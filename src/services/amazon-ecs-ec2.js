import { buildCapabilityMatrix, buildModeledBudgetPricer } from "./helpers.js";

export const amazonEcsEc2Service = {
  id: "amazon-ecs-ec2",
  name: "Amazon ECS on EC2",
  category: "compute",
  implementationStatus: "modeled",
  keywords: ["ecs", "ecs ec2"],
  pricingStrategies: ["on-demand", "savings-plans", "reserved"],
  calculatorServiceCodes: [],
  capabilityMatrix: buildCapabilityMatrix({
    modeled: ["us-east-1", "ca-central-1", "sa-east-1", "eu-west-1", "ap-southeast-2", "ap-northeast-2"],
    modeledReason:
      "Amazon ECS on EC2 is modeled across the roadmap regions. Exact calculator serialization is not parity-verified yet.",
  }),
  priceBudget: buildModeledBudgetPricer({
    unitRate: 260,
    detail: (units) => `${Math.round(units)} ECS on EC2 cluster-month equivalents`,
  }),
};
