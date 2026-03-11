import test from "node:test";
import assert from "node:assert/strict";

import { getTemplate, listServiceCatalog } from "../src/catalog.js";
import { buildComputePlan, buildNatPlan } from "../src/model.js";
import {
  TARGET_REGIONS,
  findServiceDefinitionByCalculatorServiceCode,
  getServiceDefinition,
  resolveServiceDefinitionForSavedService,
} from "../src/services/index.js";

const SERVICE_BUDGETS = {
  "amazon-eks": 220,
  "amazon-ec2": 1800,
  "amazon-athena": 1200,
  "amazon-redshift": 4200,
  "aws-glue-etl": 1600,
  "aws-glue-data-catalog": 400,
  "aws-glue-crawlers": 550,
  "amazon-kinesis-firehose": 700,
  "amazon-rds-postgresql": 950,
  "amazon-rds-mysql": 950,
  "amazon-rds-sqlserver": 1400,
  "amazon-aurora-postgresql": 1250,
  "amazon-aurora-mysql": 1250,
  "amazon-elasticache-redis": 420,
  "amazon-vpc-nat": 150,
  "application-load-balancer": 140,
  "network-load-balancer": 160,
  "amazon-s3": 90,
  "amazon-efs": 240,
  "amazon-ebs": 260,
  "amazon-ecs-ec2": 780,
  "amazon-cloudfront": 210,
  "amazon-lambda": 75,
  "amazon-dynamodb": 95,
  "amazon-api-gateway-http": 60,
  "amazon-route53": 30,
  "amazon-sqs": 80,
  "amazon-sns": 60,
  "amazon-cloudwatch": 55,
  "amazon-eventbridge": 45,
  "aws-waf-v2": 70,
  "amazon-fsx-windows": 650,
  "amazon-opensearch": 780,
  "amazon-vpc-endpoints": 120,
  "amazon-ecs-fargate": 900,
};

const DEFAULT_ENVIRONMENT_SPLIT = {
  dev: 0.2,
  staging: 0.3,
  prod: 0.5,
};
const ECS_EC2_SERVICE_ID = "amazon-ecs-ec2";
const ACTIVE_IMPLEMENTATION_STATUSES = new Set(["implemented"]);

function assertExactCatalogEntry(service) {
  assert.ok(service.calculatorServiceCodes.length > 0, `${service.id} should expose service codes`);
  assert.ok(
    service.capabilityMatrix.every((entry) => entry.support === "exact"),
    `${service.id} should be exact in every roadmap region`,
  );
  assert.ok(
    service.capabilityMatrix.every((entry) => entry.calculatorSaveSupported === true),
    `${service.id} should be calculator-save capable in every roadmap region`,
  );
  assert.ok(
    service.capabilityMatrix.every((entry) => entry.validationSupported === true),
    `${service.id} should be validation-capable in every roadmap region`,
  );
}

function buildServiceEntry(definition, region, monthlyBudgetUsd) {
  switch (definition.id) {
    case "amazon-eks":
      return definition.buildEntry({
        environment: "prod",
        region,
        notes: "Unit test baseline.",
      });
    case "amazon-ec2": {
      const computePlan = buildComputePlan(
        region,
        "linux",
        monthlyBudgetUsd,
        DEFAULT_ENVIRONMENT_SPLIT,
      );
      const prodPlan = computePlan.plans.find((plan) => plan.environment === "prod");

      return definition.buildEntry({
        environment: "prod",
        region,
        operatingSystem: "linux",
        instanceType: prodPlan.instanceType,
        instanceCount: prodPlan.instanceCount,
        pricingStrategy: {
          selectedOption: "on-demand",
          utilizationValue: "100",
        },
        notes: "Unit test baseline.",
      });
    }
    case "amazon-rds-postgresql":
      return definition.buildEntry({
        environment: "prod",
        region,
        instanceType: "db.r6g.large",
        deploymentOption: "Single-AZ",
        storageGb: 100,
        pricingModel: "OnDemand",
        notes: "Unit test baseline.",
      });
    case "amazon-vpc-nat":
      return definition.buildEntry({
        region,
        natPlan: buildNatPlan(getTemplate("linux-heavy"), region, monthlyBudgetUsd),
        notes: "Unit test baseline.",
      });
    default:
      return definition.buildEntry({
        region,
        monthlyBudgetUsd,
        notes: "Unit test baseline.",
      });
  }
}

test("service registry exposes an all-exact shipped service surface", () => {
  const catalog = listServiceCatalog();

  assert.ok(catalog.length > 0);

  for (const service of catalog) {
    assert.ok(
      ACTIVE_IMPLEMENTATION_STATUSES.has(service.implementationStatus),
      `${service.id} should be implemented or modeled`,
    );
    assert.equal(
      service.capabilityMatrix.length,
      TARGET_REGIONS.length,
      `${service.id} region count`,
    );
    assert.deepEqual(service.supportedRegions, TARGET_REGIONS, `${service.id} supported regions`);
    assertExactCatalogEntry(service);
  }
});

test("service registry maps unique calculator service codes back to their canonical definitions", () => {
  const catalog = listServiceCatalog();

  for (const service of catalog) {
    if (service.id === ECS_EC2_SERVICE_ID) {
      continue;
    }

    for (const serviceCode of service.calculatorServiceCodes) {
      const mapped = findServiceDefinitionByCalculatorServiceCode(serviceCode);

      assert.ok(mapped, `expected service code ${serviceCode} to map to a definition`);
      assert.equal(mapped.id, service.id);
    }
  }
});

test("saved ec2Enhancement entries resolve to either EC2 or ECS on EC2 based on their description", () => {
  const ec2 = getServiceDefinition("amazon-ec2");
  const ecsEc2 = getServiceDefinition(ECS_EC2_SERVICE_ID);
  const ec2Entry = ec2.buildEntry({
    environment: "shared",
    region: "us-east-1",
    operatingSystem: "linux",
    instanceType: "m6i.large",
    instanceCount: 2,
    notes: "Unit test baseline.",
  });
  const ecsEntry = ecsEc2.buildEntry({
    region: "us-east-1",
    monthlyBudgetUsd: 780,
    notes: "Unit test baseline.",
  });

  assert.equal(resolveServiceDefinitionForSavedService(ec2Entry.service)?.id, "amazon-ec2");
  assert.equal(resolveServiceDefinitionForSavedService(ecsEntry.service)?.id, ECS_EC2_SERVICE_ID);
  assert.equal(findServiceDefinitionByCalculatorServiceCode("ec2Enhancement")?.id, "amazon-ec2");
});

test("public service catalog omits implementation functions and keeps the exact surface", () => {
  for (const service of listServiceCatalog()) {
    assert.equal("buildEntry" in service, false);
    assert.equal("modelSavedMonthlyUsd" in service, false);
    assert.equal("priceBudget" in service, false);
    assert.ok(ACTIVE_IMPLEMENTATION_STATUSES.has(service.implementationStatus));
    assert.deepEqual(service.supportedRegions, TARGET_REGIONS);
  }
});

test("exact shipped service modules price budgets and round-trip through their saved-cost models", () => {
  const catalog = listServiceCatalog();

  for (const [index, serviceEntry] of catalog.entries()) {
    if (serviceEntry.implementationStatus !== "implemented") {
      continue;
    }

    const definition = getServiceDefinition(serviceEntry.id);
    const region = TARGET_REGIONS[index % TARGET_REGIONS.length];
    const capability = definition.capabilityMatrix.find((entry) => entry.region === region);
    const monthlyBudgetUsd = SERVICE_BUDGETS[serviceEntry.id] ?? 100;
    const priced = definition.priceBudget({
      definition,
      region,
      monthlyBudgetUsd,
      capability,
    });
    const built = buildServiceEntry(definition, region, monthlyBudgetUsd);

    assert.equal(typeof definition.priceBudget, "function", `${serviceEntry.id} priceBudget`);
    assert.equal(typeof definition.buildEntry, "function", `${serviceEntry.id} buildEntry`);
    assert.equal(
      typeof definition.modelSavedMonthlyUsd,
      "function",
      `${serviceEntry.id} modelSavedMonthlyUsd`,
    );
    assert.equal(priced.region, region, `${serviceEntry.id} priced region`);
    assert.equal(priced.monthlyUsd > 0, true, `${serviceEntry.id} priced monthly usd`);
    assert.equal(built.breakdown.region, region, `${serviceEntry.id} breakdown region`);
    assert.equal(built.service.region, region, `${serviceEntry.id} service region`);
    assert.equal(built.breakdown.monthlyUsd > 0, true, `${serviceEntry.id} breakdown monthly usd`);
    assert.equal(
      definition.modelSavedMonthlyUsd(built.service),
      built.service.serviceCost.monthly,
      `${serviceEntry.id} saved-cost parity`,
    );
  }
});

test("ecs on ec2 exact service still exposes a budget pricer and exact serializer", () => {
  const ecsEc2 = getServiceDefinition(ECS_EC2_SERVICE_ID);
  const capability = ecsEc2.capabilityMatrix.find((entry) => entry.region === "ca-central-1");
  const priced = ecsEc2.priceBudget({
    definition: ecsEc2,
    region: "ca-central-1",
    monthlyBudgetUsd: 780,
    capability,
  });
  const built = ecsEc2.buildEntry({
    region: "ca-central-1",
    monthlyBudgetUsd: 780,
    notes: "Unit test baseline.",
  });

  assert.equal(ecsEc2.implementationStatus, "implemented");
  assert.equal(priced.serviceId, ECS_EC2_SERVICE_ID);
  assert.equal(priced.region, "ca-central-1");
  assert.equal(priced.monthlyUsd > 0, true);
  assert.match(priced.details, /ECS on EC2 container host-month equivalents/);
  assert.equal(built.breakdown.serviceId, ECS_EC2_SERVICE_ID);
  assert.equal(built.service.serviceCode, "ec2Enhancement");
  assert.match(built.service.description, /Amazon ECS on EC2 container host baseline/);
  assert.equal(
    ecsEc2.modelSavedMonthlyUsd(built.service),
    built.service.serviceCost.monthly,
    "ecs on ec2 saved-cost parity",
  );
});
