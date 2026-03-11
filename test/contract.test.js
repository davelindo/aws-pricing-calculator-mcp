import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createContractArtifacts, TOOL_NAMES, listToolContracts } from "../src/contract/v1.js";
import { createServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(__dirname, "../docs/contracts/v1");

async function createTestClient(t) {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-contract-test-client",
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

  return client;
}

test("checked-in v1 contract artifacts stay in sync with the generated schemas", async () => {
  const artifacts = createContractArtifacts();
  const manifest = JSON.parse(
    await fs.readFile(path.join(CONTRACTS_DIR, "manifest.json"), "utf8"),
  );
  const toolError = JSON.parse(
    await fs.readFile(path.join(CONTRACTS_DIR, "tool-error.schema.json"), "utf8"),
  );

  assert.deepEqual(manifest, artifacts.manifest);
  assert.deepEqual(toolError, artifacts.toolError);

  for (const contract of listToolContracts()) {
    const generated = artifacts.tools[contract.name];
    const output = JSON.parse(
      await fs.readFile(
        path.join(CONTRACTS_DIR, `${contract.name}.output.schema.json`),
        "utf8",
      ),
    );

    assert.deepEqual(output, generated.output);

    if (generated.input) {
      const input = JSON.parse(
        await fs.readFile(
          path.join(CONTRACTS_DIR, `${contract.name}.input.schema.json`),
          "utf8",
        ),
      );

      assert.deepEqual(input, generated.input);
    }
  }
});

test("listTools exposes the frozen v1 surface", async (t) => {
  const client = await createTestClient(t);
  const result = await client.listTools();
  const emittedSnapshot = JSON.parse(
    await fs.readFile(path.join(CONTRACTS_DIR, "list-tools.snapshot.json"), "utf8"),
  );

  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );

  for (const contract of listToolContracts()) {
    const tool = result.tools.find((candidate) => candidate.name === contract.name);

    assert.ok(tool);
    assert.ok(tool.outputSchema);

    if (contract.inputSchema) {
      assert.ok(tool.inputSchema);
    }
  }

  assert.deepEqual(
    result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
    })),
    emittedSnapshot,
  );
});

test("design_architecture returns the canonical v1 shape without leaked internal policy fields", async (t) => {
  const client = await createTestClient(t);
  const result = await client.callTool({
    name: "design_architecture",
    arguments: {
      brief:
        "Need a 9k monthly edge API platform in eu-west-1 with CloudFront, Lambda, DynamoDB, Route53, and API Gateway.",
    },
  });
  const architecture = result.structuredContent;
  const policy = architecture.defaultScenarioPolicies[0];

  assert.equal(result.isError ?? false, false);
  assert.equal(policy.id, "baseline");
  assert.equal("exactLinkSupport" in policy, false);
  assert.equal("storageSizeFactor" in policy, false);
  assert.equal("storageCostFactor" in policy, false);
  assert.equal("environmentSizingFactors" in policy, false);
  assert.equal("sharedServicesSpendFactor" in policy, false);
  assert.equal("dataTransferFactor" in policy, false);
  assert.equal(architecture.inference.blueprint.value, architecture.blueprintId);
});

test("price_architecture returns canonical v1 scenarios without leaked internal fields", async (t) => {
  const client = await createTestClient(t);
  const result = await client.callTool({
    name: "price_architecture",
    arguments: {
      blueprintId: "container-platform",
      region: "us-east-1",
      targetMonthlyUsd: 7000,
    },
  });
  const priced = result.structuredContent;
  const scenario = priced.scenarios[0];

  assert.equal(result.isError ?? false, false);
  assert.equal("exactLinkSupport" in scenario.scenarioPolicy, false);
  assert.equal("storageSizeFactor" in scenario.scenarioPolicy, false);
  assert.equal("storageCostFactor" in scenario.scenarioPolicy, false);
  assert.equal("environmentSizingFactors" in scenario.scenarioPolicy, false);
  assert.equal("sharedServicesSpendFactor" in scenario.scenarioPolicy, false);
  assert.equal("dataTransferFactor" in scenario.scenarioPolicy, false);
  assert.ok(Array.isArray(priced.architecture.fitGaps));
  assert.ok(Array.isArray(priced.architecture.requiredUnpricedCapabilities));
});
