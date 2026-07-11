import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createV2ContractArtifacts, listV2ToolContracts } from "../src/contract/v2.js";
import { createServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = path.resolve(__dirname, "../docs/contracts");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, stableJson(value), "utf8");
}

async function emittedToolSnapshot(createContractServer, clientName) {
  const server = createContractServer();
  const client = new Client(
    {
      name: clientName,
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

async function writeContractVersion({
  directory,
  artifacts,
  contracts,
  createContractServer,
  clientName,
}) {
  const toolsSnapshot = await emittedToolSnapshot(createContractServer, clientName);

  await fs.mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, "manifest.json"), artifacts.manifest);
  await writeJson(path.join(directory, "list-tools.snapshot.json"), toolsSnapshot);
  await writeJson(path.join(directory, "tool-error.schema.json"), artifacts.toolError);

  for (const contract of contracts) {
    const schemas = artifacts.tools[contract.name];

    if (schemas.input) {
      await writeJson(
        path.join(directory, `${contract.name}.input.schema.json`),
        schemas.input,
      );
    }

    await writeJson(
      path.join(directory, `${contract.name}.output.schema.json`),
      schemas.output,
    );
  }
}

async function main() {
  await writeContractVersion({
    directory: path.join(CONTRACTS_ROOT, "v2"),
    artifacts: createV2ContractArtifacts(),
    contracts: listV2ToolContracts(),
    createContractServer: createServer,
    clientName: "aws-pricing-calculator-mcp-contract-generator",
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
