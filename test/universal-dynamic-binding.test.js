import test from "node:test";
import assert from "node:assert/strict";

import {
  bindArchitectureComponents,
  bindArchitectureFacts,
  evaluateDisplayCondition,
  selectCalculatorTarget,
} from "../src/universal/dynamic/index.js";

const PROVENANCE = {
  mode: "explicit",
  sourceIds: ["brief"],
  evidence: [{ sourceId: "brief", locator: "$.definition", excerpt: "EC2 facts" }],
  confidence: 0.9,
};

const EC2_INPUTS = [
  {
    id: "selectedOS",
    type: "input",
    subType: "dropdown",
    label: "Operating system",
    required: true,
    options: [
      { id: "linux", label: "Linux" },
      { id: "windows", label: "Windows" },
    ],
  },
  {
    id: "instanceType",
    type: "input",
    subType: "dropdown",
    label: "Instance type",
    required: true,
    options: [
      { id: "t3.micro", label: "t3.micro" },
      { id: "m6i.large", label: "m6i.large" },
    ],
  },
  {
    id: "workload",
    type: "input",
    subType: "numericInput",
    label: "Number of instances",
    aliases: ["instanceCount"],
    required: true,
    validations: { min: 1, max: 1000 },
  },
  {
    id: "monthlyHours",
    type: "input",
    subType: "numericInput",
    label: "Hours per month",
    required: false,
  },
];

test("bindArchitectureFacts maps EC2-like dropdown and numeric facts into compiler bindings", () => {
  const result = bindArchitectureFacts({
    component: {
      id: "web-fleet",
      serviceId: "amazon-ec2",
      configuration: {
        operatingSystem: "Linux",
        instance_type: "m6i.large",
        instanceCount: 3,
      },
      usage: { monthlyHours: 600 },
      provenance: PROVENANCE,
    },
    definition: { id: "ec2Enhancement", serviceCode: "ec2Enhancement", inputs: EC2_INPUTS },
  });

  assert.deepEqual(result.bindings, {
    selectedOS: "linux",
    instanceType: "m6i.large",
    workload: 3,
    monthlyHours: 600,
  });
  assert.equal(result.coverage.status, "ready");
  assert.deepEqual(result.questions, []);
  assert.equal(result.inputBindings[0].sourcePath, "configuration.operatingSystem");
  assert.deepEqual(result.inputBindings[0].provenance.sourceIds, ["brief"]);
  assert.equal(result.inputBindings[0].provenance.confidence, 0.9);
});

test("bindArchitectureFacts infers option and numeric tokens only when they match published inputs", () => {
  const result = bindArchitectureFacts({
    component: {
      id: "token-fleet",
      serviceId: "amazon-ec2",
      properties: {
        architectureTokens: "Linux t3.micro with 3 instances and unrelated purple widgets",
      },
      provenance: PROVENANCE,
    },
    definition: { serviceCode: "ec2Enhancement", inputs: EC2_INPUTS.slice(0, 3) },
  });

  assert.deepEqual(result.bindings, {
    selectedOS: "linux",
    instanceType: "t3.micro",
    workload: 3,
  });
  assert.deepEqual(
    result.inputBindings.map((binding) => binding.method),
    ["option-token", "option-token", "numeric-token"],
  );
  assert.doesNotMatch(JSON.stringify(result.bindings), /purple|widget/i);
});

test("bindArchitectureFacts preserves explicit storage units and performs compatible conversion", () => {
  const result = bindArchitectureFacts({
    component: {
      id: "data-volume",
      configuration: { storageSize: { value: 2, unit: "TB" } },
      provenance: PROVENANCE,
    },
    definition: {
      serviceCode: "storage",
      inputs: [
        {
          id: "allocatedStorage",
          type: "input",
          subType: "fileSize",
          label: "Storage amount",
          required: true,
          defaultUnit: "gb|NA",
          units: [{ id: "gb|NA", label: "GB" }],
        },
      ],
    },
  });

  assert.deepEqual(result.bindings.allocatedStorage, { value: 2000, unit: "gb|NA" });
  assert.equal(result.inputBindings[0].method, "semantic-key");
  assert.equal(result.questions.length, 0);
});

test("frequency options bind as numeric units rather than enumerated values", () => {
  const result = bindArchitectureFacts({
    component: {
      id: "workflow",
      usage: { numberOfExecutions: { value: 100_000, unit: "perMonth" } },
      provenance: PROVENANCE,
    },
    definition: {
      serviceCode: "stepFunctionStandard",
      inputs: [{
        id: "numberOfExecutions",
        type: "input",
        subType: "frequency",
        label: "Workflow requests",
        required: true,
        defaultUnit: "perMonth",
        options: [
          { id: "perHour", label: "per hour" },
          { id: "perMonth", label: "per month" },
        ],
      }],
    },
  });

  assert.deepEqual(result.bindings.numberOfExecutions, { value: 100_000, unit: "perMonth" });
  assert.equal(result.coverage.status, "ready");
});

test("published defaults are used only when policy explicitly permits them", () => {
  const definition = {
    serviceCode: "example",
    inputs: [
      {
        id: "tenancy",
        type: "input",
        subType: "dropdown",
        label: "Tenancy",
        required: true,
        defaultValue: "shared",
        sourcePath: "$.templates[0].tenancy",
        options: [
          { id: "shared", label: "Shared" },
          { id: "dedicated", label: "Dedicated" },
        ],
      },
    ],
  };
  const component = { id: "compute", configuration: {}, provenance: PROVENANCE };

  const strict = bindArchitectureFacts({ component, definition });
  assert.deepEqual(strict.bindings, {});
  assert.equal(strict.inputBindings[0].status, "missing");
  assert.equal(strict.diagnostics[0].code, "binding.required");
  assert.equal(strict.questions.length, 1);

  const permissive = bindArchitectureFacts({
    component,
    definition,
    policy: { allowDefaults: true },
  });
  assert.deepEqual(permissive.bindings, { tenancy: "shared" });
  assert.equal(permissive.inputBindings[0].status, "defaulted");
  assert.equal(permissive.inputBindings[0].provenance.mode, "published-default");
});

test("conditional requiredness asks only for visible required inputs", () => {
  const definition = {
    serviceCode: "conditional",
    inputs: [
      {
        id: "mode",
        type: "input",
        subType: "dropdown",
        label: "Mode",
        required: true,
        options: [
          { id: "basic", label: "Basic" },
          { id: "pro", label: "Pro" },
        ],
      },
      {
        id: "workerCount",
        type: "input",
        subType: "numericInput",
        label: "Worker count",
        required: true,
        displayIf: { "==": [{ type: "component", id: "mode" }, "pro"] },
      },
    ],
  };

  const pro = bindArchitectureFacts({
    component: { id: "app", configuration: { mode: "pro" }, provenance: PROVENANCE },
    definition,
  });
  assert.equal(pro.inputBindings[1].visibility, "visible");
  assert.equal(pro.inputBindings[1].status, "missing");
  assert.equal(pro.questions[0].inputId, "workerCount");

  const basic = bindArchitectureFacts({
    component: { id: "app", configuration: { mode: "basic" }, provenance: PROVENANCE },
    definition,
  });
  assert.equal(basic.inputBindings[1].visibility, "hidden");
  assert.equal(basic.inputBindings[1].required, false);
  assert.deepEqual(basic.questions, []);
});

test("conflicting explicit facts remain ambiguous and produce a targeted diagnostic and question", () => {
  const result = bindArchitectureFacts({
    component: {
      id: "workers",
      configuration: { instanceCount: 2 },
      usage: { instanceCount: 4 },
      provenance: PROVENANCE,
    },
    definition: { serviceCode: "ec2", inputs: [EC2_INPUTS[2]] },
  });

  assert.deepEqual(result.bindings, {});
  assert.equal(result.inputBindings[0].status, "ambiguous");
  assert.equal(result.inputBindings[0].candidates.length, 2);
  assert.equal(result.diagnostics[0].code, "binding.ambiguous");
  assert.match(result.questions[0].prompt, /which architecture fact/i);
});

test("selector child service codes require evidence unless published defaults are permitted", () => {
  const definition = {
    metadata: { serviceCode: "bedrockSelector" },
    selector: {
      templateId: "selector-template",
      serviceCodes: ["bedrockAnthropicModels", "bedrockCohereModels"],
      defaults: ["bedrockAnthropicModels"],
    },
    templates: [],
  };

  const explicit = bindArchitectureFacts({
    component: {
      id: "foundation-model",
      configuration: { modelProvider: "Cohere" },
      provenance: PROVENANCE,
    },
    definition,
  });
  assert.deepEqual(explicit.selection.selectedServiceCodes, ["bedrockCohereModels"]);
  assert.deepEqual(explicit.subservices, [
    { serviceCode: "bedrockCohereModels", bindings: {} },
  ]);
  assert.equal(explicit.selection.method, "explicit-selector-fact");

  const strict = selectCalculatorTarget({
    component: { id: "foundation-model", configuration: {}, provenance: PROVENANCE },
    definition,
  });
  assert.equal(strict.status, "missing");
  assert.equal(strict.diagnostics[0].code, "binding.selector-required");
  assert.match(strict.questions[0].prompt, /subservice\/provider/i);

  const defaulted = selectCalculatorTarget({
    component: { id: "foundation-model", configuration: {}, provenance: PROVENANCE },
    definition,
    policy: { allowDefaults: true },
  });
  assert.equal(defaulted.status, "defaulted");
  assert.deepEqual(defaulted.selectedServiceCodes, ["bedrockAnthropicModels"]);
});

test("leaf template selection binds only the explicitly chosen template", () => {
  const definition = {
    metadata: { serviceCode: "multiTemplate" },
    templates: [
      {
        id: "compute",
        title: "Compute workload",
        inputs: [{ ...EC2_INPUTS[2], id: "nodeCount", aliases: ["instanceCount"] }],
      },
      {
        id: "storage",
        title: "Storage workload",
        inputs: [
          {
            id: "storageGb",
            type: "input",
            subType: "numericInput",
            label: "Storage amount",
            required: true,
          },
        ],
      },
    ],
  };
  const result = bindArchitectureFacts({
    component: {
      id: "custom",
      configuration: { template: "Compute workload", instanceCount: 5 },
      provenance: PROVENANCE,
    },
    definition,
  });

  assert.equal(result.templateId, "compute");
  assert.deepEqual(result.bindings, { nodeCount: 5 });
  assert.equal(result.selection.method, "explicit-selector-fact");
});

test("a sole published template is selected without treating it as an inferred default", () => {
  const result = selectCalculatorTarget({
    component: { id: "queue", configuration: {}, provenance: PROVENANCE },
    definition: {
      metadata: { serviceCode: "queue" },
      templates: [{ id: "queue-template", title: "Queue" }],
    },
  });

  assert.equal(result.status, "selected");
  assert.equal(result.templateId, "queue-template");
  assert.equal(result.method, "sole-published-choice");
  assert.equal(result.confidence, 1);
});

test("batch binding resolves definitions and skips non-priceable architecture actors", () => {
  const result = bindArchitectureComponents({
    components: [
      { id: "visitor", kind: "actor", pricingStatus: "not-applicable" },
      {
        id: "fleet",
        serviceId: "amazon-ec2",
        configuration: { operatingSystem: "linux", instanceType: "t3.micro", instanceCount: 2 },
        provenance: PROVENANCE,
      },
    ],
    definitions: [
      {
        id: "amazon-ec2",
        serviceCode: "ec2Enhancement",
        inputs: EC2_INPUTS.slice(0, 3),
      },
    ],
  });

  assert.equal(result.results.length, 1);
  assert.deepEqual(result.bindingsByComponentId.fleet, {
    selectedOS: "linux",
    instanceType: "t3.micro",
    workload: 2,
  });
});

test("display-condition evaluator reports unknown dependencies without guessing", () => {
  const condition = {
    and: [
      { "==": [{ type: "component", id: "mode" }, "pro"] },
      { ">": [{ type: "component", id: "count" }, 0] },
    ],
  };
  const unknown = evaluateDisplayCondition(condition, { values: { mode: "pro" } });
  assert.equal(unknown.value, null);
  assert.deepEqual(unknown.missingReferences, ["count"]);

  const resolved = evaluateDisplayCondition(condition, {
    values: { mode: "pro", count: 2 },
  });
  assert.equal(resolved.value, true);
});
