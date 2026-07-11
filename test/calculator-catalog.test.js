import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CALCULATOR_ENTRY_KINDS,
  CalculatorCatalogError,
  MemoryCalculatorCatalogCache,
  auditCalculatorCoverage,
  digestCalculatorManifest,
  loadCalculatorCatalog,
  normalizeCalculatorManifest,
} from "../src/calculator-catalog/index.js";

const FIXTURE_URL = new URL("./fixtures/calculator-manifest.json", import.meta.url);
const SOURCE_URL = "https://fixtures.example/manifest/en_US.json";

async function fixtureManifest() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

function responseFor(manifest, { status = 200, headers = {} } = {}) {
  return new Response(status === 304 ? null : JSON.stringify(manifest), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("normalizes manifest kinds, URLs, lookup indexes, and template relationships", async () => {
  const catalog = normalizeCalculatorManifest(await fixtureManifest(), { sourceUrl: SOURCE_URL });

  assert.deepEqual(
    catalog.entries.map((entry) => entry.serviceCode),
    ["childCompute", "parentCompute", "retiredService", "staticStrings", "storageTco"],
  );
  assert.equal(catalog.activeEntries.length, 4);
  assert.equal(catalog.findByServiceCode("CHILDCOMPUTE").kind, CALCULATOR_ENTRY_KINDS.SUBSERVICE);
  assert.equal(
    catalog.findByCanonicalServiceId("aws-calculator:childCompute").serviceCode,
    "childCompute",
  );
  assert.equal(catalog.findByAlias("parent-compute").serviceCode, "parentCompute");
  assert.equal(catalog.findBySlug(" compute ").serviceCode, "parentCompute");
  assert.equal(catalog.findByName("PARENT COMPUTE").serviceCode, "parentCompute");
  assert.equal(catalog.findByServiceCode("storageTco").kind, CALCULATOR_ENTRY_KINDS.TCO);
  assert.equal(catalog.findByServiceCode("staticStrings").kind, CALCULATOR_ENTRY_KINDS.STATIC);
  assert.equal(catalog.findByServiceCode("retiredService").kind, CALCULATOR_ENTRY_KINDS.TOP_LEVEL);
  assert.deepEqual(catalog.findByServiceCode("childCompute").parentServiceCodes, ["parentCompute"]);
  assert.deepEqual(catalog.findByServiceCode("parentCompute").templateServiceCodes, [
    "childCompute",
    "missingChild",
  ]);
  assert.deepEqual(catalog.findByServiceCode("parentCompute").unresolvedTemplateServiceCodes, [
    "missingChild",
  ]);
  assert.equal(
    catalog.findByServiceCode("childCompute").definitionUrl,
    "https://fixtures.example/data/childCompute/en_US.json",
  );
  assert.deepEqual(
    catalog.search("compute").map((entry) => entry.serviceCode),
    ["parentCompute", "childCompute"],
  );
});

test("case-distinct service codes retain exact identities and reject ambiguous folded lookup", async () => {
  const manifest = await fixtureManifest();
  manifest.awsServices.push({
    name: "Child Compute Alternate",
    serviceCode: "ChildCompute",
    type: "AWSService",
    subType: "subService",
    isActive: "true",
    templates: [],
  });
  const catalog = normalizeCalculatorManifest(manifest);

  assert.equal(catalog.findByServiceCode("childCompute").name, "Child Compute");
  assert.equal(catalog.findByServiceCode("ChildCompute").name, "Child Compute Alternate");
  assert.equal(catalog.findByServiceCode("CHILDCOMPUTE"), null);
});

test("alias collisions are explicit and never resolve arbitrarily", async () => {
  const manifest = await fixtureManifest();
  manifest.awsServices.push({
    name: "Compute",
    serviceCode: "secondCompute",
    slug: "Compute",
    type: "AWSService",
    isActive: "true",
    templates: [],
  });
  const catalog = normalizeCalculatorManifest(manifest);

  assert.equal(catalog.findByAlias("compute"), null);
  assert.deepEqual(
    catalog.findAllByAlias("compute").map((entry) => entry.serviceCode),
    ["parentCompute", "secondCompute"],
  );
  assert.ok(catalog.findByServiceCode("parentCompute").ambiguousAliases.includes("Compute"));
  assert.equal(
    catalog.findByCanonicalServiceId("aws-calculator:secondCompute").serviceCode,
    "secondCompute",
  );
});

test("digest is stable across object key ordering", async () => {
  assert.equal(
    await digestCalculatorManifest({ b: 2, a: { d: 4, c: 3 } }),
    await digestCalculatorManifest({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("loads from the network, caches validators, and serves a fresh cache deterministically", async () => {
  const manifest = await fixtureManifest();
  const cache = new MemoryCalculatorCatalogCache();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return responseFor(manifest, {
      headers: { etag: '"fixture-v1"', "last-modified": "Wed, 01 Jul 2026 00:00:00 GMT" },
    });
  };

  const first = await loadCalculatorCatalog({
    fetchImpl,
    manifestUrl: SOURCE_URL,
    cache,
    now: () => Date.parse("2026-07-10T00:00:00Z"),
  });
  const second = await loadCalculatorCatalog({
    fetchImpl,
    manifestUrl: SOURCE_URL,
    cache,
    now: () => Date.parse("2026-07-10T00:30:00Z"),
  });

  assert.equal(requests.length, 1);
  assert.equal(first.metadata.cacheState, "network");
  assert.equal(second.metadata.cacheState, "fresh-cache");
  assert.equal(first.metadata.digest.length, 64);
  assert.equal(first.metadata.version, first.metadata.digest);
  assert.equal(second.metadata.digest, first.metadata.digest);
  assert.equal(second.metadata.stale, false);
});

test("revalidates stale cache with conditional headers", async () => {
  const manifest = await fixtureManifest();
  const cache = new MemoryCalculatorCatalogCache();
  await loadCalculatorCatalog({
    fetchImpl: async () => responseFor(manifest, { headers: { etag: '"fixture-v1"' } }),
    manifestUrl: SOURCE_URL,
    cache,
    now: () => Date.parse("2026-07-10T00:00:00Z"),
  });

  let request;
  const catalog = await loadCalculatorCatalog({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return responseFor(null, { status: 304 });
    },
    manifestUrl: SOURCE_URL,
    cache,
    maxAgeMs: 0,
    now: () => Date.parse("2026-07-10T02:00:00Z"),
  });

  assert.equal(request.init.headers["if-none-match"], '"fixture-v1"');
  assert.equal(catalog.metadata.cacheState, "revalidated");
  assert.equal(catalog.metadata.fetchedAt, "2026-07-10T02:00:00.000Z");
});

test("offline and failed-refresh behavior is explicit", async () => {
  const manifest = await fixtureManifest();
  const cache = new MemoryCalculatorCatalogCache();
  await loadCalculatorCatalog({
    fetchImpl: async () => responseFor(manifest),
    manifestUrl: SOURCE_URL,
    cache,
    now: () => Date.parse("2026-07-10T00:00:00Z"),
  });

  const offline = await loadCalculatorCatalog({ manifestUrl: SOURCE_URL, cache, offline: true });
  assert.equal(offline.metadata.cacheState, "offline");
  assert.equal(offline.metadata.offline, true);
  assert.equal(offline.metadata.stale, true);

  const fallback = await loadCalculatorCatalog({
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
    manifestUrl: SOURCE_URL,
    cache,
    forceRefresh: true,
  });
  assert.equal(fallback.metadata.cacheState, "stale-fallback");
  assert.match(fallback.metadata.warning, /network unavailable/);

  await assert.rejects(
    loadCalculatorCatalog({
      manifestUrl: "https://empty.example/manifest.json",
      cache: new MemoryCalculatorCatalogCache(),
      offline: true,
    }),
    (error) => error instanceof CalculatorCatalogError && error.code === "offline_cache_miss",
  );
});

test("rejects corrupt cache records instead of trusting their digest", async () => {
  const manifest = await fixtureManifest();
  const cache = new MemoryCalculatorCatalogCache();
  await cache.set(`aws-calculator-manifest:${SOURCE_URL}`, {
    schemaVersion: 1,
    fetchedAt: "2026-07-10T00:00:00.000Z",
    digest: "not-the-real-digest",
    manifest,
  });

  await assert.rejects(
    loadCalculatorCatalog({ manifestUrl: SOURCE_URL, cache, offline: true }),
    (error) => error.code === "offline_cache_miss",
  );
});

test("coverage audit includes every active definition and separates entry kinds", async () => {
  const catalog = normalizeCalculatorManifest(await fixtureManifest());
  const audit = auditCalculatorCoverage(catalog, [
    "childCompute",
    "storageTco",
    "retiredService",
    "notInManifest",
  ]);

  assert.deepEqual(audit.active, { total: 4, covered: 2, missing: 2, coveragePercent: 50 });
  assert.deepEqual(audit.byKind.subservice, {
    total: 1,
    covered: 1,
    missing: 0,
    coveragePercent: 100,
  });
  assert.deepEqual(audit.missingServiceCodes, ["parentCompute", "staticStrings"]);
  assert.deepEqual(audit.unknownSupportedCodes, ["notInManifest"]);
  assert.deepEqual(audit.inactiveSupportedCodes, ["retiredService"]);
});

test(
  "live manifest remains normalizable",
  { skip: process.env.AWS_CALCULATOR_LIVE !== "1" },
  async () => {
    const catalog = await loadCalculatorCatalog({ forceRefresh: true });
    assert.ok(catalog.activeEntries.length > 300);
    assert.ok(catalog.findByServiceCode("amazonBedrock"));
    assert.ok(catalog.metadata.digest);
  },
);
