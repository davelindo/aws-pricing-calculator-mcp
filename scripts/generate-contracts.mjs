import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createContractArtifacts, listToolContracts } from "../src/contract/v1.js";
import { createServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(__dirname, "../docs/contracts/v1");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, stableJson(value), "utf8");
}

async function emittedToolSnapshot() {
  const server = createServer();
  const client = new Client(
    {
      name: "aws-pricing-calculator-mcp-contract-generator",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.listTools();

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
    }));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function main() {
  const artifacts = createContractArtifacts();
  const toolsSnapshot = await emittedToolSnapshot();

  await fs.mkdir(CONTRACTS_DIR, { recursive: true });
  await writeJson(path.join(CONTRACTS_DIR, "manifest.json"), artifacts.manifest);
  await writeJson(path.join(CONTRACTS_DIR, "list-tools.snapshot.json"), toolsSnapshot);
  await writeJson(path.join(CONTRACTS_DIR, "tool-error.schema.json"), artifacts.toolError);

  for (const contract of listToolContracts()) {
    const schemas = artifacts.tools[contract.name];

    if (schemas.input) {
      await writeJson(
        path.join(CONTRACTS_DIR, `${contract.name}.input.schema.json`),
        schemas.input,
      );
    }

    await writeJson(
      path.join(CONTRACTS_DIR, `${contract.name}.output.schema.json`),
      schemas.output,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
