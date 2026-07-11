import { definitionDigest } from "./digest.js";
import { fail } from "./diagnostics.js";
import { evaluateCondition } from "./expression.js";
import { evaluateMaths } from "./maths.js";
import { listBindableInputs, parseServiceDefinition } from "./model.js";

function nativeValue(value, defaultUnit = null) {
  if (value && typeof value === "object" && Object.hasOwn(value, "value")) {
    return { value: String(value.value), ...(value.unit == null ? {} : { unit: value.unit }) };
  }
  return { value: String(value), ...(defaultUnit == null ? {} : { unit: defaultUnit }) };
}

function selectedValue(value) {
  return value && typeof value === "object" && Object.hasOwn(value, "value") ? value.value : value;
}

function mergeRepriceBindings(pinned = {}, saved = {}) {
  const merged = { ...pinned };
  for (const [key, value] of Object.entries(saved)) {
    merged[key] = value && typeof value === "object" && pinned[key] && typeof pinned[key] === "object"
      ? { ...pinned[key], ...value }
      : value;
  }
  return merged;
}

function lookupDerivedValues(component, binding, loadedPricing) {
  const explicit = binding && typeof binding === "object" ? binding.derived : null;
  const outputIds = Object.values(component.calculationId ?? {});
  if (explicit && outputIds.every((id) => Object.hasOwn(explicit, id))) return explicit;
  const payload = loadedPricing[component.mappingDefinitionName]?.payload;
  const rows = payload?.rows ?? payload?.items ?? payload?.table;
  if (!Array.isArray(rows)) return explicit;
  const selectors = {
    ...(component.remap?.constant ?? {}),
    ...((binding && typeof binding === "object" && binding.selectors) ?? {}),
  };
  const selectorIds = (component.row ?? []).map((row) => row.selectorId).filter(Boolean);
  if (selectorIds.length === 1 && !Object.hasOwn(selectors, selectorIds[0])) {
    selectors[selectorIds[0]] = selectedValue(binding);
  }
  const row = rows.find((candidate) => Object.entries(selectors).every(([key, value]) => String(candidate[key]) === String(value)));
  if (!row) return explicit;
  return Object.fromEntries(outputIds.filter((id) => Object.hasOwn(row, id)).map((id) => [id, row[id]]));
}

function regionPricingMap(payload, regionName, region) {
  return payload?.regions?.[regionName] ?? payload?.regions?.[region] ?? payload?.regions?.["Any"] ?? null;
}

function rateFromMap(map, meteredUnit, path) {
  const entry = map?.[meteredUnit];
  if (!entry || !Number.isFinite(Number(entry.price))) {
    fail("pricing.metered-unit.missing", `Metered unit '${meteredUnit}' has no numeric price.`, path, meteredUnit);
  }
  return Number(entry.price);
}

function regionalValue(value, region, regionName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return value[regionName] ?? value[region] ?? value.allRegions ?? value.Any ?? null;
}

async function loadPricingFor(model, region, regionName, currency, loadPricing) {
  const result = {};
  for (const mapping of model.mappings) {
    const payload = await loadPricing({
      serviceCode: model.metadata.serviceCode,
      mapping,
      region,
      regionName,
      currency,
      url: mapping.url.replace("[currency]", currency),
    });
    if (!payload || typeof payload !== "object") {
      fail("pricing.definition.invalid", `Pricing loader returned no payload for '${mapping.name}'.`, `$.mappingDefinitions.${mapping.name}`);
    }
    result[mapping.name] = {
      payload,
      map: regionPricingMap(payload, regionName, region),
      digest: definitionDigest(payload),
      manifest: payload.manifest ?? null,
    };
  }
  return result;
}

function textOperand(operand, values, path) {
  if (Object.hasOwn(operand, "constant")) return String(operand.constant);
  if (operand.variableId && Object.hasOwn(values, operand.variableId)) return String(values[operand.variableId]);
  fail("pricing.transform.operand.missing", "Pricing transform operand is unresolved.", path, operand);
}

function resolvePricingComponents(template, loadedPricing, values, hasMeteredUnit, componentAdapters, region, regionName) {
  const pricing = {};
  for (const component of template.components.filter((entry) => entry.type === "pricing")) {
    const context = { values, hasMeteredUnit };
    if (!evaluateCondition(component.card?.displayIf, context, `${component.sourcePath}.card.displayIf`)) continue;
    if (!evaluateCondition(component.displayIf, context, `${component.sourcePath}.displayIf`)) continue;
    if (component.subType === "concatenate") {
      values[component.id] = (component.operands ?? []).map((operand, index) =>
        textOperand(operand, values, `${component.sourcePath}.operands[${index}]`)).join("");
      continue;
    }
    if (component.subType === "replace") {
      if (!Object.hasOwn(values, component.originalId)) {
        fail("pricing.replace.source.missing", `Replace source '${component.originalId}' is unresolved.`, component.sourcePath, component.originalId);
      }
      values[component.id] = (component.replacements ?? []).reduce(
        (result, replacement) => result.split(String(replacement.originalString)).join(String(replacement.replaceString)),
        String(values[component.originalId]),
      );
      continue;
    }
    const loaded = loadedPricing[component.mappingDefinitionName];
    if (!loaded) fail("pricing.mapping.missing", `Unknown mapping '${component.mappingDefinitionName}'.`, component.sourcePath, component.mappingDefinitionName);
    if (component.subType === "singlePricePoint") {
      const meteredUnit = regionalValue(component.meteredUnit, region, regionName);
      pricing[component.id] = {
        kind: "rate",
        price: rateFromMap(loaded.map, meteredUnit, component.sourcePath),
      };
      values[component.id] = pricing[component.id].price;
    } else if (component.subType === "tieredPricing") {
      const tiers = component.tiers?.[region] ?? component.tiers?.allRegions;
      if (!Array.isArray(tiers)) fail("pricing.tiers.unsupported", `No tier definition is available for '${region}'.`, component.sourcePath, component.tiers);
      pricing[component.id] = {
        kind: "tiers",
        tiers: tiers.map((tier) => ({
          ...tier,
          price: rateFromMap(
            loaded.map,
            regionalValue(tier.meteredUnit, region, regionName),
            component.sourcePath,
          ),
        })),
      };
    } else if (component.subType === "pricingComboV2") {
      const referId = component.refers?.[0]?.variableId ?? component.refer ?? component.inputRefer ?? component.id;
      const unit = selectedValue(values[referId]);
      if (!unit) fail("pricing.combo.binding.missing", `Pricing combo '${component.id}' requires a bound metered-unit id.`, component.sourcePath, component.id);
      pricing[component.id] = { kind: "rate", price: rateFromMap(loaded.map, unit, component.sourcePath) };
      values[component.id] = pricing[component.id].price;
    } else {
      const adapter = componentAdapters?.[`${component.type}:${component.subType}`] ?? componentAdapters?.[component.subType];
      if (typeof adapter !== "function") {
        fail("pricing.subtype.unsupported", `Unsupported pricing subtype '${component.subType}'.`, component.sourcePath, component.subType);
      }
      const result = adapter({ component, values, loadedPricing });
      if (!result?.handled) fail("pricing.adapter.declined", `Adapter declined '${component.type}:${component.subType}'.`, component.sourcePath, component.subType);
      if (Object.hasOwn(result, "value")) values[component.id] = result.value;
      if (result.pricing) pricing[component.id] = result.pricing;
    }
  }
  return pricing;
}

function costsFromOutputs(outputs) {
  const explicit = outputs.filter((output) => output.costs);
  if (explicit.length > 0) {
    return explicit.reduce((costs, output) => ({
      monthly: costs.monthly + Number(output.costs.monthly ?? 0),
      upfront: costs.upfront + Number(output.costs.upfront ?? 0),
    }), { monthly: 0, upfront: 0 });
  }
  const costOutputs = outputs.filter((output) => /(?:cost|\[currency\]|usd)/i.test(output.outputUnitLabel ?? ""));
  return { monthly: costOutputs.length === 0 ? 0 : Number(costOutputs.at(-1).value), upfront: 0 };
}

export function createDefinitionCompiler({ loadDefinition, loadPricing, currency = "USD", adapters = {} }) {
  if (typeof loadDefinition !== "function" || typeof loadPricing !== "function") {
    throw new TypeError("createDefinitionCompiler requires loadDefinition and loadPricing functions.");
  }

  async function loadModel(serviceCode) {
    const loaded = await loadDefinition(serviceCode);
    const raw = loaded?.definition ?? loaded;
    return parseServiceDefinition(raw, { source: loaded?.source ?? null, adapters });
  }

  async function compileLeaf({ model, region, regionName, templateId, bindings = {}, description = null }) {
    const loadedPricing = await loadPricingFor(model, region, regionName, currency, loadPricing);
    const hasMeteredUnit = (mappingName, unit) => Boolean(loadedPricing[mappingName]?.map?.[unit]);
    const template = model.templates.find((entry) => entry.id === templateId) ?? (templateId == null ? model.templates[0] : null);
    if (!template) fail("template.not-found", `Template '${templateId}' was not found.`, "$.templates", templateId);
    const values = Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, selectedValue(value)]));
    for (const input of template.inputs) {
      if (!Object.hasOwn(values, input.id) && input.defaultValue != null) values[input.id] = input.defaultValue;
    }
    const calculationComponents = {};
    for (const input of listBindableInputs(model, { templateId: template.id, values, hasMeteredUnit })) {
      let value = bindings[input.id];
      if (value == null && input.defaultValue != null) value = input.defaultValue;
      if (value == null) {
        if (input.required) fail("binding.required", `Visible input '${input.id}' is required.`, input.sourcePath, input.id);
        continue;
      }
      if (input.options.length > 0) {
        const allowed = input.options.filter((option) => evaluateCondition(option.displayIf, { values, hasMeteredUnit }, `${option.sourcePath}.displayIf`)).map((option) => String(option.id));
        if (!allowed.includes(String(selectedValue(value)))) fail("binding.option.invalid", `Input '${input.id}' is not an available option.`, input.sourcePath, selectedValue(value), { allowed });
      }
      values[input.id] = selectedValue(value);
      calculationComponents[input.id] = nativeValue(value, input.defaultUnit);
      if (input.subType === "columnFormIPM") {
        const definitionComponent = template.componentById[input.id];
        const derived = lookupDerivedValues(definitionComponent, value, loadedPricing);
        for (const outputId of Object.values(definitionComponent.calculationId ?? {})) {
          if (!derived || !Object.hasOwn(derived, outputId)) {
            fail("binding.lookup-derived.required", `Column lookup '${input.id}' requires derived output '${outputId}'.`, input.sourcePath, outputId);
          }
          values[outputId] = derived[outputId];
        }
      }
    }
    for (const component of template.components) {
      const adapter = adapters.components?.[`${component.type}:${component.subType}`] ?? adapters.components?.[component.subType];
      if (typeof adapter === "function") {
        const result = adapter({ component, bindings, values, calculationComponents, loadedPricing });
        if (!result?.handled) fail("component.adapter.declined", `Adapter declined '${component.type}:${component.subType}'.`, component.sourcePath, component.subType);
        if (result.values) Object.assign(values, result.values);
        if (result.calculationComponents) Object.assign(calculationComponents, result.calculationComponents);
      }
    }
    const pricing = resolvePricingComponents(
      template,
      loadedPricing,
      values,
      hasMeteredUnit,
      adapters.components,
      region,
      regionName,
    );
    const evaluated = evaluateMaths(template, { values, pricing, hasMeteredUnit, adapters: adapters.maths });
    const costs = costsFromOutputs(evaluated.outputs);
    const monthlyUsd = costs.monthly;
    return {
      service: {
        calculationComponents,
        serviceCode: model.metadata.serviceCode,
        region,
        estimateFor: template.id,
        version: model.metadata.version,
        description,
        serviceCost: costs,
        serviceName: model.metadata.serviceName,
        regionName,
        configSummary: Object.entries(calculationComponents).map(([id, value]) => `${id} (${value.value}${value.unit ? ` ${value.unit}` : ""})`).join(", "),
      },
      monthlyUsd,
      evaluation: evaluated,
      metadata: {
        definition: model.metadata,
        pricing: Object.fromEntries(Object.entries(loadedPricing).map(([name, entry]) => [name, { digest: entry.digest, manifest: entry.manifest }])),
        reprice: { bindings: structuredClone(bindings) },
      },
      diagnostics: [],
    };
  }

  async function compile(request) {
    const model = await loadModel(request.serviceCode);
    if (!model.selector) {
      return compileLeaf({ ...request, model, regionName: request.regionName ?? request.region });
    }
    const selected = request.subservices ?? model.selector.defaults.map((serviceCode) => ({ serviceCode, bindings: {} }));
    if (!Array.isArray(selected) || selected.length === 0) fail("selector.empty", `Selector '${request.serviceCode}' requires subservices.`, "$.subservices");
    const disallowed = selected.find((entry) => !model.selector.serviceCodes.includes(entry.serviceCode));
    if (disallowed) fail("selector.subservice.invalid", `'${disallowed.serviceCode}' is not offered by '${request.serviceCode}'.`, "$.subservices", disallowed.serviceCode);
    const children = [];
    for (const child of selected) {
      const childModel = await loadModel(child.serviceCode);
      if (childModel.selector) fail("selector.nested-selector.unsupported", "Selector children may not themselves be selectors.", "$.subservices", child.serviceCode);
      children.push(await compileLeaf({
        ...child,
        model: childModel,
        region: child.region ?? request.region,
        regionName: child.regionName ?? request.regionName ?? request.region,
      }));
    }
    const monthlyUsd = children.reduce((sum, child) => sum + child.monthlyUsd, 0);
    const upfrontUsd = children.reduce((sum, child) => sum + Number(child.service.serviceCost?.upfront ?? 0), 0);
    return {
      service: {
        calculationComponents: {},
        serviceCode: model.metadata.serviceCode,
        region: request.region,
        estimateFor: model.selector.templateId,
        version: model.metadata.version,
        description: request.description ?? null,
        subServices: children.map((child) => child.service),
        serviceCost: { monthly: monthlyUsd, upfront: upfrontUsd },
        serviceName: model.metadata.serviceName,
        regionName: request.regionName ?? request.region,
        configSummary: children.map((child) => child.service.serviceName).join(", "),
      },
      monthlyUsd,
      metadata: {
        definition: model.metadata,
        children: children.map((child) => child.metadata),
      },
      diagnostics: [],
    };
  }

  function verifyPinnedMetadata(actual, expected, path = "$.metadata") {
    if (!expected) return;
    if (expected.definition?.digest && expected.definition.digest !== actual.definition.digest) {
      fail("reprice.definition.drift", "The loaded calculator definition no longer matches the pinned digest.", `${path}.definition.digest`, actual.definition.digest, { expected: expected.definition.digest });
    }
    for (const [name, pricing] of Object.entries(expected.pricing ?? {})) {
      if (pricing.digest && actual.pricing?.[name]?.digest !== pricing.digest) {
        fail("reprice.pricing.drift", `Pricing mapping '${name}' no longer matches the pinned digest.`, `${path}.pricing.${name}.digest`, actual.pricing?.[name]?.digest, { expected: pricing.digest });
      }
    }
  }

  async function repriceService(serviceRecord, { metadata = null } = {}) {
    if (!serviceRecord?.serviceCode || !serviceRecord?.region || !serviceRecord?.estimateFor) {
      fail("reprice.service.invalid", "A saved service record requires serviceCode, region, and estimateFor.", "$.service");
    }
    const model = await loadModel(serviceRecord.serviceCode);
    if (serviceRecord.version !== model.metadata.version) {
      fail("reprice.version.drift", `Saved version '${serviceRecord.version}' does not match loaded version '${model.metadata.version}'.`, "$.service.version", serviceRecord.version);
    }
    let repriced;
    if (model.selector) {
      if (serviceRecord.estimateFor !== model.selector.templateId) {
        fail("reprice.template.mismatch", "Saved selector estimateFor does not match its definition.", "$.service.estimateFor", serviceRecord.estimateFor);
      }
      repriced = await compile({
        serviceCode: serviceRecord.serviceCode,
        region: serviceRecord.region,
        regionName: serviceRecord.regionName,
        subservices: (serviceRecord.subServices ?? []).map((child, index) => ({
          serviceCode: child.serviceCode,
          region: child.region,
          regionName: child.regionName,
          templateId: child.estimateFor,
          bindings: mergeRepriceBindings(metadata?.children?.[index]?.reprice?.bindings, child.calculationComponents),
          description: child.description,
        })),
      });
      verifyPinnedMetadata(repriced.metadata, metadata);
      for (const [index, child] of repriced.metadata.children.entries()) {
        verifyPinnedMetadata(child, metadata?.children?.[index], `$.metadata.children[${index}]`);
      }
    } else {
      repriced = await compileLeaf({
        model,
        region: serviceRecord.region,
        regionName: serviceRecord.regionName ?? serviceRecord.region,
        templateId: serviceRecord.estimateFor,
        bindings: mergeRepriceBindings(metadata?.reprice?.bindings, serviceRecord.calculationComponents),
        description: serviceRecord.description,
      });
      verifyPinnedMetadata(repriced.metadata, metadata);
    }
    const storedMonthlyUsd = Number(serviceRecord.serviceCost?.monthly);
    return {
      monthlyUsd: repriced.monthlyUsd,
      storedMonthlyUsd: Number.isFinite(storedMonthlyUsd) ? storedMonthlyUsd : null,
      matchesStoredCost: Number.isFinite(storedMonthlyUsd) && Math.abs(storedMonthlyUsd - repriced.monthlyUsd) < 0.005,
      metadata: repriced.metadata,
    };
  }

  return { compile, loadModel, repriceService };
}
