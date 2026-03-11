import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const CLOUDWATCH_METRIC_TIERS = {
  "us-east-1": [
    { upTo: 10_000, pricePerMetric: 0.3 },
    { upTo: 250_000, pricePerMetric: 0.1 },
    { upTo: 1_000_000, pricePerMetric: 0.05 },
    { upTo: Number.POSITIVE_INFINITY, pricePerMetric: 0.02 },
  ],
};

function metricTiersFor(region) {
  return scaledRegionalPricing(CLOUDWATCH_METRIC_TIERS, region, "CloudWatch exact pricing");
}

function cloudwatchMetricsMonthlyCost(region, metricCount) {
  let remaining = Math.max(Math.trunc(Number(metricCount) || 0), 0);
  let previousUpperBound = 0;
  let total = 0;

  for (const tier of metricTiersFor(region)) {
    if (remaining <= 0) {
      break;
    }

    const tierCapacity =
      tier.upTo === Number.POSITIVE_INFINITY ? remaining : tier.upTo - previousUpperBound;
    const unitsInTier = Math.min(remaining, tierCapacity);
    total += unitsInTier * tier.pricePerMetric;
    remaining -= unitsInTier;
    previousUpperBound = tier.upTo;
  }

  return roundCurrency(total);
}

function metricCountForBudget(region, monthlyBudgetUsd) {
  let remainingBudget = Math.max(Number(monthlyBudgetUsd) || 0, 0);
  let previousUpperBound = 0;
  let metricCount = 0;

  for (const tier of metricTiersFor(region)) {
    if (remainingBudget <= 0) {
      break;
    }

    const tierCapacity =
      tier.upTo === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : tier.upTo - previousUpperBound;
    const affordableInTier = Math.floor(remainingBudget / tier.pricePerMetric);
    const metricsInTier = Math.min(affordableInTier, tierCapacity);

    metricCount += metricsInTier;
    remainingBudget = roundCurrency(remainingBudget - metricsInTier * tier.pricePerMetric);
    previousUpperBound = tier.upTo;

    if (metricsInTier < tierCapacity) {
      break;
    }
  }

  return Math.max(metricCount, 1);
}

export const amazonCloudwatchService = {
  id: "amazon-cloudwatch",
  name: "Amazon CloudWatch",
  category: "operations",
  implementationStatus: "implemented",
  keywords: ["cloudwatch", "logging", "monitoring"],
  pricingStrategies: ["standard"],
  calculatorServiceCodes: ["amazonCloudWatch"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const metricCount = metricCountForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = cloudwatchMetricsMonthlyCost(region, metricCount);

    return {
      key: `amazonCloudWatch-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-cloudwatch",
        kind: "amazonCloudWatchMetrics",
        label: "Amazon CloudWatch",
        category: "operations",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${metricCount} custom/detailed metrics per month`,
      },
      service: {
        calculationComponents: {
          totalNumberOfMetrics: {
            value: String(metricCount),
          },
        },
        serviceCode: "amazonCloudWatch",
        region,
        estimateFor: "CloudWatch",
        version: "0.0.140",
        description: `Amazon CloudWatch baseline. Environment: shared. ${metricCount} custom/detailed metrics.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon CloudWatch",
        regionName: regionNameFor(region),
        configSummary: `Number of Metrics (includes detailed and custom metrics) (${metricCount})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.5,
    detail: (units) => `${Math.round(units)} GB of logs / monitoring ingest`,
  }),
  modelSavedMonthlyUsd(service) {
    const metricCount = parseNumericValue(
      service?.calculationComponents?.totalNumberOfMetrics?.value,
      0,
    );

    return cloudwatchMetricsMonthlyCost(service?.region, metricCount);
  },
};
