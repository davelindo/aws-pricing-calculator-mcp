import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  regionPriceMultiplier,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const SQL_SERVER_SERVICE_CODE = "amazonRDSForSQLServer";
const SQL_SERVER_ESTIMATE_FOR = "rdsForOracle";
const SQL_SERVER_VERSION = "0.0.117";
const SQL_SERVER_STORAGE_TYPE = "General Purpose";
const SQL_SERVER_PRICING = {
  "us-east-1": {
    instanceHourly: {
      "db.m5.large": 0.934,
      "db.m5.xlarge": 1.868,
      "db.m5.2xlarge": 3.736,
      "db.m5.4xlarge": 7.472,
    },
    editionMultiplier: {
      Express: 0.48,
      Web: 0.72,
      Standard: 1,
      Enterprise: 1.58,
    },
    licenseMultiplier: {
      "License Included": 1,
      "Bring your own license": 0.46,
      BYOL: 0.46,
    },
    deploymentMultiplier: {
      "Single-AZ": 1,
      "Multi-AZ": 2,
    },
    storagePerGbMonth: {
      "General Purpose": 0.115,
      "General Purpose (gp3)": 0.1,
      "Provisioned IOPS": 0.125,
    },
    iopsPerMonth: {
      "General Purpose": 0,
      "General Purpose (gp3)": 0.005,
      "Provisioned IOPS": 0.1,
    },
  },
};
const SQL_SERVER_PRICING_MULTIPLIERS = {
  OnDemand: 1,
  Reserved: 0.9,
  ReservedHeavy: 0.84,
};
const SQL_SERVER_PROFILES = [
  {
    instanceType: "db.m5.large",
    deploymentOption: "Single-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 100,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.xlarge",
    deploymentOption: "Single-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 150,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.xlarge",
    deploymentOption: "Multi-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 200,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.2xlarge",
    deploymentOption: "Single-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 250,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.2xlarge",
    deploymentOption: "Multi-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 300,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.4xlarge",
    deploymentOption: "Single-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 400,
    pricingModel: "OnDemand",
  },
  {
    instanceType: "db.m5.4xlarge",
    deploymentOption: "Multi-AZ",
    databaseEdition: "Standard",
    licenseModel: "License Included",
    storageGb: 500,
    pricingModel: "OnDemand",
  },
];

function scaleRateTable(rateTable, multiplier) {
  return Object.fromEntries(
    Object.entries(rateTable).map(([key, rate]) => [key, roundCurrency(rate * multiplier)]),
  );
}

function sqlServerPricingFor(region) {
  const exactPricing = SQL_SERVER_PRICING[region];

  if (exactPricing) {
    return exactPricing;
  }

  const basePricing = SQL_SERVER_PRICING["us-east-1"];
  const multiplier = regionPriceMultiplier(region);

  if (!basePricing || !multiplier) {
    throw new Error(`RDS SQL Server exact pricing is not implemented for region '${region}'.`);
  }

  return {
    instanceHourly: scaleRateTable(basePricing.instanceHourly, multiplier),
    editionMultiplier: { ...basePricing.editionMultiplier },
    licenseMultiplier: { ...basePricing.licenseMultiplier },
    deploymentMultiplier: { ...basePricing.deploymentMultiplier },
    storagePerGbMonth: scaleRateTable(basePricing.storagePerGbMonth, multiplier),
    iopsPerMonth: scaleRateTable(basePricing.iopsPerMonth, multiplier),
  };
}

function normalizeDeploymentOption(value) {
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

function normalizeDatabaseEdition(value) {
  switch (String(value ?? "").toLowerCase()) {
    case "enterprise":
    case "sql server enterprise":
      return "Enterprise";
    case "web":
    case "sql server web":
      return "Web";
    case "express":
    case "sql server express":
      return "Express";
    default:
      return "Standard";
  }
}

function normalizeLicenseModel(value) {
  const normalized = String(value ?? "").toLowerCase();

  if (normalized.includes("bring") || normalized.includes("byol")) {
    return "Bring your own license";
  }

  return "License Included";
}

function sqlServerPricingMultiplier(pricingModel) {
  return SQL_SERVER_PRICING_MULTIPLIERS[pricingModel] ?? 1;
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function sqlServerMonthlyUsd({
  region,
  instanceType,
  deploymentOption,
  databaseEdition,
  licenseModel,
  storageType = SQL_SERVER_STORAGE_TYPE,
  storageGb,
  iops = 0,
  nodeCount = 1,
  pricingModel = "OnDemand",
}) {
  const pricing = sqlServerPricingFor(region);
  const normalizedDeploymentOption = normalizeDeploymentOption(deploymentOption);
  const normalizedDatabaseEdition = normalizeDatabaseEdition(databaseEdition);
  const normalizedLicenseModel = normalizeLicenseModel(licenseModel);
  const hourly = pricing.instanceHourly[instanceType];

  if (!hourly) {
    throw new Error(
      `Unsupported RDS SQL Server instance '${instanceType}' in region '${region}'.`,
    );
  }

  const editionMultiplier = pricing.editionMultiplier[normalizedDatabaseEdition];
  const licenseMultiplier = pricing.licenseMultiplier[normalizedLicenseModel];
  const deploymentMultiplier = pricing.deploymentMultiplier[normalizedDeploymentOption];
  const storageRate = pricing.storagePerGbMonth[normalizeStorageType(storageType)];
  const iopsRate = pricing.iopsPerMonth[normalizeStorageType(storageType)];

  if (
    editionMultiplier == null ||
    licenseMultiplier == null ||
    deploymentMultiplier == null ||
    storageRate == null ||
    iopsRate == null
  ) {
    throw new Error(
      `Unsupported RDS SQL Server pricing inputs for edition '${normalizedDatabaseEdition}', license '${normalizedLicenseModel}', deployment '${normalizedDeploymentOption}', or storage '${storageType}' in region '${region}'.`,
    );
  }

  const normalizedNodeCount = Math.max(parseNumericValue(nodeCount, 1), 1);
  const computeMonthly =
    monthlyFromHourly(hourly) *
    normalizedNodeCount *
    editionMultiplier *
    licenseMultiplier *
    deploymentMultiplier *
    sqlServerPricingMultiplier(pricingModel);
  const storageMonthly = storageRate * storageGb * normalizedNodeCount;
  const iopsMonthly = iopsRate * Math.max(parseNumericValue(iops, 0), 0) * normalizedNodeCount;

  return roundCurrency(computeMonthly + storageMonthly + iopsMonthly);
}

function sqlServerProfileForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const candidates = SQL_SERVER_PROFILES.map((candidate) => ({
    ...candidate,
    monthlyUsd: sqlServerMonthlyUsd({
      region,
      ...candidate,
    }),
  })).sort(
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

  return {};
}

function descriptionFor(profile, notes) {
  const parts = [
    "Amazon RDS for SQL Server baseline.",
    "Environment: shared.",
    `${profile.instanceType} ${profile.databaseEdition} with ${profile.licenseModel}, ${profile.deploymentOption}, ${profile.storageGb} GB of storage, and ${pricingSummaryLabel(profile.pricingModel)} pricing.`,
  ];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export const amazonRdsSqlserverService = {
  id: "amazon-rds-sqlserver",
  name: "Amazon RDS for SQL Server",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["sql server", "mssql", "rds sql server"],
  pricingStrategies: ["license-included", "bring-your-own-license", "reserved", "single-az", "multi-az"],
  calculatorServiceCodes: [SQL_SERVER_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = sqlServerProfileForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = profile.monthlyUsd;

    return {
      key: `${SQL_SERVER_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-rds-sqlserver",
        kind: SQL_SERVER_SERVICE_CODE,
        label: "Amazon RDS for SQL Server",
        category: "database",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.instanceType}, ${profile.databaseEdition}, ${profile.licenseModel}, ${profile.deploymentOption}`,
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
            value: SQL_SERVER_STORAGE_TYPE,
          },
          provisioningIOPS: {
            value: "0",
          },
          DatabaseInsightsSelected: {
            value: "0",
          },
          retentionPeriod: {
            value: "0",
          },
          additionalBackupStorage: {
            value: "0",
            unit: "gb|NA",
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
                TermType: {
                  value: profile.pricingModel,
                },
                "Deployment Option": {
                  value: profile.deploymentOption,
                },
                "License Model": {
                  value: profile.licenseModel,
                },
                "Database Edition": {
                  value: profile.databaseEdition,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
        },
        serviceCode: SQL_SERVER_SERVICE_CODE,
        region,
        estimateFor: SQL_SERVER_ESTIMATE_FOR,
        version: SQL_SERVER_VERSION,
        description: descriptionFor(profile, notes),
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon RDS for SQL Server",
        regionName: regionNameFor(region),
        configSummary: `Storage amount (${profile.storageGb} GB), Storage type (General Purpose SSD (gp2)), Nodes (1), Instance Type (${profile.instanceType}), Database Edition (${profile.databaseEdition}), License Model (${profile.licenseModel}), Utilization (${pricingSummaryLabel(profile.pricingModel)}) (100 %Utilized/Month), Deployment Option (${profile.deploymentOption}), Pricing Model (${profile.pricingModel})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 880,
    detail: (units) => `${Math.round(units)} RDS for SQL Server instance-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const storageGb = parseNumericValue(service?.calculationComponents?.storageAmount?.value, 0);
    const storageType = service?.calculationComponents?.storageType?.value ?? SQL_SERVER_STORAGE_TYPE;
    const iops = parseNumericValue(
      service?.calculationComponents?.provisioningIOPS?.value ??
        service?.calculationComponents?.iops?.value,
      0,
    );
    const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];

    return roundCurrency(
      rows.reduce((sum, row) => {
        const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);
        const instanceType = row?.["Instance Type"]?.value;
        const deploymentOption = row?.["Deployment Option"]?.value ?? "Single-AZ";
        const databaseEdition =
          row?.["Database Edition"]?.value ?? row?.["SQL Edition"]?.value ?? "Standard";
        const licenseModel =
          row?.["License Model"]?.value ?? row?.["License Type"]?.value ?? "License Included";
        const pricingModel = row?.TermType?.value ?? "OnDemand";

        return (
          sum +
          sqlServerMonthlyUsd({
            region: service?.region,
            instanceType,
            deploymentOption,
            databaseEdition,
            licenseModel,
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
