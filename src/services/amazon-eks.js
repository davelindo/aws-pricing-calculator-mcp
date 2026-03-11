import { buildEksService, modelEksMonthlyUsd, parseNumericValue } from "../model.js";
import { buildModeledBudgetPricer, buildRoadmapExactCapability } from "./helpers.js";

export const amazonEksService = {
  id: "amazon-eks",
  name: "Amazon EKS",
  category: "compute",
  implementationStatus: "implemented",
  keywords: ["eks", "kubernetes", "argocd"],
  pricingStrategies: ["on-demand"],
  calculatorServiceCodes: ["awsEks"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ environment, region, notes }) {
    return buildEksService(environment, region, notes);
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 73,
    detail: (units) => `${Math.round(units)} EKS cluster-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const clusterCount = parseNumericValue(
      service?.calculationComponents?.numberOfEKSClusters?.value,
      0,
    );

    return modelEksMonthlyUsd(service?.region, clusterCount);
  },
};
