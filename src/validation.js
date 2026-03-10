import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  getTemplate,
} from "./catalog.js";
import {
  ENVIRONMENTS,
  modelEc2MonthlyUsd,
  modelEksMonthlyUsd,
  modelNatMonthlyUsd,
  modelRdsMonthlyUsd,
  parseEnvironmentTag,
  parseNumericValue,
  percent,
  regionsFor,
  roundCurrency,
  serviceCodesFor,
  serviceEntries,
  serviceMonthlyUsd,
} from "./model.js";

function inferTemplateIdFromServices(services) {
  const serviceCodes = serviceCodesFor(services);

  if (serviceCodes.includes("awsEks")) {
    return "eks-rds-standard";
  }

  const hasWindowsEc2 = serviceEntries(services)
    .filter((service) => service.serviceCode === "ec2Enhancement")
    .some((service) => service?.calculationComponents?.selectedOS?.value === "windows");

  return hasWindowsEc2 ? "windows-heavy" : "linux-heavy";
}

function modeledServiceMonthlyUsd(service) {
  const region = service?.region;

  try {
    switch (service?.serviceCode) {
      case "awsEks": {
        const clusterCount = parseNumericValue(
          service?.calculationComponents?.numberOfEKSClusters?.value,
          0,
        );

        return {
          supported: true,
          monthlyUsd: modelEksMonthlyUsd(region, clusterCount),
        };
      }
      case "ec2Enhancement": {
        const operatingSystem = service?.calculationComponents?.selectedOS?.value;
        const instanceType = service?.calculationComponents?.instanceType?.value;
        const instanceCount = parseNumericValue(
          service?.calculationComponents?.workload?.value?.data,
          0,
        );

        return {
          supported: true,
          monthlyUsd: modelEc2MonthlyUsd(region, operatingSystem, instanceType, instanceCount),
        };
      }
      case "amazonRDSPostgreSQLDB": {
        const storageGb = parseNumericValue(service?.calculationComponents?.storageAmount?.value, 0);
        const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];
        const monthlyUsd = roundCurrency(
          rows.reduce((sum, row) => {
            const instanceType = row?.["Instance Type"]?.value;
            const deploymentOption = row?.["Deployment Option"]?.value;
            const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);

            return (
              sum +
              modelRdsMonthlyUsd(region, instanceType, deploymentOption, storageGb, nodeCount)
            );
          }, 0),
        );

        return {
          supported: true,
          monthlyUsd,
        };
      }
      case "amazonVirtualPrivateCloud": {
        const nat = service?.subServices?.[0]?.calculationComponents ?? {};

        return {
          supported: true,
          monthlyUsd: modelNatMonthlyUsd(
            region,
            parseNumericValue(nat.regionalNatGatewayCount?.value, 0),
            parseNumericValue(nat.regionalNatGatewayAzCount?.value, 0),
            parseNumericValue(nat.regionalNatGatewayDataProcessed?.value, 0),
          ),
        };
      }
      default:
        return {
          supported: false,
          monthlyUsd: serviceMonthlyUsd(service),
        };
    }
  } catch (error) {
    return {
      supported: false,
      monthlyUsd: serviceMonthlyUsd(service),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeModeling(services) {
  const comparisons = serviceEntries(services).map((service) => {
    const modeled = modeledServiceMonthlyUsd(service);
    return {
      serviceCode: service.serviceCode,
      region: service.region,
      storedMonthlyUsd: serviceMonthlyUsd(service),
      modeledMonthlyUsd: modeled.monthlyUsd,
      supported: modeled.supported,
      error: modeled.error ?? null,
    };
  });

  return {
    comparisons,
    storedMonthlyUsd: roundCurrency(
      comparisons.reduce((sum, comparison) => sum + comparison.storedMonthlyUsd, 0),
    ),
    modeledMonthlyUsd: roundCurrency(
      comparisons.reduce((sum, comparison) => sum + comparison.modeledMonthlyUsd, 0),
    ),
    unsupportedComparisons: comparisons.filter((comparison) => !comparison.supported),
    mismatchedComparisons: comparisons.filter(
      (comparison) =>
        comparison.supported &&
        Math.abs(comparison.storedMonthlyUsd - comparison.modeledMonthlyUsd) > 0.01,
    ),
  };
}

function makeCheck(name, status, details, blocking = true) {
  return {
    name,
    status,
    blocking,
    details,
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

function buildChecks({
  estimate,
  services,
  template,
  expectedMonthlyUsd,
  expectedRegion,
  budgetTolerancePct,
}) {
  const totalMonthlyUsd = roundCurrency(Number(estimate?.totalCost?.monthly ?? 0));
  const groupMonthlyUsd = roundCurrency(Number(estimate?.groupSubtotal?.monthly ?? 0));
  const regions = regionsFor(services);
  const serviceCodes = serviceCodesFor(services);
  const modeled = summarizeModeling(services);
  const supportedEnvironments = presentEnvironments(services);
  const missingEnvironments = ENVIRONMENTS.filter(
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
  const supportiveRatio = modeled.modeledMonthlyUsd > 0 ? supportiveUsd / modeled.modeledMonthlyUsd : 0;
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

  return [
    makeCheck(
      "services_present",
      Object.keys(services).length > 0 ? "pass" : "fail",
      `Found ${Object.keys(services).length} service entries.`,
    ),
    makeCheck(
      "known_service_formulas",
      modeled.unsupportedComparisons.length === 0 ? "pass" : "fail",
      modeled.unsupportedComparisons.length === 0
        ? "All service entries are covered by modeled pricing formulas."
        : `Unsupported service formulas: ${unsupportedDetails}.`,
    ),
    makeCheck(
      "stored_costs_match_modeled_costs",
      modeled.mismatchedComparisons.length === 0 ? "pass" : "fail",
      modeled.mismatchedComparisons.length === 0
        ? `Stored monthly ${modeled.storedMonthlyUsd.toFixed(2)} USD matches modeled monthly ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`
        : mismatchedDetails,
    ),
    makeCheck(
      "total_matches_modeled_sum",
      Math.abs(totalMonthlyUsd - modeled.modeledMonthlyUsd) <= 0.01 ? "pass" : "fail",
      `Top-level total ${totalMonthlyUsd.toFixed(2)} USD vs modeled sum ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
    ),
    makeCheck(
      "group_matches_modeled_sum",
      Math.abs(groupMonthlyUsd - modeled.modeledMonthlyUsd) <= 0.01 ? "pass" : "fail",
      `Group subtotal ${groupMonthlyUsd.toFixed(2)} USD vs modeled sum ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
    ),
    makeCheck(
      "single_region",
      regions.length === 1 ? "pass" : "fail",
      regions.length === 0 ? "No regions found." : `Regions: ${regions.join(", ")}.`,
    ),
    expectedRegion
      ? makeCheck(
          "expected_region",
          regions.length === 1 && regions[0] === expectedRegion ? "pass" : "fail",
          `Expected ${expectedRegion}; found ${regions.join(", ") || "none"}.`,
        )
      : makeCheck(
          "expected_region",
          "warning",
          "No expected region was supplied.",
          false,
        ),
    makeCheck(
      "required_services_present",
      template.requiredServiceCodes.every((serviceCode) => serviceCodes.includes(serviceCode))
        ? "pass"
        : "fail",
      `Required service codes: ${template.requiredServiceCodes.join(", ")}.`,
    ),
    makeCheck(
      "environment_coverage",
      missingEnvironments.length === 0 ? "pass" : "fail",
      missingEnvironments.length === 0
        ? `Primary services cover ${supportedEnvironments.join(", ")}.`
        : `Missing environments: ${missingEnvironments.join(", ")}.`,
    ),
    expectedComputeOs
      ? makeCheck(
          "compute_os_matches_template",
          ec2OperatingSystems.length === 1 && ec2OperatingSystems[0] === expectedComputeOs
            ? "pass"
            : "fail",
          `Expected compute OS ${expectedComputeOs}; found ${ec2OperatingSystems.join(", ") || "none"}.`,
        )
      : makeCheck(
          "compute_os_matches_template",
          "warning",
          "No expected compute OS was supplied.",
          false,
        ),
    makeCheck(
      "supportive_spend_reasonable",
      supportiveRatio <= template.supportiveMaxRatio ? "pass" : "fail",
      `Supportive spend ${percent(supportiveRatio)} vs max ${percent(template.supportiveMaxRatio)}.`,
    ),
    makeCheck(
      "primary_spend_dominant",
      primaryRatio >= template.primaryMinRatio ? "pass" : "fail",
      `Primary spend ${percent(primaryRatio)} vs min ${percent(template.primaryMinRatio)}.`,
    ),
    expectedMonthlyUsd == null
      ? makeCheck(
          "budget_within_tolerance",
          "warning",
          "No expected monthly budget was supplied.",
          false,
        )
      : makeCheck(
          "budget_within_tolerance",
          Math.abs(modeled.modeledMonthlyUsd - expectedMonthlyUsd) <= (toleranceUsd ?? 0)
            ? "pass"
            : "fail",
          `Expected ${expectedMonthlyUsd.toFixed(2)} USD within +/-${(toleranceUsd ?? 0).toFixed(2)} USD; modeled ${modeled.modeledMonthlyUsd.toFixed(2)} USD.`,
        ),
  ];
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
  const checks = buildChecks({
    estimate,
    services,
    template,
    expectedMonthlyUsd,
    expectedRegion,
    budgetTolerancePct,
  });
  const modeling = summarizeModeling(services);
  const hardFailures = checks
    .filter((check) => check.status === "fail" && check.blocking)
    .map((check) => `${check.name}: ${check.details}`);
  const warnings = checks
    .filter((check) => check.status === "warning")
    .map((check) => `${check.name}: ${check.details}`);
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

  return {
    templateId: template.id,
    templateTitle: template.title,
    expectedMonthlyUsd:
      expectedMonthlyUsd == null ? null : roundCurrency(Number(expectedMonthlyUsd)),
    storedMonthlyUsd: modeling.storedMonthlyUsd,
    modeledMonthlyUsd: modeling.modeledMonthlyUsd,
    expectedRegion: expectedRegion ?? null,
    regions: regionsFor(services),
    serviceCodes: serviceCodesFor(services),
    checks,
    hardFailures,
    warnings,
    assumptions,
    passed: hardFailures.length === 0,
  };
}
