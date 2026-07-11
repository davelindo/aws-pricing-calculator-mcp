import test from "node:test";
import assert from "node:assert/strict";

import { fetchSavedEstimate, saveEstimate } from "../src/calculator-client.js";
import { TARGET_REGIONS } from "../src/services/index.js";
import { interpretArchitecture } from "../src/universal/architecture.js";
import {
  buildUniversalEstimateFromPlan,
  priceUniversalArchitecture,
  validateUniversalEstimateRoundTrip,
} from "../src/universal/runtime.js";

const LIVE = process.env.AWS_CALCULATOR_LIVE === "1";
const BASELINE_ONLY = [{ id: "baseline", title: "Baseline" }];
const COMPOSITIONS = [
  {
    name: "static-edge-site",
    targetMonthlyUsd: 500,
    definition: {
      Resources: {
        Assets: { Type: "AWS::S3::Bucket" },
        Distribution: { Type: "AWS::CloudFront::Distribution" },
      },
    },
  },
  {
    name: "async-functions",
    targetMonthlyUsd: 800,
    definition: {
      nodes: [
        { id: "jobs", serviceId: "amazon-sqs" },
        { id: "worker", serviceId: "amazon-lambda", quantity: 2 },
        { id: "telemetry", serviceId: "amazon-cloudwatch" },
      ],
      edges: [{ from: "jobs", to: "worker", type: "invokes" }],
    },
  },
];

for (const region of TARGET_REGIONS) {
  for (const composition of COMPOSITIONS) {
    test(
      `live universal round trip: ${composition.name} in ${region}`,
      { skip: !LIVE },
      async () => {
        const architecture = interpretArchitecture({
          definition: composition.definition,
          context: {
            name: `Live ${composition.name} ${region}`,
            region,
            targetMonthlyUsd: composition.targetMonthlyUsd,
          },
        });
        const priced = priceUniversalArchitecture({
          architecture,
          targetMonthlyUsd: composition.targetMonthlyUsd,
          scenarioPolicies: BASELINE_ONLY,
        });
        const scenario = priced.scenarios[0];

        assert.equal(scenario.eligibility.eligible, true, scenario.eligibility.blockers.join(" "));
        const built = buildUniversalEstimateFromPlan(scenario.lineItemPlan);
        const saved = await saveEstimate(built.estimate);
        const fetched = await fetchSavedEstimate(saved.savedKey);
        const validation = validateUniversalEstimateRoundTrip(
          built.estimate,
          fetched.estimate,
        );

        assert.equal(validation.passed, true, JSON.stringify(validation.checks));
        assert.equal(
          Object.keys(fetched.estimate.services).length,
          scenario.coverage.pricedLineItemCount,
        );
      },
    );
  }
}

test(
  "live universal round trip: Bedrock Nova Lite inference in us-east-1",
  { skip: !LIVE },
  async () => {
    const architecture = interpretArchitecture({
      definition: {
        title: "Live Bedrock Nova Lite inference",
        components: [
          {
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
              averageOutputTokensPerRequest: 250,
            },
          },
        ],
      },
      context: {
        region: "us-east-1",
        targetMonthlyUsd: 17.28,
      },
    });
    const priced = priceUniversalArchitecture({
      architecture,
      scenarioPolicies: BASELINE_ONLY,
    });
    const scenario = priced.scenarios[0];

    assert.equal(scenario.eligibility.eligible, true, scenario.eligibility.blockers.join(" "));
    assert.equal(scenario.total.amount, 17.28);
    const built = buildUniversalEstimateFromPlan(scenario.lineItemPlan);
    const saved = await saveEstimate(built.estimate);
    const fetched = await fetchSavedEstimate(saved.savedKey);
    const validation = validateUniversalEstimateRoundTrip(
      built.estimate,
      fetched.estimate,
    );

    assert.equal(validation.passed, true, JSON.stringify(validation.checks));
    assert.equal(fetched.estimate.totalCost.monthly, 17.28);
  },
);
