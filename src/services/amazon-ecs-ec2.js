import {
  buildEc2Service,
  ec2PricingStrategyMultiplier,
  modelEc2MonthlyUsd,
  parseNumericValue,
  roundCurrency,
} from "../model.js";
import { buildModeledBudgetPricer, buildRoadmapExactCapability } from "./helpers.js";

const ECS_EC2_DESCRIPTION_PREFIX = "Amazon ECS on EC2 container host baseline.";
const ECS_EC2_INSTANCE_TYPES = ["m6i.large", "m6i.xlarge", "m6i.2xlarge"];

function ecsEc2PricingLabel(selectedPricingStrategy) {
  switch (selectedPricingStrategy) {
    case "savings-plans":
      return "Savings Plans";
    case "reserved":
      return "Reserved";
    case "reserved-heavy":
      return "Reserved Heavy";
    case "spot":
      return "Spot";
    case "on-demand":
    default:
      return "On-Demand";
  }
}

function ecsEc2ShapeForBudget(region, monthlyBudgetUsd, pricingStrategy = {}) {
  const selectedPricingStrategy = pricingStrategy.selectedOption ?? "on-demand";
  const pricingMultiplier = ec2PricingStrategyMultiplier(selectedPricingStrategy);
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const candidates = [];

  for (const instanceType of ECS_EC2_INSTANCE_TYPES) {
    const monthlyPerHost = roundCurrency(
      modelEc2MonthlyUsd(region, "linux", instanceType, 1) * pricingMultiplier,
    );
    const nominalHostCount = monthlyPerHost > 0 ? budget / monthlyPerHost : 0;
    const hostCounts = new Set([
      2,
      Math.max(2, Math.floor(nominalHostCount)),
      Math.max(2, Math.round(nominalHostCount)),
      Math.max(2, Math.ceil(nominalHostCount)),
    ]);

    for (const instanceCount of hostCounts) {
      candidates.push({
        instanceType,
        instanceCount,
        monthlyUsd: roundCurrency(monthlyPerHost * instanceCount),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget) ||
      left.monthlyUsd - right.monthlyUsd,
  );

  return candidates[0];
}

export function isEcsEc2SavedService(service) {
  return (
    service?.serviceCode === "ec2Enhancement" &&
    String(service?.description ?? "").includes(ECS_EC2_DESCRIPTION_PREFIX)
  );
}

export const amazonEcsEc2Service = {
  id: "amazon-ecs-ec2",
  name: "Amazon ECS on EC2",
  category: "compute",
  implementationStatus: "implemented",
  keywords: ["ecs", "ecs ec2", "ecs on ec2", "container hosts"],
  pricingStrategies: ["on-demand", "savings-plans", "reserved", "spot"],
  calculatorServiceCodes: ["ec2Enhancement"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes, instanceType, instanceCount, pricingStrategy = {} }) {
    const selectedPricingStrategy = pricingStrategy.selectedOption ?? "on-demand";
    const shape =
      instanceType && instanceCount
        ? {
            instanceType,
            instanceCount,
          }
        : ecsEc2ShapeForBudget(region, monthlyBudgetUsd, pricingStrategy);
    const baseEntry = buildEc2Service(
      "shared",
      region,
      "linux",
      shape.instanceType,
      shape.instanceCount,
      null,
      pricingStrategy,
    );
    const pricingLabel = ecsEc2PricingLabel(selectedPricingStrategy);
    const details = `${shape.instanceCount} ${shape.instanceType} Linux ECS container hosts with ${pricingLabel} pricing.`;

    return {
      ...baseEntry,
      breakdown: {
        ...baseEntry.breakdown,
        serviceId: "amazon-ecs-ec2",
        kind: "amazonEcsEc2",
        label: "Amazon ECS on EC2",
        implementationStatus: "implemented",
        details,
      },
      service: {
        ...baseEntry.service,
        description: `${ECS_EC2_DESCRIPTION_PREFIX} Environment: shared. ${details}${notes ? ` ${notes}` : ""}`,
        configSummary: `${baseEntry.service.configSummary}, Container orchestration (Amazon ECS on EC2)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 260,
    detail: (units) => `${Math.round(units)} ECS on EC2 container host-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const instanceType = service?.calculationComponents?.instanceType?.value;
    const instanceCount = parseNumericValue(
      service?.calculationComponents?.workload?.value?.data,
      0,
    );
    const selectedOption =
      service?.calculationComponents?.pricingStrategy?.value?.selectedOption ?? "on-demand";

    return roundCurrency(
      modelEc2MonthlyUsd(service?.region, "linux", instanceType, instanceCount) *
        ec2PricingStrategyMultiplier(selectedOption),
    );
  },
};
