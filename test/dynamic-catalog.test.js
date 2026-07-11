import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { MemoryCalculatorCatalogCache } from "../src/calculator-catalog/index.js";
import { interpretArchitecture } from "../src/universal/architecture.js";
import {
  clearDynamicCalculatorCatalog,
  loadAndRegisterDynamicCalculatorCatalog,
} from "../src/universal/dynamic-catalog.js";
import { universalServiceById } from "../src/universal/service-registry.js";

const FIXTURE_URL = new URL("./fixtures/calculator-manifest.json", import.meta.url);

test("the live-catalog adapter registers every active calculator service kind", async () => {
  const manifest = JSON.parse(await readFile(FIXTURE_URL, "utf8"));

  try {
    const loaded = await loadAndRegisterDynamicCalculatorCatalog({
      manifestUrl: "https://fixtures.example/manifest/en_US.json",
      cache: new MemoryCalculatorCatalogCache(),
      fetchImpl: async () =>
        new Response(JSON.stringify(manifest), {
          headers: { "content-type": "application/json" },
        }),
    });

    assert.equal(loaded.registeredCount, 3);
    assert.equal(loaded.manifestCoverage.active.coveragePercent, 100);
    assert.ok(universalServiceById("aws-calculator:parentCompute"));
    assert.ok(universalServiceById("aws-calculator:childCompute"));
    assert.ok(universalServiceById("aws-calculator:storageTco"));
    assert.equal(universalServiceById("aws-calculator:staticStrings"), null);

    const architecture = interpretArchitecture({
      definition: "Use Parent Compute in us-east-1.",
      context: { targetMonthlyUsd: 100 },
    });

    assert.equal(architecture.components[0].serviceId, "aws-calculator:parentCompute");
    assert.equal(architecture.components[0].resolution.status, "resolved");
  } finally {
    clearDynamicCalculatorCatalog();
  }
});

