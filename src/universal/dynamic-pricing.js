import crypto from "node:crypto";

import { roundCurrency, regionNameFor } from "../model.js";
import { registerDynamicServiceDefinitions } from "../services/index.js";
import { bindArchitectureFacts, selectCalculatorTarget } from "./dynamic/index.js";

const DYNAMIC_ADAPTERS = new Map();

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function compactSelection(selection) {
  if (!selection) return selection;
  return {
    status: selection.status,
    kind: selection.kind,
    selectedServiceCodes: selection.selectedServiceCodes,
    templateId: selection.templateId,
    method: selection.method,
    confidence: selection.confidence,
  };
}

function compactInputBinding(input) {
  return {
    inputId: input.inputId,
    label: input.label,
    status: input.status,
    visibility: input.visibility,
    required: input.required,
    value: input.value,
    method: input.method,
    confidence: input.confidence,
    sourcePath: input.sourcePath,
    reason: input.reason,
  };
}

function compactBinding(binding) {
  if (Array.isArray(binding)) {
    return binding.map(({ serviceCode, ...child }) => ({
      serviceCode,
      ...compactBinding(child),
    }));
  }
  if (!binding || typeof binding !== "object") return binding;
  return {
    componentId: binding.componentId,
    serviceId: binding.serviceId,
    serviceCode: binding.serviceCode,
    templateId: binding.templateId,
    selection: compactSelection(binding.selection),
    bindings: binding.bindings,
    inputBindings: binding.inputBindings?.map(compactInputBinding),
    diagnostics: binding.diagnostics,
    coverage: binding.coverage,
    questions: binding.questions,
  };
}

function compactDynamicResult(result) {
  const { model: _model, ...compact } = result;
  const compacted = compact.bindings
    ? { ...compact, bindings: compactBinding(compact.bindings) }
    : compact;
  if (!compacted.compiled) return compacted;
  const { evaluation: _evaluation, diagnostics: _compilerDiagnostics, ...compiled } = compact.compiled;
  return { ...compacted, compiled };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function savedShape(service) {
  return {
    serviceCode: service?.serviceCode ?? null,
    region: service?.region ?? null,
    estimateFor: service?.estimateFor ?? null,
    version: service?.version ?? null,
    calculationComponents: service?.calculationComponents ?? {},
    subServices: (service?.subServices ?? []).map(savedShape),
  };
}

function componentRegion(architecture, component) {
  if (component?.region) return component.region;
  const regions = [
    ...(architecture?.regions ?? []),
    ...((architecture?.scopes ?? [])
      .filter((scope) => scope.kind === "region")
      .map((scope) => scope.properties?.region ?? scope.value)
      .filter(Boolean)),
  ];
  return [...new Set(regions)].length === 1 ? regions[0] : null;
}

function dynamicCatalogEntry(catalog, component) {
  const serviceId = component?.resolution?.serviceId ?? component?.serviceId;
  return (
    catalog.findByCanonicalServiceId(serviceId) ??
    catalog.findByServiceCode(component?.calculatorServiceCode) ??
    catalog.findByAlias(serviceId)
  );
}

function compilationEntry({ component, catalogEntry, compiled, region }) {
  return {
    key: `${catalogEntry.serviceCode}-dynamic-${crypto.randomUUID()}`,
    breakdown: {
      serviceId: catalogEntry.canonicalServiceId,
      kind: catalogEntry.serviceCode,
      label: catalogEntry.name,
      category: `aws-calculator-${catalogEntry.kind}`,
      supportive: false,
      region,
      environment: component.environment ?? "shared",
      monthlyUsd: roundCurrency(compiled.monthlyUsd),
      implementationStatus: "dynamic",
      details: `Compiled from AWS Calculator definition ${compiled.metadata?.definition?.version ?? "unknown"}.`,
    },
    service: compiled.service,
  };
}

function bindingReady(binding) {
  return (
    binding?.coverage?.status === "ready" &&
    !binding.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  );
}

function dynamicBindingError(sourceComponent) {
  const prepared = sourceComponent.dynamicPricing;
  const error = new Error(
    prepared?.error ??
      prepared?.diagnostics?.[0]?.message ??
      `Calculator inputs are incomplete for '${sourceComponent.name ?? sourceComponent.id}'.`,
  );
  error.name = "DynamicCalculatorBindingError";
  error.field = prepared?.questions?.[0]?.inputId ?? "calculatorInputs";
  error.questions = prepared?.questions ?? [];
  error.diagnostics = prepared?.diagnostics ?? [];
  return error;
}

async function bindAndCompileComponent({
  architecture,
  component,
  catalog,
  compiler,
  assumptionsPolicy,
}) {
  const catalogEntry = dynamicCatalogEntry(catalog, component);
  const region = componentRegion(architecture, component);

  if (!catalogEntry) {
    return {
      status: "needs-input",
      diagnostics: [
        {
          code: "dynamic.catalog-entry-missing",
          severity: "error",
          componentId: component.id,
          message: `No live Calculator entry matches '${component.serviceId}'.`,
        },
      ],
      questions: [],
    };
  }

  if (!region) {
    return {
      status: "needs-input",
      catalogEntry,
      diagnostics: [
        {
          code: "dynamic.region-required",
          severity: "error",
          componentId: component.id,
          inputId: "region",
          message: "Dynamic calculator compilation requires one AWS region.",
        },
      ],
      questions: [
        {
          id: `question.calculator-input.${component.id}.region.missing`,
          prompt: `Which AWS region should '${component.name ?? component.id}' use?`,
          blocking: true,
          priority: "high",
          relatedIds: [component.id],
          answerHint: "For example: us-east-1.",
          componentId: component.id,
          inputId: "region",
          reason: "Dynamic calculator definitions are region-specific.",
          diagnosticIds: [],
        },
      ],
    };
  }

  try {
    const model = await compiler.loadModel(catalogEntry.serviceCode);
    const regionName = regionNameFor(region);

    if (model.selector) {
      const selection = selectCalculatorTarget({
        component,
        definition: model,
        policy: assumptionsPolicy,
      });

      if (!["selected", "defaulted"].includes(selection.status)) {
        return {
          status: "needs-input",
          catalogEntry,
          region,
          model,
          diagnostics: selection.diagnostics,
          questions: selection.questions,
        };
      }

      const childBindings = [];
      const diagnostics = [...selection.diagnostics];
      const questions = [...selection.questions];

      for (const serviceCode of selection.selectedServiceCodes) {
        const childModel = await compiler.loadModel(serviceCode);
        const binding = bindArchitectureFacts({
          component,
          definition: childModel,
          policy: assumptionsPolicy,
        });
        diagnostics.push(...binding.diagnostics);
        questions.push(...binding.questions);
        childBindings.push({ serviceCode, binding });
      }

      if (childBindings.some(({ binding }) => !bindingReady(binding))) {
        return {
          status: "needs-input",
          catalogEntry,
          region,
          model,
          diagnostics,
          questions,
          bindings: childBindings.map(({ serviceCode, binding }) => ({
            serviceCode,
            ...binding,
          })),
        };
      }

      const compiled = await compiler.compile({
        serviceCode: catalogEntry.serviceCode,
        region,
        regionName,
        description: component.description ?? component.name ?? null,
        subservices: childBindings.map(({ serviceCode, binding }) => ({
          serviceCode,
          region,
          regionName,
          templateId: binding.templateId,
          bindings: binding.bindings,
        })),
      });

      return {
        status: "compiled",
        catalogEntry,
        region,
        model,
        diagnostics,
        questions,
        bindings: childBindings.map(({ serviceCode, binding }) => ({
          serviceCode,
          ...binding,
        })),
        compiled,
        entry: compilationEntry({ component, catalogEntry, compiled, region }),
      };
    }

    const binding = bindArchitectureFacts({
      component,
      definition: model,
      policy: assumptionsPolicy,
    });

    if (!bindingReady(binding)) {
      return {
        status: "needs-input",
        catalogEntry,
        region,
        model,
        diagnostics: binding.diagnostics,
        questions: binding.questions,
        bindings: binding,
      };
    }

    const compiled = await compiler.compile({
      serviceCode: catalogEntry.serviceCode,
      region,
      regionName,
      templateId: binding.templateId,
      bindings: binding.bindings,
      description: component.description ?? component.name ?? null,
    });

    return {
      status: "compiled",
      catalogEntry,
      region,
      model,
      diagnostics: binding.diagnostics,
      questions: binding.questions,
      bindings: binding,
      compiled,
      entry: compilationEntry({ component, catalogEntry, compiled, region }),
    };
  } catch (error) {
    const diagnostics = error?.diagnostics ?? [
      {
        code: error?.code ?? "dynamic.compilation-failed",
        severity: "error",
        componentId: component.id,
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    return {
      status: "unsupported",
      catalogEntry,
      region,
      diagnostics,
      questions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createDynamicAdapter(catalogEntry) {
  const expectedShapes = new Map();
  return {
    id: catalogEntry.canonicalServiceId,
    name: catalogEntry.name,
    category: `aws-calculator-${catalogEntry.kind}`,
    implementationStatus: "dynamic",
    keywords: catalogEntry.searchKeywords ?? [],
    pricingStrategies: ["definition-driven"],
    calculatorServiceCodes: [catalogEntry.serviceCode],
    capabilityMatrix: [],
    universalPricingMode: "usage",
    buildUniversalEntry({ component: sourceComponent }) {
      const prepared = sourceComponent.dynamicPricing;
      if (prepared?.status !== "compiled" || !prepared.entry) {
        throw dynamicBindingError(sourceComponent);
      }
      return {
        args: {
          dynamic: true,
          definitionMetadata: prepared.compiled.metadata,
          bindings: prepared.bindings,
        },
        entry: prepared.entry,
      };
    },
    modelSavedMonthlyUsd(service) {
      const expected = expectedShapes.get(canonicalJson(savedShape(service)));
      if (expected == null) {
        throw new Error(
          `Saved '${catalogEntry.serviceCode}' components do not match a pinned dynamic compilation.`,
        );
      }
      return expected;
    },
    _expectedShapes: expectedShapes,
  };
}

function dynamicAdapter(catalogEntry) {
  const serviceId = catalogEntry.canonicalServiceId;
  let adapter = DYNAMIC_ADAPTERS.get(serviceId);
  if (!adapter) {
    adapter = createDynamicAdapter(catalogEntry);
    DYNAMIC_ADAPTERS.set(serviceId, adapter);
  }
  return adapter;
}

function recordDynamicCapability(adapter, dynamic) {
  const region = dynamic.region;
  if (region && !adapter.capabilityMatrix.some((item) => item.region === region)) {
    adapter.capabilityMatrix.push({
      region,
      support: "exact",
      calculatorSaveSupported: true,
      validationSupported: true,
      reason: "Compiled from the current pinned AWS Calculator definition and pricing maps.",
    });
  }

  if (dynamic.status === "compiled") {
    adapter._expectedShapes.set(
      canonicalJson(savedShape(dynamic.entry.service)),
      roundCurrency(dynamic.compiled.monthlyUsd),
    );
  }
}

function adapterDefinitions(dynamicComponents) {
  for (const component of dynamicComponents) {
    const dynamic = component.dynamicPricing;
    const catalogEntry = dynamic?.catalogEntry;
    if (!catalogEntry) continue;
    const adapter = dynamicAdapter(catalogEntry);

    recordDynamicCapability(adapter, dynamic);
  }

  return [...DYNAMIC_ADAPTERS.values()];
}

export async function hydrateDynamicArchitecturePricing({
  architecture,
  catalog,
  compiler,
  assumptionsPolicy,
} = {}) {
  const hydrated = cloneJson(architecture);
  const dynamicComponents = hydrated.components.filter((component) =>
    String(component?.resolution?.serviceId ?? component?.serviceId ?? "").startsWith(
      "aws-calculator:",
    ),
  );

  for (const component of dynamicComponents) {
    component.dynamicPricing = compactDynamicResult(await bindAndCompileComponent({
      architecture: hydrated,
      component,
      catalog,
      compiler,
      assumptionsPolicy,
    }));
  }

  registerDynamicServiceDefinitions(adapterDefinitions(dynamicComponents));
  return {
    architecture: hydrated,
    dynamicComponents: dynamicComponents.map((component) => component.dynamicPricing),
  };
}

export function registerHydratedDynamicPricingDefinitions(architecture) {
  const dynamicComponents = (architecture?.components ?? []).filter(
    (component) => component?.dynamicPricing?.catalogEntry,
  );
  registerDynamicServiceDefinitions(adapterDefinitions(dynamicComponents));
  return dynamicComponents.length;
}

export function clearDynamicPricingDefinitions() {
  DYNAMIC_ADAPTERS.clear();
  registerDynamicServiceDefinitions([]);
}
