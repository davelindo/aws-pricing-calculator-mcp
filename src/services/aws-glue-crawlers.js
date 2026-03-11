import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const GLUE_CRAWLER_SERVICE_CODE = "awsGlueCrawlers";
const GLUE_CRAWLER_ESTIMATE_FOR = "glueCrawlers";
const GLUE_CRAWLER_VERSION = "0.0.11";
const GLUE_CRAWLER_PRICING = {
  "us-east-1": {
    dpuPerHour: 0.44,
  },
};

function glueCrawlerPricingFor(region) {
  return scaledRegionalPricing(GLUE_CRAWLER_PRICING, region, "Glue crawler exact pricing");
}

function parseDurationHours(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "min";

  switch (unit) {
    case "sec":
      return numericValue / 3600;
    case "min":
      return numericValue / 60;
    case "hr":
      return numericValue;
    default:
      return numericValue;
  }
}

function glueCrawlerMonthlyUsd({ region, crawlerCount = 0, durationHours = 0 }) {
  return roundCurrency(
    Math.max(crawlerCount, 0) *
      Math.max(durationHours, 0) *
      glueCrawlerPricingFor(region).dpuPerHour,
  );
}

function glueCrawlerShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const crawlerCount =
    budget >= 4_000 ? 48 : budget >= 2_000 ? 24 : budget >= 1_000 ? 16 : budget >= 400 ? 8 : 4;
  const durationHours = Math.max(
    Math.min(roundCurrency(budget / (crawlerCount * glueCrawlerPricingFor(region).dpuPerHour)), 730),
    10 / 60,
  );
  const monthlyUsd = glueCrawlerMonthlyUsd({
    region,
    crawlerCount,
    durationHours,
  });

  return {
    crawlerCount,
    durationHours,
    monthlyUsd,
  };
}

export const awsGlueCrawlersService = {
  id: "aws-glue-crawlers",
  name: "AWS Glue Crawlers",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["glue crawler", "crawler", "catalog crawler"],
  pricingStrategies: ["crawler-runtime"],
  calculatorServiceCodes: [GLUE_CRAWLER_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = glueCrawlerShapeForBudget(region, monthlyBudgetUsd);
    const durationMinutes = Math.max(Math.round(profile.durationHours * 60), 10);
    const roundedDurationHours = roundCurrency(durationMinutes / 60);
    const monthlyUsd = glueCrawlerMonthlyUsd({
      region,
      crawlerCount: profile.crawlerCount,
      durationHours: roundedDurationHours,
    });

    return {
      key: `${GLUE_CRAWLER_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "aws-glue-crawlers",
        kind: GLUE_CRAWLER_SERVICE_CODE,
        label: "AWS Glue Crawlers",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.crawlerCount} crawlers, ${durationMinutes} minutes each per month`,
      },
      service: {
        calculationComponents: {
          numberOfDPU: {
            value: String(profile.crawlerCount),
          },
          durationForCrawl: {
            value: String(durationMinutes),
            unit: "min",
          },
        },
        serviceCode: GLUE_CRAWLER_SERVICE_CODE,
        region,
        estimateFor: GLUE_CRAWLER_ESTIMATE_FOR,
        version: GLUE_CRAWLER_VERSION,
        description: `AWS Glue crawler baseline. Environment: shared. ${profile.crawlerCount} crawlers at ${durationMinutes} minutes each per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Glue Crawlers",
        regionName: regionNameFor(region),
        configSummary: `Number of crawlers (${profile.crawlerCount}), Duration for each crawler (${durationMinutes} minutes)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.44,
    detail: (units) => `${Math.round(units)} Glue crawler DPU-hour equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return glueCrawlerMonthlyUsd({
      region: service?.region,
      crawlerCount: parseNumericValue(service?.calculationComponents?.numberOfDPU?.value, 0),
      durationHours: parseDurationHours(service?.calculationComponents?.durationForCrawl),
    });
  },
};
