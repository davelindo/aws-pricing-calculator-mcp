import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalculatorEstimateFromScenario,
  designArchitecture,
  priceArchitecture,
} from "../src/planner.js";
import {
  NON_DEFAULT_REGION_GOVERNANCE_FAILURE_ID,
  ROADMAP_REGIONS,
  getScenario,
} from "../test-support/helpers.js";

const BLUEPRINT_TARGETS = {
  "container-platform": 7000,
  "linux-web-stack": 5000,
  "windows-app-stack": 6000,
  "edge-api-platform": 9000,
  "event-driven-platform": 8000,
  "data-platform-lite": 7500,
  "modernization-platform": 12000,
  "enterprise-data-lake": 25000,
  "enterprise-data-platform": 15000,
};

test("designArchitecture keeps every shipped blueprint exact across the roadmap regions", () => {
  for (const [blueprintId, targetMonthlyUsd] of Object.entries(BLUEPRINT_TARGETS)) {
    for (const region of ROADMAP_REGIONS) {
      const architecture = designArchitecture({
        blueprintId,
        region,
        targetMonthlyUsd,
      });

      assert.equal(architecture.readyToPrice, true, `${blueprintId} in ${region} should price`);
      assert.deepEqual(
        architecture.serviceCoverage.modeled,
        [],
        `${blueprintId} in ${region} should not contain modeled services`,
      );
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
      blueprintId: "modernization-platform",
      region: "eu-west-1",
      targetMonthlyUsd: 12000,
      requiredCodes: [
        "awsFargate",
        "amazonElastiCache",
        "amazonEFS",
        "amazonElasticBlockStore",
        "awsPrivateLinkVpc",
      ],
      serviceIds: [
        "amazon-efs",
        "amazon-ebs",
        "amazon-vpc-endpoints",
        "amazon-elasticache-redis",
      ],
    },
    {
      blueprintId: "enterprise-data-lake",
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
    {
      blueprintId: "enterprise-data-platform",
      region: "ca-central-1",
      targetMonthlyUsd: 15000,
      requiredCodes: [
        "amazonS3",
        "amazonRDSAuroraPostgreSQLCompatibleDB",
        "amazonAuroraMySQLCompatible",
        "amazonRDSMySQLDB",
        "amazonRDSForSQLServer",
        "amazonElastiCache",
        "amazonElasticsearchService",
        "amazonEFS",
        "awsPrivateLinkVpc",
      ],
      serviceIds: [
        "amazon-aurora-mysql",
        "amazon-rds-mysql",
        "amazon-rds-sqlserver",
        "amazon-elasticache-redis",
        "amazon-opensearch",
        "amazon-efs",
        "amazon-vpc-endpoints",
      ],
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
    assert.ok(
      built.validation.blockingFailures.every(
        (failure) => failure.id === NON_DEFAULT_REGION_GOVERNANCE_FAILURE_ID,
      ),
      `${testCase.blueprintId} in ${testCase.region} should only fail governance justification`,
    );
    assert.ok(
      built.validation.checks.every(
        (check) =>
          !check.blocking ||
          check.status === "pass" ||
          check.id === NON_DEFAULT_REGION_GOVERNANCE_FAILURE_ID,
      ),
      `${testCase.blueprintId} in ${testCase.region} should keep blocking checks limited to region justification`,
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

test("buildCalculatorEstimateFromScenario includes promoted windows add-ons in the saved estimate shape", () => {
  const priced = priceArchitecture({
    blueprintId: "windows-app-stack",
    region: "us-east-1",
    targetMonthlyUsd: 6000,
    serviceIds: ["amazon-fsx-windows", "amazon-rds-sqlserver", "aws-waf-v2"],
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
