import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const ELASTICACHE_SERVICE_CODE = "amazonElastiCache";
const ELASTICACHE_ESTIMATE_FOR = "amazonElastiCache";
const ELASTICACHE_VERSION = "0.0.81";
const ELASTICACHE_ENGINE = "Redis";
const ELASTICACHE_PRICING = {
  "us-east-1": {
    instanceHourly: {
      "cache.t4g.small": 0.032,
      "cache.m7g.large": 0.158,
      "cache.r7g.large": 0.219,
      "cache.r7g.xlarge": 0.438,
    },
    pricingMultiplier: {
      OnDemand: 1,
      Reserved: 0.88,
      "Database Savings Plans": 0.85,
    },
  },
};

function elasticachePricingFor(region) {
  return scaledRegionalPricing(ELASTICACHE_PRICING, region, "ElastiCache exact pricing");
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function instanceFamilyForType(instanceType) {
  if (String(instanceType).startsWith("cache.r")) {
    return "Memory optimized";
  }

  return "Standard";
}

function pricingSummaryLabel(pricingModel) {
  switch (pricingModel) {
    case "Reserved":
      return "Reserved";
    case "Database Savings Plans":
      return "Database Savings Plans";
    default:
      return "OnDemand";
  }
}

function elasticacheMonthlyUsd({
  region,
  instanceType,
  nodeCount = 1,
  pricingModel = "OnDemand",
}) {
  const pricing = elasticachePricingFor(region);
  const hourly = pricing.instanceHourly[instanceType];
  const multiplier = pricing.pricingMultiplier[pricingModel] ?? 1;

  if (hourly == null) {
    throw new Error(
      `Unsupported ElastiCache instance '${instanceType}' in region '${region}'.`,
    );
  }

  return roundCurrency(
    monthlyFromHourly(hourly) * Math.max(parseNumericValue(nodeCount, 1), 1) * multiplier,
  );
}

function elasticacheShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const instanceType =
    budget <= 80
      ? "cache.t4g.small"
      : budget <= 240
        ? "cache.m7g.large"
        : budget <= 700
          ? "cache.r7g.large"
          : "cache.r7g.xlarge";
  const perNodeMonthlyUsd = elasticacheMonthlyUsd({
    region,
    instanceType,
    nodeCount: 1,
  });
  const nodeCount = Math.min(
    Math.max(Math.round(budget / Math.max(perNodeMonthlyUsd, 1)), 1),
    24,
  );

  return {
    cacheEngine: ELASTICACHE_ENGINE,
    instanceType,
    instanceFamily: instanceFamilyForType(instanceType),
    nodeCount,
    pricingModel: "OnDemand",
    monthlyUsd: elasticacheMonthlyUsd({
      region,
      instanceType,
      nodeCount,
    }),
  };
}

function reservedFields(pricingModel) {
  if (pricingModel === "Reserved") {
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
    "Amazon ElastiCache for Redis baseline.",
    "Environment: shared.",
    `${profile.nodeCount} ${profile.instanceType} nodes with ${pricingSummaryLabel(profile.pricingModel)} pricing.`,
  ];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export const amazonElasticacheRedisService = {
  id: "amazon-elasticache-redis",
  name: "Amazon ElastiCache for Redis",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["redis", "elasticache"],
  pricingStrategies: ["on-demand", "reserved", "database-savings-plans", "replicated"],
  calculatorServiceCodes: [ELASTICACHE_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = elasticacheShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${ELASTICACHE_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-elasticache-redis",
        kind: ELASTICACHE_SERVICE_CODE,
        label: "Amazon ElastiCache for Redis",
        category: "database",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.nodeCount} x ${profile.instanceType}, ${profile.cacheEngine}, ${pricingSummaryLabel(profile.pricingModel)} pricing`,
      },
      service: {
        calculationComponents: {
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
                "Cache Engine": {
                  value: profile.cacheEngine,
                },
                "Instance Family": {
                  value: profile.instanceFamily,
                },
                TermType: {
                  value: profile.pricingModel,
                },
                ...reservedFields(profile.pricingModel),
              },
            ],
          },
        },
        serviceCode: ELASTICACHE_SERVICE_CODE,
        region,
        estimateFor: ELASTICACHE_ESTIMATE_FOR,
        version: ELASTICACHE_VERSION,
        description: descriptionFor(profile, notes),
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon ElastiCache",
        regionName: regionNameFor(region),
        configSummary: `Nodes (${profile.nodeCount}), Instance Type (${profile.instanceType}), Utilization (${pricingSummaryLabel(profile.pricingModel)}) (100 %Utilized/Month), Cache Engine (${profile.cacheEngine}), Cache Node Type (${profile.instanceFamily}), Pricing Model (${profile.pricingModel})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 360,
    detail: (units) => `${Math.round(units)} Redis node-group month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];

    return roundCurrency(
      rows.reduce((sum, row) => {
        const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);
        const instanceType = row?.["Instance Type"]?.value;
        const pricingModel = row?.TermType?.value ?? "OnDemand";

        return (
          sum +
          elasticacheMonthlyUsd({
            region: service?.region,
            instanceType,
            nodeCount,
            pricingModel,
          })
        );
      }, 0),
    );
  },
};
