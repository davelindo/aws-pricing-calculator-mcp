import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const PRIVATE_LINK_PRICING = {
  "us-east-1": {
    endpointHourly: 0.01,
    dataTiers: [
      { upperGb: 1_048_576, rate: 0.01 },
      { upperGb: 5_242_880, rate: 0.006 },
      { upperGb: Number.POSITIVE_INFINITY, rate: 0.004 },
    ],
  },
};

function privateLinkPricingFor(region) {
  return scaledRegionalPricing(PRIVATE_LINK_PRICING, region, "AWS PrivateLink exact pricing");
}

function parseTransferGb(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const [sizeUnit] = String(component.unit ?? "gb|month").split("|");

  switch (sizeUnit) {
    case "pb":
      return numericValue * 1024 * 1024;
    case "tb":
      return numericValue * 1024;
    case "gb":
    default:
      return numericValue;
  }
}

function privateLinkDataProcessingCostUsd(pricing, processedGb) {
  let remainingGb = Math.max(Number(processedGb) || 0, 0);
  let previousUpperGb = 0;
  let total = 0;

  for (const tier of pricing.dataTiers) {
    if (remainingGb <= 0) {
      break;
    }

    const tierSpanGb =
      tier.upperGb === Number.POSITIVE_INFINITY
        ? remainingGb
        : Math.min(remainingGb, tier.upperGb - previousUpperGb);

    total += tierSpanGb * tier.rate;
    remainingGb -= tierSpanGb;
    previousUpperGb = tier.upperGb;
  }

  return total;
}

function privateLinkMonthlyCost(region, endpointCount, availabilityZoneCount, processedGb) {
  const pricing = privateLinkPricingFor(region);
  const endpointMonthly =
    Math.max(Number(endpointCount) || 0, 0) *
    Math.max(Number(availabilityZoneCount) || 0, 0) *
    HOURS_PER_MONTH *
    pricing.endpointHourly;

  return roundCurrency(endpointMonthly + privateLinkDataProcessingCostUsd(pricing, processedGb));
}

function dataGbForBudget(region, monthlyBudgetUsd, endpointCount, availabilityZoneCount) {
  const pricing = privateLinkPricingFor(region);
  const fixedMonthly =
    Math.max(Number(endpointCount) || 0, 0) *
    Math.max(Number(availabilityZoneCount) || 0, 0) *
    HOURS_PER_MONTH *
    pricing.endpointHourly;
  let remainingBudget = Math.max(Number(monthlyBudgetUsd) - fixedMonthly, 0);
  let processedGb = 0;
  let previousUpperGb = 0;

  for (const tier of pricing.dataTiers) {
    if (remainingBudget <= 0) {
      break;
    }

    const tierSpanGb =
      tier.upperGb === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : tier.upperGb - previousUpperGb;
    const tierCost =
      tierSpanGb === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : tierSpanGb * tier.rate;

    if (remainingBudget >= tierCost) {
      processedGb += tierSpanGb;
      remainingBudget -= tierCost;
      previousUpperGb = tier.upperGb;
      continue;
    }

    processedGb += remainingBudget / tier.rate;
    remainingBudget = 0;
  }

  return roundCurrency(processedGb);
}

export const amazonVpcEndpointsService = {
  id: "amazon-vpc-endpoints",
  name: "VPC Endpoints / PrivateLink",
  category: "networking",
  implementationStatus: "implemented",
  keywords: ["private link", "privatelink", "vpc endpoint", "endpoint"],
  pricingStrategies: ["interface", "gateway"],
  calculatorServiceCodes: ["awsPrivateLinkVpc"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const endpointCount = 1;
    const availabilityZoneCount = 1;
    const processedGb = dataGbForBudget(
      region,
      monthlyBudgetUsd,
      endpointCount,
      availabilityZoneCount,
    );
    const monthlyUsd = privateLinkMonthlyCost(
      region,
      endpointCount,
      availabilityZoneCount,
      processedGb,
    );

    return {
      key: `awsPrivateLinkVpc-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-vpc-endpoints",
        kind: "awsPrivateLinkVpc",
        label: "AWS PrivateLink",
        category: "networking",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${endpointCount} interface endpoint in ${availabilityZoneCount} AZ, ${processedGb.toLocaleString("en-US")} GB processed per month`,
      },
      service: {
        calculationComponents: {
          numberOfInterfaceVPCEndpointsPerRegion: {
            value: String(endpointCount),
          },
          numberOfAvailabilityZonesEndpointsDeployed: {
            value: String(availabilityZoneCount),
          },
          dataProcessedByEachVPCENIAZ: {
            value: String(processedGb),
            unit: "gb|month",
          },
        },
        serviceCode: "awsPrivateLinkVpc",
        region,
        estimateFor: "awsPrivateLink",
        version: "0.0.17",
        description: `AWS PrivateLink baseline. Environment: shared. ${endpointCount} interface endpoint in ${availabilityZoneCount} Availability Zone with ${processedGb.toLocaleString("en-US")} GB processed per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS PrivateLink",
        regionName: regionNameFor(region),
        configSummary: `Number of VPC Interface endpoints per AWS region (${endpointCount}), Number of Availability Zones an Interface endpoint is deployed in (${availabilityZoneCount}), Total data processed by all VPCE Interface endpoints in the AWS region (${processedGb.toLocaleString("en-US")} GB per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 90,
    detail: (units) => `${Math.round(units)} interface endpoint month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return privateLinkMonthlyCost(
      service?.region,
      parseNumericValue(service?.calculationComponents?.numberOfInterfaceVPCEndpointsPerRegion?.value, 0),
      parseNumericValue(
        service?.calculationComponents?.numberOfAvailabilityZonesEndpointsDeployed?.value,
        0,
      ),
      parseTransferGb(service?.calculationComponents?.dataProcessedByEachVPCENIAZ),
    );
  },
};
