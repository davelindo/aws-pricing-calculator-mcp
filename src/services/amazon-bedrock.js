import crypto from "node:crypto";

import { regionNameFor, roundCurrency } from "../model.js";
import { TARGET_REGIONS, buildCapabilityMatrix } from "./helpers.js";

const BEDROCK_SERVICE_CODE = "amazonBedrock";
const BEDROCK_ESTIMATE_FOR = "amazonBedrockClassesGroup";
const BEDROCK_VERSION = "0.0.52";
const AMAZON_SUBSERVICE_CODE = "amazon";
const AMAZON_SUBSERVICE_ESTIMATE_FOR = "Amazon";
const AMAZON_SUBSERVICE_VERSION = "0.0.34";
const NOVA_LITE_INPUT_RATE_ID = "jqpXyMWar6dZCgJ4nRTHic6D040daCa-N81Kh52Jlac";
const NOVA_LITE_OUTPUT_RATE_ID = "urNDBArH5pV5njuTwm41YJmDyeIrg_gD9kCMIHcQdLI";
const NOVA_LITE_ON_DEMAND_DISPLAY_ID = "24444";
const DAYS_PER_MONTH = 30;

// July 2026 Amazon Nova Lite Geo Cross Region Inference, On-Demand Standard
// rates in USD per 1,000 tokens. Only us-east-1 is exact-link eligible; the
// remaining target regions stay planning-only until native payload parity is
// independently verified there.
const NOVA_LITE_PRICING = {
  "us-east-1": {
    inputPerThousandTokens: 0.00006,
    outputPerThousandTokens: 0.00024,
  },
  "ca-central-1": {
    inputPerThousandTokens: 0.000064,
    outputPerThousandTokens: 0.000256,
  },
  "sa-east-1": {
    inputPerThousandTokens: 0.0000792,
    outputPerThousandTokens: 0.0003168,
  },
  "eu-west-1": {
    inputPerThousandTokens: 0.000069,
    outputPerThousandTokens: 0.000276,
  },
  "ap-southeast-2": {
    inputPerThousandTokens: 0.000063,
    outputPerThousandTokens: 0.000252,
  },
  "ap-northeast-2": {
    inputPerThousandTokens: 0.000071,
    outputPerThousandTokens: 0.000284,
  },
};

const DEFAULT_BUDGET_WORKLOAD = Object.freeze({
  provider: "amazon",
  model: "Amazon Nova Lite",
  inferenceRoute: "geo-cross-region",
  inferenceType: "on-demand-standard",
  imageInput: false,
  promptCaching: false,
  hoursPerDay: 8,
  averageInputTokensPerRequest: 1_000,
  averageOutputTokensPerRequest: 250,
});

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function pricingInputError(field, message) {
  const error = new Error(message);
  error.name = "BedrockPricingInputError";
  error.field = field;
  return error;
}

function positiveNumber(value, field) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw pricingInputError(
      field,
      `Amazon Bedrock pricing requires a positive '${field}'.`,
    );
  }

  return parsed;
}

function requiredValue(value, field) {
  if (!present(value)) {
    throw pricingInputError(field, `Amazon Bedrock pricing requires '${field}'.`);
  }

  return value;
}

function normalizedChoice(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_:/.-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function booleanValue(value, field) {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "yes") {
    return true;
  }

  if (value === false || value === 0 || value === "0" || value === "false" || value === "no") {
    return false;
  }

  throw pricingInputError(
    field,
    `Amazon Bedrock pricing requires boolean '${field}'.`,
  );
}

function pricingFor(region) {
  const pricing = NOVA_LITE_PRICING[region];

  if (!pricing) {
    throw pricingInputError(
      "region",
      `Amazon Nova Lite Geo Cross Region Inference pricing is unavailable in '${region}'.`,
    );
  }

  return pricing;
}

function validateConfiguration({
  provider,
  model,
  inferenceRoute,
  inferenceType,
  imageInput,
  promptCaching,
}) {
  const normalizedProvider = normalizedChoice(requiredValue(provider, "provider"));
  const normalizedModel = normalizedChoice(requiredValue(model, "model"));
  const normalizedRoute = normalizedChoice(
    requiredValue(inferenceRoute, "inferenceRoute"),
  );
  const normalizedType = normalizedChoice(
    requiredValue(inferenceType, "inferenceType"),
  );

  if (normalizedProvider !== "amazon") {
    throw pricingInputError(
      "provider",
      `Amazon Bedrock exact pricing currently supports provider 'amazon', not '${provider}'.`,
    );
  }

  if (!["amazon-nova-lite", "nova-lite"].includes(normalizedModel)) {
    throw pricingInputError(
      "model",
      `Amazon Bedrock exact pricing currently supports model 'Amazon Nova Lite', not '${model}'.`,
    );
  }

  if (!["geo-cross-region", "geo-cross-region-inference", "geo"].includes(normalizedRoute)) {
    throw pricingInputError(
      "inferenceRoute",
      "Amazon Bedrock exact pricing currently supports inferenceRoute 'geo-cross-region'.",
    );
  }

  if (!["on-demand-standard", "standard"].includes(normalizedType)) {
    throw pricingInputError(
      "inferenceType",
      "Amazon Bedrock exact pricing currently supports inferenceType 'on-demand-standard'.",
    );
  }

  const resolvedImageInput = booleanValue(imageInput, "imageInput");
  const resolvedPromptCaching = booleanValue(promptCaching, "promptCaching");

  if (resolvedImageInput) {
    throw pricingInputError(
      "imageInput",
      "Amazon Bedrock Nova Lite exact pricing does not yet support image input.",
    );
  }

  if (resolvedPromptCaching) {
    throw pricingInputError(
      "promptCaching",
      "Amazon Bedrock Nova Lite exact pricing does not yet support prompt caching.",
    );
  }

  return {
    provider: "amazon",
    model: "Amazon Nova Lite",
    inferenceRoute: "geo-cross-region",
    inferenceType: "on-demand-standard",
    imageInput: false,
    promptCaching: false,
  };
}

function workloadCost({
  region,
  averageRequestsPerMinute,
  hoursPerDay,
  averageInputTokensPerRequest,
  averageOutputTokensPerRequest,
}) {
  const pricing = pricingFor(region);
  const requestsPerMonth =
    averageRequestsPerMinute * 60 * hoursPerDay * DAYS_PER_MONTH;
  const inputTokensPerMonth = requestsPerMonth * averageInputTokensPerRequest;
  const outputTokensPerMonth = requestsPerMonth * averageOutputTokensPerRequest;
  const inputMonthlyUsd =
    (inputTokensPerMonth / 1_000) * pricing.inputPerThousandTokens;
  const outputMonthlyUsd =
    (outputTokensPerMonth / 1_000) * pricing.outputPerThousandTokens;

  return {
    requestsPerMonth,
    inputTokensPerMonth,
    outputTokensPerMonth,
    inputMonthlyUsd: roundCurrency(inputMonthlyUsd),
    outputMonthlyUsd: roundCurrency(outputMonthlyUsd),
    monthlyUsd: roundCurrency(inputMonthlyUsd + outputMonthlyUsd),
  };
}

function explicitWorkload(args) {
  const configuration = validateConfiguration(args);
  const averageRequestsPerMinute = positiveNumber(
    args.averageRequestsPerMinute,
    "averageRequestsPerMinute",
  );
  const hoursPerDay = positiveNumber(args.hoursPerDay, "hoursPerDay");
  const averageInputTokensPerRequest = positiveNumber(
    args.averageInputTokensPerRequest,
    "averageInputTokensPerRequest",
  );
  const averageOutputTokensPerRequest = positiveNumber(
    args.averageOutputTokensPerRequest,
    "averageOutputTokensPerRequest",
  );

  if (hoursPerDay > 24) {
    throw pricingInputError(
      "hoursPerDay",
      "Amazon Bedrock pricing requires 'hoursPerDay' to be at most 24.",
    );
  }

  return {
    ...configuration,
    averageRequestsPerMinute,
    hoursPerDay,
    averageInputTokensPerRequest,
    averageOutputTokensPerRequest,
  };
}

function budgetWorkload(region, monthlyBudgetUsd) {
  const budget = positiveNumber(monthlyBudgetUsd, "monthlyBudgetUsd");
  const oneRequestPerMinute = workloadCost({
    region,
    ...DEFAULT_BUDGET_WORKLOAD,
    averageRequestsPerMinute: 1,
  }).monthlyUsd;
  const averageRequestsPerMinute = Math.max(
    1,
    Math.round(budget / oneRequestPerMinute),
  );

  return {
    ...DEFAULT_BUDGET_WORKLOAD,
    averageRequestsPerMinute,
  };
}

function workloadFromArgs(args) {
  const explicitFields = [
    "provider",
    "model",
    "inferenceRoute",
    "inferenceType",
    "imageInput",
    "promptCaching",
    "averageRequestsPerMinute",
    "hoursPerDay",
    "averageInputTokensPerRequest",
    "averageOutputTokensPerRequest",
  ];
  const hasExplicitFields = explicitFields.some((field) => present(args[field]));

  if (!hasExplicitFields && present(args.monthlyBudgetUsd)) {
    return budgetWorkload(args.region, args.monthlyBudgetUsd);
  }

  return explicitWorkload(args);
}

function describeWorkload(workload, cost) {
  return (
    `${workload.averageRequestsPerMinute} requests/minute for ${workload.hoursPerDay} hours/day, ` +
    `${workload.averageInputTokensPerRequest} input and ` +
    `${workload.averageOutputTokensPerRequest} output tokens/request ` +
    `(${cost.requestsPerMonth.toLocaleString("en-US")} requests/month)`
  );
}

function buildBedrockEntry(args) {
  const { region, notes } = args;
  const workload = workloadFromArgs(args);
  const cost = workloadCost({ region, ...workload });
  const workloadDescription = describeWorkload(workload, cost);

  return {
    key: `${BEDROCK_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
    breakdown: {
      serviceId: "amazon-bedrock",
      kind: BEDROCK_SERVICE_CODE,
      label: "Amazon Bedrock",
      category: "machine-learning",
      supportive: false,
      region,
      environment: "shared",
      monthlyUsd: cost.monthlyUsd,
      implementationStatus: "implemented",
      details: `Amazon Nova Lite Geo Cross Region On-Demand Standard: ${workloadDescription}`,
    },
    service: {
      version: BEDROCK_VERSION,
      serviceCode: BEDROCK_SERVICE_CODE,
      estimateFor: BEDROCK_ESTIMATE_FOR,
      region,
      description:
        `Amazon Bedrock Amazon Nova Lite inference. ${workloadDescription}.` +
        (notes ? ` ${notes}` : ""),
      subServices: [
        {
          calculationComponents: {
            location: { value: "geo" },
            tierIR: { value: "standard" },
            modelSelectiongeoStan: { value: NOVA_LITE_INPUT_RATE_ID },
            selectedModelgeoStan: { value: NOVA_LITE_OUTPUT_RATE_ID },
            avgRequestsPerMingeoStan: {
              value: String(workload.averageRequestsPerMinute),
            },
            hoursPerDayAtThisRategeoStan: {
              value: String(workload.hoursPerDay),
            },
            avgInputTokensPerRequestgeoStan: {
              value: String(workload.averageInputTokensPerRequest),
            },
            avgOutputTokensPerRequestgeoStan: {
              value: String(workload.averageOutputTokensPerRequest),
            },
            imageInputgeoStan: { value: "0" },
            withPromptCachinggeoStan: { value: "0" },
            selectedModel_odgeoStan: { value: NOVA_LITE_ON_DEMAND_DISPLAY_ID },
          },
          serviceCode: AMAZON_SUBSERVICE_CODE,
          region,
          estimateFor: AMAZON_SUBSERVICE_ESTIMATE_FOR,
          version: AMAZON_SUBSERVICE_VERSION,
          description: null,
          serviceCost: {
            monthly: cost.monthlyUsd,
          },
        },
      ],
      serviceCost: {
        monthly: cost.monthlyUsd,
      },
      serviceName: "Amazon Bedrock",
      regionName: regionNameFor(region),
      configSummary:
        "Select your inference route (Geo Cross Region Inference), " +
        "Select your inference type (On Demand - Standard), " +
        `Average requests per minute (${workload.averageRequestsPerMinute}), ` +
        `Hours per day at this rate (${workload.hoursPerDay}), ` +
        `Average input tokens per request (${workload.averageInputTokensPerRequest}), ` +
        `Average output tokens per request (${workload.averageOutputTokensPerRequest})`,
    },
  };
}

function savedComponentValue(components, id) {
  return components?.[id]?.value;
}

function validateSavedShape(service, subService) {
  const components = subService?.calculationComponents;

  if (
    service?.estimateFor !== BEDROCK_ESTIMATE_FOR ||
    subService?.serviceCode !== AMAZON_SUBSERVICE_CODE ||
    subService?.estimateFor !== AMAZON_SUBSERVICE_ESTIMATE_FOR ||
    savedComponentValue(components, "location") !== "geo" ||
    savedComponentValue(components, "tierIR") !== "standard" ||
    savedComponentValue(components, "modelSelectiongeoStan") !== NOVA_LITE_INPUT_RATE_ID ||
    savedComponentValue(components, "selectedModelgeoStan") !== NOVA_LITE_OUTPUT_RATE_ID ||
    savedComponentValue(components, "selectedModel_odgeoStan") !==
      NOVA_LITE_ON_DEMAND_DISPLAY_ID ||
    String(savedComponentValue(components, "imageInputgeoStan")) !== "0" ||
    String(savedComponentValue(components, "withPromptCachinggeoStan")) !== "0"
  ) {
    throw new Error(
      "Saved Amazon Bedrock service is not the supported Amazon Nova Lite Geo Cross Region On-Demand Standard shape.",
    );
  }
}

function modelSavedBedrockMonthlyUsd(service) {
  const subServices = service?.subServices ?? [];
  const amazonSubServices = subServices.filter(
    (subService) => subService?.serviceCode === AMAZON_SUBSERVICE_CODE,
  );

  if (subServices.length !== 1 || amazonSubServices.length !== 1) {
    throw new Error(
      "Saved Amazon Bedrock pricing requires exactly one supported Amazon model subservice.",
    );
  }

  const subService = amazonSubServices[0];
  const components = subService.calculationComponents;
  validateSavedShape(service, subService);

  return workloadCost({
    region: subService.region ?? service.region,
    averageRequestsPerMinute: positiveNumber(
      savedComponentValue(components, "avgRequestsPerMingeoStan"),
      "avgRequestsPerMingeoStan",
    ),
    hoursPerDay: positiveNumber(
      savedComponentValue(components, "hoursPerDayAtThisRategeoStan"),
      "hoursPerDayAtThisRategeoStan",
    ),
    averageInputTokensPerRequest: positiveNumber(
      savedComponentValue(components, "avgInputTokensPerRequestgeoStan"),
      "avgInputTokensPerRequestgeoStan",
    ),
    averageOutputTokensPerRequest: positiveNumber(
      savedComponentValue(components, "avgOutputTokensPerRequestgeoStan"),
      "avgOutputTokensPerRequestgeoStan",
    ),
  }).monthlyUsd;
}

export const amazonBedrockService = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  category: "machine-learning",
  implementationStatus: "implemented",
  keywords: [
    "bedrock",
    "amazon bedrock",
    "foundation model inference",
    "generative ai inference",
    "nova lite",
  ],
  pricingStrategies: ["geo-cross-region", "on-demand-standard", "token-based"],
  calculatorServiceCodes: [BEDROCK_SERVICE_CODE],
  capabilityMatrix: buildCapabilityMatrix({
    exact: ["us-east-1"],
    modeled: TARGET_REGIONS.filter((region) => region !== "us-east-1"),
    exactReason:
      "Amazon Nova Lite Geo Cross Region On-Demand Standard payload parity is verified in this region.",
    modeledReason:
      "Amazon Nova Lite token pricing is modeled in this region; native calculator payload parity is not yet verified.",
  }),
  universalPricingMode: "usage",
  buildEntry: buildBedrockEntry,
  buildUniversalEntry({ region, component, notes }) {
    const configuration = component?.configuration ?? {};
    const usage = component?.usage ?? {};
    const args = {
      region,
      provider: configuration.provider,
      model: configuration.model,
      inferenceRoute: configuration.inferenceRoute,
      inferenceType: configuration.inferenceType,
      imageInput: configuration.imageInput,
      promptCaching: configuration.promptCaching,
      averageRequestsPerMinute: usage.averageRequestsPerMinute,
      hoursPerDay: usage.hoursPerDay,
      averageInputTokensPerRequest: usage.averageInputTokensPerRequest,
      averageOutputTokensPerRequest: usage.averageOutputTokensPerRequest,
      notes,
    };

    return {
      args,
      entry: buildBedrockEntry(args),
    };
  },
  priceBudget({ definition, region, monthlyBudgetUsd, capability }) {
    const workload = budgetWorkload(region, monthlyBudgetUsd);
    const cost = workloadCost({ region, ...workload });

    return {
      serviceId: definition.id,
      kind: definition.id,
      label: definition.name,
      category: definition.category,
      supportive: false,
      region,
      environment: "shared",
      monthlyUsd: cost.monthlyUsd,
      implementationStatus: definition.implementationStatus,
      capability,
      details: `Amazon Nova Lite inference at ${workload.averageRequestsPerMinute} requests/minute`,
    };
  },
  modelSavedMonthlyUsd: modelSavedBedrockMonthlyUsd,
};
