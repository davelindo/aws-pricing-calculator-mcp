import {
  auditCalculatorCoverage,
  loadCalculatorCatalog,
} from "../src/calculator-catalog/index.js";
import {
  WINDOWS_WORKLOADS_SERVICE_CODE,
  auditManifest,
  windowsWorkloadsAdapter,
} from "../src/calculator-definition/index.js";
import { findServiceDefinitionByCalculatorServiceCode } from "../src/services/index.js";

const catalog = await loadCalculatorCatalog({ forceRefresh: true });
const discovery = auditCalculatorCoverage(
  catalog,
  catalog.activeEntries.map((entry) => entry.serviceCode),
);
const definitionAudit = await auditManifest({
  manifest: {
    awsServices: catalog.entries.map((entry) => ({
      serviceCode: entry.serviceCode,
      isActive: entry.active,
    })),
  },
  async loadDefinition(entry) {
    const catalogEntry = catalog.findByServiceCode(entry.serviceCode);
    if (!catalogEntry?.definitionUrl) {
      throw new Error(`No definition URL is published for '${entry.serviceCode}'.`);
    }
    const response = await fetch(catalogEntry.definitionUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  },
});
const blockingStatuses = new Set(["fail-closed", "load-failed"]);
const blockingEntries = definitionAudit.entries.filter((entry) =>
  blockingStatuses.has(entry.status),
);
const adapterRequired = definitionAudit.entries.filter(
  (entry) => entry.status === "adapter-required",
);
const adapterCoverage = adapterRequired.map((entry) => {
  const builtIn = findServiceDefinitionByCalculatorServiceCode(entry.serviceCode);
  const windows =
    entry.serviceCode === WINDOWS_WORKLOADS_SERVICE_CODE &&
    Object.keys(windowsWorkloadsAdapter.components ?? {}).length > 0 &&
    Object.keys(windowsWorkloadsAdapter.maths ?? {}).length > 0;
  return {
    serviceCode: entry.serviceCode,
    covered: Boolean(builtIn || windows),
    implementation: builtIn?.id ?? (windows ? "windows-workloads-adapter" : null),
  };
});
const uncoveredAdapters = adapterCoverage.filter((entry) => !entry.covered);
const report = {
  manifest: {
    version: catalog.metadata.version,
    digest: catalog.metadata.digest,
    fetchedAt: catalog.metadata.fetchedAt,
  },
  discovery: discovery.active,
  definitions: definitionAudit.counts,
  adapterCoverage,
  uncoveredAdapters,
  blockingEntries,
};

console.log(JSON.stringify(report, null, 2));

if (
  discovery.active.missing > 0 ||
  definitionAudit.classifiedEntries !== definitionAudit.totalManifestEntries ||
  uncoveredAdapters.length > 0 ||
  blockingEntries.length > 0
) {
  process.exitCode = 1;
}
