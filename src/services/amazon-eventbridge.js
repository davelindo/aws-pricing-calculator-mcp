import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const EVENTBRIDGE_PRICING = {
  "us-east-1": {
    customEventPerEvent: 1 / 1_000_000,
    partnerEventPerEvent: 1 / 1_000_000,
    optInDataEventPerEvent: 1 / 1_000_000,
  },
};
const DEFAULT_PAYLOAD_KB = 64;

function eventbridgePricingFor(region) {
  return scaledRegionalPricing(EVENTBRIDGE_PRICING, region, "EventBridge exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "millionPerMonth":
      return numericValue * 1_000_000;
    case "perMonth":
    default:
      return numericValue;
  }
}

function billablePayloadUnits(payloadKb) {
  return Math.max(Math.ceil(Math.max(Number(payloadKb) || 0, 0) / 64), 1);
}

function eventbridgeMonthlyCost({
  region,
  payloadKb,
  customEventCount,
  partnerEventCount,
  optInDataEventCount,
}) {
  const pricing = eventbridgePricingFor(region);
  const payloadUnits = billablePayloadUnits(payloadKb);

  return roundCurrency(
    Math.max(Number(customEventCount) || 0, 0) * payloadUnits * pricing.customEventPerEvent +
      Math.max(Number(partnerEventCount) || 0, 0) * payloadUnits * pricing.partnerEventPerEvent +
      Math.max(Number(optInDataEventCount) || 0, 0) * payloadUnits * pricing.optInDataEventPerEvent,
  );
}

function customEventCountForBudget(region, monthlyBudgetUsd, payloadKb = DEFAULT_PAYLOAD_KB) {
  const pricing = eventbridgePricingFor(region);
  const payloadUnits = billablePayloadUnits(payloadKb);

  return Math.max(
    Math.round(Math.max(Number(monthlyBudgetUsd) || 0, 0) / pricing.customEventPerEvent / payloadUnits),
    0,
  );
}

export const amazonEventbridgeService = {
  id: "amazon-eventbridge",
  name: "Amazon EventBridge",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["eventbridge", "event bus", "events"],
  pricingStrategies: ["standard", "high-throughput"],
  calculatorServiceCodes: ["amazonEventBridge"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const payloadKb = DEFAULT_PAYLOAD_KB;
    const customEventCount = customEventCountForBudget(region, monthlyBudgetUsd, payloadKb);
    const monthlyUsd = eventbridgeMonthlyCost({
      region,
      payloadKb,
      customEventCount,
      partnerEventCount: 0,
      optInDataEventCount: 0,
    });

    return {
      key: `amazonEventBridge-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-eventbridge",
        kind: "amazonEventBridge",
        label: "Amazon EventBridge",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${customEventCount.toLocaleString("en-US")} custom events per month at ${payloadKb} KB payloads`,
      },
      service: {
        calculationComponents: {
          Size_of_the_payload: {
            value: String(payloadKb),
            unit: "kb|NA",
          },
          Number_of_AWS_management_events: {
            value: "0",
            unit: "perMonth",
          },
          Number_of_AWS_opt_in_data_events: {
            value: "0",
            unit: "perMonth",
          },
          Number_of_custom_events: {
            value: String(customEventCount),
            unit: "perMonth",
          },
          Number_of_partner_events: {
            value: "0",
            unit: "perMonth",
          },
        },
        serviceCode: "amazonEventBridge",
        region,
        estimateFor: "template_0",
        version: "0.0.50",
        description: `Amazon EventBridge custom-event baseline. Environment: shared. ${customEventCount.toLocaleString("en-US")} custom events per month at ${payloadKb} KB payloads.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon EventBridge",
        regionName: regionNameFor(region),
        configSummary: `Size of the payload (${payloadKb} KB), Number of AWS management events (0 per month), Number of AWS opt-in data events (0 per month), Number of custom events (${customEventCount.toLocaleString("en-US")} per month), Number of partner events (0 per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 1,
    detail: (units) => `${Math.round(units)} million event bus ingestion units`,
  }),
  modelSavedMonthlyUsd(service) {
    return eventbridgeMonthlyCost({
      region: service?.region,
      payloadKb: parseNumericValue(service?.calculationComponents?.Size_of_the_payload?.value, 0),
      customEventCount: parseFrequencyValue(service?.calculationComponents?.Number_of_custom_events),
      partnerEventCount: parseFrequencyValue(service?.calculationComponents?.Number_of_partner_events),
      optInDataEventCount: parseFrequencyValue(
        service?.calculationComponents?.Number_of_AWS_opt_in_data_events,
      ),
    });
  },
};
