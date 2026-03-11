import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const EBS_SERVICE_CODE = "amazonElasticBlockStore";
const EBS_ESTIMATE_FOR = "elasticBlockStore";
const EBS_VERSION = "0.0.155";
const EBS_STORAGE_TYPE_GP3 = "Storage General Purpose gp3 GB Mo";
const EBS_PRICING = {
  "us-east-1": {
    storagePerGbMonth: {
      [EBS_STORAGE_TYPE_GP3]: 0.08,
    },
    iopsPerMonth: {
      [EBS_STORAGE_TYPE_GP3]: 0.005,
    },
    throughputPerMbpsMonth: {
      [EBS_STORAGE_TYPE_GP3]: 40.96 / 1024,
    },
    snapshotPerGbMonth: 0.05,
  },
};

function ebsPricingFor(region) {
  return scaledRegionalPricing(EBS_PRICING, region, "EBS exact pricing");
}

function parseDurationHours(component) {
  if (!component || typeof component !== "object") {
    return HOURS_PER_MONTH;
  }

  return parseNumericValue(component.value, HOURS_PER_MONTH);
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

function parseThroughputMbps(component, fallback = 125) {
  if (!component || typeof component !== "object") {
    return fallback;
  }

  const numericValue = parseNumericValue(component.value, fallback);
  const [throughputUnit] = String(component.unit ?? "mbps").split("|");

  switch (throughputUnit) {
    case "gbps":
      return numericValue * 1024;
    case "mbps":
    default:
      return numericValue;
  }
}

function ebsMonthlyUsd({
  region,
  numberOfVolumes = 1,
  durationHours = HOURS_PER_MONTH,
  storageType = EBS_STORAGE_TYPE_GP3,
  storageAmountGb,
  gp3Iops = 3000,
  gp3ThroughputMbps = 125,
}) {
  const pricing = ebsPricingFor(region);
  const instanceMonths =
    (Math.max(parseNumericValue(numberOfVolumes, 0), 0) *
      Math.max(parseNumericValue(durationHours, HOURS_PER_MONTH), 0)) /
    HOURS_PER_MONTH;
  const storageGb = Math.max(parseNumericValue(storageAmountGb, 0), 0);
  const storageMonthly =
    instanceMonths * storageGb * (pricing.storagePerGbMonth[storageType] ?? 0);
  const billableIops = Math.max(parseNumericValue(gp3Iops, 3000) - 3000, 0);
  const iopsMonthly =
    instanceMonths * billableIops * (pricing.iopsPerMonth[storageType] ?? 0);
  const billableThroughputMbps = Math.max(parseNumericValue(gp3ThroughputMbps, 125) - 125, 0);
  const throughputMonthly =
    instanceMonths *
    billableThroughputMbps *
    (pricing.throughputPerMbpsMonth[storageType] ?? 0);

  return roundCurrency(storageMonthly + iopsMonthly + throughputMonthly);
}

function ebsShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const volumeCount = budget > 600 ? 4 : budget > 250 ? 2 : 1;
  const storageAmountGb = budget > 500 ? 4096 : budget > 250 ? 2048 : budget > 120 ? 1024 : 512;
  const gp3Iops = budget > 800 ? 12000 : budget > 500 ? 6000 : 3000;
  const gp3ThroughputMbps = budget > 800 ? 500 : budget > 500 ? 250 : 125;
  const monthlyUsd = ebsMonthlyUsd({
    region,
    numberOfVolumes: volumeCount,
    storageAmountGb,
    gp3Iops,
    gp3ThroughputMbps,
  });

  return {
    numberOfVolumes: volumeCount,
    durationHours: HOURS_PER_MONTH,
    storageType: EBS_STORAGE_TYPE_GP3,
    storageAmountGb,
    gp3Iops,
    gp3ThroughputMbps,
    snapshotFrequency: "0",
    snapshotAmountGb: 0,
    monthlyUsd,
  };
}

export const amazonEbsService = {
  id: "amazon-ebs",
  name: "Amazon EBS",
  category: "storage",
  implementationStatus: "implemented",
  keywords: ["ebs", "block storage", "gp3", "io2"],
  pricingStrategies: ["gp3", "io2", "throughput-tuned"],
  calculatorServiceCodes: [EBS_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = ebsShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${EBS_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-ebs",
        kind: EBS_SERVICE_CODE,
        label: "Amazon EBS",
        category: "storage",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.numberOfVolumes} gp3 volumes, ${profile.storageAmountGb} GB each, ${profile.gp3Iops} IOPS, ${profile.gp3ThroughputMbps} MBps throughput`,
      },
      service: {
        calculationComponents: {
          numberOfInstances: {
            value: String(profile.numberOfVolumes),
          },
          durationOfInstanceRuns: {
            value: String(profile.durationHours),
            unit: "hours",
          },
          storageType: {
            value: profile.storageType,
          },
          storageAmount: {
            value: String(profile.storageAmountGb),
            unit: "gb|NA",
          },
          gp3Iops: {
            value: String(profile.gp3Iops),
          },
          gp3Throughput: {
            value: String(profile.gp3ThroughputMbps),
            unit: "mbps",
          },
          snapshotFrequency: {
            value: profile.snapshotFrequency,
          },
          snapshotAmount: {
            value: String(profile.snapshotAmountGb),
            unit: "gb|NA",
          },
        },
        serviceCode: EBS_SERVICE_CODE,
        region,
        estimateFor: EBS_ESTIMATE_FOR,
        version: EBS_VERSION,
        description: `Amazon EBS baseline. Environment: shared. ${profile.numberOfVolumes} gp3 volumes, ${profile.storageAmountGb} GB each, ${profile.gp3Iops} IOPS, ${profile.gp3ThroughputMbps} MBps throughput, and no snapshot storage.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Elastic Block Store (EBS)",
        regionName: regionNameFor(region),
        configSummary: `Number of volumes (${profile.numberOfVolumes}), Average duration of volume (${profile.durationHours} hours per month), Storage for each EC2 instance (General Purpose SSD (gp3)), Storage amount per volume (${profile.storageAmountGb} GB), Provisioning IOPS per volume (gp3) (${profile.gp3Iops}), General Purpose SSD (gp3) - Throughput (${profile.gp3ThroughputMbps} MBps), Snapshot Frequency (No snapshot storage)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 120,
    detail: (units) => `${Math.round(units)} EBS volume-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const components = service?.calculationComponents ?? {};

    return ebsMonthlyUsd({
      region: service?.region,
      numberOfVolumes: parseNumericValue(components.numberOfInstances?.value, 1),
      durationHours: parseDurationHours(components.durationOfInstanceRuns),
      storageType: components.storageType?.value ?? EBS_STORAGE_TYPE_GP3,
      storageAmountGb: parseFileSizeGb(components.storageAmount, 0),
      gp3Iops: parseNumericValue(components.gp3Iops?.value, 3000),
      gp3ThroughputMbps: parseThroughputMbps(components.gp3Throughput, 125),
    });
  },
};
