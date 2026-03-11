import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const LAMBDA_PRICING = {
  "us-east-1": {
    requestPerInvocation: 0.0000002,
    durationPerGbSecond: 0.0000166667,
    durationPerGbSecondArm: 0.0000133334,
    storagePerGbSecond: 0.0000000309,
  },
};
const LAMBDA_REQUEST_CANDIDATES = [
  100_000,
  500_000,
  1_000_000,
  5_000_000,
  10_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
  250_000_000,
  500_000_000,
  1_000_000_000,
];
const LAMBDA_MEMORY_MB = 1024;
const LAMBDA_STORAGE_MB = 512;
const LAMBDA_MAX_DURATION_MS = 900_000;

function lambdaPricingFor(region) {
  return scaledRegionalPricing(LAMBDA_PRICING, region, "Lambda exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

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

function parseMemoryGb(component, defaultMb) {
  if (!component || typeof component !== "object") {
    return defaultMb / 1024;
  }

  const numericValue = parseNumericValue(component.value, defaultMb);
  const [sizeUnit] = String(component.unit ?? "mb|NA").split("|");

  switch (sizeUnit) {
    case "gb":
      return numericValue;
    case "kb":
      return numericValue / (1024 * 1024);
    case "mb":
    default:
      return numericValue / 1024;
  }
}

function lambdaMonthlyCost({
  region,
  requestCount,
  durationMs,
  memoryGb,
  storageGb,
  architecture = "x86",
}) {
  const pricing = lambdaPricingFor(region);
  const requestCost = Math.max(Number(requestCount) || 0, 0) * pricing.requestPerInvocation;
  const durationRate =
    architecture === "arm" ? pricing.durationPerGbSecondArm : pricing.durationPerGbSecond;
  const durationGbSeconds =
    Math.max(Number(requestCount) || 0, 0) * (Math.max(Number(durationMs) || 0, 0) / 1000) * memoryGb;
  const storageGbSeconds =
    Math.max(Number(requestCount) || 0, 0) *
    (Math.max(Number(durationMs) || 0, 0) / 1000) *
    Math.max(storageGb - 0.5, 0);

  return roundCurrency(
    requestCost + durationGbSeconds * durationRate + storageGbSeconds * pricing.storagePerGbSecond,
  );
}

function lambdaShapeForBudget(region, monthlyBudgetUsd) {
  const pricing = lambdaPricingFor(region);
  const memoryGb = LAMBDA_MEMORY_MB / 1024;

  for (const requestCount of LAMBDA_REQUEST_CANDIDATES) {
    const requestCost = requestCount * pricing.requestPerInvocation;

    if (requestCost > monthlyBudgetUsd) {
      continue;
    }

    const durationMs = Math.round(
      (Number(monthlyBudgetUsd) - requestCost) /
        (requestCount * memoryGb * (pricing.durationPerGbSecond / 1000)),
    );

    if (durationMs >= 1 && durationMs <= LAMBDA_MAX_DURATION_MS) {
      return {
        requestCount,
        durationMs,
      };
    }
  }

  return {
    requestCount: LAMBDA_REQUEST_CANDIDATES[0],
    durationMs: 1,
  };
}

export const amazonLambdaService = {
  id: "amazon-lambda",
  name: "AWS Lambda",
  category: "compute",
  implementationStatus: "implemented",
  keywords: ["lambda", "serverless", "function"],
  pricingStrategies: ["on-demand", "compute-savings-plans"],
  calculatorServiceCodes: ["aWSLambda"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const { requestCount, durationMs } = lambdaShapeForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = lambdaMonthlyCost({
      region,
      requestCount,
      durationMs,
      memoryGb: LAMBDA_MEMORY_MB / 1024,
      storageGb: LAMBDA_STORAGE_MB / 1024,
    });

    return {
      key: `aWSLambda-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-lambda",
        kind: "aWSLambda",
        label: "AWS Lambda",
        category: "compute",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${requestCount.toLocaleString("en-US")} requests per month, ${durationMs} ms average duration, ${LAMBDA_MEMORY_MB} MB memory`,
      },
      service: {
        calculationComponents: {
          selectArchitectureRequests: {
            value: "1",
          },
          numberOfRequests: {
            value: String(requestCount),
            unit: "perMonth",
          },
          durationOfEachRequest: {
            value: String(durationMs),
          },
          sizeOfMemoryAllocated: {
            value: String(LAMBDA_MEMORY_MB),
            unit: "mb|NA",
          },
          storageAmountEphemeral: {
            value: String(LAMBDA_STORAGE_MB),
            unit: "mb|NA",
          },
        },
        serviceCode: "aWSLambda",
        region,
        estimateFor: "lambdaWithoutFreeTier",
        version: "0.0.145",
        description: `AWS Lambda baseline. Environment: shared. ${requestCount.toLocaleString("en-US")} requests per month, ${durationMs} ms average duration, ${LAMBDA_MEMORY_MB} MB memory.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Lambda",
        regionName: regionNameFor(region),
        configSummary: `Architecture (x86), Number of requests (${requestCount.toLocaleString("en-US")} per month), Duration of each request (${durationMs} ms), Amount of memory allocated (${LAMBDA_MEMORY_MB} MB), Amount of ephemeral storage allocated (${LAMBDA_STORAGE_MB} MB)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 2.5,
    detail: (units) => `${Math.round(units)} million request-equivalent units`,
  }),
  modelSavedMonthlyUsd(service) {
    const architecture = String(
      service?.calculationComponents?.selectArchitectureRequests?.value ?? "1",
    ) === "2"
      ? "arm"
      : "x86";
    const requestCount = parseFrequencyValue(service?.calculationComponents?.numberOfRequests);
    const durationMs = parseNumericValue(
      service?.calculationComponents?.durationOfEachRequest?.value,
      0,
    );
    const memoryGb = parseMemoryGb(service?.calculationComponents?.sizeOfMemoryAllocated, LAMBDA_MEMORY_MB);
    const storageGb = parseMemoryGb(
      service?.calculationComponents?.storageAmountEphemeral,
      LAMBDA_STORAGE_MB,
    );

    return lambdaMonthlyCost({
      region: service?.region,
      requestCount,
      durationMs,
      memoryGb,
      storageGb,
      architecture,
    });
  },
};
