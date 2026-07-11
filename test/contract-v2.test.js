import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  V2_TOOL_NAMES,
  architectureIRSchema,
  createV2ContractArtifacts,
  interpretArchitectureInputSchema,
  listV2ToolContracts,
  listServiceCatalogOutputSchema,
  normalizeV2ToolOutput,
  pricedArchitectureSchema,
  sourceInputSchema,
} from "../src/contract/v2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_CONTRACTS_DIR = path.resolve(__dirname, "../docs/contracts/v2");

const provenance = {
  mode: "explicit",
  sourceIds: ["source-1"],
  evidence: [{ sourceId: "source-1", locator: "components[0]", excerpt: null }],
  confidence: 1,
};

function makeArchitecture(serviceId = "aws.example-service") {
  return {
    contractVersion: "v2",
    kind: "architecture_ir",
    architectureId: "architecture-1",
    architectureRef: {
      contractVersion: "v2",
      kind: "architecture_ref",
      architectureId: "architecture-1",
      revision: "1",
      token: "architecture-token-1",
    },
    title: "Example",
    summary: null,
    sources: [
      {
        id: "source-1",
        name: "definition",
        mediaType: "application/x-future-architecture",
        formatHint: "future-graph-v99",
        locator: null,
        digest: null,
      },
    ],
    components: [
      {
        id: "component-1",
        name: "Workload",
        kind: "compute",
        description: null,
        serviceId,
        resolution: {
          status: "resolved",
          serviceId,
          serviceName: "Example Service",
          confidence: 1,
          candidates: [],
          rationale: ["Named explicitly"],
          provenance,
        },
        scopeIds: ["scope-1"],
        region: "us-east-1",
        environment: "production",
        quantity: 1,
        configuration: {},
        usage: {},
        pricingStatus: "ready",
        properties: {},
        provenance,
      },
      {
        id: "component-2",
        name: "Consumer",
        kind: "client",
        description: null,
        serviceId: null,
        resolution: null,
        scopeIds: ["scope-1"],
        region: null,
        environment: "production",
        quantity: 1,
        configuration: {},
        usage: {},
        pricingStatus: "unresolved",
        properties: {},
        provenance,
      },
    ],
    relationships: [
      {
        id: "relationship-1",
        fromComponentId: "component-2",
        toComponentId: "component-1",
        type: "invokes",
        description: null,
        properties: {},
        provenance,
      },
    ],
    scopes: [
      {
        id: "scope-1",
        name: "Production",
        kind: "environment",
        parentScopeId: null,
        componentIds: ["component-1", "component-2"],
        properties: {},
        provenance,
      },
    ],
    constraints: [],
    assumptions: [],
    conflicts: [],
    unresolved: [],
    questions: [],
    coverage: {
      status: "partial",
      score: 0.8,
      componentCount: 2,
      resolvedComponentCount: 1,
      relationshipCount: 1,
      unresolvedCount: 0,
      dimensions: [],
      gaps: ["Consumer implementation is unknown"],
    },
    provenance,
  };
}

function makeCoverage() {
  return {
    status: "partial",
    score: 0.5,
    componentCount: 2,
    pricedComponentCount: 1,
    estimatedComponentCount: 0,
    unpricedComponentCount: 1,
    unpricedComponentIds: ["component-2"],
    gaps: ["Consumer is not priced"],
  };
}

function makeEligibility() {
  return {
    eligible: true,
    status: "partially-eligible",
    eligibleComponentIds: ["component-1"],
    ineligibleComponentIds: ["component-2"],
    blockers: [],
    warnings: ["The consumer is outside the calculator estimate"],
  };
}

test("v2 accepts arbitrary service identifiers and nullable resolutions", () => {
  const serviceId = "partner.quantum-cache@2099";
  const catalog = listServiceCatalogOutputSchema.parse({
    catalogVersion: "dynamic-1",
    generatedAt: null,
    nextCursor: null,
    services: [
      {
        id: serviceId,
        provider: "aws",
        name: "Quantum Cache",
        description: null,
        category: "future-service",
        aliases: [],
        capabilities: [],
        regions: ["moon-west-1"],
        pricingSupport: "discovered",
        calculatorServiceCodes: ["FutureCalculatorCode"],
        metadata: {},
      },
    ],
  });
  const architecture = makeArchitecture(serviceId);
  const priced = pricedArchitectureSchema.parse({
    contractVersion: "v2",
    kind: "priced_architecture",
    pricingId: "pricing-1",
    architecture,
    scenarios: [
      {
        id: "scenario-1",
        title: "Baseline",
        total: { amount: 42, currency: "USD", period: "month" },
        componentPlans: [
          {
            componentId: "component-1",
            serviceId,
            resolution: architecture.components[0].resolution,
            status: "priced",
            calculatorServiceCode: "FutureCalculatorCode",
            configuration: { futureDimension: 7 },
            lineItems: [],
            cost: { amount: 42, currency: "USD", period: "month" },
            assumptionIds: [],
            warnings: [],
            provenance,
          },
        ],
        coverage: makeCoverage(),
        eligibility: makeEligibility(),
        assumptionIds: [],
        warnings: [],
        provenance,
      },
    ],
    recommendedScenarioId: "scenario-1",
    coverage: makeCoverage(),
    eligibility: makeEligibility(),
    warnings: [],
  });

  assert.equal(catalog.services[0].id, serviceId);
  assert.equal(priced.architecture.components[0].serviceId, serviceId);
  assert.equal(priced.architecture.components[1].resolution, null);
  assert.equal(priced.scenarios[0].componentPlans[0].serviceId, serviceId);
});

test("v2 preserves extension facts while requiring every graph section", () => {
  const architecture = makeArchitecture();
  architecture.graphAnnotations = { reviewState: "human-approved" };
  architecture.components[0].deploymentFact = { cells: 3 };
  architecture.relationships[0].transportFact = { protocol: "h3" };

  const parsed = normalizeV2ToolOutput("interpret_architecture", architecture);

  assert.deepEqual(parsed.graphAnnotations, architecture.graphAnnotations);
  assert.deepEqual(parsed.components[0].deploymentFact, architecture.components[0].deploymentFact);
  assert.deepEqual(
    parsed.relationships[0].transportFact,
    architecture.relationships[0].transportFact,
  );

  const withoutRelationships = { ...architecture };
  delete withoutRelationships.relationships;
  assert.equal(architectureIRSchema.safeParse(withoutRelationships).success, false);
});

test("v2 ingestion stays open to definitions, source formats, and context", () => {
  const definition = {
    vendorSpecificGraph: {
      nodes: [{ completelyUnknownFutureNode: true }],
    },
  };
  const content = { raw: ["anything", 42, { nested: true }] };
  const parsed = interpretArchitectureInputSchema.parse({
    definition,
    sources: [
      {
        id: "source-1",
        mediaType: "application/vnd.vendor.architecture+json",
        formatHint: "vendor-next",
        content,
      },
    ],
    context: {
      name: "Future platform",
      regions: ["moon-west-1"],
      environments: ["production"],
      operatingSystem: "future-os",
      targetMonthlyUsd: 42,
      sovereignCloud: "aws-iso-future",
      organizationPolicy: { tier: 7 },
    },
    assumptionsPolicy: { mode: "infer-reversible-only", vendorExtension: true },
  });

  assert.deepEqual(parsed.definition, definition);
  assert.deepEqual(parsed.sources[0].content, content);
  assert.equal(parsed.sources[0].formatHint, "vendor-next");
  assert.equal(parsed.context.sovereignCloud, "aws-iso-future");
  assert.equal(parsed.context.targetMonthlyUsd, 42);
  assert.equal(parsed.assumptionsPolicy.vendorExtension, true);
  assert.equal(sourceInputSchema.safeParse({ mediaType: "text/plain" }).success, false);
});

test("v2 tool metadata stays compact", () => {
  const artifacts = createV2ContractArtifacts();

  for (const toolName of V2_TOOL_NAMES) {
    const inputLength = JSON.stringify(artifacts.tools[toolName].input).length;
    assert.ok(inputLength < 15000, `${toolName} input metadata is ${inputLength} characters`);
  }
});

test("the contract exposes only the universal tool surface", () => {
  const expectedToolNames = [
    "list_service_catalog",
    "interpret_architecture",
    "price_architecture",
    "generate_calculator_link",
  ];

  assert.deepEqual(V2_TOOL_NAMES, expectedToolNames);
});

test("checked-in v2 contract artifacts stay in sync with the open schemas", async () => {
  const artifacts = createV2ContractArtifacts();
  const manifest = JSON.parse(
    await fs.readFile(path.join(V2_CONTRACTS_DIR, "manifest.json"), "utf8"),
  );
  const toolError = JSON.parse(
    await fs.readFile(path.join(V2_CONTRACTS_DIR, "tool-error.schema.json"), "utf8"),
  );

  assert.deepEqual(manifest, artifacts.manifest);
  assert.deepEqual(toolError, artifacts.toolError);

  for (const contract of listV2ToolContracts()) {
    const generated = artifacts.tools[contract.name];
    const input = JSON.parse(
      await fs.readFile(
        path.join(V2_CONTRACTS_DIR, `${contract.name}.input.schema.json`),
        "utf8",
      ),
    );
    const output = JSON.parse(
      await fs.readFile(
        path.join(V2_CONTRACTS_DIR, `${contract.name}.output.schema.json`),
        "utf8",
      ),
    );

    assert.deepEqual(input, generated.input);
    assert.deepEqual(output, generated.output);
  }
});
