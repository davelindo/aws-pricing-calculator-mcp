import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const GLUE_ETL_SERVICE_CODE = "awsEtlJobsAndDevelopmentEndpoints";
const GLUE_ETL_ESTIMATE_FOR = "template_0";
const GLUE_ETL_VERSION = "0.0.29";
const GLUE_ETL_PRICING = {
  "us-east-1": {
    dpuPerHour: 0.44,
  },
};

function glueEtlPricingFor(region) {
  return scaledRegionalPricing(GLUE_ETL_PRICING, region, "Glue ETL exact pricing");
}

function parseDurationHours(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "hr";

  switch (unit) {
    case "min":
      return numericValue / 60;
    case "sec":
      return numericValue / 3600;
    case "hr":
    default:
      return numericValue;
  }
}

function glueEtlMonthlyUsd({
  region,
  sparkDpus = 0,
  sparkHours = 0,
  pythonDpus = 0,
  pythonHours = 0,
  interactiveDpus = 0,
  interactiveHours = 0,
  devEndpointDpus = 0,
  devEndpointHours = 0,
}) {
  const rate = glueEtlPricingFor(region).dpuPerHour;

  return roundCurrency(
    (Math.max(sparkDpus, 0) * Math.max(sparkHours, 0) +
      Math.max(pythonDpus, 0) * Math.max(pythonHours, 0) +
      Math.max(interactiveDpus, 0) * Math.max(interactiveHours, 0) +
      Math.max(devEndpointDpus, 0) * Math.max(devEndpointHours, 0)) *
      rate,
  );
}

function glueEtlShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const sparkDpus =
    budget >= 8_000 ? 80 : budget >= 4_000 ? 40 : budget >= 1_500 ? 20 : 10;
  const sparkHours = Math.max(
    Math.min(roundCurrency(budget / (sparkDpus * glueEtlPricingFor(region).dpuPerHour)), 730),
    1,
  );
  const monthlyUsd = glueEtlMonthlyUsd({
    region,
    sparkDpus,
    sparkHours,
  });

  return {
    sparkDpus,
    sparkHours,
    pythonDpus: 0,
    pythonHours: 0,
    interactiveDpus: 0,
    interactiveHours: 0,
    devEndpointDpus: 0,
    devEndpointHours: 0,
    monthlyUsd,
  };
}

export const awsGlueEtlService = {
  id: "aws-glue-etl",
  name: "AWS Glue ETL Jobs",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["glue", "etl", "spark"],
  pricingStrategies: ["serverless-etl"],
  calculatorServiceCodes: [GLUE_ETL_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = glueEtlShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${GLUE_ETL_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "aws-glue-etl",
        kind: GLUE_ETL_SERVICE_CODE,
        label: "AWS Glue ETL",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.sparkDpus} Spark DPUs for ${profile.sparkHours} hours per month`,
      },
      service: {
        calculationComponents: {
          numberOfDPUsForApacheSpark: {
            value: String(profile.sparkDpus),
          },
          durationForApacheSparkJob: {
            value: String(profile.sparkHours),
            unit: "hr",
          },
          numberOfDPUsForPythonShell: {
            value: String(profile.pythonDpus),
          },
          durationForPythonShellJob: {
            value: String(profile.pythonHours),
            unit: "hr",
          },
          numberOfDPUsForInteractiveSession: {
            value: String(profile.interactiveDpus),
          },
          durationForInteractiveSession: {
            value: String(profile.interactiveHours),
            unit: "hr",
          },
          numberOfDPUsForDevelopmentEndpoints: {
            value: String(profile.devEndpointDpus),
          },
          durationForDevelopmentEndpoint: {
            value: String(profile.devEndpointHours),
            unit: "hr",
          },
        },
        serviceCode: GLUE_ETL_SERVICE_CODE,
        region,
        estimateFor: GLUE_ETL_ESTIMATE_FOR,
        version: GLUE_ETL_VERSION,
        description: `AWS Glue ETL baseline. Environment: shared. ${profile.sparkDpus} Apache Spark DPUs for ${profile.sparkHours} hours per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Glue ETL jobs and development endpoints",
        regionName: regionNameFor(region),
        configSummary: `Number of DPUs for Apache Spark job (${profile.sparkDpus}), Duration for which Apache Spark ETL job runs (${profile.sparkHours} hours per month), Number of DPUs for Python Shell job (${profile.pythonDpus}), Duration for which Python Shell job ETL runs (${profile.pythonHours} hours per month), Number of DPUs for each provisioned interactive session (${profile.interactiveDpus}), Duration for provisioned interactive sessions (${profile.interactiveHours} hours per month), Number of DPUs for each provisioned development endpoint (${profile.devEndpointDpus}), Duration for provisioned development endpoint (${profile.devEndpointHours} hours)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.44,
    detail: (units) => `${Math.round(units)} Glue DPU-hour equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return glueEtlMonthlyUsd({
      region: service?.region,
      sparkDpus: parseNumericValue(
        service?.calculationComponents?.numberOfDPUsForApacheSpark?.value,
        0,
      ),
      sparkHours: parseDurationHours(service?.calculationComponents?.durationForApacheSparkJob),
      pythonDpus: parseNumericValue(
        service?.calculationComponents?.numberOfDPUsForPythonShell?.value,
        0,
      ),
      pythonHours: parseDurationHours(service?.calculationComponents?.durationForPythonShellJob),
      interactiveDpus: parseNumericValue(
        service?.calculationComponents?.numberOfDPUsForInteractiveSession?.value,
        0,
      ),
      interactiveHours: parseDurationHours(
        service?.calculationComponents?.durationForInteractiveSession,
      ),
      devEndpointDpus: parseNumericValue(
        service?.calculationComponents?.numberOfDPUsForDevelopmentEndpoints?.value,
        0,
      ),
      devEndpointHours: parseDurationHours(
        service?.calculationComponents?.durationForDevelopmentEndpoint,
      ),
    });
  },
};
