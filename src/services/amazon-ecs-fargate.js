import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const FARGATE_SERVICE_CODE = "awsFargate";
const FARGATE_ESTIMATE_FOR = "template";
const FARGATE_VERSION = "0.0.66";
const FARGATE_PRICING = {
  "us-east-1": {
    linuxX86CpuPerHour: 0.04048,
    linuxX86MemoryPerGbHour: 0.004445,
    linuxArmCpuPerHour: 0.03238,
    linuxArmMemoryPerGbHour: 0.00356,
    windowsCpuPerHour: 0.046552,
    windowsMemoryPerGbHour: 0.00511175,
    windowsLicensePerCpuHour: 0.046,
    ephemeralStoragePerGbHour: 0.000111,
  },
};
const FARGATE_PROFILES = [
  { vcpu: 1, memoryGb: 2, billableStorageGb: 0 },
  { vcpu: 2, memoryGb: 4, billableStorageGb: 0 },
  { vcpu: 4, memoryGb: 8, billableStorageGb: 0 },
];

function fargatePricingFor(region) {
  return scaledRegionalPricing(FARGATE_PRICING, region, "Fargate exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "perSecond":
      return numericValue * HOURS_PER_MONTH * 60 * 60;
    case "perMinute":
      return numericValue * HOURS_PER_MONTH * 60;
    case "perHour":
      return numericValue * HOURS_PER_MONTH;
    case "perDay":
      return numericValue * (365 / 12);
    case "perMonth":
    default:
      return numericValue;
  }
}

function parseDurationHours(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "hr";

  switch (unit) {
    case "sec":
      return numericValue / 3600;
    case "min":
      return numericValue / 60;
    case "day":
      return numericValue * 24;
    case "hr":
    case "hours":
    default:
      return numericValue;
  }
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

function fargateRatesFor(pricing, operatingSystem, architecture) {
  if (operatingSystem === "windows") {
    return {
      cpuPerHour: pricing.windowsCpuPerHour,
      memoryPerGbHour: pricing.windowsMemoryPerGbHour,
      windowsLicensePerCpuHour: pricing.windowsLicensePerCpuHour,
    };
  }

  if (architecture === "arm") {
    return {
      cpuPerHour: pricing.linuxArmCpuPerHour,
      memoryPerGbHour: pricing.linuxArmMemoryPerGbHour,
      windowsLicensePerCpuHour: 0,
    };
  }

  return {
    cpuPerHour: pricing.linuxX86CpuPerHour,
    memoryPerGbHour: pricing.linuxX86MemoryPerGbHour,
    windowsLicensePerCpuHour: 0,
  };
}

function fargateMonthlyUsd({
  region,
  operatingSystem = "linux",
  architecture = "x86",
  taskCount,
  durationHours,
  vcpu,
  memoryGb,
  storageGb = 20,
}) {
  const pricing = fargatePricingFor(region);
  const rates = fargateRatesFor(pricing, operatingSystem, architecture);
  const billableStorageGb = Math.max(parseNumericValue(storageGb, 20) - 20, 0);
  const runtimeHours = Math.max(parseNumericValue(taskCount, 0), 0) * Math.max(parseNumericValue(durationHours, 0), 0);

  return roundCurrency(
    runtimeHours *
      (Math.max(parseNumericValue(vcpu, 0), 0) * rates.cpuPerHour +
        Math.max(parseNumericValue(memoryGb, 0), 0) * rates.memoryPerGbHour +
        Math.max(parseNumericValue(vcpu, 0), 0) * rates.windowsLicensePerCpuHour +
        billableStorageGb * pricing.ephemeralStoragePerGbHour),
  );
}

function fargateShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const candidates = FARGATE_PROFILES.map((profile) => {
    const perTaskMonthlyUsd = fargateMonthlyUsd({
      region,
      taskCount: 1,
      durationHours: HOURS_PER_MONTH,
      vcpu: profile.vcpu,
      memoryGb: profile.memoryGb,
      storageGb: 20 + profile.billableStorageGb,
    });
    const taskCount = Math.max(Math.round(budget / Math.max(perTaskMonthlyUsd, 1)), 1);
    const monthlyUsd = fargateMonthlyUsd({
      region,
      taskCount,
      durationHours: HOURS_PER_MONTH,
      vcpu: profile.vcpu,
      memoryGb: profile.memoryGb,
      storageGb: 20 + profile.billableStorageGb,
    });

    return {
      operatingSystem: "linux",
      architecture: "x86",
      durationHours: HOURS_PER_MONTH,
      taskCount,
      vcpu: profile.vcpu,
      memoryGb: profile.memoryGb,
      storageGb: 20 + profile.billableStorageGb,
      monthlyUsd,
    };
  });

  candidates.sort(
    (left, right) => Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
  );

  return candidates[0];
}

export const amazonEcsFargateService = {
  id: "amazon-ecs-fargate",
  name: "Amazon ECS on Fargate",
  category: "compute",
  implementationStatus: "implemented",
  keywords: ["fargate", "ecs fargate"],
  pricingStrategies: ["on-demand"],
  calculatorServiceCodes: [FARGATE_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = fargateShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${FARGATE_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-ecs-fargate",
        kind: FARGATE_SERVICE_CODE,
        label: "AWS Fargate",
        category: "compute",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.taskCount} Linux x86 tasks per month, ${profile.vcpu} vCPU, ${profile.memoryGb} GB memory, ${profile.storageGb} GB storage, ${profile.durationHours} hours average duration`,
      },
      service: {
        calculationComponents: {
          operatingSystem: {
            value: profile.operatingSystem,
          },
          selectArchitecture: {
            value: profile.architecture,
          },
          numberOfTasks: {
            value: String(profile.taskCount),
            unit: "perMonth",
          },
          taskDuration: {
            value: String(profile.durationHours),
            unit: "hr",
          },
          vcpuPerTask: {
            value: String(profile.vcpu),
          },
          memoryStandardFargateOnDemand: {
            value: String(profile.memoryGb),
            unit: "gb|NA",
          },
          storageAmountECS: {
            value: String(profile.storageGb),
            unit: "gb|NA",
          },
        },
        serviceCode: FARGATE_SERVICE_CODE,
        region,
        estimateFor: FARGATE_ESTIMATE_FOR,
        version: FARGATE_VERSION,
        description: `AWS Fargate baseline. Environment: shared. ${profile.taskCount} Linux x86 tasks per month, ${profile.vcpu} vCPU, ${profile.memoryGb} GB memory, ${profile.storageGb} GB storage, ${profile.durationHours} hour average duration.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Fargate",
        regionName: regionNameFor(region),
        configSummary: `Operating system (${profile.operatingSystem}), CPU Architecture (${profile.architecture}), Number of tasks or pods (${profile.taskCount} per month), Average duration (${profile.durationHours} hours), Amount of vCPU allocated (${profile.vcpu}), Amount of memory allocated (${profile.memoryGb} GB), Amount of ephemeral storage allocated for Amazon ECS (${profile.storageGb} GB)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 320,
    detail: (units) => `${Math.round(units)} ECS on Fargate service-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const components = service?.calculationComponents ?? {};
    const vcpu = parseNumericValue(components.vcpuPerTask?.value, 0);
    const memoryGb =
      parseFileSizeGb(components.memoryStandardFargateOnDemand, 0) ||
      parseNumericValue(components.smallMemory?.value, 0) ||
      parseNumericValue(components.smallMemory_8?.value, 0) ||
      parseNumericValue(components.smallMemory_16?.value, 0);

    return fargateMonthlyUsd({
      region: service?.region,
      operatingSystem: components.operatingSystem?.value ?? "linux",
      architecture: components.selectArchitecture?.value ?? "x86",
      taskCount: parseFrequencyValue(components.numberOfTasks),
      durationHours: parseDurationHours(components.taskDuration),
      vcpu,
      memoryGb,
      storageGb: parseFileSizeGb(components.storageAmountECS, 20),
    });
  },
};
