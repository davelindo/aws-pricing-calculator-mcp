const SUPPORTED_INPUTS = new Set(["checkbox", "columnFormIPM", "dataTransferV2", "dropdown", "durationInput", "fileSize", "frequency", "numericInput", "percentInput", "radioTiles", "throughput", "utilization", "workload"]);
const SUPPORTED_PRICING = new Set(["concatenate", "pricingComboV2", "replace", "singlePricePoint", "tieredPricing"]);
const SUPPORTED_MATHS = new Set(["variable", "ec2Variable", "basicMaths", "tieredPricingMath", "maxMin", "rounding"]);
const IGNORED = new Set(["bodyText", "condition", "conversionDisplay", "headerText", "priceDisplay", "alert", "subService"]);
const SUPPORTED_OPERATIONS = new Set(["addition", "subtraction", "multiplication", "division", "exponent", "Maximum", "Minimum"]);
const SUPPORTED_CONDITIONS = new Set(["and", "or", "not", "!", "exists", "checkboxChecked", "checkboxNotChecked", "==", "!=", ">", ">=", "<", "<="]);
const ADAPTER_CONSTRUCT = /(?:ec2|workload|dedicatedhost|snapshot|windows|sql|conditionalCheckboxes|workflowInstruction|uploadTable|pricingStrategy|inputField|instanceRecommendation|CostSummary|LicenseSummary)/i;

function collectDefinitionConstructs(definition) {
  const componentSubTypes = new Set();
  const mathsOperations = new Set();
  const conditionOperators = new Set();
  const mappingShapes = new Set();
  function walkCondition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      conditionOperators.add(`shape:${keys.sort().join("+")}`);
      return;
    }
    const operator = keys[0];
    conditionOperators.add(operator);
    if (["and", "or"].includes(operator) && Array.isArray(value[operator])) {
      value[operator].forEach(walkCondition);
    } else if (["not", "!"].includes(operator)) {
      walkCondition(value[operator]);
    }
  }
  function walk(value, key = null) {
    if (!value || typeof value !== "object") return;
    if (value.type && value.subType && (value.id || ["input", "pricing", "maths", "display"].includes(value.type))) {
      componentSubTypes.add(`${value.type}:${value.subType}`);
    }
    if (value.type === "maths" && value.operation) mathsOperations.add(value.operation);
    if (key === "displayIf") walkCondition(value);
    for (const [key, child] of Object.entries(value)) {
      walk(child, key);
    }
  }
  walk(definition);
  for (const mapping of definition.mappingDefinitions ?? []) {
    mappingShapes.add(Object.keys(mapping).sort().join("+"));
  }
  return { componentSubTypes, mathsOperations, conditionOperators, mappingShapes };
}

function hasAdapter(adapters, token) {
  const [, subType] = token.split(":");
  const group = token.startsWith("maths:") ? adapters?.maths : adapters?.components;
  return typeof group?.[token] === "function" || typeof group?.[subType] === "function";
}

export function classifyDefinition(definition, { adapters = null } = {}) {
  if (!Array.isArray(definition?.templates) || definition.templates.length === 0) {
    return {
      status: "not-configurable",
      reasons: [{ code: "definition.templates.missing", construct: "templates" }],
      constructs: { componentSubTypes: [], mathsOperations: [], conditionOperators: [], mappingShapes: [] },
    };
  }
  const constructs = collectDefinitionConstructs(definition);
  const reasons = [];
  const adapterConstructs = [];
  for (const token of constructs.componentSubTypes) {
    const [type, subType] = token.split(":");
    const supported = type === "input" ? SUPPORTED_INPUTS.has(subType) || IGNORED.has(subType)
      : type === "pricing" ? SUPPORTED_PRICING.has(subType)
        : type === "maths" ? SUPPORTED_MATHS.has(subType)
          : type === "display";
    if (!supported && hasAdapter(adapters, token)) adapterConstructs.push(token);
    else if (!supported) reasons.push({ code: ADAPTER_CONSTRUCT.test(token) ? "component.adapter.required" : "component.subtype.unsupported", construct: token });
  }
  for (const operation of constructs.mathsOperations) {
    if (!SUPPORTED_OPERATIONS.has(operation)) reasons.push({ code: ADAPTER_CONSTRUCT.test(operation) ? "maths.adapter.required" : "maths.operation.unsupported", construct: operation });
  }
  for (const operator of constructs.conditionOperators) {
    if (!SUPPORTED_CONDITIONS.has(operator)) reasons.push({ code: "condition.operator.unsupported", construct: operator });
  }
  const mappingKeys = new Set(["includeRegions", "mappingDefinitionName", "mappingDefinitionURL", "mappingDefinitionVersion"]);
  for (const [index, mapping] of (definition.mappingDefinitions ?? []).entries()) {
    const unknownKeys = Object.keys(mapping).filter((key) => !mappingKeys.has(key));
    if (!mapping.mappingDefinitionName || !mapping.mappingDefinitionURL || unknownKeys.length > 0) {
      reasons.push({
        code: "mapping.shape.unsupported",
        construct: `mappingDefinitions[${index}]`,
        details: { unknownKeys, missingName: !mapping.mappingDefinitionName, missingUrl: !mapping.mappingDefinitionURL },
      });
    }
  }
  return {
    status: reasons.length === 0
      ? adapterConstructs.length > 0 ? "adapter-backed" : "exact-schema-supported"
      : reasons.every((reason) => reason.code.endsWith("adapter.required"))
        ? "adapter-required"
        : "fail-closed",
    reasons,
    constructs: {
      ...Object.fromEntries(Object.entries(constructs).map(([key, set]) => [key, [...set].sort()])),
      adapterConstructs: adapterConstructs.sort(),
    },
  };
}

export async function auditManifest({
  manifest,
  loadDefinition,
  concurrency = 12,
  adapters = null,
  adaptersByService = null,
  externallyBackedServiceCodes = [],
}) {
  const services = manifest?.awsServices ?? [];
  const externalAdapters = new Set(externallyBackedServiceCodes);
  const results = new Array(services.length);
  let cursor = 0;
  async function worker() {
    while (cursor < services.length) {
      const index = cursor++;
      const entry = services[index];
      if (entry.isActive !== true && entry.isActive !== "true") {
        results[index] = { serviceCode: entry.serviceCode, status: "inactive", reasons: [] };
        continue;
      }
      try {
        const loaded = await loadDefinition(entry);
        const serviceAdapters = adaptersByService?.[entry.serviceCode] ?? adapters;
        const classification = classifyDefinition(loaded?.definition ?? loaded, { adapters: serviceAdapters });
        results[index] = {
          serviceCode: entry.serviceCode,
          ...classification,
          ...(classification.status === "adapter-required" && externalAdapters.has(entry.serviceCode)
            ? { status: "external-adapter-backed", externalAdapter: true }
            : {}),
        };
      } catch (error) {
        results[index] = { serviceCode: entry.serviceCode, status: "load-failed", reasons: [{ code: "definition.load.failed", message: error.message }] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, services.length)) }, worker));
  const entries = results.filter(Boolean);
  return {
    totalManifestEntries: services.length,
    classifiedEntries: entries.length,
    counts: entries.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {}),
    entries,
  };
}
