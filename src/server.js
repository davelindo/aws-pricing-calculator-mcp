import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  DEFAULT_REGION,
  getBlueprint,
  getServiceRegionCapability,
  listBlueprintCatalog,
  listServiceCatalog,
  supportedBlueprintIds,
} from "./catalog.js";
import {
  fetchSavedEstimate,
  isOfficialCalculatorShareLink,
  saveEstimate,
} from "./calculator-client.js";
import {
  buildCalculatorEstimateFromScenario,
  designArchitecture,
  priceArchitecture,
} from "./planner.js";
import { validateEstimatePayload } from "./validation.js";

const blueprintIdEnum = z.enum(supportedBlueprintIds());
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
const capabilityEntrySchema = z.object({
  region: z.string(),
  support: z.enum(["exact", "modeled", "unavailable"]),
  calculatorSaveSupported: z.boolean(),
  validationSupported: z.boolean(),
  reason: z.string(),
});
const serviceCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  implementationStatus: z.enum(["implemented", "modeled", "planned"]),
  keywords: z.array(z.string()),
  pricingStrategies: z.array(z.string()),
  calculatorServiceCodes: z.array(z.string()),
  capabilityMatrix: z.array(capabilityEntrySchema),
  supportedRegions: z.array(z.string()),
});
const blueprintSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  defaultOperatingSystem: z.string(),
  packIds: z.array(z.string()),
  packs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
  requiredServiceFamilies: z.array(z.string()),
  requiredServiceIds: z.array(z.string()),
  defaultAddOnServiceIds: z.array(z.string()),
  optionalServiceIds: z.array(z.string()),
  supportedRegions: z.array(z.string()),
});
const structuredItemSchema = z.object({
  id: z.string(),
  field: z.string(),
  message: z.string(),
  remediation: z.string(),
  blocking: z.boolean(),
});
const inferenceFieldSchema = z.object({
  value: z.any(),
  source: z.string(),
  confidence: z.number(),
});
const scenarioPolicySchema = z.object({
  id: z.string(),
  title: z.string(),
  computeCommitment: z.string(),
  computeDiscountPct: z.number(),
  databaseCommitment: z.string(),
  databaseDiscountPct: z.number(),
  haPosture: z.string(),
  prodMultiAz: z.boolean(),
  nonProdMultiAz: z.boolean(),
  storageStrategy: z.string(),
  storageMultiplier: z.number(),
  environmentSizing: z.string(),
  environmentScaleFactors: normalizedEnvironmentSplitSchema,
  sharedServicesProfile: z.string(),
  sharedServicesMultiplier: z.number(),
  dataTransferProfile: z.string(),
  dataTransferMultiplier: z.number(),
  justificationProfile: z.string(),
  expectedSavingsPct: z.number(),
  coreBudgetFactor: z.number(),
  addOnBudgetFactor: z.number(),
  strategySummary: z.string(),
});
const selectedServiceSchema = z.object({
  serviceId: z.string(),
  serviceName: z.string(),
  category: z.string(),
  implementationStatus: z.enum(["implemented", "modeled", "planned"]),
  required: z.boolean(),
  source: z.string(),
  capability: capabilityEntrySchema,
});
const serviceCoverageSchema = z.object({
  exact: z.array(z.string()),
  modeled: z.array(z.string()),
  unavailable: z.array(z.string()),
});
const validationCheckSchema = z.object({
  pack: z.string(),
  id: z.string(),
  title: z.string(),
  status: z.enum(["pass", "warning", "fail"]),
  severity: z.enum(["info", "warning", "error"]),
  blocking: z.boolean(),
  reason: z.string(),
  remediation: z.string(),
  details: z.string(),
  evidence: z.any().nullable().optional(),
});
const validationPackSchema = z.object({
  id: z.string(),
  title: z.string(),
  passed: z.boolean(),
  blocking: z.boolean(),
  failedRuleCount: z.number(),
  warningRuleCount: z.number(),
  checks: z.array(validationCheckSchema),
});
const validationRuleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  details: z.string(),
  remediation: z.string(),
});
const parityDetailSchema = z.object({
  serviceId: z.string().nullable(),
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
  blueprintId: z.string().optional(),
  blueprintTitle: z.string().optional(),
  templateId: z.string().optional(),
  templateTitle: z.string().optional(),
  expectedMonthlyUsd: z.number().nullable().optional(),
  storedMonthlyUsd: z.number().optional(),
  modeledMonthlyUsd: z.number().optional(),
  expectedRegion: z.string().nullable().optional(),
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
const architectureSchema = z.object({
  version: z.string(),
  architectureId: z.string(),
  readyToPrice: z.boolean(),
  sourceType: z.enum(["brief", "hybrid", "blueprint"]),
  briefSummary: z.string().nullable(),
  blueprintId: z.string(),
  blueprintTitle: z.string(),
  templateId: z.string(),
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
  operatingSystem: z.enum(["linux", "windows"]),
  targetMonthlyUsd: z.number().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  includeDefaultAddOns: z.boolean(),
  selectedServices: z.array(selectedServiceSchema),
  serviceCoverage: serviceCoverageSchema,
  defaultScenarioPolicies: z.array(scenarioPolicySchema),
  blockers: z.array(z.string()),
  blockerDetails: z.array(structuredItemSchema),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  unresolvedQuestions: z.array(structuredItemSchema),
  suggestedNextActions: z.array(z.string()),
  inference: z.object({
    blueprint: inferenceFieldSchema,
    region: inferenceFieldSchema,
    targetMonthlyUsd: inferenceFieldSchema,
    operatingSystem: inferenceFieldSchema,
    environmentSplit: inferenceFieldSchema,
    databaseEngine: inferenceFieldSchema,
  }),
  confidence: z.object({
    score: z.number(),
    level: z.enum(["low", "medium", "high"]),
  }),
});
const serviceBreakdownSchema = z.object({
  serviceId: z.string(),
  kind: z.string(),
  label: z.string(),
  category: z.string(),
  supportive: z.boolean(),
  region: z.string(),
  environment: z.string(),
  monthlyUsd: z.number(),
  implementationStatus: z.string(),
  capability: capabilityEntrySchema,
  details: z.string().nullable(),
});
const linkPlanSchema = z.object({
  blueprintId: z.string(),
  scenarioId: z.string(),
  templateId: z.string(),
  targetMonthlyUsd: z.number(),
  coreTargetMonthlyUsd: z.number().optional(),
  region: z.string(),
  estimateName: z.string(),
  notes: z.string().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  operatingSystem: z.enum(["linux", "windows"]),
  scenarioPolicy: scenarioPolicySchema,
  exactAddOns: z
    .array(
      z.object({
        serviceId: z.string(),
        monthlyBudgetUsd: z.number(),
      }),
    )
    .default([]),
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
  pricingConfidence: z.string(),
  serviceBreakdown: z.array(serviceBreakdownSchema),
  coverage: serviceCoverageSchema.extend({
    calculatorEligible: z.boolean(),
  }),
  calculatorEligible: z.boolean(),
  calculatorBlockers: z.array(z.string()),
  linkPlan: linkPlanSchema.nullable(),
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
const generatedEstimateSchema = z.object({
  estimateId: z.string(),
  shareLink: z.string(),
  officialShareLink: z.boolean(),
  readOnlyViewer: z.boolean(),
  editInstructions: z.string(),
  blueprintId: z.string(),
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
const validatedEstimateSchema = z.object({
  estimateId: z.string(),
  shareLink: z.string(),
  officialShareLink: z.boolean(),
  estimateName: z.string(),
  totalMonthlyUsd: z.number(),
  serviceCount: z.number(),
  validation: validationSummarySchema,
});

function textToolResponse(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function renderChecks(checks) {
  return checks
    .map(
      (check) =>
        `- ${check.severity.toUpperCase()} [${check.pack}] ${check.id}: ${check.details}`,
    )
    .join("\n");
}

function renderArchitecture(architecture) {
  return [
    architecture.blueprintTitle,
    `Ready to price: ${architecture.readyToPrice ? "yes" : "no"}`,
    `Confidence: ${architecture.confidence.level} (${architecture.confidence.score}/100)`,
    `Region: ${architecture.region}`,
    `Target monthly: ${
      architecture.targetMonthlyUsd == null
        ? "not resolved"
        : `${architecture.targetMonthlyUsd.toFixed(2)} USD`
    }`,
    `Packs: ${architecture.packIds.join(", ") || "none"}`,
    "",
    "Selected services:",
    architecture.selectedServices
      .map(
        (service) =>
          `- ${service.serviceName} (${service.capability.support}, ${service.capability.region})`,
      )
      .join("\n"),
    architecture.unresolvedQuestions.length > 0
      ? ["", "Unresolved questions:", architecture.unresolvedQuestions.map((item) => `- ${item.message}`).join("\n")].join(
          "\n",
        )
      : "",
  ].join("\n");
}

function renderPricedArchitecture(result) {
  return [
    result.architecture.blueprintTitle,
    `Recommended scenario: ${result.recommendedScenarioId ?? "none"}`,
    "",
    ...result.scenarios.map((scenario) =>
      [
        `${scenario.title}: ${scenario.modeledMonthlyUsd.toFixed(2)} USD/month`,
        `Policy: ${scenario.scenarioPolicy.computeCommitment}, ${scenario.scenarioPolicy.haPosture}, ${scenario.scenarioPolicy.environmentSizing}`,
        `Drivers: ${scenario.deltaDrivers.join("; ")}`,
        `Calculator eligible: ${scenario.calculatorEligible ? "yes" : "no"}`,
        scenario.calculatorBlockers.length > 0
          ? scenario.calculatorBlockers.map((value) => `- ${value}`).join("\n")
          : "- no calculator blockers",
      ].join("\n"),
    ),
  ].join("\n\n");
}

function renderGeneratedEstimate(result) {
  return [
    result.shareLink,
    `Blueprint: ${result.blueprintId}`,
    `Target monthly: ${result.targetMonthlyUsd.toFixed(2)} USD`,
    `Modeled monthly: ${result.modeledMonthlyUsd.toFixed(2)} USD`,
    `Stored monthly: ${result.storedMonthlyUsd.toFixed(2)} USD`,
    `Blocking failures: ${result.validation.blockingFailures.length}`,
    `Parity rows: ${result.validation.parityDetails.length}`,
    "",
    "Validation:",
    renderChecks(result.validation.checks),
  ].join("\n");
}

function renderValidatedEstimate(result) {
  return [
    result.shareLink,
    `Estimate: ${result.estimateName}`,
    `Monthly total: ${result.totalMonthlyUsd.toFixed(2)} USD`,
    `Validation: ${result.validation.passed ? "passed" : "needs review"}`,
    `Blocking failures: ${result.validation.blockingFailures.length}`,
    `Parity rows: ${result.validation.parityDetails.length}`,
  ].join("\n");
}

export function createServer() {
  const server = new McpServer({
    name: "aws-pricing-calculator-mcp",
    version: "4.0.0",
  });

  server.registerTool(
    "list_blueprints",
    {
      description: "List the blueprint catalog supported by the architecture engine.",
      outputSchema: {
        blueprints: z.array(blueprintSchema),
      },
    },
    async () => {
      const blueprints = listBlueprintCatalog();
      return textToolResponse(
        blueprints.map((blueprint) => `${blueprint.id}: ${blueprint.description}`).join("\n"),
        { blueprints },
      );
    },
  );

  server.registerTool(
    "list_service_catalog",
    {
      description:
        "List the service registry with per-region capability states and implementation status.",
      outputSchema: {
        services: z.array(serviceCatalogEntrySchema),
      },
    },
    async () => {
      const services = listServiceCatalog();
      return textToolResponse(
        services
          .map((service) => `${service.id}: ${service.name} (${service.implementationStatus})`)
          .join("\n"),
        { services },
      );
    },
  );

  server.registerTool(
    "design_architecture",
    {
      description:
        "Normalize a blueprint or rough brief into an architecture spec with explicit service capabilities and default scenario policies.",
      inputSchema: {
        blueprintId: blueprintIdEnum.optional(),
        brief: z.string().optional(),
        targetMonthlyUsd: z.number().positive().optional(),
        region: z.string().optional().describe(`Optional explicit region. Defaults to ${DEFAULT_REGION}.`),
        clientName: z.string().optional(),
        estimateName: z.string().optional(),
        notes: z.string().optional(),
        operatingSystem: z.enum(["linux", "windows"]).optional(),
        environmentSplit: environmentSplitSchema.optional(),
        includeDefaultAddOns: z.boolean().optional(),
        serviceIds: z.array(z.string()).optional(),
        scenarioPolicies: z.array(scenarioPolicySchema.partial()).optional(),
      },
      outputSchema: architectureSchema.shape,
    },
    async (args) => {
      const architecture = designArchitecture(args);
      return textToolResponse(renderArchitecture(architecture), architecture);
    },
  );

  server.registerTool(
    "price_architecture",
    {
      description:
        "Price one or more scenario policies for an architecture and report exact, modeled, and unavailable service coverage.",
      inputSchema: {
        architecture: architectureSchema.optional(),
        blueprintId: blueprintIdEnum.optional(),
        brief: z.string().optional(),
        targetMonthlyUsd: z.number().positive().optional(),
        region: z.string().optional(),
        clientName: z.string().optional(),
        estimateName: z.string().optional(),
        notes: z.string().optional(),
        operatingSystem: z.enum(["linux", "windows"]).optional(),
        environmentSplit: environmentSplitSchema.optional(),
        includeDefaultAddOns: z.boolean().optional(),
        serviceIds: z.array(z.string()).optional(),
        scenarioPolicies: z.array(scenarioPolicySchema.partial()).optional(),
      },
      outputSchema: pricedArchitectureSchema.shape,
    },
    async (args) => {
      const priced = priceArchitecture(args);
      return textToolResponse(renderPricedArchitecture(priced), priced);
    },
  );

  server.registerTool(
    "create_calculator_link",
    {
      description:
        "Create an official AWS calculator share link from an exact priced scenario and validate the saved estimate.",
      inputSchema: {
        pricedScenario: pricedScenarioSchema,
      },
      outputSchema: generatedEstimateSchema.shape,
    },
    async ({ pricedScenario }) => {
      const built = buildCalculatorEstimateFromScenario({ pricedScenario });
      const saved = await saveEstimate(built.estimate);
      const fetched = await fetchSavedEstimate(saved.savedKey);
      const validation = validateEstimatePayload({
        estimate: fetched.estimate,
        templateId: built.linkPlan.templateId,
        expectedMonthlyUsd: built.linkPlan.targetMonthlyUsd,
        expectedRegion: built.linkPlan.region,
      });
      const result = {
        estimateId: saved.savedKey,
        shareLink: saved.shareLink,
        officialShareLink: isOfficialCalculatorShareLink(saved.shareLink),
        readOnlyViewer: true,
        editInstructions:
          "Shared calculator links open in AWS's read-only viewer. Click 'Update estimate' inside calculator.aws to enter the editable flow.",
        blueprintId: built.linkPlan.blueprintId,
        estimateName: fetched.estimate.name,
        region: built.linkPlan.region,
        targetMonthlyUsd: built.linkPlan.targetMonthlyUsd,
        modeledMonthlyUsd: built.validation.modeledMonthlyUsd,
        storedMonthlyUsd: Number(fetched.estimate?.totalCost?.monthly ?? 0),
        assumptions: built.validation.assumptions,
        warnings: built.validation.warnings,
        serviceBreakdown: built.serviceBreakdown.map((service) => ({
          ...service,
          capability:
            service.capability ??
            getServiceRegionCapability(service.serviceId, service.region),
        })),
        validation,
      };

      return textToolResponse(renderGeneratedEstimate(result), result);
    },
  );

  server.registerTool(
    "validate_calculator_link",
    {
      description:
        "Validate an AWS calculator share link for pricing integrity, architecture completeness, and funding readiness.",
      inputSchema: {
        shareLinkOrEstimateId: z.string(),
        blueprintId: blueprintIdEnum.optional(),
        expectedMonthlyUsd: z.number().positive().optional(),
        expectedRegion: z.string().optional(),
        budgetTolerancePct: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe(`Optional tolerance. Defaults to ${DEFAULT_BUDGET_TOLERANCE_PCT}.`),
      },
      outputSchema: validatedEstimateSchema.shape,
    },
    async ({
      shareLinkOrEstimateId,
      blueprintId,
      expectedMonthlyUsd,
      expectedRegion,
      budgetTolerancePct,
    }) => {
      const fetched = await fetchSavedEstimate(shareLinkOrEstimateId);
      const templateId = blueprintId ? getBlueprint(blueprintId).templateId : undefined;
      const validation = validateEstimatePayload({
        estimate: fetched.estimate,
        templateId,
        expectedMonthlyUsd,
        expectedRegion,
        budgetTolerancePct,
      });
      const result = {
        estimateId: fetched.estimateId,
        shareLink: fetched.shareLink,
        officialShareLink: isOfficialCalculatorShareLink(fetched.shareLink),
        estimateName: fetched.estimate.name,
        totalMonthlyUsd: Number(fetched.estimate?.totalCost?.monthly ?? 0),
        serviceCount: Object.keys(fetched.estimate?.services ?? {}).length,
        validation,
      };

      return textToolResponse(renderValidatedEstimate(result), result);
    },
  );

  return server;
}
