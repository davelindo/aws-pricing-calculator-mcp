import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCalculatorManifest } from "../src/calculator-catalog/index.js";
import {
  clearDynamicCalculatorCatalog,
  loadAndRegisterDynamicCalculatorCatalog,
} from "../src/universal/dynamic-catalog.js";
import { createAwsCalculatorDefinitionRuntime } from "../src/universal/dynamic-definition-runtime.js";
import {
  clearDynamicPricingDefinitions,
  hydrateDynamicArchitecturePricing,
} from "../src/universal/dynamic-pricing.js";
import {
  buildUniversalEstimateFromPlan,
  priceUniversalArchitecture,
} from "../src/universal/pricing.js";
import {
  generateUniversalCalculatorLinkAsync,
  interpretArchitectureAsync,
  priceUniversalArchitectureAsync,
} from "../src/universal/runtime.js";

const DEFINITION_URL = "https://fixtures.example/data/genericQueue/en_US.json";
const DEFINITION = {
  version: "1.0.0",
  serviceName: "Generic Queue",
  serviceCode: "genericQueue",
  type: "AWSService",
  layout: "simple",
  mappingDefinitions: [
    {
      mappingDefinitionName: "queue",
      mappingDefinitionURL:
        "pricing/2.0/meteredUnitMaps/queue/[currency]/current/queue.json",
    },
  ],
  templates: [
    {
      id: "queue",
      title: "Queue",
      cards: [
        {
          title: "Requests",
          inputSection: {
            components: [
              {
                type: "input",
                subType: "frequency",
                id: "requests",
                label: "Requests",
                validations: { required: true },
              },
              {
                type: "pricing",
                subType: "singlePricePoint",
                id: "requestRate",
                mappingDefinitionName: "queue",
                meteredUnit: "request",
              },
            ],
          },
          mathsSection: [
            {
              components: [
                {
                  type: "maths",
                  subType: "basicMaths",
                  id: "monthlyCost",
                  operation: "multiplication",
                  operands: [
                    { variableId: "requests", required: true },
                    { variableId: "requestRate", required: true },
                  ],
                  outputUnitLabel: "USD monthly cost",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const PRICING = {
  regions: {
    "us-east-1": {
      request: { price: "0.02" },
    },
  },
};

function fixtureRuntime() {
  const catalog = normalizeCalculatorManifest(
    {
      awsServices: [
        {
          name: "Generic Queue",
          serviceCode: "genericQueue",
          type: "AWSService",
          isActive: "true",
          serviceDefinitionLocation: DEFINITION_URL,
          templates: [],
        },
      ],
    },
    { sourceUrl: "https://fixtures.example/manifest/en_US.json" },
  );
  const runtime = createAwsCalculatorDefinitionRuntime({
    catalog,
    fetchImpl: async (url) =>
      new Response(JSON.stringify(url === DEFINITION_URL ? DEFINITION : PRICING), {
        headers: { "content-type": "application/json" },
      }),
  });
  return { catalog, runtime };
}

function architecture(requests) {
  return {
    architectureId: "architecture-dynamic-queue",
    title: "Dynamic queue",
    components: [
      {
        id: "queue",
        name: "Generic Queue",
        serviceId: "aws-calculator:genericQueue",
        region: "us-east-1",
        inclusion: "included",
        quantity: 1,
        configuration: {},
        usage: requests == null ? {} : { requests },
        resolution: {
          status: "resolved",
          serviceId: "aws-calculator:genericQueue",
        },
      },
    ],
  };
}

test("dynamic definitions bind usage, compile, price, and validate native line items", async () => {
  const { catalog, runtime } = fixtureRuntime();

  try {
    const hydrated = await hydrateDynamicArchitecturePricing({
      architecture: architecture(100),
      catalog,
      compiler: runtime.compiler,
    });
    const priced = priceUniversalArchitecture({
      architecture: hydrated.architecture,
      scenarioPolicies: [{ id: "baseline", title: "Baseline" }],
    });

    assert.equal(hydrated.dynamicComponents[0].status, "compiled");
    assert.equal(priced.status, "ready");
    assert.equal(priced.scenarios[0].total.amount, 2);
    assert.equal(priced.eligibility.eligible, true);

    const built = buildUniversalEstimateFromPlan(priced.lineItemPlan);
    const [service] = Object.values(built.estimate.services);
    assert.equal(service.serviceCode, "genericQueue");
    assert.deepEqual(service.calculationComponents, {
      requests: { value: "100" },
    });
    assert.equal(built.validation.passed, true);
  } finally {
    clearDynamicPricingDefinitions();
  }
});

test("missing dynamic inputs become targeted pricing questions", async () => {
  const { catalog, runtime } = fixtureRuntime();

  try {
    const hydrated = await hydrateDynamicArchitecturePricing({
      architecture: architecture(),
      catalog,
      compiler: runtime.compiler,
    });
    const priced = priceUniversalArchitecture({
      architecture: hydrated.architecture,
      scenarioPolicies: [{ id: "baseline", title: "Baseline" }],
    });

    assert.equal(hydrated.dynamicComponents[0].status, "needs-input");
    assert.equal(priced.status, "needs_input");
    assert.ok(
      priced.questions.some(
        (question) =>
          question.componentId === "queue" && question.field === "requests",
      ),
    );
  } finally {
    clearDynamicPricingDefinitions();
  }
});

test("the async universal runtime discovers and prices services absent from the built-in registry", async () => {
  const manifest = {
    awsServices: [
      {
        name: "Generic Queue",
        serviceCode: "genericQueue",
        type: "AWSService",
        isActive: "true",
        serviceDefinitionLocation: DEFINITION_URL,
        templates: [],
      },
    ],
  };
  const catalogResult = await loadAndRegisterDynamicCalculatorCatalog({
    manifestUrl: "https://fixtures.example/manifest/en_US.json",
    cache: { get: async () => null, set: async () => {} },
    fetchImpl: async () =>
      new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      }),
  });
  const runtimeOptions = {
    catalogResult,
    fetchImpl: async (url) =>
      new Response(JSON.stringify(url === DEFINITION_URL ? DEFINITION : PRICING), {
        headers: { "content-type": "application/json" },
      }),
  };

  try {
    const interpreted = await interpretArchitectureAsync(
      {
        definition: "Use Generic Queue in us-east-1.",
        context: { targetMonthlyUsd: 2 },
      },
      runtimeOptions,
    );
    assert.equal(interpreted.components[0].serviceId, "aws-calculator:genericQueue");

    const priced = await priceUniversalArchitectureAsync(
      {
        definition: {
          components: [
            {
              id: "queue",
              serviceId: "aws-calculator:genericQueue",
              usage: { requests: 100 },
            },
          ],
        },
        context: { region: "us-east-1" },
        scenarioPolicies: [{ id: "baseline", title: "Baseline" }],
      },
      runtimeOptions,
    );

    assert.equal(priced.status, "ready");
    assert.equal(priced.scenarios[0].total.amount, 2);
    assert.equal(priced.eligibility.eligible, true);
  } finally {
    clearDynamicPricingDefinitions();
    clearDynamicCalculatorCatalog();
  }
});

test("dynamic services save, fetch, and independently reprice through the async runtime", async () => {
  const manifest = {
    awsServices: [
      {
        name: "Generic Queue",
        serviceCode: "genericQueue",
        type: "AWSService",
        isActive: "true",
        serviceDefinitionLocation: DEFINITION_URL,
        templates: [],
      },
    ],
  };
  const catalogResult = await loadAndRegisterDynamicCalculatorCatalog({
    manifestUrl: "https://fixtures.example/manifest/en_US.json",
    cache: { get: async () => null, set: async () => {} },
    fetchImpl: async () =>
      new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      }),
  });
  const runtimeOptions = {
    catalogResult,
    fetchImpl: async (url) =>
      new Response(JSON.stringify(url === DEFINITION_URL ? DEFINITION : PRICING), {
        headers: { "content-type": "application/json" },
      }),
  };
  const estimateId = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  let savedEstimate;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/saveAs")) {
      savedEstimate = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ body: JSON.stringify({ savedKey: estimateId }) }),
      };
    }
    if (String(url).includes(estimateId)) {
      return {
        ok: true,
        json: async () => savedEstimate,
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const result = await generateUniversalCalculatorLinkAsync(
      {
        definition: {
          title: "Dynamic queue",
          components: [
            {
              id: "queue",
              serviceId: "aws-calculator:genericQueue",
              usage: { requests: 100 },
            },
          ],
        },
        context: { region: "us-east-1" },
        scenarioPolicies: [{ id: "baseline", title: "Baseline" }],
      },
      runtimeOptions,
    );

    assert.equal(result.link.estimateId, estimateId);
    assert.equal(result.storedEstimate.monthlyUsd, 2);
    assert.equal(result.dynamicDefinitionValidation.passed, true);
    assert.ok(
      result.validation.checks.some(
        (check) => check.id.startsWith("dynamic-definition-") && check.status === "pass",
      ),
    );
  } finally {
    delete globalThis.fetch;
    clearDynamicPricingDefinitions();
    clearDynamicCalculatorCatalog();
  }
});
