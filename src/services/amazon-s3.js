import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const S3_STANDARD_PRICING = {
  "us-east-1": {
    storagePerGbMonth: 0.023,
    putPerThousand: 0.005,
    getPerThousand: 0.0004,
  },
};

function s3PricingFor(region) {
  return scaledRegionalPricing(S3_STANDARD_PRICING, region, "S3 exact pricing");
}

function s3MonthlyCost(region, storageGb, putRequests = 0, getRequests = 0) {
  const pricing = s3PricingFor(region);

  return roundCurrency(
    storageGb * pricing.storagePerGbMonth +
      (putRequests / 1000) * pricing.putPerThousand +
      (getRequests / 1000) * pricing.getPerThousand,
  );
}

function storageGbForBudget(region, monthlyBudgetUsd) {
  return roundCurrency(Number(monthlyBudgetUsd) / s3PricingFor(region).storagePerGbMonth);
}

export const amazonS3Service = {
  id: "amazon-s3",
  name: "Amazon S3",
  category: "storage",
  implementationStatus: "implemented",
  keywords: ["s3", "object storage", "bucket"],
  pricingStrategies: ["standard", "intelligent-tiering", "standard-ia"],
  calculatorServiceCodes: ["amazonS3"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const storageGb = storageGbForBudget(region, monthlyBudgetUsd);
    const putRequests = 0;
    const getRequests = 0;
    const monthlyUsd = s3MonthlyCost(region, storageGb, putRequests, getRequests);

    return {
      key: `amazonS3-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-s3",
        kind: "amazonS3Standard",
        label: "Amazon S3 Standard",
        category: "storage",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${storageGb} GB-month of S3 Standard storage`,
      },
      service: {
        calculationComponents: {
          s3Standard_generated_34: {
            value: String(storageGb),
            unit: "gb|NA",
          },
          s3Standard_generated_35: {
            value: String(putRequests),
          },
          s3Standard_generated_36: {
            value: String(getRequests),
          },
          s3Standard_generated_37: {
            value: "0",
            unit: "gb|NA",
          },
          s3Standard_generated_38: {
            value: "0",
            unit: "gb|NA",
          },
        },
        serviceCode: "amazonS3",
        region,
        estimateFor: "template_1",
        version: "0.0.36",
        description: `Amazon S3 Standard baseline. Environment: shared. ${storageGb} GB-month of S3 Standard storage.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Simple Storage Service (S3)",
        regionName: regionNameFor(region),
        configSummary: `S3 Standard Storage (${storageGb} GB per month), PUT/COPY/POST/LIST requests (${putRequests}), GET/SELECT and other similar requests (${getRequests})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.023,
    detail: (units) => `${Math.round(units)} GB-month of standard storage`,
  }),
  modelSavedMonthlyUsd(service) {
    const storageGb = parseNumericValue(
      service?.calculationComponents?.s3Standard_generated_34?.value,
      0,
    );
    const putRequests = parseNumericValue(
      service?.calculationComponents?.s3Standard_generated_35?.value,
      0,
    );
    const getRequests = parseNumericValue(
      service?.calculationComponents?.s3Standard_generated_36?.value,
      0,
    );

    return s3MonthlyCost(service?.region, storageGb, putRequests, getRequests);
  },
};
