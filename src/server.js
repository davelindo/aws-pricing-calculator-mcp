import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DEFAULT_BUDGET_TOLERANCE_PCT,
  DEFAULT_REGION,
  getBlueprint,
  getServiceRegionCapability,
  listBlueprintCatalog,
  listServiceCatalog,
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
import {
  TOOL_CONTRACTS,
  normalizeToolError,
  normalizeToolOutput,
} from "./contract/v1.js";
import { validateEstimatePayload } from "./validation.js";

const STRUCTURAL_PACKS = new Set(["pricing-integrity", "architecture-completeness"]);
const POLICY_PACKS = new Set(["funding-readiness", "platform-governance"]);

function successToolResponse(toolName, text, structuredContent) {
  const normalized = normalizeToolOutput(toolName, structuredContent);

  return {
    content: [{ type: "text", text }],
    structuredContent: normalized,
  };
}

function toolHint(toolName, errorMessage) {
  if (toolName === "price_architecture") {
    return "Retry with the full architecture returned by design_architecture, supply blueprintId/brief directly, or use generate_calculator_link for a one-shot share-link flow.";
  }

  if (toolName === "generate_calculator_link") {
    if (/Scenario '/i.test(errorMessage) && /not found/i.test(errorMessage)) {
      return "Omit scenarioId to let the server pick the best calculator-eligible scenario, or pass baseline, optimized, or aggressive.";
    }

    if (
      /calculator-eligible/i.test(errorMessage) ||
      /cannot mint an official calculator link/i.test(errorMessage)
    ) {
      return "Try a different scenarioId, or narrow the request so only exact supported services remain in scope.";
    }

    return "Pass the same inputs you would use for price_architecture. The server will design, price, select a scenario, and mint the share link.";
  }

  if (toolName === "create_calculator_link") {
    if (
      /scenario is not calculator-eligible/i.test(errorMessage) ||
      /cannot mint an official calculator link/i.test(errorMessage)
    ) {
      return "Pass a calculator-eligible priced scenario from price_architecture, remove modeled/unavailable services from scope, or use generate_calculator_link for a one-shot flow.";
    }

    return "Pass the priced scenario returned by price_architecture and confirm it includes a non-null linkPlan, or use generate_calculator_link instead.";
  }

  if (toolName === "validate_calculator_link") {
    return "Pass a calculator.aws share link or estimate id returned by AWS Pricing Calculator.";
  }

  return null;
}

function formatToolError(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`Tool '${toolName}' failed.`, message];
  const hint = toolHint(toolName, message);

  if (hint) {
    lines.push("", `Hint: ${hint}`);
  }

  return lines.join("\n");
}

function inferToolErrorCode(errorMessage) {
  if (
    /Expected a calculator share link or estimate id/i.test(errorMessage) ||
    /Unable to extract an estimate id/i.test(errorMessage) ||
    /targetMonthlyUsd is too low/i.test(errorMessage)
  ) {
    return "invalid_input";
  }

  if (/not found/i.test(errorMessage) || /Unknown /i.test(errorMessage)) {
    return "not_found";
  }

  if (
    /calculator-eligible/i.test(errorMessage) ||
    /cannot mint an official calculator link/i.test(errorMessage)
  ) {
    return "not_calculator_eligible";
  }

  if (/region/i.test(errorMessage) && /not available|unsupported/i.test(errorMessage)) {
    return "unsupported_region";
  }

  if (/unsupported/i.test(errorMessage) || /missing a buildEntry implementation/i.test(errorMessage)) {
    return "unsupported_service_combination";
  }

  if (/validation/i.test(errorMessage)) {
    return "validation_failed";
  }

  if (/AWS|calculator|save response|fetch/i.test(errorMessage)) {
    return "upstream_aws_error";
  }

  return "internal_error";
}

function errorToolResponse(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = toolHint(toolName, message);
  const structuredContent = normalizeToolError({
    contractVersion: "v1",
    tool: toolName,
    code: inferToolErrorCode(message),
    message,
    hint,
    details: [],
  });

  return {
    content: [{ type: "text", text: formatToolError(toolName, error) }],
    structuredContent,
    isError: true,
  };
}

function withToolErrorHandling(toolName, handler) {
  return async (args) => {
    try {
      const result = await handler(args);

      if (!result || !Array.isArray(result.content)) {
        return errorToolResponse(toolName, "Tool returned no response payload.");
      }

      return result;
    } catch (error) {
      return errorToolResponse(toolName, error);
    }
  };
}

function renderChecks(checks) {
  const visibleChecks = checks.filter((check) => check.status !== "pass");

  if (visibleChecks.length === 0) {
    return "- none";
  }

  return visibleChecks
    .map((check) => {
      const statusLabel = check.status === "fail" ? "FAIL" : "WARN";
      return `- ${statusLabel} [${check.pack}] ${check.id}: ${check.details}`;
    })
    .join("\n");
}

function renderValidationSections(validation) {
  const structuralChecks = validation.checks.filter((check) => STRUCTURAL_PACKS.has(check.pack));
  const policyChecks = validation.checks.filter((check) => POLICY_PACKS.has(check.pack));

  return [
    `Structural validation: ${validation.blockingFailures.length === 0 ? "passed" : "failed"}`,
    renderChecks(structuralChecks),
    "",
    `Policy guidance: ${validation.warningRules.length === 0 ? "none" : `${validation.warningRules.length} warning(s)`}`,
    renderChecks(policyChecks),
  ].join("\n");
}

function renderArchitecture(architecture) {
  return [
    architecture.blueprintTitle,
    `Architecture family: ${architecture.architectureFamily}/${architecture.architectureSubtype}`,
    `Ready to price: ${architecture.readyToPrice ? "yes" : "no"}`,
    `Confidence: ${architecture.confidence.level} (${architecture.confidence.score}/100)`,
    `Region: ${architecture.region}`,
    `Region mode: ${architecture.regionMode}`,
    `Service selection: ${architecture.serviceSelectionMode}`,
    `Target monthly: ${
      architecture.targetMonthlyUsd == null
        ? "not resolved"
        : `${architecture.targetMonthlyUsd.toFixed(2)} USD`
    }`,
    `Budget fit: ${architecture.budgetFit.status}`,
    `Packs: ${architecture.packIds.join(", ") || "none"}`,
    architecture.alternativeArchitectureIds.length > 0
      ? `Alternates: ${architecture.alternativeArchitectureIds.join(", ")}`
      : "Alternates: none",
    "",
    "Selected services:",
    architecture.selectedServices
      .map(
        (service) =>
          `- ${service.serviceName} [${service.role}] (${service.capability.support}, ${service.capability.region})`,
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
        `Budget fit: ${scenario.budgetFit.status}`,
        `Policy: ${scenario.scenarioPolicy.computeCommitment}, ${scenario.scenarioPolicy.haPosture}, ${scenario.scenarioPolicy.environmentSizing}`,
        `Drivers: ${(scenario.deltaDrivers ?? []).join("; ")}`,
        `Calculator eligible: ${scenario.calculatorEligible ? "yes" : "no"}`,
        (scenario.calculatorBlockers?.length ?? 0) > 0
          ? scenario.calculatorBlockers.map((value) => `- ${value}`).join("\n")
          : "- no calculator blockers",
      ].join("\n"),
    ),
  ].join("\n\n");
}

function renderGeneratedEstimate(result) {
  return [
    result.shareLink,
    "Link created successfully.",
    `Blueprint: ${result.blueprintId}`,
    `Target monthly: ${result.targetMonthlyUsd.toFixed(2)} USD`,
    `Modeled monthly: ${result.modeledMonthlyUsd.toFixed(2)} USD`,
    `Stored monthly: ${result.storedMonthlyUsd.toFixed(2)} USD`,
    `Validation: ${result.validation.passed ? "passed" : "needs review"}`,
    `Structural blockers: ${result.validation.blockingFailures.length}`,
    `Policy warnings: ${result.validation.warningRules.length}`,
    "",
    renderValidationSections(result.validation),
  ].join("\n");
}

function renderGeneratedCalculatorLink(result) {
  return [
    result.estimate.shareLink,
    "Link created successfully.",
    `Blueprint: ${result.architecture.blueprintTitle}`,
    `Pattern: ${result.architecture.patternTitle}`,
    `Selected scenario: ${result.selectedScenario.title}`,
    `Target monthly: ${result.estimate.targetMonthlyUsd.toFixed(2)} USD`,
    `Modeled monthly: ${result.selectedScenario.modeledMonthlyUsd.toFixed(2)} USD`,
    `Stored monthly: ${result.estimate.storedMonthlyUsd.toFixed(2)} USD`,
    `Validation: ${result.estimate.validation.passed ? "passed" : "needs review"}`,
    `Structural blockers: ${result.estimate.validation.blockingFailures.length}`,
    `Policy warnings: ${result.estimate.validation.warningRules.length}`,
    "",
    renderValidationSections(result.estimate.validation),
  ].join("\n");
}

function renderValidatedEstimate(result) {
  return [
    result.shareLink,
    `Estimate: ${result.estimateName}`,
    `Monthly total: ${result.totalMonthlyUsd.toFixed(2)} USD`,
    `Validation: ${result.validation.passed ? "passed" : "needs review"}`,
    `Structural blockers: ${result.validation.blockingFailures.length}`,
    `Policy warnings: ${result.validation.warningRules.length}`,
    "",
    renderValidationSections(result.validation),
  ].join("\n");
}

function validateBuiltEstimate({ estimate, linkPlan, expectedMonthlyUsd, estimateNotes }) {
  return validateEstimatePayload({
    estimate,
    blueprintId: linkPlan.blueprintId,
    patternId: linkPlan.patternId,
    templateId: linkPlan.templateId,
    expectedMonthlyUsd,
    expectedRegion: linkPlan.region,
    expectedRegionMode: "single-region",
    validationMode: "intent-aware",
    contextSource: "link-plan",
    userAuthoredText: estimateNotes,
  });
}

function validateFetchedEstimate({
  estimate,
  blueprintId,
  patternId,
  expectedMonthlyUsd,
  expectedRegion,
  expectedRegionMode,
  validationMode,
  budgetTolerancePct,
}) {
  return validateEstimatePayload({
    estimate,
    blueprintId,
    patternId,
    templateId: blueprintId ? getBlueprint(blueprintId).templateId : undefined,
    expectedMonthlyUsd,
    expectedRegion,
    expectedRegionMode,
    validationMode,
    contextSource: blueprintId || patternId ? "explicit" : undefined,
    budgetTolerancePct,
  });
}

function summarizeGeneratedScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    modeledMonthlyUsd: scenario.modeledMonthlyUsd,
    calculatorEligible: scenario.calculatorEligible,
    calculatorBlockers: scenario.calculatorBlockers ?? [],
    budgetFit: scenario.budgetFit,
    strategySummary: scenario.strategySummary,
  };
}

function selectScenarioForCalculatorLink(priced, scenarioId) {
  const scenarios = priced?.scenarios ?? [];

  if (scenarios.length === 0) {
    throw new Error("Unable to create estimate: no priced scenarios were produced.");
  }

  if (scenarioId) {
    const selected = scenarios.find((scenario) => scenario.id === scenarioId);

    if (!selected) {
      throw new Error(
        `Scenario '${scenarioId}' was not found. Available scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}.`,
      );
    }

    if (!selected.calculatorEligible || !selected.linkPlan) {
      throw new Error(
        `Scenario '${scenarioId}' is not calculator-eligible. ${selected.calculatorBlockers?.join(" ") || "No exact link plan was produced."}`,
      );
    }

    return selected;
  }

  const eligibleScenarios = scenarios.filter(
    (scenario) => scenario.calculatorEligible && scenario.linkPlan,
  );

  if (eligibleScenarios.length === 0) {
    throw new Error(
      `Unable to create estimate: no calculator-eligible scenarios were produced. ${scenarios
        .flatMap((scenario) => scenario.calculatorBlockers ?? [])
        .join(" ")}`.trim(),
    );
  }

  const recommendedScenario = eligibleScenarios.find(
    (scenario) => scenario.id === priced.recommendedScenarioId,
  );

  if (recommendedScenario) {
    return recommendedScenario;
  }

  return [...eligibleScenarios].sort(
    (left, right) =>
      Math.abs(left.modeledMonthlyUsd - left.targetMonthlyUsd) -
      Math.abs(right.modeledMonthlyUsd - right.targetMonthlyUsd),
  )[0];
}

async function buildGeneratedEstimateResult(pricedScenario) {
  const built = buildCalculatorEstimateFromScenario({ pricedScenario });
  const saved = await saveEstimate(built.estimate);
  const fetched = await fetchSavedEstimate(saved.savedKey);
  const validation = validateBuiltEstimate({
    estimate: fetched.estimate,
    linkPlan: built.linkPlan,
    expectedMonthlyUsd: built.linkPlan.targetMonthlyUsd,
    estimateNotes: built.linkPlan.notes,
  });

  return {
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
        service.capability ?? getServiceRegionCapability(service.serviceId, service.region),
    })),
    validation,
  };
}

export function createServer() {
  const server = new McpServer({
    name: "aws-pricing-calculator-mcp",
    version: "4.0.0",
  });

  server.registerTool(
    "list_blueprints",
    {
      description: TOOL_CONTRACTS.list_blueprints.description,
      outputSchema: TOOL_CONTRACTS.list_blueprints.outputSchema,
    },
    withToolErrorHandling("list_blueprints", async () => {
      const blueprints = listBlueprintCatalog();
      return successToolResponse(
        "list_blueprints",
        blueprints.map((blueprint) => `${blueprint.id}: ${blueprint.description}`).join("\n"),
        { blueprints },
      );
    }),
  );

  server.registerTool(
    "list_service_catalog",
    {
      description: TOOL_CONTRACTS.list_service_catalog.description,
      outputSchema: TOOL_CONTRACTS.list_service_catalog.outputSchema,
    },
    withToolErrorHandling("list_service_catalog", async () => {
      const services = listServiceCatalog();
      return successToolResponse(
        "list_service_catalog",
        services
          .map((service) => `${service.id}: ${service.name} (${service.implementationStatus})`)
          .join("\n"),
        { services },
      );
    }),
  );

  server.registerTool(
    "design_architecture",
    {
      description: TOOL_CONTRACTS.design_architecture.description,
      inputSchema: TOOL_CONTRACTS.design_architecture.inputSchema,
      outputSchema: TOOL_CONTRACTS.design_architecture.outputSchema,
    },
    withToolErrorHandling("design_architecture", async (args) => {
      const architecture = designArchitecture(args);
      return successToolResponse(
        "design_architecture",
        renderArchitecture(architecture),
        architecture,
      );
    }),
  );

  server.registerTool(
    "price_architecture",
    {
      description: TOOL_CONTRACTS.price_architecture.description,
      inputSchema: TOOL_CONTRACTS.price_architecture.inputSchema,
      outputSchema: TOOL_CONTRACTS.price_architecture.outputSchema,
    },
    withToolErrorHandling("price_architecture", async (args) => {
      const priced = priceArchitecture(args);
      return successToolResponse("price_architecture", renderPricedArchitecture(priced), priced);
    }),
  );

  server.registerTool(
    "generate_calculator_link",
    {
      description: TOOL_CONTRACTS.generate_calculator_link.description,
      inputSchema: TOOL_CONTRACTS.generate_calculator_link.inputSchema,
      outputSchema: TOOL_CONTRACTS.generate_calculator_link.outputSchema,
    },
    withToolErrorHandling("generate_calculator_link", async ({ scenarioId, ...args }) => {
      const priced = priceArchitecture(args);
      const selectedScenario = selectScenarioForCalculatorLink(priced, scenarioId);
      const estimate = await buildGeneratedEstimateResult(selectedScenario);
      const result = {
        architecture: {
          architectureId: priced.architecture.architectureId,
          blueprintId: priced.architecture.blueprintId,
          blueprintTitle: priced.architecture.blueprintTitle,
          patternId: priced.architecture.patternId,
          patternTitle: priced.architecture.patternTitle,
          region: priced.architecture.region,
          estimateName: priced.architecture.estimateName,
          targetMonthlyUsd: priced.architecture.targetMonthlyUsd,
          serviceSelectionMode: priced.architecture.serviceSelectionMode,
          selectedServiceIds: priced.architecture.selectedServices.map((service) => service.serviceId),
        },
        selectedScenario: summarizeGeneratedScenario(selectedScenario),
        recommendedScenarioId: priced.recommendedScenarioId,
        availableScenarios: priced.scenarios.map(summarizeGeneratedScenario),
        estimate,
      };

      return successToolResponse(
        "generate_calculator_link",
        renderGeneratedCalculatorLink(result),
        result,
      );
    }),
  );

  server.registerTool(
    "create_calculator_link",
    {
      description: TOOL_CONTRACTS.create_calculator_link.description,
      inputSchema: TOOL_CONTRACTS.create_calculator_link.inputSchema,
      outputSchema: TOOL_CONTRACTS.create_calculator_link.outputSchema,
    },
    withToolErrorHandling("create_calculator_link", async ({ pricedScenario }) => {
      const result = await buildGeneratedEstimateResult(pricedScenario);

      return successToolResponse(
        "create_calculator_link",
        renderGeneratedEstimate(result),
        result,
      );
    }),
  );

  server.registerTool(
    "validate_calculator_link",
    {
      description: TOOL_CONTRACTS.validate_calculator_link.description,
      inputSchema: TOOL_CONTRACTS.validate_calculator_link.inputSchema,
      outputSchema: TOOL_CONTRACTS.validate_calculator_link.outputSchema,
    },
    withToolErrorHandling("validate_calculator_link", async ({
      shareLinkOrEstimateId,
      blueprintId,
      patternId,
      expectedMonthlyUsd,
      expectedRegion,
      expectedRegionMode,
      validationMode,
      budgetTolerancePct,
    }) => {
      const fetched = await fetchSavedEstimate(shareLinkOrEstimateId);
      const validation = validateFetchedEstimate({
        estimate: fetched.estimate,
        blueprintId,
        patternId,
        expectedMonthlyUsd,
        expectedRegion,
        expectedRegionMode,
        validationMode,
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

      return successToolResponse(
        "validate_calculator_link",
        renderValidatedEstimate(result),
        result,
      );
    }),
  );

  return server;
}
