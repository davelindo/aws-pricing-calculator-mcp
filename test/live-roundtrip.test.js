import test from "node:test";
import assert from "node:assert/strict";

import { fetchSavedEstimate, saveEstimate } from "../src/calculator-client.js";
import {
  buildCalculatorEstimateFromScenario,
  priceArchitecture,
} from "../src/planner.js";
import { validateEstimatePayload } from "../src/validation.js";
import {
  allowedBlockingFailureIdsForRegion,
  getScenario,
  ROADMAP_REGIONS,
} from "../test-support/helpers.js";

const LIVE_ENABLED = process.env.AWS_CALCULATOR_LIVE === "1";
const CASES = [
  {
    name: "container-platform baseline",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: true,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "linux-web-stack baseline",
    blueprintId: "linux-web-stack",
    targetMonthlyUsd: 5000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "windows-app-stack baseline",
    blueprintId: "windows-app-stack",
    targetMonthlyUsd: 6000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "container-platform alb and s3 add-ons",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["application-load-balancer", "amazon-s3"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "container-platform api gateway add-on",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["amazon-api-gateway-http"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "container-platform lambda and dynamodb add-ons",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["amazon-lambda", "amazon-dynamodb"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "container-platform network load balancer add-on",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["network-load-balancer"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "container-platform private networking add-on",
    blueprintId: "container-platform",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["amazon-vpc-endpoints"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "edge-api-platform baseline",
    blueprintId: "edge-api-platform",
    targetMonthlyUsd: 9000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "event-driven-platform baseline",
    blueprintId: "event-driven-platform",
    targetMonthlyUsd: 8000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "data-platform-lite baseline",
    blueprintId: "data-platform-lite",
    targetMonthlyUsd: 7500,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "modernization-platform baseline",
    blueprintId: "modernization-platform",
    targetMonthlyUsd: 12000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "enterprise-data-platform baseline",
    blueprintId: "enterprise-data-platform",
    targetMonthlyUsd: 15000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "enterprise-data-lake baseline",
    blueprintId: "enterprise-data-lake",
    targetMonthlyUsd: 25000,
    regions: ROADMAP_REGIONS,
  },
  {
    name: "windows-app-stack promoted windows services",
    blueprintId: "windows-app-stack",
    targetMonthlyUsd: 6000,
    serviceIds: ["amazon-fsx-windows", "amazon-rds-sqlserver", "aws-waf-v2"],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "modernization-platform promoted modernization services",
    blueprintId: "modernization-platform",
    targetMonthlyUsd: 12000,
    serviceIds: [
      "amazon-efs",
      "amazon-ebs",
      "amazon-vpc-endpoints",
      "amazon-elasticache-redis",
    ],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "enterprise-data-platform promoted enterprise services",
    blueprintId: "enterprise-data-platform",
    targetMonthlyUsd: 15000,
    serviceIds: [
      "amazon-aurora-mysql",
      "amazon-rds-mysql",
      "amazon-rds-sqlserver",
      "amazon-elasticache-redis",
      "amazon-opensearch",
      "amazon-efs",
      "amazon-vpc-endpoints",
    ],
    regions: ROADMAP_REGIONS,
  },
  {
    name: "enterprise-data-lake promoted ingestion services",
    blueprintId: "enterprise-data-lake",
    targetMonthlyUsd: 25000,
    serviceIds: ["amazon-kinesis-firehose", "amazon-vpc-endpoints"],
    regions: ROADMAP_REGIONS,
  },
];

test(
  "live calculator round-trips preserve exact saved parity across roadmap coverage",
  {
    skip: !LIVE_ENABLED,
  },
  async () => {
    for (const testCase of CASES) {
      for (const region of testCase.regions ?? ["us-east-1"]) {
        const priced = priceArchitecture({
          ...testCase,
          region,
          clientName: "LiveTest",
          includeDefaultAddOns: testCase.includeDefaultAddOns ?? false,
        });
        const baseline = getScenario(priced);
        const created = buildCalculatorEstimateFromScenario({
          pricedScenario: baseline,
        });
        const saved = await saveEstimate(created.estimate);
        const fetched = await fetchSavedEstimate(saved.savedKey);
        const validation = validateEstimatePayload({
          estimate: fetched.estimate,
          templateId: created.linkPlan.templateId,
          expectedMonthlyUsd: baseline.modeledMonthlyUsd,
          expectedRegion: region,
        });
        const allowedBlockingFailureIds = allowedBlockingFailureIdsForRegion(region);

        assert.ok(
          validation.blockingFailures.every((failure) =>
            allowedBlockingFailureIds.includes(failure.id),
          ),
          `unexpected live blocking failure for ${testCase.name ?? testCase.blueprintId} in ${region}: ${validation.blockingFailures.map((failure) => failure.id).join(", ")}`,
        );
        assert.ok(
          validation.parityDetails.length > 0,
          `expected parity details for ${testCase.name ?? testCase.blueprintId} in ${region}`,
        );
        assert.ok(
          validation.checks.every(
            (check) =>
              !check.blocking ||
              check.status === "pass" ||
              allowedBlockingFailureIds.includes(check.id),
          ),
          `unexpected blocking check drift for ${testCase.name ?? testCase.blueprintId} in ${region}`,
        );
        assert.equal(
          region === "us-east-1" ? validation.passed : true,
          true,
          `live validation should fully pass on the default region path for ${testCase.name ?? testCase.blueprintId}`,
        );
      }
    }
  },
);
