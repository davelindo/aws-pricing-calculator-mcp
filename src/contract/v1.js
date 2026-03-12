import * as z from "zod/v4";

import {
  listServiceCatalog,
  patternIdsForBlueprint,
  supportedBlueprintIds,
  supportedTemplateIds,
} from "../catalog.js";

export const V1_CONTRACT_VERSION = "v1";
export const TOOL_NAMES = [
  "list_blueprints",
  "list_service_catalog",
  "design_architecture",
  "price_architecture",
  "generate_calculator_link",
  "create_calculator_link",
  "validate_calculator_link",
];
export const SUPPORT_VALUES = ["exact", "modeled", "unavailable"];
export const IMPLEMENTATION_STATUS_VALUES = ["implemented", "modeled", "planned"];
export const BUDGET_FIT_STATUS_VALUES = [
  "fits",
  "underspecified",
  "nearest_fit_above",
  "nearest_fit_below",
  "incompatible_budget",
];
export const SOURCE_TYPE_VALUES = ["brief", "hybrid", "blueprint"];
export const OPERATING_SYSTEM_VALUES = ["linux", "windows"];
export const REGION_MODE_VALUES = ["single-region", "multi-region"];
export const SERVICE_SELECTION_MODE_VALUES = ["strict", "augment"];
export const VALIDATION_MODE_VALUES = ["generic", "intent-aware"];
export const VALIDATION_CONTEXT_SOURCE_VALUES = ["explicit", "link-plan", "inferred", "none"];
export const VALIDATION_STATUS_VALUES = ["pass", "warning", "fail"];
export const VALIDATION_SEVERITY_VALUES = ["info", "warning", "error"];
export const VALIDATION_PACK_IDS = [
  "pricing-integrity",
  "architecture-completeness",
  "funding-readiness",
  "platform-governance",
];
export const PRICING_CONFIDENCE_VALUES = ["exact-or-modeled", "review-required"];
export const SELECTED_SERVICE_SOURCE_VALUES = [
  "blueprint-required",
  "blueprint-default",
  "explicit",
  "brief-inferred",
];
export const INFERENCE_SOURCE_VALUES = [
  "explicit",
  "brief-inferred",
  "blueprint-default",
  "default",
  "missing",
];
export const COMPUTE_COMMITMENT_VALUES = [
  "on-demand",
  "savings-plans",
  "reserved",
  "reserved-heavy",
];
export const DATABASE_COMMITMENT_VALUES = ["on-demand", "reserved", "reserved-heavy"];
export const HA_POSTURE_VALUES = ["standard", "targeted-ha", "selective-ha"];
export const STORAGE_STRATEGY_VALUES = ["standard", "tuned", "lean"];
export const ENVIRONMENT_SIZING_VALUES = [
  "full-footprint",
  "right-sized-non-prod",
  "lean-non-prod",
];
export const SHARED_SERVICES_PROFILE_VALUES = ["standard", "trimmed", "lean"];
export const DATA_TRANSFER_PROFILE_VALUES = ["baseline", "reviewed", "minimized"];
export const JUSTIFICATION_PROFILE_VALUES = [
  "default-baseline",
  "cost-optimized",
  "high-optimization",
];
export const TOOL_ERROR_CODE_VALUES = [
  "invalid_input",
  "not_found",
  "not_calculator_eligible",
  "unsupported_region",
  "unsupported_service_combination",
  "validation_failed",
  "upstream_aws_error",
  "internal_error",
];
export const VALIDATION_RULE_ID_VALUES = [
  "pricing.services-present",
  "pricing.known-service-formulas",
  "pricing.saved-modeled-parity",
  "pricing.total-parity",
  "pricing.group-subtotal-parity",
  "pricing.scenario-target-positive",
  "pricing.scenario-services-present",
  "pricing.region-service-coverage",
  "pricing.core-preview-valid",
  "architecture.single-region",
  "architecture.expected-region",
  "architecture.required-service-codes",
  "architecture.required-service-families",
  "architecture.environment-coverage",
  "architecture.compute-os",
  "architecture.required-blueprint-services",
  "architecture.required-capabilities",
  "architecture.forbidden-service-mix",
  "architecture.pattern-fit-gaps",
  "architecture.required-unpriced-capabilities",
  "architecture.environment-model",
  "architecture.calculator-backed-services",
  "funding.supportive-spend-threshold",
  "funding.primary-spend-dominant",
  "funding.primary-architecture-dominance",
  "funding.target-band-fit",
  "funding.architecture-budget-fit",
  "funding.modeled-service-gaps",
  "funding.calculator-link-ready",
  "governance.non-default-region-justification",
  "governance.edge-security-controls",
  "governance.operational-visibility",
  "governance.premium-managed-service-justification",
];

function enumFromValues(values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Cannot build enum '${name}' from an empty value set.`);
  }

  return z.enum(values);
}

const blueprintIdValues = supportedBlueprintIds();
const patternIdValues = [
  ...new Set(
    blueprintIdValues.flatMap((blueprintId) => [
      ...patternIdsForBlueprint(blueprintId),
      `${blueprintId}.default`,
    ]),
  ),
];
const templateIdValues = supportedTemplateIds();
const serviceCatalogEntries = listServiceCatalog();
const serviceIdValues = serviceCatalogEntries.map((service) => service.id);
const categoryValues = [...new Set(serviceCatalogEntries.map((service) => service.category))];
const serviceBreakdownCategoryValues = [...new Set([...categoryValues, "supportive"])];

export const blueprintIdEnum = enumFromValues(blueprintIdValues, "blueprintId");
export const patternIdEnum = enumFromValues(patternIdValues, "patternId");
export const templateIdEnum = enumFromValues(templateIdValues, "templateId");
export const serviceIdEnum = enumFromValues(serviceIdValues, "serviceId");
export const serviceCategoryEnum = enumFromValues(categoryValues, "serviceCategory");
export const serviceBreakdownCategoryEnum = enumFromValues(
  serviceBreakdownCategoryValues,
  "serviceBreakdownCategory",
);
export const supportEnum = enumFromValues(SUPPORT_VALUES, "support");
export const implementationStatusEnum = enumFromValues(
  IMPLEMENTATION_STATUS_VALUES,
  "implementationStatus",
);
export const budgetFitStatusEnum = enumFromValues(
  BUDGET_FIT_STATUS_VALUES,
  "budgetFitStatus",
);
export const sourceTypeEnum = enumFromValues(SOURCE_TYPE_VALUES, "sourceType");
export const operatingSystemEnum = enumFromValues(
  OPERATING_SYSTEM_VALUES,
  "operatingSystem",
);
export const regionModeEnum = enumFromValues(REGION_MODE_VALUES, "regionMode");
export const serviceSelectionModeEnum = enumFromValues(
  SERVICE_SELECTION_MODE_VALUES,
  "serviceSelectionMode",
);
export const validationModeEnum = enumFromValues(
  VALIDATION_MODE_VALUES,
  "validationMode",
);
export const validationContextSourceEnum = enumFromValues(
  VALIDATION_CONTEXT_SOURCE_VALUES,
  "validationContextSource",
);
export const validationStatusEnum = enumFromValues(
  VALIDATION_STATUS_VALUES,
  "validationStatus",
);
export const validationSeverityEnum = enumFromValues(
  VALIDATION_SEVERITY_VALUES,
  "validationSeverity",
);
export const validationPackIdEnum = enumFromValues(VALIDATION_PACK_IDS, "validationPackId");
export const pricingConfidenceEnum = enumFromValues(
  PRICING_CONFIDENCE_VALUES,
  "pricingConfidence",
);
export const selectedServiceSourceEnum = enumFromValues(
  SELECTED_SERVICE_SOURCE_VALUES,
  "selectedServiceSource",
);
export const inferenceSourceEnum = enumFromValues(
  INFERENCE_SOURCE_VALUES,
  "inferenceSource",
);
export const computeCommitmentEnum = enumFromValues(
  COMPUTE_COMMITMENT_VALUES,
  "computeCommitment",
);
export const databaseCommitmentEnum = enumFromValues(
  DATABASE_COMMITMENT_VALUES,
  "databaseCommitment",
);
export const haPostureEnum = enumFromValues(HA_POSTURE_VALUES, "haPosture");
export const storageStrategyEnum = enumFromValues(
  STORAGE_STRATEGY_VALUES,
  "storageStrategy",
);
export const environmentSizingEnum = enumFromValues(
  ENVIRONMENT_SIZING_VALUES,
  "environmentSizing",
);
export const sharedServicesProfileEnum = enumFromValues(
  SHARED_SERVICES_PROFILE_VALUES,
  "sharedServicesProfile",
);
export const dataTransferProfileEnum = enumFromValues(
  DATA_TRANSFER_PROFILE_VALUES,
  "dataTransferProfile",
);
export const justificationProfileEnum = enumFromValues(
  JUSTIFICATION_PROFILE_VALUES,
  "justificationProfile",
);
export const toolErrorCodeEnum = enumFromValues(TOOL_ERROR_CODE_VALUES, "toolErrorCode");
export const validationRuleIdEnum = enumFromValues(
  VALIDATION_RULE_ID_VALUES,
  "validationRuleId",
);

const environmentSplitSchema = z.object({
  dev: z.number().nonnegative().optional(),
  staging: z.number().nonnegative().optional(),
  prod: z.number().nonnegative().optional(),
});
const normalizedEnvironmentSplitSchema = z.object({
  dev: z.number(),
  staging: z.number(),
  prod: z.number(),
});
const budgetGuidanceSchema = z
  .object({
    minimumMonthlyUsd: z.number().optional(),
    preferredMinMonthlyUsd: z.number().optional(),
    preferredMaxMonthlyUsd: z.number().optional(),
  })
  .nullable();
const capabilityEntrySchema = z.object({
  region: z.string(),
  support: supportEnum,
  calculatorSaveSupported: z.boolean(),
  validationSupported: z.boolean(),
  reason: z.string(),
});
const serviceCatalogEntrySchema = z.object({
  id: serviceIdEnum,
  name: z.string(),
  category: serviceCategoryEnum,
  implementationStatus: implementationStatusEnum,
  keywords: z.array(z.string()),
  pricingStrategies: z.array(z.string()),
  calculatorServiceCodes: z.array(z.string()),
  capabilityMatrix: z.array(capabilityEntrySchema),
  supportedRegions: z.array(z.string()),
});
const blueprintSchema = z.object({
  id: blueprintIdEnum,
  title: z.string(),
  description: z.string(),
  architectureFamily: z.string(),
  architectureSubtype: z.string(),
  environmentModel: z.string(),
  defaultOperatingSystem: operatingSystemEnum,
  requiredCapabilities: z.array(z.string()),
  budgetGuidance: budgetGuidanceSchema,
  packIds: z.array(z.string()),
  packs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
  requiredServiceFamilies: z.array(z.string()),
  requiredServiceIds: z.array(serviceIdEnum),
  defaultAddOnServiceIds: z.array(serviceIdEnum),
  optionalServiceIds: z.array(serviceIdEnum),
  supportedRegions: z.array(z.string()),
});
const structuredItemSchema = z.object({
  id: z.string(),
  field: z.string(),
  message: z.string(),
  remediation: z.string(),
  blocking: z.boolean(),
});
const budgetFitSchema = z.object({
  status: budgetFitStatusEnum,
  details: z.string(),
  deltaUsd: z.number().optional(),
  guidance: budgetGuidanceSchema.optional(),
});
const architectureCandidateSchema = z.object({
  blueprintId: blueprintIdEnum,
  blueprintTitle: z.string(),
  architectureFamily: z.string(),
  architectureSubtype: z.string(),
  summary: z.string(),
  requiredCapabilities: z.array(z.string()),
  requiredServiceIds: z.array(serviceIdEnum),
  optionalServiceIds: z.array(serviceIdEnum),
  packIds: z.array(z.string()),
  fitScore: z.number(),
  matchedSignals: z.array(z.string()),
  budgetFit: budgetFitSchema,
  rationale: z.array(z.string()),
  explicit: z.boolean().optional(),
});
const unpricedCapabilitySchema = z.object({
  id: z.string(),
  title: z.string(),
  details: z.string(),
});
const patternCandidateSchema = z.object({
  id: patternIdEnum,
  title: z.string(),
  description: z.string(),
  fitScore: z.number(),
  budgetFit: budgetFitSchema,
  requiredServiceIds: z.array(serviceIdEnum),
  primaryServiceIds: z.array(serviceIdEnum),
  forbiddenServiceIds: z.array(serviceIdEnum),
  requiredUnpricedCapabilities: z.array(unpricedCapabilitySchema),
  traits: z.array(z.string()),
  rationale: z.array(z.string()),
});
const hardConstraintSchema = z.object({
  requestedDatabase: z.string().nullable(),
  requiresServerless: z.boolean(),
  requiresPrivateConnectivity: z.boolean(),
  requiresFargatePrimary: z.boolean(),
  requiresGovernance: z.boolean(),
  requiresStreamProcessing: z.boolean(),
  requestedAlbOrigins: z.boolean(),
  requestedEventBridge: z.boolean(),
  requestedQueueing: z.boolean(),
  requestedFiles: z.boolean(),
  requestedSearch: z.boolean(),
  requestedCdn: z.boolean(),
});
const scenarioPolicySchema = z.object({
  id: z.string(),
  title: z.string(),
  computeCommitment: computeCommitmentEnum,
  computeDiscountPct: z.number(),
  databaseCommitment: databaseCommitmentEnum,
  databaseDiscountPct: z.number(),
  haPosture: haPostureEnum,
  prodMultiAz: z.boolean(),
  nonProdMultiAz: z.boolean(),
  storageStrategy: storageStrategyEnum,
  storageMultiplier: z.number(),
  environmentSizing: environmentSizingEnum,
  environmentScaleFactors: normalizedEnvironmentSplitSchema,
  sharedServicesProfile: sharedServicesProfileEnum,
  sharedServicesMultiplier: z.number(),
  dataTransferProfile: dataTransferProfileEnum,
  dataTransferMultiplier: z.number(),
  justificationProfile: justificationProfileEnum,
  expectedSavingsPct: z.number(),
  coreBudgetFactor: z.number(),
  addOnBudgetFactor: z.number(),
  strategySummary: z.string(),
});
const selectedServiceSchema = z.object({
  serviceId: serviceIdEnum,
  serviceName: z.string(),
  category: serviceCategoryEnum,
  implementationStatus: implementationStatusEnum,
  required: z.boolean(),
  role: z.string(),
  rationale: z.string(),
  source: selectedServiceSourceEnum,
  capability: capabilityEntrySchema,
});
const serviceCoverageSchema = z.object({
  exact: z.array(serviceIdEnum),
  modeled: z.array(serviceIdEnum),
  unavailable: z.array(serviceIdEnum),
});
const validationEvidenceSchema = z
  .union([
    z.object({
      kind: z.literal("string_set"),
      label: z.string(),
      values: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("required_present_missing"),
      label: z.string(),
      required: z.array(z.string()),
      present: z.array(z.string()),
      missing: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("numeric_comparison"),
      metric: z.string(),
      actual: z.number(),
      expected: z.number().nullable(),
      comparator: z.enum(["eq", "lte", "gte", "band"]),
      tolerance: z.number().nullable(),
      unit: z.enum(["usd", "ratio", "count"]),
    }),
    z.object({
      kind: z.literal("expected_found"),
      label: z.string(),
      expected: z.string(),
      found: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("parity_summary"),
      storedMonthlyUsd: z.number(),
      modeledMonthlyUsd: z.number(),
      groupMonthlyUsd: z.number().nullable(),
      mismatchedServiceCodes: z.array(z.string()),
      unsupportedServiceCodes: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("state_summary"),
      label: z.string(),
      state: z.string(),
      values: z.array(z.string()),
    }),
  ])
  .nullable()
  .optional();
const validationCheckSchema = z.object({
  pack: validationPackIdEnum,
  id: validationRuleIdEnum,
  title: z.string(),
  status: validationStatusEnum,
  severity: validationSeverityEnum,
  blocking: z.boolean(),
  reason: z.string(),
  remediation: z.string(),
  details: z.string(),
  evidence: validationEvidenceSchema,
});
const validationPackSchema = z.object({
  id: validationPackIdEnum,
  title: z.string(),
  passed: z.boolean(),
  blocking: z.boolean(),
  failedRuleCount: z.number(),
  warningRuleCount: z.number(),
  checks: z.array(validationCheckSchema),
});
const validationRuleSummarySchema = z.object({
  id: validationRuleIdEnum,
  title: z.string(),
  details: z.string(),
  remediation: z.string(),
});
const parityDetailSchema = z.object({
  serviceId: serviceIdEnum.nullable(),
  serviceCode: z.string(),
  region: z.string(),
  storedMonthlyUsd: z.number(),
  modeledMonthlyUsd: z.number(),
  deltaUsd: z.number(),
  supported: z.boolean(),
  error: z.string().nullable(),
});
const validationSummarySchema = z.object({
  schemaVersion: z.string(),
  validationMode: validationModeEnum.optional(),
  contextSource: validationContextSourceEnum.optional(),
  blueprintId: blueprintIdEnum.optional(),
  blueprintTitle: z.string().optional(),
  templateId: templateIdEnum.optional(),
  templateTitle: z.string().optional(),
  bestMatchBlueprintId: blueprintIdEnum.nullable().optional(),
  bestMatchBlueprintTitle: z.string().nullable().optional(),
  patternId: patternIdEnum.optional(),
  expectedMonthlyUsd: z.number().nullable().optional(),
  storedMonthlyUsd: z.number().optional(),
  modeledMonthlyUsd: z.number().optional(),
  expectedRegion: z.string().nullable().optional(),
  expectedRegionMode: regionModeEnum.nullable().optional(),
  regions: z.array(z.string()).optional(),
  serviceCodes: z.array(z.string()).optional(),
  checks: z.array(validationCheckSchema),
  packs: z.array(validationPackSchema),
  blockingFailures: z.array(validationRuleSummarySchema),
  warningRules: z.array(validationRuleSummarySchema),
  hardFailures: z.array(z.string()),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  parityDetails: z.array(parityDetailSchema),
  passed: z.boolean(),
});
const architectureInferenceSchema = z.object({
  blueprint: z.object({
    value: blueprintIdEnum,
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
  region: z.object({
    value: z.string(),
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
  targetMonthlyUsd: z.object({
    value: z.number().nullable(),
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
  operatingSystem: z.object({
    value: operatingSystemEnum,
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
  environmentSplit: z.object({
    value: normalizedEnvironmentSplitSchema,
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
  databaseEngine: z.object({
    value: z.string(),
    source: inferenceSourceEnum,
    confidence: z.number(),
  }),
});
const architectureRefSchema = z.object({
  contractVersion: z.literal(V1_CONTRACT_VERSION),
  kind: z.literal("architecture_ref"),
  architectureId: z.string(),
  blueprintId: blueprintIdEnum,
  patternId: patternIdEnum,
  token: z.string(),
});
const architectureSchema = z.object({
  architectureRef: architectureRefSchema.nullable().optional(),
  version: z.string(),
  architectureId: z.string(),
  readyToPrice: z.boolean(),
  sourceType: sourceTypeEnum,
  briefSummary: z.string().nullable(),
  blueprintId: blueprintIdEnum,
  blueprintTitle: z.string(),
  templateId: templateIdEnum,
  environmentModel: z.string(),
  architectureFamily: z.string(),
  architectureSubtype: z.string(),
  patternId: patternIdEnum,
  patternTitle: z.string(),
  patternDescription: z.string(),
  recommendedPatternId: patternIdEnum,
  recommendedArchitectureId: blueprintIdEnum,
  alternativeArchitectureIds: z.array(blueprintIdEnum),
  candidateArchitectures: z.array(architectureCandidateSchema),
  patternCandidates: z.array(patternCandidateSchema),
  alternativePatternIds: z.array(patternIdEnum),
  requiredCapabilities: z.array(z.string()),
  budgetFit: budgetFitSchema,
  packIds: z.array(z.string()),
  packs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
  requiredServiceFamilies: z.array(z.string()),
  clientName: z.string().nullable(),
  estimateName: z.string(),
  notes: z.string().nullable(),
  region: z.string(),
  regionMode: regionModeEnum,
  operatingSystem: operatingSystemEnum,
  targetMonthlyUsd: z.number().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  includeDefaultAddOns: z.boolean(),
  serviceSelectionMode: serviceSelectionModeEnum,
  selectedServices: z.array(selectedServiceSchema),
  serviceCoverage: serviceCoverageSchema,
  hardConstraints: hardConstraintSchema,
  fitGaps: z.array(z.string()),
  excludedDefaults: z.array(z.string()),
  requiredUnpricedCapabilities: z.array(unpricedCapabilitySchema),
  minimumPrimaryDominanceRatio: z.number(),
  defaultScenarioPolicies: z.array(scenarioPolicySchema),
  blockers: z.array(z.string()),
  blockerDetails: z.array(structuredItemSchema),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  unresolvedQuestions: z.array(structuredItemSchema),
  suggestedNextActions: z.array(z.string()),
  inference: architectureInferenceSchema,
  confidence: z.object({
    score: z.number(),
    level: z.enum(["low", "medium", "high"]),
  }),
});
const serviceBreakdownSchema = z.object({
  serviceId: serviceIdEnum,
  kind: z.string(),
  label: z.string(),
  category: serviceBreakdownCategoryEnum,
  supportive: z.boolean(),
  region: z.string(),
  environment: z.string(),
  monthlyUsd: z.number(),
  implementationStatus: implementationStatusEnum,
  role: z.string(),
  required: z.boolean(),
  rationale: z.string(),
  capability: capabilityEntrySchema,
  details: z.string().nullable(),
});
const linkPlanSchema = z.object({
  blueprintId: blueprintIdEnum,
  patternId: patternIdEnum,
  scenarioId: z.string(),
  templateId: templateIdEnum,
  targetMonthlyUsd: z.number(),
  coreTargetMonthlyUsd: z.number().optional(),
  region: z.string(),
  estimateName: z.string(),
  notes: z.string().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  operatingSystem: operatingSystemEnum,
  scenarioPolicy: scenarioPolicySchema,
  exactAddOns: z
    .array(
      z.object({
        serviceId: serviceIdEnum,
        monthlyBudgetUsd: z.number(),
      }),
    )
    .default([]),
});
const pricingCommitSchema = z.object({
  contractVersion: z.literal(V1_CONTRACT_VERSION),
  kind: z.literal("pricing_commit"),
  architectureId: z.string(),
  blueprintId: blueprintIdEnum,
  patternId: patternIdEnum,
  scenarioId: z.string(),
  scenarioTitle: z.string(),
  modeledMonthlyUsd: z.number(),
  targetMonthlyUsd: z.number(),
  strategySummary: z.string(),
  token: z.string(),
});
const pricedScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  referenceMonthlyUsd: z.number(),
  targetMonthlyUsd: z.number(),
  modeledMonthlyUsd: z.number(),
  expectedSavingsPct: z.number(),
  strategySummary: z.string(),
  deltaDrivers: z.array(z.string()),
  scenarioPolicy: scenarioPolicySchema,
  budgetFit: budgetFitSchema,
  pricingConfidence: pricingConfidenceEnum,
  serviceBreakdown: z.array(serviceBreakdownSchema),
  coverage: serviceCoverageSchema.extend({
    calculatorEligible: z.boolean(),
  }),
  calculatorEligible: z.boolean(),
  calculatorBlockers: z.array(z.string()),
  linkPlan: linkPlanSchema.nullable(),
  pricingCommit: pricingCommitSchema.nullable().optional(),
  validation: validationSummarySchema,
});
const pricedArchitectureSchema = z.object({
  architecture: architectureSchema,
  scenarios: z.array(pricedScenarioSchema),
  comparisonSummary: z.array(
    z.object({
      scenarioId: z.string(),
      title: z.string(),
      modeledMonthlyUsd: z.number(),
      deltaVsBaselineUsd: z.number(),
      deltaVsBaselinePct: z.number(),
      calculatorEligible: z.boolean(),
    }),
  ),
  recommendedScenarioId: z.string().nullable(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
});
const generatedCalculatorScenarioSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  modeledMonthlyUsd: z.number(),
  calculatorEligible: z.boolean(),
  calculatorBlockers: z.array(z.string()),
  budgetFit: budgetFitSchema,
  strategySummary: z.string(),
  pricingCommit: pricingCommitSchema.nullable().optional(),
});
const generatedEstimateSchema = z.object({
  estimateId: z.string(),
  shareLink: z.string(),
  officialShareLink: z.boolean(),
  readOnlyViewer: z.boolean(),
  editInstructions: z.string(),
  blueprintId: blueprintIdEnum,
  estimateName: z.string(),
  region: z.string(),
  targetMonthlyUsd: z.number(),
  modeledMonthlyUsd: z.number(),
  storedMonthlyUsd: z.number(),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  serviceBreakdown: z.array(serviceBreakdownSchema),
  validation: validationSummarySchema,
});
const generatedCalculatorLinkOutputSchema = z.object({
  architecture: z.object({
    architectureId: z.string(),
    blueprintId: blueprintIdEnum,
    blueprintTitle: z.string(),
    patternId: patternIdEnum,
    patternTitle: z.string(),
    region: z.string(),
    estimateName: z.string(),
    targetMonthlyUsd: z.number().nullable(),
    serviceSelectionMode: serviceSelectionModeEnum,
    selectedServiceIds: z.array(serviceIdEnum),
  }),
  selectedScenario: generatedCalculatorScenarioSummarySchema,
  recommendedScenarioId: z.string().nullable(),
  availableScenarios: z.array(generatedCalculatorScenarioSummarySchema),
  estimate: generatedEstimateSchema,
});
const validatedEstimateSchema = z.object({
  estimateId: z.string(),
  shareLink: z.string(),
  officialShareLink: z.boolean(),
  estimateName: z.string(),
  totalMonthlyUsd: z.number(),
  serviceCount: z.number(),
  validation: validationSummarySchema,
});
export const toolErrorSchema = z.object({
  contractVersion: z.literal(V1_CONTRACT_VERSION),
  tool: enumFromValues(TOOL_NAMES, "toolName"),
  code: toolErrorCodeEnum,
  message: z.string(),
  hint: z.string().nullable(),
  details: z.array(z.string()).default([]),
});

export const listBlueprintsOutputSchema = z.object({
  blueprints: z.array(blueprintSchema),
});
export const listServiceCatalogOutputSchema = z.object({
  services: z.array(serviceCatalogEntrySchema),
});
export const designArchitectureInputSchema = z.object({
  blueprintId: blueprintIdEnum.optional(),
  brief: z.string().optional(),
  targetMonthlyUsd: z.number().positive().optional(),
  region: z.string().optional(),
  clientName: z.string().optional(),
  estimateName: z.string().optional(),
  notes: z.string().optional(),
  operatingSystem: operatingSystemEnum.optional(),
  environmentSplit: environmentSplitSchema.optional(),
  includeDefaultAddOns: z.boolean().optional(),
  serviceSelectionMode: serviceSelectionModeEnum.optional(),
  serviceIds: z.array(serviceIdEnum).optional(),
  scenarioPolicies: z.array(scenarioPolicySchema.partial()).optional(),
});
export const priceArchitectureInputSchema = z.object({
  architecture: z.unknown().optional(),
  architectureRef: architectureRefSchema.optional(),
  blueprintId: blueprintIdEnum.optional(),
  brief: z.string().optional(),
  targetMonthlyUsd: z.number().positive().optional(),
  region: z.string().optional(),
  clientName: z.string().optional(),
  estimateName: z.string().optional(),
  notes: z.string().optional(),
  operatingSystem: operatingSystemEnum.optional(),
  environmentSplit: environmentSplitSchema.optional(),
  includeDefaultAddOns: z.boolean().optional(),
  serviceSelectionMode: serviceSelectionModeEnum.optional(),
  serviceIds: z.array(serviceIdEnum).optional(),
  scenarioPolicies: z.array(scenarioPolicySchema.partial()).optional(),
});
export const generateCalculatorLinkInputSchema = designArchitectureInputSchema.extend({
  scenarioId: z.string().optional(),
});
export const createCalculatorLinkInputSchema = z.object({
  pricedScenario: z.unknown().optional(),
  pricingCommit: pricingCommitSchema.optional(),
}).refine((value) => value.pricedScenario || value.pricingCommit, {
  message: "Pass pricedScenario or pricingCommit.",
});
export const validateCalculatorLinkInputSchema = z.object({
  shareLinkOrEstimateId: z.string(),
  blueprintId: blueprintIdEnum.optional(),
  patternId: patternIdEnum.optional(),
  expectedMonthlyUsd: z.number().positive().optional(),
  expectedRegion: z.string().optional(),
  expectedRegionMode: regionModeEnum.optional(),
  validationMode: validationModeEnum.optional(),
  budgetTolerancePct: z.number().positive().max(1).optional(),
});

export const TOOL_CONTRACTS = Object.freeze({
  list_blueprints: {
    name: "list_blueprints",
    description: "List the blueprint catalog supported by the architecture engine.",
    outputSchema: listBlueprintsOutputSchema,
  },
  list_service_catalog: {
    name: "list_service_catalog",
    description:
      "List the service registry with per-region capability states and implementation status.",
    outputSchema: listServiceCatalogOutputSchema,
  },
  design_architecture: {
    name: "design_architecture",
    description:
      "Normalize a blueprint or rough brief into an architecture spec with explicit service capabilities and default scenario policies.",
    inputSchema: designArchitectureInputSchema,
    outputSchema: architectureSchema,
  },
  price_architecture: {
    name: "price_architecture",
    description:
      "Preview priced scenarios for an architecture and return calculator commit handles for exact scenarios. Use generate_calculator_link for the default one-shot flow, or create_calculator_link to commit a selected priced scenario.",
    inputSchema: priceArchitectureInputSchema,
    outputSchema: pricedArchitectureSchema,
  },
  generate_calculator_link: {
    name: "generate_calculator_link",
    description:
      "Default happy path for chat clients: design if needed, price scenarios, pick a calculator-eligible scenario, create the official AWS calculator share link, and validate the saved estimate.",
    inputSchema: generateCalculatorLinkInputSchema,
    outputSchema: generatedCalculatorLinkOutputSchema,
  },
  create_calculator_link: {
    name: "create_calculator_link",
    description:
      "Commit a previously priced exact scenario to AWS Pricing Calculator by passing its pricingCommit handle, then validate the saved estimate.",
    inputSchema: createCalculatorLinkInputSchema,
    outputSchema: generatedEstimateSchema,
  },
  validate_calculator_link: {
    name: "validate_calculator_link",
    description:
      "Validate an AWS calculator share link for pricing integrity, architecture completeness, and funding readiness.",
    inputSchema: validateCalculatorLinkInputSchema,
    outputSchema: validatedEstimateSchema,
  },
});

export function listToolContracts() {
  return TOOL_NAMES.map((toolName) => TOOL_CONTRACTS[toolName]);
}

export function getToolContract(toolName) {
  const contract = TOOL_CONTRACTS[toolName];

  if (!contract) {
    throw new Error(
      `Unknown v1 tool contract '${toolName}'. Supported tools: ${TOOL_NAMES.join(", ")}.`,
    );
  }

  return contract;
}

export function normalizeToolOutput(toolName, structuredContent) {
  return getToolContract(toolName).outputSchema.parse(structuredContent);
}

export function normalizeToolError(errorPayload) {
  return toolErrorSchema.parse(errorPayload);
}

function schemaDocument(schema, id, title) {
  return {
    $id: id,
    title,
    ...z.toJSONSchema(schema),
  };
}

export function createContractManifest() {
  return {
    contractVersion: V1_CONTRACT_VERSION,
    tools: listToolContracts().map((contract) => ({
      name: contract.name,
      description: contract.description,
      inputSchemaId: contract.inputSchema
        ? `aws-pricing-calculator-mcp.contract.${V1_CONTRACT_VERSION}.tools.${contract.name}.input`
        : null,
      outputSchemaId: `aws-pricing-calculator-mcp.contract.${V1_CONTRACT_VERSION}.tools.${contract.name}.output`,
    })),
    enums: {
      blueprintIds: blueprintIdValues,
      patternIds: patternIdValues,
      templateIds: templateIdValues,
      serviceIds: serviceIdValues,
      support: SUPPORT_VALUES,
      implementationStatus: IMPLEMENTATION_STATUS_VALUES,
      budgetFitStatus: BUDGET_FIT_STATUS_VALUES,
      sourceType: SOURCE_TYPE_VALUES,
      operatingSystem: OPERATING_SYSTEM_VALUES,
      regionMode: REGION_MODE_VALUES,
      serviceSelectionMode: SERVICE_SELECTION_MODE_VALUES,
      validationMode: VALIDATION_MODE_VALUES,
      validationContextSource: VALIDATION_CONTEXT_SOURCE_VALUES,
      validationStatus: VALIDATION_STATUS_VALUES,
      validationSeverity: VALIDATION_SEVERITY_VALUES,
      validationPackIds: VALIDATION_PACK_IDS,
      validationRuleIds: VALIDATION_RULE_ID_VALUES,
      toolErrorCodes: TOOL_ERROR_CODE_VALUES,
      pricingConfidence: PRICING_CONFIDENCE_VALUES,
      selectedServiceSource: SELECTED_SERVICE_SOURCE_VALUES,
      inferenceSource: INFERENCE_SOURCE_VALUES,
      computeCommitment: COMPUTE_COMMITMENT_VALUES,
      databaseCommitment: DATABASE_COMMITMENT_VALUES,
      haPosture: HA_POSTURE_VALUES,
      storageStrategy: STORAGE_STRATEGY_VALUES,
      environmentSizing: ENVIRONMENT_SIZING_VALUES,
      sharedServicesProfile: SHARED_SERVICES_PROFILE_VALUES,
      dataTransferProfile: DATA_TRANSFER_PROFILE_VALUES,
      justificationProfile: JUSTIFICATION_PROFILE_VALUES,
    },
  };
}

export function createContractArtifacts() {
  const manifest = createContractManifest();
  const toolSchemas = Object.fromEntries(
    listToolContracts().map((contract) => [
      contract.name,
      {
        input: contract.inputSchema
          ? schemaDocument(
              contract.inputSchema,
              `aws-pricing-calculator-mcp.contract.${V1_CONTRACT_VERSION}.tools.${contract.name}.input`,
              `${contract.name} input`,
            )
          : null,
        output: schemaDocument(
          contract.outputSchema,
          `aws-pricing-calculator-mcp.contract.${V1_CONTRACT_VERSION}.tools.${contract.name}.output`,
          `${contract.name} output`,
        ),
      },
    ]),
  );

  return {
    manifest,
    toolError: schemaDocument(
      toolErrorSchema,
      `aws-pricing-calculator-mcp.contract.${V1_CONTRACT_VERSION}.tool-error`,
      "tool error",
    ),
    tools: toolSchemas,
  };
}

export {
  architectureSchema,
  budgetFitSchema,
  generatedEstimateSchema,
  pricedArchitectureSchema,
  pricedScenarioSchema,
  scenarioPolicySchema,
  serviceCatalogEntrySchema,
  validatedEstimateSchema,
};
