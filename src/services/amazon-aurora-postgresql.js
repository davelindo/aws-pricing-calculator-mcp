import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const AURORA_PG_SERVICE_CODE = "amazonRDSAuroraPostgreSQLCompatibleDB";
const AURORA_PG_ESTIMATE_FOR = "AuroraPostgreSQLCompatibleDB";
const AURORA_PG_VERSION = "0.0.149";
const AURORA_PG_STANDARD = "Aurora Standard";
const AURORA_PG_PRICING = {
  "us-east-1": {
    instanceHourly: {
      "db.r6g.large": 0.335,
      "db.r6g.xlarge": 0.67,
      "db.r6g.2xlarge": 1.34,
      "db.r6g.4xlarge": 2.68,
    },
    pricingMultiplier: {
      OnDemand: 1,
      Reserved: 0.9,
      ReservedHeavy: 0.84,
      "Database Savings Plans": 0.87,
    },
    storagePerGbMonth: {
      [AURORA_PG_STANDARD]: 0.1,
      "Aurora I/O-Optimized": 0.225,
    },
    ioPerMillion: {
      [AURORA_PG_STANDARD]: 0.2,
      "Aurora I/O-Optimized": 0,
    },
    backupPerGbMonth: 0.021,
  },
};
const AURORA_PG_PROFILES = [
  {
    maxBudgetUsd: 600,
    edition: AURORA_PG_STANDARD,
    instanceType: "db.r6g.large",
    nodeCount: 1,
    storageGb: 100,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: 1_400,
    edition: AURORA_PG_STANDARD,
    instanceType: "db.r6g.large",
    nodeCount: 2,
    storageGb: 200,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: 3_000,
    edition: AURORA_PG_STANDARD,
    instanceType: "db.r6g.2xlarge",
    nodeCount: 2,
    storageGb: 350,
    pricingModel: "OnDemand",
  },
  {
    maxBudgetUsd: Number.POSITIVE_INFINITY,
    edition: AURORA_PG_STANDARD,
    instanceType: "db.r6g.4xlarge",
    nodeCount: 2,
    storageGb: 500,
    pricingModel: "OnDemand",
  },
];

function auroraPgPricingFor(region) {
  return scaledRegionalPricing(AURORA_PG_PRICING, region, "Aurora PostgreSQL exact pricing");
}

function normalizeEdition(value) {
  return String(value ?? "").toLowerCase().includes("io")
    ? "Aurora I/O-Optimized"
    : AURORA_PG_STANDARD;
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? component?.value?.selectedId ?? "perMonth";

  switch (unit) {
    case "perSecond":
      return numericValue * HOURS_PER_MONTH * 60 * 60;
    case "perMinute":
      return numericValue * HOURS_PER_MONTH * 60;
    case "perHour":
      return numericValue * HOURS_PER_MONTH;
    case "perDay":
      return numericValue * 30.4167;
    case "perMonth":
    default:
      return numericValue;
  }
}

function auroraPgMonthlyUsd({
  region,
  edition = AURORA_PG_STANDARD,
  instanceType,
  nodeCount = 1,
  storageGb,
  totalIoPerMonth = 0,
  additionalBackupStorageGb = 0,
  pricingModel = "OnDemand",
}) {
  const pricing = auroraPgPricingFor(region);
  const normalizedEdition = normalizeEdition(edition);
  const hourly = pricing.instanceHourly[instanceType];
  const storageRate = pricing.storagePerGbMonth[normalizedEdition];
  const ioRate = pricing.ioPerMillion[normalizedEdition];
  const multiplier = pricing.pricingMultiplier[pricingModel] ?? 1;

  if (hourly == null || storageRate == null || ioRate == null) {
    throw new Error(
      `Unsupported Aurora PostgreSQL pricing inputs for instance '${instanceType}' or edition '${normalizedEdition}' in region '${region}'.`,
    );
  }

  const normalizedNodeCount = Math.max(parseNumericValue(nodeCount, 1), 1);
  const computeMonthly = monthlyFromHourly(hourly) * normalizedNodeCount * multiplier;
  const storageMonthly = storageRate * storageGb;
  const ioMonthly = (Math.max(Number(totalIoPerMonth) || 0, 0) / 1_000_000) * ioRate;
  const backupMonthly = pricing.backupPerGbMonth * Math.max(Number(additionalBackupStorageGb) || 0, 0);

  return roundCurrency(computeMonthly + storageMonthly + ioMonthly + backupMonthly);
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function auroraPgProfileForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const profile = AURORA_PG_PROFILES.find((candidate) => budget <= candidate.maxBudgetUsd);
  const selected = profile ?? AURORA_PG_PROFILES.at(-1);

  return {
    ...selected,
    monthlyUsd: auroraPgMonthlyUsd({
      region,
      ...selected,
    }),
  };
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

function descriptionFor(profile, notes) {
  const parts = [
    "Amazon Aurora PostgreSQL baseline.",
    "Environment: shared.",
    `${profile.nodeCount} ${profile.instanceType} instances in ${profile.edition}, ${profile.storageGb} GB of storage, and ${pricingSummaryLabel(profile.pricingModel)} pricing.`,
  ];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export const amazonAuroraPostgresqlService = {
  id: "amazon-aurora-postgresql",
  name: "Amazon Aurora PostgreSQL",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["aurora postgres", "aurora postgresql"],
  pricingStrategies: ["on-demand", "reserved", "database-savings-plans", "serverless-v2", "multi-az"],
  calculatorServiceCodes: [AURORA_PG_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = auroraPgProfileForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = profile.monthlyUsd;

    return {
      key: `${AURORA_PG_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-aurora-postgresql",
        kind: AURORA_PG_SERVICE_CODE,
        label: "Amazon Aurora PostgreSQL",
        category: "database",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.nodeCount} x ${profile.instanceType}, ${profile.edition}, ${profile.storageGb} GB`,
      },
      service: {
        calculationComponents: {
          edition: {
            value: profile.edition,
          },
          createRDSProxy: {
            value: "0",
          },
          storageAmount: {
            value: String(profile.storageGb),
            unit: "gb|NA",
          },
          totalReads_BaseIO: {
            value: "0",
            unit: "perMonth",
          },
          totalWrites_PeakIO: {
            value: "0",
            unit: "perMonth",
          },
          durationPeakWriteId: {
            value: "0",
            unit: "perMonth",
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
            value: "year12",
          },
          numberOfHoursOnES: {
            value: "0",
            unit: "perMonth",
          },
          additionalBackupStorage: {
            value: "0",
            unit: "gb|NA",
          },
          snapshotExport: {
            value: "0",
            unit: "gb|NA",
          },
          columnFormIPM: {
            value: [
              {
                "Number of Nodes": {
                  value: String(profile.nodeCount),
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
                TermType: {
                  value: profile.pricingModel,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
        },
        serviceCode: AURORA_PG_SERVICE_CODE,
        region,
        estimateFor: AURORA_PG_ESTIMATE_FOR,
        version: AURORA_PG_VERSION,
        description: descriptionFor(profile, notes),
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Aurora PostgreSQL-Compatible DB",
        regionName: regionNameFor(region),
        configSummary: `Cluster configuration (${profile.edition}), Storage amount (${profile.storageGb} GB), Nodes (${profile.nodeCount}), Instance Type (${profile.instanceType}), Pricing Model (${profile.pricingModel})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 650,
    detail: (units) => `${Math.round(units)} Aurora PostgreSQL cluster-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const edition = service?.calculationComponents?.edition?.value ?? AURORA_PG_STANDARD;
    const storageGb = parseNumericValue(service?.calculationComponents?.storageAmount?.value, 0);
    const additionalBackupStorageGb = parseNumericValue(
      service?.calculationComponents?.additionalBackupStorage?.value,
      0,
    );
    const totalIoPerMonth =
      parseFrequencyValue(service?.calculationComponents?.totalReads_BaseIO) +
      parseFrequencyValue(service?.calculationComponents?.totalWrites_PeakIO);
    const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];

    return roundCurrency(
      rows.reduce((sum, row) => {
        const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);
        const instanceType = row?.["Instance Type"]?.value;
        const pricingModel = row?.TermType?.value ?? "OnDemand";

        return (
          sum +
          auroraPgMonthlyUsd({
            region: service?.region,
            edition,
            instanceType,
            nodeCount,
            storageGb,
            totalIoPerMonth,
            additionalBackupStorageGb,
            pricingModel,
          })
        );
      }, 0),
    );
  },
};
