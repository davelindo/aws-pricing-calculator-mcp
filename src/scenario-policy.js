const COMPUTE_COMMITMENT_DISCOUNT_PCT = {
  "on-demand": 0,
  "savings-plans": 18,
  reserved: 14,
  "reserved-heavy": 28,
};

const DATABASE_COMMITMENT_DISCOUNT_PCT = {
  "on-demand": 0,
  reserved: 14,
  "reserved-heavy": 22,
};

const ENVIRONMENT_SIZING_FACTORS = {
  "full-footprint": {
    dev: 1,
    staging: 1,
    prod: 1,
  },
  "right-sized-non-prod": {
    dev: 0.65,
    staging: 0.8,
    prod: 1,
  },
  "lean-non-prod": {
    dev: 0.45,
    staging: 0.65,
    prod: 1,
  },
};

const SHARED_SERVICES_SPEND_FACTORS = {
  standard: 1,
  trimmed: 0.88,
  lean: 0.76,
};

const DATA_TRANSFER_FACTORS = {
  baseline: 1,
  reviewed: 0.86,
  minimized: 0.72,
};

const STORAGE_STRATEGIES = {
  standard: {
    storageSizeFactor: 1,
    storageCostFactor: 1,
  },
  tuned: {
    storageSizeFactor: 0.88,
    storageCostFactor: 0.92,
  },
  lean: {
    storageSizeFactor: 0.75,
    storageCostFactor: 0.84,
  },
};

const HA_DEPLOYMENTS = {
  standard: {
    dev: "Single-AZ",
    staging: "Multi-AZ",
    prod: "Multi-AZ",
  },
  "targeted-ha": {
    dev: "Single-AZ",
    staging: "Single-AZ",
    prod: "Multi-AZ",
  },
  "selective-ha": {
    dev: "Single-AZ",
    staging: "Single-AZ",
    prod: "Single-AZ",
  },
};

function combineSummary(policy) {
  return [
    policy.computeCommitment,
    policy.databaseCommitment,
    policy.haPosture,
    policy.storageStrategy,
    policy.environmentSizing,
    policy.sharedServicesProfile,
    policy.dataTransferProfile,
  ].join(", ");
}

export const DEFAULT_SCENARIO_POLICIES = [
  {
    id: "baseline",
    title: "Baseline",
    computeCommitment: "on-demand",
    databaseCommitment: "on-demand",
    haPosture: "standard",
    storageStrategy: "standard",
    environmentSizing: "full-footprint",
    sharedServicesProfile: "standard",
    dataTransferProfile: "baseline",
    justificationProfile: "default-baseline",
    computeDiscountPct: 0,
    databaseDiscountPct: 0,
    environmentScaleFactors: ENVIRONMENT_SIZING_FACTORS["full-footprint"],
    storageMultiplier: 1,
    storageSizeFactor: 1,
    storageCostFactor: 1,
    prodMultiAz: true,
    nonProdMultiAz: true,
    sharedServicesMultiplier: 1,
    sharedServicesSpendFactor: 1,
    dataTransferMultiplier: 1,
    dataTransferFactor: 1,
    coreBudgetFactor: 1,
    addOnBudgetFactor: 1,
    exactLinkSupport: "exact",
    expectedSavingsPct: 0,
    strategySummary:
      "On-Demand baseline with standard HA, full non-prod footprint, and standard shared-service overhead.",
  },
  {
    id: "optimized",
    title: "Optimized",
    computeCommitment: "savings-plans",
    databaseCommitment: "reserved",
    haPosture: "targeted-ha",
    storageStrategy: "tuned",
    environmentSizing: "right-sized-non-prod",
    sharedServicesProfile: "trimmed",
    dataTransferProfile: "reviewed",
    justificationProfile: "cost-optimized",
    computeDiscountPct: COMPUTE_COMMITMENT_DISCOUNT_PCT["savings-plans"],
    databaseDiscountPct: DATABASE_COMMITMENT_DISCOUNT_PCT.reserved,
    environmentScaleFactors: ENVIRONMENT_SIZING_FACTORS["right-sized-non-prod"],
    storageMultiplier: STORAGE_STRATEGIES.tuned.storageSizeFactor,
    storageSizeFactor: STORAGE_STRATEGIES.tuned.storageSizeFactor,
    storageCostFactor: STORAGE_STRATEGIES.tuned.storageCostFactor,
    prodMultiAz: true,
    nonProdMultiAz: false,
    sharedServicesMultiplier: SHARED_SERVICES_SPEND_FACTORS.trimmed,
    sharedServicesSpendFactor: SHARED_SERVICES_SPEND_FACTORS.trimmed,
    dataTransferMultiplier: DATA_TRANSFER_FACTORS.reviewed,
    dataTransferFactor: DATA_TRANSFER_FACTORS.reviewed,
    coreBudgetFactor: 1,
    addOnBudgetFactor: SHARED_SERVICES_SPEND_FACTORS.trimmed,
    exactLinkSupport: "exact",
    expectedSavingsPct: 18,
    strategySummary:
      "Savings-plan and reserved-capacity optimization with tighter non-prod sizing and tuned storage/networking.",
  },
  {
    id: "aggressive",
    title: "Aggressive",
    computeCommitment: "reserved-heavy",
    databaseCommitment: "reserved-heavy",
    haPosture: "selective-ha",
    storageStrategy: "lean",
    environmentSizing: "lean-non-prod",
    sharedServicesProfile: "lean",
    dataTransferProfile: "minimized",
    justificationProfile: "high-optimization",
    computeDiscountPct: 28,
    databaseDiscountPct: DATABASE_COMMITMENT_DISCOUNT_PCT["reserved-heavy"],
    environmentScaleFactors: ENVIRONMENT_SIZING_FACTORS["lean-non-prod"],
    storageMultiplier: STORAGE_STRATEGIES.lean.storageSizeFactor,
    storageSizeFactor: STORAGE_STRATEGIES.lean.storageSizeFactor,
    storageCostFactor: STORAGE_STRATEGIES.lean.storageCostFactor,
    prodMultiAz: false,
    nonProdMultiAz: false,
    sharedServicesMultiplier: SHARED_SERVICES_SPEND_FACTORS.lean,
    sharedServicesSpendFactor: SHARED_SERVICES_SPEND_FACTORS.lean,
    dataTransferMultiplier: DATA_TRANSFER_FACTORS.minimized,
    dataTransferFactor: DATA_TRANSFER_FACTORS.minimized,
    coreBudgetFactor: 1,
    addOnBudgetFactor: SHARED_SERVICES_SPEND_FACTORS.lean,
    exactLinkSupport: "exact",
    expectedSavingsPct: 31,
    strategySummary:
      "Commitment-heavy posture with selective HA, lean non-prod sizing, and minimized shared-service overhead.",
  },
];

function mergePolicy(policy, fallback) {
  const environmentSizing = policy?.environmentSizing ?? fallback.environmentSizing;
  const storageStrategy = policy?.storageStrategy ?? fallback.storageStrategy;
  const sharedServicesProfile = policy?.sharedServicesProfile ?? fallback.sharedServicesProfile;
  const dataTransferProfile = policy?.dataTransferProfile ?? fallback.dataTransferProfile;
  const justificationProfile = policy?.justificationProfile ?? fallback.justificationProfile;
  const computeCommitment = policy?.computeCommitment ?? fallback.computeCommitment;
  const databaseCommitment = policy?.databaseCommitment ?? fallback.databaseCommitment;
  const exactLinkSupport =
    policy?.exactLinkSupport ??
    "exact";

  return {
    ...fallback,
    ...policy,
    id: policy?.id ?? fallback.id,
    title: policy?.title ?? fallback.title,
    computeCommitment,
    databaseCommitment,
    haPosture: policy?.haPosture ?? fallback.haPosture,
    storageStrategy,
    environmentSizing,
    sharedServicesProfile,
    dataTransferProfile,
    justificationProfile,
    computeDiscountPct:
      policy?.computeDiscountPct ??
      COMPUTE_COMMITMENT_DISCOUNT_PCT[computeCommitment] ??
      fallback.computeDiscountPct,
    databaseDiscountPct:
      policy?.databaseDiscountPct ??
      DATABASE_COMMITMENT_DISCOUNT_PCT[databaseCommitment] ??
      fallback.databaseDiscountPct,
    environmentScaleFactors:
      policy?.environmentScaleFactors ??
      policy?.environmentSizingFactors ??
      ENVIRONMENT_SIZING_FACTORS[environmentSizing] ??
      fallback.environmentScaleFactors,
    environmentSizingFactors:
      policy?.environmentSizingFactors ??
      policy?.environmentScaleFactors ??
      ENVIRONMENT_SIZING_FACTORS[environmentSizing] ??
      fallback.environmentScaleFactors,
    storageMultiplier:
      policy?.storageMultiplier ??
      policy?.storageSizeFactor ??
      STORAGE_STRATEGIES[storageStrategy]?.storageSizeFactor ??
      fallback.storageMultiplier,
    storageSizeFactor:
      policy?.storageSizeFactor ??
      policy?.storageMultiplier ??
      STORAGE_STRATEGIES[storageStrategy]?.storageSizeFactor ??
      fallback.storageSizeFactor,
    storageCostFactor:
      policy?.storageCostFactor ??
      STORAGE_STRATEGIES[storageStrategy]?.storageCostFactor ??
      fallback.storageCostFactor,
    prodMultiAz: policy?.prodMultiAz ?? (policy?.haPosture === "selective-ha" ? false : true),
    nonProdMultiAz: policy?.nonProdMultiAz ?? (policy?.haPosture === "standard"),
    sharedServicesMultiplier:
      policy?.sharedServicesMultiplier ??
      policy?.sharedServicesSpendFactor ??
      SHARED_SERVICES_SPEND_FACTORS[sharedServicesProfile] ??
      fallback.sharedServicesMultiplier,
    sharedServicesSpendFactor:
      policy?.sharedServicesSpendFactor ??
      policy?.sharedServicesMultiplier ??
      SHARED_SERVICES_SPEND_FACTORS[sharedServicesProfile] ??
      fallback.sharedServicesSpendFactor,
    dataTransferMultiplier:
      policy?.dataTransferMultiplier ??
      policy?.dataTransferFactor ??
      DATA_TRANSFER_FACTORS[dataTransferProfile] ??
      fallback.dataTransferMultiplier,
    dataTransferFactor:
      policy?.dataTransferFactor ??
      policy?.dataTransferMultiplier ??
      DATA_TRANSFER_FACTORS[dataTransferProfile] ??
      fallback.dataTransferFactor,
    exactLinkSupport,
    coreBudgetFactor: policy?.coreBudgetFactor ?? fallback.coreBudgetFactor,
    addOnBudgetFactor:
      policy?.addOnBudgetFactor ??
      policy?.sharedServicesMultiplier ??
      policy?.sharedServicesSpendFactor ??
      fallback.addOnBudgetFactor,
    expectedSavingsPct: policy?.expectedSavingsPct ?? fallback.expectedSavingsPct,
    strategySummary: policy?.strategySummary ?? combineSummary(policy ?? fallback),
  };
}

export function normalizeScenarioPolicies(policies) {
  if (!Array.isArray(policies) || policies.length === 0) {
    return DEFAULT_SCENARIO_POLICIES.map((policy) => ({ ...policy }));
  }

  return policies.map((policy, index) => {
    const fallback = DEFAULT_SCENARIO_POLICIES[index] ?? DEFAULT_SCENARIO_POLICIES.at(-1);
    return mergePolicy(policy, fallback);
  });
}

export function haDeploymentFor(policy, environment) {
  const posture = policy?.haPosture ?? DEFAULT_SCENARIO_POLICIES[0].haPosture;
  const mapping = HA_DEPLOYMENTS[posture] ?? HA_DEPLOYMENTS.standard;
  return mapping[environment] ?? mapping.prod;
}

export function exactLinkSupportedFor(policy) {
  return (policy?.exactLinkSupport ?? "modeled-only") === "exact";
}
