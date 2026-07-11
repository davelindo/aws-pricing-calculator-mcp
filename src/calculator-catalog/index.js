export const DEFAULT_CALCULATOR_CATALOG_BASE_URL =
  "https://d1qsjq9pzbk1k6.cloudfront.net/";
const DEFAULT_LOCALE = "en_US";
export const CALCULATOR_CATALOG_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export const CALCULATOR_ENTRY_KINDS = Object.freeze({
  TOP_LEVEL: "top-level",
  SUBSERVICE: "subservice",
  TCO: "tco",
  STATIC: "static",
});

export class CalculatorCatalogError extends Error {
  constructor(message, { code = "catalog_error", cause } = {}) {
    super(message, { cause });
    this.name = "CalculatorCatalogError";
    this.code = code;
  }
}

export class MemoryCalculatorCatalogCache {
  #records = new Map();

  async get(key) {
    return this.#records.get(key) ?? null;
  }

  async set(key, value) {
    this.#records.set(key, value);
  }

  async delete(key) {
    this.#records.delete(key);
  }

  clear() {
    this.#records.clear();
  }
}

export const defaultCalculatorCatalogCache = new MemoryCalculatorCatalogCache();

function normalizedText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function uniqueSortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string"))]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function uniqueNormalizedStrings(values) {
  const unique = new Map();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const cleaned = value.trim();
    const key = normalizedText(cleaned);
    if (!unique.has(key)) unique.set(key, cleaned);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, "en-US"));
}

function kebabAlias(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLocaleLowerCase("en-US");
}

function aliasesFor(record) {
  const shortenedName = record.name.replace(/^(?:amazon web services|amazon|aws)\s+/i, "");
  return uniqueNormalizedStrings([
    record.canonicalServiceId,
    record.serviceCode,
    record.name,
    record.slug,
    kebabAlias(record.serviceCode),
    kebabAlias(record.name),
    kebabAlias(record.slug),
    shortenedName,
    kebabAlias(shortenedName),
  ]);
}

function manifestBoolean(value) {
  return value === true || value === "true";
}

function classifyEntry(record) {
  if (record.type === "static") {
    return CALCULATOR_ENTRY_KINDS.STATIC;
  }

  if (record.subType === "TCOCalculator") {
    return CALCULATOR_ENTRY_KINDS.TCO;
  }

  if (record.subType === "subService") {
    return CALCULATOR_ENTRY_KINDS.SUBSERVICE;
  }

  return CALCULATOR_ENTRY_KINDS.TOP_LEVEL;
}

function resolveUrl(value, sourceUrl) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value, sourceUrl ?? DEFAULT_CALCULATOR_CATALOG_BASE_URL).toString();
  } catch {
    return null;
  }
}

function freezeEntry(entry) {
  Object.freeze(entry.searchKeywords);
  Object.freeze(entry.regions);
  Object.freeze(entry.templateServiceCodes);
  Object.freeze(entry.parentServiceCodes);
  Object.freeze(entry.unresolvedTemplateServiceCodes);
  Object.freeze(entry.aliases);
  Object.freeze(entry.ambiguousAliases);
  Object.freeze(entry.flags);
  return Object.freeze(entry);
}

function entryComparator(left, right) {
  return (
    left.serviceCode.localeCompare(right.serviceCode, "en-US") ||
    left.name.localeCompare(right.name, "en-US")
  );
}

function indexEntries(entries, selector) {
  const index = new Map();

  for (const entry of entries) {
    const key = normalizedText(selector(entry));
    if (!key) {
      continue;
    }

    const matches = index.get(key) ?? [];
    matches.push(entry);
    index.set(key, matches);
  }

  for (const matches of index.values()) {
    Object.freeze(matches);
  }

  return index;
}

function firstMatch(index, value) {
  return index.get(normalizedText(value))?.[0] ?? null;
}

function allMatches(index, value) {
  return index.get(normalizedText(value)) ?? Object.freeze([]);
}

function exactOrUniqueMatch(exactIndex, foldedIndex, value) {
  if (typeof value !== "string") return null;
  const exact = exactIndex.get(value.trim());
  if (exact) return exact;
  const folded = allMatches(foldedIndex, value);
  return folded.length === 1 ? folded[0] : null;
}

function normalizeManifestRecords(manifest, sourceUrl) {
  if (!manifest || !Array.isArray(manifest.awsServices)) {
    throw new CalculatorCatalogError(
      "AWS Pricing Calculator manifest must contain an awsServices array.",
      { code: "invalid_manifest" },
    );
  }

  const records = manifest.awsServices.map((record, index) => {
    const serviceCode = typeof record?.serviceCode === "string" ? record.serviceCode.trim() : "";
    const name = typeof record?.name === "string" ? record.name.trim() : "";

    if (!serviceCode || !name) {
      throw new CalculatorCatalogError(
        `AWS Pricing Calculator manifest entry ${index} must have a name and serviceCode.`,
        { code: "invalid_manifest_entry" },
      );
    }

    return {
      serviceCode,
      canonicalServiceId: `aws-calculator:${serviceCode}`,
      name,
      slug: typeof record.slug === "string" && record.slug.trim() ? record.slug.trim() : null,
      description:
        typeof record.description === "string" && record.description.trim()
          ? record.description.trim()
          : null,
      type: typeof record.type === "string" ? record.type : null,
      subtype: typeof record.subType === "string" ? record.subType : null,
      kind: classifyEntry(record),
      active: manifestBoolean(record.isActive),
      searchKeywords: uniqueSortedStrings(record.searchKeywords),
      regions: uniqueSortedStrings(record.regions),
      linkUrl: resolveUrl(record.linkUrl, sourceUrl),
      definitionUrl:
        resolveUrl(record.serviceDefinitionLocation, sourceUrl) ??
        resolveUrl(record.serviceDefinitionUrlPath, sourceUrl),
      definitionUrlPath:
        typeof record.serviceDefinitionUrlPath === "string"
          ? record.serviceDefinitionUrlPath
          : null,
      templateServiceCodes: uniqueSortedStrings(record.templates),
      parentServiceCodes: [],
      unresolvedTemplateServiceCodes: [],
      aliases: [],
      ambiguousAliases: [],
      flags: {
        disableConfigure: manifestBoolean(record.disableConfigure),
        disableRegionSupport: manifestBoolean(record.disableRegionSupport),
        hasDataTransfer: manifestBoolean(record.hasDataTransfer),
        bulkImportEnabled: Array.isArray(record.bulkImportEnabled)
          ? record.bulkImportEnabled.length > 0
          : manifestBoolean(record.bulkImportEnabled),
        c2e: manifestBoolean(record.c2e),
        mvpSupport: manifestBoolean(record.MVPSupport),
      },
    };
  });

  const codes = new Map();
  const foldedCodes = new Map();
  for (const record of records) {
    if (codes.has(record.serviceCode)) {
      throw new CalculatorCatalogError(
        `AWS Pricing Calculator manifest contains duplicate serviceCode ${record.serviceCode}.`,
        { code: "duplicate_service_code" },
      );
    }
    codes.set(record.serviceCode, record);
    const foldedKey = normalizedText(record.serviceCode);
    const folded = foldedCodes.get(foldedKey) ?? [];
    folded.push(record);
    foldedCodes.set(foldedKey, folded);
  }

  for (const parent of records) {
    for (const templateServiceCode of parent.templateServiceCodes) {
      const exactChild = codes.get(templateServiceCode);
      const foldedChildren = foldedCodes.get(normalizedText(templateServiceCode)) ?? [];
      const child = exactChild ?? (foldedChildren.length === 1 ? foldedChildren[0] : null);
      if (child) {
        child.parentServiceCodes.push(parent.serviceCode);
      } else {
        parent.unresolvedTemplateServiceCodes.push(templateServiceCode);
      }
    }
  }

  const aliasOwners = new Map();
  for (const record of records) {
    record.aliases = aliasesFor(record);
    for (const alias of record.aliases) {
      const key = normalizedText(alias);
      const owners = aliasOwners.get(key) ?? [];
      owners.push(record.serviceCode);
      aliasOwners.set(key, owners);
    }
  }

  return records
    .map((record) => {
      record.parentServiceCodes = uniqueSortedStrings(record.parentServiceCodes);
      record.unresolvedTemplateServiceCodes = uniqueSortedStrings(
        record.unresolvedTemplateServiceCodes,
      );
      record.ambiguousAliases = record.aliases.filter(
        (alias) => (aliasOwners.get(normalizedText(alias))?.length ?? 0) > 1,
      );
      return freezeEntry(record);
    })
    .sort(entryComparator);
}

function createCatalog(entries, metadata) {
  const frozenEntries = Object.freeze(entries);
  const activeEntries = Object.freeze(entries.filter((entry) => entry.active));
  const exactServiceCodes = new Map(entries.map((entry) => [entry.serviceCode, entry]));
  const exactCanonicalServiceIds = new Map(
    entries.map((entry) => [entry.canonicalServiceId, entry]),
  );
  const byServiceCode = indexEntries(entries, (entry) => entry.serviceCode);
  const byCanonicalServiceId = indexEntries(entries, (entry) => entry.canonicalServiceId);
  const bySlug = indexEntries(entries, (entry) => entry.slug);
  const byName = indexEntries(entries, (entry) => entry.name);
  const byAlias = new Map();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const key = normalizedText(alias);
      const matches = byAlias.get(key) ?? [];
      if (!matches.includes(entry)) matches.push(entry);
      byAlias.set(key, matches);
    }
  }
  for (const matches of byAlias.values()) Object.freeze(matches);
  const frozenMetadata = Object.freeze({ ...metadata });

  return Object.freeze({
    entries: frozenEntries,
    activeEntries,
    metadata: frozenMetadata,
    findByServiceCode(serviceCode) {
      return exactOrUniqueMatch(exactServiceCodes, byServiceCode, serviceCode);
    },
    findByCanonicalServiceId(canonicalServiceId) {
      return exactOrUniqueMatch(
        exactCanonicalServiceIds,
        byCanonicalServiceId,
        canonicalServiceId,
      );
    },
    findBySlug(slug) {
      return firstMatch(bySlug, slug);
    },
    findByName(name) {
      return firstMatch(byName, name);
    },
    findAllBySlug(slug) {
      return allMatches(bySlug, slug);
    },
    findAllByName(name) {
      return allMatches(byName, name);
    },
    findByAlias(alias) {
      const matches = allMatches(byAlias, alias);
      return matches.length === 1 ? matches[0] : null;
    },
    findAllByAlias(alias) {
      return allMatches(byAlias, alias);
    },
    search(query, { activeOnly = true, limit = 20 } = {}) {
      const needle = normalizedText(query);
      if (!needle || !Number.isInteger(limit) || limit < 1) {
        return Object.freeze([]);
      }

      const candidates = activeOnly ? activeEntries : entries;
      const matches = candidates
        .map((entry) => {
          const code = normalizedText(entry.serviceCode);
          const slug = normalizedText(entry.slug);
          const name = normalizedText(entry.name);
          const keywords = entry.searchKeywords.map(normalizedText);
          const aliases = entry.aliases.map(normalizedText);
          let rank = Number.POSITIVE_INFINITY;

          if (code === needle) rank = 0;
          else if (slug === needle) rank = 1;
          else if (name === needle) rank = 2;
          else if (code.startsWith(needle) || slug.startsWith(needle)) rank = 3;
          else if (name.startsWith(needle)) rank = 4;
          else if (keywords.some((keyword) => keyword === needle)) rank = 5;
          else if (aliases.some((alias) => alias === needle)) rank = 6;
          else if ([code, slug, name, ...keywords, ...aliases].some((text) => text.includes(needle)))
            rank = 7;

          return { entry, rank };
        })
        .filter(({ rank }) => Number.isFinite(rank))
        .sort((left, right) => left.rank - right.rank || entryComparator(left.entry, right.entry))
        .slice(0, limit)
        .map(({ entry }) => entry);

      return Object.freeze(matches);
    },
  });
}

export function normalizeCalculatorManifest(manifest, metadata = {}) {
  const sourceUrl = metadata.sourceUrl ?? null;
  const entries = normalizeManifestRecords(manifest, sourceUrl);

  return createCatalog(entries, {
    schemaVersion: CALCULATOR_CATALOG_CACHE_SCHEMA_VERSION,
    sourceUrl,
    fetchedAt: metadata.fetchedAt ?? null,
    digest: metadata.digest ?? null,
    version: metadata.version ?? metadata.digest ?? null,
    cacheState: metadata.cacheState ?? "normalized",
    stale: Boolean(metadata.stale),
    offline: Boolean(metadata.offline),
    warning: metadata.warning ?? null,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export async function digestCalculatorManifest(manifest) {
  if (!globalThis.crypto?.subtle) {
    throw new CalculatorCatalogError("Web Crypto is required to digest the calculator manifest.", {
      code: "digest_unavailable",
    });
  }

  const bytes = new TextEncoder().encode(stableJson(manifest));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function manifestUrlFor({ baseUrl, locale, manifestUrl }) {
  if (manifestUrl) {
    return new URL(manifestUrl, baseUrl).toString();
  }

  return new URL(`manifest/${locale}.json`, baseUrl).toString();
}

function timestamp(now) {
  const value = typeof now === "function" ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CalculatorCatalogError("Catalog clock returned an invalid date.", {
      code: "invalid_clock",
    });
  }
  return date;
}

async function readValidCache(cache, cacheKey) {
  if (!cache?.get) {
    return null;
  }

  const record = await cache.get(cacheKey);
  if (
    !record ||
    record.schemaVersion !== CALCULATOR_CATALOG_CACHE_SCHEMA_VERSION ||
    !record.manifest ||
    typeof record.digest !== "string" ||
    typeof record.fetchedAt !== "string"
  ) {
    return null;
  }

  const actualDigest = await digestCalculatorManifest(record.manifest);
  return actualDigest === record.digest ? record : null;
}

function catalogFromCache(record, sourceUrl, metadata) {
  return normalizeCalculatorManifest(record.manifest, {
    sourceUrl,
    fetchedAt: record.fetchedAt,
    digest: record.digest,
    ...metadata,
  });
}

export async function loadCalculatorCatalog({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_CALCULATOR_CATALOG_BASE_URL,
  locale = DEFAULT_LOCALE,
  manifestUrl,
  cache = defaultCalculatorCatalogCache,
  cacheKey,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  offline = false,
  staleIfError = true,
  forceRefresh = false,
  now = Date.now,
  signal,
} = {}) {
  const sourceUrl = manifestUrlFor({ baseUrl, locale, manifestUrl });
  const resolvedCacheKey = cacheKey ?? `aws-calculator-manifest:${sourceUrl}`;
  const currentTime = timestamp(now);
  const cached = await readValidCache(cache, resolvedCacheKey);

  if (offline) {
    if (!cached) {
      throw new CalculatorCatalogError(
        `No valid cached AWS Pricing Calculator manifest is available for offline use (${sourceUrl}).`,
        { code: "offline_cache_miss" },
      );
    }

    return catalogFromCache(cached, sourceUrl, {
      cacheState: "offline",
      stale: true,
      offline: true,
      warning: "Using a cached manifest because offline mode was requested.",
    });
  }

  const cachedAt = cached ? Date.parse(cached.fetchedAt) : Number.NaN;
  const cacheIsFresh =
    cached &&
    !forceRefresh &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    Number.isFinite(cachedAt) &&
    currentTime.getTime() - cachedAt <= maxAgeMs;

  if (cacheIsFresh) {
    return catalogFromCache(cached, sourceUrl, {
      cacheState: "fresh-cache",
      stale: false,
      offline: false,
    });
  }

  if (typeof fetchImpl !== "function") {
    throw new CalculatorCatalogError("A fetch implementation is required to load the catalog.", {
      code: "fetch_unavailable",
    });
  }

  const headers = { accept: "application/json" };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

  try {
    const response = await fetchImpl(sourceUrl, { headers, signal });

    if (response.status === 304 && cached) {
      const record = { ...cached, fetchedAt: currentTime.toISOString() };
      await cache?.set?.(resolvedCacheKey, record);
      return catalogFromCache(record, sourceUrl, {
        cacheState: "revalidated",
        stale: false,
        offline: false,
      });
    }

    if (!response.ok) {
      throw new CalculatorCatalogError(
        `AWS Pricing Calculator manifest request failed (${response.status} ${response.statusText}).`,
        { code: "manifest_fetch_failed" },
      );
    }

    const manifest = await response.json();
    normalizeManifestRecords(manifest, sourceUrl);
    const digest = await digestCalculatorManifest(manifest);
    const record = {
      schemaVersion: CALCULATOR_CATALOG_CACHE_SCHEMA_VERSION,
      sourceUrl,
      fetchedAt: currentTime.toISOString(),
      digest,
      version: digest,
      etag: response.headers?.get?.("etag") ?? null,
      lastModified: response.headers?.get?.("last-modified") ?? null,
      manifest,
    };
    await cache?.set?.(resolvedCacheKey, record);

    return catalogFromCache(record, sourceUrl, {
      cacheState: cached ? "refreshed" : "network",
      stale: false,
      offline: false,
    });
  } catch (error) {
    if (cached && staleIfError) {
      return catalogFromCache(cached, sourceUrl, {
        cacheState: "stale-fallback",
        stale: true,
        offline: false,
        warning: `Manifest refresh failed; using cached data: ${error.message}`,
      });
    }

    if (error instanceof CalculatorCatalogError) {
      throw error;
    }

    throw new CalculatorCatalogError(`Unable to load AWS Pricing Calculator manifest: ${error.message}`, {
      code: "manifest_fetch_failed",
      cause: error,
    });
  }
}

function coverageStats(entries, supported) {
  const coveredEntries = entries.filter((entry) => supported.has(entry.serviceCode));
  const missingEntries = entries.filter((entry) => !supported.has(entry.serviceCode));
  return Object.freeze({
    total: entries.length,
    covered: coveredEntries.length,
    missing: missingEntries.length,
    coveragePercent:
      entries.length === 0 ? 100 : Number(((coveredEntries.length / entries.length) * 100).toFixed(2)),
  });
}

export function auditCalculatorCoverage(catalog, supportedServiceCodes = []) {
  if (!catalog?.activeEntries || typeof catalog.findByServiceCode !== "function") {
    throw new CalculatorCatalogError("Coverage audit requires a normalized calculator catalog.", {
      code: "invalid_catalog",
    });
  }

  const suppliedCodes = uniqueSortedStrings([...supportedServiceCodes]);
  const supported = new Set(suppliedCodes);
  const activeEntries = catalog.activeEntries;
  const coveredEntries = activeEntries.filter((entry) => supported.has(entry.serviceCode));
  const missingEntries = activeEntries.filter((entry) => !supported.has(entry.serviceCode));
  const unknownSupportedCodes = suppliedCodes.filter(
    (serviceCode) => !catalog.entries.some((entry) => entry.serviceCode === serviceCode),
  );
  const inactiveSupportedCodes = suppliedCodes.filter((serviceCode) => {
    const entry = catalog.entries.find((candidate) => candidate.serviceCode === serviceCode);
    return entry && !entry.active;
  });
  const byKind = Object.fromEntries(
    Object.values(CALCULATOR_ENTRY_KINDS).map((kind) => [
      kind,
      coverageStats(
        activeEntries.filter((entry) => entry.kind === kind),
        supported,
      ),
    ]),
  );

  return Object.freeze({
    digest: catalog.metadata.digest,
    active: coverageStats(activeEntries, supported),
    byKind: Object.freeze(byKind),
    coveredServiceCodes: Object.freeze(coveredEntries.map((entry) => entry.serviceCode)),
    missingServiceCodes: Object.freeze(missingEntries.map((entry) => entry.serviceCode)),
    missingEntries: Object.freeze(missingEntries),
    unknownSupportedCodes: Object.freeze(unknownSupportedCodes),
    inactiveSupportedCodes: Object.freeze(inactiveSupportedCodes),
  });
}
