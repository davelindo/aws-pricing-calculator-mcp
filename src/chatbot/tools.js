import * as z from "zod/v4";

import { V2_TOOL_CONTRACTS } from "../contract/v2.js";
import {
  generateUniversalCalculatorLinkAsync,
  interpretArchitectureAsync,
} from "../universal/runtime.js";

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "nullable",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "title",
]);

function normalizeGeminiType(type, schema) {
  if (Array.isArray(type)) {
    const nonNullTypes = type.filter((entry) => entry !== "null");

    if (nonNullTypes.length === 1) {
      return {
        type: nonNullTypes[0],
        nullable: type.length !== nonNullTypes.length || Boolean(schema?.nullable),
      };
    }
  }

  return {
    type,
    nullable: Boolean(schema?.nullable),
  };
}

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const normalized = {};
  const { type, nullable } = normalizeGeminiType(schema.type, schema);

  if (type) {
    normalized.type = type;
  }

  if (nullable) {
    normalized.nullable = true;
  }

  if (typeof schema.description === "string") {
    normalized.description = schema.description;
  }

  if (typeof schema.title === "string") {
    normalized.title = schema.title;
  }

  if (typeof schema.format === "string") {
    normalized.format = schema.format;
  }

  if (Array.isArray(schema.enum)) {
    normalized.enum = schema.enum;
  }

  const minimum = schema.exclusiveMinimum ?? schema.minimum;
  const maximum = schema.exclusiveMaximum ?? schema.maximum;

  if (typeof minimum === "number") {
    normalized.minimum = minimum;
  }

  if (typeof maximum === "number") {
    normalized.maximum = maximum;
  }

  if (typeof schema.minItems === "number") {
    normalized.minItems = schema.minItems;
  }

  if (typeof schema.maxItems === "number") {
    normalized.maxItems = schema.maxItems;
  }

  if (schema.items && typeof schema.items === "object") {
    normalized.items = sanitizeGeminiSchema(schema.items);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, sanitizeGeminiSchema(value)]),
    );
  }

  if (Array.isArray(schema.required) && normalized.properties) {
    normalized.required = schema.required.filter((key) =>
      Object.prototype.hasOwnProperty.call(normalized.properties, key),
    );
  }

  return Object.fromEntries(
    Object.entries(normalized).filter(([key, value]) => GEMINI_SCHEMA_KEYS.has(key) && value !== undefined),
  );
}

function toGeminiParameters(schema) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  return sanitizeGeminiSchema(jsonSchema);
}

function summarizeCalculatorLinkResult(result) {
  return [
    result.link.url,
    `Architecture: ${result.architecture.title ?? result.architecture.architectureId}`,
    `Monthly total: ${result.selectedScenario.total.amount?.toFixed(2) ?? "unknown"} USD`,
    `Components priced: ${result.coverage.pricedComponentCount}/${result.coverage.componentCount}`,
  ].join("\n");
}

function summarizeArchitectureResult(result) {
  return [
    `Architecture: ${result.title ?? result.architectureId}`,
    `Components: ${result.components.length}`,
    `Resolution: ${result.coverage.status}`,
    result.questions.length > 0
      ? `Questions: ${result.questions.map((question) => question.prompt).join(" | ")}`
      : "Questions: none",
  ].join("\n");
}

const CHATBOT_TOOLS = Object.freeze({
  generate_calculator_link: {
    description:
      `${V2_TOOL_CONTRACTS.generate_calculator_link.description} ` +
      "Pass the user's architecture as definition or sources. Use only when the user wants a saved link and has supplied enough pricing context.",
    inputSchema: V2_TOOL_CONTRACTS.generate_calculator_link.inputSchema,
    parameters: toGeminiParameters(V2_TOOL_CONTRACTS.generate_calculator_link.inputSchema),
    handler: generateUniversalCalculatorLinkAsync,
    summarize: summarizeCalculatorLinkResult,
  },
  interpret_architecture: {
    description:
      `${V2_TOOL_CONTRACTS.interpret_architecture.description} ` +
      "Use this for incomplete, mixed-format, or exploratory architecture definitions before attempting a calculator link.",
    inputSchema: V2_TOOL_CONTRACTS.interpret_architecture.inputSchema,
    parameters: toGeminiParameters(V2_TOOL_CONTRACTS.interpret_architecture.inputSchema),
    handler: interpretArchitectureAsync,
    summarize: summarizeArchitectureResult,
  },
});

function sanitizePublicCalculatorText(value, maxLength) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeCalculatorArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }

  const sanitized = { ...args };

  for (const key of ["estimateName", "clientName"]) {
    if (typeof sanitized[key] === "string") {
      sanitized[key] = sanitizePublicCalculatorText(sanitized[key], 80);
    }
  }

  if (typeof sanitized.notes === "string") {
    sanitized.notes = sanitizePublicCalculatorText(sanitized.notes, 500);
  }

  if (sanitized.context && typeof sanitized.context === "object") {
    sanitized.context = { ...sanitized.context };
    for (const key of ["name", "notes"]) {
      if (typeof sanitized.context[key] === "string") {
        sanitized.context[key] = sanitizePublicCalculatorText(
          sanitized.context[key],
          key === "notes" ? 500 : 80,
        );
      }
    }
  }

  return sanitized;
}

export function listChatbotToolDeclarations() {
  return Object.entries(CHATBOT_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export async function executeChatbotTool(name, args, runtimeOptions = {}) {
  const tool = CHATBOT_TOOLS[name];

  if (!tool) {
    return {
      ok: false,
      tool: name,
      error: {
        message: `Unknown tool '${name}'.`,
      },
    };
  }

  try {
    const preparedArgs = sanitizeCalculatorArgs(args ?? {});
    const parsedArgs = tool.inputSchema.parse(preparedArgs);
    const result = await tool.handler(parsedArgs, runtimeOptions);

    return {
      ok: true,
      tool: name,
      summary: tool.summarize(result),
      result,
    };
  } catch (error) {
    return {
      ok: false,
      tool: name,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
