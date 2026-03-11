import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const FSX_SERVICE_CODE = "amazonFSx";
const FSX_VERSION = "0.0.92";
const FSX_SINGLE_AZ = "singleAZDeployment";
const FSX_MULTI_AZ = "multiAZDeployment";
const FSX_STORAGE_TYPE_SINGLE_AZ_SSD = "DDURBPI4tsBCssHtJz-pnpofARkXwk3q7_-D3R-POb0";
const FSX_STORAGE_TYPE_MULTI_AZ_SSD = "tQmrtIAgZ-JGQyf4yDArf4sQPj9KzoFfpdCxfGf-tsM";
const FSX_SHAPE_PROFILES = [
  {
    estimateFor: FSX_SINGLE_AZ,
    storageType: FSX_STORAGE_TYPE_SINGLE_AZ_SSD,
    storageCapacityGb: 500,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 32,
    backupStorageGb: 50,
  },
  {
    estimateFor: FSX_SINGLE_AZ,
    storageType: FSX_STORAGE_TYPE_SINGLE_AZ_SSD,
    storageCapacityGb: 1000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 64,
    backupStorageGb: 100,
  },
  {
    estimateFor: FSX_SINGLE_AZ,
    storageType: FSX_STORAGE_TYPE_SINGLE_AZ_SSD,
    storageCapacityGb: 2000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 64,
    backupStorageGb: 200,
  },
  {
    estimateFor: FSX_SINGLE_AZ,
    storageType: FSX_STORAGE_TYPE_SINGLE_AZ_SSD,
    storageCapacityGb: 3000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 128,
    backupStorageGb: 300,
  },
  {
    estimateFor: FSX_SINGLE_AZ,
    storageType: FSX_STORAGE_TYPE_SINGLE_AZ_SSD,
    storageCapacityGb: 4000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 128,
    backupStorageGb: 400,
  },
  {
    estimateFor: FSX_MULTI_AZ,
    storageType: FSX_STORAGE_TYPE_MULTI_AZ_SSD,
    storageCapacityGb: 2000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 128,
    backupStorageGb: 200,
  },
  {
    estimateFor: FSX_MULTI_AZ,
    storageType: FSX_STORAGE_TYPE_MULTI_AZ_SSD,
    storageCapacityGb: 4000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 256,
    backupStorageGb: 400,
  },
  {
    estimateFor: FSX_MULTI_AZ,
    storageType: FSX_STORAGE_TYPE_MULTI_AZ_SSD,
    storageCapacityGb: 6000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 256,
    backupStorageGb: 600,
  },
  {
    estimateFor: FSX_MULTI_AZ,
    storageType: FSX_STORAGE_TYPE_MULTI_AZ_SSD,
    storageCapacityGb: 8000,
    deduplicationSavingsPct: 50,
    provisionedIopsMode: "AutomaticIOPS",
    userProvisionedIops: 0,
    throughputMbps: 512,
    backupStorageGb: 800,
  },
];
const FSX_PRICING = {
  "us-east-1": {
    [FSX_SINGLE_AZ]: {
      storagePerGbMonth: {
        [FSX_STORAGE_TYPE_SINGLE_AZ_SSD]: 0.13,
      },
      backupPerGbMonth: 0.05,
      iopsPerMonth: 0.012,
      throughputPerMbpsMonth: 2.2,
    },
    [FSX_MULTI_AZ]: {
      storagePerGbMonth: {
        [FSX_STORAGE_TYPE_MULTI_AZ_SSD]: 0.23,
      },
      backupPerGbMonth: 0.05,
      iopsPerMonth: 0.024,
      throughputPerMbpsMonth: 4.5,
    },
  },
};

function fsxPricingFor(region) {
  return scaledRegionalPricing(FSX_PRICING, region, "FSx exact pricing");
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
    case "mbps":
    default:
      return numericValue;
  }
}

function normalizeFsxStorageType(estimateFor, rawValue) {
  if (estimateFor === FSX_MULTI_AZ) {
    if (
      rawValue === FSX_STORAGE_TYPE_MULTI_AZ_SSD ||
      rawValue === "Storage capacity Windows Multi-AZ"
    ) {
      return FSX_STORAGE_TYPE_MULTI_AZ_SSD;
    }
  } else if (
    rawValue === FSX_STORAGE_TYPE_SINGLE_AZ_SSD ||
    rawValue === "Storage capacity Windows"
  ) {
    return FSX_STORAGE_TYPE_SINGLE_AZ_SSD;
  }

  return estimateFor === FSX_MULTI_AZ
    ? FSX_STORAGE_TYPE_MULTI_AZ_SSD
    : FSX_STORAGE_TYPE_SINGLE_AZ_SSD;
}

function fsxMonthlyUsd({
  region,
  estimateFor,
  storageType,
  storageCapacityGb,
  deduplicationSavingsPct = 50,
  provisionedIopsMode = "AutomaticIOPS",
  userProvisionedIops = 0,
  throughputMbps = 32,
  backupStorageGb = 0,
}) {
  const pricing = fsxPricingFor(region)[estimateFor];
  const normalizedStorageType = normalizeFsxStorageType(estimateFor, storageType);
  const effectiveStorageGb =
    Math.max(parseNumericValue(storageCapacityGb, 0), 0) *
    (1 - Math.max(parseNumericValue(deduplicationSavingsPct, 0), 0) / 100);
  const storageMonthly =
    effectiveStorageGb * (pricing.storagePerGbMonth[normalizedStorageType] ?? 0);
  const defaultIops = effectiveStorageGb * 3;
  const billableIops =
    provisionedIopsMode === "UserProvisionedIOPS"
      ? Math.max(parseNumericValue(userProvisionedIops, 0) - defaultIops, 0)
      : 0;
  const iopsMonthly = billableIops * pricing.iopsPerMonth;
  const minimumFileSystems = Math.max(
    effectiveStorageGb / 65536,
    Math.max(parseNumericValue(throughputMbps, 0), 0) / 2048,
  );
  const fileSystemCount = Math.max(Math.ceil(minimumFileSystems), 1);
  const effectiveThroughputMbps = Math.max(parseNumericValue(throughputMbps, 0), fileSystemCount * 8);
  const throughputMonthly = effectiveThroughputMbps * pricing.throughputPerMbpsMonth;
  const effectiveBackupGb =
    Math.max(parseNumericValue(backupStorageGb, 0), 0) *
    (1 - Math.max(parseNumericValue(deduplicationSavingsPct, 0), 0) / 100);
  const backupMonthly = effectiveBackupGb * pricing.backupPerGbMonth;

  return roundCurrency(storageMonthly + iopsMonthly + throughputMonthly + backupMonthly);
}

function fsxShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const profiles = FSX_SHAPE_PROFILES.map((profile) => ({
    ...profile,
    monthlyUsd: fsxMonthlyUsd({
      region,
      ...profile,
    }),
  }));

  profiles.sort(
    (left, right) => Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
  );
  return profiles[0];
}

export const amazonFsxWindowsService = {
  id: "amazon-fsx-windows",
  name: "Amazon FSx for Windows File Server",
  category: "storage",
  implementationStatus: "implemented",
  keywords: ["fsx", "windows file server", "smb"],
  pricingStrategies: ["single-az", "multi-az"],
  calculatorServiceCodes: [FSX_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = fsxShapeForBudget(region, monthlyBudgetUsd);
    const iopsModeComponentId =
      profile.estimateFor === FSX_MULTI_AZ ? "ProvisionedSSDIOPS_MultiAZ" : "ProvisionedSSDIOPS";
    const userIopsComponentId =
      profile.estimateFor === FSX_MULTI_AZ
        ? "User_provisioned_SSD_IOPS_MultiAZ"
        : "User_provisioned_SSD_IOPS";

    return {
      key: `${FSX_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-fsx-windows",
        kind: FSX_SERVICE_CODE,
        label: "Amazon FSx for Windows File Server",
        category: "storage",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.estimateFor === FSX_MULTI_AZ ? "Multi-AZ" : "Single-AZ"} SSD, ${profile.storageCapacityGb} GB, ${profile.throughputMbps} MBps throughput, ${profile.backupStorageGb} GB backup`,
      },
      service: {
        calculationComponents: {
          storageType: {
            value: profile.storageType,
          },
          storageCapacity: {
            value: String(profile.storageCapacityGb),
            unit: "gb|NA",
          },
          percentDeduplicationSavings: {
            value: String(profile.deduplicationSavingsPct),
          },
          [iopsModeComponentId]: {
            value: profile.provisionedIopsMode,
          },
          [userIopsComponentId]: {
            value: String(profile.userProvisionedIops),
          },
          throughputCapacity: {
            value: String(profile.throughputMbps),
            unit: "mbps",
          },
          backupStorage: {
            value: String(profile.backupStorageGb),
            unit: "gb|NA",
          },
        },
        serviceCode: FSX_SERVICE_CODE,
        region,
        estimateFor: profile.estimateFor,
        version: FSX_VERSION,
        description: `Amazon FSx for Windows baseline. Environment: shared. ${profile.estimateFor === FSX_MULTI_AZ ? "Multi-AZ" : "Single-AZ"} SSD deployment with ${profile.storageCapacityGb} GB storage, ${profile.throughputMbps} MBps throughput, ${profile.backupStorageGb} GB backup storage, and ${profile.deduplicationSavingsPct}% deduplication savings.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon FSx for Windows File Server",
        regionName: regionNameFor(region),
        configSummary: `Deployment (${profile.estimateFor === FSX_MULTI_AZ ? "Multi-AZ" : "Single-AZ"}), Desired storage capacity (${profile.storageCapacityGb} GB), Deduplication savings (${profile.deduplicationSavingsPct}%), Provisioned SSD IOPS (${profile.provisionedIopsMode}), Desired aggregate throughput (${profile.throughputMbps} MBps), Backup storage (${profile.backupStorageGb} GB)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 550,
    detail: (units) => `${Math.round(units)} FSx for Windows file-system month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const components = service?.calculationComponents ?? {};
    const estimateFor = service?.estimateFor ?? FSX_SINGLE_AZ;
    const iopsModeComponentId =
      estimateFor === FSX_MULTI_AZ ? "ProvisionedSSDIOPS_MultiAZ" : "ProvisionedSSDIOPS";
    const userIopsComponentId =
      estimateFor === FSX_MULTI_AZ
        ? "User_provisioned_SSD_IOPS_MultiAZ"
        : "User_provisioned_SSD_IOPS";

    return fsxMonthlyUsd({
      region: service?.region,
      estimateFor,
      storageType: components.storageType?.value,
      storageCapacityGb: parseFileSizeGb(components.storageCapacity, 0),
      deduplicationSavingsPct: parseNumericValue(components.percentDeduplicationSavings?.value, 50),
      provisionedIopsMode: components[iopsModeComponentId]?.value ?? "AutomaticIOPS",
      userProvisionedIops: parseNumericValue(components[userIopsComponentId]?.value, 0),
      throughputMbps: parseThroughputMbps(components.throughputCapacity, 0),
      backupStorageGb: parseFileSizeGb(components.backupStorage, 0),
    });
  },
};
