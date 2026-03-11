import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { priceArchitecture } from "../src/architecture.js";
import { createServer } from "../src/server.js";

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
