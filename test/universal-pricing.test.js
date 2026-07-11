import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUniversalEstimateFromPlan,
  priceUniversalArchitecture,
} from "../src/universal/pricing.js";

const BASELINE_ONLY = [
  {
    id: "baseline",
    title: "Baseline",
  },
];

function component({
  id,
  serviceId,
  name = serviceId,
  quantity = 1,
  configuration = {},
  usage = {},
  resolution,
}) {
  return {
    id,
    name,
    serviceId,
    quantity,
    region: "us-east-1",
    configuration,
    usage,
    resolution:
      resolution ?? {
        status: "resolved",
        serviceId,
      },
  };
}

test("universal pricing composes a custom S3 and CloudFront estimate", () => {
  const architecture = {
    architectureId: "architecture-custom-edge-storage",
    title: "Custom edge storage",
    components: [
      component({
        id: "assets",
        serviceId: "amazon-s3",
        configuration: {
          monthlyBudgetUsd: 90,
        },
      }),
      component({
        id: "delivery",
        serviceId: "amazon-cloudfront",
      }),
    ],
  };
  const priced = priceUniversalArchitecture({
    architecture,
    targetMonthlyUsd: 300,
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.contractVersion, "v2");
  assert.equal(priced.kind, "priced_architecture");
  assert.equal(priced.status, "ready");
  assert.equal(priced.recommendedScenarioId, "baseline");
  assert.equal(priced.componentPlans.length, 2);
  assert.equal(
    priced.componentPlans.find((plan) => plan.componentId === "assets").monthlyBudgetUsd,
    90,
    "an explicit component budget takes precedence over target allocation",
  );
  assert.equal(
    priced.componentPlans.find((plan) => plan.componentId === "delivery").monthlyBudgetUsd,
    210,
  );
  assert.equal(priced.scenarios[0].total.amount, 300);
  assert.equal(priced.eligibility.eligible, true);
  assert.equal(Object.isFrozen(priced.lineItemPlan), true);
  assert.equal(Object.isFrozen(priced.lineItemPlan.lineItems), true);

  const built = buildUniversalEstimateFromPlan(priced.lineItemPlan);
  const serviceCodes = Object.values(built.estimate.services)
    .map((service) => service.serviceCode)
    .sort();

  assert.deepEqual(serviceCodes, ["amazonCloudFront", "amazonS3"]);
  assert.equal(built.estimate.totalCost.monthly, 300);
  assert.equal(built.validation.validationMode, "generic");
  assert.equal(built.validation.contextSource, "universal");
  assert.equal(built.validation.passed, true);
});

test("unresolved components block an exact link while retaining partial known pricing", () => {
  const architecture = {
    architectureId: "architecture-partial",
    title: "Partially understood architecture",
    components: [
      component({
        id: "known-bucket",
        serviceId: "amazon-s3",
      }),
      component({
        id: "future-service",
        serviceId: "amazon-future-service",
        name: "Future AWS service",
        resolution: {
          status: "unresolved",
          serviceId: null,
          reason: "unsupported-aws-resource",
        },
      }),
    ],
  };
  const priced = priceUniversalArchitecture({
    architecture,
    targetMonthlyUsd: 120,
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.status, "needs_input");
  assert.equal(priced.coverage.status, "partial");
  assert.equal(priced.coverage.pricedComponentCount, 1);
  assert.deepEqual(priced.coverage.unpricedComponentIds, ["future-service"]);
  assert.equal(priced.eligibility.eligible, false);
  assert.ok(priced.eligibility.ineligibleComponentIds.includes("future-service"));
  assert.equal(priced.scenarios[0].total.amount, 120);
  assert.equal(priced.lineItemPlan.lineItems.length, 1);
  assert.ok(
    priced.questions.some(
      (question) =>
        question.componentId === "future-service" && question.field === "serviceId",
    ),
  );
  assert.throws(
    () => buildUniversalEstimateFromPlan(priced.lineItemPlan),
    /not supported service resolution|not calculator-eligible|no supported service resolution/i,
  );
});

test("component quantity is preserved as separate calculator line items", () => {
  const architecture = {
    architectureId: "architecture-multiple-buckets",
    title: "Three independent buckets",
    components: [
      component({
        id: "buckets",
        serviceId: "amazon-s3",
        quantity: 3,
      }),
    ],
  };
  const priced = priceUniversalArchitecture({
    architecture,
    targetMonthlyUsd: 90,
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.status, "ready");
  assert.equal(priced.componentPlans[0].quantity, 3);
  assert.equal(priced.componentPlans[0].lineItems.length, 3);
  assert.equal(priced.coverage.requestedQuantity, 3);
  assert.equal(priced.coverage.pricedLineItemCount, 3);
  assert.deepEqual(
    priced.lineItemPlan.lineItems.map((lineItem) => lineItem.monthlyBudgetUsd),
    [30, 30, 30],
  );

  const built = buildUniversalEstimateFromPlan(priced.lineItemPlan);

  assert.equal(Object.keys(built.estimate.services).length, 3);
  assert.equal(built.estimate.totalCost.monthly, 90);
});

test("a budget-driven service without target or usage returns targeted needs_input", () => {
  const architecture = {
    architectureId: "architecture-no-budget",
    title: "Unquantified storage",
    components: [
      component({
        id: "unquantified-bucket",
        serviceId: "amazon-s3",
      }),
    ],
  };
  const priced = priceUniversalArchitecture({
    architecture,
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.status, "needs_input");
  assert.equal(priced.targetMonthlyUsd, null);
  assert.equal(priced.scenarios[0].total.amount, 0);
  assert.equal(priced.componentPlans[0].status, "needs_input");
  assert.equal(priced.componentPlans[0].cost, null);
  assert.equal(priced.lineItemPlan.lineItems.length, 0);
  assert.equal(priced.eligibility.eligible, false);
  assert.ok(
    priced.questions.some(
      (question) =>
        question.componentId === "unquantified-bucket" &&
        question.field === "monthlyBudgetUsd",
    ),
  );
});

test("Bedrock inference prices explicit token usage without inventing a budget", () => {
  const architecture = {
    architectureId: "architecture-bedrock-inference",
    title: "Bedrock customer-support inference",
    components: [
      component({
        id: "foundation-model",
        serviceId: "amazon-bedrock",
        name: "Amazon Nova Lite inference",
        configuration: {
          provider: "amazon",
          model: "Amazon Nova Lite",
          inferenceRoute: "geo-cross-region",
          inferenceType: "on-demand-standard",
          imageInput: false,
          promptCaching: false,
        },
        usage: {
          averageRequestsPerMinute: 10,
          hoursPerDay: 8,
          averageInputTokensPerRequest: 1_000,
          averageOutputTokensPerRequest: 250,
        },
      }),
    ],
  };
  const priced = priceUniversalArchitecture({
    architecture,
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.status, "ready");
  assert.equal(priced.targetMonthlyUsd, null);
  assert.equal(priced.scenarios[0].total.amount, 17.28);
  assert.equal(priced.componentPlans[0].monthlyBudgetUsd, null);
  assert.equal(priced.eligibility.eligible, true);

  const built = buildUniversalEstimateFromPlan(priced.lineItemPlan);
  const [service] = Object.values(built.estimate.services);

  assert.equal(service.serviceCode, "amazonBedrock");
  assert.equal(service.estimateFor, "amazonBedrockClassesGroup");
  assert.equal(service.subServices.length, 1);
  assert.equal(service.subServices[0].serviceCode, "amazon");
  assert.equal(
    service.subServices[0].calculationComponents.avgRequestsPerMingeoStan.value,
    "10",
  );
  assert.equal(built.estimate.totalCost.monthly, 17.28);
  assert.equal(built.validation.passed, true);
});

test("Bedrock inference asks for the specific missing usage field", () => {
  const priced = priceUniversalArchitecture({
    architecture: {
      architectureId: "architecture-incomplete-bedrock-inference",
      components: [
        component({
          id: "foundation-model",
          serviceId: "amazon-bedrock",
          configuration: {
            provider: "amazon",
            model: "Amazon Nova Lite",
            inferenceRoute: "geo-cross-region",
            inferenceType: "on-demand-standard",
            imageInput: false,
            promptCaching: false,
          },
          usage: {
            averageRequestsPerMinute: 10,
            hoursPerDay: 8,
            averageInputTokensPerRequest: 1_000,
          },
        }),
      ],
    },
    scenarioPolicies: BASELINE_ONLY,
  });

  assert.equal(priced.status, "needs_input");
  assert.equal(priced.coverage.unpricedComponentCount, 1);
  assert.ok(
    priced.questions.some(
      (question) =>
        question.componentId === "foundation-model" &&
        question.field === "averageOutputTokensPerRequest",
    ),
  );
});
