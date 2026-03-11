import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const SNS_STANDARD_PRICING = {
  "us-east-1": {
    requestPerRequest: 0.5 / 1_000_000,
    freeRequests: 1_000_000,
  },
};

function snsPricingFor(region) {
  return scaledRegionalPricing(SNS_STANDARD_PRICING, region, "SNS exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "millionPerMonth":
      return numericValue * 1_000_000;
    case "perMonth":
    default:
      return numericValue;
  }
}

function snsMonthlyCost({
  region,
  requestCount,
}) {
  const pricing = snsPricingFor(region);
  const billableRequests = Math.max(Math.max(Number(requestCount) || 0, 0) - pricing.freeRequests, 0);

  return roundCurrency(billableRequests * pricing.requestPerRequest);
}

function snsRequestCountForBudget(region, monthlyBudgetUsd) {
  const pricing = snsPricingFor(region);
  const budget = Math.max(Number(monthlyBudgetUsd) || 0, 0);

  if (budget <= 0) {
    return 0;
  }

  return pricing.freeRequests + Math.ceil(budget / pricing.requestPerRequest);
}

export const amazonSnsService = {
  id: "amazon-sns",
  name: "Amazon SNS",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["sns", "topic", "pubsub"],
  pricingStrategies: ["standard", "fifo"],
  calculatorServiceCodes: ["standardTopics"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const requestCount = snsRequestCountForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = snsMonthlyCost({
      region,
      requestCount,
    });

    return {
      key: `standardTopics-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-sns",
        kind: "standardTopics",
        label: "Amazon SNS",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${requestCount.toLocaleString("en-US")} standard-topic API requests per month`,
      },
      service: {
        calculationComponents: {
          numberOfRequests: {
            value: String(requestCount),
            unit: "perMonth",
          },
          numberOfSQSNotifications: {
            value: "0",
            unit: "perMonth",
          },
        },
        serviceCode: "standardTopics",
        region,
        estimateFor: "sns_t1",
        version: "0.0.64",
        description: `Amazon SNS standard-topic baseline. Environment: shared. ${requestCount.toLocaleString("en-US")} API requests per month with SQS deliveries disabled in the estimate.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Standard topics",
        regionName: regionNameFor(region),
        configSummary: `Requests (${requestCount.toLocaleString("en-US")} per month), SQS Notifications (0 per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.5,
    detail: (units) => `${Math.round(units)} million publish units`,
  }),
  modelSavedMonthlyUsd(service) {
    return snsMonthlyCost({
      region: service?.region,
      requestCount: parseFrequencyValue(service?.calculationComponents?.numberOfRequests),
    });
  },
};
