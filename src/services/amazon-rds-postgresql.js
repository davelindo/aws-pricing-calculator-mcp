import { buildModeledBudgetPricer, buildRoadmapExactCapability } from "./helpers.js";
import {
  buildRdsService,
  modelRdsMonthlyUsd,
  parseNumericValue,
  rdsPricingModelMultiplier,
  roundCurrency,
} from "../model.js";

export const amazonRdsPostgresqlService = {
  id: "amazon-rds-postgresql",
  name: "Amazon RDS for PostgreSQL",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["postgres", "postgresql", "rds"],
  pricingStrategies: ["on-demand", "reserved", "single-az", "multi-az"],
  calculatorServiceCodes: ["amazonRDSPostgreSQLDB"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ environment, region, instanceType, deploymentOption, storageGb, notes, pricingModel }) {
    return buildRdsService(
      environment,
      region,
      instanceType,
      deploymentOption,
      storageGb,
      notes,
      pricingModel,
    );
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 450,
    detail: (units) => `${Math.round(units)} RDS PostgreSQL instance-month equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const storageGb = parseNumericValue(service?.calculationComponents?.storageAmount?.value, 0);
    const rows = service?.calculationComponents?.columnFormIPM?.value ?? [];

    return roundCurrency(
      rows.reduce((sum, row) => {
        const instanceType = row?.["Instance Type"]?.value;
        const deploymentOption = row?.["Deployment Option"]?.value;
        const nodeCount = parseNumericValue(row?.["Number of Nodes"]?.value, 1);
        const pricingModel = row?.TermType?.value ?? "OnDemand";

        return (
          sum +
          modelRdsMonthlyUsd(service?.region, instanceType, deploymentOption, storageGb, nodeCount) *
            rdsPricingModelMultiplier(pricingModel)
        );
      }, 0),
    );
  },
};
