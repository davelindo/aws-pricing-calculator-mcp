import crypto from "node:crypto";

import {
  DEFAULT_REGION,
  DESIGN_REGIONS,
  candidateBlueprintIds,
  getArchitecturePattern,
  getBlueprint,
  getServiceDefinition,
  getServiceRegionCapability,
  getTemplate,
  listArchitecturePatterns,
  listServiceCatalog,
  resolveBlueprintIdForTemplate,
  supportedBlueprintIds,
} from "./catalog.js";
import {
  ENVIRONMENTS,
  buildComputePlan,
  buildEstimatePayloadFromEntries,
  buildNatPlan,
  modelEc2MonthlyUsd,
  modelRdsMonthlyUsd,
  normalizeEnvironmentSplit,
  modelEksMonthlyUsd,
  pricingFor,
  rdsPricingModelMultiplier,
  roundCurrency,
  selectedRdsTier,
} from "./model.js";
import { exactLinkSupportedFor, normalizeScenarioPolicies } from "./scenario-policy.js";
import { validateArchitectureScenario, validateEstimatePayload } from "./validation.js";

const BRIEF_PREVIEW_LENGTH = 240;
const OPERATING_SYSTEMS = new Set(["linux", "windows"]);
const SECURITY_SIGNAL_PATTERNS = [/security/i, /compliance/i, /regulat/i, /waf/i, /incident/i];
const MODERNIZATION_SIGNAL_PATTERNS = [/moderni/i, /migrat/i, /fargate/i, /ecs/i, /landing zone/i];
const UNSUPPORTED_DATABASES = [
  { pattern: /mariadb/i, label: "MariaDB" },
  { pattern: /oracle/i, label: "Oracle" },
];
const SHARED_POSTGRES_BUDGET_PROFILES = [
  {
    instanceType: "db.t4g.large",
    deploymentOption: "Single-AZ",
    storageGb: 100,
  },
  {
    instanceType: "db.t4g.large",
    deploymentOption: "Multi-AZ",
    storageGb: 100,
  },
  {
    instanceType: "db.r6g.large",
    deploymentOption: "Single-AZ",
    storageGb: 150,
  },
  {
    instanceType: "db.r6g.large",
    deploymentOption: "Multi-AZ",
    storageGb: 150,
  },
  {
    instanceType: "db.r6g.xlarge",
    deploymentOption: "Single-AZ",
    storageGb: 200,
  },
  {
    instanceType: "db.r6g.xlarge",
    deploymentOption: "Multi-AZ",
    storageGb: 200,
  },
  {
    instanceType: "db.r6g.2xlarge",
    deploymentOption: "Single-AZ",
    storageGb: 300,
  },
  {
    instanceType: "db.r6g.2xlarge",
    deploymentOption: "Multi-AZ",
    storageGb: 300,
  },
  {
    instanceType: "db.r6g.4xlarge",
    deploymentOption: "Multi-AZ",
    storageGb: 500,
  },
];

function clampNumber(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeWeightedEnvironmentSplit(environmentSplit, scaleFactors) {
  const weighted = {
    dev: environmentSplit.dev * scaleFactors.dev,
    staging: environmentSplit.staging * scaleFactors.staging,
    prod: environmentSplit.prod * scaleFactors.prod,
  };
  const total = weighted.dev + weighted.staging + weighted.prod;

  if (total <= 0) {
    return environmentSplit;
  }

  return {
    dev: weighted.dev / total,
    staging: weighted.staging / total,
    prod: weighted.prod / total,
  };
}

function ec2PricingStrategyForPolicy(policy) {
  return {
    selectedOption:
      policy.computeCommitment === "reserved-heavy"
        ? "reserved-heavy"
        : policy.computeCommitment === "reserved"
          ? "reserved"
          : policy.computeCommitment === "savings-plans"
            ? "savings-plans"
            : "on-demand",
    term: "1 year",
    utilizationValue: "100",
  };
}

function rdsPricingModelForPolicy(policy) {
  if (policy.databaseCommitment === "reserved-heavy") {
    return "ReservedHeavy";
  }

  if (policy.databaseCommitment === "reserved") {
    return "Reserved";
  }

  return "OnDemand";
}

function deploymentOptionForPolicy(policy, environment, baselineOption) {
  if (environment === "prod") {
    return policy.prodMultiAz ? "Multi-AZ" : baselineOption;
  }

  return policy.nonProdMultiAz ? "Multi-AZ" : "Single-AZ";
}

function storageGbForPolicy(storageGb, policy) {
  return Math.max(20, Math.round(storageGb * policy.storageMultiplier));
}

function confidenceDescriptor(score) {
  if (score >= 75) {
    return "high";
  }

  if (score >= 55) {
    return "medium";
  }

  return "low";
}

function makeStructuredItem(id, field, message, remediation, blocking = false) {
  return {
    id,
    field,
    message,
    remediation,
    blocking,
  };
}

function inferOperatingSystem({ brief, explicitOperatingSystem, blueprint, assumptions }) {
  if (explicitOperatingSystem) {
    assumptions.push(`Operating system was supplied explicitly as ${explicitOperatingSystem}.`);
    return {
      value: explicitOperatingSystem,
      source: "explicit",
      confidence: 1,
    };
  }

  const lower = brief.toLowerCase();

  if (/\bwindows\b|\biis\b|active directory|\.net|dotnet/i.test(lower)) {
    assumptions.push("Operating system was inferred from the brief as windows.");
    return {
      value: "windows",
      source: "brief-inferred",
      confidence: 0.8,
    };
  }

  if (/\blinux\b|eks|kubernetes|container|fargate|ecs/i.test(lower)) {
    assumptions.push("Operating system was inferred from the brief as linux.");
    return {
      value: "linux",
      source: "brief-inferred",
      confidence: 0.8,
    };
  }

  assumptions.push(`Operating system defaulted from blueprint '${blueprint.id}' as ${blueprint.defaultOperatingSystem}.`);
  return {
    value: blueprint.defaultOperatingSystem,
    source: "blueprint-default",
    confidence: 0.65,
  };
}

const ARCHITECTURE_SIGNAL_PATTERNS = {
  containers: [/eks/i, /kubernetes/i, /\bcontainer/i, /\bcontainers/i, /argocd/i],
  kubernetes: [/eks/i, /kubernetes/i, /argocd/i],
  "vm-runtime": [/\bec2\b/i, /\bvm\b/i, /\bfleet\b/i, /\bvirtual machine/i],
  linux: [/\blinux\b/i],
  windows: [/\bwindows\b/i, /\biis\b/i, /active directory/i, /\.net\b/i, /\bdotnet\b/i],
  edge: [/\bedge\b/i, /cloudfront/i, /cdn/i, /route ?53/i],
  api: [/\bapi\b/i, /gateway/i],
  serverless: [/lambda/i, /serverless/i],
  eventing: [/event/i, /eventbridge/i, /\bsqs\b/i, /\bsns\b/i, /\bqueue/i, /async/i],
  async: [/async/i, /\bqueue/i, /event/i],
  queueing: [/\bsqs\b/i, /\bsns\b/i, /\bqueue/i],
  modernization: [/moderni/i, /migrat/i, /refactor/i, /landing zone/i, /fargate/i, /\becs\b/i],
  migration: [/migrat/i, /landing zone/i, /moderni/i],
  "data-lake": [/data lake/i, /\blake\b/i, /athena/i, /glue/i, /catalog/i, /crawler/i],
  lakehouse: [/lakehouse/i],
  warehouse: [/warehouse/i, /redshift/i, /\bbi\b/i, /reporting/i],
  analytics: [/analytics/i, /athena/i, /redshift/i, /query/i],
  streaming: [/stream/i, /streaming/i, /real[- ]?time/i, /firehose/i],
  web: [/\bweb\b/i, /\bsite\b/i, /\bapp\b/i],
  relational: [/postgres/i, /postgresql/i, /aurora/i, /\brds\b/i, /sql server/i, /mysql/i],
  microsoft: [/windows/i, /microsoft/i, /active directory/i, /sql server/i],
};

function normalizeBrief(brief) {
  return String(brief ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function operatingSystemHintFromBrief(brief, explicitOperatingSystem = null) {
  if (explicitOperatingSystem) {
    return explicitOperatingSystem;
  }

  const lower = normalizeBrief(brief).toLowerCase();

  if (ARCHITECTURE_SIGNAL_PATTERNS.windows.some((pattern) => pattern.test(lower))) {
    return "windows";
  }

  if (
    ARCHITECTURE_SIGNAL_PATTERNS.linux.some((pattern) => pattern.test(lower)) ||
    ARCHITECTURE_SIGNAL_PATTERNS.containers.some((pattern) => pattern.test(lower))
  ) {
    return "linux";
  }

  return null;
}

function signalsFromServiceIds(serviceIds = []) {
  const lowerJoined = serviceIds.join(" ").toLowerCase();
  const matched = [];

  for (const [signal, patterns] of Object.entries(ARCHITECTURE_SIGNAL_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(lowerJoined))) {
      matched.push(signal);
    }
  }

  return matched;
}

function deriveArchitectureSignals({ brief, operatingSystem, serviceIds = [] }) {
  const normalized = normalizeBrief(brief).toLowerCase();
  const matched = new Set(signalsFromServiceIds(serviceIds));

  for (const [signal, patterns] of Object.entries(ARCHITECTURE_SIGNAL_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      matched.add(signal);
    }
  }

  const operatingSystemHint = operatingSystemHintFromBrief(normalized, operatingSystem);

  if (operatingSystemHint === "windows") {
    matched.add("windows");
    matched.add("microsoft");
  } else if (operatingSystemHint === "linux") {
    matched.add("linux");
  }

  return {
    operatingSystemHint,
    matched: [...matched],
    hasBrief: normalized.length > 0,
  };
}

function extractHardConstraints({ brief, serviceIds = [], operatingSystem }) {
  const normalized = normalizeBrief(brief).toLowerCase();
  const joinedServiceIds = serviceIds.join(" ").toLowerCase();
  const hasToken = (pattern) => pattern.test(normalized) || pattern.test(joinedServiceIds);
  const requestedAlbOrigins = hasToken(/\balb origins?\b|origin app|origin-backed|alb-backed origins?/i);
  const requestedDatabase =
    hasToken(/sql server/i)
      ? "sqlserver"
      : hasToken(/postgres|postgresql|aurora|rds/i)
        ? "postgresql"
        : null;
  const requiresServerless =
    hasToken(/serverless|lambda/i) &&
    !hasToken(/eks|kubernetes|container|containers|ecs|fargate/i) &&
    !requestedAlbOrigins;
  const requiresPrivateConnectivity = hasToken(/privatelink|private link|private api|private service/i);
  const requiresGovernance = hasToken(/governed|governance|lake formation/i);
  const requiresStreamProcessing = hasToken(/real[- ]?time|stream(?:ing)? analytics|continuous/i);
  const requiresFargatePrimary = hasToken(/fargate/i);

  return {
    requiresServerless,
    requiresPrivateConnectivity,
    requiresGovernance,
    requiresStreamProcessing,
    requiresFargatePrimary,
    requestedDatabase,
    requestedAlbOrigins,
    requestedCdn: hasToken(/cdn|cloudfront/i),
    requestedRoute53: hasToken(/route ?53/i),
    requestedWaf: hasToken(/\bwaf\b/i),
    requestedEventBridge: hasToken(/eventbridge/i),
    requestedQueueing: hasToken(/\bsqs\b|\bsns\b|\bqueue\b|async/i),
    requestedSqlServer: requestedDatabase === "sqlserver",
    requestedFiles: hasToken(/fsx|smb|file share/i),
    requestedStreaming: hasToken(/stream|streaming|firehose/i),
    requestedSearch: hasToken(/opensearch|search/i),
    operatingSystemHint: operatingSystemHintFromBrief(normalized, operatingSystem),
  };
}

function defaultPatternForBlueprint(blueprint) {
  return {
    id: `${blueprint.id}.default`,
    blueprintId: blueprint.id,
    title: blueprint.title,
    description: blueprint.description,
    templateId: blueprint.templateId,
    coreStrategy: null,
    environmentModel: blueprint.environmentModel,
    defaultOperatingSystem: blueprint.defaultOperatingSystem,
    keywords: [],
    traits: [],
    requiredCapabilities: [...(blueprint.requiredCapabilities ?? [])],
    budgetGuidance: blueprint.budgetGuidance ? { ...blueprint.budgetGuidance } : null,
    requiredServiceFamilies: [...(blueprint.requiredServiceFamilies ?? [])],
    requiredServiceIds: [...(blueprint.requiredServiceIds ?? [])],
    defaultAddOnServiceIds: [...(blueprint.defaultAddOnServiceIds ?? [])],
    optionalServiceIds: [...(blueprint.optionalServiceIds ?? [])],
    addOnAllocations: { ...(blueprint.addOnAllocations ?? {}) },
    primaryServiceIds: [...(blueprint.primaryServiceIds ?? [])],
    forbiddenServiceIds: [...(blueprint.forbiddenServiceIds ?? [])],
    coreBudgetWeights: blueprint.coreBudgetWeights ? { ...blueprint.coreBudgetWeights } : null,
    serviceRoles: { ...(blueprint.serviceRoles ?? {}) },
    requiredUnpricedCapabilities: [],
  };
}

function resolveArchitectureProfile(blueprint, pattern) {
  return {
    ...blueprint,
    patternId: pattern.id,
    patternTitle: pattern.title,
    patternDescription: pattern.description,
    templateId: pattern.templateId ?? blueprint.templateId,
    environmentModel: pattern.environmentModel ?? blueprint.environmentModel,
    defaultOperatingSystem: pattern.defaultOperatingSystem ?? blueprint.defaultOperatingSystem,
    requiredCapabilities: pattern.requiredCapabilities ?? [...(blueprint.requiredCapabilities ?? [])],
    budgetGuidance: pattern.budgetGuidance ?? (blueprint.budgetGuidance ? { ...blueprint.budgetGuidance } : null),
    requiredServiceFamilies:
      pattern.requiredServiceFamilies ?? [...(blueprint.requiredServiceFamilies ?? [])],
    requiredServiceIds: pattern.requiredServiceIds ?? [...(blueprint.requiredServiceIds ?? [])],
    defaultAddOnServiceIds:
      pattern.defaultAddOnServiceIds ?? [...(blueprint.defaultAddOnServiceIds ?? [])],
    optionalServiceIds: pattern.optionalServiceIds ?? [...(blueprint.optionalServiceIds ?? [])],
    addOnAllocations: {
      ...(blueprint.addOnAllocations ?? {}),
      ...(pattern.addOnAllocations ?? {}),
    },
    primaryServiceIds: pattern.primaryServiceIds ?? [...(blueprint.primaryServiceIds ?? [])],
    forbiddenServiceIds:
      pattern.forbiddenServiceIds ?? [...(blueprint.forbiddenServiceIds ?? [])],
    coreBudgetWeights: pattern.coreBudgetWeights ?? blueprint.coreBudgetWeights ?? null,
    coreStrategy: pattern.coreStrategy ?? getTemplate(pattern.templateId ?? blueprint.templateId).coreStrategy ?? null,
    serviceRoles: {
      ...(blueprint.serviceRoles ?? {}),
      ...(pattern.serviceRoles ?? {}),
    },
    requiredUnpricedCapabilities: pattern.requiredUnpricedCapabilities ?? [],
    patternTraits: [...(pattern.traits ?? [])],
  };
}

function patternKeywordScore(briefLower, pattern) {
  return (pattern.keywords ?? []).reduce((score, keyword) => {
    if (!briefLower.includes(keyword.toLowerCase())) {
      return score;
    }

    return score + (keyword.includes(" ") ? 7 : 4);
  }, 0);
}

function scorePatternCandidate({
  blueprint,
  pattern,
  briefLower,
  hardConstraints,
  targetMonthlyUsd,
  serviceIds = [],
}) {
  const profile = resolveArchitectureProfile(blueprint, pattern);
  const requestedServices = new Set(serviceIds ?? []);
  const budgetFit = budgetFitForBlueprint(profile, targetMonthlyUsd);
  const rationale = [];
  const keywordScore = patternKeywordScore(briefLower, pattern);
  let score = keywordScore;

  if (!pattern.id.endsWith(".default") && keywordScore > 0) {
    score += 8;
  }

  for (const serviceId of profile.requiredServiceIds) {
    if (requestedServices.has(serviceId)) {
      score += 8;
      rationale.push(`Explicitly requested ${serviceId}.`);
    }
  }

  if (hardConstraints.requestedDatabase === "sqlserver") {
    score += profile.patternTraits.includes("sqlserver") ? 28 : -45;
  } else if (profile.patternTraits.includes("sqlserver")) {
    score -= 18;
  }

  if (hardConstraints.requiresServerless) {
    score += profile.patternTraits.includes("serverless") ? 35 : -50;
  }

  if (hardConstraints.requiresPrivateConnectivity) {
    score += profile.patternTraits.includes("private") ? 28 : -40;
  }

  if (hardConstraints.requiresFargatePrimary) {
    score += profile.patternTraits.includes("fargate") ? 28 : -45;
  }

  if (hardConstraints.requiresGovernance) {
    score += profile.patternTraits.includes("governed") ? 24 : -28;
  }

  if (hardConstraints.requiresStreamProcessing) {
    score += profile.patternTraits.includes("stream-processing") ? 24 : -30;
  }

  if (hardConstraints.requestedAlbOrigins) {
    score += pattern.id === "cloudfront-alb-origin-app" ? 42 : 0;
  }

  if (hardConstraints.requestedEventBridge) {
    score += pattern.id === "event-bus-integration-platform" ? 40 : pattern.id === "async-worker-platform" ? -6 : 0;
  }

  if (hardConstraints.requestedQueueing) {
    score += pattern.id === "async-worker-platform" || pattern.id === "pubsub-fanout-platform" ? 10 : 0;
  }

  if (hardConstraints.requestedFiles) {
    score += pattern.id === "windows-files-app" ? 18 : 0;
  }

  if (hardConstraints.requestedSearch) {
    score += pattern.id === "eks-search-content-platform" ? 28 : 0;
  }

  if (hardConstraints.requestedCdn) {
    score += pattern.id === "ec2-web-with-cdn" ? 28 : 0;
  }

  if (hardConstraints.requiresPrivateConnectivity) {
    score +=
      pattern.id === "eks-private-service" || pattern.id === "ec2-web-with-private-service"
        ? 18
        : 0;
  }

  if (/\bapi gateway\b|\bapi\b/.test(briefLower)) {
    score += pattern.id === "eks-api-front-door" ? 20 : 0;
  }

  if (/fanout|notifications?|pubsub/.test(briefLower)) {
    score += pattern.id === "pubsub-fanout-platform" ? 36 : 0;
  }

  if (/async|jobs?|workers?/.test(briefLower)) {
    score += pattern.id === "async-worker-platform" ? 20 : 0;
  }

  if (/integration/.test(briefLower)) {
    score += pattern.id === "event-bus-integration-platform" ? 18 : 0;
  }

  if (budgetFit.status === "fits") {
    score += 4;
  }

  return {
    id: pattern.id,
    title: pattern.title,
    description: pattern.description,
    fitScore: score,
    budgetFit,
    requiredServiceIds: [...profile.requiredServiceIds],
    primaryServiceIds: [...profile.primaryServiceIds],
    forbiddenServiceIds: [...profile.forbiddenServiceIds],
    requiredUnpricedCapabilities: profile.requiredUnpricedCapabilities.map((capability) => ({
      ...capability,
    })),
    traits: [...profile.patternTraits],
    rationale: rationale.length > 0 ? rationale : ["Pattern matched the strongest architecture signals."],
  };
}

function buildPatternCandidates({
  blueprint,
  brief,
  targetMonthlyUsd,
  serviceIds = [],
  hardConstraints,
}) {
  const briefLower = normalizeBrief(brief).toLowerCase();
  const patterns = [
    defaultPatternForBlueprint(blueprint),
    ...listArchitecturePatterns(blueprint.id),
  ];

  return patterns
    .map((pattern) =>
      scorePatternCandidate({
        blueprint,
        pattern,
        briefLower,
        hardConstraints,
        targetMonthlyUsd,
        serviceIds,
      }),
    )
    .sort((left, right) => right.fitScore - left.fitScore);
}

function materializePattern(blueprint, patternId) {
  return patternId.endsWith(".default")
    ? defaultPatternForBlueprint(blueprint)
    : getArchitecturePattern(blueprint.id, patternId);
}

function patternFitGaps(profile, hardConstraints) {
  const fitGaps = [];
  const excludedDefaults = [];

  if (hardConstraints.requiresServerless && !profile.patternTraits.includes("serverless")) {
    fitGaps.push(
      "The prompt implies a serverless runtime, but the selected pattern still requires an origin/runtime service.",
    );
  }

  if (
    hardConstraints.requiresPrivateConnectivity &&
    profile.architectureFamily !== "data-platform" &&
    !profile.patternTraits.includes("private") &&
    !profile.requiredServiceIds.includes("amazon-vpc-endpoints") &&
    !profile.optionalServiceIds.includes("amazon-vpc-endpoints")
  ) {
    fitGaps.push(
      "The prompt implies a private-connectivity pattern, but the selected architecture is not private-ingress-native.",
    );
  }

  if (
    hardConstraints.requestedDatabase === "sqlserver" &&
    !profile.requiredServiceIds.includes("amazon-rds-sqlserver")
  ) {
    fitGaps.push(
      "The prompt explicitly requests SQL Server, but the selected pattern does not center SQL Server.",
    );
  }

  if (
    hardConstraints.requiresFargatePrimary &&
    !profile.patternTraits.includes("fargate")
  ) {
    fitGaps.push(
      "The prompt explicitly requests Fargate, but the selected pattern is not Fargate-led.",
    );
  }

  if (
    hardConstraints.requestedAlbOrigins &&
    profile.blueprintId === "edge-api-platform" &&
    profile.patternId !== "cloudfront-alb-origin-app"
  ) {
    fitGaps.push(
      "The prompt references ALB origins, but the selected edge pattern is not origin-app centered.",
    );
  }

  if (hardConstraints.requiresPrivateConnectivity) {
    if (profile.forbiddenServiceIds.includes("amazon-cloudfront")) {
      excludedDefaults.push("amazon-cloudfront");
    }
    if (profile.forbiddenServiceIds.includes("application-load-balancer")) {
      excludedDefaults.push("application-load-balancer");
    }
    if (profile.forbiddenServiceIds.includes("amazon-vpc-nat")) {
      excludedDefaults.push("amazon-vpc-nat");
    }
  }

  if (hardConstraints.requiresGovernance && profile.requiredUnpricedCapabilities.length === 0) {
    fitGaps.push(
      "The prompt implies a governed lake, but no explicit governance capability is modeled for the selected pattern.",
    );
  }

  if (
    hardConstraints.requiresStreamProcessing &&
    !profile.patternTraits.includes("stream-processing")
  ) {
    fitGaps.push(
      "The prompt implies real-time stream processing, but the selected pattern is lake-ingest oriented.",
    );
  }

  return {
    fitGaps,
    excludedDefaults,
  };
}

function minimumPrimaryDominanceRatioFor(profile) {
  if (profile.patternTraits.includes("serverless") || profile.patternTraits.includes("private")) {
    return 0.65;
  }

  if (profile.patternTraits.includes("fargate")) {
    return 0.6;
  }

  if (profile.architectureFamily === "data-platform") {
    return 0.62;
  }

  return 0.55;
}

function budgetFitForBlueprint(blueprint, targetMonthlyUsd) {
  const guidance = blueprint.budgetGuidance ?? null;

  if (!Number.isFinite(targetMonthlyUsd) || targetMonthlyUsd <= 0 || !guidance) {
    return {
      status: "underspecified",
      details: "No target monthly budget was supplied for ranking.",
      guidance,
    };
  }

  if (guidance.minimumMonthlyUsd && targetMonthlyUsd < guidance.minimumMonthlyUsd) {
    return {
      status: "incompatible_budget",
      details: `Target ${targetMonthlyUsd.toFixed(2)} USD is below the minimum viable range of ${guidance.minimumMonthlyUsd.toFixed(2)} USD.`,
      guidance,
    };
  }

  if (guidance.preferredMinMonthlyUsd && targetMonthlyUsd < guidance.preferredMinMonthlyUsd) {
    return {
      status: "nearest_fit_below",
      details: `Target ${targetMonthlyUsd.toFixed(2)} USD is below the preferred operating range of ${guidance.preferredMinMonthlyUsd.toFixed(2)} USD.`,
      guidance,
    };
  }

  if (guidance.preferredMaxMonthlyUsd && targetMonthlyUsd > guidance.preferredMaxMonthlyUsd) {
    return {
      status: "nearest_fit_above",
      details: `Target ${targetMonthlyUsd.toFixed(2)} USD is above the preferred operating range of ${guidance.preferredMaxMonthlyUsd.toFixed(2)} USD.`,
      guidance,
    };
  }

  return {
    status: "fits",
    details: `Target ${targetMonthlyUsd.toFixed(2)} USD falls inside the preferred operating range.`,
    guidance,
  };
}

function serviceSelectionSignals(serviceIds = []) {
  const selected = new Set(serviceIds);

  return {
    has(serviceId) {
      return selected.has(serviceId);
    },
    size: selected.size,
  };
}

function scoreArchitectureCandidate({
  blueprint,
  signals,
  targetMonthlyUsd,
  serviceIds = [],
}) {
  const selectedServices = serviceSelectionSignals(serviceIds);
  const matchedSignals = [];
  const rationale = [];
  let score = signals.hasBrief ? blueprintKeywordScore(signals.briefLower ?? "", blueprint) : 0;
  const budgetFit = budgetFitForBlueprint(blueprint, targetMonthlyUsd);

  for (const signal of blueprint.signalProfile?.boost ?? []) {
    if (signals.matched.includes(signal)) {
      matchedSignals.push(signal);
      rationale.push(`Matched ${signal} workload signals.`);
      score += 8;
    }
  }

  for (const signal of blueprint.signalProfile?.penalize ?? []) {
    if (signals.matched.includes(signal)) {
      score -= 7;
    }
  }

  const requiredSignals = blueprint.signalProfile?.requireAny ?? [];

  if (requiredSignals.length > 0) {
    const matchedRequiredSignals = requiredSignals.filter((signal) => signals.matched.includes(signal));

    if (matchedRequiredSignals.length > 0) {
      score += matchedRequiredSignals.length * 5;
    } else if (signals.hasBrief) {
      score -= 10;
    }
  }

  if (signals.operatingSystemHint && blueprint.defaultOperatingSystem === signals.operatingSystemHint) {
    score += 4;
  } else if (
    signals.operatingSystemHint === "windows" &&
    blueprint.defaultOperatingSystem === "linux"
  ) {
    score -= 12;
  }

  for (const serviceId of blueprint.requiredServiceIds) {
    if (selectedServices.has(serviceId)) {
      score += 6;
      rationale.push(`Explicitly requested ${serviceId}.`);
    }
  }

  switch (budgetFit.status) {
    case "fits":
      score += 6;
      break;
    case "nearest_fit_below":
    case "nearest_fit_above":
      score -= 2;
      break;
    case "incompatible_budget":
      score -= 10;
      break;
    default:
      break;
  }

  return {
    blueprintId: blueprint.id,
    blueprintTitle: blueprint.title,
    architectureFamily: blueprint.architectureFamily,
    architectureSubtype: blueprint.architectureSubtype,
    summary: blueprint.description,
    requiredCapabilities: [...(blueprint.requiredCapabilities ?? [])],
    requiredServiceIds: [...blueprint.requiredServiceIds],
    optionalServiceIds: [...blueprint.optionalServiceIds],
    packIds: [...(blueprint.packIds ?? [])],
    fitScore: score,
    matchedSignals: [...new Set(matchedSignals)],
    budgetFit,
    rationale: rationale.length > 0 ? rationale : ["No strong workload-specific signals were matched."],
  };
}

function buildArchitectureCandidates({
  blueprintId,
  templateId,
  brief,
  targetMonthlyUsd,
  operatingSystem,
  serviceIds,
  assumptions,
}) {
  if (blueprintId) {
    const blueprint = getBlueprint(blueprintId);

    assumptions.push(`Architecture '${blueprintId}' was supplied explicitly.`);

    return [
      {
        ...scoreArchitectureCandidate({
          blueprint,
          signals: {
            matched: deriveArchitectureSignals({ brief, operatingSystem, serviceIds }).matched,
            operatingSystemHint: operatingSystemHintFromBrief(brief, operatingSystem),
            hasBrief: normalizeBrief(brief).length > 0,
            briefLower: normalizeBrief(brief).toLowerCase(),
          },
          targetMonthlyUsd,
          serviceIds,
        }),
        explicit: true,
      },
    ];
  }

  if (templateId) {
    const resolvedBlueprintId = resolveBlueprintIdForTemplate(templateId);
    const blueprint = getBlueprint(resolvedBlueprintId);

    assumptions.push(`Architecture '${resolvedBlueprintId}' was selected from template '${templateId}'.`);

    return [
      {
        ...scoreArchitectureCandidate({
          blueprint,
          signals: {
            matched: deriveArchitectureSignals({ brief, operatingSystem, serviceIds }).matched,
            operatingSystemHint: operatingSystemHintFromBrief(brief, operatingSystem),
            hasBrief: normalizeBrief(brief).length > 0,
            briefLower: normalizeBrief(brief).toLowerCase(),
          },
          targetMonthlyUsd,
          serviceIds,
        }),
        explicit: true,
      },
    ];
  }

  if (!normalizeBrief(brief)) {
    assumptions.push("Architecture 'linux-web-stack' was selected as the default architecture.");

    return [
      scoreArchitectureCandidate({
        blueprint: getBlueprint("linux-web-stack"),
        signals: {
          matched: [],
          operatingSystemHint: operatingSystem,
          hasBrief: false,
          briefLower: "",
        },
        targetMonthlyUsd,
        serviceIds,
      }),
    ];
  }

  const signalState = deriveArchitectureSignals({ brief, operatingSystem, serviceIds });
  signalState.briefLower = normalizeBrief(brief).toLowerCase();

  const ranked = candidateBlueprintIds()
    .map((candidateId) =>
      scoreArchitectureCandidate({
        blueprint: getBlueprint(candidateId),
        signals: signalState,
        targetMonthlyUsd,
        serviceIds,
      }),
    )
    .sort((left, right) => right.fitScore - left.fitScore);

  if (ranked[0]) {
    assumptions.push(`Architecture '${ranked[0].blueprintId}' was inferred from the brief.`);
  } else {
    assumptions.push("Architecture 'linux-web-stack' was selected as the default architecture.");
  }

  return ranked.slice(0, 3);
}

function selectedArchitectureCandidate(candidates) {
  return candidates[0] ?? null;
}

function alternativeArchitectureCandidates(candidates) {
  return candidates.slice(1);
}

function blueprintKeywordScore(brief, blueprint) {
  return blueprint.keywords.reduce((score, keyword) => {
    if (!brief.includes(keyword)) {
      return score;
    }

    const tokenCount = keyword.trim().split(/\s+/).filter(Boolean).length;
    return score + (tokenCount > 1 ? tokenCount * 6 : 3);
  }, 0);
}

function briefPreview(brief) {
  const normalized = normalizeBrief(brief);

  if (!normalized) {
    return null;
  }

  return normalized.length <= BRIEF_PREVIEW_LENGTH
    ? normalized
    : `${normalized.slice(0, BRIEF_PREVIEW_LENGTH - 1)}…`;
}

function parseMoneyToken(rawToken) {
  const compact = rawToken.replace(/[\s,$]/g, "").toLowerCase();
  const hasThousandsSuffix = compact.endsWith("k");
  const numeric = hasThousandsSuffix ? compact.slice(0, -1) : compact;
  const parsed = Number(numeric.replace(/usd$/i, ""));

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return roundCurrency(parsed * (hasThousandsSuffix ? 1_000 : 1));
}

function budgetContextScore(context, baseScore) {
  const positiveSignals = [
    ["calculator", 60],
    ["mrr", 45],
    ["monthly", 35],
    ["month", 25],
    ["budget", 25],
    ["target", 20],
    ["push", 15],
    ["needed", 10],
  ];
  const negativeSignals = [
    ["arr", 45],
    ["project", 35],
    ["forecast", 20],
    ["current", 20],
    ["credits", 20],
    ["one-time", 20],
  ];
  let score = baseScore;

  for (const [signal, weight] of positiveSignals) {
    if (context.includes(signal)) {
      score += weight;
    }
  }

  for (const [signal, weight] of negativeSignals) {
    if (context.includes(signal)) {
      score -= weight;
    }
  }

  return score;
}

function extractBudgetCandidates(brief) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    {
      regex:
        /(\$?\s*\d+(?:,\d{3})*(?:\.\d+)?\s*k?)\s*(?:usd)?\s*(?:\/\s*month|per month|monthly|mrr|\/mo|\bmo\b)/gi,
      baseScore: 70,
    },
    {
      regex:
        /(?:calculator|budget|target|push)[^$\d]{0,20}(\$?\s*\d+(?:,\d{3})*(?:\.\d+)?\s*k?)/gi,
      baseScore: 55,
    },
    {
      regex:
        /(\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*k)?|\d+(?:\.\d+)?\s*k|\d+(?:,\d{3})*(?:\.\d+)?\s*usd)\b/gi,
      baseScore: 20,
    },
  ];

  for (const { regex, baseScore } of patterns) {
    for (const match of brief.matchAll(regex)) {
      const rawToken = (match[1] ?? match[0]).trim();
      const start = match.index ?? 0;
      const key = `${start}:${rawToken}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      const usd = parseMoneyToken(rawToken);

      if (!usd) {
        continue;
      }

      const context = brief
        .slice(Math.max(0, start - 60), Math.min(brief.length, start + 80))
        .toLowerCase();

      candidates.push({
        usd,
        score: budgetContextScore(context, baseScore),
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.usd - right.usd);
  return candidates;
}

function inferTargetMonthlyUsd(brief, explicitTarget, warnings, assumptions) {
  if (Number.isFinite(explicitTarget) && explicitTarget > 0) {
    assumptions.push(
      `Target monthly budget was supplied explicitly as ${Number(explicitTarget).toFixed(2)} USD.`,
    );
    return roundCurrency(explicitTarget);
  }

  const candidates = extractBudgetCandidates(brief);

  if (candidates.length === 0) {
    return null;
  }

  const selected = candidates[0];
  assumptions.push(
    `Target monthly budget was inferred as ${selected.usd.toFixed(2)} USD from the brief.`,
  );

  if (candidates.length > 1) {
    warnings.push(
      `The brief contained multiple spend-like values. Selected ${selected.usd.toFixed(2)} USD from the strongest calculator/monthly context.`,
    );
  }

  return selected.usd;
}

function inferEnvironmentSplitFromBrief(brief, assumptions) {
  const lower = brief.toLowerCase();

  if (
    !(
      (lower.includes("dev") && lower.includes("prod")) ||
      lower.includes("environment split") ||
      lower.includes("environment model") ||
      lower.includes("non-prod")
    )
  ) {
    return null;
  }

  const match = brief.match(/(\d{1,3})\s*\/\s*(\d{1,3})\s*\/\s*(\d{1,3})/);

  if (!match) {
    return null;
  }

  assumptions.push(
    `Environment split was inferred from the brief as ${match[1]}/${match[2]}/${match[3]}.`,
  );

  return {
    dev: Number(match[1]),
    staging: Number(match[2]),
    prod: Number(match[3]),
  };
}

function inferRegion(brief, explicitRegion, warnings, assumptions) {
  if (explicitRegion) {
    assumptions.push(`Region was supplied explicitly as ${explicitRegion}.`);
    return explicitRegion;
  }

  const lower = brief.toLowerCase();

  for (const region of DESIGN_REGIONS) {
    if (lower.includes(region)) {
      assumptions.push(`Region was inferred from the brief as ${region}.`);
      return region;
    }
  }

  if (lower.includes("canada")) {
    warnings.push("The brief references Canada. Using ca-central-1.");
    return "ca-central-1";
  }

  if (lower.includes("brazil") || lower.includes("sao paulo") || lower.includes("são paulo")) {
    warnings.push("The brief references Brazil / São Paulo. Using sa-east-1.");
    return "sa-east-1";
  }

  if (lower.includes("australia") || lower.includes("sydney")) {
    warnings.push("The brief references Australia / Sydney. Using ap-southeast-2.");
    return "ap-southeast-2";
  }

  if (lower.includes("korea") || lower.includes("seoul")) {
    warnings.push("The brief references Korea / Seoul. Using ap-northeast-2.");
    return "ap-northeast-2";
  }

  assumptions.push(`Region defaulted to ${DEFAULT_REGION}.`);
  return DEFAULT_REGION;
}

function unsupportedDatabaseMention(brief) {
  for (const candidate of UNSUPPORTED_DATABASES) {
    if (candidate.pattern.test(brief)) {
      return candidate.label;
    }
  }

  return null;
}

function inferBlueprintId({ templateId, blueprintId, brief, operatingSystem, assumptions }) {
  if (blueprintId) {
    assumptions.push(`Blueprint was supplied explicitly as '${blueprintId}'.`);
    return blueprintId;
  }

  if (templateId) {
    const resolved = resolveBlueprintIdForTemplate(templateId);
    assumptions.push(`Blueprint '${resolved}' was selected from template '${templateId}'.`);
    return resolved;
  }

  const lower = brief.toLowerCase();
  const scoredCandidates = supportedBlueprintIds()
    .map((candidateId) => {
      const blueprint = getBlueprint(candidateId);

      return {
        candidateId,
        score: blueprintKeywordScore(lower, blueprint),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scoredCandidates.length > 0) {
    assumptions.push(`Blueprint '${scoredCandidates[0].candidateId}' was inferred from the brief.`);
    return scoredCandidates[0].candidateId;
  }

  if (operatingSystem === "windows") {
    assumptions.push("Blueprint 'windows-app-stack' was inferred from the operatingSystem override.");
    return "windows-app-stack";
  }

  assumptions.push("Blueprint 'linux-web-stack' was selected as the default architecture.");
  return "linux-web-stack";
}

function additionalServiceIdsFromBrief(brief) {
  const lower = brief.toLowerCase();

  return listServiceCatalog()
    .filter((service) => service.keywords.some((keyword) => matchesServiceKeyword(lower, keyword)))
    .map((service) => service.id);
}

function matchesServiceKeyword(briefLower, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  const index = briefLower.indexOf(normalizedKeyword);

  if (index === -1) {
    return false;
  }

  const lookBehind = briefLower.slice(Math.max(0, index - 24), index);

  if (/\b(no|not|without|exclude|excluding|except)\s+$/.test(lookBehind)) {
    return false;
  }

  return true;
}

function selectedServiceMetadata(blueprint, serviceId, required, source) {
  const roleMetadata = blueprint.serviceRoles?.[serviceId];

  if (roleMetadata) {
    return {
      role: roleMetadata.role,
      rationale: roleMetadata.rationale,
      required: roleMetadata.required ?? required,
    };
  }

  return {
    role: required ? "required-capability" : source === "explicit" ? "requested-add-on" : "optional-add-on",
    rationale: required
      ? `${serviceId} is part of the required service mix for ${blueprint.title}.`
      : source === "explicit"
        ? `${serviceId} was requested explicitly for this architecture.`
        : `${serviceId} augments the selected architecture as an optional service.`,
    required,
  };
}

function buildSelectedServices({
  blueprint,
  brief,
  serviceIds,
  region,
  includeDefaultAddOns = true,
  serviceSelectionMode = "augment",
}) {
  const explicitServiceIds = new Set(serviceIds ?? []);
  const inferredServiceIds = new Set(additionalServiceIdsFromBrief(brief));
  const selections = [];
  const seen = new Set();
  const forbiddenServiceIds = new Set(blueprint.forbiddenServiceIds ?? []);
  const pushService = (serviceId, selectionSource, required) => {
    if (!required && selectionSource !== "explicit" && forbiddenServiceIds.has(serviceId)) {
      return;
    }

    if (seen.has(serviceId)) {
      return;
    }

    seen.add(serviceId);
    const definition = getServiceDefinition(serviceId);
    const capability = getServiceRegionCapability(serviceId, region);
    const metadata = selectedServiceMetadata(blueprint, serviceId, required, selectionSource);
    selections.push({
      serviceId,
      serviceName: definition.name,
      category: definition.category,
      implementationStatus: definition.implementationStatus,
      required: metadata.required,
      role: metadata.role,
      rationale: metadata.rationale,
      source: selectionSource,
      capability,
    });
  };

  for (const serviceId of blueprint.requiredServiceIds) {
    pushService(serviceId, "blueprint-required", true);
  }

  if (includeDefaultAddOns && serviceSelectionMode === "augment") {
    for (const serviceId of blueprint.defaultAddOnServiceIds) {
      pushService(serviceId, "blueprint-default", false);
    }
  }

  if (serviceSelectionMode === "augment") {
    for (const serviceId of blueprint.optionalServiceIds) {
      if (explicitServiceIds.has(serviceId) || inferredServiceIds.has(serviceId)) {
        pushService(serviceId, explicitServiceIds.has(serviceId) ? "explicit" : "brief-inferred", false);
      }
    }
  }

  for (const serviceId of explicitServiceIds) {
    pushService(serviceId, "explicit", false);
  }

  if (serviceSelectionMode === "augment") {
    for (const serviceId of inferredServiceIds) {
      pushService(serviceId, "brief-inferred", false);
    }
  }

  return selections;
}

function coverageFor(selectedServices) {
  return {
    exact: selectedServices
      .filter((service) => service.capability.support === "exact")
      .map((service) => service.serviceId),
    modeled: selectedServices
      .filter((service) => service.capability.support === "modeled")
      .map((service) => service.serviceId),
    unavailable: selectedServices
      .filter((service) => service.capability.support === "unavailable")
      .map((service) => service.serviceId),
  };
}

function estimateNameFor(clientName, title) {
  return `${clientName ? `${clientName} - ` : ""}${title}`;
}

function scenarioEstimateName(baseEstimateName, policy) {
  return policy.id === "baseline" ? baseEstimateName : `${baseEstimateName} (${policy.title})`;
}

function priceModeledService(serviceId, region, monthlyBudgetUsd) {
  const definition = getServiceDefinition(serviceId);
  const capability = getServiceRegionCapability(serviceId, region);

  if (typeof definition.priceBudget !== "function") {
    throw new Error(`Modeled service '${serviceId}' is missing a priceBudget implementation.`);
  }

  return definition.priceBudget({
    definition,
    region,
    monthlyBudgetUsd,
    capability,
  });
}

function priceSelectedService({ service, region, monthlyBudgetUsd, notes }) {
  const definition = getServiceDefinition(service.serviceId);

  if (service.serviceId === "amazon-vpc-nat" && !service.required) {
    return {
      serviceId: service.serviceId,
      monthlyBudgetUsd,
      exact: false,
      breakdown: priceModeledService(service.serviceId, region, monthlyBudgetUsd),
    };
  }

  if (service.serviceId === "amazon-rds-postgresql" && !service.required) {
    const entry = buildBudgetDrivenPostgresEntry({
      region,
      monthlyBudgetUsd,
      notes,
      policy: normalizeScenarioPolicies()[0],
    });

    return {
      serviceId: service.serviceId,
      monthlyBudgetUsd,
      exact: true,
      entry,
      breakdown: augmentCoreBreakdown(entry.breakdown, region),
    };
  }

  if (service.serviceId === "amazon-ec2" && !service.required) {
    const entry = buildBudgetDrivenEc2Entry({
      region,
      monthlyBudgetUsd,
      notes,
      operatingSystem: service.category === "compute" ? "linux" : "linux",
      policy: normalizeScenarioPolicies()[0],
    });

    return {
      serviceId: service.serviceId,
      monthlyBudgetUsd,
      exact: true,
      entry,
      breakdown: augmentCoreBreakdown(entry.breakdown, region),
    };
  }

  if (service.capability.support === "exact") {
    if (typeof definition.buildEntry !== "function") {
      throw new Error(`Exact service '${service.serviceId}' is missing a buildEntry implementation.`);
    }

    const entry = definition.buildEntry({
      region,
      monthlyBudgetUsd,
      notes,
    });

    return {
      serviceId: service.serviceId,
      monthlyBudgetUsd,
      exact: true,
      entry,
      breakdown: entry.breakdown,
    };
  }

  return {
    serviceId: service.serviceId,
    monthlyBudgetUsd,
    exact: false,
    breakdown: priceModeledService(service.serviceId, region, monthlyBudgetUsd),
  };
}

function augmentCoreBreakdown(breakdown, region) {
  const mappings = {
    eks: "amazon-eks",
    ec2Linux: "amazon-ec2",
    ec2Windows: "amazon-ec2",
    rdsPostgres: "amazon-rds-postgresql",
    vpcNat: "amazon-vpc-nat",
  };
  const serviceId = mappings[breakdown.kind] ?? breakdown.kind;
  const definition = getServiceDefinition(serviceId);

  return {
    ...breakdown,
    region,
    monthlyUsd: roundCurrency(breakdown.monthlyUsd),
    serviceId,
    implementationStatus: definition.implementationStatus,
    capability: getServiceRegionCapability(serviceId, region),
    details: null,
  };
}

function annotateBreakdown(blueprint, breakdown) {
  const metadata = selectedServiceMetadata(
    blueprint,
    breakdown.serviceId,
    blueprint.requiredServiceIds.includes(breakdown.serviceId),
    "breakdown",
  );

  return {
    ...breakdown,
    implementationStatus:
      breakdown.implementationStatus ??
      (breakdown.serviceId ? getServiceDefinition(breakdown.serviceId).implementationStatus : null),
    capability:
      breakdown.capability ??
      (breakdown.serviceId && breakdown.region
        ? getServiceRegionCapability(breakdown.serviceId, breakdown.region)
        : null),
    supportive: blueprint.requiredServiceIds.includes(breakdown.serviceId) ? false : breakdown.supportive,
    role: metadata.role,
    required: metadata.required,
    rationale: metadata.rationale,
  };
}

function annotateBreakdowns(blueprint, breakdowns) {
  return breakdowns.map((breakdown) => annotateBreakdown(blueprint, breakdown));
}

function totalBreakdownMonthlyUsd(breakdowns) {
  return roundCurrency(breakdowns.reduce((sum, service) => sum + service.monthlyUsd, 0));
}

function totalEntryMonthlyUsd(entries) {
  return roundCurrency(entries.reduce((sum, entry) => sum + entry.breakdown.monthlyUsd, 0));
}

function normalizedBreakdown(entry) {
  const kindMappings = {
    eks: "amazon-eks",
    ec2Linux: "amazon-ec2",
    ec2Windows: "amazon-ec2",
    rdsPostgres: "amazon-rds-postgresql",
    vpcNat: "amazon-vpc-nat",
  };
  const serviceId = entry.breakdown.serviceId ?? kindMappings[entry.breakdown.kind] ?? null;
  const region = entry.breakdown.region ?? null;
  const definition = serviceId ? getServiceDefinition(serviceId) : null;

  return {
    ...entry.breakdown,
    ...(serviceId
      ? {
          serviceId,
          implementationStatus: definition.implementationStatus,
          capability: region ? getServiceRegionCapability(serviceId, region) : null,
        }
      : {}),
    monthlyUsd: roundCurrency(entry.breakdown.monthlyUsd),
  };
}

function allocateBudgetByWeights(totalBudgetUsd, weightedServices) {
  if (weightedServices.length === 0) {
    return [];
  }

  const positiveWeights = weightedServices.map((service) => ({
    ...service,
    weight: service.weight > 0 ? service.weight : 1,
  }));
  const totalWeight = positiveWeights.reduce((sum, service) => sum + service.weight, 0);
  let allocatedUsd = 0;

  return positiveWeights.map((service, index) => {
    const monthlyBudgetUsd =
      index === positiveWeights.length - 1
        ? roundCurrency(totalBudgetUsd - allocatedUsd)
        : roundCurrency((totalBudgetUsd * service.weight) / totalWeight);

    allocatedUsd = roundCurrency(allocatedUsd + monthlyBudgetUsd);

    return {
      serviceId: service.serviceId,
      monthlyBudgetUsd,
    };
  });
}

function buildBudgetDrivenEc2Entry({ region, monthlyBudgetUsd, notes, operatingSystem, policy }) {
  const ec2Service = getServiceDefinition("amazon-ec2");
  const instanceType = operatingSystem === "windows" ? "m6i.xlarge" : "m6i.large";
  const monthlyPerInstance = modelEc2MonthlyUsd(region, operatingSystem, instanceType, 1);
  const instanceCount = Math.max(1, Math.round(monthlyBudgetUsd / monthlyPerInstance));

  return ec2Service.buildEntry({
    environment: "shared",
    region,
    operatingSystem,
    instanceType,
    instanceCount,
    notes,
    pricingStrategy: ec2PricingStrategyForPolicy(policy),
  });
}

function buildBudgetDrivenPostgresEntry({ region, monthlyBudgetUsd, notes, policy }) {
  const rdsService = getServiceDefinition("amazon-rds-postgresql");
  const databasePricingModel = rdsPricingModelForPolicy(policy);
  const budget = Math.max(Number(monthlyBudgetUsd) || 0, 0);
  const storagePricing = pricingFor(region).rdsPostgres.storagePerGbMonth;
  const pricingMultiplier = rdsPricingModelMultiplier(databasePricingModel);
  const profile = SHARED_POSTGRES_BUDGET_PROFILES
    .map((candidate) => {
      const deploymentOption = deploymentOptionForPolicy(
        policy,
        "prod",
        candidate.deploymentOption,
      );
      const baselineMonthlyUsd =
        modelRdsMonthlyUsd(
          region,
          candidate.instanceType,
          deploymentOption,
          candidate.storageGb,
        ) * pricingMultiplier;
      const monthlyStorageRate =
        (storagePricing[deploymentOption] ?? storagePricing["Single-AZ"] ?? 0) * pricingMultiplier;
      const storageTopUpGb =
        budget > baselineMonthlyUsd && monthlyStorageRate > 0
          ? Math.min(
              12_000,
              Math.max(Math.round((budget - baselineMonthlyUsd) / monthlyStorageRate), 0),
            )
          : 0;
      const storageGb = candidate.storageGb + storageTopUpGb;
      const monthlyUsd =
        modelRdsMonthlyUsd(region, candidate.instanceType, deploymentOption, storageGb) *
        pricingMultiplier;

      return {
        instanceType: candidate.instanceType,
        deploymentOption,
        storageGb,
        monthlyUsd: roundCurrency(monthlyUsd),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
    )[0];

  return rdsService.buildEntry({
    environment: "shared",
    region,
    instanceType: profile.instanceType,
    deploymentOption: deploymentOptionForPolicy(policy, "prod", profile.deploymentOption),
    storageGb: storageGbForPolicy(profile.storageGb, policy),
    notes,
    pricingModel: databasePricingModel,
  });
}

function buildWeightedServiceEntry({ serviceId, region, monthlyBudgetUsd, notes, operatingSystem, policy }) {
  const definition = getServiceDefinition(serviceId);

  if (serviceId === "amazon-ec2") {
    return buildBudgetDrivenEc2Entry({
      region,
      monthlyBudgetUsd,
      notes,
      operatingSystem,
      policy,
    });
  }

  if (serviceId === "amazon-rds-postgresql") {
    return buildBudgetDrivenPostgresEntry({
      region,
      monthlyBudgetUsd,
      notes,
      policy,
    });
  }

  if (serviceId === "amazon-eks") {
    return definition.buildEntry({
      environment: "shared",
      region,
      notes,
    });
  }

  if (typeof definition.buildEntry !== "function") {
    throw new Error(`Exact core service '${serviceId}' is missing a buildEntry implementation.`);
  }

  return definition.buildEntry({
    region,
    monthlyBudgetUsd,
    notes,
  });
}

function buildWeightedServicesScenario({
  profile,
  region,
  targetMonthlyUsd,
  estimateName,
  notes,
  operatingSystem,
  policy,
}) {
  const weightedCoreServices = profile.requiredServiceIds
    .map((serviceId) => ({
      serviceId,
      weight: profile.coreBudgetWeights?.[serviceId] ?? 0,
    }))
    .filter((service) => service.weight > 0);

  if (weightedCoreServices.length === 0) {
    throw new Error(`Architecture pattern '${profile.patternId}' is missing weighted-service core weights.`);
  }

  const coreBudgets = allocateBudgetByWeights(targetMonthlyUsd, weightedCoreServices);
  const entries = coreBudgets.map((budget) =>
    buildWeightedServiceEntry({
      serviceId: budget.serviceId,
      region,
      monthlyBudgetUsd: budget.monthlyBudgetUsd,
      notes,
      operatingSystem: operatingSystem ?? profile.defaultOperatingSystem ?? "linux",
      policy,
    }),
  );
  const breakdown = annotateBreakdowns(
    profile,
    entries.map((entry) =>
      entry.breakdown.kind === "ec2Linux" ||
      entry.breakdown.kind === "ec2Windows" ||
      entry.breakdown.kind === "rdsPostgres" ||
      entry.breakdown.kind === "vpcNat"
        ? augmentCoreBreakdown(entry.breakdown, region)
        : normalizedBreakdown(entry),
    ),
  );

  return {
    template: getTemplate(profile.templateId),
    entries,
    estimate: buildEstimatePayloadFromEntries({
      estimateName,
      entries,
    }),
    breakdown,
    validation: {
      passed: true,
      hardFailures: [],
      parityDetails: [],
    },
  };
}

function buildDataServicesScenario({
  profile,
  template,
  region,
  targetMonthlyUsd,
  environmentSplit,
  estimateName,
  notes,
  operatingSystem,
  policy,
}) {
  const exactRegion = region;
  const selectedOperatingSystem = operatingSystem ?? template.computeOs;
  const weightedEnvironmentSplit = normalizeWeightedEnvironmentSplit(
    environmentSplit,
    policy.environmentScaleFactors,
  );
  const natService = getServiceDefinition("amazon-vpc-nat");
  const ec2Service = getServiceDefinition("amazon-ec2");
  const natPlan = buildNatPlan(template, exactRegion, targetMonthlyUsd, {
    sharedServicesMultiplier: policy.sharedServicesMultiplier,
    dataTransferMultiplier: policy.dataTransferMultiplier,
  });
  const remainingBudgetUsd = roundCurrency(targetMonthlyUsd - natPlan.monthlyUsd);

  if (remainingBudgetUsd <= 0) {
    throw new Error(
      `targetMonthlyUsd is too low for the minimum viable '${template.id}' baseline in ${exactRegion}. Minimum modeled spend is ${natPlan.monthlyUsd.toFixed(2)} USD/month.`,
    );
  }

  const weightedCoreServices = profile.requiredServiceIds
    .filter((serviceId) => serviceId !== "amazon-vpc-nat")
    .map((serviceId) => ({
      serviceId,
      weight: profile.coreBudgetWeights?.[serviceId] ?? template.coreBudgetWeights?.[serviceId] ?? 0,
    }))
    .filter((service) => service.weight > 0);

  const coreBudgets = allocateBudgetByWeights(remainingBudgetUsd, weightedCoreServices);
  const entries = [];

  for (const budget of coreBudgets) {
    if (budget.serviceId === "amazon-ec2") {
      const computePlan = buildComputePlan(
        exactRegion,
        selectedOperatingSystem,
        budget.monthlyBudgetUsd,
        weightedEnvironmentSplit,
      );

      for (const compute of computePlan.plans) {
        entries.push(
          ec2Service.buildEntry({
            environment: compute.environment,
            region: exactRegion,
            operatingSystem: selectedOperatingSystem,
            instanceType: compute.instanceType,
            instanceCount: compute.instanceCount,
            notes,
            pricingStrategy: ec2PricingStrategyForPolicy(policy),
          }),
        );
      }

      continue;
    }

    const definition = getServiceDefinition(budget.serviceId);

    if (typeof definition.buildEntry !== "function") {
      throw new Error(`Exact core service '${budget.serviceId}' is missing a buildEntry implementation.`);
    }

    entries.push(
      definition.buildEntry({
        region: exactRegion,
        monthlyBudgetUsd: budget.monthlyBudgetUsd,
        notes,
      }),
    );
  }

  entries.push(
    natService.buildEntry({
      region: exactRegion,
      natPlan,
      notes,
    }),
  );

  const breakdown = annotateBreakdowns(profile, entries.map((entry) =>
    entry.breakdown.kind === "eks" ||
    entry.breakdown.kind === "ec2Linux" ||
    entry.breakdown.kind === "ec2Windows" ||
    entry.breakdown.kind === "rdsPostgres" ||
    entry.breakdown.kind === "vpcNat"
      ? augmentCoreBreakdown(entry.breakdown, region)
      : normalizedBreakdown(entry),
  ));
  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: profile.templateId,
    expectedMonthlyUsd: totalEntryMonthlyUsd(entries),
    expectedRegion: region,
  });

  return {
    template,
    entries,
    estimate,
    breakdown,
    validation,
  };
}

function adjustedSharedServiceWeight(serviceId, weight, policy) {
  if (["amazon-s3", "aws-glue-data-catalog"].includes(serviceId)) {
    return weight * policy.storageCostFactor;
  }

  if (["amazon-athena", "amazon-redshift", "amazon-kinesis-firehose"].includes(serviceId)) {
    return weight * policy.dataTransferFactor;
  }

  if (["aws-glue-etl", "aws-glue-crawlers"].includes(serviceId)) {
    return weight * (1 - policy.computeDiscountPct / 100);
  }

  return weight;
}

function buildSharedServicesScenario({
  profile,
  template,
  region,
  targetMonthlyUsd,
  estimateName,
  notes,
  policy,
}) {
  const weightedCoreServices = profile.requiredServiceIds
    .map((serviceId) => ({
      serviceId,
      weight: adjustedSharedServiceWeight(
        serviceId,
        profile.coreBudgetWeights?.[serviceId] ?? template.coreBudgetWeights?.[serviceId] ?? 0,
        policy,
      ),
    }))
    .filter((service) => service.weight > 0);

  if (weightedCoreServices.length === 0) {
    throw new Error(`Template '${template.id}' is missing shared-service core budget weights.`);
  }

  const coreBudgets = allocateBudgetByWeights(targetMonthlyUsd, weightedCoreServices);
  const entries = coreBudgets.map((budget) => {
    const definition = getServiceDefinition(budget.serviceId);

    if (typeof definition.buildEntry !== "function") {
      throw new Error(
        `Exact shared core service '${budget.serviceId}' is missing a buildEntry implementation.`,
      );
    }

    return definition.buildEntry({
      region,
      monthlyBudgetUsd: budget.monthlyBudgetUsd,
      notes,
    });
  });
  const breakdown = annotateBreakdowns(
    profile,
    entries.map((entry) => normalizedBreakdown(entry)),
  );
  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: profile.templateId,
    expectedMonthlyUsd: totalEntryMonthlyUsd(entries),
    expectedRegion: region,
  });

  return {
    template,
    entries,
    estimate,
    breakdown,
    validation,
  };
}

function buildCoreScenario({
  profile,
  region,
  targetMonthlyUsd,
  environmentSplit,
  estimateName,
  notes,
  operatingSystem,
  policy,
}) {
  const template = getTemplate(profile.templateId);

  if (profile.coreStrategy === "weighted-services" || template.coreStrategy === "weighted-services") {
    return buildWeightedServicesScenario({
      profile,
      region,
      targetMonthlyUsd,
      estimateName,
      notes,
      operatingSystem,
      policy,
    });
  }

  if (template.coreStrategy === "data-services") {
    return buildDataServicesScenario({
      profile,
      template,
      region,
      targetMonthlyUsd,
      environmentSplit,
      estimateName,
      notes,
      operatingSystem,
      policy,
    });
  }

  if (template.coreStrategy === "shared-services") {
    return buildSharedServicesScenario({
      profile,
      template,
      region,
      targetMonthlyUsd,
      estimateName,
      notes,
      policy,
    });
  }

  const exactRegion = region;
  const selectedOperatingSystem = operatingSystem ?? template.computeOs;
  const weightedEnvironmentSplit = normalizeWeightedEnvironmentSplit(
    environmentSplit,
    policy.environmentScaleFactors,
  );
  const databasePricingModel = rdsPricingModelForPolicy(policy);
  const rdsTier = selectedRdsTier(targetMonthlyUsd);
  const policyAdjustedRdsEnvs = rdsTier.envs.map((database) => ({
    ...database,
    deploymentOption: deploymentOptionForPolicy(policy, database.environment, database.deploymentOption),
    storageGb: storageGbForPolicy(database.storageGb, policy),
  }));
  const natPlan = buildNatPlan(template, exactRegion, targetMonthlyUsd, {
    sharedServicesMultiplier: policy.sharedServicesMultiplier,
    dataTransferMultiplier: policy.dataTransferMultiplier,
  });
  const fixedEksMonthlyUsd = template.includeEks
    ? roundCurrency(ENVIRONMENTS.length * modelEksMonthlyUsd(exactRegion, 1))
    : 0;
  const fixedRdsMonthlyUsd = roundCurrency(
    policyAdjustedRdsEnvs.reduce(
      (sum, database) =>
        sum +
        modelRdsMonthlyUsd(
          exactRegion,
          database.instanceType,
          database.deploymentOption,
          database.storageGb,
        ) *
          rdsPricingModelMultiplier(databasePricingModel),
      0,
    ),
  );
  const minimumModeledSpendUsd = roundCurrency(
    fixedEksMonthlyUsd + fixedRdsMonthlyUsd + natPlan.monthlyUsd,
  );
  const targetComputeBudgetUsd = roundCurrency(targetMonthlyUsd - minimumModeledSpendUsd);

  if (targetComputeBudgetUsd <= 0) {
    throw new Error(
      `targetMonthlyUsd is too low for the minimum viable '${template.id}' baseline in ${exactRegion}. Minimum modeled spend is ${minimumModeledSpendUsd.toFixed(2)} USD/month.`,
    );
  }

  const computePlan = buildComputePlan(
    exactRegion,
    selectedOperatingSystem,
    targetComputeBudgetUsd,
    weightedEnvironmentSplit,
  );
  const eksService = getServiceDefinition("amazon-eks");
  const ec2Service = getServiceDefinition("amazon-ec2");
  const rdsService = getServiceDefinition("amazon-rds-postgresql");
  const natService = getServiceDefinition("amazon-vpc-nat");
  const entries = [];

  if (template.includeEks) {
    for (const environment of ENVIRONMENTS) {
      entries.push(
        eksService.buildEntry({
          environment,
          region: exactRegion,
          notes,
        }),
      );
    }
  }

  for (const compute of computePlan.plans) {
    entries.push(
      ec2Service.buildEntry({
        environment: compute.environment,
        region: exactRegion,
        operatingSystem: selectedOperatingSystem,
        instanceType: compute.instanceType,
        instanceCount: compute.instanceCount,
        notes,
        pricingStrategy: ec2PricingStrategyForPolicy(policy),
      }),
    );
  }

  for (const database of policyAdjustedRdsEnvs) {
    entries.push(
      rdsService.buildEntry({
        environment: database.environment,
        region: exactRegion,
        instanceType: database.instanceType,
        deploymentOption: database.deploymentOption,
        storageGb: database.storageGb,
        notes,
        pricingModel: databasePricingModel,
      }),
    );
  }

  entries.push(
    natService.buildEntry({
      region: exactRegion,
      natPlan,
      notes,
    }),
  );

  const breakdown = annotateBreakdowns(
    profile,
    entries.map((entry) => augmentCoreBreakdown(entry.breakdown, region)),
  );

  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: profile.templateId,
    expectedMonthlyUsd: targetMonthlyUsd,
    expectedRegion: region,
  });

  return {
    template,
    entries,
    estimate,
    breakdown,
    validation,
  };
}

function normalizeAddOnBudgets(targetMonthlyUsd, selectedServices, profile, policy) {
  const coreServiceIds = new Set(profile.requiredServiceIds);
  const budgetedServices = selectedServices.filter(
    (service) => service.capability.support !== "unavailable" && !coreServiceIds.has(service.serviceId),
  );
  const requested = budgetedServices.map((service) => ({
    serviceId: service.serviceId,
    ratio:
      (profile.addOnAllocations[service.serviceId] ?? 0.015) *
      policy.sharedServicesMultiplier *
      (["edge", "networking"].includes(service.category) ? policy.dataTransferMultiplier : 1),
  }));
  const totalRatio = requested.reduce((sum, item) => sum + item.ratio, 0);
  const maxRatio = 0.32;
  const normalizer = totalRatio > maxRatio ? maxRatio / totalRatio : 1;

  return requested.map((item) => ({
    serviceId: item.serviceId,
    monthlyBudgetUsd: roundCurrency(targetMonthlyUsd * item.ratio * normalizer),
  }));
}

function scenarioDeltaDrivers(policy) {
  return [
    `${policy.computeCommitment} compute (${policy.computeDiscountPct}% compute discount assumption)`,
    `${policy.databaseCommitment} database (${policy.databaseDiscountPct}% database discount assumption)`,
    `${policy.environmentSizing} with scale factors dev/staging/prod ${policy.environmentScaleFactors.dev}/${policy.environmentScaleFactors.staging}/${policy.environmentScaleFactors.prod}`,
    `${policy.haPosture} HA with prod Multi-AZ ${policy.prodMultiAz ? "enabled" : "disabled"} and non-prod Multi-AZ ${policy.nonProdMultiAz ? "enabled" : "disabled"}`,
    `${policy.storageStrategy} storage (${Math.round(policy.storageMultiplier * 100)}% storage multiplier)`,
    `${policy.sharedServicesProfile} shared services (${Math.round(policy.sharedServicesMultiplier * 100)}% overhead multiplier)`,
  ];
}

function parseMinimumBudgetUsd(errorMessage) {
  const match = String(errorMessage ?? "").match(/Minimum modeled spend is ([0-9]+(?:\.[0-9]+)?) USD/i);

  if (!match?.[1]) {
    return null;
  }

  return roundCurrency(Number(match[1]));
}

function scenarioBudgetFit(targetMonthlyUsd, modeledMonthlyUsd) {
  if (!Number.isFinite(targetMonthlyUsd) || targetMonthlyUsd <= 0) {
    return {
      status: "underspecified",
      deltaUsd: 0,
      details: "No target budget was supplied for scenario fit analysis.",
    };
  }

  const deltaUsd = roundCurrency(modeledMonthlyUsd - targetMonthlyUsd);
  const toleranceUsd = roundCurrency(targetMonthlyUsd * 0.05);

  if (Math.abs(deltaUsd) <= toleranceUsd) {
    return {
      status: "fits",
      deltaUsd,
      details: `Modeled monthly total ${modeledMonthlyUsd.toFixed(2)} USD is within ${toleranceUsd.toFixed(2)} USD of the target.`,
    };
  }

  return {
    status: deltaUsd > 0 ? "nearest_fit_above" : "nearest_fit_below",
    deltaUsd,
    details: `Modeled monthly total ${modeledMonthlyUsd.toFixed(2)} USD differs from the target by ${Math.abs(deltaUsd).toFixed(2)} USD.`,
  };
}

function comparisonSummaryFor(scenarios) {
  const baseline = scenarios.find((scenario) => scenario.id === "baseline") ?? scenarios[0];

  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    title: scenario.title,
    modeledMonthlyUsd: scenario.modeledMonthlyUsd,
    deltaVsBaselineUsd: roundCurrency(scenario.modeledMonthlyUsd - baseline.modeledMonthlyUsd),
    deltaVsBaselinePct:
      baseline.modeledMonthlyUsd > 0
        ? roundCurrency(
            ((scenario.modeledMonthlyUsd - baseline.modeledMonthlyUsd) /
              baseline.modeledMonthlyUsd) *
              100,
          )
        : 0,
    calculatorEligible: scenario.calculatorEligible,
  }));
}

function recommendedScenarioIdFor(scenarios) {
  const ranked = scenarios
    .map((scenario) => {
      const blockingFailures = scenario.validation.blockingFailures?.length ?? 0;
      const warningCount = scenario.validation.warningRules?.length ?? 0;
      const targetDrift = Math.abs(scenario.modeledMonthlyUsd - scenario.targetMonthlyUsd);
      const withinTargetTolerance = scenario.budgetFit?.status === "fits" ? 1 : 0;
      const score =
        (scenario.validation.passed ? 300 : 0) +
        (scenario.calculatorEligible ? 140 : 0) +
        withinTargetTolerance * 120 -
        targetDrift / 10 -
        blockingFailures * 80 -
        warningCount * 12 -
        scenario.modeledMonthlyUsd / 1000 +
        scenario.expectedSavingsPct * 0.25;

      return {
        scenarioId: scenario.id,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.scenarioId ?? null;
}

function compactValidationCheck(check) {
  return {
    ...check,
    evidence: check.evidence ?? null,
  };
}

const COMPACT_VALIDATION_CHECK_IDS = new Set([
  "architecture.required-blueprint-services",
  "funding.calculator-link-ready",
]);

function compactValidationChecks(checks) {
  return checks
    .filter(
      (check) =>
        check.status !== "pass" || COMPACT_VALIDATION_CHECK_IDS.has(check.id),
    )
    .map(compactValidationCheck);
}

function compactValidationPack(pack) {
  return {
    ...pack,
    checks: compactValidationChecks(pack.checks),
  };
}

function compactScenarioValidation(validation) {
  const packs = validation.packs
    .map(compactValidationPack)
    .filter((pack) => pack.failedRuleCount > 0 || pack.warningRuleCount > 0 || pack.checks.length > 0);

  return {
    ...validation,
    checks: compactValidationChecks(validation.checks),
    packs,
    parityDetails: [],
  };
}

function normalizeArchitectureForPricing(architecture) {
  const coverage = architecture?.serviceCoverage ?? {};

  return {
    ...architecture,
    patternId: architecture?.patternId ?? `${architecture?.blueprintId ?? "linux-web-stack"}.default`,
    fitGaps: architecture?.fitGaps ?? [],
    requiredUnpricedCapabilities: architecture?.requiredUnpricedCapabilities ?? [],
    blockers: architecture?.blockers ?? [],
    warnings: architecture?.warnings ?? [],
    assumptions: architecture?.assumptions ?? [],
    defaultScenarioPolicies: architecture?.defaultScenarioPolicies ?? [],
    selectedServices: architecture?.selectedServices ?? [],
    serviceSelectionMode:
      architecture?.serviceSelectionMode ??
      ((architecture?.selectedServices?.some((service) => service.source === "explicit") &&
      !architecture?.selectedServices?.some((service) => service.source === "blueprint-default"))
        ? "strict"
        : "augment"),
    regionMode: architecture?.regionMode ?? "single-region",
    serviceCoverage: {
      exact: coverage.exact ?? [],
      modeled: coverage.modeled ?? [],
      unavailable: coverage.unavailable ?? [],
    },
  };
}

export function designArchitecture({
  blueprintId,
  templateId,
  brief,
  targetMonthlyUsd,
  region,
  clientName,
  estimateName,
  notes,
  operatingSystem,
  environmentSplit,
  serviceIds,
  includeDefaultAddOns = true,
  serviceSelectionMode,
  scenarioPolicies,
} = {}) {
  const assumptions = [];
  const warnings = [];
  const blockers = [];
  const blockerDetails = [];
  const unresolvedQuestions = [];
  const suggestedNextActions = [];
  const normalizedBrief = normalizeBrief(brief);
  const hasBrief = normalizedBrief.length > 0;
  const normalizedOperatingSystem =
    operatingSystem && OPERATING_SYSTEMS.has(operatingSystem) ? operatingSystem : null;
  const hardConstraints = extractHardConstraints({
    brief: normalizedBrief,
    serviceIds: serviceIds ?? [],
    operatingSystem: normalizedOperatingSystem,
  });
  const architectureCandidates = buildArchitectureCandidates({
    blueprintId,
    templateId,
    brief: normalizedBrief,
    targetMonthlyUsd,
    operatingSystem: normalizedOperatingSystem,
    serviceIds,
    assumptions,
  });
  const selectedCandidate =
    selectedArchitectureCandidate(architectureCandidates) ??
    scoreArchitectureCandidate({
      blueprint: getBlueprint("linux-web-stack"),
      signals: {
        matched: [],
        operatingSystemHint: normalizedOperatingSystem,
        hasBrief,
        briefLower: normalizedBrief.toLowerCase(),
      },
      targetMonthlyUsd,
      serviceIds,
    });
  const alternativeCandidates = alternativeArchitectureCandidates(architectureCandidates);
  const resolvedBlueprintId = selectedCandidate.blueprintId;
  const blueprint = getBlueprint(resolvedBlueprintId);
  const operatingSystemInference = inferOperatingSystem({
    brief: normalizedBrief,
    explicitOperatingSystem: normalizedOperatingSystem,
    blueprint,
    assumptions,
  });
  const unsupportedDatabase = unsupportedDatabaseMention(normalizedBrief);

  if (unsupportedDatabase) {
    const message = `The brief references ${unsupportedDatabase}, but the current modeled engine still requires explicit support before pricing.`;
    blockers.push(message);
    blockerDetails.push(
      makeStructuredItem(
        "design.unsupported-database",
        "databaseEngine",
        message,
        "Switch to a supported engine such as PostgreSQL or add serializer/model coverage for the requested engine.",
        true,
      ),
    );
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.database-engine",
        "databaseEngine",
        `Should this estimate stay on ${unsupportedDatabase}, or can it be normalized to PostgreSQL for pricing and funding review?`,
        "Confirm the intended database engine before pricing.",
        true,
      ),
    );
  }

  const resolvedRegion = inferRegion(normalizedBrief, region, warnings, assumptions);
  const regionSource = region
    ? "explicit"
    : DESIGN_REGIONS.some((candidate) => normalizedBrief.toLowerCase().includes(candidate))
      ? "brief-inferred"
      : "default";

  if (!DESIGN_REGIONS.includes(resolvedRegion)) {
    const message = `Unsupported region '${resolvedRegion}'. Supported design regions: ${DESIGN_REGIONS.join(", ")}.`;
    blockers.push(message);
    blockerDetails.push(
      makeStructuredItem(
        "design.unsupported-region",
        "region",
        message,
        `Choose one of: ${DESIGN_REGIONS.join(", ")}.`,
        true,
      ),
    );
  }

  const resolvedTargetMonthlyUsd = inferTargetMonthlyUsd(
    normalizedBrief,
    targetMonthlyUsd,
    warnings,
    assumptions,
  );
  const targetSource = Number.isFinite(targetMonthlyUsd)
    ? "explicit"
    : resolvedTargetMonthlyUsd != null
      ? "brief-inferred"
      : "missing";

  if (resolvedTargetMonthlyUsd == null) {
    const message = "A positive targetMonthlyUsd is required or must be inferable from the brief.";
    blockers.push(message);
    blockerDetails.push(
      makeStructuredItem(
        "design.missing-target-monthly",
        "targetMonthlyUsd",
        message,
        "Provide targetMonthlyUsd or mention a clear monthly/MRR calculator target in the brief.",
        true,
      ),
    );
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.target-monthly",
        "targetMonthlyUsd",
        "What monthly spend target should the MCP optimize around for the estimate?",
        "Provide a positive monthly USD target.",
        true,
      ),
    );
  }

  const inferredEnvironmentSplit = inferEnvironmentSplitFromBrief(normalizedBrief, assumptions);
  const resolvedEnvironmentSplit = normalizeEnvironmentSplit(
    environmentSplit ?? inferredEnvironmentSplit ?? undefined,
  );
  const environmentSource = environmentSplit
    ? "explicit"
    : inferredEnvironmentSplit != null
      ? "brief-inferred"
      : "default";

  if (!environmentSplit) {
    assumptions.push(
      `Environment split resolved to ${(resolvedEnvironmentSplit.dev * 100).toFixed(0)}/${(
        resolvedEnvironmentSplit.staging * 100
      ).toFixed(0)}/${(resolvedEnvironmentSplit.prod * 100).toFixed(0)}.`,
    );
  }

  const resolvedClientName = clientName ?? null;
  const resolvedEstimateName = estimateName ?? estimateNameFor(resolvedClientName, blueprint.title);
  const hasExplicitServiceScope = (serviceIds?.length ?? 0) > 0;
  const resolvedServiceSelectionMode =
    serviceSelectionMode ?? (hasExplicitServiceScope ? "strict" : "augment");
  const patternCandidates = buildPatternCandidates({
    blueprint,
    brief: normalizedBrief,
    targetMonthlyUsd: resolvedTargetMonthlyUsd,
    serviceIds: serviceIds ?? [],
    hardConstraints,
  });
  const preferredPatternCandidate =
    blueprintId && !normalizedBrief
      ? patternCandidates.find((candidate) => !candidate.id.endsWith(".default"))
      : null;
  const selectedPatternCandidate =
    preferredPatternCandidate ??
    patternCandidates[0] ?? {
    id: `${blueprint.id}.default`,
    title: blueprint.title,
    budgetFit: selectedCandidate.budgetFit,
    fitScore: selectedCandidate.fitScore,
    requiredUnpricedCapabilities: [],
    traits: [],
    rationale: ["Default architecture pattern selected."],
  };
  const alternativePatternCandidates = patternCandidates.slice(1);
  const selectedPattern = materializePattern(blueprint, selectedPatternCandidate.id);
  const architectureProfile = resolveArchitectureProfile(blueprint, selectedPattern);
  const { fitGaps, excludedDefaults } = patternFitGaps(architectureProfile, hardConstraints);
  const selectedServices = buildSelectedServices({
    blueprint: architectureProfile,
    brief: normalizedBrief,
    serviceIds,
    region: resolvedRegion,
    includeDefaultAddOns,
    serviceSelectionMode: resolvedServiceSelectionMode,
  });
  const serviceCoverage = coverageFor(selectedServices);

  if (selectedPatternCandidate.budgetFit.status !== "fits") {
    warnings.push(selectedPatternCandidate.budgetFit.details);
  }

  if (
    alternativeCandidates.length > 0 &&
    selectedCandidate.fitScore - alternativeCandidates[0].fitScore <= 8
  ) {
    warnings.push(
      `Architecture inference is close between ${selectedCandidate.blueprintId} and ${alternativeCandidates[0].blueprintId}.`,
    );
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.architecture-shape",
        "blueprintId",
        `The brief could map to ${selectedCandidate.blueprintTitle} or ${alternativeCandidates[0].blueprintTitle}.`,
        "Confirm which architecture shape is intended before final pricing if the distinction matters.",
      ),
    );
  }

  if (!hasBrief && !blueprintId && !templateId && !hasExplicitServiceScope) {
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.architecture-intent",
        "brief",
        "No workload brief, blueprint, template, or explicit service scope was supplied.",
        "Describe the workload or pass blueprintId/serviceIds before pricing.",
        true,
      ),
    );
  }

  if (serviceCoverage.unavailable.length > 0) {
    const message = `Selected services are not implemented in ${resolvedRegion}: ${serviceCoverage.unavailable.join(", ")}.`;
    blockers.push(message);
    blockerDetails.push(
      makeStructuredItem(
        "design.unavailable-services",
        "serviceIds",
        message,
        "Remove the unavailable services, change region, or add modeled/exact support before pricing.",
        true,
      ),
    );
  }

  if (serviceCoverage.modeled.length > 0) {
    warnings.push(
      `Modeled-only services are present in ${resolvedRegion}: ${serviceCoverage.modeled.join(", ")}.`,
    );
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.exact-link-scope",
        "serviceCoverage",
        `Do you need an official calculator link for all selected services, or is modeled coverage acceptable for ${serviceCoverage.modeled.join(", ")}?`,
        "Reduce the service set to exact services if the immediate deliverable must be a calculator link.",
      ),
    );
  }

  if (fitGaps.length > 0) {
    warnings.push(...fitGaps);
  }

  if (architectureProfile.requiredUnpricedCapabilities.length > 0) {
    warnings.push(
      ...architectureProfile.requiredUnpricedCapabilities.map((capability) => capability.details),
    );
    suggestedNextActions.push(
      "Resolve or document the required-but-unpriced capability gaps before treating the response as a complete architecture.",
    );
  }

  if (regionSource === "default") {
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.region-confirmation",
        "region",
        `The region defaulted to ${resolvedRegion}. Should the estimate stay there?`,
        "Confirm the operating region before final pricing.",
        true,
      ),
    );
  }

  if (
    SECURITY_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalizedBrief)) &&
    !selectedServices.some((service) => service.serviceId === "aws-waf-v2")
  ) {
    warnings.push("The brief carries security/compliance signals but WAF is not currently selected.");
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.security-controls",
        "security",
        "Should the design include WAF or additional governance controls given the brief's security/compliance signals?",
        "Add aws-waf-v2 or document why edge security is handled elsewhere.",
      ),
    );
  }

  if (
    MODERNIZATION_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalizedBrief)) &&
    !selectedServices.some((service) =>
      ["amazon-ecs-fargate", "amazon-efs", "amazon-ebs"].includes(service.serviceId),
    )
  ) {
    suggestedNextActions.push(
      "Consider adding modernization services such as amazon-ecs-fargate, amazon-efs, amazon-ebs, or amazon-vpc-endpoints if the brief is migration-heavy.",
    );
  }

  if (serviceCoverage.modeled.length > 0) {
    suggestedNextActions.push(
      "Keep pricing in modeled mode for the full architecture, or scope the immediate calculator link to the exact-capable subset.",
    );
  }

  if (alternativeCandidates.length > 0) {
    suggestedNextActions.push(
      `Compare alternate architectures: ${alternativeCandidates.map((candidate) => candidate.blueprintId).join(", ")}.`,
    );
  }

  if (blockers.length === 0 && unresolvedQuestions.length === 0) {
    suggestedNextActions.push("Price the architecture and inspect baseline, optimized, and aggressive scenarios.");
  }

  const inference = {
    blueprint: {
      value: blueprint.id,
      source:
        blueprintId || templateId
          ? "explicit"
          : selectedCandidate.fitScore > 15
            ? "brief-inferred"
            : "default",
      confidence:
        blueprintId || templateId
          ? 1
          : clampNumber((selectedCandidate.fitScore + 20) / 100, 0.4, 0.92),
    },
    region: {
      value: resolvedRegion,
      source: regionSource,
      confidence: regionSource === "explicit" ? 1 : regionSource === "brief-inferred" ? 0.85 : 0.6,
    },
    targetMonthlyUsd: {
      value: resolvedTargetMonthlyUsd,
      source: targetSource,
      confidence: targetSource === "explicit" ? 1 : targetSource === "brief-inferred" ? 0.8 : 0,
    },
    operatingSystem: operatingSystemInference,
    environmentSplit: {
      value: resolvedEnvironmentSplit,
      source: environmentSource,
      confidence:
        environmentSource === "explicit" ? 1 : environmentSource === "brief-inferred" ? 0.75 : 0.6,
    },
    databaseEngine: {
      value: unsupportedDatabase ?? "PostgreSQL",
      source: unsupportedDatabase ? "brief-inferred" : "blueprint-default",
      confidence: unsupportedDatabase ? 0.7 : 0.65,
    },
  };
  const confidenceScore = clampNumber(
    Math.round(
      inference.blueprint.confidence * 22 +
        inference.region.confidence * 18 +
      inference.targetMonthlyUsd.confidence * 24 +
      inference.operatingSystem.confidence * 12 +
      inference.environmentSplit.confidence * 12 +
      inference.databaseEngine.confidence * 8 +
      Math.min(selectedCandidate.fitScore, 25) +
      14 -
      warnings.length * 5 -
      blockers.length * 15,
    ),
    0,
    100,
  );

  return {
    version: "4.0",
    architectureId: crypto.randomUUID(),
    readyToPrice: blockers.length === 0 && !unresolvedQuestions.some((question) => question.blocking),
    sourceType:
      blueprintId && hasBrief ? "hybrid" : blueprintId ? "blueprint" : hasBrief ? "brief" : "blueprint",
    briefSummary: briefPreview(brief),
    blueprintId: blueprint.id,
    blueprintTitle: blueprint.title,
    templateId: architectureProfile.templateId,
    environmentModel: architectureProfile.environmentModel,
    architectureFamily: blueprint.architectureFamily,
    architectureSubtype: blueprint.architectureSubtype,
    patternId: architectureProfile.patternId,
    patternTitle: architectureProfile.patternTitle,
    patternDescription: architectureProfile.patternDescription,
    recommendedPatternId: selectedPatternCandidate.id,
    recommendedArchitectureId: selectedCandidate.blueprintId,
    alternativeArchitectureIds: alternativeCandidates.map((candidate) => candidate.blueprintId),
    candidateArchitectures: architectureCandidates.map((candidate) => ({
      ...candidate,
    })),
    patternCandidates: patternCandidates.map((candidate) => ({
      ...candidate,
    })),
    alternativePatternIds: alternativePatternCandidates.map((candidate) => candidate.id),
    requiredCapabilities: [...(architectureProfile.requiredCapabilities ?? [])],
    budgetFit: { ...selectedPatternCandidate.budgetFit },
    packIds: [...(blueprint.packIds ?? [])],
    packs: blueprint.packs.map((pack) => ({ ...pack })),
    requiredServiceFamilies: [...(architectureProfile.requiredServiceFamilies ?? [])],
    clientName: resolvedClientName,
    estimateName: resolvedEstimateName,
    notes: notes ?? null,
    region: resolvedRegion,
    regionMode: "single-region",
    operatingSystem: operatingSystemInference.value,
    targetMonthlyUsd: resolvedTargetMonthlyUsd,
    environmentSplit: resolvedEnvironmentSplit,
    includeDefaultAddOns,
    serviceSelectionMode: resolvedServiceSelectionMode,
    selectedServices,
    serviceCoverage,
    hardConstraints,
    fitGaps,
    excludedDefaults,
    requiredUnpricedCapabilities: architectureProfile.requiredUnpricedCapabilities.map((capability) => ({
      ...capability,
    })),
    minimumPrimaryDominanceRatio: minimumPrimaryDominanceRatioFor(architectureProfile),
    defaultScenarioPolicies: normalizeScenarioPolicies(scenarioPolicies),
    blockers,
    blockerDetails,
    assumptions,
    warnings,
    unresolvedQuestions,
    suggestedNextActions,
    inference,
    confidence: {
      score: confidenceScore,
      level: confidenceDescriptor(confidenceScore),
    },
  };
}

export function priceArchitecture(input = {}) {
  const architecture = input?.architecture?.architectureId
    ? normalizeArchitectureForPricing(input.architecture)
    : designArchitecture(input);

  if (!architecture.readyToPrice || architecture.targetMonthlyUsd == null) {
    return {
      architecture,
      scenarios: [],
      comparisonSummary: [],
      recommendedScenarioId: null,
      blockers: architecture.blockers,
      warnings: architecture.warnings,
      assumptions: architecture.assumptions,
    };
  }

  const blueprint = getBlueprint(architecture.blueprintId);
  const selectedPattern = materializePattern(
    blueprint,
    architecture.patternId ?? `${blueprint.id}.default`,
  );
  const architectureProfile = resolveArchitectureProfile(blueprint, selectedPattern);
  const policies = normalizeScenarioPolicies(
    input.scenarioPolicies ?? architecture.defaultScenarioPolicies,
  );
  const scenarios = policies.map((policy) => {
    const targetMonthlyUsd = roundCurrency(architecture.targetMonthlyUsd * policy.coreBudgetFactor);
    const addOnBudgets = normalizeAddOnBudgets(
      targetMonthlyUsd,
      architecture.selectedServices,
      architectureProfile,
      policy,
    );
    const addOnResults = addOnBudgets.map((budget) => {
      const service = architecture.selectedServices.find(
        (candidate) => candidate.serviceId === budget.serviceId,
      );

      if (!service) {
        throw new Error(`Unable to find selected service '${budget.serviceId}'.`);
      }

      return priceSelectedService({
        service,
        region: architecture.region,
        monthlyBudgetUsd: budget.monthlyBudgetUsd,
        notes: architecture.notes,
      });
    });
    const addOnServiceBreakdown = addOnResults.map((result) => result.breakdown);
    const addOnTotal = roundCurrency(
      addOnServiceBreakdown.reduce((sum, service) => sum + service.monthlyUsd, 0),
    );
    const coreBudget = roundCurrency(targetMonthlyUsd - addOnTotal);
    const coverage = architecture.serviceCoverage;
    const exactPolicySupport = exactLinkSupportedFor(policy);
    const calculatorEligible =
      coverage.modeled.length === 0 &&
      coverage.unavailable.length === 0 &&
      exactPolicySupport &&
      architecture.requiredUnpricedCapabilities.length === 0 &&
      architecture.fitGaps.length === 0 &&
      coreBudget > 0;
    const calculatorBlockers = [];

    if (coverage.unavailable.length > 0) {
      calculatorBlockers.push(
        `Unavailable services in ${architecture.region}: ${coverage.unavailable.join(", ")}.`,
      );
    }

    if (coverage.modeled.length > 0) {
      calculatorBlockers.push(
        `Modeled-only services cannot mint an official calculator link yet: ${coverage.modeled.join(", ")}.`,
      );
    }

    if (!exactPolicySupport) {
      calculatorBlockers.push(
        `Scenario policy '${policy.id}' is modeled-only and cannot mint an official calculator link.`,
      );
    }

    if (architecture.requiredUnpricedCapabilities.length > 0) {
      calculatorBlockers.push(
        `Required capability gaps remain: ${architecture.requiredUnpricedCapabilities
          .map((capability) => capability.id)
          .join(", ")}.`,
      );
    }

    if (architecture.fitGaps.length > 0) {
      calculatorBlockers.push(architecture.fitGaps.join(" "));
    }

    let coreScenario = null;
    let coreBreakdown = [];
    let modeledMonthlyUsd = addOnTotal;
    let draftValidation = null;
    let budgetFitOverride = null;

    if (coreBudget > 0) {
      try {
        coreScenario = buildCoreScenario({
          profile: architectureProfile,
          region: architecture.region,
          targetMonthlyUsd: coreBudget,
          environmentSplit: architecture.environmentSplit,
          estimateName: scenarioEstimateName(architecture.estimateName, policy),
          notes: architecture.notes,
          operatingSystem: architecture.operatingSystem,
          policy,
        });
        coreBreakdown = coreScenario.breakdown;
        modeledMonthlyUsd = roundCurrency(addOnTotal + totalBreakdownMonthlyUsd(coreBreakdown));
        draftValidation = coreScenario.validation;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const minimumBudgetUsd = parseMinimumBudgetUsd(message);

        if (minimumBudgetUsd && minimumBudgetUsd > coreBudget) {
          coreScenario = buildCoreScenario({
            profile: architectureProfile,
            region: architecture.region,
            targetMonthlyUsd: minimumBudgetUsd,
            environmentSplit: architecture.environmentSplit,
            estimateName: scenarioEstimateName(architecture.estimateName, policy),
            notes: architecture.notes,
            operatingSystem: architecture.operatingSystem,
            policy,
          });
          coreBreakdown = coreScenario.breakdown;
          modeledMonthlyUsd = roundCurrency(addOnTotal + totalBreakdownMonthlyUsd(coreBreakdown));
          draftValidation = coreScenario.validation;
          budgetFitOverride = {
            status: "nearest_fit_above",
            deltaUsd: roundCurrency(modeledMonthlyUsd - targetMonthlyUsd),
            details: `Target ${targetMonthlyUsd.toFixed(2)} USD is below the minimum viable architecture shape. Sized the nearest valid scenario at ${modeledMonthlyUsd.toFixed(2)} USD.`,
          };
        } else {
          calculatorBlockers.push(message);
        }
      }
    } else {
      calculatorBlockers.push("Scenario leaves no remaining budget for the core services.");
    }

    const serviceBreakdown = annotateBreakdowns(architectureProfile, [
      ...coreBreakdown,
      ...addOnServiceBreakdown,
    ]);
    const exactAddOns = addOnResults
      .filter((result) => result.exact)
      .map((result) => ({
        serviceId: result.serviceId,
        monthlyBudgetUsd: result.monthlyBudgetUsd,
      }));
    const budgetFit = budgetFitOverride ?? scenarioBudgetFit(targetMonthlyUsd, modeledMonthlyUsd);
    const linkReady = Boolean(
      calculatorEligible && calculatorBlockers.length === 0 && coreScenario?.estimate,
    );
    const linkPlan =
      linkReady
        ? {
            blueprintId: architecture.blueprintId,
            patternId: architecture.patternId,
            scenarioId: policy.id,
            templateId: architectureProfile.templateId,
            targetMonthlyUsd: modeledMonthlyUsd,
            coreTargetMonthlyUsd: coreBudget,
            region: architecture.region,
            estimateName: scenarioEstimateName(architecture.estimateName, policy),
            notes: architecture.notes,
            environmentSplit: architecture.environmentSplit,
            operatingSystem: architecture.operatingSystem,
            scenarioPolicy: { ...policy },
            exactAddOns,
          }
        : null;
    const validation = compactScenarioValidation(
      validateArchitectureScenario({
        architecture,
        scenario: {
          id: policy.id,
          title: policy.title,
          targetMonthlyUsd,
          modeledMonthlyUsd,
          serviceBreakdown,
          coverage: {
            ...coverage,
            calculatorEligible: linkReady,
          },
          calculatorBlockers,
          budgetFit,
        },
        draftValidation,
      }),
    );

    return {
      id: policy.id,
      title: policy.title,
      referenceMonthlyUsd: architecture.targetMonthlyUsd,
      targetMonthlyUsd,
      modeledMonthlyUsd,
      expectedSavingsPct: policy.expectedSavingsPct,
      strategySummary: policy.strategySummary,
      deltaDrivers: scenarioDeltaDrivers(policy),
      scenarioPolicy: { ...policy },
      budgetFit,
      pricingConfidence:
        architecture.confidence.level === "low" ? "review-required" : "exact-or-modeled",
      serviceBreakdown,
      coverage: {
        ...coverage,
        calculatorEligible: linkReady,
      },
      calculatorEligible: linkReady,
      calculatorBlockers,
      linkPlan,
      validation,
      dominantServices: serviceBreakdown
        .slice()
        .sort((left, right) => right.monthlyUsd - left.monthlyUsd)
        .slice(0, 4)
        .map((service) => ({
          serviceId: service.serviceId,
          monthlyUsd: service.monthlyUsd,
        })),
    };
  });

  return {
    architecture,
    scenarios,
    comparisonSummary: comparisonSummaryFor(scenarios),
    recommendedScenarioId: recommendedScenarioIdFor(scenarios),
    blockers: architecture.blockers,
    warnings: architecture.warnings,
    assumptions: architecture.assumptions,
  };
}

export function buildExactEstimateFromLinkPlan(linkPlan) {
  const blueprint = getBlueprint(linkPlan.blueprintId);
  const selectedPattern = materializePattern(
    blueprint,
    linkPlan.patternId ?? `${blueprint.id}.default`,
  );
  const architectureProfile = resolveArchitectureProfile(blueprint, selectedPattern);
  const built = buildCoreScenario({
    profile: architectureProfile,
    region: linkPlan.region,
    targetMonthlyUsd: linkPlan.coreTargetMonthlyUsd ?? linkPlan.targetMonthlyUsd,
    environmentSplit: linkPlan.environmentSplit,
    estimateName: linkPlan.estimateName,
    notes: linkPlan.notes,
    operatingSystem: linkPlan.operatingSystem,
    policy: linkPlan.scenarioPolicy,
  });

  if (!built.estimate) {
    throw new Error(`Exact estimate generation is not available for region '${linkPlan.region}'.`);
  }

  const addOnEntries = (linkPlan.exactAddOns ?? []).map((addOn) => {
    const definition = getServiceDefinition(addOn.serviceId);
    const priced = priceSelectedService({
      service: {
        serviceId: addOn.serviceId,
        category: definition.category,
        required: false,
        capability: getServiceRegionCapability(addOn.serviceId, linkPlan.region),
      },
      region: linkPlan.region,
      monthlyBudgetUsd: addOn.monthlyBudgetUsd,
      notes: linkPlan.notes,
    });

    if (!priced.entry) {
      throw new Error(`Exact add-on '${addOn.serviceId}' is missing a buildEntry implementation.`);
    }

    return priced.entry;
  });
  const entries = [...built.entries, ...addOnEntries];
  const estimate = buildEstimatePayloadFromEntries({
    estimateName: linkPlan.estimateName,
    entries,
  });
  const breakdown = annotateBreakdowns(
    architectureProfile,
    [...built.breakdown, ...addOnEntries.map((entry) => normalizedBreakdown(entry))],
  );
  const validation = validateEstimatePayload({
    estimate,
    templateId: architectureProfile.templateId,
    expectedMonthlyUsd: linkPlan.targetMonthlyUsd,
    expectedRegion: linkPlan.region,
  });

  return {
    ...built,
    entries,
    estimate,
    breakdown,
    validation,
  };
}
