import test from "node:test";
import assert from "node:assert/strict";

import { architectureIRSchema } from "../src/contract/v2.js";
import { interpretArchitecture } from "../src/universal/architecture.js";
import { listServiceDefinitions } from "../src/services/index.js";
import { registerDynamicUniversalServices } from "../src/universal/service-registry.js";

function includedServiceIds(architecture) {
  return architecture.components
    .filter((component) => component.inclusion === "included")
    .map((component) => component.serviceId);
}

test("interpretArchitecture records a static S3/CloudFront site and first-class exclusions without service injection", () => {
  const input = {
    definition:
      "Run a static website in us-east-1. Store assets in S3 and serve them through CloudFront. No Lambda, API Gateway, or DynamoDB.",
    context: { targetMonthlyUsd: 125 },
  };
  const architecture = interpretArchitecture(input);

  assert.equal(architecture.schemaVersion, "2.0");
  assert.equal(architecture.contractVersion, "v2");
  assert.equal(architecture.kind, "architecture_ir");
  assert.equal(architecture.status, "complete");
  assert.deepEqual(includedServiceIds(architecture), ["amazon-s3", "amazon-cloudfront"]);
  assert.equal(architecture.components.some((component) => component.serviceId === "amazon-ebs"), false);

  const excluded = architecture.components
    .filter((component) => component.inclusion === "excluded")
    .map((component) => component.serviceId);
  assert.deepEqual(excluded, [
    "amazon-lambda",
    "amazon-api-gateway-http",
    "amazon-dynamodb",
  ]);
  assert.equal(
    architecture.constraints.filter((constraint) => constraint.kind === "exclusion").length,
    3,
  );
  assert.deepEqual(
    [...new Set(architecture.components.map((component) => component.serviceId))],
    [
      "amazon-s3",
      "amazon-cloudfront",
      "amazon-lambda",
      "amazon-api-gateway-http",
      "amazon-dynamodb",
    ],
  );
  assert.equal(interpretArchitecture(input).architectureId, architecture.architectureId);
  architectureIRSchema.parse(architecture);
});

test("interpretArchitecture parses CloudFormation resources, engines, multiplicity, and intrinsic edges", () => {
  const architecture = interpretArchitecture({
    definition: {
      Resources: {
        PublicAssets: { Type: "AWS::S3::Bucket" },
        PrivateAssets: { Type: "AWS::S3::Bucket" },
        Api: { Type: "AWS::ApiGatewayV2::Api" },
        Handler: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: { Variables: { BUCKET_NAME: { Ref: "PrivateAssets" } } },
          },
        },
        Database: {
          Type: "AWS::RDS::DBInstance",
          Properties: { Engine: "postgres", DBInstanceClass: "db.t4g.small" },
        },
      },
    },
    context: { region: "ca-central-1", targetMonthlyUsd: 900 },
  });

  const buckets = architecture.components.filter((component) => component.serviceId === "amazon-s3");
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map((component) => component.id), ["PublicAssets", "PrivateAssets"]);
  assert.equal(
    architecture.components.find((component) => component.id === "Database").serviceId,
    "amazon-rds-postgresql",
  );
  assert.ok(
    architecture.relationships.some(
      (relationship) =>
        relationship.fromComponentId === "Handler" &&
        relationship.toComponentId === "PrivateAssets" &&
        relationship.type === "depends-on",
    ),
  );
  assert.ok(architecture.components.every((component) => component.region === "ca-central-1"));
  architectureIRSchema.parse(architecture);
});

test("interpretArchitecture parses CloudFormation YAML sources", () => {
  const architecture = interpretArchitecture({
    sources: [
      {
        id: "template",
        mediaType: "application/yaml",
        formatHint: "cloudformation-yaml",
        content: `Resources:
  SiteBucket:
    Type: AWS::S3::Bucket
  Distribution:
    Type: AWS::CloudFront::Distribution
  Events:
    Type: AWS::Events::EventBus
`,
      },
    ],
    context: { region: "eu-west-1", targetMonthlyUsd: 300 },
  });

  assert.deepEqual(includedServiceIds(architecture), [
    "amazon-s3",
    "amazon-cloudfront",
    "amazon-eventbridge",
  ]);
  assert.equal(architecture.sources[0].id, "template");
  assert.equal(architecture.components[0].provenance.evidence[0].sourceId, "template");
});

test("interpretArchitecture parses Terraform JSON and conditional resource attributes", () => {
  const architecture = interpretArchitecture({
    definition: {
      resource: {
        aws_s3_bucket: {
          assets: { bucket: "example-assets" },
        },
        aws_lb: {
          ingress: { load_balancer_type: "network" },
        },
        aws_rds_cluster: {
          primary: { engine: "aurora-postgresql" },
        },
      },
    },
    context: { region: "ap-southeast-2", targetMonthlyUsd: 1_200 },
  });

  assert.deepEqual(includedServiceIds(architecture), [
    "amazon-s3",
    "network-load-balancer",
    "amazon-aurora-postgresql",
  ]);
  assert.deepEqual(
    architecture.components.map((component) => component.id),
    ["aws_s3_bucket.assets", "aws_lb.ingress", "aws_rds_cluster.primary"],
  );
});

test("interpretArchitecture parses Terraform HCL counts and references", () => {
  const architecture = interpretArchitecture({
    sources: [
      {
        id: "main-tf",
        formatHint: "terraform",
        content: `resource "aws_instance" "web" {
  count         = 3
  instance_type = "t3.micro"
}

resource "aws_s3_bucket" "assets" {
  bucket = aws_instance.web.id
}
`,
      },
    ],
    context: { region: "us-west-2", targetMonthlyUsd: 500 },
  });

  assert.equal(
    architecture.components.find((component) => component.id === "aws_instance.web").quantity,
    3,
  );
  assert.ok(
    architecture.relationships.some(
      (relationship) =>
        relationship.fromComponentId === "aws_s3_bucket.assets" &&
        relationship.toComponentId === "aws_instance.web",
    ),
  );
});

test("interpretArchitecture preserves repeated graph nodes instead of deduplicating services", () => {
  const architecture = interpretArchitecture({
    definition: {
      nodes: [
        { id: "visitor", kind: "actor", label: "Website visitor" },
        { id: "web-assets", serviceId: "amazon-s3", quantity: 2 },
        { id: "audit-archive", serviceId: "amazon-s3", quantity: 1 },
        { id: "cdn", name: "content delivery network" },
      ],
      edges: [
        { id: "request", from: "visitor", to: "cdn", type: "requests" },
        { id: "delivery", from: "cdn", to: "web-assets", type: "origin" },
      ],
    },
    context: { region: "us-east-1", targetMonthlyUsd: 250 },
  });

  const buckets = architecture.components.filter((component) => component.serviceId === "amazon-s3");
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map((component) => component.quantity), [2, 1]);
  assert.equal(architecture.components.find((component) => component.id === "cdn").serviceId, "amazon-cloudfront");
  const visitor = architecture.components.find((component) => component.id === "visitor");
  assert.equal(visitor.pricingStatus, "not-applicable");
  assert.equal(visitor.resolution, null);
  assert.equal(architecture.unresolvedComponents.some((item) => item.componentId === "visitor"), false);
  assert.deepEqual(architecture.relationships[1], {
    ...architecture.relationships[1],
    id: "delivery",
    fromComponentId: "cdn",
    toComponentId: "web-assets",
    type: "origin",
  });
});

test("interpretArchitecture resolves Bedrock resources and preserves unsupported AWS resources", () => {
  const architecture = interpretArchitecture({
    definition: {
      components: [
        {
          id: "agent",
          resourceType: "AWS::Bedrock::Agent",
          properties: { FoundationModel: "example.model" },
        },
        { id: "workflow", resourceType: "aws_sfn_state_machine" },
      ],
    },
    context: { region: "us-east-1", targetMonthlyUsd: 600 },
  });

  assert.equal(architecture.status, "partial");
  assert.deepEqual(
    architecture.components.map((component) => component.serviceId),
    ["amazon-bedrock", "aws-sfn-state-machine"],
  );
  assert.equal(architecture.components[0].resolution.status, "resolved");
  assert.equal(architecture.components[1].resolution.status, "unresolved");
  assert.equal(architecture.unresolvedComponents.length, 1);
  assert.ok(architecture.questions.some((question) => question.id.includes("workflow")));
});

test("open AWS service identifiers do not duplicate an existing provider prefix", () => {
  const architecture = interpretArchitecture({
    definition: {
      components: [
        { id: "amazon-future", serviceId: "amazon-future-ai" },
        { id: "aws-future", serviceId: "aws-future-machine" },
      ],
    },
    context: { region: "us-east-1", targetMonthlyUsd: 100 },
  });

  assert.deepEqual(
    architecture.components.map((component) => component.serviceId),
    ["amazon-future-ai", "aws-future-machine"],
  );
  assert.ok(
    architecture.components.every((component) => component.resolution.status === "unresolved"),
  );
});

test("usage-priced architectures do not require an artificial monthly budget", () => {
  const architecture = interpretArchitecture({
    definition: {
      components: [
        {
          id: "foundation-model",
          serviceId: "amazon-bedrock",
          usage: {
            averageRequestsPerMinute: 10,
            hoursPerDay: 8,
            averageInputTokensPerRequest: 1_000,
            averageOutputTokensPerRequest: 250,
          },
        },
      ],
    },
    context: { region: "us-east-1" },
  });

  assert.equal(architecture.status, "complete");
  assert.equal(architecture.coverage.hasBudget, false);
  assert.equal(architecture.coverage.hasUsage, true);
  assert.equal(architecture.coverage.hasPricingInputs, true);
  assert.equal(
    architecture.questions.some((question) => question.id === "question.monthly-budget"),
    false,
  );
});

test("interpretArchitecture remains partial and asks targeted questions when region and budget are absent", () => {
  const architecture = interpretArchitecture({ definition: "Three EC2 instances with an S3 bucket." });

  assert.equal(architecture.status, "partial");
  assert.equal(architecture.coverage.hasRegion, false);
  assert.equal(architecture.coverage.hasBudget, false);
  assert.equal(
    architecture.components.find((component) => component.serviceId === "amazon-ec2").quantity,
    3,
  );
  assert.ok(architecture.questions.some((question) => question.id === "question.region"));
  assert.ok(architecture.questions.some((question) => question.id === "question.monthly-budget"));
  assert.equal(
    architecture.assumptions.some((assumption) => /default/i.test(assumption.statement)),
    false,
  );
});

test("interpretArchitecture resolves every current catalog service by canonical ID", () => {
  const catalog = listServiceDefinitions();
  assert.equal(catalog.length, 36);
  const architecture = interpretArchitecture({
    definition: { serviceIds: catalog.map((service) => service.id) },
    context: { region: "us-east-1", targetMonthlyUsd: 10_000 },
  });

  assert.equal(architecture.components.length, 36);
  assert.ok(architecture.components.every((component) => component.resolution.status === "resolved"));
  assert.deepEqual(includedServiceIds(architecture), catalog.map((service) => service.id));
});

test("dynamically discovered services participate in prose and CloudFormation resolution", () => {
  registerDynamicUniversalServices([
    {
      canonicalServiceId: "aws-calculator:awsStepFunctions",
      name: "AWS Step Functions",
      serviceCode: "awsStepFunctions",
      aliases: ["step functions", "stepfunctions"],
      keywords: ["state machine workflow"],
    },
  ]);

  try {
    const prose = interpretArchitecture({
      definition: "Run the workflow with AWS Step Functions in us-east-1.",
      context: { targetMonthlyUsd: 100 },
    });
    const cloudFormation = interpretArchitecture({
      definition: {
        Resources: {
          Workflow: { Type: "AWS::StepFunctions::StateMachine" },
        },
      },
      context: { region: "us-east-1", targetMonthlyUsd: 100 },
    });

    assert.deepEqual(includedServiceIds(prose), ["aws-calculator:awsStepFunctions"]);
    assert.equal(cloudFormation.components[0].serviceId, "aws-calculator:awsStepFunctions");
    assert.equal(cloudFormation.components[0].resolution.status, "resolved");
  } finally {
    registerDynamicUniversalServices([]);
  }
});
