import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const DYNAMODB_PRICING = {
  "us-east-1": {
    storagePerGbMonth: 0.25,
    writeRequestUnit: 0.000000625,
    readRequestUnit: 0.000000125,
  },
};
const DYNAMODB_TABLE_CLASS = "standard";
const DYNAMODB_ITEM_SIZE_KB = 1;
const DYNAMODB_DEFAULT_STORAGE_GB = 10;

function dynamodbPricingFor(region) {
  return scaledRegionalPricing(DYNAMODB_PRICING, region, "DynamoDB exact pricing");
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
    case "perSecond":
      return numericValue * 730 * 60 * 60;
    case "perMinute":
      return numericValue * 730 * 60;
    case "perHour":
      return numericValue * 730;
    case "perDay":
      return numericValue * 30.4167;
    case "perMonth":
    default:
      return numericValue;
  }
}

function parseSizeKb(component, defaultValueKb) {
  if (!component || typeof component !== "object") {
    return defaultValueKb;
  }

  const numericValue = parseNumericValue(component.value, defaultValueKb);
  const [sizeUnit] = String(component.unit ?? "kb|NA").split("|");

  switch (sizeUnit) {
    case "gb":
      return numericValue * 1024 * 1024;
    case "mb":
      return numericValue * 1024;
    case "bytes":
      return numericValue / 1024;
    case "kb":
    default:
      return numericValue;
  }
}

function parseSizeGb(component, defaultValueGb) {
  if (!component || typeof component !== "object") {
    return defaultValueGb;
  }

  const numericValue = parseNumericValue(component.value, defaultValueGb);
  const [sizeUnit] = String(component.unit ?? "gb|NA").split("|");

  switch (sizeUnit) {
    case "tb":
      return numericValue * 1024;
    case "mb":
      return numericValue / 1024;
    case "kb":
      return numericValue / (1024 * 1024);
    case "gb":
    default:
      return numericValue;
  }
}

function dynamodbMonthlyCost({
  region,
  storageGb,
  itemSizeKb,
  writeCount,
  readCount,
  standardWritePct = 100,
  transactionalWritePct = 0,
  eventualReadPct = 100,
  strongReadPct = 0,
  transactionalReadPct = 0,
}) {
  const pricing = dynamodbPricingFor(region);
  const writeUnitsPerOperation = Math.max(Math.ceil(itemSizeKb / 1), 1);
  const readUnitsPerOperation = Math.max(Math.ceil(itemSizeKb / 4), 1);
  const writeRequestUnits =
    writeCount *
    ((standardWritePct / 100) * writeUnitsPerOperation +
      (transactionalWritePct / 100) * writeUnitsPerOperation * 2);
  const readRequestUnits =
    readCount *
    ((eventualReadPct / 100) * readUnitsPerOperation * 0.5 +
      (strongReadPct / 100) * readUnitsPerOperation +
      (transactionalReadPct / 100) * readUnitsPerOperation * 2);

  return roundCurrency(
    storageGb * pricing.storagePerGbMonth +
      writeRequestUnits * pricing.writeRequestUnit +
      readRequestUnits * pricing.readRequestUnit,
  );
}

function dynamodbShapeForBudget(region, monthlyBudgetUsd) {
  const storageGb = Math.max(
    roundCurrency(Math.min(Number(monthlyBudgetUsd || 0) * 0.2, 50)),
    1,
  );
  const storageCost = storageGb * dynamodbPricingFor(region).storagePerGbMonth;
  const remainingBudget = Math.max(Number(monthlyBudgetUsd) - storageCost, 0);
  const effectiveCostPerWrite = 0.000000625 + 2 * 0.000000125;
  const writeCount = Math.max(Math.floor(remainingBudget / effectiveCostPerWrite), 0);
  const readCount = writeCount * 2;

  return {
    storageGb,
    writeCount,
    readCount,
  };
}

export const amazonDynamodbService = {
  id: "amazon-dynamodb",
  name: "Amazon DynamoDB",
  category: "database",
  implementationStatus: "implemented",
  keywords: ["dynamodb", "nosql"],
  pricingStrategies: ["on-demand", "provisioned"],
  calculatorServiceCodes: ["dynamoDbOnDemand"],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const { storageGb, writeCount, readCount } = dynamodbShapeForBudget(region, monthlyBudgetUsd);
    const monthlyUsd = dynamodbMonthlyCost({
      region,
      storageGb,
      itemSizeKb: DYNAMODB_ITEM_SIZE_KB,
      writeCount,
      readCount,
    });

    return {
      key: `dynamoDbOnDemand-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "amazon-dynamodb",
        kind: "dynamoDbOnDemand",
        label: "Amazon DynamoDB",
        category: "database",
        supportive: false,
        region,
        environment: "shared",
        monthlyUsd,
        implementationStatus: "implemented",
        details: `${storageGb} GB storage, ${writeCount.toLocaleString("en-US")} writes, ${readCount.toLocaleString("en-US")} reads per month`,
      },
      service: {
        calculationComponents: {
          selectTableClass: {
            value: DYNAMODB_TABLE_CLASS,
          },
          dataStorageSize: {
            value: String(storageGb),
            unit: "gb|NA",
          },
          averageItemSizeForAllAttributes: {
            value: String(DYNAMODB_ITEM_SIZE_KB),
            unit: "kb|NA",
          },
          standardWritesId: {
            value: "100",
          },
          transactionalWritesId: {
            value: "0",
          },
          writeRateId: {
            value: String(writeCount),
            unit: "perMonth",
          },
          eventuallyConsistentId: {
            value: "100",
          },
          stronglyConsistentId: {
            value: "0",
          },
          transactionalId: {
            value: "0",
          },
          readRateId: {
            value: String(readCount),
            unit: "perMonth",
          },
        },
        serviceCode: "dynamoDbOnDemand",
        region,
        estimateFor: "dynamoDBOnDemand",
        version: "0.0.132",
        description: `Amazon DynamoDB on-demand baseline. Environment: shared. ${storageGb} GB storage, ${writeCount.toLocaleString("en-US")} writes, ${readCount.toLocaleString("en-US")} reads per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: monthlyUsd,
          upfront: 0,
        },
        serviceName: "DynamoDB on-demand capacity",
        regionName: regionNameFor(region),
        configSummary: `Table class (Standard), Data storage size (${storageGb} GB), Average item size (all attributes) (${DYNAMODB_ITEM_SIZE_KB} KB), Standard writes (100%), Transactional writes (0%), Number of writes (${writeCount.toLocaleString("en-US")} per month), Eventually consistent percentage (100%), Strongly consistent percentage (0%), Transactional percentage (0%), Number of reads (${readCount.toLocaleString("en-US")} per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 1.5,
    detail: (units) => `${Math.round(units)} read/write million-unit equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    const storageGb = parseSizeGb(
      service?.calculationComponents?.dataStorageSize,
      DYNAMODB_DEFAULT_STORAGE_GB,
    );
    const itemSizeKb = parseSizeKb(
      service?.calculationComponents?.averageItemSizeForAllAttributes,
      DYNAMODB_ITEM_SIZE_KB,
    );
    const writeCount = parseFrequencyValue(
      service?.calculationComponents?.writeRateId ?? service?.calculationComponents?.numberOfWrites,
    );
    const readCount = parseFrequencyValue(
      service?.calculationComponents?.readRateId ?? service?.calculationComponents?.numberOfReads,
    );
    const standardWritePct = parseNumericValue(
      service?.calculationComponents?.standardWritesId?.value,
      100,
    );
    const transactionalWritePct = parseNumericValue(
      service?.calculationComponents?.transactionalWritesId?.value,
      0,
    );
    const eventualReadPct = parseNumericValue(
      service?.calculationComponents?.eventuallyConsistentId?.value,
      100,
    );
    const strongReadPct = parseNumericValue(
      service?.calculationComponents?.stronglyConsistentId?.value,
      0,
    );
    const transactionalReadPct = parseNumericValue(
      service?.calculationComponents?.transactionalId?.value,
      0,
    );

    return dynamodbMonthlyCost({
      region: service?.region,
      storageGb,
      itemSizeKb,
      writeCount,
      readCount,
      standardWritePct,
      transactionalWritePct,
      eventualReadPct,
      strongReadPct,
      transactionalReadPct,
    });
  },
};
