import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const ATHENA_SERVICE_CODE = "amazonAthena";
const ATHENA_ESTIMATE_FOR = "Athena";
const ATHENA_VERSION = "0.0.118";
const ATHENA_PRICING = {
  "us-east-1": {
    queryPerTb: 5,
    dpuPerHour: 0.3,
  },
};

function athenaPricingFor(region) {
  return scaledRegionalPricing(ATHENA_PRICING, region, "Athena exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? component?.value?.selectedId ?? "perMonth";

  switch (unit) {
    case "perSecond":
      return numericValue * 730 * 60 * 60;
    case "perMinute":
      return numericValue * 730 * 60;
    case "perHour":
      return numericValue * 730;
    case "perDay":
      return numericValue * 30.4167;
    case "perWeek":
      return numericValue * (365 / 12 / 7);
    case "perMonth":
    default:
      return numericValue;
  }
}

function parseDurationHours(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "hr";

  switch (unit) {
    case "min":
      return numericValue / 60;
    case "sec":
      return numericValue / 3600;
    case "hr":
    default:
      return numericValue;
  }
}

function parseFileSizeTb(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const [sizeUnit] = String(component.unit ?? "tb|NA").split("|");

  switch (sizeUnit) {
    case "gb":
      return numericValue / 1024;
    case "mb":
      return numericValue / (1024 * 1024);
    case "tb":
    default:
      return numericValue;
  }
}

function athenaMonthlyUsd({
  region,
  queriesPerMonth,
  dataScannedPerQueryTb,
  dpuCount = 0,
  dpuHours = 0,
}) {
  const pricing = athenaPricingFor(region);

  return roundCurrency(
    Math.max(queriesPerMonth, 0) * Math.max(dataScannedPerQueryTb, 0) * pricing.queryPerTb +
      Math.max(dpuCount, 0) * Math.max(dpuHours, 0) * pricing.dpuPerHour,
  );
}

function athenaShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const averageScanPerQueryGb = budget >= 4_000 ? 40 : budget >= 1_500 ? 25 : 10;
  const queryBudgetUsd = budget >= 3_000 ? budget * 0.85 : budget;
  const dpuBudgetUsd = Math.max(budget - queryBudgetUsd, 0);
  const dataScannedPerQueryTb = averageScanPerQueryGb / 1024;
  const queryCostPerExecutionUsd = dataScannedPerQueryTb * athenaPricingFor(region).queryPerTb;
  const queriesPerMonth =
    queryCostPerExecutionUsd > 0
      ? Math.max(Math.round(queryBudgetUsd / queryCostPerExecutionUsd), 1)
      : 0;
  const dpuCount = dpuBudgetUsd > 0 ? 8 : 0;
  const dpuHours =
    dpuCount > 0
      ? Math.max(roundCurrency(dpuBudgetUsd / (dpuCount * athenaPricingFor(region).dpuPerHour)), 1)
      : 0;
  const monthlyUsd = athenaMonthlyUsd({
    region,
    queriesPerMonth,
    dataScannedPerQueryTb,
    dpuCount,
    dpuHours,
  });

  return {
    queriesPerMonth,
    averageScanPerQueryGb,
    dpuCount,
    dpuHours,
    monthlyUsd,
  };
}

export const amazonAthenaService = {
  id: "amazon-athena",
  name: "Amazon Athena",
  category: "analytics",
  implementationStatus: "implemented",
  keywords: ["athena", "sql query", "query lake"],
  pricingStrategies: ["per-query", "capacity"],
  calculatorServiceCodes: [ATHENA_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = athenaShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${ATHENA_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-athena",
        kind: ATHENA_SERVICE_CODE,
        label: "Amazon Athena",
        category: "analytics",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.queriesPerMonth.toLocaleString("en-US")} queries/month, ${profile.averageScanPerQueryGb} GB scanned/query${profile.dpuCount > 0 ? `, ${profile.dpuCount} provisioned DPUs for ${profile.dpuHours} hours/month` : ""}`,
      },
      service: {
        calculationComponents: {
          numberOfQueries: {
            value: String(profile.queriesPerMonth),
            unit: "perMonth",
          },
          dataScannedPerQuery: {
            value: String(profile.averageScanPerQueryGb),
            unit: "gb|NA",
          },
          numberOfDPUs: {
            value: String(profile.dpuCount),
          },
          LengthOfDPU: {
            value: String(profile.dpuHours),
            unit: "hr",
          },
        },
        serviceCode: ATHENA_SERVICE_CODE,
        region,
        estimateFor: ATHENA_ESTIMATE_FOR,
        version: ATHENA_VERSION,
        description: `Amazon Athena analytics baseline. Environment: shared. ${profile.queriesPerMonth.toLocaleString("en-US")} SQL queries per month scanning ${profile.averageScanPerQueryGb} GB per query.${profile.dpuCount > 0 ? ` Provisioned capacity: ${profile.dpuCount} DPUs for ${profile.dpuHours} hours per month.` : ""}${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Athena",
        regionName: regionNameFor(region),
        configSummary: `Total number of queries (${profile.queriesPerMonth.toLocaleString("en-US")} per month), Amount of data scanned per query (${profile.averageScanPerQueryGb} GB), Number of DPUs (${profile.dpuCount}), Length of time capacity is active (${profile.dpuHours} hours per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 5,
    detail: (units) => `${Math.round(units)} TB scanned per month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return athenaMonthlyUsd({
      region: service?.region,
      queriesPerMonth: parseFrequencyValue(service?.calculationComponents?.numberOfQueries),
      dataScannedPerQueryTb: parseFileSizeTb(service?.calculationComponents?.dataScannedPerQuery),
      dpuCount: parseNumericValue(service?.calculationComponents?.numberOfDPUs?.value, 0),
      dpuHours: parseDurationHours(service?.calculationComponents?.LengthOfDPU),
    });
  },
};
