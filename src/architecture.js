import crypto from "node:crypto";

import {
  DEFAULT_REGION,
  DESIGN_REGIONS,
  getBlueprint,
  getServiceDefinition,
  getServiceRegionCapability,
  getTemplate,
  listServiceCatalog,
  resolveBlueprintIdForTemplate,
  supportedBlueprintIds,
} from "./catalog.js";
import {
  ENVIRONMENTS,
  buildComputePlan,
  buildEstimatePayloadFromEntries,
  buildNatPlan,
  modelRdsMonthlyUsd,
  normalizeEnvironmentSplit,
  modelEksMonthlyUsd,
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
function normalizeBrief(brief) {
  return String(brief ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

function inferClientNameFromBrief(brief, assumptions) {
  if (!brief) {
    return null;
  }

  const numberedLead = brief.match(/^\s*\d+\s*-\s*([A-Za-z0-9 .&'-]+?)\s*-\s*https?:\/\//m);

  if (!numberedLead?.[1]) {
    return null;
  }

  const clientName = numberedLead[1].trim();
  assumptions.push(`Client name was inferred from the brief as '${clientName}'.`);
  return clientName;
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
    .filter((service) => service.keywords.some((keyword) => lower.includes(keyword)))
    .map((service) => service.id);
}

function buildSelectedServices({
  blueprint,
  brief,
  serviceIds,
  region,
  includeDefaultAddOns = true,
}) {
  const explicitServiceIds = new Set(serviceIds ?? []);
  const inferredServiceIds = new Set(additionalServiceIdsFromBrief(brief));
  const selections = [];
  const seen = new Set();
  const pushService = (serviceId, selectionSource, required) => {
    if (seen.has(serviceId)) {
      return;
    }

    seen.add(serviceId);
    const definition = getServiceDefinition(serviceId);
    const capability = getServiceRegionCapability(serviceId, region);
    selections.push({
      serviceId,
      serviceName: definition.name,
      category: definition.category,
      implementationStatus: definition.implementationStatus,
      required,
      source: selectionSource,
      capability,
    });
  };

  for (const serviceId of blueprint.requiredServiceIds) {
    pushService(serviceId, "blueprint-required", true);
  }

  if (includeDefaultAddOns) {
    for (const serviceId of blueprint.defaultAddOnServiceIds) {
      pushService(serviceId, "blueprint-default", false);
    }
  }

  for (const serviceId of blueprint.optionalServiceIds) {
    if (explicitServiceIds.has(serviceId) || inferredServiceIds.has(serviceId)) {
      pushService(serviceId, explicitServiceIds.has(serviceId) ? "explicit" : "brief-inferred", false);
    }
  }

  for (const serviceId of explicitServiceIds) {
    pushService(serviceId, "explicit", false);
  }

  for (const serviceId of inferredServiceIds) {
    pushService(serviceId, "brief-inferred", false);
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

function totalBreakdownMonthlyUsd(breakdowns) {
  return roundCurrency(breakdowns.reduce((sum, service) => sum + service.monthlyUsd, 0));
}

function totalEntryMonthlyUsd(entries) {
  return roundCurrency(entries.reduce((sum, entry) => sum + entry.breakdown.monthlyUsd, 0));
}

function normalizedBreakdown(entry) {
  return {
    ...entry.breakdown,
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

function buildDataServicesScenario({
  blueprint,
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

  const weightedCoreServices = blueprint.requiredServiceIds
    .filter((serviceId) => serviceId !== "amazon-vpc-nat")
    .map((serviceId) => ({
      serviceId,
      weight: template.coreBudgetWeights?.[serviceId] ?? 0,
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

  const breakdown = entries.map((entry) =>
    entry.breakdown.kind === "eks" ||
    entry.breakdown.kind === "ec2Linux" ||
    entry.breakdown.kind === "ec2Windows" ||
    entry.breakdown.kind === "rdsPostgres" ||
    entry.breakdown.kind === "vpcNat"
      ? augmentCoreBreakdown(entry.breakdown, region)
      : normalizedBreakdown(entry),
  );
  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: blueprint.templateId,
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
  blueprint,
  template,
  region,
  targetMonthlyUsd,
  estimateName,
  notes,
  policy,
}) {
  const weightedCoreServices = blueprint.requiredServiceIds
    .map((serviceId) => ({
      serviceId,
      weight: adjustedSharedServiceWeight(
        serviceId,
        template.coreBudgetWeights?.[serviceId] ?? 0,
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
  const breakdown = entries.map((entry) => normalizedBreakdown(entry));
  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: blueprint.templateId,
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
  blueprint,
  region,
  targetMonthlyUsd,
  environmentSplit,
  estimateName,
  notes,
  operatingSystem,
  policy,
}) {
  const template = getTemplate(blueprint.templateId);

  if (template.coreStrategy === "data-services") {
    return buildDataServicesScenario({
      blueprint,
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
      blueprint,
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

  const breakdown = entries.map((entry) => augmentCoreBreakdown(entry.breakdown, region));

  const estimate = buildEstimatePayloadFromEntries({
    estimateName,
    entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: blueprint.templateId,
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

function normalizeAddOnBudgets(targetMonthlyUsd, selectedServices, blueprint, policy) {
  const templateBlueprint = getBlueprint(resolveBlueprintIdForTemplate(blueprint.templateId));
  const coreServiceIds = new Set(templateBlueprint.requiredServiceIds);
  const budgetedServices = selectedServices.filter(
    (service) => service.capability.support !== "unavailable" && !coreServiceIds.has(service.serviceId),
  );
  const requested = budgetedServices.map((service) => ({
    serviceId: service.serviceId,
    ratio:
      (blueprint.addOnAllocations[service.serviceId] ?? 0.015) *
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
      const score =
        (scenario.validation.passed ? 120 : 0) +
        (scenario.calculatorEligible ? 25 : 0) +
        scenario.expectedSavingsPct * 1.5 -
        blockingFailures * 60 -
        warningCount * 8 -
        targetDrift / 50;

      return {
        scenarioId: scenario.id,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.scenarioId ?? null;
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
  const resolvedBlueprintId = inferBlueprintId({
    templateId,
    blueprintId,
    brief: normalizedBrief,
    operatingSystem: normalizedOperatingSystem,
    assumptions,
  });
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

  const resolvedEnvironmentSplit = normalizeEnvironmentSplit(
    environmentSplit ?? inferEnvironmentSplitFromBrief(normalizedBrief, assumptions) ?? undefined,
  );
  const environmentSource = environmentSplit
    ? "explicit"
    : inferEnvironmentSplitFromBrief(normalizedBrief, []) != null
      ? "brief-inferred"
      : "default";

  if (!environmentSplit) {
    assumptions.push(
      `Environment split resolved to ${(resolvedEnvironmentSplit.dev * 100).toFixed(0)}/${(
        resolvedEnvironmentSplit.staging * 100
      ).toFixed(0)}/${(resolvedEnvironmentSplit.prod * 100).toFixed(0)}.`,
    );
  }

  const resolvedClientName = clientName ?? inferClientNameFromBrief(brief, assumptions) ?? null;
  const resolvedEstimateName = estimateName ?? estimateNameFor(resolvedClientName, blueprint.title);
  const selectedServices = buildSelectedServices({
    blueprint,
    brief: normalizedBrief,
    serviceIds,
    region: resolvedRegion,
    includeDefaultAddOns,
  });
  const serviceCoverage = coverageFor(selectedServices);

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

  if (regionSource === "default") {
    unresolvedQuestions.push(
      makeStructuredItem(
        "question.region-confirmation",
        "region",
        `The region defaulted to ${resolvedRegion}. Should the estimate stay there?`,
        "Confirm the operating region before final pricing.",
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

  if (blockers.length === 0 && unresolvedQuestions.length === 0) {
    suggestedNextActions.push("Price the architecture and inspect baseline, optimized, and aggressive scenarios.");
  }

  const inference = {
    blueprint: {
      value: blueprint.id,
      source:
        blueprintId || templateId ? "explicit" : hasBrief ? "brief-inferred" : "default",
      confidence: blueprintId || templateId ? 1 : hasBrief ? 0.8 : 0.65,
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
    templateId: blueprint.templateId,
    packIds: [...(blueprint.packIds ?? [])],
    packs: blueprint.packs.map((pack) => ({ ...pack })),
    requiredServiceFamilies: [...(blueprint.requiredServiceFamilies ?? [])],
    clientName: resolvedClientName,
    estimateName: resolvedEstimateName,
    notes: notes ?? null,
    region: resolvedRegion,
    operatingSystem: operatingSystemInference.value,
    targetMonthlyUsd: resolvedTargetMonthlyUsd,
    environmentSplit: resolvedEnvironmentSplit,
    includeDefaultAddOns,
    selectedServices,
    serviceCoverage,
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
  const architecture = input?.architecture?.architectureId ? input.architecture : designArchitecture(input);

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
  const policies = normalizeScenarioPolicies(
    input.scenarioPolicies ?? architecture.defaultScenarioPolicies,
  );
  const scenarios = policies.map((policy) => {
    const targetMonthlyUsd = roundCurrency(architecture.targetMonthlyUsd * policy.coreBudgetFactor);
    const addOnBudgets = normalizeAddOnBudgets(
      targetMonthlyUsd,
      architecture.selectedServices,
      blueprint,
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

    let coreScenario = null;
    let coreBreakdown = [];
    let modeledMonthlyUsd = addOnTotal;
    let draftValidation = null;

    if (coreBudget > 0) {
      try {
        coreScenario = buildCoreScenario({
          blueprint,
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
        calculatorBlockers.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      calculatorBlockers.push("Scenario leaves no remaining budget for the core services.");
    }

    const serviceBreakdown = [...coreBreakdown, ...addOnServiceBreakdown];
    const exactAddOns = addOnResults
      .filter((result) => result.exact)
      .map((result) => ({
        serviceId: result.serviceId,
        monthlyBudgetUsd: result.monthlyBudgetUsd,
      }));
    const linkPlan =
      calculatorEligible && coreScenario?.estimate
        ? {
            blueprintId: architecture.blueprintId,
            scenarioId: policy.id,
            templateId: blueprint.templateId,
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
    const validation = validateArchitectureScenario({
      architecture,
      scenario: {
        id: policy.id,
        title: policy.title,
        targetMonthlyUsd,
        modeledMonthlyUsd,
        serviceBreakdown,
        coverage: {
          ...coverage,
          calculatorEligible,
        },
        calculatorBlockers,
      },
      draftValidation,
    });

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
      pricingConfidence:
        architecture.confidence.level === "low" ? "review-required" : "exact-or-modeled",
      serviceBreakdown,
      coverage: {
        ...coverage,
        calculatorEligible,
      },
      calculatorEligible,
      calculatorBlockers,
      linkPlan,
      validation,
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
  const built = buildCoreScenario({
    blueprint,
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

    if (typeof definition.buildEntry !== "function") {
      throw new Error(`Exact add-on '${addOn.serviceId}' is missing a buildEntry implementation.`);
    }

    return definition.buildEntry({
      region: linkPlan.region,
      monthlyBudgetUsd: addOn.monthlyBudgetUsd,
      notes: linkPlan.notes,
    });
  });
  const entries = [...built.entries, ...addOnEntries];
  const estimate = buildEstimatePayloadFromEntries({
    estimateName: linkPlan.estimateName,
    entries,
  });
  const breakdown = [...built.breakdown, ...addOnEntries.map((entry) => entry.breakdown)];
  const validation = validateEstimatePayload({
    estimate,
    templateId: blueprint.templateId,
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
