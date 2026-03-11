import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const EFS_SERVICE_CODE = "amazonEFS";
const EFS_ESTIMATE_FOR = "template_0";
const EFS_VERSION = "0.0.3";
const EFS_PRICING = {
  "us-east-1": {
    standardStoragePerGbMonth: 0.3,
    infrequentStoragePerGbMonth: 0.025,
    infrequentAccessRequestsPerGb: 0.01,
    provisionedThroughputPerMbpsMonth: 6,
  },
};

function efsPricingFor(region) {
  return scaledRegionalPricing(EFS_PRICING, region, "EFS exact pricing");
}

function parseFileSizeGb(component, fallback = 0) {
  if (!component || typeof component !== "object") {
    return fallback;
  }

  const numericValue = parseNumericValue(component.value, fallback);
  const [sizeUnit] = String(component.unit ?? "gb|NA").split("|");

  switch (sizeUnit) {
    case "tb":
      return numericValue * 1024;
    case "mb":
      return numericValue / 1024;
    case "gb":
    default:
      return numericValue;
  }
}

function parseThroughputMbps(component, fallback = 0) {
  if (!component || typeof component !== "object") {
    return fallback;
  }

  const numericValue = parseNumericValue(component.value, fallback);
  const [throughputUnit] = String(component.unit ?? "mbps").split("|");

  switch (throughputUnit) {
    case "gbps":
      return numericValue * 1024;
    case "kbps":
      return numericValue / 1024;
    case "mbps":
    default:
      return numericValue;
  }
}

function efsMonthlyUsd({
  region,
  standardStorageGb,
  infrequentStorageGb = 0,
  infrequentRequestGb = 0,
  provisionedThroughputMbps = 0,
}) {
  const pricing = efsPricingFor(region);
  const includedThroughputMbps = Math.max(parseNumericValue(standardStorageGb, 0), 0) / 20;
  const billableThroughputMbps = Math.max(
    parseNumericValue(provisionedThroughputMbps, 0) - includedThroughputMbps,
    0,
  );

  return roundCurrency(
    Math.max(parseNumericValue(standardStorageGb, 0), 0) * pricing.standardStoragePerGbMonth +
      Math.max(parseNumericValue(infrequentStorageGb, 0), 0) *
        pricing.infrequentStoragePerGbMonth +
      Math.max(parseNumericValue(infrequentRequestGb, 0), 0) *
        pricing.infrequentAccessRequestsPerGb +
      billableThroughputMbps * pricing.provisionedThroughputPerMbpsMonth,
  );
}

function efsShapeForBudget(region, monthlyBudgetUsd) {
  const pricing = efsPricingFor(region);
  const standardStorageGb = Math.max(
    Math.round(Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0) / pricing.standardStoragePerGbMonth),
    1,
  );

  return {
    standardStorageGb,
    infrequentStorageGb: 0,
    infrequentRequestGb: 0,
    provisionedThroughputMbps: 0,
    monthlyUsd: efsMonthlyUsd({
      region,
      standardStorageGb,
    }),
  };
}

export const amazonEfsService = {
  id: "amazon-efs",
  name: "Amazon EFS",
  category: "storage",
  implementationStatus: "implemented",
  keywords: ["efs", "shared file system"],
  pricingStrategies: ["standard", "infrequent-access", "elastic-throughput"],
  calculatorServiceCodes: [EFS_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = efsShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${EFS_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-efs",
        kind: EFS_SERVICE_CODE,
        label: "Amazon EFS",
        category: "storage",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.standardStorageGb} GB standard storage, ${profile.infrequentStorageGb} GB infrequent access, ${profile.provisionedThroughputMbps} MBps provisioned throughput`,
      },
      service: {
        calculationComponents: {
          undefined_generated_2: {
            value: String(profile.standardStorageGb),
            unit: "gb|NA",
          },
          undefined_generated_5: {
            value: String(profile.infrequentStorageGb),
            unit: "gb|NA",
          },
          undefined_generated_6: {
            value: String(profile.infrequentRequestGb),
            unit: "gb|NA",
          },
          undefined_generated_16: {
            value: String(profile.provisionedThroughputMbps),
            unit: "mbps",
          },
        },
        serviceCode: EFS_SERVICE_CODE,
        region,
        estimateFor: EFS_ESTIMATE_FOR,
        version: EFS_VERSION,
        description: `Amazon EFS baseline. Environment: shared. ${profile.standardStorageGb} GB standard storage, ${profile.infrequentStorageGb} GB infrequent access storage, and ${profile.provisionedThroughputMbps} MBps provisioned throughput.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Elastic File System (EFS)",
        regionName: regionNameFor(region),
        configSummary: `Data stored in Standard storage (${profile.standardStorageGb} GB per month), Data stored in Infrequent Access storage (${profile.infrequentStorageGb} GB per month), Infrequent Access requests (${profile.infrequentRequestGb} GB per month), Provisioned Throughput (${profile.provisionedThroughputMbps} MBps per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 180,
    detail: (units) => `${Math.round(units)} EFS file-system month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return efsMonthlyUsd({
      region: service?.region,
      standardStorageGb: parseFileSizeGb(service?.calculationComponents?.undefined_generated_2, 0),
      infrequentStorageGb: parseFileSizeGb(service?.calculationComponents?.undefined_generated_5, 0),
      infrequentRequestGb: parseFileSizeGb(service?.calculationComponents?.undefined_generated_6, 0),
      provisionedThroughputMbps: parseThroughputMbps(
        service?.calculationComponents?.undefined_generated_16,
        0,
      ),
    });
  },
};
