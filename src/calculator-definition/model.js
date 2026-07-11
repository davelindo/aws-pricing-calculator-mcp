import { definitionDigest } from "./digest.js";
import { fail } from "./diagnostics.js";
import { evaluateCondition } from "./expression.js";

const INPUT_SUBTYPES = new Set([
  "checkbox", "dropdown", "durationInput", "fileSize", "frequency", "numericInput",
  "percentInput", "radioTiles", "throughput", "workload",
  "columnFormIPM", "dataTransferV2", "utilization",
]);
const PRESENTATIONAL_SUBTYPES = new Set(["alert", "bodyText", "condition", "headerText", "subService"]);
const PRICING_SUBTYPES = new Set(["concatenate", "pricingComboV2", "replace", "singlePricePoint", "tieredPricing"]);
const MATHS_SUBTYPES = new Set(["basicMaths", "ec2Variable", "maxMin", "rounding", "tieredPricingMath", "variable"]);

function adapterFor(adapters, component) {
  return adapters?.[`${component.type}:${component.subType}`] ?? adapters?.[component.subType];
}

function validateRuntimeComponent(component, sourcePath, adapters) {
  const supported = typeof adapterFor(adapters, component) === "function" || (component.type === "input"
    ? INPUT_SUBTYPES.has(component.subType) || PRESENTATIONAL_SUBTYPES.has(component.subType)
    : component.type === "pricing"
      ? PRICING_SUBTYPES.has(component.subType)
      : component.type === "display");
  if (!supported) {
    fail("definition.component.unsupported", `Unsupported calculator component '${component.type}:${component.subType}'.`, sourcePath, `${component.type}:${component.subType}`);
  }
}

function normalizeInput(component, sourcePath) {
  const publishedOptions = Array.isArray(component.options)
    ? component.options.map((option, index) => ({
        id: option.id,
        label: option.label ?? String(option.id ?? ""),
        displayIf: option.displayIf ?? null,
        sourcePath: `${sourcePath}.options[${index}]`,
      }))
    : [];
  // Frequency components use `options` for the unit attached to a numeric
  // value; they are not enumerated-value inputs.
  const optionBackedUnits = component.subType === "frequency" ? publishedOptions : [];
  const options = component.subType === "frequency" ? [] : publishedOptions;
  const units = (component.dropDownSize ?? component.units ?? optionBackedUnits).map((unit) => ({
    id: unit.id,
    label: unit.label ?? String(unit.id ?? ""),
  }));
  const defaultValue =
    component.defaultValue ?? component.defaultDropDownItem ?? component.defaultOption?.value ?? null;
  const defaultUnit =
    component.defaultFrequency ?? component.defaultDuration ?? component.preferredUnit ??
    component.defaultOption?.frequency ?? component.defaultOption?.size ?? null;
  return {
    id: component.id,
    type: "input",
    subType: component.subType,
    label: component.label ?? component.id,
    description: component.description ?? component.help ?? "",
    required: component.validations?.required === true,
    defaultValue,
    defaultUnit,
    options,
    units,
    aliases: (component.row ?? []).map((row) => row.selectorId).filter(Boolean),
    displayIf: component.displayIf ?? null,
    validations: { ...(component.validations ?? {}) },
    sourcePath,
    raw: component,
  };
}

function normalizeTemplate(template, index, adapters) {
  const id = template.id ?? template.title ?? `template-${index}`;
  const cards = [];
  const components = [];
  const maths = [];
  for (const [cardIndex, card] of (template.cards ?? []).entries()) {
    const cardPath = `$.templates[${index}].cards[${cardIndex}]`;
    const normalizedCard = {
      title: card.title ?? `card-${cardIndex}`,
      displayIf: card.displayIf ?? null,
      sourcePath: cardPath,
    };
    cards.push(normalizedCard);
    for (const [componentIndex, component] of (card.inputSection?.components ?? []).entries()) {
      const sourcePath = `${cardPath}.inputSection.components[${componentIndex}]`;
      const normalizedComponent = component?.type == null && PRESENTATIONAL_SUBTYPES.has(component?.subType)
        ? { ...component, type: "input" }
        : component;
      if (!normalizedComponent?.id || !normalizedComponent?.type) {
        fail("definition.component.invalid", "Every calculator component requires type and id.", sourcePath, component);
      }
      validateRuntimeComponent(normalizedComponent, sourcePath, adapters?.components);
      components.push({ ...normalizedComponent, sourcePath, card: normalizedCard });
    }
    for (const [sectionIndex, section] of (card.mathsSection ?? []).entries()) {
      for (const [mathIndex, component] of (section.components ?? []).entries()) {
        if (component.type !== "maths") continue;
        if (!MATHS_SUBTYPES.has(component.subType) && typeof adapterFor(adapters?.maths, component) !== "function") {
          fail("definition.maths.unsupported", `Unsupported maths subtype '${component.subType}'.`, `${cardPath}.mathsSection[${sectionIndex}].components[${mathIndex}]`, component.subType);
        }
        maths.push({
          ...component,
          sourcePath: `${cardPath}.mathsSection[${sectionIndex}].components[${mathIndex}]`,
          card: normalizedCard,
        });
      }
    }
  }
  const inputs = components
    .filter((component) => component.type === "input" && INPUT_SUBTYPES.has(component.subType))
    .map((component) => normalizeInput(component, component.sourcePath));
  return {
    id,
    title: template.title ?? id,
    description: template.description ?? "",
    cards,
    components,
    maths,
    inputs,
    componentById: Object.fromEntries(components.map((component) => [component.id, component])),
  };
}

export function parseServiceDefinition(raw, { source = null, adapters = null } = {}) {
  if (!raw || typeof raw !== "object" || !raw.serviceCode || !raw.version) {
    fail("definition.invalid", "A service definition requires serviceCode and version.", "$", raw);
  }
  const selector = raw.subType === "subServiceSelector" || raw.layout === "loader";
  if (selector && !Array.isArray(raw.templates)) {
    fail("definition.selector.invalid", "A subservice selector requires template service codes.", "$.templates", raw.templates);
  }
  const templates = selector ? [] : (raw.templates ?? []).map((template, index) => normalizeTemplate(template, index, adapters));
  if (!selector && templates.length === 0) {
    fail("definition.templates.missing", "A calculator definition requires at least one template.", "$.templates");
  }
  const mappings = (raw.mappingDefinitions ?? []).map((mapping, index) => {
    if (!mapping.mappingDefinitionName || !mapping.mappingDefinitionURL) {
      fail("definition.mapping.invalid", "A mapping definition requires name and URL.", `$.mappingDefinitions[${index}]`, mapping);
    }
    return {
      name: mapping.mappingDefinitionName,
      url: mapping.mappingDefinitionURL,
      includeRegions: mapping.includeRegions !== false,
      version: mapping.mappingDefinitionVersion ?? null,
    };
  });
  return {
    metadata: {
      serviceCode: raw.serviceCode,
      serviceName: raw.serviceName ?? raw.serviceCode,
      version: raw.version,
      source,
      digest: definitionDigest(raw),
      type: raw.type ?? null,
      subType: raw.subType ?? null,
      layout: raw.layout ?? null,
    },
    mappings,
    selector: selector
      ? { templateId: raw.templateId, serviceCodes: [...raw.templates], defaults: [...(raw.defaultTemplates ?? [])] }
      : null,
    templates,
    raw,
  };
}

export function listBindableInputs(model, { templateId, values = {}, hasMeteredUnit } = {}) {
  const template = model.templates.find((entry) => entry.id === templateId) ?? model.templates[0];
  if (!template) return [];
  const context = { values, hasMeteredUnit };
  return template.inputs.filter((input) => {
    if (!evaluateCondition(input.displayIf, context, `${input.sourcePath}.displayIf`)) return false;
    return evaluateCondition(input.raw.card?.displayIf, context, `${input.sourcePath}.card.displayIf`);
  }).map(({ raw: _raw, ...input }) => input);
}
