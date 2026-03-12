import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalculatorEstimateFromScenario,
  designArchitecture,
  priceArchitecture,
} from "../src/planner.js";
import { ROADMAP_REGIONS, getScenario } from "../test-support/helpers.js";

const BLUEPRINT_TARGETS = {
  "container-platform": 7000,
  "linux-web-stack": 5000,
  "windows-app-stack": 6000,
  "edge-api-platform": 9000,
  "event-driven-platform": 8000,
  "lake-foundation": 12000,
  "lakehouse-platform": 25000,
  "streaming-data-platform": 22000,
  "warehouse-centric-analytics": 18000,
  "modernization-platform": 12000,
};

test("designArchitecture keeps every shipped blueprint priceable across the roadmap regions", () => {
  for (const [blueprintId, targetMonthlyUsd] of Object.entries(BLUEPRINT_TARGETS)) {
    for (const region of ROADMAP_REGIONS) {
      const architecture = designArchitecture({
        blueprintId,
        region,
        targetMonthlyUsd,
      });

      assert.equal(architecture.readyToPrice, true, `${blueprintId} in ${region} should price`);
      assert.deepEqual(
        architecture.serviceCoverage.unavailable,
        [],
        `${blueprintId} in ${region} should not contain unavailable services`,
      );
    }
  }
});

test("buildCalculatorEstimateFromScenario builds exact baseline estimates outside us-east-1", () => {
  const cases = [
    {
      blueprintId: "container-platform",
      region: "ca-central-1",
      targetMonthlyUsd: 7000,
      clientName: "ExampleCo",
      requiredCodes: [
        "awsEks",
        "ec2Enhancement",
        "amazonRDSPostgreSQLDB",
        "amazonVirtualPrivateCloud",
      ],
    },
    {
      brief:
        "Need a 12k monthly modernization program in eu-west-1 moving to Fargate with EFS, EBS, Redis, and PrivateLink.",
      region: "eu-west-1",
      targetMonthlyUsd: 12000,
      requiredCodes: [
        "awsFargate",
        "amazonElastiCache",
        "amazonEFS",
        "amazonElasticBlockStore",
        "awsPrivateLinkVpc",
      ],
    },
    {
      blueprintId: "lakehouse-platform",
      region: "eu-west-1",
      targetMonthlyUsd: 25000,
      requiredCodes: [
        "amazonS3",
        "amazonAthena",
        "amazonRedshift",
        "awsEtlJobsAndDevelopmentEndpoints",
        "awsGlueDataCatalogStorageRequests",
      ],
      serviceIds: ["amazon-kinesis-firehose"],
    },
  ];

  for (const testCase of cases) {
    const priced = priceArchitecture(testCase);
    const baseline = getScenario(priced);
    const built = buildCalculatorEstimateFromScenario({
      pricedScenario: baseline,
    });
    const services = Object.values(built.estimate.services);
    const serviceCodes = services.map((service) => service.serviceCode);

    assert.ok(baseline, `${testCase.blueprintId} baseline should exist`);
    assert.equal(
      baseline.calculatorEligible,
      true,
      `${testCase.blueprintId} in ${testCase.region} should be calculator-eligible`,
    );
    assert.ok(built.validation.parityDetails.length > 0, `${testCase.blueprintId} parity details`);
    assert.equal(
      built.validation.blockingFailures.length,
      0,
      `${testCase.blueprintId} in ${testCase.region} should validate without blocking failures`,
    );
    assert.ok(
      services.every((service) => service.region === testCase.region),
      `${testCase.blueprintId} should keep every service in ${testCase.region}`,
    );

    for (const serviceCode of testCase.requiredCodes) {
      assert.ok(
        serviceCodes.includes(serviceCode),
        `${testCase.blueprintId} in ${testCase.region} should include ${serviceCode}`,
      );
    }
  }
});

test("buildCalculatorEstimateFromScenario refuses streaming architectures with unresolved stream-processing gaps", () => {
  const priced = priceArchitecture({
    blueprintId: "streaming-data-platform",
    region: "ca-central-1",
    targetMonthlyUsd: 22000,
    serviceIds: ["amazon-vpc-endpoints", "aws-glue-crawlers"],
  });
  const baseline = getScenario(priced);

  assert.equal(baseline.calculatorEligible, false);
  assert.ok(
    baseline.calculatorBlockers.some((blocker) => blocker.includes("stream-processing-engine")),
  );
  assert.throws(() =>
    buildCalculatorEstimateFromScenario({
      pricedScenario: baseline,
    }),
  );
});

test("buildCalculatorEstimateFromScenario includes promoted windows add-ons in the saved estimate shape", () => {
  const priced = priceArchitecture({
    brief: "Need a 6k monthly Windows application in us-east-1 with FSx, SQL Server, and WAF.",
  });
  const baseline = getScenario(priced);
  const built = buildCalculatorEstimateFromScenario({
    pricedScenario: baseline,
  });
  const serviceCodes = Object.values(built.estimate.services).map((service) => service.serviceCode);

  assert.ok(serviceCodes.includes("amazonFSx"));
  assert.ok(serviceCodes.includes("amazonRDSForSQLServer"));
  assert.ok(serviceCodes.includes("awsWebApplicationFirewall"));
  assert.equal(built.validation.passed, true);
});

test("buildCalculatorEstimateFromScenario rejects scenarios without an exact link plan", () => {
  assert.throws(
    () =>
      buildCalculatorEstimateFromScenario({
        pricedScenario: {
          id: "manual",
          calculatorBlockers: ["missing exact serializer coverage"],
        },
    }),
    /Unable to create estimate: missing exact serializer coverage/,
  );
});

test("priceArchitecture returns nearest valid scenarios instead of throwing for under-budget requests", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 1600,
  });
  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.modeledMonthlyUsd > 0, true);
  assert.equal(baseline.calculatorEligible, true);
  assert.equal(baseline.calculatorBlockers.length, 0);
  assert.equal(baseline.budgetFit.status, "nearest_fit_above");
  assert.match(baseline.budgetFit.details, /minimum viable architecture shape/i);
});
