import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const CLOUDFRONT_US_PRICING = {
  internetTiers: [
    { upperGb: 10_240, rate: 0.085 },
    { upperGb: 51_200, rate: 0.08 },
    { upperGb: 153_600, rate: 0.06 },
    { upperGb: 512_000, rate: 0.04 },
    { upperGb: 1_048_576, rate: 0.03 },
    { upperGb: 5_242_880, rate: 0.025 },
    { upperGb: Number.POSITIVE_INFINITY, rate: 0.02 },
  ],
  originPerGb: 0.02,
  httpsRequest: 0.000001,
};
const DEFAULT_INTERNET_ALLOCATION = 0.65;
const DEFAULT_ORIGIN_ALLOCATION = 0.15;
const MAX_PRIMARY_INTERNET_GB = 9_000;

function cloudfrontPricingFor(region) {
  return scaledRegionalPricing({ "us-east-1": CLOUDFRONT_US_PRICING }, region, "CloudFront exact pricing");
}

function parseTransferGb(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const [sizeUnit] = String(component.unit ?? "gb|month").split("|");

  switch (sizeUnit) {
    case "pb":
      return numericValue * 1024 * 1024;
    case "tb":
      return numericValue * 1024;
    case "gb":
    default:
      return numericValue;
  }
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

function internetTransferCostUsd(pricing, internetGb) {
  let remainingGb = Math.max(Number(internetGb) || 0, 0);
  let previousUpperGb = 0;
  let total = 0;

  for (const tier of pricing.internetTiers) {
    if (remainingGb <= 0) {
      break;
    }

    const tierSpanGb =
      tier.upperGb === Number.POSITIVE_INFINITY
        ? remainingGb
        : Math.min(remainingGb, tier.upperGb - previousUpperGb);

    total += tierSpanGb * tier.rate;
    remainingGb -= tierSpanGb;
    previousUpperGb = tier.upperGb;
  }

  return total;
}

function cloudfrontMonthlyCost({
  region,
  internetGb,
  originGb,
  httpsRequestCount,
}) {
  const pricing = cloudfrontPricingFor(region);

  return roundCurrency(
    internetTransferCostUsd(pricing, internetGb) +
      Math.max(Number(originGb) || 0, 0) * pricing.originPerGb +
      Math.max(Number(httpsRequestCount) || 0, 0) * pricing.httpsRequest,
  );
}

function cloudfrontShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(Number(monthlyBudgetUsd) || 0, 0);
  const pricing = cloudfrontPricingFor(region);
  const maxPrimaryInternetCost = internetTransferCostUsd(pricing, MAX_PRIMARY_INTERNET_GB);
  const internetBudget = Math.min(budget * DEFAULT_INTERNET_ALLOCATION, maxPrimaryInternetCost);
  const internetGb = Math.max(Math.floor(internetBudget / pricing.internetTiers[0].rate), 0);
  const internetCost = cloudfrontMonthlyCost({
    region,
    internetGb,
    originGb: 0,
    httpsRequestCount: 0,
  });
  const remainingAfterInternet = Math.max(budget - internetCost, 0);
  const originBudget = Math.min(budget * DEFAULT_ORIGIN_ALLOCATION, remainingAfterInternet);
  const originGb = Math.max(Math.floor(originBudget / pricing.originPerGb), 0);
  const originCost = originGb * pricing.originPerGb;
  const remainingAfterTransfer = Math.max(budget - internetCost - originCost, 0);
  const httpsRequestCount = Math.max(Math.round(remainingAfterTransfer / pricing.httpsRequest), 0);

  return {
    internetGb,
    originGb,
    httpsRequestCount,
  };
}

export const amazonCloudfrontService = {
  id: "amazon-cloudfront",
  name: "Amazon CloudFront",
  category: "edge",
  implementationStatus: "implemented",
  keywords: ["cloudfront", "cdn", "edge"],
  pricingStrategies: ["standard", "cache-heavy"],
  calculatorServiceCodes: ["amazonCloudFront"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const { internetGb, originGb, httpsRequestCount } = cloudfrontShapeForBudget(
      region,
      monthlyBudgetUsd,
    );
    const monthlyUsd = cloudfrontMonthlyCost({
      region,
      internetGb,
      originGb,
      httpsRequestCount,
    });

    return {
      key: `amazonCloudFront-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-cloudfront",
        kind: "amazonCloudFront",
        label: "Amazon CloudFront",
        category: "edge",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${internetGb.toLocaleString("en-US")} GB internet delivery, ${originGb.toLocaleString("en-US")} GB origin delivery, ${httpsRequestCount.toLocaleString("en-US")} HTTPS requests per month`,
      },
      service: {
        calculationComponents: {
          dataTransferedToInternet_US: {
            value: String(internetGb),
            unit: "gb|month",
          },
          dataTransferedToOrigin_US: {
            value: String(originGb),
            unit: "gb|month",
          },
          numberOfHttpsRequests_US: {
            value: String(httpsRequestCount),
            unit: "perMonth",
          },
        },
        serviceCode: "amazonCloudFront",
        region,
        estimateFor: "CDN",
        version: "0.0.45",
        description: `Amazon CloudFront baseline. Environment: shared. United States edge delivery with ${internetGb.toLocaleString("en-US")} GB internet transfer, ${originGb.toLocaleString("en-US")} GB origin transfer, and ${httpsRequestCount.toLocaleString("en-US")} HTTPS requests per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon CloudFront",
        regionName: regionNameFor(region),
        configSummary: `Data transfer out to internet (${internetGb.toLocaleString("en-US")} GB per month), Data transfer out to origin (${originGb.toLocaleString("en-US")} GB per month), Number of requests (HTTPS) (${httpsRequestCount.toLocaleString("en-US")} per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.085,
    detail: (units) => `${Math.round(units)} GB of edge data transfer`,
  }),
  modelSavedMonthlyUsd(service) {
    return cloudfrontMonthlyCost({
      region: service?.region,
      internetGb: parseTransferGb(service?.calculationComponents?.dataTransferedToInternet_US),
      originGb: parseTransferGb(service?.calculationComponents?.dataTransferedToOrigin_US),
      httpsRequestCount: parseFrequencyValue(
        service?.calculationComponents?.numberOfHttpsRequests_US,
      ),
    });
  },
};
