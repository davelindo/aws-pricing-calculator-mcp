import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const ROUTE53_PRICING = {
  "us-east-1": {
    hostedZoneFirst25: 0.5,
    hostedZoneOver25: 0.1,
    standardQueryFirstBillion: 0.4 / 1_000_000,
    standardQueryOverBillion: 0.2 / 1_000_000,
  },
};

function route53PricingFor(region) {
  return scaledRegionalPricing(ROUTE53_PRICING, region, "Route 53 exact pricing");
}

function route53HostedZoneMonthlyCost(region, hostedZoneCount) {
  const pricing = route53PricingFor(region);
  const first25 = Math.min(Math.max(hostedZoneCount, 0), 25);
  const over25 = Math.max(hostedZoneCount - 25, 0);

  return roundCurrency(first25 * pricing.hostedZoneFirst25 + over25 * pricing.hostedZoneOver25);
}

function route53StandardQueryMonthlyCost(region, standardQueriesPerMonth) {
  const pricing = route53PricingFor(region);
  const queries = Math.max(Math.trunc(Number(standardQueriesPerMonth) || 0), 0);
  const firstBillion = Math.min(queries, 1_000_000_000);
  const overBillion = Math.max(queries - 1_000_000_000, 0);

  return roundCurrency(
    firstBillion * pricing.standardQueryFirstBillion +
      overBillion * pricing.standardQueryOverBillion,
  );
}

function route53MonthlyCost(region, hostedZoneCount, standardQueriesPerMonth) {
  return roundCurrency(
    route53HostedZoneMonthlyCost(region, hostedZoneCount) +
      route53StandardQueryMonthlyCost(region, standardQueriesPerMonth),
  );
}

function standardQueriesForBudget(region, monthlyBudgetUsd, hostedZoneCount) {
  const pricing = route53PricingFor(region);
  const remainingBudget = Math.max(
    roundCurrency(
      Number(monthlyBudgetUsd) - route53HostedZoneMonthlyCost(region, hostedZoneCount),
    ),
    0,
  );
  const firstBillionCost = 1_000_000_000 * pricing.standardQueryFirstBillion;

  if (remainingBudget <= firstBillionCost) {
    return Math.max(Math.floor(remainingBudget / pricing.standardQueryFirstBillion), 0);
  }

  return Math.max(
    1_000_000_000 +
      Math.floor((remainingBudget - firstBillionCost) / pricing.standardQueryOverBillion),
    0,
  );
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  if (component.unit) {
    const numericValue = parseNumericValue(component.value, 0);
    return component.unit === "millionPerMonth" ? numericValue * 1_000_000 : numericValue;
  }

  const nestedValue = component.value;

  if (!nestedValue || typeof nestedValue !== "object") {
    return parseNumericValue(nestedValue, 0);
  }

  const numericValue = parseNumericValue(nestedValue.value, 0);
  const unit = nestedValue.selectedId ?? nestedValue.unit ?? "perMonth";
  return unit === "millionPerMonth" ? numericValue * 1_000_000 : numericValue;
}

export const amazonRoute53Service = {
  id: "amazon-route53",
  name: "Amazon Route 53",
  category: "edge",
  implementationStatus: "implemented",
  keywords: ["route53", "dns", "hosted zone"],
  pricingStrategies: ["standard"],
  calculatorServiceCodes: ["amazonRoute53"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const hostedZoneCount = 1;
    const standardQueriesPerMonth = standardQueriesForBudget(region, monthlyBudgetUsd, hostedZoneCount);
    const monthlyUsd = route53MonthlyCost(region, hostedZoneCount, standardQueriesPerMonth);

    return {
      key: `amazonRoute53-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-route53",
        kind: "amazonRoute53HostedZones",
        label: "Amazon Route 53",
        category: "edge",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${hostedZoneCount} hosted zone and ${standardQueriesPerMonth.toLocaleString("en-US")} standard queries per month`,
      },
      service: {
        calculationComponents: {
          numberOfHostedZones: {
            value: String(hostedZoneCount),
          },
          RRsetRecord: {
            value: "0",
          },
          numberOfPolicyRecordsForTrafficFlow: {
            value: "0",
          },
          numberOfStandardQueries: {
            value: String(standardQueriesPerMonth),
            unit: "perMonth",
          },
        },
        serviceCode: "amazonRoute53",
        region,
        estimateFor: "Route53",
        version: "0.0.88",
        description: `Amazon Route 53 baseline. Environment: shared. ${hostedZoneCount} hosted zone and ${standardQueriesPerMonth.toLocaleString("en-US")} standard queries per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Route 53",
        regionName: regionNameFor(region),
        configSummary: `Hosted Zones (${hostedZoneCount}), Additional Records in Hosted Zones (0), Traffic Flow (0), Standard queries (${standardQueriesPerMonth.toLocaleString("en-US")} per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.5,
    detail: (units) => `${Math.round(units)} hosted-zone / query million equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const hostedZoneCount = parseNumericValue(
      service?.calculationComponents?.numberOfHostedZones?.value,
      0,
    );
    const standardQueriesPerMonth = parseFrequencyValue(
      service?.calculationComponents?.numberOfStandardQueries,
    );

    return route53MonthlyCost(service?.region, hostedZoneCount, standardQueriesPerMonth);
  },
};
