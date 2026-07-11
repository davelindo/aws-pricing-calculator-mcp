import {
  CALCULATOR_ENTRY_KINDS,
  auditCalculatorCoverage,
  loadCalculatorCatalog,
} from "../calculator-catalog/index.js";
import { listServiceDefinitions } from "../services/index.js";
import { registerDynamicUniversalServices } from "./service-registry.js";

let defaultCatalogPromise = null;

function staticCalculatorCodes() {
  return new Set(
    listServiceDefinitions()
      .filter((service) => service.implementationStatus !== "dynamic")
      .flatMap((service) => service.calculatorServiceCodes),
  );
}

function unambiguousAliases(entry) {
  return entry.aliases.filter(
    (alias) => !entry.ambiguousAliases.includes(alias),
  );
}

function dynamicDescriptor(entry) {
  const aliases = unambiguousAliases(entry);

  return {
    canonicalServiceId: entry.canonicalServiceId,
    name: entry.name,
    serviceCode: entry.serviceCode,
    aliases,
    keywords: entry.searchKeywords,
    category: `aws-calculator-${entry.kind}`,
    implementationStatus: "dynamic",
    universalPricingMode: "dynamic",
    regions: entry.regions,
    capabilities: [],
    hints: {
      aliases,
      capabilities: [],
      cloudFormation: [],
      terraform: [],
    },
    metadata: {
      calculatorKind: entry.kind,
      definitionUrl: entry.definitionUrl,
      parentServiceCodes: entry.parentServiceCodes,
      templateServiceCodes: entry.templateServiceCodes,
    },
  };
}

export async function loadAndRegisterDynamicCalculatorCatalog(options = {}) {
  const catalog = await loadCalculatorCatalog(options);
  const staticCodes = staticCalculatorCodes();
  const registrableEntries = catalog.activeEntries.filter(
    (entry) =>
      entry.kind !== CALCULATOR_ENTRY_KINDS.STATIC &&
      !staticCodes.has(entry.serviceCode),
  );
  const registeredCount = registerDynamicUniversalServices(
    registrableEntries.map(dynamicDescriptor),
  );
  const discoveredCodes = new Set([
    ...staticCodes,
    ...registrableEntries.map((entry) => entry.serviceCode),
    ...catalog.activeEntries
      .filter((entry) => entry.kind === CALCULATOR_ENTRY_KINDS.STATIC)
      .map((entry) => entry.serviceCode),
  ]);

  return {
    catalog,
    registeredCount,
    manifestCoverage: auditCalculatorCoverage(catalog, discoveredCodes),
  };
}

export function ensureDynamicCalculatorCatalog(options = {}) {
  if (Object.keys(options).length > 0) {
    return loadAndRegisterDynamicCalculatorCatalog(options);
  }

  defaultCatalogPromise ??= loadAndRegisterDynamicCalculatorCatalog().catch((error) => {
    defaultCatalogPromise = null;
    throw error;
  });
  return defaultCatalogPromise;
}

export function clearDynamicCalculatorCatalog() {
  defaultCatalogPromise = null;
  registerDynamicUniversalServices([]);
}
