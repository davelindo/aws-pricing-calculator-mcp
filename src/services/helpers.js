export const TARGET_REGIONS = [
  "us-east-1",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "ap-southeast-2",
  "ap-northeast-2",
];

export const SUPPORT_STATES = {
  EXACT: "exact",
  MODELED: "modeled",
  UNAVAILABLE: "unavailable",
};

export const MODELED_REGION_PRICE_MULTIPLIERS = {
  "us-east-1": 1,
  "ca-central-1": 1.09,
  "sa-east-1": 1.32,
  "eu-west-1": 1.11,
  "ap-southeast-2": 1.18,
  "ap-northeast-2": 1.16,
};

function deepScaleNumericValues(value, multiplier) {
  if (typeof value === "number") {
    return Math.round((value * multiplier + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepScaleNumericValues(entry, multiplier));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepScaleNumericValues(entry, multiplier)]),
    );
  }

  return value;
}

function capabilityEntry(region, support, reason) {
  return {
    region,
    support,
    calculatorSaveSupported: support === SUPPORT_STATES.EXACT,
    validationSupported: support !== SUPPORT_STATES.UNAVAILABLE,
    reason,
  };
}

export function buildCapabilityMatrix({
  exact = [],
  modeled = [],
  unavailable = [],
  exactReason = "Service is calculator-save capable and parity-verified in this region.",
  modeledReason = "Service is priced for planning in this region, but calculator save/parity is not complete yet.",
  unavailableReason = "Service is not implemented for this region yet.",
} = {}) {
  const exactSet = new Set(exact);
  const modeledSet = new Set(modeled);
  const unavailableSet = new Set(unavailable);

  return TARGET_REGIONS.map((region) => {
    if (exactSet.has(region)) {
      return capabilityEntry(region, SUPPORT_STATES.EXACT, exactReason);
    }

    if (modeledSet.has(region)) {
      return capabilityEntry(region, SUPPORT_STATES.MODELED, modeledReason);
    }

    if (unavailableSet.has(region)) {
      return capabilityEntry(region, SUPPORT_STATES.UNAVAILABLE, unavailableReason);
    }

    return capabilityEntry(region, SUPPORT_STATES.UNAVAILABLE, unavailableReason);
  });
}

export function capabilityForRegion(capabilityMatrix, region) {
  return (
    capabilityMatrix.find((entry) => entry.region === region) ?? {
      region,
      support: SUPPORT_STATES.UNAVAILABLE,
      calculatorSaveSupported: false,
      validationSupported: false,
      reason: "Region is outside the current roadmap matrix.",
    }
  );
}

export function buildModeledBudgetPricer({ unitRate, detail }) {
  return ({ definition, region, monthlyBudgetUsd, capability }) => {
    const multiplier = MODELED_REGION_PRICE_MULTIPLIERS[region] ?? 1;
    const adjustedBudget = Math.round((Number(monthlyBudgetUsd) * multiplier + Number.EPSILON) * 100) / 100;
    const pricedUnitRate = unitRate * multiplier;
    const units = pricedUnitRate > 0 ? adjustedBudget / pricedUnitRate : adjustedBudget;

    return {
      serviceId: definition.id,
      kind: definition.id,
      label: definition.name,
      category: definition.category,
      supportive: ["networking", "edge", "operations", "security"].includes(definition.category),
      region,
      environment: "shared",
      monthlyUsd: adjustedBudget,
      implementationStatus: definition.implementationStatus,
      capability,
      details: detail(units),
    };
  };
}

export function regionPriceMultiplier(region) {
  return MODELED_REGION_PRICE_MULTIPLIERS[region] ?? 1;
}

export function scaledRegionalPricing(pricingByRegion, region, errorContext = "Exact pricing") {
  const exactPricing = pricingByRegion[region];

  if (exactPricing) {
    return exactPricing;
  }

  const basePricing = pricingByRegion["us-east-1"];

  if (!basePricing) {
    throw new Error(`${errorContext} is not implemented for region '${region}'.`);
  }

  const multiplier = regionPriceMultiplier(region);

  if (!multiplier) {
    throw new Error(`${errorContext} is not implemented for region '${region}'.`);
  }

  return deepScaleNumericValues(basePricing, multiplier);
}

export function buildRoadmapExactCapability({
  unavailable = [],
  exactReason = "Service is calculator-save capable and parity-verified across the roadmap regions.",
  unavailableReason = "Service is not implemented for this region yet.",
} = {}) {
  const unavailableSet = new Set(unavailable);

  return buildCapabilityMatrix({
    exact: TARGET_REGIONS.filter((region) => !unavailableSet.has(region)),
    unavailable: [...unavailableSet],
    exactReason,
    unavailableReason,
  });
}
