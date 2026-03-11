import { buildModeledBudgetPricer, buildRoadmapExactCapability } from "./helpers.js";
import { buildNatService, modelNatMonthlyUsd, parseNumericValue } from "../model.js";

export const amazonVpcNatService = {
  id: "amazon-vpc-nat",
  name: "Amazon VPC / NAT Gateway",
  category: "networking",
  implementationStatus: "implemented",
  keywords: ["nat", "vpc", "network"],
  pricingStrategies: ["standard"],
  calculatorServiceCodes: ["amazonVirtualPrivateCloud"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, natPlan, notes }) {
    return buildNatService(region, natPlan, notes);
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 110,
    detail: (units) => `${Math.round(units)} NAT gateway-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const nat = service?.subServices?.[0]?.calculationComponents ?? {};

    return modelNatMonthlyUsd(
      service?.region,
      parseNumericValue(nat.regionalNatGatewayCount?.value, 0),
      parseNumericValue(nat.regionalNatGatewayAzCount?.value, 0),
      parseNumericValue(nat.regionalNatGatewayDataProcessed?.value, 0),
    );
  },
};
