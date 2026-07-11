import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  V2_CONTRACT_VERSION,
  V2_TOOL_NAMES,
  getV2ToolContract,
  normalizeV2ToolError,
  normalizeV2ToolOutput,
} from "./contract/v2.js";
import {
  UniversalRuntimeError,
  generateUniversalCalculatorLinkAsync,
  interpretArchitectureAsync,
  listUniversalServiceCatalogAsync,
  priceUniversalArchitectureAsync,
} from "./universal/runtime.js";

function successToolResponse(toolName, text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent: normalizeV2ToolOutput(toolName, structuredContent),
  };
}

function errorCode(error, message) {
  if (error instanceof UniversalRuntimeError) return error.code;
  if (error?.name === "ZodError") return "invalid_input";
  if (/not found/i.test(message)) return "not_found";
  if (/calculator.?eligible|exact universal line-item plan/i.test(message)) {
    return "not_calculator_eligible";
  }
  if (/save|fetch|calculator.*response|saved estimate/i.test(message)) {
    return "upstream_aws_error";
  }
  if (/unsupported|unavailable/i.test(message)) return "unsupported_component";
  return "internal_error";
}

function errorDetails(error) {
  if (error instanceof UniversalRuntimeError) return error.details;
  if (Array.isArray(error?.issues)) {
    return {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })),
    };
  }
  return null;
}

function errorToolResponse(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error, message);
  const retryable =
    error instanceof UniversalRuntimeError
      ? error.retryable
      : code === "upstream_aws_error";
  const structuredContent = normalizeV2ToolError({
    contractVersion: V2_CONTRACT_VERSION,
    tool: toolName,
    code,
    message,
    retryable,
    details: errorDetails(error),
  });

  return {
    content: [
      {
        type: "text",
        text: `Universal architecture tool '${toolName}' failed.\n${message}`,
      },
    ],
    structuredContent,
    isError: true,
  };
}

function withToolErrorHandling(toolName, handler) {
  return async (args = {}) => {
    try {
      return await handler(args);
    } catch (error) {
      return errorToolResponse(toolName, error);
    }
  };
}

function registerV2Tool(server, toolName, handler) {
  const contract = getV2ToolContract(toolName);

  server.registerTool(
    toolName,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
    },
    withToolErrorHandling(toolName, handler),
  );
}

function renderCatalog(result) {
  if (result.services.length === 0) return "No services matched the catalog query.";

  return result.services
    .map(
      (service) =>
        `${service.id}: ${service.name} (${service.pricingSupport}; ${
          service.regions.join(", ") || "no priced regions"
        })`,
    )
    .join("\n");
}

function renderArchitecture(architecture) {
  const resolvedCount = architecture.components.filter(
    (component) => component.resolution?.status === "resolved",
  ).length;
  const lines = [
    architecture.title ?? "Interpreted architecture",
    `Architecture: ${architecture.architectureId}`,
    `Components: ${architecture.components.length} (${resolvedCount} resolved)`,
    `Relationships: ${architecture.relationships.length}`,
    `Coverage: ${architecture.coverage.status} (${Math.round(architecture.coverage.score * 100)}%)`,
  ];

  if (architecture.coverage.gaps.length > 0) {
    lines.push("", "Coverage gaps:", ...architecture.coverage.gaps.map((gap) => `- ${gap}`));
  }

  if (architecture.questions.length > 0) {
    lines.push(
      "",
      "Follow-up questions:",
      ...architecture.questions.map((question) => `- ${question.prompt}`),
    );
  }

  return lines.join("\n");
}

function renderPricing(priced) {
  const lines = [
    priced.architecture.title ?? "Priced architecture",
    `Pricing result: ${priced.pricingId}`,
    `Recommended scenario: ${priced.recommendedScenarioId ?? "none"}`,
    "",
  ];

  for (const scenario of priced.scenarios) {
    lines.push(
      `${scenario.title} [${scenario.id}]: ${
        scenario.total.amount == null
          ? "not fully priced"
          : `${scenario.total.amount.toFixed(2)} ${scenario.total.currency}/${scenario.total.period}`
      }`,
      `Calculator eligible: ${scenario.eligibility.eligible ? "yes" : "no"}`,
    );

    for (const blocker of scenario.eligibility.blockers) {
      lines.push(`- ${blocker}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderCalculatorLink(result) {
  return [
    result.link.url,
    "AWS Pricing Calculator link created and verified.",
    `Scenario: ${result.selectedScenario.title} (${result.selectedScenario.id})`,
    `Monthly total: ${
      result.selectedScenario.total.amount == null
        ? "not reported"
        : `${result.selectedScenario.total.amount.toFixed(2)} ${result.selectedScenario.total.currency}`
    }`,
    `Components: ${result.selectedScenario.coverage.pricedComponentCount}/${result.selectedScenario.coverage.componentCount} priced`,
  ].join("\n");
}

export function createUniversalServer(runtimeOptions = {}) {
  const server = new McpServer({
    name: "aws-pricing-calculator-mcp",
    version: "4.0.0",
  });

  registerV2Tool(server, "list_service_catalog", async (args) => {
    const result = await listUniversalServiceCatalogAsync(args, runtimeOptions);
    return successToolResponse("list_service_catalog", renderCatalog(result), result);
  });

  registerV2Tool(server, "interpret_architecture", async (args) => {
    const result = await interpretArchitectureAsync(args, runtimeOptions);
    return successToolResponse("interpret_architecture", renderArchitecture(result), result);
  });

  registerV2Tool(server, "price_architecture", async (args) => {
    const result = await priceUniversalArchitectureAsync(args, runtimeOptions);
    return successToolResponse("price_architecture", renderPricing(result), result);
  });

  registerV2Tool(server, "generate_calculator_link", async (args) => {
    const result = await generateUniversalCalculatorLinkAsync(args, runtimeOptions);
    return successToolResponse(
      "generate_calculator_link",
      renderCalculatorLink(result),
      result,
    );
  });

  return server;
}

export function universalToolNames() {
  return [...V2_TOOL_NAMES];
}
