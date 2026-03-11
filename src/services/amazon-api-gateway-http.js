import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const API_GATEWAY_HTTP_PRICING = {
  "us-east-1": {
    first300MillionPerRequest: 0.000001,
    over300MillionPerRequest: 0.0000009,
  },
};
const KB_PER_BILLABLE_REQUEST = 512;
const HTTP_API_REQUEST_MULTIPLIER = 1_000_000;

function apiGatewayPricingFor(region) {
  return scaledRegionalPricing(API_GATEWAY_HTTP_PRICING, region, "API Gateway exact pricing");
}

function billedHttpApiRequests(requestCount, requestSizeKb) {
  const multiplier = Math.max(Math.ceil(Math.max(requestSizeKb, 1) / KB_PER_BILLABLE_REQUEST), 1);
  return Math.max(Math.trunc(Number(requestCount) || 0), 0) * multiplier;
}

function httpApiMonthlyCost(region, requestCount, requestSizeKb = 1) {
  const pricing = apiGatewayPricingFor(region);
  const requests = billedHttpApiRequests(requestCount, requestSizeKb);
  const first300Million = Math.min(requests, 300_000_000);
  const over300Million = Math.max(requests - 300_000_000, 0);

  return roundCurrency(
    first300Million * pricing.first300MillionPerRequest +
      over300Million * pricing.over300MillionPerRequest,
  );
}

function httpApiRequestCountForBudget(region, monthlyBudgetUsd, requestSizeKb = 1) {
  const pricing = apiGatewayPricingFor(region);
  const multiplier = Math.max(Math.ceil(Math.max(requestSizeKb, 1) / KB_PER_BILLABLE_REQUEST), 1);
  const remainingBudget = Math.max(Number(monthlyBudgetUsd) || 0, 0);
  const first300MillionCost = 300_000_000 * pricing.first300MillionPerRequest;

  if (remainingBudget <= first300MillionCost) {
    return Math.max(Math.floor(remainingBudget / pricing.first300MillionPerRequest / multiplier), 0);
  }

  return Math.max(
    Math.floor(300_000_000 / multiplier) +
      Math.floor(
        (remainingBudget - first300MillionCost) / pricing.over300MillionPerRequest / multiplier,
      ),
    0,
  );
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
    case "perMonth":
    default:
      return numericValue;
  }
}

export const amazonApiGatewayHttpService = {
  id: "amazon-api-gateway-http",
  name: "Amazon API Gateway",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["api gateway", "http api", "rest api"],
  pricingStrategies: ["http-api", "rest-api"],
  calculatorServiceCodes: ["amazonApiGateway"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const requestSizeKb = 1;
    const requestCount = httpApiRequestCountForBudget(region, monthlyBudgetUsd, requestSizeKb);
    const requestCountInMillions = roundCurrency(requestCount / HTTP_API_REQUEST_MULTIPLIER);
    const monthlyUsd = httpApiMonthlyCost(region, requestCount, requestSizeKb);

    return {
      key: `amazonApiGateway-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-api-gateway-http",
        kind: "amazonApiGatewayHttp",
        label: "Amazon API Gateway",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${requestCountInMillions} million HTTP API requests per month at ${requestSizeKb} KB per request`,
      },
      service: {
        calculationComponents: {
          APIOpsMult: {
            value: String(HTTP_API_REQUEST_MULTIPLIER),
          },
          numberOfAPIRequests: {
            value: String(requestCountInMillions),
            unit: "perMonth",
          },
          dataPerRequest: {
            value: String(requestSizeKb),
            unit: "kb|NA",
          },
        },
        serviceCode: "amazonApiGateway",
        region,
        estimateFor: "template",
        version: "0.0.59",
        description: `Amazon API Gateway HTTP API baseline. Environment: shared. ${requestCountInMillions} million requests per month at ${requestSizeKb} KB per request.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon API Gateway",
        regionName: regionNameFor(region),
        configSummary: `HTTP API requests units (millions), Requests (${requestCountInMillions} per month), Average size of each request (${requestSizeKb} KB)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 1,
    detail: (units) => `${Math.round(units)} million HTTP API requests`,
  }),
  modelSavedMonthlyUsd(service) {
    const requestMultiplier = parseNumericValue(
      service?.calculationComponents?.APIOpsMult?.value,
      HTTP_API_REQUEST_MULTIPLIER,
    );
    const requestCount = parseFrequencyValue(service?.calculationComponents?.numberOfAPIRequests);
    const requestSizeKb = parseNumericValue(service?.calculationComponents?.dataPerRequest?.value, 1);

    return httpApiMonthlyCost(
      service?.region,
      requestCount * requestMultiplier,
      requestSizeKb,
    );
  },
};
