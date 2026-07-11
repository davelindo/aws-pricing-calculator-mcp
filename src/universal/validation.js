import {
  resolveServiceDefinitionForSavedService,
} from "../services/index.js";
import {
  roundCurrency,
  serviceEntries,
  serviceMonthlyUsd,
} from "../model.js";

const PARITY_TOLERANCE_USD = 0.02;
const TARGET_TOLERANCE_RATIO = 0.1;

function check(id, title, passed, details, evidence = null) {
  return {
    id,
    title,
    status: passed ? "pass" : "fail",
    blocking: !passed,
    details,
    evidence,
  };
}

function parityForService(service) {
  const definition = resolveServiceDefinitionForSavedService(service);
  const storedMonthlyUsd = serviceMonthlyUsd(service);

  if (!definition?.modelSavedMonthlyUsd) {
    return {
      serviceId: definition?.id ?? null,
      serviceCode: service?.serviceCode ?? null,
      storedMonthlyUsd,
      modeledMonthlyUsd: null,
      deltaUsd: null,
      supported: false,
      error: "No universal saved-service pricing model is registered.",
    };
  }

  try {
    const modeledMonthlyUsd = roundCurrency(definition.modelSavedMonthlyUsd(service));
    const deltaUsd = roundCurrency(storedMonthlyUsd - modeledMonthlyUsd);

    return {
      serviceId: definition.id,
      serviceCode: service?.serviceCode ?? null,
      storedMonthlyUsd,
      modeledMonthlyUsd,
      deltaUsd,
      supported: Math.abs(deltaUsd) <= PARITY_TOLERANCE_USD,
      error: null,
    };
  } catch (error) {
    return {
      serviceId: definition.id,
      serviceCode: service?.serviceCode ?? null,
      storedMonthlyUsd,
      modeledMonthlyUsd: null,
      deltaUsd: null,
      supported: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateUniversalEstimatePayload({
  estimate,
  expectedMonthlyUsd,
  expectedRegion,
  expectedRegionMode,
} = {}) {
  const services = serviceEntries(estimate?.services ?? {});
  const storedMonthlyUsd = roundCurrency(Number(estimate?.totalCost?.monthly ?? 0));
  const rowTotalMonthlyUsd = roundCurrency(
    services.reduce((sum, service) => sum + serviceMonthlyUsd(service), 0),
  );
  const regions = [...new Set(services.map((service) => service?.region).filter(Boolean))];
  const parityDetails = services.map(parityForService);
  const unsupported = parityDetails.filter((detail) => !detail.supported);
  const totalParity = Math.abs(storedMonthlyUsd - rowTotalMonthlyUsd) <= PARITY_TOLERANCE_USD;
  const targetToleranceUsd = Number.isFinite(expectedMonthlyUsd)
    ? Math.max(PARITY_TOLERANCE_USD, Number(expectedMonthlyUsd) * TARGET_TOLERANCE_RATIO)
    : null;
  const targetParity =
    targetToleranceUsd == null ||
    Math.abs(storedMonthlyUsd - Number(expectedMonthlyUsd)) <= targetToleranceUsd;
  const expectedRegionPresent = !expectedRegion || regions.includes(expectedRegion);
  const regionModeValid =
    !expectedRegionMode ||
    (expectedRegionMode === "single-region" ? regions.length <= 1 : regions.length > 1);
  const checks = [
    check(
      "pricing.services-present",
      "Services Present",
      services.length > 0,
      `Estimate contains ${services.length} service row(s).`,
      { serviceCount: services.length },
    ),
    check(
      "pricing.known-service-formulas",
      "Known Service Formulas",
      unsupported.length === 0,
      unsupported.length === 0
        ? "Every service row has a matching universal pricing model."
        : `Unmodeled or mismatched service rows: ${unsupported
            .map((detail) => detail.serviceCode ?? "unknown")
            .join(", ")}.`,
      { unsupportedServiceCodes: unsupported.map((detail) => detail.serviceCode) },
    ),
    check(
      "pricing.saved-modeled-parity",
      "Saved Service Parity",
      unsupported.length === 0,
      unsupported.length === 0
        ? "Saved service rows match their local pricing models."
        : "At least one saved service row does not match its local pricing model.",
      { parityDetails },
    ),
    check(
      "pricing.total-parity",
      "Estimate Total Parity",
      totalParity,
      `Stored total is ${storedMonthlyUsd.toFixed(2)} USD; service rows total ${rowTotalMonthlyUsd.toFixed(2)} USD.`,
      { storedMonthlyUsd, rowTotalMonthlyUsd },
    ),
    check(
      "pricing.target-fit",
      "Target Fit",
      targetParity,
      expectedMonthlyUsd == null
        ? "No target monthly total was supplied."
        : `Stored total is ${storedMonthlyUsd.toFixed(2)} USD against target ${Number(expectedMonthlyUsd).toFixed(2)} USD.`,
      { expectedMonthlyUsd: expectedMonthlyUsd ?? null, storedMonthlyUsd, targetToleranceUsd },
    ),
    check(
      "architecture.expected-region",
      "Expected Region",
      expectedRegionPresent,
      expectedRegion
        ? `Expected ${expectedRegion}; found ${regions.join(", ") || "no regions"}.`
        : `Found regions: ${regions.join(", ") || "none"}.`,
      { expectedRegion: expectedRegion ?? null, regions },
    ),
    check(
      "architecture.region-mode",
      "Region Mode",
      regionModeValid,
      `Expected ${expectedRegionMode ?? "any region mode"}; found ${regions.length} region(s).`,
      { expectedRegionMode: expectedRegionMode ?? null, regions },
    ),
  ];
  const hardFailures = checks.filter((item) => item.status === "fail");

  return {
    schemaVersion: "2.0",
    validationMode: "generic",
    contextSource: "universal",
    expectedMonthlyUsd: expectedMonthlyUsd ?? null,
    storedMonthlyUsd,
    rowTotalMonthlyUsd,
    expectedRegion: expectedRegion ?? null,
    expectedRegionMode: expectedRegionMode ?? null,
    regions,
    checks,
    hardFailures,
    warnings: [],
    parityDetails,
    passed: hardFailures.length === 0,
  };
}

