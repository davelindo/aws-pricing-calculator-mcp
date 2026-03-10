import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  DEFAULT_REGION,
  listTemplateCatalog,
  supportedTemplateIds,
} from "./catalog.js";
import {
  fetchSavedEstimate,
  isOfficialCalculatorShareLink,
  saveEstimate,
} from "./calculator-client.js";
import { createModeledEstimate, planEstimate } from "./planner.js";
import { validateEstimatePayload } from "./validation.js";

const templateIdEnum = z.enum(supportedTemplateIds());
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
const validationCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "warning", "fail"]),
  blocking: z.boolean(),
  details: z.string(),
});
const serviceBreakdownSchema = z.object({
  kind: z.string(),
  label: z.string(),
  category: z.string(),
  supportive: z.boolean(),
  region: z.string(),
  environment: z.string(),
  monthlyUsd: z.number(),
});
const planSummaryEnvironmentSchema = z.object({
  environment: z.string(),
  eksClusterCount: z.number(),
  computeInstanceType: z.string(),
  computeInstanceCount: z.number(),
  rdsInstanceType: z.string().nullable(),
  rdsDeploymentOption: z.string().nullable(),
  rdsStorageGb: z.number(),
});
const servicePlanSummarySchema = z.object({
  computeOs: z.enum(["linux", "windows"]),
  includesEks: z.boolean(),
  databaseEngine: z.literal("postgresql"),
  rdsTierId: z.string(),
  computeInstanceType: z.string(),
  totalInstances: z.number(),
  natProcessedGb: z.number(),
  minimumModeledSpendUsd: z.number(),
  environments: z.array(planSummaryEnvironmentSchema),
});
const createInputSchema = z.object({
  templateId: templateIdEnum,
  targetMonthlyUsd: z.number().positive(),
  region: z.string(),
  clientName: z.string().nullable(),
  estimateName: z.string(),
  notes: z.string().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  operatingSystem: z.enum(["linux", "windows"]),
});
const templateSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  defaultRegion: z.string(),
  supportedRegions: z.array(z.string()),
  expectedInputs: z.array(z.string()),
  supportiveInfra: z.array(z.string()),
  requiredServiceCodes: z.array(z.string()),
  supportiveServiceCodes: z.array(z.string()),
  primaryMinRatio: z.number(),
  supportiveMaxRatio: z.number(),
  defaultEnvironmentSplit: normalizedEnvironmentSplitSchema,
});
const validationSummarySchema = z.object({
  templateId: z.string(),
  templateTitle: z.string(),
  expectedMonthlyUsd: z.number().nullable(),
  storedMonthlyUsd: z.number(),
  modeledMonthlyUsd: z.number(),
  expectedRegion: z.string().nullable(),
  regions: z.array(z.string()),
  serviceCodes: z.array(z.string()),
  checks: z.array(validationCheckSchema),
  hardFailures: z.array(z.string()),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  passed: z.boolean(),
});
const planEstimateResultSchema = z.object({
  readyToCreate: z.boolean(),
  sourceType: z.enum(["template", "brief", "hybrid"]),
  briefSummary: z.string().nullable(),
  templateId: z.string(),
  templateTitle: z.string(),
  clientName: z.string().nullable(),
  estimateName: z.string(),
  region: z.string(),
  targetMonthlyUsd: z.number().nullable(),
  modeledMonthlyUsd: z.number().nullable(),
  environmentSplit: normalizedEnvironmentSplitSchema,
  blockers: z.array(z.string()),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  servicePlanSummary: servicePlanSummarySchema.nullable(),
  serviceBreakdown: z.array(serviceBreakdownSchema),
  createInput: createInputSchema.nullable(),
});
const generatedEstimateSchema = z.object({
  estimateId: z.string(),
  shareLink: z.string(),
  officialShareLink: z.boolean(),
  readOnlyViewer: z.boolean(),
  editInstructions: z.string(),
  templateId: z.string(),
  templateTitle: z.string(),
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
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
  };
}

function renderChecks(checks) {
  return checks
    .map((check) => `- ${check.status.toUpperCase()} ${check.name}: ${check.details}`)
    .join("\n");
}

function renderServiceBreakdown(services) {
  return services
    .map(
      (service) =>
        `- ${service.environment} ${service.label}: ${service.monthlyUsd.toFixed(2)} USD/month (${service.region})`,
    )
    .join("\n");
}

function renderPlan(plan) {
  return [
    `${plan.templateTitle}`,
    `Ready to create: ${plan.readyToCreate ? "yes" : "no"}`,
    `Region: ${plan.region}`,
    `Target monthly: ${
      plan.targetMonthlyUsd == null ? "not resolved" : `${plan.targetMonthlyUsd.toFixed(2)} USD`
    }`,
    `Modeled monthly: ${
      plan.modeledMonthlyUsd == null ? "not modeled" : `${plan.modeledMonthlyUsd.toFixed(2)} USD`
    }`,
    "",
    plan.blockers.length > 0 ? `Blockers:\n${plan.blockers.map((value) => `- ${value}`).join("\n")}` : "Blockers:\n- none",
    "",
    `Warnings:\n${plan.warnings.length > 0 ? plan.warnings.map((value) => `- ${value}`).join("\n") : "- none"}`,
    "",
    `Assumptions:\n${plan.assumptions.length > 0 ? plan.assumptions.map((value) => `- ${value}`).join("\n") : "- none"}`,
    plan.serviceBreakdown.length > 0
      ? `\nService breakdown:\n${renderServiceBreakdown(plan.serviceBreakdown)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderGeneratedEstimate(result) {
  return [
    result.templateTitle,
    result.shareLink,
    `Target monthly: ${result.targetMonthlyUsd.toFixed(2)} USD`,
    `Modeled monthly: ${result.modeledMonthlyUsd.toFixed(2)} USD`,
    `Stored monthly: ${result.storedMonthlyUsd.toFixed(2)} USD`,
    `Read-only viewer: ${result.readOnlyViewer ? "yes" : "no"}`,
    result.editInstructions,
    "",
    "Warnings:",
    result.warnings.length > 0 ? result.warnings.map((warning) => `- ${warning}`).join("\n") : "- none",
    "",
    "Service breakdown:",
    renderServiceBreakdown(result.serviceBreakdown),
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
    `Official share link: ${result.officialShareLink ? "yes" : "no"}`,
    `Validation: ${result.validation.passed ? "passed" : "needs review"}`,
    "",
    "Hard failures:",
    result.validation.hardFailures.length > 0
      ? result.validation.hardFailures.map((value) => `- ${value}`).join("\n")
      : "- none",
    "",
    "Warnings:",
    result.validation.warnings.length > 0
      ? result.validation.warnings.map((value) => `- ${value}`).join("\n")
      : "- none",
    "",
    "Checks:",
    renderChecks(result.validation.checks),
  ].join("\n");
}

function resolveValidateRegion(expectedRegion) {
  return expectedRegion ?? DEFAULT_REGION;
}

export function createServer() {
  const server = new McpServer({
    name: "aws-pricing-calculator-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_templates",
    {
      description:
        "List the funding templates supported by this MCP, including defaults, required services, and supportive infrastructure coverage.",
      outputSchema: {
        templates: z.array(templateSummarySchema),
      },
    },
    async () => {
      const templates = listTemplateCatalog();

      return textToolResponse(
        templates.map((template) => `${template.id}: ${template.description}`).join("\n"),
        {
          templates,
        },
      );
    },
  );

  server.registerTool(
    "plan_estimate",
    {
      description:
        "Normalize a funding request into a concrete AWS estimate plan. Use either a template id or a rough infra brief, optionally with overrides.",
      inputSchema: {
        templateId: templateIdEnum.optional().describe("Optional template override."),
        brief: z.string().optional().describe("Optional rough infra brief for inference."),
        targetMonthlyUsd: z
          .number()
          .positive()
          .optional()
          .describe("Optional explicit monthly target in USD."),
        region: z.string().optional().describe(`Optional explicit region. Defaults to ${DEFAULT_REGION}.`),
        clientName: z.string().optional().describe("Optional customer name."),
        estimateName: z.string().optional().describe("Optional estimate name."),
        notes: z.string().optional().describe("Optional free-form notes appended to service descriptions."),
        operatingSystem: z
          .enum(["linux", "windows"])
          .optional()
          .describe("Optional OS hint when planning from a brief."),
        environmentSplit: environmentSplitSchema
          .optional()
          .describe("Optional environment split. Values are normalized, so 20/30/50 works."),
      },
      outputSchema: planEstimateResultSchema.shape,
    },
    async (args) => {
      const result = planEstimate(args);
      return textToolResponse(renderPlan(result), result);
    },
  );

  server.registerTool(
    "create_calculator_link",
    {
      description:
        "Create an official AWS calculator share link from a normalized plan or the same high-level planning inputs, then validate the saved estimate.",
      inputSchema: {
        plan: z
          .object({
            createInput: createInputSchema,
          })
          .optional()
          .describe("Optional result returned by plan_estimate."),
        templateId: templateIdEnum.optional().describe("Optional template when not passing a plan."),
        brief: z.string().optional().describe("Optional rough infra brief when not passing a plan."),
        targetMonthlyUsd: z
          .number()
          .positive()
          .optional()
          .describe("Optional explicit monthly target in USD."),
        region: z.string().optional().describe(`Optional explicit region. Defaults to ${DEFAULT_REGION}.`),
        clientName: z.string().optional().describe("Optional customer name."),
        estimateName: z.string().optional().describe("Optional estimate name."),
        notes: z.string().optional().describe("Optional notes appended to service descriptions."),
        operatingSystem: z
          .enum(["linux", "windows"])
          .optional()
          .describe("Optional OS hint when planning from a brief."),
        environmentSplit: environmentSplitSchema
          .optional()
          .describe("Optional environment split. Values are normalized, so 20/30/50 works."),
      },
      outputSchema: generatedEstimateSchema.shape,
    },
    async (args) => {
      const modeled = createModeledEstimate(args);
      const saved = await saveEstimate(modeled.estimate);
      const fetched = await fetchSavedEstimate(saved.savedKey);
      const validation = validateEstimatePayload({
        estimate: fetched.estimate,
        templateId: modeled.template.id,
        expectedMonthlyUsd: modeled.plan.createInput?.targetMonthlyUsd,
        expectedRegion: modeled.plan.createInput?.region,
      });
      const storedMonthlyUsd = Number(fetched.estimate?.totalCost?.monthly ?? 0);
      const result = {
        estimateId: saved.savedKey,
        shareLink: saved.shareLink,
        officialShareLink: isOfficialCalculatorShareLink(saved.shareLink),
        readOnlyViewer: true,
        editInstructions:
          "Shared calculator links open in AWS's read-only viewer. Click 'Update estimate' inside calculator.aws to enter the editable flow.",
        templateId: modeled.template.id,
        templateTitle: modeled.template.title,
        estimateName: fetched.estimate.name,
        region: modeled.plan.createInput.region,
        targetMonthlyUsd: modeled.plan.createInput.targetMonthlyUsd,
        modeledMonthlyUsd: modeled.validation.modeledMonthlyUsd,
        storedMonthlyUsd,
        assumptions: modeled.plan.assumptions,
        warnings: modeled.plan.warnings,
        serviceBreakdown: modeled.serviceBreakdown,
        validation,
      };

      return textToolResponse(renderGeneratedEstimate(result), result);
    },
  );

  server.registerTool(
    "validate_calculator_link",
    {
      description:
        "Validate an AWS calculator share link for funding-readiness checks such as region consistency, service coverage, and target-budget alignment.",
      inputSchema: {
        shareLinkOrEstimateId: z
          .string()
          .describe("A calculator share link or the raw saved estimate id."),
        templateId: templateIdEnum.optional().describe("Optional expected template. If omitted, this MCP infers it from the saved service mix."),
        expectedMonthlyUsd: z
          .number()
          .positive()
          .optional()
          .describe("Optional expected monthly target in USD."),
        expectedRegion: z
          .string()
          .optional()
          .describe(`Optional expected region. Defaults to ${DEFAULT_REGION} when supplied by callers.`),
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
      templateId,
      expectedMonthlyUsd,
      expectedRegion,
      budgetTolerancePct,
    }) => {
      const fetched = await fetchSavedEstimate(shareLinkOrEstimateId);
      const validation = validateEstimatePayload({
        estimate: fetched.estimate,
        templateId,
        expectedMonthlyUsd,
        expectedRegion: expectedRegion ?? (expectedMonthlyUsd == null ? undefined : resolveValidateRegion(expectedRegion)),
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
