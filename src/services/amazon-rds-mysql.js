import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const MYSQL_SERVICE_CODE = "amazonRDSMySQLDB";
const MYSQL_ESTIMATE_FOR = "mySQLDB";
const MYSQL_VERSION = "0.0.128";
const MYSQL_STORAGE_TYPE = "General Purpose";
const MYSQL_EXTENDED_SUPPORT_YEAR = "year12";
const MYSQL_PRICING = {
  "us-east-1": {
    instanceHourly: {
      "db.t4g.large": {
        "Single-AZ": 0.124,
        "Multi-AZ": 0.248,
      },
      "db.r6g.large": {
        "Single-AZ": 0.227,
        "Multi-AZ": 0.454,
      },
      "db.r6g.xlarge": {
        "Single-AZ": 0.454,
        "Multi-AZ": 0.908,
      },
      "db.r6g.2xlarge": {
        "Single-AZ": 0.908,
        "Multi-AZ": 1.816,
      },
      "db.r6g.4xlarge": {
        "Single-AZ": 1.816,
        "Multi-AZ": 3.632,
      },
    },
    storagePerGbMonth: {
      "General Purpose": {
        "Single-AZ": 0.115,
        "Multi-AZ": 0.23,
      },
      "General Purpose (gp3)": {
        "Single-AZ": 0.1,
        "Multi-AZ": 0.2,
      },
      "Provisioned IOPS": {
        "Single-AZ": 0.125,
        "Multi-AZ": 0.25,
      },
    },
    iopsPerMonth: {
      "General Purpose": 0,
      "General Purpose (gp3)": 0.005,
      "Provisioned IOPS": 0.1,
    },
  },
};
const MYSQL_PRICING_MULTIPLIERS = {
  OnDemand: 1,
  Reserved: 0.9,
  ReservedHeavy: 0.84,
  "Database Savings Plans": 0.87,
};
const MYSQL_PROFILES = [
  {
    maxBudgetUsd: 250,
    instanceType: "db.t4g.large",
    deploymentOption: "Single-AZ",
    storageGb: 100,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: 800,
    instanceType: "db.r6g.large",
    deploymentOption: "Multi-AZ",
    storageGb: 150,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: 2_000,
    instanceType: "db.r6g.2xlarge",
    deploymentOption: "Multi-AZ",
    storageGb: 300,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: Number.POSITIVE_INFINITY,
    instanceType: "db.r6g.4xlarge",
    deploymentOption: "Multi-AZ",
    storageGb: 500,
    pricingModel: "OnDemand",
  },
];

function mysqlPricingFor(region) {
  return scaledRegionalPricing(MYSQL_PRICING, region, "RDS MySQL exact pricing");
}

function normalizeDeploymentOption(value) {
  if (value === "single-az" || value === "Single-AZ") {
    return "Single-AZ";
  }

  if (value === "multi-az" || value === "Multi-AZ") {
    return "Multi-AZ";
  }

  return "Single-AZ";
}

function normalizeStorageType(value) {
  if (value === "General Purpose SSD (gp3)" || value === "General Purpose (gp3)") {
    return "General Purpose (gp3)";
  }

  if (value === "Provisioned IOPS" || value === "Provisioned IOPS SSD (io1)") {
    return "Provisioned IOPS";
  }

  return "General Purpose";
}

function mysqlPricingMultiplier(pricingModel) {
  return MYSQL_PRICING_MULTIPLIERS[pricingModel] ?? 1;
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function mysqlStorageMonthlyUsd(region, storageType, deploymentOption, storageGb, nodeCount) {
  const pricing = mysqlPricingFor(region);
  const normalizedStorageType = normalizeStorageType(storageType);
  const normalizedDeploymentOption = normalizeDeploymentOption(deploymentOption);
  const storageRate =
    pricing.storagePerGbMonth[normalizedStorageType]?.[normalizedDeploymentOption];

  if (!storageRate) {
    throw new Error(
      `Unsupported RDS MySQL storage '${normalizedStorageType}' with deployment '${normalizedDeploymentOption}' in region '${region}'.`,
    );
  }

  return roundCurrency(storageRate * storageGb * nodeCount);
}

function mysqlIopsMonthlyUsd(region, storageType, iops, nodeCount) {
  const pricing = mysqlPricingFor(region);
  const normalizedStorageType = normalizeStorageType(storageType);
  const rate = pricing.iopsPerMonth[normalizedStorageType];

  if (rate == null) {
    throw new Error(
      `Unsupported RDS MySQL storage '${normalizedStorageType}' for IOPS pricing in region '${region}'.`,
    );
  }

  return roundCurrency(rate * Math.max(parseNumericValue(iops, 0), 0) * nodeCount);
}

function mysqlMonthlyUsd({
  region,
  instanceType,
  deploymentOption,
  storageType = MYSQL_STORAGE_TYPE,
  storageGb,
  iops = 0,
  nodeCount = 1,
  pricingModel = "OnDemand",
}) {
  const pricing = mysqlPricingFor(region);
  const normalizedDeploymentOption = normalizeDeploymentOption(deploymentOption);
  const hourly = pricing.instanceHourly[instanceType]?.[normalizedDeploymentOption];

  if (!hourly) {
    throw new Error(
      `Unsupported RDS MySQL instance '${instanceType}' with deployment '${normalizedDeploymentOption}' in region '${region}'.`,
    );
  }

  const computeMonthly =
    monthlyFromHourly(hourly) * Math.max(parseNumericValue(nodeCount, 1), 1) * mysqlPricingMultiplier(pricingModel);
  const storageMonthly = mysqlStorageMonthlyUsd(
    region,
    storageType,
    normalizedDeploymentOption,
    storageGb,
    nodeCount,
  );
  const iopsMonthly = mysqlIopsMonthlyUsd(region, storageType, iops, nodeCount);

  return roundCurrency(computeMonthly + storageMonthly + iopsMonthly);
}

function mysqlProfileForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const byThreshold = MYSQL_PROFILES.find((profile) => budget <= profile.maxBudgetUsd);

  if (byThreshold) {
    return {
      ...byThreshold,
      monthlyUsd: mysqlMonthlyUsd({
        region,
        ...byThreshold,
      }),
    };
  }

  const candidates = MYSQL_PROFILES.map((profile) => ({
    ...profile,
    monthlyUsd: mysqlMonthlyUsd({
      region,
      ...profile,
    }),
  }));

  candidates.sort(
    (left, right) => Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
  );
  return candidates[0];
}

function pricingSummaryLabel(pricingModel) {
  switch (pricingModel) {
    case "ReservedHeavy":
      return "Reserved Heavy";
    case "Reserved":
      return "Reserved";
    case "Database Savings Plans":
      return "Database Savings Plans";
    default:
      return "OnDemand";
  }
}

function reservedFields(pricingModel) {
  if (pricingModel === "Reserved" || pricingModel === "ReservedHeavy") {
    return {
      LeaseContractLength: {
        value: "1yr",
      },
      PurchaseOption: {
        value: "No Upfront",
      },
    };
  }

  if (pricingModel === "Database Savings Plans") {
    return {
      PurchaseOption: {
        value: "No Upfront",
      },
    };
  }

  return {};
}

function descriptionFor({ instanceType, deploymentOption, storageGb, pricingModel, notes }) {
  const parts = [
    "Amazon RDS for MySQL baseline.",
    "Environment: shared.",
    `${instanceType} with ${deploymentOption}, ${storageGb} GB of storage, and ${pricingSummaryLabel(pricingModel)} pricing.`,
  ];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export const amazonRdsMysqlService = {
  id: "amazon-rds-mysql",
  name: "Amazon RDS for MySQL",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["mysql", "rds mysql"],
  pricingStrategies: ["on-demand", "reserved", "database-savings-plans", "single-az", "multi-az"],
  calculatorServiceCodes: [MYSQL_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = mysqlProfileForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = profile.monthlyUsd;

    return {
      key: `${MYSQL_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-rds-mysql",
        kind: MYSQL_SERVICE_CODE,
        label: "Amazon RDS for MySQL",
        category: "database",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.instanceType}, ${profile.deploymentOption}, ${profile.storageGb} GB, ${pricingSummaryLabel(profile.pricingModel)} pricing`,
      },
      service: {
        calculationComponents: {
          createRDSProxy: {
            value: "0",
          },
          storageAmount: {
            value: String(profile.storageGb),
            unit: "gb|NA",
          },
          storageType: {
            value: MYSQL_STORAGE_TYPE,
          },
          iops: {
            value: "0",
          },
          DatabaseInsightsSelected: {
            value: "0",
          },
          retentionPeriod: {
            value: "0",
          },
          addRDSExtendedSupport: {
            value: "0",
          },
          RDSExtendedSupportYear: {
            value: MYSQL_EXTENDED_SUPPORT_YEAR,
          },
          additionalBackupStorage: {
            value: "0",
            unit: "gb|NA",
          },
          snapshotExport: {
            value: "0",
            unit: "gb|NA",
          },
          dedicatedLogVolume: {
            value: "0",
          },
          columnFormIPM: {
            value: [
              {
                "Number of Nodes": {
                  value: "1",
                },
                "Instance Type": {
                  value: profile.instanceType,
                },
                undefined: {
                  value: {
                    unit: "100",
                    selectedId: "%Utilized/Month",
                  },
                },
                "Deployment Option": {
                  value: profile.deploymentOption,
                },
                TermType: {
                  value: profile.pricingModel,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
        },
        serviceCode: MYSQL_SERVICE_CODE,
        region,
        estimateFor: MYSQL_ESTIMATE_FOR,
        version: MYSQL_VERSION,
        description: descriptionFor({
          instanceType: profile.instanceType,
          deploymentOption: profile.deploymentOption,
          storageGb: profile.storageGb,
          pricingModel: profile.pricingModel,
          notes,
        }),
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon RDS for MySQL",
        regionName: regionNameFor(region),
        configSummary: `Storage amount (${profile.storageGb} GB), Storage type (General Purpose SSD (gp2)), Nodes (1), Instance Type (${profile.instanceType}), Utilization (${pricingSummaryLabel(profile.pricingModel)}) (100 %Utilized/Month), Deployment Option (${profile.deploymentOption}), Pricing Model (${profile.pricingModel})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 420,
    detail: (units) => `${Math.round(units)} RDS for MySQL instance-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const storageGb = parseNumericValue(service?.calculationComponents?.storageAmount?.value, 0);
    const storageType = service?.calculationComponents?.storageType?.value ?? MYSQL_STORAGE_TYPE;
    const iops = parseNumericValue(service?.calculationComponents?.iops?.value, 0);
    const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];

    return roundCurrency(
      rows.reduce((sum, row) => {
        const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);
        const instanceType = row?.["Instance Type"]?.value;
        const deploymentOption =
          row?.["Deployment Option"]?.value ?? row?.deploymentStrategy?.value ?? "Single-AZ";
        const pricingModel = row?.TermType?.value ?? "OnDemand";

        return (
          sum +
          mysqlMonthlyUsd({
            region: service?.region,
            instanceType,
            deploymentOption,
            storageType,
            storageGb,
            iops,
            nodeCount,
            pricingModel,
          })
        );
      }, 0),
    );
  },
};
