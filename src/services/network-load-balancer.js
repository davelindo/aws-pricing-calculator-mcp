import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const HOURS_PER_MONTH = 730;
const NLB_PRICING = {
  "us-east-1": {
    balancerHourly: 0.0225,
    lcuHourly: 0.006,
  },
};

function nlbPricingFor(region) {
  return scaledRegionalPricing(NLB_PRICING, region, "NLB exact pricing");
}

function parseTransferGbPerHour(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const [sizeUnit, frequencyUnit = "hour"] = String(component.unit ?? "gb|hour").split("|");
  let valueInGb =
    sizeUnit === "tb" ? numericValue * 1024 : numericValue;

  if (frequencyUnit === "month") {
    valueInGb /= HOURS_PER_MONTH;
  }

  return valueInGb;
}

function parseConnectionsPerSecond(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perSecond";

  switch (unit) {
    case "perMinute":
      return numericValue / 60;
    case "perHour":
      return numericValue / (60 * 60);
    case "perDay":
      return numericValue / (24 * 60 * 60);
    case "perMonth":
      return numericValue / (30.4167 * 24 * 60 * 60);
    case "perSecond":
    default:
      return numericValue;
  }
}

function parseDurationSeconds(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "sec";

  switch (unit) {
    case "min":
      return numericValue * 60;
    case "hour":
    case "hr":
      return numericValue * 60 * 60;
    case "sec":
    default:
      return numericValue;
  }
}

function lcusForTraffic(processedGbPerHour, newConnectionsPerSecond, durationSeconds, {
  newConnectionsPerLcu,
  activeConnectionsPerLcu,
}) {
  const processedLcus = Math.max(Number(processedGbPerHour) || 0, 0);
  const newConnectionLcus =
    Math.max(Number(newConnectionsPerSecond) || 0, 0) / newConnectionsPerLcu;
  const activeConnectionLcus =
    (Math.max(Number(newConnectionsPerSecond) || 0, 0) * Math.max(Number(durationSeconds) || 0, 0)) /
    activeConnectionsPerLcu;

  return Math.max(processedLcus, newConnectionLcus, activeConnectionLcus);
}

function nlbMonthlyCost(
  region,
  balancerCount,
  {
    tcpProcessedGbPerHour,
    tcpNewConnectionsPerSecond,
    tcpDurationSeconds,
    udpProcessedGbPerHour,
    udpNewFlowsPerSecond,
    udpDurationSeconds,
    tlsProcessedGbPerHour,
    tlsNewConnectionsPerSecond,
    tlsDurationSeconds,
  },
) {
  const pricing = nlbPricingFor(region);
  const tcpLcus = lcusForTraffic(
    tcpProcessedGbPerHour,
    tcpNewConnectionsPerSecond,
    tcpDurationSeconds,
    {
      newConnectionsPerLcu: 800,
      activeConnectionsPerLcu: 100_000,
    },
  );
  const udpLcus = lcusForTraffic(
    udpProcessedGbPerHour,
    udpNewFlowsPerSecond,
    udpDurationSeconds,
    {
      newConnectionsPerLcu: 400,
      activeConnectionsPerLcu: 50_000,
    },
  );
  const tlsLcus = lcusForTraffic(
    tlsProcessedGbPerHour,
    tlsNewConnectionsPerSecond,
    tlsDurationSeconds,
    {
      newConnectionsPerLcu: 50,
      activeConnectionsPerLcu: 3_000,
    },
  );
  const lcuMonthly =
    (tcpLcus + udpLcus + tlsLcus) * pricing.lcuHourly * HOURS_PER_MONTH;

  return roundCurrency(
    Math.max(Number(balancerCount) || 0, 0) *
      (pricing.balancerHourly * HOURS_PER_MONTH + lcuMonthly),
  );
}

function tcpProcessedGbPerHourForBudget(region, monthlyBudgetUsd, balancerCount) {
  const pricing = nlbPricingFor(region);
  const fixedMonthly =
    Math.max(Number(balancerCount) || 0, 0) * pricing.balancerHourly * HOURS_PER_MONTH;
  const remainingBudget = Math.max(Number(monthlyBudgetUsd) - fixedMonthly, 0);

  return roundCurrency(remainingBudget / (pricing.lcuHourly * HOURS_PER_MONTH));
}

export const networkLoadBalancerService = {
  id: "network-load-balancer",
  name: "Network Load Balancer",
  category: "networking",
  implementationStatus: "implemented",
  keywords: ["nlb", "network load balancer"],
  pricingStrategies: ["standard"],
  calculatorServiceCodes: ["networkLoadBalancer"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const balancerCount = 1;
    const tcpProcessedGbPerHour = tcpProcessedGbPerHourForBudget(
      region,
      monthlyBudgetUsd,
      balancerCount,
    );
    const tcpNewConnectionsPerSecond = 0;
    const tcpDurationSeconds = 60;
    const udpProcessedGbPerHour = 0;
    const udpNewFlowsPerSecond = 0;
    const udpDurationSeconds = 60;
    const tlsProcessedGbPerHour = 0;
    const tlsNewConnectionsPerSecond = 0;
    const tlsDurationSeconds = 60;
    const monthlyUsd = nlbMonthlyCost(region, balancerCount, {
      tcpProcessedGbPerHour,
      tcpNewConnectionsPerSecond,
      tcpDurationSeconds,
      udpProcessedGbPerHour,
      udpNewFlowsPerSecond,
      udpDurationSeconds,
      tlsProcessedGbPerHour,
      tlsNewConnectionsPerSecond,
      tlsDurationSeconds,
    });

    return {
      key: `networkLoadBalancer-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "network-load-balancer",
        kind: "networkLoadBalancer",
        label: "Network Load Balancer",
        category: "networking",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${balancerCount} NLB, ${tcpProcessedGbPerHour} GB/hour TCP processed, UDP/TLS idle`,
      },
      service: {
        calculationComponents: {
          numberOfNetworkLoadBalancers: {
            value: String(balancerCount),
          },
          sizeOfProcessedDataPerNLBForTCP: {
            value: String(tcpProcessedGbPerHour),
            unit: "gb|hour",
          },
          averageNumberOfNewTCPConnections: {
            value: String(tcpNewConnectionsPerSecond),
            unit: "perSecond",
          },
          averageTCPConnectionDuration: {
            value: String(tcpDurationSeconds),
            unit: "sec",
          },
          sizeOfDataProcessedPerNLBForUDP: {
            value: String(udpProcessedGbPerHour),
            unit: "gb|hour",
          },
          averageNumberOfNewUDPFlows: {
            value: String(udpNewFlowsPerSecond),
            unit: "perSecond",
          },
          averageUDPFlowduration: {
            value: String(udpDurationSeconds),
            unit: "sec",
          },
          sizeOfDataProcessedPerNLBForTLS: {
            value: String(tlsProcessedGbPerHour),
            unit: "gb|hour",
          },
          averageNumberOfNewTLSConnections: {
            value: String(tlsNewConnectionsPerSecond),
            unit: "perSecond",
          },
          averageDurationForTLSConnection: {
            value: String(tlsDurationSeconds),
            unit: "sec",
          },
        },
        serviceCode: "networkLoadBalancer",
        region,
        estimateFor: "template_0",
        version: "0.0.21",
        description: `Network Load Balancer baseline. Environment: shared. ${balancerCount} NLB with ${tcpProcessedGbPerHour} GB/hour of TCP traffic and idle UDP/TLS dimensions.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Network Load Balancer",
        regionName: regionNameFor(region),
        configSummary: `Number of Network Load Balancers (${balancerCount}), Processed bytes per NLB for TCP (${tcpProcessedGbPerHour} GB per hour), Average number of new TCP connections (${tcpNewConnectionsPerSecond} per second), Average TCP connection duration (${tcpDurationSeconds} seconds), Processed bytes per NLB for UDP (${udpProcessedGbPerHour} GB per hour), Average number of new UDP Flows (${udpNewFlowsPerSecond} per second), Average UDP Flow duration (${udpDurationSeconds} seconds), Processed bytes per NLB for TLS (${tlsProcessedGbPerHour} GB per hour), Average number of new TLS connections (${tlsNewConnectionsPerSecond} per second), Average TLS connection duration (${tlsDurationSeconds} seconds)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 140,
    detail: (units) => `${Math.round(units)} NLB/Lcu-equivalent months`,
  }),
  modelSavedMonthlyUsd(service) {
    return nlbMonthlyCost(service?.region, parseNumericValue(
      service?.calculationComponents?.numberOfNetworkLoadBalancers?.value,
      0,
    ), {
      tcpProcessedGbPerHour: parseTransferGbPerHour(
        service?.calculationComponents?.sizeOfProcessedDataPerNLBForTCP,
      ),
      tcpNewConnectionsPerSecond: parseConnectionsPerSecond(
        service?.calculationComponents?.averageNumberOfNewTCPConnections,
      ),
      tcpDurationSeconds: parseDurationSeconds(
        service?.calculationComponents?.averageTCPConnectionDuration,
      ),
      udpProcessedGbPerHour: parseTransferGbPerHour(
        service?.calculationComponents?.sizeOfDataProcessedPerNLBForUDP,
      ),
      udpNewFlowsPerSecond: parseConnectionsPerSecond(
        service?.calculationComponents?.averageNumberOfNewUDPFlows,
      ),
      udpDurationSeconds: parseDurationSeconds(
        service?.calculationComponents?.averageUDPFlowduration,
      ),
      tlsProcessedGbPerHour: parseTransferGbPerHour(
        service?.calculationComponents?.sizeOfDataProcessedPerNLBForTLS,
      ),
      tlsNewConnectionsPerSecond: parseConnectionsPerSecond(
        service?.calculationComponents?.averageNumberOfNewTLSConnections,
      ),
      tlsDurationSeconds: parseDurationSeconds(
        service?.calculationComponents?.averageDurationForTLSConnection,
      ),
    });
  },
};
