import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const OPENSEARCH_SERVICE_CODE = "amazonElasticsearchService";
const OPENSEARCH_ESTIMATE_FOR = "elasticSearchService";
const OPENSEARCH_VERSION = "0.0.165";
const OPENSEARCH_INSTANCE_STORAGE = "EBS Only";
const OPENSEARCH_STORAGE_TYPE = "GP3";
const OPENSEARCH_STORAGE_TYPE_LABELS = {
  GP3: "General Purpose SSD (gp3)",
  GP2: "General Purpose SSD (gp2)",
  "PIOPS Storage": "Provisioned IOPS SSD (io1)",
  Magnetic: "Magnetic (previous generation)",
};
const OPENSEARCH_DEFAULT_GP3_IOPS = 3000;
const OPENSEARCH_DEFAULT_GP3_THROUGHPUT = 125;
const OPENSEARCH_PRICING = {
  "us-east-1": {
    instanceHourly: {
      "t3.medium.search": 0.038,
      "m6g.large.search": 0.138,
      "r6g.large.search": 0.186,
      "r6g.xlarge.search": 0.372,
    },
    storagePerGbMonth: {
      GP3: 0.08,
      GP2: 0.135,
      "PIOPS Storage": 0.125,
      Magnetic: 0.05,
    },
    pricingMultiplier: {
      OnDemand: 1,
      Reserved: 0.9,
    },
  },
};

function opensearchPricingFor(region) {
  return scaledRegionalPricing(OPENSEARCH_PRICING, region, "OpenSearch exact pricing");
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function instanceFamilyForType(instanceType) {
  if (String(instanceType).startsWith("r")) {
    return "Memory optimized";
  }

  if (String(instanceType).startsWith("c")) {
    return "Compute optimized";
  }

  if (String(instanceType).startsWith("or")) {
    return "OR1";
  }

  return "General purpose";
}

function pricingSummaryLabel(pricingModel) {
  return pricingModel === "Reserved" ? "Reserved" : "OnDemand";
}

function storageTypeLabel(storageType) {
  return OPENSEARCH_STORAGE_TYPE_LABELS[storageType] ?? storageType;
}

function parseFileSizeGb(component, fallback = 0) {
  if (!component || typeof component !== "object") {
    return fallback;
  }

  const numericValue = parseNumericValue(component.value, fallback);
  const rawUnit = component.unit ?? component?.value?.unit ?? "gb|NA";
  const [sizeUnit] = String(rawUnit).split("|");

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

function opensearchMonthlyUsd({
  region,
  dataInstanceType,
  dataNodeCount = 1,
  dedicatedMasterInstanceType = "t3.medium.search",
  dedicatedMasterNodeCount = 0,
  storageType = OPENSEARCH_STORAGE_TYPE,
  storageGbPerNode = 100,
  pricingModel = "OnDemand",
}) {
  const pricing = opensearchPricingFor(region);
  const multiplier = pricing.pricingMultiplier[pricingModel] ?? 1;
  const dataHourly = pricing.instanceHourly[dataInstanceType];
  const masterHourly =
    dedicatedMasterNodeCount > 0
      ? pricing.instanceHourly[dedicatedMasterInstanceType]
      : 0;
  const storageRate = pricing.storagePerGbMonth[storageType];

  if (
    dataHourly == null ||
    storageRate == null ||
    (dedicatedMasterNodeCount > 0 && masterHourly == null)
  ) {
    throw new Error(
      `Unsupported OpenSearch pricing inputs for '${dataInstanceType}', '${dedicatedMasterInstanceType}', or storage '${storageType}' in region '${region}'.`,
    );
  }

  return roundCurrency(
    monthlyFromHourly(dataHourly) * Math.max(parseNumericValue(dataNodeCount, 1), 1) * multiplier +
      monthlyFromHourly(masterHourly) *
        Math.max(parseNumericValue(dedicatedMasterNodeCount, 0), 0) *
        multiplier +
      Math.max(parseNumericValue(storageGbPerNode, 0), 0) *
        Math.max(parseNumericValue(dataNodeCount, 1), 1) *
        storageRate,
  );
}

function opensearchShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const dataInstanceType =
    budget <= 140
      ? "t3.medium.search"
      : budget <= 450
        ? "m6g.large.search"
        : budget <= 900
          ? "r6g.large.search"
          : "r6g.xlarge.search";
  const storageGbPerNode =
    budget <= 140 ? 50 : budget <= 450 ? 100 : budget <= 900 ? 150 : 250;
  const singleNodeMonthlyUsd = opensearchMonthlyUsd({
    region,
    dataInstanceType,
    dataNodeCount: 1,
    storageGbPerNode,
  });
  const dataNodeCount = Math.min(
    Math.max(Math.round(budget / Math.max(singleNodeMonthlyUsd, 1)), 1),
    18,
  );

  return {
    dataInstanceType,
    dataInstanceFamily: instanceFamilyForType(dataInstanceType),
    dataNodeCount,
    dedicatedMasterInstanceType: "t3.medium.search",
    dedicatedMasterInstanceFamily: instanceFamilyForType("t3.medium.search"),
    dedicatedMasterNodeCount: 0,
    storageMode: OPENSEARCH_INSTANCE_STORAGE,
    storageType: OPENSEARCH_STORAGE_TYPE,
    storageGbPerNode,
    pricingModel: "OnDemand",
    monthlyUsd: opensearchMonthlyUsd({
      region,
      dataInstanceType,
      dataNodeCount,
      storageGbPerNode,
    }),
  };
}

function reservedFields(pricingModel) {
  if (pricingModel !== "Reserved") {
    return {};
  }

  return {
    LeaseContractLength: {
      value: "1yr",
    },
    PurchaseOption: {
      value: "No Upfront",
    },
  };
}

function descriptionFor(profile, notes) {
  const parts = [
    "Amazon OpenSearch Service baseline.",
    "Environment: shared.",
    `${profile.dataNodeCount} ${profile.dataInstanceType} data nodes with ${profile.storageGbPerNode} GB ${storageTypeLabel(profile.storageType)} per node, ${profile.dedicatedMasterNodeCount} dedicated masters, and ${pricingSummaryLabel(profile.pricingModel)} pricing.`,
  ];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export const amazonOpensearchService = {
  id: "amazon-opensearch",
  name: "Amazon OpenSearch Service",
  category: "analytics",
  implementationStatus: "implemented",
  keywords: ["opensearch", "search", "elasticsearch"],
  pricingStrategies: ["on-demand", "reserved", "multi-az"],
  calculatorServiceCodes: [OPENSEARCH_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = opensearchShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${OPENSEARCH_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-opensearch",
        kind: OPENSEARCH_SERVICE_CODE,
        label: "Amazon OpenSearch Service",
        category: "analytics",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.dataNodeCount} x ${profile.dataInstanceType}, ${profile.storageGbPerNode} GB ${storageTypeLabel(profile.storageType)}/node, ${profile.dedicatedMasterNodeCount} dedicated masters`,
      },
      service: {
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                "Number of Nodes Data instance": {
                  value: String(profile.dataNodeCount),
                },
                "Instance Type": {
                  value: profile.dataInstanceType,
                },
                undefined: {
                  value: {
                    unit: "100",
                    selectedId: "%Utilized/Month",
                  },
                },
                "Instance Family": {
                  value: profile.dataInstanceFamily,
                },
                TermType: {
                  value: profile.pricingModel,
                },
                Storage: {
                  value: profile.storageMode,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
          columnFormIPM_2: {
            value: [
              {
                "Number of Nodes Dedicated master": {
                  value: String(profile.dedicatedMasterNodeCount),
                },
                "Instance Type": {
                  value: profile.dedicatedMasterInstanceType,
                },
                undefined: {
                  value: {
                    unit: "100",
                    selectedId: "%Utilized/Month",
                  },
                },
                "Instance Family": {
                  value: profile.dedicatedMasterInstanceFamily,
                },
                TermType: {
                  value: profile.pricingModel,
                },
                Storage: {
                  value: profile.storageMode,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
          numberOfInstances: {
            value: String(profile.dataNodeCount),
          },
          storageType: {
            value: profile.storageType,
          },
          gp3StorageAmount: {
            value: String(profile.storageGbPerNode),
            unit: "gb|NA",
          },
          gp3ProvisioningIOPS: {
            value: String(OPENSEARCH_DEFAULT_GP3_IOPS),
          },
          gp3Throughput: {
            value: String(OPENSEARCH_DEFAULT_GP3_THROUGHPUT),
          },
        },
        serviceCode: OPENSEARCH_SERVICE_CODE,
        region,
        estimateFor: OPENSEARCH_ESTIMATE_FOR,
        version: OPENSEARCH_VERSION,
        description: descriptionFor(profile, notes),
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon OpenSearch Service",
        regionName: regionNameFor(region),
        configSummary: `Data instances (${profile.dataNodeCount} x ${profile.dataInstanceType}), Dedicated master instances (${profile.dedicatedMasterNodeCount} x ${profile.dedicatedMasterInstanceType}), Storage type (${storageTypeLabel(profile.storageType)}), Storage amount per volume (${profile.storageGbPerNode} GB), Pricing Model (${profile.pricingModel})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 700,
    detail: (units) => `${Math.round(units)} OpenSearch domain-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const components = service?.calculationComponents ?? {};
    const dataRows = components.columnFormIPM_1?.value ?? [];
    const masterRows = components.columnFormIPM_2?.value ?? [];
    const storageType = components.storageType?.value ?? OPENSEARCH_STORAGE_TYPE;
    const storageGbPerNode =
      storageType === "GP3"
        ? parseFileSizeGb(components.gp3StorageAmount, 0)
        : parseFileSizeGb(components.storageAmount, 0);
    const dataNodeCount = roundCurrency(
      dataRows.reduce(
        (sum, row) => sum + parseNumericValue(row?.["Number of Nodes Data instance"]?.value, 0),
        0,
      ),
    );
    const dedicatedMasterNodeCount = roundCurrency(
      masterRows.reduce(
        (sum, row) =>
          sum + parseNumericValue(row?.["Number of Nodes Dedicated master"]?.value, 0),
        0,
      ),
    );
    const dataInstanceType =
      dataRows[0]?.["Instance Type"]?.value ??
      opensearchShapeForBudget(service?.region, 0).dataInstanceType;
    const dedicatedMasterInstanceType =
      masterRows[0]?.["Instance Type"]?.value ?? "t3.medium.search";
    const pricingModel =
      dataRows[0]?.TermType?.value ?? masterRows[0]?.TermType?.value ?? "OnDemand";

    return opensearchMonthlyUsd({
      region: service?.region,
      dataInstanceType,
      dataNodeCount,
      dedicatedMasterInstanceType,
      dedicatedMasterNodeCount,
      storageType,
      storageGbPerNode,
      pricingModel,
    });
  },
};
