import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const WEEKS_PER_MONTH = 30.4167 / 7;
const SQS_PRICING = {
  "us-east-1": {
    standardTiers: [
      { upperRequests: 100_000_000_000, ratePerRequest: 0.4 / 1_000_000 },
      { upperRequests: 200_000_000_000, ratePerRequest: 0.3 / 1_000_000 },
      { upperRequests: Number.POSITIVE_INFINITY, ratePerRequest: 0.24 / 1_000_000 },
    ],
    fifoTiers: [
      { upperRequests: 100_000_000_000, ratePerRequest: 0.5 / 1_000_000 },
      { upperRequests: 200_000_000_000, ratePerRequest: 0.4 / 1_000_000 },
      { upperRequests: Number.POSITIVE_INFINITY, ratePerRequest: 0.35 / 1_000_000 },
    ],
  },
};

function sqsPricingFor(region) {
  return scaledRegionalPricing(SQS_PRICING, region, "SQS exact pricing");
}

function parseMillionFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "perDay":
      return numericValue * 1_000_000 * 30.4167;
    case "perWeek":
      return numericValue * 1_000_000 * WEEKS_PER_MONTH;
    case "perMonth":
    default:
      return numericValue * 1_000_000;
  }
}

function tieredRequestCostUsd(requestCount, tiers) {
  let remainingRequests = Math.max(Number(requestCount) || 0, 0);
  let previousUpperRequests = 0;
  let total = 0;

  for (const tier of tiers) {
    if (remainingRequests <= 0) {
      break;
    }

    const tierSpanRequests =
      tier.upperRequests === Number.POSITIVE_INFINITY
        ? remainingRequests
        : Math.min(remainingRequests, tier.upperRequests - previousUpperRequests);

    total += tierSpanRequests * tier.ratePerRequest;
    remainingRequests -= tierSpanRequests;
    previousUpperRequests = tier.upperRequests;
  }

  return total;
}

function sqsMonthlyCost({
  region,
  standardRequestCount,
  fifoRequestCount,
}) {
  const pricing = sqsPricingFor(region);

  return roundCurrency(
    tieredRequestCostUsd(standardRequestCount, pricing.standardTiers) +
      tieredRequestCostUsd(fifoRequestCount, pricing.fifoTiers),
  );
}

function standardQueueRequestsForBudget(region, monthlyBudgetUsd) {
  const pricing = sqsPricingFor(region);
  return roundCurrency(
    Math.max(Number(monthlyBudgetUsd) || 0, 0) / pricing.standardTiers[0].ratePerRequest / 1_000_000,
  );
}

export const amazonSqsService = {
  id: "amazon-sqs",
  name: "Amazon SQS",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["sqs", "queue"],
  pricingStrategies: ["standard", "fifo"],
  calculatorServiceCodes: ["amazonSimpleQueueService"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const standardQueueRequests = standardQueueRequestsForBudget(region, monthlyBudgetUsd);
    const fifoQueueRequests = 0;
    const monthlyUsd = sqsMonthlyCost({
      region,
      standardRequestCount: standardQueueRequests * 1_000_000,
      fifoRequestCount: 0,
    });

    return {
      key: `amazonSimpleQueueService-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-sqs",
        kind: "amazonSimpleQueueService",
        label: "Amazon SQS",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${standardQueueRequests} million standard queue requests per month`,
      },
      service: {
        calculationComponents: {
          standardQueueRequests: {
            value: String(standardQueueRequests),
            unit: "perMonth",
          },
          fifoQueueRequests: {
            value: String(fifoQueueRequests),
            unit: "perMonth",
          },
        },
        serviceCode: "amazonSimpleQueueService",
        region,
        estimateFor: "simpleQueueService",
        version: "0.0.47",
        description: `Amazon SQS standard queue baseline. Environment: shared. ${standardQueueRequests} million standard queue requests per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Simple Queue Service (SQS)",
        regionName: regionNameFor(region),
        configSummary: `Standard queue requests (${standardQueueRequests} million per month), FIFO queue requests (${fifoQueueRequests} million per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.4,
    detail: (units) => `${Math.round(units)} million queue requests`,
  }),
  modelSavedMonthlyUsd(service) {
    return sqsMonthlyCost({
      region: service?.region,
      standardRequestCount: parseMillionFrequencyValue(
        service?.calculationComponents?.standardQueueRequests,
      ),
      fifoRequestCount: parseMillionFrequencyValue(service?.calculationComponents?.fifoQueueRequests),
    });
  },
};
