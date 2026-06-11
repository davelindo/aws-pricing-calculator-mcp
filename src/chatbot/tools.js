import * as z from "zod/v4";

import { generateCalculatorLinkResult } from "../calculator-link-runtime.js";
import { TOOL_CONTRACTS } from "../contract/v1.js";

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
    result.estimate.shareLink,
    `Blueprint: ${result.architecture.blueprintTitle}`,
    `Target monthly: ${result.estimate.targetMonthlyUsd.toFixed(2)} USD`,
    `Modeled monthly: ${result.selectedScenario.modeledMonthlyUsd.toFixed(2)} USD`,
  ].join("\n");
}

const CHATBOT_TOOLS = Object.freeze({
  generate_calculator_link: {
    description:
      `${TOOL_CONTRACTS.generate_calculator_link.description} ` +
      "Use this when the user wants a saved AWS calculator link or asks to size a monthly AWS target.",
    inputSchema: TOOL_CONTRACTS.generate_calculator_link.inputSchema,
    parameters: toGeminiParameters(TOOL_CONTRACTS.generate_calculator_link.inputSchema),
    handler: generateCalculatorLinkResult,
    summarize: summarizeCalculatorLinkResult,
  },
});

export function listChatbotToolDeclarations() {
  return Object.entries(CHATBOT_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export async function executeChatbotTool(name, args) {
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
    const parsedArgs = tool.inputSchema.parse(args ?? {});
    const result = await tool.handler(parsedArgs);

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
