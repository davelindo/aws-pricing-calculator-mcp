import test from "node:test";
import assert from "node:assert/strict";

import { designArchitecture, priceArchitecture } from "../src/architecture.js";
import { getScenario, ROADMAP_REGIONS } from "../test-support/helpers.js";

test("designArchitecture infers an edge blueprint and explicit capability coverage from a brief", () => {
  const architecture = designArchitecture({
    brief:
      "Need a 9k monthly edge API platform in eu-west-1 with CloudFront, Lambda, DynamoDB, Route53, and API Gateway.",
  });

  assert.equal(architecture.readyToPrice, true);
  assert.equal(architecture.blueprintId, "edge-api-platform");
  assert.equal(architecture.region, "eu-west-1");
  assert.equal(architecture.targetMonthlyUsd, 9000);
  assert.equal(architecture.defaultScenarioPolicies.length, 3);
  assert.ok(architecture.packIds.includes("edge"));
  assert.equal(architecture.confidence.level, "high");
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-cloudfront"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-lambda"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-dynamodb"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-api-gateway-http"));
  assert.equal(architecture.serviceCoverage.unavailable.length, 0);
});

test("priceArchitecture keeps the edge blueprint exact-link eligible in eu-west-1", () => {
  const priced = priceArchitecture({
    blueprintId: "edge-api-platform",
    region: "eu-west-1",
    targetMonthlyUsd: 9000,
  });

  const baseline = getScenario(priced);
  const recommended = priced.scenarios.find(
    (scenario) => scenario.id === priced.recommendedScenarioId,
  );

  assert.ok(baseline);
  assert.ok(recommended);
  assert.equal(baseline.scenarioPolicy.computeCommitment, "on-demand");
  assert.equal(baseline.calculatorEligible, true);
  assert.deepEqual(baseline.calculatorBlockers, []);
  assert.ok(baseline.linkPlan);
  assert.ok(recommended.expectedSavingsPct >= baseline.expectedSavingsPct);
});

test("designArchitecture keeps the event-driven blueprint fully exact in us-east-1", () => {
  const architecture = designArchitecture({
    blueprintId: "event-driven-platform",
    region: "us-east-1",
    targetMonthlyUsd: 8000,
  });

  assert.equal(architecture.readyToPrice, true);
  assert.equal(architecture.serviceCoverage.unavailable.length, 0);
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-eventbridge"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-sqs"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-sns"));
  assert.ok(architecture.serviceCoverage.exact.includes("amazon-lambda"));
});

test("priceArchitecture keeps scoped core container baselines exact-link eligible", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
    clientName: "ExampleCo",
    includeDefaultAddOns: false,
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(priced.architecture.estimateName, "ExampleCo - Container Platform");
  assert.equal(baseline.calculatorEligible, true);
  assert.equal(baseline.linkPlan?.blueprintId, "container-platform");
});

test("priceArchitecture keeps exact add-ons calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["application-load-balancer", "amazon-s3"],
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.equal(baseline.linkPlan?.exactAddOns.length, 2);
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "application-load-balancer"),
  );
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-s3"));
});

test("priceArchitecture keeps API Gateway exact add-ons calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["amazon-api-gateway-http"],
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.equal(baseline.linkPlan?.exactAddOns.length, 1);
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-api-gateway-http"),
  );
});

test("priceArchitecture keeps Lambda and DynamoDB exact add-ons calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    serviceIds: ["amazon-lambda", "amazon-dynamodb"],
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.equal(baseline.linkPlan?.exactAddOns.length, 2);
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-lambda"));
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-dynamodb"));
});

test("priceArchitecture keeps the edge blueprint calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "edge-api-platform",
    region: "us-east-1",
    targetMonthlyUsd: 9000,
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(baseline.linkPlan);
  assert.ok(
    baseline.linkPlan.exactAddOns.some((service) => service.serviceId === "amazon-cloudfront"),
  );
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-cloudfront"));
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-api-gateway-http"),
  );
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-lambda"));
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-dynamodb"));
});

test("priceArchitecture keeps the event-driven blueprint calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "event-driven-platform",
    region: "us-east-1",
    targetMonthlyUsd: 8000,
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(baseline.linkPlan);
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-sqs"));
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-sns"));
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-eventbridge"),
  );
});

test("priceArchitecture keeps the data-platform-lite blueprint calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "data-platform-lite",
    region: "us-east-1",
    targetMonthlyUsd: 7500,
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(baseline.linkPlan);
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-s3"));
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-aurora-postgresql"),
  );
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-cloudwatch"),
  );
});

test("priceArchitecture maps enterprise data lake briefs to a real lake-service mix", () => {
  const priced = priceArchitecture({
    brief: "Need a 25k/mo enterprise data lake.",
  });
  const baseline = getScenario(priced);

  assert.equal(priced.architecture.blueprintId, "enterprise-data-lake");
  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-s3"));
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-athena"),
  );
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-redshift"),
  );
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "aws-glue-etl"),
  );
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "aws-glue-data-catalog"),
  );
  assert.equal(
    baseline.serviceBreakdown.some((service) =>
      ["amazon-ec2", "amazon-aurora-postgresql", "amazon-opensearch"].includes(service.serviceId),
    ),
    false,
  );
});

test("priceArchitecture keeps default shared add-ons calculator-link eligible in us-east-1", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
  });

  const baseline = getScenario(priced);

  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-cloudwatch"),
  );
  assert.ok(
    baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-route53"),
  );
});

test("designArchitecture returns structured unresolved questions when key inputs are missing", () => {
  const architecture = designArchitecture({
    brief: "Need a modernization landing zone and migration path with compliance controls.",
  });

  assert.equal(architecture.readyToPrice, false);
  assert.ok(architecture.packIds.length > 0);
  assert.ok(architecture.unresolvedQuestions.some((item) => item.field === "targetMonthlyUsd"));
  assert.ok(architecture.blockerDetails.some((item) => item.field === "targetMonthlyUsd"));
});

test("priceArchitecture keeps the modernization blueprint calculator-link eligible across roadmap regions", () => {
  for (const region of ROADMAP_REGIONS) {
    const priced = priceArchitecture({
      blueprintId: "modernization-platform",
      region,
      targetMonthlyUsd: 12000,
      serviceIds: [
        "amazon-efs",
        "amazon-ebs",
        "amazon-vpc-endpoints",
        "amazon-elasticache-redis",
      ],
    });
    const baseline = getScenario(priced);

    assert.ok(baseline, `expected modernization baseline for ${region}`);
    assert.equal(baseline.calculatorEligible, true, `expected modernization eligibility in ${region}`);
    assert.ok(baseline.linkPlan, `expected modernization link plan in ${region}`);
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-ecs-fargate"),
      `expected Fargate in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-efs"),
      `expected EFS in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-ebs"),
      `expected EBS in ${region}`,
    );
  }
});

test("priceArchitecture keeps the enterprise data blueprint calculator-link eligible across roadmap regions", () => {
  for (const region of ROADMAP_REGIONS) {
    const priced = priceArchitecture({
      blueprintId: "enterprise-data-platform",
      region,
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
    });
    const baseline = getScenario(priced);

    assert.ok(baseline, `expected enterprise baseline for ${region}`);
    assert.equal(
      baseline.calculatorEligible,
      true,
      `expected enterprise-data-platform eligibility in ${region}`,
    );
    assert.ok(baseline.linkPlan, `expected enterprise link plan in ${region}`);
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-aurora-postgresql"),
      `expected Aurora PostgreSQL in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-opensearch"),
      `expected OpenSearch in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-vpc-endpoints"),
      `expected VPC endpoints in ${region}`,
    );
  }
});

test("priceArchitecture keeps the enterprise data lake blueprint calculator-link eligible across roadmap regions", () => {
  for (const region of ROADMAP_REGIONS) {
    const priced = priceArchitecture({
      blueprintId: "enterprise-data-lake",
      region,
      targetMonthlyUsd: 25000,
      serviceIds: ["amazon-kinesis-firehose"],
    });
    const baseline = getScenario(priced);

    assert.ok(baseline, `expected enterprise data lake baseline for ${region}`);
    assert.equal(
      baseline.calculatorEligible,
      true,
      `expected enterprise-data-lake eligibility in ${region}`,
    );
    assert.ok(baseline.linkPlan, `expected enterprise data lake link plan in ${region}`);
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-athena"),
      `expected Athena in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-redshift"),
      `expected Redshift in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "aws-glue-etl"),
      `expected Glue ETL in ${region}`,
    );
    assert.ok(
      baseline.serviceBreakdown.some((service) => service.serviceId === "amazon-kinesis-firehose"),
      `expected Firehose in ${region}`,
    );
  }
});
