import { executeChatbotTool, listChatbotToolDeclarations } from "./tools.js";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_TOOL_CYCLES = 2;
const BASE_SYSTEM_PROMPT = [
  "You are an AWS pricing calculator assistant.",
  "Use generate_calculator_link when the user wants an AWS Pricing Calculator estimate created, saved, or shared.",
  "Interpret 'container migration', 'kubernetes migration', 'EKS migration', or 'ECS migration' as a strong hint for blueprintId='container-platform' unless the user says it is AWS-to-AWS only.",
  "In AWS pricing contexts, interpret phrases like '$25k MRR', '$25k/mo', '$25k per month', or '25k monthly' as a likely targetMonthlyUsd monthly AWS spend unless the user clearly means business revenue instead.",
  "Treat tool results as the source of truth and do not invent calculator links or pricing.",
  "If required inputs are missing, ask only for the minimum facts needed to continue.",
  "When a calculator link is available, include it verbatim in the reply.",
  "Keep answers concise and practical.",
];

function normalizeModel(model) {
  const trimmed = String(model ?? "").trim();
  return trimmed.startsWith("models/") ? trimmed : `models/${trimmed || DEFAULT_GEMINI_MODEL}`;
}

function collectText(parts = []) {
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractFunctionCalls(parts = []) {
  return parts
    .filter((part) => part?.functionCall)
    .map((part) => part.functionCall)
    .filter((call) => call?.name);
}

function buildContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text }],
  }));
}

function latestUserText(contents = []) {
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];

    if (content?.role !== "user") {
      continue;
    }

    const text = collectText(content.parts);

    if (text) {
      return text;
    }
  }

  return "";
}

function parseMonthlyUsd(text) {
  const match = String(text ?? "").match(
    /\$?\s*(\d+(?:[.,]\d+)?)\s*(k)?\s*(mrr|monthly|month|\/mo|per month)\b/i,
  );

  if (!match) {
    return null;
  }

  const numeric = Number(match[1].replace(/,/g, ""));

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return match[2] ? numeric * 1000 : numeric;
}

function inferSystemHints(contents) {
  const text = latestUserText(contents);
  const normalized = text.toLowerCase();
  const hints = [];
  const monthlyUsd = parseMonthlyUsd(text);

  if (!text) {
    return hints;
  }

  if (
    normalized.includes("container migration") ||
    normalized.includes("kubernetes migration") ||
    normalized.includes("k8s migration") ||
    normalized.includes("eks migration") ||
    normalized.includes("ecs migration")
  ) {
    hints.push(
      "Latest user hint: this looks like a container migration. Prefer blueprintId='container-platform' unless contradicted.",
    );
  }

  if (monthlyUsd != null && /(calculator|estimate|migration|aws)/i.test(normalized)) {
    hints.push(`Latest user hint: interpret the monthly AWS spend target as ${monthlyUsd} USD.`);
  }

  return hints;
}

function buildSystemPrompt(contents) {
  return [...BASE_SYSTEM_PROMPT, ...inferSystemHints(contents)].join(" ");
}

async function callGemini({
  apiKey,
  model,
  contents,
  toolDeclarations,
  signal,
}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${normalizeModel(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      signal,
      body: JSON.stringify({
        systemInstruction: {
          role: "system",
          parts: [{ text: buildSystemPrompt(contents) }],
        },
        contents,
        tools: [
          {
            functionDeclarations: toolDeclarations,
          },
        ],
        generationConfig: {
          temperature: 0.3,
        },
      }),
    },
  );

  if (!response.ok) {
    const failureBody = (await response.text()).slice(0, 500);
    throw new Error(
      `Gemini API request failed (${response.status} ${response.statusText}): ${failureBody}`,
    );
  }

  return response.json();
}

export async function runGeminiConversation({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  contents,
  executeTool = executeChatbotTool,
  maxToolCycles = DEFAULT_MAX_TOOL_CYCLES,
}) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error("Pass at least one Gemini content item.");
  }

  const toolDeclarations = listChatbotToolDeclarations();
  const workingContents = [...contents];
  const appendedContents = [];
  const toolEvents = [];

  for (let cycle = 0; cycle <= maxToolCycles; cycle += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;

    try {
      response = await callGemini({
        apiKey,
        model,
        contents: workingContents,
        toolDeclarations,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const candidate = response?.candidates?.[0];
    const modelContent = candidate?.content;

    if (!modelContent?.parts?.length) {
      const reason =
        response?.promptFeedback?.blockReason ||
        candidate?.finishReason ||
        "no candidate content";
      throw new Error(`Gemini could not produce a reply: ${reason}.`);
    }

    workingContents.push(modelContent);
    appendedContents.push(modelContent);

    const functionCalls = extractFunctionCalls(modelContent.parts);
    const replyText = collectText(modelContent.parts);

    if (functionCalls.length === 0) {
      return {
        reply: replyText || "No response returned from Gemini.",
        toolEvents,
        appendedContents,
        finalModelContent: modelContent,
      };
    }

    if (cycle === maxToolCycles) {
      throw new Error("Gemini exceeded the maximum tool cycle count.");
    }

    const toolResponseParts = await Promise.all(
      functionCalls.map(async (call) => {
        const toolResult = await executeTool(call.name, call.args ?? {});
        const modelToolResult = {
          ok: toolResult.ok,
          tool: toolResult.tool,
          summary: toolResult.summary ?? toolResult.error?.message ?? null,
        };
        toolEvents.push({
          name: call.name,
          ok: toolResult.ok,
          summary: toolResult.summary ?? toolResult.error?.message ?? null,
          result: toolResult,
        });

        return {
          functionResponse: {
            name: call.name,
            id: call.id,
            response: {
              result: modelToolResult,
            },
          },
        };
      }),
    );

    const functionResponseContent = {
      role: "user",
      parts: toolResponseParts,
    };

    workingContents.push(functionResponseContent);
    appendedContents.push(functionResponseContent);
  }

  throw new Error("Gemini exceeded the maximum tool cycle count.");
}

export async function runGeminiChatTurn({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  messages,
  executeTool = executeChatbotTool,
  maxToolCycles = DEFAULT_MAX_TOOL_CYCLES,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Pass at least one chat message.");
  }

  const result = await runGeminiConversation({
    apiKey,
    model,
    contents: buildContents(messages),
    executeTool,
    maxToolCycles,
  });

  return {
    reply: result.reply,
    toolEvents: result.toolEvents.map((event) => ({
      name: event.name,
      ok: event.ok,
      summary: event.summary,
    })),
  };
}

export { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_TOOL_CYCLES };
