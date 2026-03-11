import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const REDSHIFT_SERVICE_CODE = "amazonRedshift";
const REDSHIFT_ESTIMATE_FOR = "redshift_serverless";
const REDSHIFT_VERSION = "0.0.83";
const DAYS_PER_MONTH = 30.5;
const REDSHIFT_PRICING = {
  "us-east-1": {
    rpuPerHour: 0.375,
    managedStoragePerGbMonth: 0.024,
    backupPerGbMonth: 0.023,
  },
};
const RPU_SIZES = [32, 64, 96, 128, 192, 256];

function redshiftPricingFor(region) {
  return scaledRegionalPricing(REDSHIFT_PRICING, region, "Redshift Serverless exact pricing");
}

function parseFileSizeGb(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
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

function workloadSizeForRpu(rpu) {
  if (rpu <= 64) {
    return "small";
  }

  if (rpu <= 128) {
    return "medium";
  }

  if (rpu <= 256) {
    return "large";
  }

  return "extra_large";
}

function redshiftMonthlyUsd({
  region,
  rpu,
  runtimeHoursPerDay,
  managedStorageGb,
  backupStorageGb,
  dataTransferInGb = 0,
}) {
  const pricing = redshiftPricingFor(region);

  return roundCurrency(
    Math.max(rpu, 0) * Math.max(runtimeHoursPerDay, 0) * DAYS_PER_MONTH * pricing.rpuPerHour +
      Math.max(managedStorageGb, 0) * pricing.managedStoragePerGbMonth +
      Math.max(backupStorageGb, 0) * pricing.backupPerGbMonth +
      Math.max(dataTransferInGb, 0) * 0,
  );
}

function managedStorageGbForBudget(budget) {
  if (budget >= 30_000) {
    return 20_480;
  }

  if (budget >= 18_000) {
    return 10_240;
  }

  if (budget >= 9_000) {
    return 5_120;
  }

  return 2_048;
}

function redshiftShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const managedStorageGb = managedStorageGbForBudget(budget);
  const backupStorageGb = roundCurrency(managedStorageGb * 0.25);
  const pricing = redshiftPricingFor(region);
  const storageFloorUsd =
    managedStorageGb * pricing.managedStoragePerGbMonth +
    backupStorageGb * pricing.backupPerGbMonth;
  const computeBudgetUsd = Math.max(budget - storageFloorUsd, 0);
  const candidates = RPU_SIZES.map((rpu) => {
    const runtimeHoursPerDay = Math.max(
      Math.min(roundCurrency(computeBudgetUsd / (rpu * DAYS_PER_MONTH * pricing.rpuPerHour)), 24),
      1,
    );
    const monthlyUsd = redshiftMonthlyUsd({
      region,
      rpu,
      runtimeHoursPerDay,
      managedStorageGb,
      backupStorageGb,
    });

    return {
      workloadSize: workloadSizeForRpu(rpu),
      rpu,
      runtimeHoursPerDay,
      managedStorageGb,
      backupStorageGb,
      dataTransferInGb: 0,
      monthlyUsd,
    };
  });

  candidates.sort(
    (left, right) => Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
  );

  return candidates[0];
}

export const amazonRedshiftService = {
  id: "amazon-redshift",
  name: "Amazon Redshift Serverless",
  category: "analytics",
  implementationStatus: "implemented",
  keywords: ["redshift", "warehouse", "data warehouse"],
  pricingStrategies: ["serverless"],
  calculatorServiceCodes: [REDSHIFT_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = redshiftShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${REDSHIFT_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-redshift",
        kind: REDSHIFT_SERVICE_CODE,
        label: "Amazon Redshift Serverless",
        category: "analytics",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.rpu} base RPUs, ${profile.runtimeHoursPerDay} runtime hours/day, ${profile.managedStorageGb.toLocaleString("en-US")} GB managed storage`,
      },
      service: {
        calculationComponents: {
          select_Workload_size: {
            value: profile.workloadSize,
          },
          RPU_Size: {
            value: String(profile.rpu),
          },
          Query_period: {
            value: String(profile.runtimeHoursPerDay),
          },
          sizeForAdditionalBackupStorage: {
            value: String(profile.backupStorageGb),
            unit: "gb|NA",
          },
          sizeOfManagedStorage: {
            value: String(profile.managedStorageGb),
            unit: "gb|NA",
          },
          dataTransferInTo: {
            value: "0",
            unit: "gb|NA",
          },
        },
        serviceCode: REDSHIFT_SERVICE_CODE,
        region,
        estimateFor: REDSHIFT_ESTIMATE_FOR,
        version: REDSHIFT_VERSION,
        description: `Amazon Redshift Serverless analytics baseline. Environment: shared. ${profile.rpu} base RPUs with ${profile.runtimeHoursPerDay} runtime hours per day, ${profile.managedStorageGb.toLocaleString("en-US")} GB managed storage, and ${profile.backupStorageGb.toLocaleString("en-US")} GB backup storage.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Redshift",
        regionName: regionNameFor(region),
        configSummary: `Workload size (${profile.workloadSize}), Base RPU (${profile.rpu}), Expected daily runtime (${profile.runtimeHoursPerDay} hours), Additional backup storage (${profile.backupStorageGb.toLocaleString("en-US")} GB), Managed storage size (${profile.managedStorageGb.toLocaleString("en-US")} GB), Data Transfer In To (0 GB)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.375 * DAYS_PER_MONTH,
    detail: (units) => `${Math.round(units)} Redshift Serverless RPU-day equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return redshiftMonthlyUsd({
      region: service?.region,
      rpu: parseNumericValue(service?.calculationComponents?.RPU_Size?.value, 0),
      runtimeHoursPerDay: parseNumericValue(service?.calculationComponents?.Query_period?.value, 0),
      managedStorageGb: parseFileSizeGb(service?.calculationComponents?.sizeOfManagedStorage),
      backupStorageGb: parseFileSizeGb(
        service?.calculationComponents?.sizeForAdditionalBackupStorage,
      ),
      dataTransferInGb: parseFileSizeGb(service?.calculationComponents?.dataTransferInTo),
    });
  },
};
