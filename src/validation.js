import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  DEFAULT_REGION,
  getArchitecturePattern,
  getBlueprint,
  getTemplate,
  listArchitecturePatterns,
  resolveBlueprintIdForTemplate,
  supportedBlueprintIds,
} from "./catalog.js";
import {
  findServiceDefinitionByCalculatorServiceCode,
  resolveServiceDefinitionForSavedService,
} from "./services/index.js";
import {
  ENVIRONMENTS,
  parseEnvironmentTag,
  percent,
  regionsFor,
  roundCurrency,
  serviceCodesFor,
  serviceEntries,
  serviceMonthlyUsd,
} from "./model.js";

const VALIDATION_SCHEMA_VERSION = "4.0";
const PACK_METADATA = {
  "pricing-integrity": {
    title: "Pricing Integrity",
  },
  "architecture-completeness": {
    title: "Architecture Completeness",
  },
  "funding-readiness": {
    title: "Funding Readiness",
  },
  "platform-governance": {
    title: "Platform Governance",
  },
};
const DEFAULT_PACK_ORDER = Object.keys(PACK_METADATA);
const ROUNDING_TOLERANCE_USD = 0.02;
const EDGE_SERVICE_CODES = new Set([
  "amazonCloudFront",
  "amazonApiGateway",
  "amazonELB",
  "amazonRoute53",
]);
const EDGE_SERVICE_IDS = new Set([
  "amazon-cloudfront",
  "amazon-api-gateway-http",
  "application-load-balancer",
  "network-load-balancer",
  "amazon-route53",
]);
const PREMIUM_SERVICE_IDS = new Set([
  "amazon-rds-sqlserver",
  "amazon-aurora-postgresql",
  "amazon-aurora-mysql",
  "amazon-opensearch",
  "amazon-fsx-windows",
]);
const SERVICE_CODE_ALIAS_TO_ID = new Map([
  ["amazonApiGateway", "amazon-api-gateway-http"],
  ["amazonAthena", "amazon-athena"],
  ["amazonAuroraMySQLCompatible", "amazon-aurora-mysql"],
  ["amazonCloudFront", "amazon-cloudfront"],
  ["amazonCloudWatch", "amazon-cloudwatch"],
  ["amazonDynamoDB", "amazon-dynamodb"],
  ["amazonEFS", "amazon-efs"],
  ["amazonELB", "application-load-balancer"],
  ["amazonElasticBlockStore", "amazon-ebs"],
  ["amazonElasticsearchService", "amazon-opensearch"],
  ["amazonEventBridge", "amazon-eventbridge"],
  ["amazonFSx", "amazon-fsx-windows"],
  ["amazonFSxWindowsFileServer", "amazon-fsx-windows"],
  ["amazonKinesisFirehose", "amazon-kinesis-firehose"],
  ["amazonLambda", "amazon-lambda"],
  ["amazonNLB", "network-load-balancer"],
  ["amazonRDSAuroraPostgreSQLCompatibleDB", "amazon-aurora-postgresql"],
  ["amazonRDSForSQLServer", "amazon-rds-sqlserver"],
  ["amazonRDSMySQLDB", "amazon-rds-mysql"],
  ["amazonRDSPostgreSQLDB", "amazon-rds-postgresql"],
  ["amazonRedshift", "amazon-redshift"],
  ["amazonRoute53", "amazon-route53"],
  ["amazonS3", "amazon-s3"],
  ["amazonSimpleQueueService", "amazon-sqs"],
  ["amazonVirtualPrivateCloud", "amazon-vpc-nat"],
  ["aWSLambda", "amazon-lambda"],
  ["awsEks", "amazon-eks"],
  ["awsEtlJobsAndDevelopmentEndpoints", "aws-glue-etl"],
  ["awsFargate", "amazon-ecs-fargate"],
  ["awsGlueCrawlers", "aws-glue-crawlers"],
  ["awsGlueDataCatalogStorageRequests", "aws-glue-data-catalog"],
  ["awsPrivateLinkVpc", "amazon-vpc-endpoints"],
  ["awsWAFv2", "aws-waf-v2"],
  ["awsWebApplicationFirewall", "aws-waf-v2"],
  ["dynamoDbOnDemand", "amazon-dynamodb"],
  ["ec2Enhancement", "amazon-ec2"],
  ["networkLoadBalancer", "network-load-balancer"],
  ["standardTopics", "amazon-sns"],
]);
const REGION_JUSTIFICATION_SIGNAL =
  /(regulat|residency|sovereign|compliance|latency|country|local|regional|brazil|sao paulo)/i;
const PREMIUM_JUSTIFICATION_SIGNAL =
  /(license|migration|moderni|managed|search|sql server|aurora|windows|performance|operational|availability)/i;

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalServiceIdForServiceCode(serviceCode) {
  return (
    findServiceDefinitionByCalculatorServiceCode(serviceCode)?.id ??
    SERVICE_CODE_ALIAS_TO_ID.get(serviceCode) ??
    null
  );
}

function serviceIdsForServiceCodes(serviceCodes = []) {
  return dedupe(serviceCodes.map((serviceCode) => canonicalServiceIdForServiceCode(serviceCode)));
}

function blueprintIdForPattern(patternId) {
  for (const blueprintId of supportedBlueprintIds()) {
    if (listArchitecturePatterns(blueprintId).some((pattern) => pattern.id === patternId)) {
      return blueprintId;
    }
  }

  return null;
}

function patternForTemplate(blueprintId, templateId) {
  if (!blueprintId || !templateId) {
    return null;
  }

  const patterns = listArchitecturePatterns(blueprintId).filter(
    (pattern) => pattern.templateId === templateId,
  );

  if (patterns.length !== 1) {
    return null;
  }

  return getArchitecturePattern(blueprintId, patterns[0].id);
}

function scorePatternCandidate(pattern, savedServiceIds, savedServiceFamilies) {
  const blueprint = getBlueprint(pattern.blueprintId);
  const template = pattern.templateId ? getTemplate(pattern.templateId) : null;
  const requiredServiceIds = pattern.requiredServiceIds ?? [];
  const requiredServiceFamilies = pattern.requiredServiceFamilies ?? [];
  const relatedServiceIds = new Set([
    ...requiredServiceIds,
    ...(pattern.primaryServiceIds ?? []),
    ...(pattern.defaultAddOnServiceIds ?? []),
    ...(pattern.optionalServiceIds ?? []),
  ]);
  const presentRequiredIds = requiredServiceIds.filter((serviceId) => savedServiceIds.has(serviceId));
  const missingRequiredIds = requiredServiceIds.filter((serviceId) => !savedServiceIds.has(serviceId));
  const presentRequiredFamilies = requiredServiceFamilies.filter((family) =>
    savedServiceFamilies.has(family),
  );
  const missingRequiredFamilies = requiredServiceFamilies.filter(
    (family) => !savedServiceFamilies.has(family),
  );
  const matchedRelatedIds = [...savedServiceIds].filter((serviceId) =>
    relatedServiceIds.has(serviceId),
  );
  const unmatchedServiceIds = [...savedServiceIds].filter(
    (serviceId) => !relatedServiceIds.has(serviceId),
  );

  return {
    score:
      presentRequiredIds.length * 30 -
      missingRequiredIds.length * 18 +
      presentRequiredFamilies.length * 14 -
      missingRequiredFamilies.length * 8 +
      matchedRelatedIds.length * 8 -
      Math.min(unmatchedServiceIds.length, 4) * 3,
    presentRequiredIds,
    missingRequiredIds,
    presentRequiredFamilies,
    missingRequiredFamilies,
    expectedComputeOs:
      pattern.defaultOperatingSystem ?? template?.computeOs ?? blueprint.defaultOperatingSystem,
  };
}

function inferPatternContext(services, savedDefinitions) {
  const savedServiceIds = new Set(dedupe(savedDefinitions.map((definition) => definition.id)));
  const savedServiceFamilies = new Set(
    dedupe(savedDefinitions.map((definition) => definition.category)),
  );
  const savedOperatingSystems = dedupe(
    serviceEntries(services)
      .filter((service) => service.serviceCode === "ec2Enhancement")
      .map((service) => service?.calculationComponents?.selectedOS?.value),
  );

  if (savedServiceIds.size === 0) {
    return null;
  }

  const candidates = [];

  for (const blueprintId of supportedBlueprintIds()) {
    for (const pattern of listArchitecturePatterns(blueprintId)) {
      const candidate = scorePatternCandidate(pattern, savedServiceIds, savedServiceFamilies);

      if (savedOperatingSystems.length === 1 && candidate.expectedComputeOs) {
        candidate.score +=
          candidate.expectedComputeOs === savedOperatingSystems[0]
            ? 18
            : -20;
      }

      candidates.push({
        blueprintId,
        pattern,
        ...candidate,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.missingRequiredIds.length - right.missingRequiredIds.length ||
      right.presentRequiredIds.length - left.presentRequiredIds.length ||
      right.presentRequiredFamilies.length - left.presentRequiredFamilies.length,
  );

  const best = candidates[0];
  const runnerUp = candidates[1];

  if (!best || best.score <= 0) {
    return null;
  }

  const confidenceGap = best.score - (runnerUp?.score ?? 0);
  const confidence =
    best.missingRequiredIds.length === 0 && confidenceGap >= 12
      ? "high"
      : best.presentRequiredIds.length > 0 && confidenceGap >= 6
        ? "medium"
        : "low";
  const blueprint = getBlueprint(best.blueprintId);
  const pattern = getArchitecturePattern(best.blueprintId, best.pattern.id);

  return {
    blueprint,
    pattern,
    template: getTemplate(pattern.templateId ?? blueprint.templateId),
    confidence,
  };
}

function resolveValidationContext({
  services,
  templateId,
  blueprintId,
  patternId,
  validationMode,
  contextSource,
}) {
  const savedDefinitions = serviceDefinitionsForSavedEstimate(services);
  const explicitPatternBlueprintId = patternId ? blueprintIdForPattern(patternId) : null;
  const resolvedBlueprintId =
    blueprintId ??
    explicitPatternBlueprintId ??
    (templateId ? resolveBlueprintIdForTemplate(templateId) : null);
  const resolvedPattern =
    patternId && resolvedBlueprintId
      ? getArchitecturePattern(resolvedBlueprintId, patternId)
      : patternForTemplate(resolvedBlueprintId, templateId);
  const resolvedTemplate =
    resolvedPattern != null
      ? getTemplate(resolvedPattern.templateId ?? getBlueprint(resolvedBlueprintId).templateId)
      : templateId
        ? getTemplate(templateId)
        : resolvedBlueprintId
          ? getTemplate(getBlueprint(resolvedBlueprintId).templateId)
          : null;
  const resolvedBlueprint = resolvedBlueprintId ? getBlueprint(resolvedBlueprintId) : null;
  const resolvedContextSource =
    contextSource ??
    (templateId || blueprintId || patternId ? "explicit" : null);

  if (resolvedContextSource) {
    return {
      savedDefinitions,
      validationMode:
        validationMode ??
        (resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
          ? "intent-aware"
          : "generic"),
      contextSource: resolvedContextSource,
      blueprint: resolvedBlueprint,
      pattern: resolvedPattern,
      template: resolvedTemplate,
      bestMatch: null,
    };
  }

  const inferredPatternContext = inferPatternContext(services, savedDefinitions);
  const fallbackTemplateId = inferTemplateIdFromServices(services);
  const fallbackTemplate = fallbackTemplateId ? getTemplate(fallbackTemplateId) : null;
  const fallbackBlueprint = fallbackTemplate
    ? getBlueprint(resolveBlueprintIdForTemplate(fallbackTemplate.id))
    : null;
  const fallbackPattern = fallbackBlueprint
    ? patternForTemplate(fallbackBlueprint.id, fallbackTemplate.id)
    : null;
  const bestMatch = inferredPatternContext ?? (
    fallbackTemplate && fallbackBlueprint
      ? {
          blueprint: fallbackBlueprint,
          pattern: fallbackPattern,
          template: fallbackTemplate,
          confidence: "low",
        }
      : null
  );

  return {
    savedDefinitions,
    validationMode: validationMode ?? "generic",
    contextSource: bestMatch ? "inferred" : "none",
    blueprint: bestMatch?.blueprint ?? null,
    pattern: bestMatch?.pattern ?? null,
    template: bestMatch?.template ?? null,
    bestMatch,
  };
}

function inferTemplateIdFromServices(services) {
  const serviceCodes = serviceCodesFor(services);

  if (
    serviceCodes.includes("amazonKinesisFirehose") &&
    serviceCodes.includes("amazonS3") &&
    serviceCodes.includes("awsGlueDataCatalogStorageRequests")
  ) {
    return "streaming-data-platform-standard";
  }

  if (
    serviceCodes.includes("amazonRedshift") &&
    serviceCodes.includes("amazonAthena") &&
    serviceCodes.includes("amazonS3")
  ) {
    return "lakehouse-platform-standard";
  }

  if (
    serviceCodes.includes("amazonRedshift") &&
    serviceCodes.includes("amazonS3") &&
    serviceCodes.includes("awsGlueDataCatalogStorageRequests")
  ) {
    return "warehouse-centric-analytics-standard";
  }

  if (
    serviceCodes.includes("amazonAthena") &&
    serviceCodes.includes("awsGlueDataCatalogStorageRequests") &&
    serviceCodes.includes("awsGlueCrawlers")
  ) {
    return "lake-foundation-standard";
  }

  if (
    serviceCodes.includes("amazonAthena") ||
    serviceCodes.includes("amazonRedshift") ||
    serviceCodes.includes("awsEtlJobsAndDevelopmentEndpoints") ||
    serviceCodes.includes("awsGlueDataCatalogStorageRequests") ||
    serviceCodes.includes("awsGlueCrawlers")
  ) {
    return "enterprise-data-lake-standard";
  }

  if (
    serviceCodes.includes("amazonRDSAuroraPostgreSQLCompatibleDB") &&
    serviceCodes.includes("amazonS3")
  ) {
    if (
      serviceCodes.includes("amazonElasticsearchService") ||
      serviceCodes.includes("awsPrivateLinkVpc")
    ) {
      return "enterprise-data-standard";
    }

    return "data-platform-standard";
  }

  if (serviceCodes.includes("awsEks")) {
    return "eks-rds-standard";
  }

  const hasWindowsEc2 = serviceEntries(services)
    .filter((service) => service.serviceCode === "ec2Enhancement")
    .some((service) => service?.calculationComponents?.selectedOS?.value === "windows");

  return hasWindowsEc2 ? "windows-heavy" : "linux-heavy";
}

function modeledServiceMonthlyUsd(service) {
  const definition = resolveServiceDefinitionForSavedService(service);

  try {
    if (!definition?.modelSavedMonthlyUsd) {
      return {
        supported: false,
        serviceId: definition?.id ?? null,
        monthlyUsd: serviceMonthlyUsd(service),
      };
    }

    return {
      supported: true,
      serviceId: definition.id,
      monthlyUsd: roundCurrency(definition.modelSavedMonthlyUsd(service)),
    };
  } catch (error) {
    return {
      supported: false,
      serviceId: definition?.id ?? null,
      monthlyUsd: serviceMonthlyUsd(service),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeModeling(services) {
  const parityDetails = serviceEntries(services).map((service) => {
    const modeled = modeledServiceMonthlyUsd(service);

    return {
      serviceId: modeled.serviceId,
      serviceCode: service.serviceCode,
      region: service.region,
      storedMonthlyUsd: serviceMonthlyUsd(service),
      modeledMonthlyUsd: modeled.monthlyUsd,
      deltaUsd: roundCurrency(serviceMonthlyUsd(service) - modeled.monthlyUsd),
      supported: modeled.supported,
      error: modeled.error ?? null,
    };
  });

  return {
    parityDetails,
    storedMonthlyUsd: roundCurrency(
      parityDetails.reduce((sum, comparison) => sum + comparison.storedMonthlyUsd, 0),
    ),
    modeledMonthlyUsd: roundCurrency(
      parityDetails.reduce((sum, comparison) => sum + comparison.modeledMonthlyUsd, 0),
    ),
    unsupportedComparisons: parityDetails.filter((comparison) => !comparison.supported),
    mismatchedComparisons: parityDetails.filter(
      (comparison) =>
        comparison.supported && Math.abs(comparison.deltaUsd) > ROUNDING_TOLERANCE_USD,
    ),
  };
}

function withinRoundingTolerance(left, right) {
  return roundCurrency(Math.abs(Number(left ?? 0) - Number(right ?? 0))) <= ROUNDING_TOLERANCE_USD;
}

function stringSetEvidence(label, values) {
  return {
    kind: "string_set",
    label,
    values: [...values],
  };
}

function requiredPresentMissingEvidence(label, required, present) {
  const presentSet = new Set(present);

  return {
    kind: "required_present_missing",
    label,
    required: [...required],
    present: [...present],
    missing: required.filter((value) => !presentSet.has(value)),
  };
}

function numericComparisonEvidence(metric, actual, expected, { comparator, tolerance = null, unit }) {
  return {
    kind: "numeric_comparison",
    metric,
    actual,
    expected,
    comparator,
    tolerance,
    unit,
  };
}

function expectedFoundEvidence(label, expected, found) {
  return {
    kind: "expected_found",
    label,
    expected,
    found: [...found],
  };
}

function paritySummaryEvidence({ modeled, groupMonthlyUsd = null }) {
  return {
    kind: "parity_summary",
    storedMonthlyUsd: modeled.storedMonthlyUsd,
    modeledMonthlyUsd: modeled.modeledMonthlyUsd,
    groupMonthlyUsd,
    mismatchedServiceCodes: modeled.mismatchedComparisons.map((comparison) => comparison.serviceCode),
    unsupportedServiceCodes: modeled.unsupportedComparisons.map((comparison) => comparison.serviceCode),
  };
}

function stateSummaryEvidence(label, state, values = []) {
  return {
    kind: "state_summary",
    label,
    state,
    values: [...values],
  };
}

function makeRuleResult({
  pack,
  id,
  title,
  status,
  severity,
  reason,
  remediation,
  details,
  blocking = true,
  evidence = null,
}) {
  return {
    pack,
    id,
    title,
    status,
    severity,
    blocking,
    reason,
    remediation,
    details,
    evidence,
  };
}

function groupChecksIntoPacks(checks) {
  return DEFAULT_PACK_ORDER.map((packId) => {
    const packChecks = checks.filter((check) => check.pack === packId);

    if (packChecks.length === 0) {
      return null;
    }

    return {
      id: packId,
      title: PACK_METADATA[packId]?.title ?? packId,
      passed: packChecks.every((check) => check.status !== "fail" || !check.blocking),
      blocking: packChecks.some((check) => check.blocking),
      failedRuleCount: packChecks.filter((check) => check.status === "fail").length,
      warningRuleCount: packChecks.filter((check) => check.status === "warning").length,
      checks: packChecks,
    };
  }).filter(Boolean);
}

function summarizeValidation({ checks, assumptions, parityDetails = [] }) {
  const blockingFailures = checks
    .filter((check) => check.status === "fail" && check.blocking)
    .map((check) => ({
      id: check.id,
      title: check.title,
      details: check.details,
      remediation: check.remediation,
    }));
  const warningRules = checks
    .filter(
      (check) =>
        check.status === "warning" || (check.status === "fail" && !check.blocking),
    )
    .map((check) => ({
      id: check.id,
      title: check.title,
      details: check.details,
      remediation: check.remediation,
    }));

  return {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    checks,
    packs: groupChecksIntoPacks(checks),
    blockingFailures,
    warningRules,
    hardFailures: blockingFailures.map((failure) => `${failure.id}: ${failure.details}`),
    warnings: warningRules.map((warning) => `${warning.id}: ${warning.details}`),
    assumptions,
    parityDetails,
    passed: blockingFailures.length === 0,
  };
}

function presentEnvironments(services) {
  return [
    ...new Set(
      serviceEntries(services)
        .filter((service) => service.serviceCode !== "amazonVirtualPrivateCloud")
        .map((service) => parseEnvironmentTag(service.description))
        .filter(Boolean),
    ),
  ];
}

function serviceDefinitionsForSavedEstimate(services) {
  return serviceEntries(services)
    .map((service) => resolveServiceDefinitionForSavedService(service))
    .filter(Boolean);
}

function hasExplicitValidationContext(contextSource) {
  return contextSource === "explicit" || contextSource === "link-plan";
}

function userAuthoredValidationText(estimate, userAuthoredText) {
  return [String(userAuthoredText ?? ""), String(estimate?.name ?? "")].join(" ").trim();
}

function hasRegionJustification(text) {
  return REGION_JUSTIFICATION_SIGNAL.test(String(text ?? ""));
}

function hasPremiumJustification(text) {
  return PREMIUM_JUSTIFICATION_SIGNAL.test(String(text ?? ""));
}

function buildSavedEstimateChecks({
  estimate,
  services,
  savedDefinitions,
  template,
  blueprint,
  pattern,
  expectedMonthlyUsd,
  expectedRegion,
  budgetTolerancePct,
  expectedRegionMode,
  validationMode,
  contextSource,
  userAuthoredText,
}) {
  const savedServices = serviceEntries(services);
  const totalMonthlyUsd = roundCurrency(Number(estimate?.totalCost?.monthly ?? 0));
  const groupMonthlyUsd = roundCurrency(Number(estimate?.groupSubtotal?.monthly ?? 0));
  const regions = regionsFor(services);
  const serviceCodes = serviceCodesFor(services);
  const serviceIds = dedupe(savedDefinitions.map((service) => service.id));
  const serviceFamilies = dedupe(savedDefinitions.map((service) => service.category));
  const modeled = summarizeModeling(services);
  const supportedEnvironments = presentEnvironments(services);
  const isIntentAware = validationMode === "intent-aware";
  const enforceTemplateSpecific =
    isIntentAware &&
    hasExplicitValidationContext(contextSource) &&
    Boolean(template) &&
    Boolean(blueprint);
  const expectedEnvironments = template?.expectedEnvironments ?? ENVIRONMENTS;
  const missingEnvironments = expectedEnvironments.filter(
    (environment) => !supportedEnvironments.includes(environment),
  );
  const ec2OperatingSystems = [
    ...new Set(
      savedServices
        .filter((service) => service.serviceCode === "ec2Enhancement")
        .map((service) => service?.calculationComponents?.selectedOS?.value)
        .filter(Boolean),
    ),
  ];
  const supportiveServiceIds = serviceIdsForServiceCodes(template?.supportiveServiceCodes ?? []);
  const supportiveUsd = roundCurrency(
    savedServices.reduce((sum, service) => {
      const savedServiceId =
        resolveServiceDefinitionForSavedService(service)?.id ??
        canonicalServiceIdForServiceCode(service.serviceCode);

      return supportiveServiceIds.includes(savedServiceId)
        ? sum + modeledServiceMonthlyUsd(service).monthlyUsd
        : sum;
    }, 0),
  );
  const supportiveRatio =
    modeled.modeledMonthlyUsd > 0 ? supportiveUsd / modeled.modeledMonthlyUsd : 0;
  const primaryRatio = modeled.modeledMonthlyUsd > 0 ? 1 - supportiveRatio : 0;
  const toleranceUsd =
    expectedMonthlyUsd == null
      ? null
      : roundCurrency(Math.abs(expectedMonthlyUsd) * budgetTolerancePct);
  const unsupportedDetails = modeled.unsupportedComparisons
    .map((comparison) =>
      comparison.error
        ? `${comparison.serviceCode} (${comparison.error})`
        : comparison.serviceCode,
    )
    .join(", ");
  const mismatchedDetails = modeled.mismatchedComparisons
    .map(
      (comparison) =>
        `${comparison.serviceCode}: stored ${comparison.storedMonthlyUsd.toFixed(2)} USD vs modeled ${comparison.modeledMonthlyUsd.toFixed(2)} USD`,
    )
    .join("; ");
  const expectedComputeOs = template?.computeOs ?? null;
  const userAuthoredTextCorpus = userAuthoredValidationText(estimate, userAuthoredText);
  const hasExplicitRegionJustification = hasRegionJustification(userAuthoredTextCorpus);
  const edgeExposed =
    serviceIds.some((serviceId) => EDGE_SERVICE_IDS.has(serviceId)) ||
    savedServices.some((service) => EDGE_SERVICE_CODES.has(service.serviceCode));
  const hasWaf = serviceIds.includes("aws-waf-v2");
  const hasCloudWatch = serviceIds.includes("amazon-cloudwatch");
  const usesPremiumService = savedDefinitions.some((service) =>
    PREMIUM_SERVICE_IDS.has(service.id),
  );
  const hasExplicitPremiumJustification = hasPremiumJustification(userAuthoredTextCorpus);
  const supportiveMaxRatio = template?.supportiveMaxRatio ?? 0.25;
  const primaryMinRatio = template?.primaryMinRatio ?? 0.55;
  const requiredServiceIds =
    pattern?.requiredServiceIds ??
    blueprint?.requiredServiceIds ??
    serviceIdsForServiceCodes(template?.requiredServiceCodes ?? []);
  const requiredServiceFamilies =
    pattern?.requiredServiceFamilies ?? blueprint?.requiredServiceFamilies ?? [];
  const nonDefaultRegions = regions.filter((region) => region !== DEFAULT_REGION);
  const nonDefaultRegion = nonDefaultRegions.length > 0;
  const bestMatchTemplateTitle = template?.title ?? "the inferred service mix";

  return {
    checks: [
      makeRuleResult({
        pack: "pricing-integrity",
        id: "pricing.services-present",
        title: "Services Present",
        status: Object.keys(services).length > 0 ? "pass" : "fail",
        severity: "error",
        reason: "A saved estimate must contain at least one service.",
        remediation: "Rebuild the estimate with at least one supported service entry.",
        details: `Found ${Object.keys(services).length} service entries.`,
        evidence: numericComparisonEvidence("service_entries", Object.keys(services).length, 1, {
          comparator: "gte",
          unit: "count",
        }),
      }),
      makeRuleResult({
        pack: "pricing-integrity",
        id: "pricing.known-service-formulas",
        title: "Known Service Formulas",
        status: modeled.unsupportedComparisons.length === 0 ? "pass" : "fail",
        severity: "error",
        reason: "Post-save validation needs a formula or parser for every saved service.",
        remediation: "Add a service parser/model hook or remove unsupported services from the exact path.",
        details:
          modeled.unsupportedComparisons.length === 0
            ? "All saved service entries are covered by modeled pricing formulas."
            : `Unsupported service formulas: ${unsupportedDetails}.`,
        evidence: paritySummaryEvidence({ modeled }),
      }),
      makeRuleResult({
        pack: "pricing-integrity",
        id: "pricing.saved-modeled-parity",
        title: "Saved vs Modeled Parity",
        status: modeled.mismatchedComparisons.length === 0 ? "pass" : "fail",
        severity: "error",
        reason: "Saved monthly values should match the local pricing model for parity-verified services.",
        remediation: "Inspect the service serializer and saved estimate shape for AWS-side coercion or drift.",
        details:
          modeled.mismatchedComparisons.length === 0
            ? `Stored monthly ${modeled.storedMonthlyUsd.toFixed(2)} USD matches modeled monthly ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`
            : mismatchedDetails,
        evidence: paritySummaryEvidence({ modeled }),
      }),
      makeRuleResult({
        pack: "pricing-integrity",
        id: "pricing.total-parity",
        title: "Top-Level Total Parity",
        status:
          withinRoundingTolerance(totalMonthlyUsd, modeled.modeledMonthlyUsd)
            ? "pass"
            : "fail",
        severity: "error",
        reason: "The top-level estimate total should match the modeled service sum.",
        remediation: "Recompute aggregate estimate totals from the saved services before generating the link.",
        details: `Top-level total ${totalMonthlyUsd.toFixed(2)} USD vs modeled sum ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
        evidence: numericComparisonEvidence(
          "estimate_total_monthly_usd",
          totalMonthlyUsd,
          modeled.modeledMonthlyUsd,
          {
            comparator: "eq",
            tolerance: ROUNDING_TOLERANCE_USD,
            unit: "usd",
          },
        ),
      }),
      makeRuleResult({
        pack: "pricing-integrity",
        id: "pricing.group-subtotal-parity",
        title: "Group Subtotal Parity",
        status:
          withinRoundingTolerance(groupMonthlyUsd, modeled.modeledMonthlyUsd)
            ? "pass"
            : "fail",
        severity: "error",
        reason: "The group subtotal should match the modeled service sum.",
        remediation: "Rebuild group subtotals from the saved service list.",
        details: `Group subtotal ${groupMonthlyUsd.toFixed(2)} USD vs modeled sum ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
        evidence: numericComparisonEvidence(
          "group_subtotal_monthly_usd",
          groupMonthlyUsd,
          modeled.modeledMonthlyUsd,
          {
            comparator: "eq",
            tolerance: ROUNDING_TOLERANCE_USD,
            unit: "usd",
          },
        ),
      }),
      expectedRegionMode === "single-region"
        ? makeRuleResult({
            pack: "architecture-completeness",
            id: "architecture.single-region",
            title: "Single Region",
            status: regions.length === 1 ? "pass" : "fail",
            severity: "error",
            reason:
              "The saved estimate should stay regionally coherent when single-region intent is explicit.",
            remediation:
              "Scope the estimate to one region or validate it with expectedRegionMode='multi-region'.",
            details: regions.length === 0 ? "No regions found." : `Regions: ${regions.join(", ")}.`,
            evidence: stringSetEvidence("regions", regions),
          })
        : expectedRegionMode === "multi-region"
          ? makeRuleResult({
              pack: "architecture-completeness",
              id: "architecture.single-region",
              title: "Single Region",
              status: regions.length > 1 ? "pass" : "warning",
              severity: regions.length > 1 ? "info" : "warning",
              blocking: false,
              reason: "This validation run expects multi-region intent.",
              remediation:
                "If the estimate is intentionally single-region, validate it with expectedRegionMode='single-region'.",
              details:
                regions.length > 1
                  ? `Multi-region estimate detected: ${regions.join(", ")}.`
                  : `Expected multi-region scope; found ${regions.join(", ") || "none"}.`,
              evidence: stringSetEvidence("regions", regions),
            })
          : makeRuleResult({
              pack: "architecture-completeness",
              id: "architecture.single-region",
              title: "Single Region",
              status: regions.length <= 1 ? "pass" : "warning",
              severity: regions.length <= 1 ? "info" : "warning",
              blocking: false,
              reason:
                "Regional scope is informational unless single-region or multi-region intent is explicit.",
              remediation:
                "Pass expectedRegionMode during validation if regional scope should be enforced.",
              details: regions.length === 0 ? "No regions found." : `Regions: ${regions.join(", ")}.`,
              evidence: stringSetEvidence("regions", regions),
            }),
      expectedRegion
        ? makeRuleResult({
            pack: "architecture-completeness",
            id: "architecture.expected-region",
            title: "Expected Region",
            status: regions.length === 1 && regions[0] === expectedRegion ? "pass" : "fail",
            severity: "error",
            reason: "The saved estimate should match the requested deployment region.",
            remediation: "Rebuild the estimate in the intended region or correct the requested region.",
            details: `Expected ${expectedRegion}; found ${regions.join(", ") || "none"}.`,
            evidence: expectedFoundEvidence("region", expectedRegion, regions),
          })
        : makeRuleResult({
            pack: "architecture-completeness",
            id: "architecture.expected-region",
            title: "Expected Region",
            status: "warning",
            severity: "warning",
            blocking: false,
            reason: "Validation is stronger when the intended region is known.",
            remediation: "Pass expectedRegion during validation.",
            details: "No expected region was supplied.",
            evidence: null,
          }),
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.required-service-codes",
        title: "Required Service Codes",
        status: requiredServiceIds.every((serviceId) => serviceIds.includes(serviceId))
          ? "pass"
          : enforceTemplateSpecific
            ? "fail"
            : "warning",
        severity: enforceTemplateSpecific ? "error" : "warning",
        blocking: enforceTemplateSpecific,
        reason: enforceTemplateSpecific
          ? "Intent-aware validation requires the expected baseline services."
          : "Best-match template coverage is informational when no explicit architecture context was supplied.",
        remediation: enforceTemplateSpecific
          ? `Ensure the estimate includes ${requiredServiceIds.join(", ")}.`
          : "Pass blueprintId or templateId during validation if service-code coverage should be enforced.",
        details: enforceTemplateSpecific
          ? `Required services: ${requiredServiceIds.join(", ")}.`
          : `Best-match template '${bestMatchTemplateTitle}' expects ${requiredServiceIds.join(", ")}.`,
        evidence: requiredPresentMissingEvidence(
          "required_service_ids",
          requiredServiceIds,
          serviceIds,
        ),
      }),
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.required-service-families",
        title: "Required Service Families",
        status: requiredServiceFamilies.every((family) => serviceFamilies.includes(family))
          ? "pass"
          : enforceTemplateSpecific
            ? "fail"
            : "warning",
        severity: enforceTemplateSpecific ? "error" : "warning",
        blocking: enforceTemplateSpecific,
        reason: enforceTemplateSpecific
          ? "Intent-aware validation requires the expected service-family mix."
          : "Best-match blueprint families are advisory when validation context was inferred.",
        remediation: enforceTemplateSpecific
          ? "Add the missing family or choose a blueprint that matches the saved service mix."
          : "Pass blueprintId during validation if service-family coverage should be enforced.",
        details: `Required families: ${requiredServiceFamilies.join(", ")}. Present families: ${serviceFamilies.join(", ") || "none"}.`,
        evidence: requiredPresentMissingEvidence(
          "required_service_families",
          requiredServiceFamilies,
          serviceFamilies,
        ),
      }),
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.environment-coverage",
        title: "Environment Coverage",
        status:
          missingEnvironments.length === 0
            ? "pass"
            : enforceTemplateSpecific
              ? "fail"
              : "warning",
        severity: enforceTemplateSpecific ? "error" : "warning",
        blocking: enforceTemplateSpecific,
        reason: enforceTemplateSpecific
          ? `The baseline environment model expects ${expectedEnvironments.join(", ")} coverage.`
          : "Environment coverage is advisory when no explicit environment model was supplied.",
        remediation: enforceTemplateSpecific
          ? "Add the missing environment rows or document why a reduced environment model is justified."
          : "Validate with explicit blueprint/template context if environment coverage should be enforced.",
        details:
          missingEnvironments.length === 0
            ? `Primary services cover ${supportedEnvironments.join(", ")}.`
            : enforceTemplateSpecific
              ? `Missing environments: ${missingEnvironments.join(", ")}.`
              : `Best-match template expects ${expectedEnvironments.join(", ")}; found ${supportedEnvironments.join(", ") || "none"}.`,
        evidence: requiredPresentMissingEvidence(
          "environment_coverage",
          expectedEnvironments,
          supportedEnvironments,
        ),
      }),
      expectedComputeOs
        ? makeRuleResult({
            pack: "architecture-completeness",
            id: "architecture.compute-os",
            title: "Compute OS Matches Blueprint",
            status:
              ec2OperatingSystems.length === 1 && ec2OperatingSystems[0] === expectedComputeOs
                ? "pass"
                : enforceTemplateSpecific
                  ? "fail"
                  : "warning",
            severity: enforceTemplateSpecific ? "error" : "warning",
            blocking: enforceTemplateSpecific,
            reason: enforceTemplateSpecific
              ? "The compute operating system should remain consistent with the selected blueprint."
              : "Compute operating system matching is advisory when the blueprint was inferred.",
            remediation: enforceTemplateSpecific
              ? "Use the matching blueprint or rebuild the EC2 rows for the intended operating system."
              : "Pass blueprintId during validation if compute OS should be enforced.",
            details: `Expected compute OS ${expectedComputeOs}; found ${ec2OperatingSystems.join(", ") || "none"}.`,
            evidence: expectedFoundEvidence("compute_os", expectedComputeOs, ec2OperatingSystems),
          })
        : makeRuleResult({
            pack: "architecture-completeness",
            id: "architecture.compute-os",
            title: "Compute OS Matches Blueprint",
            status: "warning",
            severity: "warning",
            blocking: false,
            reason: "No compute OS expectation was supplied during validation.",
            remediation:
              "Pass an explicit blueprint or expected compute OS during validation when compute is present.",
            details:
              ec2OperatingSystems.length === 0
                ? "No EC2 compute rows are present for this blueprint."
                : "No expected compute OS was supplied.",
            evidence: null,
      }),
      makeRuleResult({
        pack: "funding-readiness",
        id: "funding.supportive-spend-threshold",
        title: "Supportive Spend Threshold",
        status: supportiveRatio <= supportiveMaxRatio ? "pass" : "warning",
        severity: supportiveRatio <= supportiveMaxRatio ? "info" : "warning",
        blocking: false,
        reason: "Supportive spend should not dominate the estimate.",
        remediation: "Reduce supportive services or increase primary workload scope.",
        details: `Supportive spend ${percent(supportiveRatio)} vs guidance max ${percent(supportiveMaxRatio)}.`,
        evidence: numericComparisonEvidence("supportive_spend_ratio", supportiveRatio, supportiveMaxRatio, {
          comparator: "lte",
          unit: "ratio",
        }),
      }),
      makeRuleResult({
        pack: "funding-readiness",
        id: "funding.primary-spend-dominant",
        title: "Primary Spend Dominant",
        status: primaryRatio >= primaryMinRatio ? "pass" : "warning",
        severity: primaryRatio >= primaryMinRatio ? "info" : "warning",
        blocking: false,
        reason: "Primary workload spend should remain dominant for funding review.",
        remediation: "Increase primary workload scope or trim supportive spend.",
        details: `Primary spend ${percent(primaryRatio)} vs guidance min ${percent(primaryMinRatio)}.`,
        evidence: numericComparisonEvidence("primary_spend_ratio", primaryRatio, primaryMinRatio, {
          comparator: "gte",
          unit: "ratio",
        }),
      }),
      expectedMonthlyUsd == null
        ? makeRuleResult({
            pack: "funding-readiness",
            id: "funding.target-band-fit",
            title: "Target Band Fit",
            status: "warning",
            severity: "warning",
            blocking: false,
            reason: "Validation is stronger when the target monthly budget is known.",
            remediation: "Pass expectedMonthlyUsd during validation.",
            details: "No expected monthly budget was supplied.",
          })
        : makeRuleResult({
            pack: "funding-readiness",
            id: "funding.target-band-fit",
            title: "Target Band Fit",
            status:
              Math.abs(modeled.modeledMonthlyUsd - expectedMonthlyUsd) <= (toleranceUsd ?? 0)
                ? "pass"
                : "warning",
            severity:
              Math.abs(modeled.modeledMonthlyUsd - expectedMonthlyUsd) <= (toleranceUsd ?? 0)
                ? "info"
                : "warning",
            blocking: false,
            reason: "Funding review depends on the estimate landing in an agreed monthly band.",
            remediation: "Resize the architecture or adjust the target monthly budget with explicit justification.",
            details: `Expected ${expectedMonthlyUsd.toFixed(2)} USD within +/-${(toleranceUsd ?? 0).toFixed(2)} USD; modeled ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
            evidence: numericComparisonEvidence(
              "target_monthly_usd",
              modeled.modeledMonthlyUsd,
              expectedMonthlyUsd,
              {
                comparator: "band",
                tolerance: toleranceUsd ?? 0,
                unit: "usd",
              },
            ),
          }),
      nonDefaultRegion
        ? makeRuleResult({
            pack: "platform-governance",
            id: "governance.non-default-region-justification",
            title: "Non-Default Region Justification",
            status:
              regions.length === 1 && expectedRegion && expectedRegion === regions[0]
                ? "pass"
                : hasExplicitRegionJustification
                  ? "pass"
                  : "warning",
            severity:
              regions.length === 1 && expectedRegion && expectedRegion === regions[0]
                ? "info"
                : hasExplicitRegionJustification
                  ? "info"
                  : "warning",
            blocking: false,
            reason: "Non-default regions are guidance-only unless region intent is explicitly contradictory.",
            remediation:
              "Document latency, residency, compliance, or local-operational reasons when they matter for review.",
            details:
              regions.length === 1 && expectedRegion && expectedRegion === regions[0]
                ? `Region ${regions[0]} was explicitly requested.`
                : hasExplicitRegionJustification
                  ? "User-authored text includes a non-default region justification."
                  : `Non-default regions ${nonDefaultRegions.join(", ")} require documented context when reviewers need the rationale.`,
            evidence: stateSummaryEvidence(
              "non_default_region_justification",
              regions.length === 1 && expectedRegion && expectedRegion === regions[0]
                ? "explicit-region"
                : hasExplicitRegionJustification
                  ? "justified"
                  : "missing-justification",
              nonDefaultRegions,
            ),
          })
        : makeRuleResult({
            pack: "platform-governance",
            id: "governance.non-default-region-justification",
            title: "Non-Default Region Justification",
            status: "pass",
            severity: "info",
            blocking: false,
            reason: "The default region path does not require extra regional justification.",
            remediation: "None.",
            details: `Estimate stays on the default region path (${DEFAULT_REGION}).`,
            evidence: stateSummaryEvidence(
              "non_default_region_justification",
              "default-region",
              [DEFAULT_REGION],
            ),
          }),
      edgeExposed
        ? makeRuleResult({
            pack: "platform-governance",
            id: "governance.edge-security-controls",
            title: "Edge Security Controls",
            status: hasWaf ? "pass" : "warning",
            severity: hasWaf ? "info" : "warning",
            blocking: false,
            reason: "Edge-facing architectures should normally document or include explicit security controls.",
            remediation: "Add AWS WAF or document where equivalent edge security controls are enforced.",
            details: hasWaf
              ? "Edge-facing services include AWS WAF."
              : "Edge-facing services are present without AWS WAF.",
        evidence: stateSummaryEvidence(
          "edge_security_controls",
          hasWaf ? "waf-present" : "waf-missing",
          serviceIds.filter((serviceId) => EDGE_SERVICE_IDS.has(serviceId)),
        ),
      })
        : makeRuleResult({
            pack: "platform-governance",
            id: "governance.edge-security-controls",
            title: "Edge Security Controls",
            status: "pass",
            severity: "info",
            blocking: false,
            reason: "No edge-facing services were detected.",
            remediation: "None.",
            details: "The saved estimate is not edge-exposed.",
            evidence: stateSummaryEvidence("edge_security_controls", "not-edge-exposed"),
          }),
      makeRuleResult({
        pack: "platform-governance",
        id: "governance.operational-visibility",
        title: "Operational Visibility",
        status: !edgeExposed || hasCloudWatch ? "pass" : "warning",
        severity: !edgeExposed || hasCloudWatch ? "info" : "warning",
        blocking: false,
        reason: "Operational visibility should be present when the estimate includes edge or event-driven components.",
        remediation: "Add CloudWatch or document equivalent operational visibility controls.",
        details:
          !edgeExposed || hasCloudWatch
            ? "Operational visibility controls are present or not required by the saved service mix."
            : "Edge-facing services are present without CloudWatch.",
        evidence: stateSummaryEvidence(
          "operational_visibility",
          !edgeExposed || hasCloudWatch ? "present-or-not-required" : "missing-cloudwatch",
          hasCloudWatch ? ["amazonCloudWatch"] : [],
        ),
      }),
      usesPremiumService
        ? makeRuleResult({
            pack: "platform-governance",
            id: "governance.premium-managed-service-justification",
            title: "Premium Managed Service Justification",
            status: hasExplicitPremiumJustification ? "pass" : "warning",
            severity: hasExplicitPremiumJustification ? "info" : "warning",
            blocking: false,
            reason: "Premium managed services are easier to approve when their value is explicit.",
            remediation: "Document why the premium managed service is required for the workload.",
            details: hasExplicitPremiumJustification
              ? "User-authored text includes a premium managed service justification."
              : "Premium managed services are present without a clear justification marker.",
            evidence: stateSummaryEvidence(
              "premium_managed_service_justification",
              hasExplicitPremiumJustification ? "justified" : "missing-justification",
              savedDefinitions
                .filter((service) => PREMIUM_SERVICE_IDS.has(service.id))
                .map((service) => service.id),
            ),
          })
        : makeRuleResult({
            pack: "platform-governance",
            id: "governance.premium-managed-service-justification",
            title: "Premium Managed Service Justification",
            status: "pass",
            severity: "info",
            blocking: false,
            reason: "No premium managed services were detected.",
            remediation: "None.",
            details: "The saved estimate does not include premium managed services.",
            evidence: stateSummaryEvidence(
              "premium_managed_service_justification",
              "not-applicable",
            ),
          }),
    ],
    parityDetails: modeled.parityDetails,
    modeled,
  };
}

export function validateArchitectureScenario({ architecture, scenario, draftValidation }) {
  const supportiveUsd = roundCurrency(
    scenario.serviceBreakdown
      .filter((service) => service.supportive)
      .reduce((sum, service) => sum + service.monthlyUsd, 0),
  );
  const primaryUsd = roundCurrency(
    scenario.serviceBreakdown
      .filter((service) =>
        (architecture.selectedServices ?? []).some(
          (selected) => selected.serviceId === service.serviceId && selected.required,
        ),
      )
      .reduce((sum, service) => sum + service.monthlyUsd, 0),
  );
  const supportiveRatio =
    scenario.modeledMonthlyUsd > 0 ? supportiveUsd / scenario.modeledMonthlyUsd : 0;
  const primaryRatio = scenario.modeledMonthlyUsd > 0 ? primaryUsd / scenario.modeledMonthlyUsd : 0;
  const requiredServiceIds = architecture.selectedServices
    .filter((service) => service.required)
    .map((service) => service.serviceId);
  const selectedServiceIds = architecture.selectedServices.map((service) => service.serviceId);
  const serviceFamilies = [...new Set(architecture.selectedServices.map((service) => service.category))];
  const forbiddenServiceIds = (architecture.excludedDefaults ?? []).filter((serviceId) =>
    selectedServiceIds.includes(serviceId),
  );
  const dominantForbiddenServices = scenario.serviceBreakdown.filter((service) => {
    const serviceRatio =
      scenario.modeledMonthlyUsd > 0 ? service.monthlyUsd / scenario.modeledMonthlyUsd : 0;
    return (architecture.excludedDefaults ?? []).includes(service.serviceId) && serviceRatio >= 0.12;
  });
  const hasRegionJustificationNotes = hasRegionJustification(architecture.notes);
  const hasPremiumJustificationNotes = hasPremiumJustification(architecture.notes);
  const hasWaf = selectedServiceIds.includes("aws-waf-v2");
  const hasCloudWatch = selectedServiceIds.includes("amazon-cloudwatch");
  const edgeExposed = architecture.selectedServices.some((service) =>
    ["application-load-balancer", "amazon-cloudfront", "amazon-api-gateway-http", "amazon-route53"].includes(
      service.serviceId,
    ),
  );
  const usesPremiumService = architecture.selectedServices.some((service) =>
    PREMIUM_SERVICE_IDS.has(service.serviceId),
  );
  const checks = [
    makeRuleResult({
      pack: "pricing-integrity",
      id: "pricing.scenario-target-positive",
      title: "Scenario Target Positive",
      status: scenario.targetMonthlyUsd > 0 ? "pass" : "fail",
      severity: "error",
      reason: "A priced scenario requires a positive target budget.",
      remediation: "Provide a positive targetMonthlyUsd or adjust the scenario policy.",
      details: `Scenario target monthly budget is ${scenario.targetMonthlyUsd.toFixed(2)} USD.`,
      evidence: numericComparisonEvidence("scenario_target_monthly_usd", scenario.targetMonthlyUsd, 0, {
        comparator: "gte",
        unit: "usd",
      }),
    }),
    makeRuleResult({
      pack: "pricing-integrity",
      id: "pricing.scenario-services-present",
      title: "Scenario Services Present",
      status: scenario.serviceBreakdown.length > 0 ? "pass" : "fail",
      severity: "error",
      reason: "A scenario needs at least one priced service row.",
      remediation: "Ensure the architecture selects at least one supported service.",
      details: `Scenario contains ${scenario.serviceBreakdown.length} priced service rows.`,
      evidence: numericComparisonEvidence("scenario_service_rows", scenario.serviceBreakdown.length, 1, {
        comparator: "gte",
        unit: "count",
      }),
    }),
    scenario.coverage.unavailable.length === 0
      ? makeRuleResult({
          pack: "pricing-integrity",
          id: "pricing.region-service-coverage",
          title: "Region Service Coverage",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "All selected services are at least modeled in the target region.",
          remediation: "None.",
          details: "All selected services are priced or modeled in the selected region.",
          evidence: stringSetEvidence("exact_or_modeled_services", [
            ...scenario.coverage.exact,
            ...scenario.coverage.modeled,
          ]),
        })
      : makeRuleResult({
          pack: "pricing-integrity",
          id: "pricing.region-service-coverage",
          title: "Region Service Coverage",
          status: "fail",
          severity: "error",
          reason: "Unavailable services block scenario execution in the selected region.",
          remediation: "Remove the unavailable services or change region.",
          details: `Unavailable services in the selected region: ${scenario.coverage.unavailable.join(", ")}.`,
          evidence: stringSetEvidence("unavailable_services", scenario.coverage.unavailable),
        }),
    makeRuleResult({
      pack: "architecture-completeness",
      id: "architecture.required-blueprint-services",
      title: "Required Blueprint Services",
      status: requiredServiceIds.every((serviceId) => selectedServiceIds.includes(serviceId))
        ? "pass"
        : "fail",
      severity: "error",
      reason: "Each blueprint requires a minimum service set.",
      remediation: "Add the missing required services or select a different blueprint.",
      details: `Required services: ${requiredServiceIds.join(", ")}.`,
      evidence: requiredPresentMissingEvidence(
        "required_blueprint_services",
        requiredServiceIds,
        selectedServiceIds,
      ),
    }),
    makeRuleResult({
      pack: "architecture-completeness",
      id: "architecture.required-service-families",
      title: "Required Service Families",
      status: architecture.requiredServiceFamilies.every((family) => serviceFamilies.includes(family))
        ? "pass"
        : "fail",
      severity: "error",
      reason: "Each blueprint requires a minimum service-family mix.",
      remediation: "Add the missing service family or choose a blueprint that matches the workload.",
      details: `Required families: ${architecture.requiredServiceFamilies.join(", ")}. Present families: ${serviceFamilies.join(", ") || "none"}.`,
      evidence: requiredPresentMissingEvidence(
        "required_service_families",
        architecture.requiredServiceFamilies,
        serviceFamilies,
      ),
    }),
    makeRuleResult({
      pack: "architecture-completeness",
      id: "architecture.required-capabilities",
      title: "Required Capabilities",
      status: (architecture.requiredCapabilities ?? []).length > 0 ? "pass" : "warning",
      severity: (architecture.requiredCapabilities ?? []).length > 0 ? "info" : "warning",
      blocking: false,
      reason: "Architecture validation is clearer when the required workload capabilities are explicit.",
      remediation: "Define required capabilities for the architecture profile if they are missing.",
      details:
        (architecture.requiredCapabilities ?? []).length > 0
          ? `Required capabilities: ${architecture.requiredCapabilities.join(", ")}.`
          : "This architecture profile does not declare required capabilities.",
      evidence: stringSetEvidence(
        "required_capabilities",
        architecture.requiredCapabilities ?? [],
      ),
    }),
    dominantForbiddenServices.length === 0 && forbiddenServiceIds.length === 0
      ? makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.forbidden-service-mix",
          title: "Forbidden Service Mix",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "The selected service mix is coherent with the architecture profile.",
          remediation: "None.",
          details: "No forbidden service families were selected for this architecture.",
          evidence: stringSetEvidence("forbidden_service_conflicts", []),
        })
      : makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.forbidden-service-mix",
          title: "Forbidden Service Mix",
          status: "fail",
          severity: "error",
          reason: "The selected service mix contradicts the intended architecture shape.",
          remediation: "Remove the conflicting service or choose the architecture family that matches the workload.",
          details: `Conflicting services: ${[
            ...forbiddenServiceIds,
            ...dominantForbiddenServices.map((service) => service.serviceId),
          ].join(", ")}.`,
          evidence: stringSetEvidence("forbidden_service_conflicts", [
            ...forbiddenServiceIds,
            ...dominantForbiddenServices.map((service) => service.serviceId),
          ]),
        }),
    architecture.fitGaps?.length > 0
      ? makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.pattern-fit-gaps",
          title: "Pattern Fit Gaps",
          status: "warning",
          severity: "warning",
          blocking: false,
          reason: "The selected pattern is the nearest supported fit, but it still misses an explicit architectural requirement from the prompt.",
          remediation: "Resolve the fit gap or document why the nearest-fit pattern is acceptable.",
          details: architecture.fitGaps.join(" "),
          evidence: stringSetEvidence("pattern_fit_gaps", architecture.fitGaps),
        })
      : makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.pattern-fit-gaps",
          title: "Pattern Fit Gaps",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "No architecture fit gaps were recorded for the selected pattern.",
          remediation: "None.",
          details: `Pattern '${architecture.patternId ?? architecture.blueprintId}' cleanly matches the extracted architecture intent.`,
          evidence: stateSummaryEvidence("pattern_fit", "clean", [
            architecture.patternId ?? architecture.blueprintId,
          ]),
        }),
    architecture.requiredUnpricedCapabilities?.length > 0
      ? makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.required-unpriced-capabilities",
          title: "Required Unpriced Capabilities",
          status: "warning",
          severity: "warning",
          blocking: false,
          reason: "The prompt implies required architectural capabilities that are not fully represented in the priced service mix.",
          remediation: "Surface the capability gap to the user or add pricing support for the missing capability.",
          details: architecture.requiredUnpricedCapabilities
            .map((capability) => capability.id)
            .join(", "),
          evidence: stringSetEvidence(
            "required_unpriced_capabilities",
            architecture.requiredUnpricedCapabilities.map((capability) => capability.id),
          ),
        })
      : makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.required-unpriced-capabilities",
          title: "Required Unpriced Capabilities",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "All required capabilities are represented in the priced architecture.",
          remediation: "None.",
          details: "No required-but-unpriced architecture capabilities were recorded.",
          evidence: stringSetEvidence("required_unpriced_capabilities", []),
        }),
    makeRuleResult({
      pack: "architecture-completeness",
      id: "architecture.environment-model",
      title: "Environment Model Present",
      status: ["dev", "staging", "prod"].every((environment) =>
        Object.prototype.hasOwnProperty.call(architecture.environmentSplit, environment),
      )
        ? "pass"
        : "fail",
      severity: "error",
      reason: "The architecture engine expects a three-environment model unless explicitly changed.",
      remediation: "Provide dev, staging, and prod environment weights.",
      details: "Architecture includes the expected three-environment split.",
      evidence: requiredPresentMissingEvidence(
        "environment_model",
        ["dev", "staging", "prod"],
        Object.keys(architecture.environmentSplit),
      ),
    }),
    (scenario.coverage.exact?.length ?? 0) > 0
      ? makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.calculator-backed-services",
          title: "Calculator-Backed Services Present",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "At least one calculator-backed service is present in the scenario.",
          remediation: "None.",
          details: `Calculator-backed services: ${scenario.coverage.exact.join(", ")}.`,
          evidence: stringSetEvidence("calculator_backed_services", scenario.coverage.exact),
        })
      : makeRuleResult({
          pack: "architecture-completeness",
          id: "architecture.calculator-backed-services",
          title: "Calculator-Backed Services Present",
          status: "fail",
          severity: "error",
          reason: "An exact calculator flow requires calculator-backed services.",
          remediation: "Scope the scenario to exact-capable services or add serializer coverage.",
          details: "No calculator-backed services were selected.",
          evidence: stringSetEvidence("calculator_backed_services", []),
        }),
    makeRuleResult({
      pack: "funding-readiness",
      id: "funding.supportive-spend-threshold",
      title: "Supportive Spend Threshold",
      status: supportiveRatio <= 0.25 ? "pass" : "warning",
      severity: supportiveRatio <= 0.25 ? "info" : "warning",
      blocking: false,
      reason: "Supportive services should remain proportionate to the primary workload.",
      remediation: "Trim shared-service overhead or expand the primary workload.",
      details: `Supportive spend ${percent(supportiveRatio)} of modeled total.`,
      evidence: numericComparisonEvidence("supportive_spend_ratio", supportiveRatio, 0.25, {
        comparator: "lte",
        unit: "ratio",
      }),
    }),
    makeRuleResult({
      pack: "funding-readiness",
      id: "funding.primary-architecture-dominance",
      title: "Primary Architecture Dominance",
      status:
        primaryRatio >= (architecture.minimumPrimaryDominanceRatio ?? 0.55) ? "pass" : "warning",
      severity:
        primaryRatio >= (architecture.minimumPrimaryDominanceRatio ?? 0.55) ? "info" : "warning",
      blocking: false,
      reason: "Core architecture services should dominate the spend mix for the chosen topology.",
      remediation: "Increase the core workload scope or remove unrelated add-ons that are dominating the estimate.",
      details: `Primary architecture services account for ${percent(primaryRatio)} of modeled spend vs expected minimum ${percent(architecture.minimumPrimaryDominanceRatio ?? 0.55)}.`,
      evidence: numericComparisonEvidence(
        "primary_architecture_spend_ratio",
        primaryRatio,
        architecture.minimumPrimaryDominanceRatio ?? 0.55,
        {
          comparator: "gte",
          unit: "ratio",
        },
      ),
    }),
    makeRuleResult({
      pack: "funding-readiness",
      id: "funding.architecture-budget-fit",
      title: "Architecture Budget Fit",
      status:
        scenario.budgetFit?.status === "fits"
          ? "pass"
          : scenario.budgetFit?.status === "incompatible_budget"
            ? "fail"
            : "warning",
      severity:
        scenario.budgetFit?.status === "fits"
          ? "info"
          : scenario.budgetFit?.status === "incompatible_budget"
            ? "error"
            : "warning",
      blocking: scenario.budgetFit?.status === "incompatible_budget",
      reason: "Budgets should size the architecture, not force a different topology.",
      remediation: "Adjust the target budget or select a different architecture family if the nearest valid fit is too far away.",
      details: scenario.budgetFit?.details ?? "No scenario budget-fit details were recorded.",
      evidence: stateSummaryEvidence(
        "architecture_budget_fit",
        scenario.budgetFit?.status ?? "unknown",
      ),
    }),
    scenario.coverage.modeled.length === 0
      ? makeRuleResult({
          pack: "funding-readiness",
          id: "funding.modeled-service-gaps",
          title: "Modeled Service Gaps",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "No modeled-only services block exact calculator generation.",
          remediation: "None.",
          details: "No modeled-only services block exact calculator generation.",
          evidence: stringSetEvidence("modeled_service_gaps", []),
        })
      : makeRuleResult({
          pack: "funding-readiness",
          id: "funding.modeled-service-gaps",
          title: "Modeled Service Gaps",
          status: "warning",
          severity: "warning",
          blocking: false,
          reason: "Modeled-only services prevent a fully exact calculator link.",
          remediation: "Scope the scenario to exact services or complete serializer coverage for the modeled services.",
          details: `Modeled-only services present: ${scenario.coverage.modeled.join(", ")}.`,
          evidence: stringSetEvidence("modeled_service_gaps", scenario.coverage.modeled),
        }),
    scenario.calculatorEligible
      ? makeRuleResult({
          pack: "funding-readiness",
          id: "funding.calculator-link-ready",
          title: "Calculator Link Ready",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "The scenario can be turned into an official calculator link.",
          remediation: "None.",
          details: "Scenario can be turned into an official calculator link.",
          evidence: stateSummaryEvidence("calculator_link_ready", "ready"),
        })
      : makeRuleResult({
          pack: "funding-readiness",
          id: "funding.calculator-link-ready",
          title: "Calculator Link Ready",
          status: "warning",
          severity: "warning",
          blocking: false,
          reason: "The scenario is not yet calculator-link ready.",
          remediation: "Resolve the calculator blockers or scope the scenario down to an exact-capable subset.",
          details: scenario.calculatorBlockers.join(" "),
          evidence: stateSummaryEvidence(
            "calculator_link_ready",
            "blocked",
            scenario.calculatorBlockers,
          ),
        }),
    architecture.region !== DEFAULT_REGION
      ? makeRuleResult({
          pack: "platform-governance",
          id: "governance.non-default-region-justification",
          title: "Non-Default Region Justification",
          status: hasRegionJustificationNotes ? "pass" : "warning",
          severity: hasRegionJustificationNotes ? "info" : "warning",
          blocking: false,
          reason: "Non-default regions are easier to approve when the rationale is explicit.",
          remediation: "Add a residency, latency, compliance, or regulatory justification in the architecture notes.",
          details: hasRegionJustificationNotes
            ? "Architecture notes include a region justification marker."
            : `Architecture targets ${architecture.region} without an explicit justification marker in notes.`,
          evidence: stateSummaryEvidence(
            "non_default_region_justification",
            hasRegionJustificationNotes ? "justified" : "missing-justification",
            [architecture.region],
          ),
        })
      : makeRuleResult({
          pack: "platform-governance",
          id: "governance.non-default-region-justification",
          title: "Non-Default Region Justification",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "The default region path does not require extra regional justification.",
          remediation: "None.",
          details: `Architecture stays on the default region path (${DEFAULT_REGION}).`,
          evidence: stateSummaryEvidence(
            "non_default_region_justification",
            "default-region",
            [DEFAULT_REGION],
          ),
        }),
    edgeExposed
      ? makeRuleResult({
          pack: "platform-governance",
          id: "governance.edge-security-controls",
          title: "Edge Security Controls",
          status: hasWaf ? "pass" : "warning",
          severity: hasWaf ? "info" : "warning",
          blocking: false,
          reason: "Edge-facing designs should normally include WAF or equivalent controls.",
          remediation: "Add aws-waf-v2 or document equivalent edge security controls.",
          details: hasWaf
            ? "Edge-facing services include aws-waf-v2."
            : "Edge-facing services are present without aws-waf-v2.",
          evidence: stateSummaryEvidence(
            "edge_security_controls",
            hasWaf ? "waf-present" : "waf-missing",
            selectedServiceIds.filter((serviceId) =>
              ["application-load-balancer", "amazon-cloudfront", "amazon-api-gateway-http", "amazon-route53"].includes(serviceId),
            ),
          ),
        })
      : makeRuleResult({
          pack: "platform-governance",
          id: "governance.edge-security-controls",
          title: "Edge Security Controls",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "No edge-facing services were selected.",
          remediation: "None.",
          details: "The architecture is not edge-exposed.",
          evidence: stateSummaryEvidence("edge_security_controls", "not-edge-exposed"),
        }),
    makeRuleResult({
      pack: "platform-governance",
      id: "governance.operational-visibility",
      title: "Operational Visibility",
      status: !edgeExposed || hasCloudWatch ? "pass" : "warning",
      severity: !edgeExposed || hasCloudWatch ? "info" : "warning",
      blocking: false,
      reason: "Operational visibility should be explicit for edge and event-driven designs.",
      remediation: "Add amazon-cloudwatch or document equivalent observability controls.",
      details:
        !edgeExposed || hasCloudWatch
          ? "Operational visibility controls are present or not required by the design."
          : "Edge-facing services are present without amazon-cloudwatch.",
      evidence: stateSummaryEvidence(
        "operational_visibility",
        !edgeExposed || hasCloudWatch ? "present-or-not-required" : "missing-cloudwatch",
        hasCloudWatch ? ["amazon-cloudwatch"] : [],
      ),
    }),
    usesPremiumService
      ? makeRuleResult({
          pack: "platform-governance",
          id: "governance.premium-managed-service-justification",
          title: "Premium Managed Service Justification",
          status: hasPremiumJustificationNotes ? "pass" : "warning",
          severity: hasPremiumJustificationNotes ? "info" : "warning",
          blocking: false,
          reason: "Premium managed services should have an explicit value justification.",
          remediation: "Document the reason for the premium managed service in the architecture notes.",
          details: hasPremiumJustificationNotes
            ? "Architecture notes include a premium service justification marker."
            : "Premium managed services are selected without an explicit justification marker in notes.",
          evidence: stateSummaryEvidence(
            "premium_managed_service_justification",
            hasPremiumJustificationNotes ? "justified" : "missing-justification",
            architecture.selectedServices
              .filter((service) => PREMIUM_SERVICE_IDS.has(service.serviceId))
              .map((service) => service.serviceId),
          ),
        })
      : makeRuleResult({
          pack: "platform-governance",
          id: "governance.premium-managed-service-justification",
          title: "Premium Managed Service Justification",
          status: "pass",
          severity: "info",
          blocking: false,
          reason: "No premium managed services were selected.",
          remediation: "None.",
          details: "The architecture does not include premium managed services.",
          evidence: stateSummaryEvidence(
            "premium_managed_service_justification",
            "not-applicable",
          ),
        }),
  ];

  if (draftValidation) {
    checks.push(
      draftValidation.passed
        ? makeRuleResult({
            pack: "pricing-integrity",
            id: "pricing.core-preview-valid",
            title: "Core Preview Valid",
            status: "pass",
            severity: "info",
            blocking: false,
            reason: "The core exact estimate preview validated before save.",
            remediation: "None.",
            details: "Core template preview validates successfully before save.",
            evidence: stateSummaryEvidence("core_preview_valid", "pass"),
          })
        : makeRuleResult({
            pack: "pricing-integrity",
            id: "pricing.core-preview-valid",
            title: "Core Preview Valid",
            status: "fail",
            severity: "error",
            reason: "The core exact estimate preview failed validation before save.",
            remediation: "Inspect the core estimate payload and fix the failing preview rules.",
            details: draftValidation.hardFailures.join(" "),
            evidence: stringSetEvidence("core_preview_failures", draftValidation.hardFailures),
          }),
    );
  }

  return summarizeValidation({
    checks,
    assumptions: [
      `Scenario '${scenario.id}' uses the normalized architecture '${architecture.blueprintId}' and pattern '${architecture.patternId ?? architecture.blueprintId}'.`,
    ],
    parityDetails: draftValidation?.parityDetails ?? [],
  });
}

export function validateEstimatePayload({
  estimate,
  templateId,
  blueprintId,
  patternId,
  expectedMonthlyUsd,
  expectedRegion,
  expectedRegionMode,
  validationMode,
  contextSource,
  userAuthoredText,
  budgetTolerancePct = DEFAULT_BUDGET_TOLERANCE_PCT,
}) {
  const services = estimate?.services ?? {};
  const resolvedContext = resolveValidationContext({
    services,
    templateId,
    blueprintId,
    patternId,
    validationMode,
    contextSource,
  });
  const {
    savedDefinitions,
    validationMode: resolvedValidationMode,
    contextSource: resolvedContextSource,
    blueprint,
    pattern,
    template,
    bestMatch,
  } = resolvedContext;
  const { checks, parityDetails, modeled } = buildSavedEstimateChecks({
    estimate,
    services,
    savedDefinitions,
    template,
    blueprint,
    pattern,
    expectedMonthlyUsd,
    expectedRegion,
    budgetTolerancePct,
    expectedRegionMode,
    validationMode: resolvedValidationMode,
    contextSource: resolvedContextSource,
    userAuthoredText,
  });
  const assumptions = [];

  if (resolvedContextSource === "inferred" && bestMatch?.template?.id) {
    assumptions.push(
      `Best-match template '${bestMatch.template.id}'${bestMatch.pattern ? ` via pattern '${bestMatch.pattern.id}'` : ""} was inferred from the saved service mix for generic validation.`,
    );
  }

  if (resolvedContextSource === "inferred" && bestMatch?.confidence === "low") {
    assumptions.push(
      "Saved-service inference confidence is low, so architecture mismatch checks are advisory only.",
    );
  }

  assumptions.push(`Budget tolerance defaulted to ${(budgetTolerancePct * 100).toFixed(0)}%.`);

  if (!expectedRegion) {
    assumptions.push("Region expectation was not supplied during validation.");
  }

  if (!expectedRegionMode) {
    assumptions.push("Region mode was not supplied during validation.");
  }

  if (expectedMonthlyUsd == null) {
    assumptions.push("Target monthly budget was not supplied during validation.");
  }

  const summary = summarizeValidation({
    checks,
    assumptions,
    parityDetails,
  });

  return {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    validationMode: resolvedValidationMode,
    contextSource: resolvedContextSource,
    blueprintId:
      resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
        ? blueprint?.id
        : undefined,
    blueprintTitle:
      resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
        ? blueprint?.title
        : undefined,
    templateId:
      resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
        ? template?.id
        : undefined,
    templateTitle:
      resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
        ? template?.title
        : undefined,
    bestMatchBlueprintId:
      resolvedContextSource === "inferred" ? bestMatch?.blueprint?.id ?? null : null,
    bestMatchBlueprintTitle:
      resolvedContextSource === "inferred" ? bestMatch?.blueprint?.title ?? null : null,
    patternId:
      resolvedContextSource === "explicit" || resolvedContextSource === "link-plan"
        ? pattern?.id
        : undefined,
    expectedMonthlyUsd:
      expectedMonthlyUsd == null ? null : roundCurrency(Number(expectedMonthlyUsd)),
    storedMonthlyUsd: modeled.storedMonthlyUsd,
    modeledMonthlyUsd: modeled.modeledMonthlyUsd,
    expectedRegion: expectedRegion ?? null,
    expectedRegionMode: expectedRegionMode ?? null,
    regions: regionsFor(services),
    serviceCodes: serviceCodesFor(services),
    ...summary,
  };
}
