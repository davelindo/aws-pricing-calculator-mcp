import assert from "node:assert/strict";
import test from "node:test";

import {
  DefinitionCompilerError,
  auditManifest,
  classifyDefinition,
  createDefinitionCompiler,
  definitionDigest,
  evaluateCondition,
  parseServiceDefinition,
  windowsWorkloadsAdapter,
} from "../src/calculator-definition/index.js";

function componentRef(id) {
  return { type: "component", id };
}

const simpleDefinition = {
  version: "1.2.3",
  serviceName: "Generic Queue",
  serviceCode: "genericQueue",
  type: "AWSService",
  layout: "simple",
  mappingDefinitions: [{
    mappingDefinitionName: "queue-map",
    mappingDefinitionURL: "pricing/queue/[currency]/current.json",
  }],
  templates: [{
    id: "queue-template",
    title: "Queue",
    cards: [{
      title: "Requests",
      inputSection: { components: [
        {
          type: "input", subType: "frequency", id: "requests", label: "Requests",
          defaultFrequency: "perMonth", validations: { required: true, minValue: 0 },
          options: [{ id: "perHour", label: "per hour" }, { id: "perMonth", label: "per month" }],
        },
        {
          type: "pricing", subType: "tieredPricing", id: "requestPricing",
          mappingDefinitionName: "queue-map", tiers: { allRegions: [
            { startOfTier: 0, endOfTier: 100, meteredUnit: "first" },
            { startOfTier: 100, endOfTier: -1, meteredUnit: "rest" },
          ] },
        },
      ] },
      mathsSection: [{ components: [
        {
          type: "maths", subType: "tieredPricingMath", id: "requestCost",
          tieredPricingRefer: "requestPricing", inputRefer: "requests",
          outputUnitLabel: "USD request cost", decimalPlaces: 2,
        },
      ] }],
    }],
  }],
};

const childDefinition = {
  version: "2.0.0",
  serviceName: "Foundation Model Provider",
  serviceCode: "provider",
  type: "AWSService",
  subType: "subService",
  layout: "simple",
  mappingDefinitions: [{ mappingDefinitionName: "models", mappingDefinitionURL: "pricing/models/[currency]/current.json" }],
  templates: [{ id: "Provider", cards: [{ title: "Inference", inputSection: { components: [
    { type: "input", subType: "dropdown", id: "route", label: "Route", defaultDropDownItem: "geo", validations: { required: true }, options: [{ id: "geo", label: "Geo" }] },
    { type: "input", subType: "numericInput", id: "tokens", label: "Tokens", validations: { required: true } },
    { type: "pricing", subType: "singlePricePoint", id: "tokenRate", mappingDefinitionName: "models", meteredUnit: { allRegions: "input-token" } },
  ] }, mathsSection: [{ components: [
    { type: "maths", subType: "basicMaths", id: "tokenCost", operation: "multiplication", operands: [{ variableId: "tokens", required: true }, { variableId: "tokenRate", required: true }], outputUnitLabel: "USD monthly cost", decimalPlaces: 4 },
  ] }] }] }],
};

const selectorDefinition = {
  version: "3.0.0", serviceName: "Generic AI", serviceCode: "genericAI", type: "AWSService",
  subType: "subServiceSelector", layout: "loader", mappingDefinitions: [],
  templates: ["provider"], defaultTemplates: ["provider"], templateId: "genericAIGroup",
};

const conditionalDefinition = {
  version: "4.0.0", serviceName: "Conditional", serviceCode: "conditional", type: "AWSService", layout: "simple",
  mappingDefinitions: [], templates: [{ id: "conditional-template", cards: [
    { title: "Mode", inputSection: { components: [
      { type: "input", subType: "dropdown", id: "mode", label: "Mode", defaultDropDownItem: "basic", validations: { required: true }, options: [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro" }] },
    ] } },
    { title: "Pro", displayIf: { and: [{ "==": [componentRef("mode"), "pro"] }, { ">": [componentRef("workers"), 0] }] }, inputSection: { components: [
      { type: "input", subType: "numericInput", id: "workers", label: "Workers", defaultValue: 1, validations: { required: true } },
      { type: "input", subType: "numericInput", id: "hours", label: "Hours", validations: { required: true } },
    ] }, mathsSection: [{ components: [
      { type: "maths", subType: "basicMaths", id: "total", operation: "multiplication", operands: [{ variableId: "workers", required: true }, { variableId: "hours", required: true }], outputUnitLabel: "USD monthly cost" },
    ] }] },
  ] }],
};

const genericConstructDefinition = {
  version: "5.0.0", serviceName: "Generic Constructs", serviceCode: "genericConstructs", type: "AWSService", layout: "simple",
  mappingDefinitions: [
    { mappingDefinitionName: "lookup", mappingDefinitionURL: "pricing/lookup/[currency]/metadata.json" },
    { mappingDefinitionName: "rates", mappingDefinitionURL: "pricing/rates/[currency]/current.json" },
  ],
  templates: [{ id: "generic-constructs", cards: [{ title: "Inputs", displayIf: { checkboxChecked: componentRef("enabled") }, inputSection: { components: [
    { type: "input", subType: "checkbox", id: "enabled", label: "Enabled", defaultValue: true, validations: { required: true } },
    { type: "input", subType: "utilization", id: "hours", label: "Hours", defaultValue: 4, defaultDuration: "hoursPerMonth", validations: { required: true } },
    { type: "input", subType: "dataTransferV2", id: "transferCost", label: "Transfer", preferredUnit: "gb", validations: { required: true } },
    { type: "input", subType: "dropdown", id: "rateId", label: "Rate", defaultDropDownItem: "rate-1", options: [{ id: "rate-1", label: "Rate 1" }], validations: { required: true } },
    {
      type: "input", subType: "columnFormIPM", id: "countryLookup", mappingDefinitionName: "lookup",
      row: [{ label: "Country", type: "dropDown", selectorId: "Country" }], calculationId: { hourly: "countryRate" },
      validations: { required: true },
    },
    { type: "input", subType: "condition", id: "usageAlert", label: "Alert", rule: { conditions: [] } },
    { type: "pricing", subType: "concatenate", id: "hoursText", operands: [{ variableId: "hours" }, { constant: " hours" }] },
    { type: "pricing", subType: "replace", id: "normalizedHours", originalId: "hoursText", replacements: [{ originalString: " hours", replaceString: "" }] },
    { type: "pricing", subType: "pricingComboV2", id: "selectedRate", mappingDefinitionName: "rates", refers: [{ variableId: "rateId", key: "price" }] },
  ] }, mathsSection: [{ components: [
    { type: "maths", subType: "basicMaths", id: "poweredTransfer", operation: "exponent", operands: [{ variableId: "transferCost", required: true }, { constant: 2 }], outputUnitLabel: "USD transfer cost" },
    { type: "maths", subType: "maxMin", id: "minimumHours", operation: "Maximum", operands: [{ variableId: "normalizedHours", required: true }, { constant: 5 }], outputUnitLabel: "hours" },
    { type: "maths", subType: "rounding", id: "roundedTransfer", method: "roundUp", factor: 2, operands: [{ variableId: "transferCost", required: true }], outputUnitLabel: "units" },
    { type: "maths", subType: "basicMaths", id: "totalGenericCost", operation: "addition", operands: [{ variableId: "poweredTransfer", required: true }, { variableId: "countryRate", required: true }, { variableId: "normalizedHours", required: true }, { variableId: "selectedRate", required: true }, { variableId: "minimumHours", required: true }, { variableId: "roundedTransfer", required: true }], outputUnitLabel: "USD total monthly cost" },
  ] }] }] }],
};

const definitions = { genericQueue: simpleDefinition, genericAI: selectorDefinition, provider: childDefinition, conditional: conditionalDefinition, genericConstructs: genericConstructDefinition };
const pricing = {
  "queue-map": { manifest: { version: "p1" }, regions: { "US East": { first: { price: "0.10" }, rest: { price: "0.05" } } } },
  models: { manifest: { version: "p2" }, regions: { "US East": { "input-token": { price: "0.0002" } } } },
  lookup: { manifest: { version: "p3" }, rows: [{ Country: "CA", countryRate: 2 }] },
  rates: { manifest: { version: "p4" }, regions: { "US East": { "rate-1": { price: "0.5" } } } },
};

function compiler() {
  return createDefinitionCompiler({
    loadDefinition: async (serviceCode) => ({ definition: structuredClone(definitions[serviceCode]), source: `fixture:${serviceCode}` }),
    loadPricing: async ({ mapping }) => structuredClone(pricing[mapping.name]),
  });
}

test("normalizes templates, bindable inputs, mappings, and stable definition metadata", () => {
  const first = parseServiceDefinition(simpleDefinition, { source: "fixture" });
  const second = parseServiceDefinition(structuredClone(simpleDefinition), { source: "fixture" });
  assert.equal(first.metadata.digest, second.metadata.digest);
  assert.equal(first.metadata.digest, definitionDigest(simpleDefinition));
  assert.deepEqual(first.templates[0].inputs.map(({ id, defaultUnit }) => ({ id, defaultUnit })), [{ id: "requests", defaultUnit: "perMonth" }]);
  assert.deepEqual(first.templates[0].inputs[0].options, []);
  assert.deepEqual(first.templates[0].inputs[0].units.map(({ id }) => id), ["perHour", "perMonth"]);
  assert.equal(first.mappings[0].name, "queue-map");
});

test("compiles a simple tiered service into a native calculator record", async () => {
  const result = await compiler().compile({ serviceCode: "genericQueue", region: "us-east-1", regionName: "US East", bindings: { requests: { value: 150, unit: "perMonth" } } });
  assert.equal(result.monthlyUsd, 12.5);
  assert.deepEqual(result.service.calculationComponents.requests, { value: "150", unit: "perMonth" });
  assert.equal(result.service.estimateFor, "queue-template");
  assert.equal(result.service.version, "1.2.3");
  assert.match(result.metadata.definition.digest, /^[a-f0-9]{64}$/);
  assert.match(result.metadata.pricing["queue-map"].digest, /^[a-f0-9]{64}$/);
});

test("compiles nested selector services without service-specific code", async () => {
  const result = await compiler().compile({
    serviceCode: "genericAI", region: "us-east-1", regionName: "US East",
    subservices: [{ serviceCode: "provider", bindings: { tokens: 1_000 } }],
  });
  assert.equal(result.service.estimateFor, "genericAIGroup");
  assert.equal(result.service.subServices[0].serviceCode, "provider");
  assert.equal(result.service.subServices[0].calculationComponents.route.value, "geo");
  assert.equal(result.monthlyUsd, 0.2);
  assert.equal(result.metadata.children[0].definition.version, "2.0.0");
});

test("evaluates complex conditional visibility and omits hidden bindings", async () => {
  const basic = await compiler().compile({ serviceCode: "conditional", region: "us-east-1", regionName: "US East", bindings: { mode: "basic" } });
  assert.deepEqual(Object.keys(basic.service.calculationComponents), ["mode"]);
  const pro = await compiler().compile({ serviceCode: "conditional", region: "us-east-1", regionName: "US East", bindings: { mode: "pro", workers: 2, hours: 10 } });
  assert.equal(pro.monthlyUsd, 20);
  assert.equal(evaluateCondition({ or: [{ "==": [componentRef("mode"), "pro"] }, { not: { "==": [componentRef("mode"), "basic"] } }] }, { values: { mode: "pro" } }), true);
  assert.equal(evaluateCondition({ checkboxChecked: componentRef("enabled") }, { values: { enabled: true } }), true);
  assert.equal(evaluateCondition({ checkboxNotChecked: componentRef("enabled") }, { values: { enabled: false } }), true);
  assert.equal(evaluateCondition({ exists: componentRef("enabled") }, { values: { enabled: false } }), true);
});

test("supports generic lookup, utilization, transfer, transforms, condition UI, and exponent constructs", async () => {
  const model = parseServiceDefinition(genericConstructDefinition);
  assert.deepEqual(model.templates[0].inputs.find((input) => input.id === "countryLookup").aliases, ["Country"]);
  const result = await compiler().compile({
    serviceCode: "genericConstructs", region: "us-east-1", regionName: "US East",
    bindings: {
      enabled: true,
      transferCost: { value: 3, unit: "gb" },
      countryLookup: { value: "CA" },
    },
  });
  assert.equal(result.evaluation.values.hoursText, "4 hours");
  assert.equal(result.evaluation.values.normalizedHours, "4");
  assert.equal(result.evaluation.values.poweredTransfer, 9);
  assert.equal(result.evaluation.values.minimumHours, 5);
  assert.equal(result.evaluation.values.roundedTransfer, 4);
  assert.equal(result.evaluation.values.selectedRate, 0.5);
  assert.equal(result.monthlyUsd, 24.5);
  assert.deepEqual(result.service.calculationComponents.hours, { value: "4", unit: "hoursPerMonth" });
  assert.deepEqual(result.service.calculationComponents.transferCost, { value: "3", unit: "gb" });
});

test("specialized constructs use explicit component and maths adapter hooks", async () => {
  const specialized = {
    version: "1", serviceName: "Specialized", serviceCode: "specialized", type: "AWSService", layout: "simple", mappingDefinitions: [],
    templates: [{ id: "special", cards: [{ title: "Workload", inputSection: { components: [
      { type: "input", subType: "workloadDropdown", id: "workload", label: "Workload" },
    ] }, mathsSection: [{ components: [
      { type: "maths", subType: "workloadInstanceMath", id: "workloadCost", outputUnitLabel: "USD total cost" },
    ] }] }] }],
  };
  definitions.specialized = specialized;
  const withAdapters = createDefinitionCompiler({
    loadDefinition: async (serviceCode) => definitions[serviceCode],
    loadPricing: async () => ({}),
    adapters: {
      components: {
        workloadDropdown: ({ component, bindings }) => ({ handled: true, values: { workloadUnits: Number(bindings[component.id]) }, calculationComponents: { [component.id]: { value: String(bindings[component.id]) } } }),
      },
      maths: {
        workloadInstanceMath: ({ values }) => ({ handled: true, value: values.workloadUnits * 10 }),
      },
    },
  });
  const result = await withAdapters.compile({ serviceCode: "specialized", region: "us-east-1", regionName: "US East", bindings: { workload: 3 } });
  assert.equal(result.monthlyUsd, 30);
  assert.equal(classifyDefinition(specialized).status, "adapter-required");
});

test("Windows Workloads adapter compiles native bindings and reprices with pinned derived subtotals", async () => {
  const windowsDefinition = {
    version: "1.0.35", serviceName: "Microsoft Workloads on AWS", serviceCode: "windowsWorkloads", type: "AWSService", layout: "simple", mappingDefinitions: [],
    templates: [{ id: "sharedTenancy", cards: [{ title: "Licensing", inputSection: { components: [
      { type: "input", subType: "conditionalCheckboxes", id: "windowsLicenseCheckboxes", options: [{ id: "bringWindowsLicense", prechecked: false }] },
      { type: "input", subType: "workloadsConditionalComponent", id: "tenancyWorkflow", storeVariable: "workflow" },
      { type: "input", subType: "workloadsInstanceSearch", id: "instanceTypeSearch", validations: { required: true } },
      { type: "input", subType: "pricingStrategy", id: "pricingStrategy", validations: { required: true } },
      { type: "input", subType: "windowsWorkloadStorage", id: "machineSpecificationStorage", validations: { required: true } },
      { type: "input", subType: "workflowInstruction", id: "instructions" },
    ] }, mathsSection: [{ components: [
      { type: "maths", subType: "workloadInstanceMath", id: "workloadInstanceMath", subTotalIds: { monthly: { ondemand: "totalOnDemandPrice" }, upfront: "totalInstanceUpfrontPrice" } },
      { type: "maths", subType: "workloadStorageMath", id: "workloadStorageMath", subTotalId: "totalStorageCost" },
    ] }] }] }],
  };
  definitions.windowsWorkloads = windowsDefinition;
  const instance = createDefinitionCompiler({
    loadDefinition: async (serviceCode) => definitions[serviceCode],
    loadPricing: async () => ({}),
    adapters: windowsWorkloadsAdapter,
  });
  const compiled = await instance.compile({
    serviceCode: "windowsWorkloads", region: "us-east-1", regionName: "US East",
    bindings: {
      windowsLicenseCheckboxes: { bringWindowsLicense: false },
      tenancyWorkflow: "shared",
      instanceTypeSearch: { value: "m6i.xlarge", derived: { totalOnDemandPrice: 100, totalInstanceUpfrontPrice: 10 } },
      pricingStrategy: { value: { model: "ondemand" } },
      machineSpecificationStorage: { value: [{ type: "gp3", size: 100 }], derived: { totalStorageCost: 25 } },
    },
  });
  assert.equal(compiled.monthlyUsd, 125);
  assert.equal(compiled.service.serviceCost.upfront, 10);
  assert.deepEqual(compiled.service.calculationComponents.instanceTypeSearch, { value: "m6i.xlarge" });
  assert.equal(classifyDefinition(windowsDefinition, { adapters: windowsWorkloadsAdapter }).status, "adapter-backed");
  const repriced = await instance.repriceService(compiled.service, { metadata: compiled.metadata });
  assert.equal(repriced.monthlyUsd, 125);
  assert.equal(repriced.matchesStoredCost, true);
  await assert.rejects(
    instance.repriceService(compiled.service),
    (error) => error instanceof DefinitionCompilerError && error.diagnostics[0].code === "windows-workloads.subtotal.required",
  );
});

test("reprices saved calculation components independently and detects pinned drift", async () => {
  const instance = compiler();
  const compiled = await instance.compile({ serviceCode: "genericQueue", region: "us-east-1", regionName: "US East", bindings: { requests: 150 } });
  compiled.service.serviceCost.monthly = 999;
  const repriced = await instance.repriceService(compiled.service, { metadata: compiled.metadata });
  assert.equal(repriced.monthlyUsd, 12.5);
  assert.equal(repriced.storedMonthlyUsd, 999);
  assert.equal(repriced.matchesStoredCost, false);
  await assert.rejects(
    instance.repriceService(compiled.service, { metadata: { ...compiled.metadata, definition: { ...compiled.metadata.definition, digest: "0".repeat(64) } } }),
    (error) => error instanceof DefinitionCompilerError && error.diagnostics[0].code === "reprice.definition.drift",
  );
});

test("unknown operations and schema drift fail closed with structured diagnostics", async () => {
  definitions.drifted = structuredClone(simpleDefinition);
  definitions.drifted.serviceCode = "drifted";
  definitions.drifted.templates[0].cards[0].mathsSection[0].components[0].subType = "quantumPricing";
  await assert.rejects(
    compiler().compile({ serviceCode: "drifted", region: "us-east-1", regionName: "US East", bindings: { requests: 1 } }),
    (error) => error instanceof DefinitionCompilerError && error.diagnostics[0].code === "definition.maths.unsupported",
  );
});

test("schema audit classifies every manifest entry and records fail-closed reasons", async () => {
  const unknown = structuredClone(simpleDefinition);
  unknown.templates[0].cards[0].inputSection.components.push({ type: "pricing", subType: "futurePricing", id: "future", mappingDefinitionName: "queue-map" });
  assert.equal(classifyDefinition(simpleDefinition).status, "exact-schema-supported");
  assert.deepEqual(classifyDefinition(unknown).reasons, [{ code: "component.subtype.unsupported", construct: "pricing:futurePricing" }]);
  const manifest = { awsServices: [
    { serviceCode: "genericQueue", isActive: "true" },
    { serviceCode: "unknown", isActive: true },
    { serviceCode: "old", isActive: "false" },
  ] };
  const report = await auditManifest({ manifest, loadDefinition: async (entry) => entry.serviceCode === "unknown" ? unknown : simpleDefinition });
  assert.equal(report.classifiedEntries, report.totalManifestEntries);
  assert.deepEqual(report.counts, { "exact-schema-supported": 1, "fail-closed": 1, inactive: 1 });
});
