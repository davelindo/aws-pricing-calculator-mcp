import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const ALB_PRICING = {
  "us-east-1": {
    balancerHourly: 0.0225,
    lcuHourly: 0.008,
  },
};

function albPricingFor(region) {
  return scaledRegionalPricing(ALB_PRICING, region, "ALB exact pricing");
}

function monthlyAlbCost(region, balancerCount, lambdaDataGbPerHour, ec2DataGbPerHour) {
  const pricing = albPricingFor(region);
  const processedLcuPerHour = lambdaDataGbPerHour / 0.4 + ec2DataGbPerHour;

  return roundCurrency(
    balancerCount * pricing.balancerHourly * HOURS_PER_MONTH +
      processedLcuPerHour * pricing.lcuHourly * HOURS_PER_MONTH,
  );
}

function ec2DataGbPerHourForBudget(region, monthlyBudgetUsd, balancerCount) {
  const pricing = albPricingFor(region);
  const fixedMonthly = balancerCount * pricing.balancerHourly * HOURS_PER_MONTH;
  const remaining = Math.max(Number(monthlyBudgetUsd) - fixedMonthly, 0);

  return roundCurrency(remaining / (pricing.lcuHourly * HOURS_PER_MONTH));
}

export const applicationLoadBalancerService = {
  id: "application-load-balancer",
  name: "Application Load Balancer",
  category: "networking",
  implementationStatus: "implemented",
  keywords: ["alb", "load balancer", "ingress"],
  pricingStrategies: ["standard"],
  calculatorServiceCodes: ["amazonELB"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, loadBalancerCount = 1, notes }) {
    const ec2DataGbPerHour = ec2DataGbPerHourForBudget(region, monthlyBudgetUsd, loadBalancerCount);
    const lambdaDataGbPerHour = 0;
    const monthlyUsd = monthlyAlbCost(
      region,
      loadBalancerCount,
      lambdaDataGbPerHour,
      ec2DataGbPerHour,
    );

    return {
      key: `amazonELB-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "application-load-balancer",
        kind: "applicationLoadBalancer",
        label: "Application Load Balancer",
        category: "networking",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${loadBalancerCount} ALB, ${ec2DataGbPerHour} GB/hour processed for EC2/IP targets`,
      },
      service: {
        calculationComponents: {
          applicationLoadBalancer_generated_0: {
            value: String(loadBalancerCount),
          },
          applicationLoadBalancer_generated_4: {
            value: String(lambdaDataGbPerHour),
            unit: "gb|hour",
          },
          applicationLoadBalancer_generated_5: {
            value: String(ec2DataGbPerHour),
            unit: "gb|hour",
          },
          applicationLoadBalancer_generated_6: {
            value: "0",
            unit: "perSecond",
          },
          applicationLoadBalancer_generated_7: {
            value: "60",
            unit: "sec",
          },
          applicationLoadBalancer_generated_8: {
            value: "1",
            unit: "perSecond",
          },
          applicationLoadBalancer_generated_9: {
            value: "0",
          },
        },
        serviceCode: "amazonELB",
        region,
        estimateFor: "template_0",
        version: "0.0.1",
        description: `Application Load Balancer baseline. Environment: shared. ${loadBalancerCount} ALB with ${ec2DataGbPerHour} GB/hour processed for EC2/IP targets.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Elastic Load Balancing",
        regionName: regionNameFor(region),
        configSummary: `Number of Application Load Balancers (${loadBalancerCount}), Lambda target data processed (${lambdaDataGbPerHour} GB per hour), EC2/IP target data processed (${ec2DataGbPerHour} GB per hour), Average number of new connections (0 per second), Connection duration (60 seconds), Requests per connection (1 per second), Rule evaluations (0)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 21,
    detail: (units) => `${units} ALB/Lcu-equivalent monthly units`,
  }),
  modelSavedMonthlyUsd(service) {
    const balancerCount = parseNumericValue(
      service?.calculationComponents?.applicationLoadBalancer_generated_0?.value,
      0,
    );
    const lambdaDataGbPerHour = parseNumericValue(
      service?.calculationComponents?.applicationLoadBalancer_generated_4?.value,
      0,
    );
    const ec2DataGbPerHour = parseNumericValue(
      service?.calculationComponents?.applicationLoadBalancer_generated_5?.value,
      0,
    );

    return monthlyAlbCost(service?.region, balancerCount, lambdaDataGbPerHour, ec2DataGbPerHour);
  },
};
