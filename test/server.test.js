import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildShareLink } from "../src/calculator-client.js";
import { priceArchitecture } from "../src/architecture.js";
import { buildCalculatorEstimateFromScenario } from "../src/planner.js";
import { createServer } from "../src/server.js";

const ESTIMATE_ID = "89abcdef0123456789abcdef0123456789abcdef";

test.afterEach(() => {
  delete globalThis.fetch;
});

test("create_calculator_link returns a readable MCP tool error for non-eligible scenarios", async (t) => {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
    scenarioPolicies: [
      {
        id: "modeled-only",
        title: "Modeled Only",
        exactLinkSupport: "modeled-only",
      },
    ],
  });
  const pricedScenario = priced.scenarios[0];

  assert.equal(pricedScenario.calculatorEligible, false);
  assert.equal(pricedScenario.linkPlan, null);

  const result = await client.callTool({
    name: "create_calculator_link",
    arguments: {
      pricedScenario,
    },
  });
  const textBlock = result.content.find((item) => item.type === "text");

  assert.equal(result.isError, true);
  assert.ok(textBlock);
  assert.equal(result.structuredContent.tool, "create_calculator_link");
  assert.equal(result.structuredContent.code, "not_calculator_eligible");
  assert.equal(result.structuredContent.contractVersion, "v1");
  assert.match(textBlock.text, /Tool 'create_calculator_link' failed\./);
  assert.match(textBlock.text, /cannot mint an official calculator link/i);
  assert.match(textBlock.text, /Hint:/);
});

test("price_architecture returns a pricingCommit handle for exact scenarios", async (t) => {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  const result = await client.callTool({
    name: "price_architecture",
    arguments: {
      blueprintId: "container-platform",
      region: "us-east-1",
      targetMonthlyUsd: 7000,
    },
  });

  const baseline = result.structuredContent.scenarios.find((scenario) => scenario.id === "baseline");

  assert.equal(result.isError ?? false, false);
  assert.ok(baseline);
  assert.equal(baseline.calculatorEligible, true);
  assert.ok(baseline.pricingCommit);
  assert.equal(baseline.pricingCommit.kind, "pricing_commit");
  assert.equal(baseline.pricingCommit.scenarioId, baseline.id);
});

test("generate_calculator_link creates a link from pricing inputs without a client-side tool chain", async (t) => {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
  });
  const expectedScenario = priced.scenarios.find(
    (scenario) => scenario.id === priced.recommendedScenarioId,
  );

  assert.ok(expectedScenario);

  const built = buildCalculatorEstimateFromScenario({
    pricedScenario: expectedScenario,
  });

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/saveAs")) {
      assert.equal(init.method, "POST");
      return {
        ok: true,
        json: async () => ({
          body: JSON.stringify({
            savedKey: ESTIMATE_ID,
          }),
        }),
      };
    }

    if (String(url).includes(ESTIMATE_ID)) {
      return {
        ok: true,
        json: async () => built.estimate,
      };
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  };

  const result = await client.callTool({
    name: "generate_calculator_link",
    arguments: {
      blueprintId: "container-platform",
      region: "us-east-1",
      targetMonthlyUsd: 7000,
    },
  });
  const textBlock = result.content.find((item) => item.type === "text");

  assert.equal(result.isError ?? false, false);
  assert.ok(textBlock);
  assert.match(textBlock.text, /Link created successfully\./);
  assert.equal(result.structuredContent.selectedScenario.id, expectedScenario.id);
  assert.equal(result.structuredContent.recommendedScenarioId, priced.recommendedScenarioId);
  assert.equal(result.structuredContent.estimate.shareLink, buildShareLink(ESTIMATE_ID));
  assert.equal(result.structuredContent.estimate.validation.passed, true);
});

test("create_calculator_link accepts a pricingCommit handle as the advanced commit input", async (t) => {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
  });
  const expectedScenario = priced.scenarios.find(
    (scenario) => scenario.id === priced.recommendedScenarioId,
  );

  assert.ok(expectedScenario);

  const built = buildCalculatorEstimateFromScenario({
    pricedScenario: expectedScenario,
  });

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/saveAs")) {
      assert.equal(init.method, "POST");
      return {
        ok: true,
        json: async () => ({
          body: JSON.stringify({
            savedKey: ESTIMATE_ID,
          }),
        }),
      };
    }

    if (String(url).includes(ESTIMATE_ID)) {
      return {
        ok: true,
        json: async () => built.estimate,
      };
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  };

  const pricedResult = await client.callTool({
    name: "price_architecture",
    arguments: {
      blueprintId: "container-platform",
      region: "us-east-1",
      targetMonthlyUsd: 7000,
    },
  });
  const selectedScenario = pricedResult.structuredContent.scenarios.find(
    (scenario) => scenario.id === pricedResult.structuredContent.recommendedScenarioId,
  );

  assert.ok(selectedScenario?.pricingCommit);

  const result = await client.callTool({
    name: "create_calculator_link",
    arguments: {
      pricingCommit: selectedScenario.pricingCommit,
    },
  });

  assert.equal(result.isError ?? false, false);
  assert.equal(result.structuredContent.shareLink, buildShareLink(ESTIMATE_ID));
  assert.equal(result.structuredContent.validation.passed, true);
});
