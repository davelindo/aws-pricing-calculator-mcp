import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const FIREHOSE_SERVICE_CODE = "amazonKinesisFirehose";
const FIREHOSE_ESTIMATE_FOR = "KinesisDataFirehose";
const FIREHOSE_VERSION = "0.0.112";
const FIREHOSE_PRICING = {
  "us-east-1": {
    ingestPerGb: 0.029,
    dataFormatConversionPerGb: 0.021,
    vpcPerGb: 0.01,
    subnetPerHour: 0.01,
  },
};

function firehosePricingFor(region) {
  return scaledRegionalPricing(FIREHOSE_PRICING, region, "Amazon Data Firehose exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "perSecond":
      return numericValue * 730 * 60 * 60;
    case "perMinute":
      return numericValue * 730 * 60;
    case "perHour":
      return numericValue * 730;
    case "perDay":
      return numericValue * 30.4167;
    case "perWeek":
      return numericValue * (365 / 12 / 7);
    case "perMonth":
    default:
      return numericValue;
  }
}

function parseFileSizeKb(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const [sizeUnit] = String(component.unit ?? "gb|NA").split("|");

  switch (sizeUnit) {
    case "bytes":
      return numericValue / 1024;
    case "kb":
      return numericValue;
    case "mb":
      return numericValue * 1024;
    default:
      return numericValue;
  }
}

function firehoseMonthlyUsd({
  region,
  recordsPerMonth,
  recordMultiplier,
  recordSizeKb,
  enableFormatConversion = false,
  subnetCount = 0,
  vpcRetryRatio = 1,
}) {
  const pricing = firehosePricingFor(region);
  const actualRecordCount = Math.max(recordsPerMonth, 0) * Math.max(recordMultiplier, 1);
  const ingestedGb = (actualRecordCount * Math.max(recordSizeKb, 0)) / (1024 * 1024);

  return roundCurrency(
    ingestedGb * pricing.ingestPerGb +
      (enableFormatConversion ? ingestedGb * pricing.dataFormatConversionPerGb : 0) +
      (subnetCount > 0 ? ingestedGb * Math.max(vpcRetryRatio, 0) * pricing.vpcPerGb : 0) +
      subnetCount * 730 * pricing.subnetPerHour,
  );
}

function firehoseShapeForBudget(region, monthlyBudgetUsd) {
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const recordSizeKb = 512;
  const recordMultiplier = 1000;
  const enableFormatConversion = budget >= 1_200;
  const subnetCount = budget >= 2_500 ? 2 : 0;
  const vpcRetryRatio = subnetCount > 0 ? 1.2 : 1;
  const effectiveRatePerGb =
    firehosePricingFor(region).ingestPerGb +
    (enableFormatConversion ? firehosePricingFor(region).dataFormatConversionPerGb : 0) +
    (subnetCount > 0 ? firehosePricingFor(region).vpcPerGb * vpcRetryRatio : 0);
  const fixedVpcUsd = subnetCount * 730 * firehosePricingFor(region).subnetPerHour;
  const targetGb = Math.max((budget - fixedVpcUsd) / effectiveRatePerGb, 1);
  const recordsPerMonth = Math.max(
    Math.round((targetGb * 1024 * 1024) / (recordSizeKb * recordMultiplier)),
    1,
  );
  const monthlyUsd = firehoseMonthlyUsd({
    region,
    recordsPerMonth,
    recordMultiplier,
    recordSizeKb,
    enableFormatConversion,
    subnetCount,
    vpcRetryRatio,
  });

  return {
    sourceType: "direct",
    recordMultiplier,
    recordsPerMonth,
    recordSizeKb,
    enableFormatConversion,
    subnetCount,
    vpcRetryRatio,
    monthlyUsd,
  };
}

export const amazonKinesisFirehoseService = {
  id: "amazon-kinesis-firehose",
  name: "Amazon Data Firehose",
  category: "integration",
  implementationStatus: "implemented",
  keywords: ["firehose", "kinesis firehose", "stream ingest"],
  pricingStrategies: ["direct-put", "format-conversion", "vpc-delivery"],
  calculatorServiceCodes: [FIREHOSE_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = firehoseShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${FIREHOSE_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-kinesis-firehose",
        kind: FIREHOSE_SERVICE_CODE,
        label: "Amazon Data Firehose",
        category: "integration",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.recordsPerMonth.toLocaleString("en-US")} record units/month, ${profile.recordMultiplier}x multiplier, ${profile.recordSizeKb} KB records`,
      },
      service: {
        calculationComponents: {
          sourceType: {
            value: profile.sourceType,
          },
          recordMultDI: {
            value: String(profile.recordMultiplier),
          },
          numberOfRecordsIngested: {
            value: String(profile.recordsPerMonth),
            unit: "perMonth",
          },
          dataPerRecord: {
            value: String(profile.recordSizeKb),
            unit: "kb|NA",
          },
          dataFormatConversionSelect: {
            value: profile.enableFormatConversion ? "1" : "0",
          },
          dataFormatConversionSelect_2: {
            value: profile.enableFormatConversion ? "1" : "0",
          },
          dynamicPartitioningAddOn: {
            value: "0",
          },
          numberOfSubnets: {
            value: String(profile.subnetCount),
          },
          ratioDataRetry: {
            value: String(profile.vpcRetryRatio),
          },
        },
        serviceCode: FIREHOSE_SERVICE_CODE,
        region,
        estimateFor: FIREHOSE_ESTIMATE_FOR,
        version: FIREHOSE_VERSION,
        description: `Amazon Data Firehose ingestion baseline. Environment: shared. ${profile.recordsPerMonth.toLocaleString("en-US")} record units per month at ${profile.recordMultiplier}x units and ${profile.recordSizeKb} KB per record.${profile.enableFormatConversion ? " Data format conversion enabled." : ""}${profile.subnetCount > 0 ? ` VPC delivery across ${profile.subnetCount} subnets.` : ""}${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "Amazon Data Firehose",
        regionName: regionNameFor(region),
        configSummary: `Source Type (Direct PUT or Kinesis Data Stream), Data records units (${profile.recordMultiplier}), Number of records for data ingestion (${profile.recordsPerMonth.toLocaleString("en-US")} per month), Record size (${profile.recordSizeKb} KB), Data format conversion (${profile.enableFormatConversion ? "Enabled" : "Disabled"}), Number of subnets for VPC delivery (${profile.subnetCount}), Average ratio of data processed to VPC vs data ingested (${profile.vpcRetryRatio})`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 0.029,
    detail: (units) => `${Math.round(units)} GB of data ingestion`,
  }),
  modelSavedMonthlyUsd(service) {
    return firehoseMonthlyUsd({
      region: service?.region,
      recordsPerMonth: parseFrequencyValue(
        service?.calculationComponents?.numberOfRecordsIngested,
      ),
      recordMultiplier: parseNumericValue(service?.calculationComponents?.recordMultDI?.value, 1),
      recordSizeKb: parseFileSizeKb(service?.calculationComponents?.dataPerRecord),
      enableFormatConversion:
        parseNumericValue(
          service?.calculationComponents?.dataFormatConversionSelect?.value,
          0,
        ) === 1 ||
        parseNumericValue(
          service?.calculationComponents?.dataFormatConversionSelect_2?.value,
          0,
        ) === 1,
      subnetCount: parseNumericValue(service?.calculationComponents?.numberOfSubnets?.value, 0),
      vpcRetryRatio: parseNumericValue(service?.calculationComponents?.ratioDataRetry?.value, 1),
    });
  },
};
