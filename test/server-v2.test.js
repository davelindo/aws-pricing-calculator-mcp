import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildShareLink } from "../src/calculator-client.js";
import { createServer } from "../src/server.js";
import { buildUniversalEstimateFromPlan } from "../src/universal/runtime.js";

const ESTIMATE_ID = "1234567890abcdef1234567890abcdef12345678";
const STATIC_SITE = [
  "A static marketing site stores its files in an Amazon S3 bucket.",
  "CloudFront distributes the site globally and Route 53 provides DNS.",
  "Do not add Lambda, API Gateway, or a database.",
].join(" ");

async function connectedClient(t) {
  const server = createServer({ dynamicCatalog: false });
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-v2-test-client",
      version: "1.0.0",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  return client;
}

test.afterEach(() => {
  delete globalThis.fetch;
});

test("v2 exposes only the universal tool surface and an open service catalog", async (t) => {
  const client = await connectedClient(t);
  const listed = await client.listTools();

  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "list_service_catalog",
      "interpret_architecture",
      "price_architecture",
      "generate_calculator_link",
    ],
  );

  const result = await client.callTool({
    name: "list_service_catalog",
    arguments: { query: "object storage", limit: 2 },
  });

  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.catalogVersion.startsWith("v2-"), true);
  assert.ok(result.structuredContent.services.length > 0);
  assert.equal(result.structuredContent.services[0].provider, "aws");
  assert.equal(Array.isArray(result.structuredContent.services[0].aliases), true);
  assert.equal(typeof result.structuredContent.services[0].id, "string");
});

test("v2 interprets an arbitrary static site exactly as supplied", async (t) => {
  const client = await connectedClient(t);
  const result = await client.callTool({
    name: "interpret_architecture",
    arguments: {
      definition: STATIC_SITE,
      context: {
        name: "Marketing site",
        region: "us-east-1",
        targetMonthlyUsd: 120,
      },
    },
  });

  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.contractVersion, "v2");
  assert.equal(result.structuredContent.kind, "architecture_ir");
  assert.equal(result.structuredContent.architectureRef.kind, "architecture_ref");
  assert.equal(typeof result.structuredContent.architectureRef.token, "string");

  const serviceIds = new Set(
    result.structuredContent.components
      .filter((component) => component.pricingStatus !== "excluded")
      .map((component) => component.serviceId),
  );
  assert.equal(serviceIds.has("amazon-s3"), true);
  assert.equal(serviceIds.has("amazon-cloudfront"), true);
  assert.equal(serviceIds.has("amazon-route53"), true);
  assert.equal(serviceIds.has("amazon-lambda"), false);
  assert.equal(serviceIds.has("amazon-api-gateway-http"), false);
});

test("v2 architecture references round-trip into compositional pricing", async (t) => {
  const client = await connectedClient(t);
  const interpreted = await client.callTool({
    name: "interpret_architecture",
    arguments: {
      definition: STATIC_SITE,
      context: { region: "us-east-1", targetMonthlyUsd: 120 },
    },
  });
  const architecture = interpreted.structuredContent;
  const result = await client.callTool({
    name: "price_architecture",
    arguments: {
      architectureRef: architecture.architectureRef,
      pricingContext: { targetMonthlyUsd: 120 },
    },
  });

  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.kind, "priced_architecture");
  assert.equal(result.structuredContent.architecture.architectureId, architecture.architectureId);
  assert.deepEqual(
    result.structuredContent.architecture.components.map((component) => component.serviceId),
    architecture.components.map((component) => component.serviceId),
  );
  assert.ok(result.structuredContent.scenarios.length > 0);

  const exact = result.structuredContent.scenarios.find(
    (scenario) => scenario.eligibility.eligible && scenario.lineItemPlan,
  );
  assert.ok(exact);
  assert.equal(exact.pricingCommit.kind, "pricing_commit");
  assert.equal(typeof exact.pricingCommit.token, "string");
});

test("v2 generates and generically verifies an exact calculator link from a pricing commit", async (t) => {
  const client = await connectedClient(t);
  const priced = await client.callTool({
    name: "price_architecture",
    arguments: {
      definition: {
        Resources: {
          SiteBucket: { Type: "AWS::S3::Bucket" },
          Distribution: { Type: "AWS::CloudFront::Distribution" },
        },
      },
      context: { region: "us-east-1", targetMonthlyUsd: 120 },
      pricingContext: { targetMonthlyUsd: 120 },
    },
  });

  assert.equal(priced.isError ?? false, false);
  const scenario = priced.structuredContent.scenarios.find(
    (candidate) => candidate.eligibility.eligible && candidate.lineItemPlan,
  );
  assert.ok(scenario?.pricingCommit);

  const built = buildUniversalEstimateFromPlan(scenario.lineItemPlan);
  let savedEstimate;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/saveAs")) {
      assert.equal(init.method, "POST");
      savedEstimate = JSON.parse(init.body);
      assert.equal(savedEstimate.name, built.estimate.name);
      assert.equal(savedEstimate.totalCost.monthly, built.estimate.totalCost.monthly);
      assert.deepEqual(savedEstimate.services, built.estimate.services);
      return {
        ok: true,
        json: async () => ({ body: JSON.stringify({ savedKey: ESTIMATE_ID }) }),
      };
    }

    if (String(url).includes(ESTIMATE_ID)) {
      return {
        ok: true,
        json: async () => savedEstimate,
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await client.callTool({
    name: "generate_calculator_link",
    arguments: { scenario: scenario.pricingCommit },
  });

  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.contractVersion, "v2");
  assert.equal(result.structuredContent.kind, "calculator_link");
  assert.equal(result.structuredContent.link.url, buildShareLink(ESTIMATE_ID));
  assert.equal(result.structuredContent.link.official, true);
  assert.equal(result.structuredContent.link.readOnly, true);
  assert.equal(result.structuredContent.selectedScenario.id, scenario.id);
  assert.equal(result.structuredContent.validation.passed, true);
  assert.equal(result.structuredContent.validation.mode, "generic-exact-round-trip");
});

test("v2 failures use the universal error envelope", async (t) => {
  const client = await connectedClient(t);
  const result = await client.callTool({
    name: "price_architecture",
    arguments: { architectureRef: "not-a-v2-token" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.contractVersion, "v2");
  assert.equal(result.structuredContent.tool, "price_architecture");
  assert.equal(result.structuredContent.code, "invalid_input");
});
