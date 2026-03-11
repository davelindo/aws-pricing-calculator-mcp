import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  DEFAULT_REGION,
  getBlueprint,
  getTemplate,
  resolveBlueprintIdForTemplate,
} from "./catalog.js";
import { resolveServiceDefinitionForSavedService } from "./services/index.js";
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
const PREMIUM_SERVICE_IDS = new Set([
  "amazon-rds-sqlserver",
  "amazon-aurora-postgresql",
  "amazon-aurora-mysql",
  "amazon-opensearch",
  "amazon-fsx-windows",
]);
const JUSTIFICATION_SIGNAL = /(regulat|residency|sovereign|compliance|latency|security|incident|license|migration|moderni)/i;

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

function serviceFamiliesForSavedEstimate(services) {
  return [...new Set(serviceDefinitionsForSavedEstimate(services).map((service) => service.category))];
}

function estimateTextCorpus(estimate, services) {
  return [
    estimate?.name ?? "",
    ...serviceEntries(services).map((service) => service.description ?? ""),
  ].join(" ");
}

function hasJustification(text) {
  return JUSTIFICATION_SIGNAL.test(String(text ?? ""));
}

function buildSavedEstimateChecks({
  estimate,
  services,
  template,
  blueprint,
  expectedMonthlyUsd,
  expectedRegion,
  budgetTolerancePct,
}) {
  const totalMonthlyUsd = roundCurrency(Number(estimate?.totalCost?.monthly ?? 0));
  const groupMonthlyUsd = roundCurrency(Number(estimate?.groupSubtotal?.monthly ?? 0));
  const regions = regionsFor(services);
  const serviceCodes = serviceCodesFor(services);
  const serviceFamilies = serviceFamiliesForSavedEstimate(services);
  const modeled = summarizeModeling(services);
  const supportedEnvironments = presentEnvironments(services);
  const expectedEnvironments = template.expectedEnvironments ?? ENVIRONMENTS;
  const missingEnvironments = expectedEnvironments.filter(
    (environment) => !supportedEnvironments.includes(environment),
  );
  const ec2OperatingSystems = [
    ...new Set(
      serviceEntries(services)
        .filter((service) => service.serviceCode === "ec2Enhancement")
        .map((service) => service?.calculationComponents?.selectedOS?.value)
        .filter(Boolean),
    ),
  ];
  const supportiveUsd = roundCurrency(
    serviceEntries(services)
      .filter((service) => template.supportiveServiceCodes.includes(service.serviceCode))
      .reduce((sum, service) => sum + modeledServiceMonthlyUsd(service).monthlyUsd, 0),
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
  const expectedComputeOs = template.computeOs ?? null;
  const textCorpus = estimateTextCorpus(estimate, services);
  const hasRegionJustification = hasJustification(textCorpus);
  const edgeExposed = serviceEntries(services).some((service) => EDGE_SERVICE_CODES.has(service.serviceCode));
  const hasWaf =
    serviceCodes.includes("awsWAFv2") ||
    serviceCodes.includes("awsWebApplicationFirewall");
  const hasCloudWatch = serviceCodes.includes("amazonCloudWatch");
  const usesPremiumService = serviceDefinitionsForSavedEstimate(services).some((service) =>
    PREMIUM_SERVICE_IDS.has(service.id),
  );

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
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.single-region",
        title: "Single Region",
        status: regions.length === 1 ? "pass" : "fail",
        severity: "error",
        reason: "Funding-oriented estimates should stay regionally coherent unless multi-region is explicit.",
        remediation: "Scope the estimate to one region or add explicit multi-region support and justification.",
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
        status: template.requiredServiceCodes.every((serviceCode) => serviceCodes.includes(serviceCode))
          ? "pass"
          : "fail",
        severity: "error",
        reason: "Every baseline template requires a minimum set of service families and exact service codes.",
        remediation: `Ensure the estimate includes ${template.requiredServiceCodes.join(", ")}.`,
        details: `Required service codes: ${template.requiredServiceCodes.join(", ")}.`,
        evidence: requiredPresentMissingEvidence(
          "required_service_codes",
          template.requiredServiceCodes,
          serviceCodes,
        ),
      }),
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.required-service-families",
        title: "Required Service Families",
        status: blueprint.requiredServiceFamilies.every((family) => serviceFamilies.includes(family))
          ? "pass"
          : "fail",
        severity: "error",
        reason: "Blueprint-level architecture validation needs the expected service families to be present.",
        remediation: `Add the missing family or choose a blueprint that matches the saved service mix.`,
        details: `Required families: ${blueprint.requiredServiceFamilies.join(", ")}. Present families: ${serviceFamilies.join(", ") || "none"}.`,
        evidence: requiredPresentMissingEvidence(
          "required_service_families",
          blueprint.requiredServiceFamilies,
          serviceFamilies,
        ),
      }),
      makeRuleResult({
        pack: "architecture-completeness",
        id: "architecture.environment-coverage",
        title: "Environment Coverage",
        status: missingEnvironments.length === 0 ? "pass" : "fail",
        severity: "error",
        reason: `The baseline environment model expects ${expectedEnvironments.join(", ")} coverage.`,
        remediation:
          "Add the missing environment rows or document why a reduced environment model is justified.",
        details:
          missingEnvironments.length === 0
            ? `Primary services cover ${supportedEnvironments.join(", ")}.`
            : `Missing environments: ${missingEnvironments.join(", ")}.`,
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
                : "fail",
            severity: "error",
            reason: "The compute operating system should remain consistent with the selected blueprint.",
            remediation: "Use the matching blueprint or rebuild the EC2 rows for the intended operating system.",
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
        remediation: "Pass an explicit blueprint or expected compute OS during validation when compute is present.",
        details:
          ec2OperatingSystems.length === 0
            ? "No EC2 compute rows are present for this blueprint."
            : "No expected compute OS was supplied.",
      }),
      makeRuleResult({
        pack: "funding-readiness",
        id: "funding.supportive-spend-threshold",
        title: "Supportive Spend Threshold",
        status: supportiveRatio <= template.supportiveMaxRatio ? "pass" : "fail",
        severity: "error",
        reason: "Supportive spend should not dominate the estimate.",
        remediation: "Reduce supportive services or increase primary workload scope.",
        details: `Supportive spend ${percent(supportiveRatio)} vs max ${percent(template.supportiveMaxRatio)}.`,
        evidence: numericComparisonEvidence("supportive_spend_ratio", supportiveRatio, template.supportiveMaxRatio, {
          comparator: "lte",
          unit: "ratio",
        }),
      }),
      makeRuleResult({
        pack: "funding-readiness",
        id: "funding.primary-spend-dominant",
        title: "Primary Spend Dominant",
        status: primaryRatio >= template.primaryMinRatio ? "pass" : "fail",
        severity: "error",
        reason: "Primary workload spend should remain dominant for funding review.",
        remediation: "Increase primary workload scope or trim supportive spend.",
        details: `Primary spend ${percent(primaryRatio)} vs min ${percent(template.primaryMinRatio)}.`,
        evidence: numericComparisonEvidence("primary_spend_ratio", primaryRatio, template.primaryMinRatio, {
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
                : "fail",
            severity: "error",
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
      regions[0] && regions[0] !== DEFAULT_REGION
        ? makeRuleResult({
            pack: "platform-governance",
            id: "governance.non-default-region-justification",
            title: "Non-Default Region Justification",
            status: hasRegionJustification ? "pass" : "fail",
            severity: "error",
            reason: "Non-default regions need a clear justification for funding and review.",
            remediation: "Include residency, regulatory, latency, or compliance justification in the estimate notes or attached SOW.",
            details: hasRegionJustification
              ? "A justification marker was found in the estimate text."
              : `Region ${regions[0]} is outside the default ${DEFAULT_REGION} path and no justification marker was found.`,
            evidence: stateSummaryEvidence(
              "non_default_region_justification",
              hasRegionJustification ? "justified" : "missing-justification",
              [regions[0]],
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
              serviceCodes.filter((serviceCode) => EDGE_SERVICE_CODES.has(serviceCode)),
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
            status: hasJustification(textCorpus) ? "pass" : "warning",
            severity: hasJustification(textCorpus) ? "info" : "warning",
            blocking: false,
            reason: "Premium managed services are easier to approve when their value is explicit.",
            remediation: "Document why the premium managed service is required for the workload.",
            details: hasJustification(textCorpus)
              ? "A justification marker was found for premium managed services."
              : "Premium managed services are present without a clear justification marker.",
            evidence: stateSummaryEvidence(
              "premium_managed_service_justification",
              hasJustification(textCorpus) ? "justified" : "missing-justification",
              serviceDefinitionsForSavedEstimate(services)
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
  const hasJustificationNotes = hasJustification(architecture.notes);
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
          status: hasJustificationNotes ? "pass" : "warning",
          severity: hasJustificationNotes ? "info" : "warning",
          blocking: false,
          reason: "Non-default regions are easier to approve when the rationale is explicit.",
          remediation: "Add a residency, latency, compliance, or regulatory justification in the architecture notes.",
          details: hasJustificationNotes
            ? "Architecture notes include a region justification marker."
            : `Architecture targets ${architecture.region} without an explicit justification marker in notes.`,
          evidence: stateSummaryEvidence(
            "non_default_region_justification",
            hasJustificationNotes ? "justified" : "missing-justification",
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
          status: hasJustificationNotes ? "pass" : "warning",
          severity: hasJustificationNotes ? "info" : "warning",
          blocking: false,
          reason: "Premium managed services should have an explicit value justification.",
          remediation: "Document the reason for the premium managed service in the architecture notes.",
          details: hasJustificationNotes
            ? "Architecture notes include a premium service justification marker."
            : "Premium managed services are selected without an explicit justification marker in notes.",
          evidence: stateSummaryEvidence(
            "premium_managed_service_justification",
            hasJustificationNotes ? "justified" : "missing-justification",
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
  expectedMonthlyUsd,
  expectedRegion,
  budgetTolerancePct = DEFAULT_BUDGET_TOLERANCE_PCT,
}) {
  const services = estimate?.services ?? {};
  const inferredTemplateId = templateId ?? inferTemplateIdFromServices(services);
  const template = getTemplate(inferredTemplateId);
  const blueprint = getBlueprint(resolveBlueprintIdForTemplate(template.id));
  const { checks, parityDetails, modeled } = buildSavedEstimateChecks({
    estimate,
    services,
    template,
    blueprint,
    expectedMonthlyUsd,
    expectedRegion,
    budgetTolerancePct,
  });
  const assumptions = [];

  if (!templateId) {
    assumptions.push(`Template was inferred as '${inferredTemplateId}' from the saved service mix.`);
  }

  assumptions.push(`Budget tolerance defaulted to ${(budgetTolerancePct * 100).toFixed(0)}%.`);

  if (!expectedRegion) {
    assumptions.push("Region expectation was not supplied during validation.");
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
    blueprintId: blueprint.id,
    blueprintTitle: blueprint.title,
    templateId: template.id,
    templateTitle: template.title,
    expectedMonthlyUsd:
      expectedMonthlyUsd == null ? null : roundCurrency(Number(expectedMonthlyUsd)),
    storedMonthlyUsd: modeled.storedMonthlyUsd,
    modeledMonthlyUsd: modeled.modeledMonthlyUsd,
    expectedRegion: expectedRegion ?? null,
    regions: regionsFor(services),
    serviceCodes: serviceCodesFor(services),
    ...summary,
  };
}
