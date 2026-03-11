import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const GLUE_CATALOG_SERVICE_CODE = "awsGlueDataCatalogStorageRequests";
const GLUE_CATALOG_ESTIMATE_FOR = "glueDataCatalog";
const GLUE_CATALOG_VERSION = "0.0.11";
const GLUE_CATALOG_PRICING = {
  "us-east-1": {
    storagePerMillionObjectsMonth: 10,
    requestsPerMillionMonth: 1,
  },
};

function glueCatalogPricingFor(region) {
  return scaledRegionalPricing(
    GLUE_CATALOG_PRICING,
    region,
    "Glue Data Catalog exact pricing",
  );
}

function parseFrequencyMillions(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "perHour":
      return numericValue * 730;
    case "perMonth":
    default:
      return numericValue;
  }
}

function glueCatalogMonthlyUsd({ region, objectsMillions = 0, requestsMillions = 0 }) {
  const pricing = glueCatalogPricingFor(region);

  return roundCurrency(
    Math.max(objectsMillions, 0) * pricing.storagePerMillionObjectsMonth +
      Math.max(requestsMillions, 0) * pricing.requestsPerMillionMonth,
  );
}

function glueCatalogShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const storageBudgetUsd = budget * 0.7;
  const requestBudgetUsd = budget - storageBudgetUsd;
  const pricing = glueCatalogPricingFor(region);
  const objectsMillions = roundCurrency(
    storageBudgetUsd / pricing.storagePerMillionObjectsMonth,
  );
  const requestsMillions = roundCurrency(
    requestBudgetUsd / pricing.requestsPerMillionMonth,
  );
  const monthlyUsd = glueCatalogMonthlyUsd({
    region,
    objectsMillions,
    requestsMillions,
  });

  return {
    objectsMillions,
    requestsMillions,
    monthlyUsd,
  };
}

export const awsGlueDataCatalogService = {
  id: "aws-glue-data-catalog",
  name: "AWS Glue Data Catalog",
  category: "metadata",
  implementationStatus: "implemented",
  keywords: ["glue catalog", "data catalog", "metadata catalog"],
  pricingStrategies: ["metadata-storage", "request-driven"],
  calculatorServiceCodes: [GLUE_CATALOG_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = glueCatalogShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${GLUE_CATALOG_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "aws-glue-data-catalog",
        kind: GLUE_CATALOG_SERVICE_CODE,
        label: "AWS Glue Data Catalog",
        category: "metadata",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.objectsMillions}M objects stored, ${profile.requestsMillions}M access requests/month`,
      },
      service: {
        calculationComponents: {
          numberOfObjectsStored: {
            value: String(profile.objectsMillions),
            unit: "perMonth",
          },
          numberOfAccessRequests: {
            value: String(profile.requestsMillions),
            unit: "perMonth",
          },
        },
        serviceCode: GLUE_CATALOG_SERVICE_CODE,
        region,
        estimateFor: GLUE_CATALOG_ESTIMATE_FOR,
        version: GLUE_CATALOG_VERSION,
        description: `AWS Glue Data Catalog baseline. Environment: shared. ${profile.objectsMillions} million objects stored and ${profile.requestsMillions} million access requests per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Glue Data Catalog storage and requests",
        regionName: regionNameFor(region),
        configSummary: `Number of Objects stored (${profile.objectsMillions} million per month), Number of access requests (${profile.requestsMillions} million per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 10,
    detail: (units) => `${Math.round(units)} million catalog-object month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return glueCatalogMonthlyUsd({
      region: service?.region,
      objectsMillions: parseFrequencyMillions(
        service?.calculationComponents?.numberOfObjectsStored,
      ),
      requestsMillions: parseFrequencyMillions(
        service?.calculationComponents?.numberOfAccessRequests,
      ),
    });
  },
};
