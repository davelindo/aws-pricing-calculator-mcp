import { createDefinitionCompiler } from "../calculator-definition/index.js";

const DEFAULT_PRICING_BASE_URL = "https://calculator.aws/";

export class DynamicCalculatorLoadError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DynamicCalculatorLoadError";
    this.code = code;
    this.details = details;
  }
}

async function fetchJson(fetchImpl, url, context) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new DynamicCalculatorLoadError(
      "calculator_asset_fetch_failed",
      `Unable to fetch ${context} (${response.status} ${response.statusText}).`,
      { url, status: response.status },
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new DynamicCalculatorLoadError(
      "calculator_asset_invalid_json",
      `AWS Calculator returned invalid JSON for ${context}.`,
      { url, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export function createAwsCalculatorDefinitionRuntime({
  catalog,
  fetchImpl = globalThis.fetch,
  currency = "USD",
  pricingBaseUrl = DEFAULT_PRICING_BASE_URL,
} = {}) {
  if (!catalog?.findByServiceCode || typeof fetchImpl !== "function") {
    throw new TypeError("A calculator catalog and fetch implementation are required.");
  }

  const definitionCache = new Map();
  const pricingCache = new Map();

  async function loadDefinition(serviceCode) {
    const entry = catalog.findByServiceCode(serviceCode);

    if (!entry?.definitionUrl) {
      throw new DynamicCalculatorLoadError(
        "calculator_definition_missing",
        `No calculator definition URL is published for '${serviceCode}'.`,
        { serviceCode },
      );
    }

    if (!definitionCache.has(entry.definitionUrl)) {
      definitionCache.set(
        entry.definitionUrl,
        fetchJson(fetchImpl, entry.definitionUrl, `definition '${serviceCode}'`).catch(
          (error) => {
            definitionCache.delete(entry.definitionUrl);
            throw error;
          },
        ),
      );
    }

    return {
      definition: await definitionCache.get(entry.definitionUrl),
      source: entry.definitionUrl,
    };
  }

  async function loadPricing({ serviceCode, mapping, url }) {
    let resolvedUrl;

    try {
      resolvedUrl = new URL(url, pricingBaseUrl).toString();
    } catch {
      throw new DynamicCalculatorLoadError(
        "calculator_pricing_url_invalid",
        `Pricing URL '${url}' for '${serviceCode}' is invalid.`,
        { serviceCode, mapping: mapping?.name, url },
      );
    }

    if (!pricingCache.has(resolvedUrl)) {
      pricingCache.set(
        resolvedUrl,
        fetchJson(
          fetchImpl,
          resolvedUrl,
          `pricing map '${mapping?.name ?? "unknown"}' for '${serviceCode}'`,
        ).catch((error) => {
          pricingCache.delete(resolvedUrl);
          throw error;
        }),
      );
    }

    return pricingCache.get(resolvedUrl);
  }

  const compiler = createDefinitionCompiler({ loadDefinition, loadPricing, currency });

  return {
    compiler,
    loadDefinition,
    loadPricing,
    definitionCache,
    pricingCache,
  };
}

