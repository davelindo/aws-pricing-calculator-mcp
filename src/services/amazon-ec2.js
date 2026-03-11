import { buildModeledBudgetPricer, buildRoadmapExactCapability } from "./helpers.js";
import {
  buildEc2Service,
  ec2PricingStrategyMultiplier,
  modelEc2MonthlyUsd,
  parseNumericValue,
  roundCurrency,
} from "../model.js";

export const amazonEc2Service = {
  id: "amazon-ec2",
  name: "Amazon EC2",
  category: "compute",
  implementationStatus: "implemented",
  keywords: ["ec2", "vm", "instance", "fleet", "windows", "linux"],
  pricingStrategies: ["on-demand", "savings-plans", "reserved", "spot"],
  calculatorServiceCodes: ["ec2Enhancement"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ environment, region, operatingSystem, instanceType, instanceCount, notes, pricingStrategy }) {
    return buildEc2Service(
      environment,
      region,
      operatingSystem,
      instanceType,
      instanceCount,
      notes,
      pricingStrategy,
    );
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 180,
    detail: (units) => `${Math.round(units)} EC2 instance-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const operatingSystem = service?.calculationComponents?.selectedOS?.value;
    const instanceType = service?.calculationComponents?.instanceType?.value;
    const instanceCount = parseNumericValue(
      service?.calculationComponents?.workload?.value?.data,
      0,
    );
    const selectedOption =
      service?.calculationComponents?.pricingStrategy?.value?.selectedOption ?? "on-demand";

    return roundCurrency(
      modelEc2MonthlyUsd(service?.region, operatingSystem, instanceType, instanceCount) *
        ec2PricingStrategyMultiplier(selectedOption),
    );
  },
};
