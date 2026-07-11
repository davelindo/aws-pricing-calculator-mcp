import test from "node:test";
import assert from "node:assert/strict";

import { buildShareLink } from "../src/calculator-client.js";
import { runGeminiChatTurn } from "../src/chatbot/gemini.js";
import { executeChatbotTool, listChatbotToolDeclarations } from "../src/chatbot/tools.js";

const ESTIMATE_ID = "89abcdef0123456789abcdef0123456789abcdef";

test.afterEach(() => {
  delete globalThis.fetch;
});

function collectUnsupportedSchemaKeys(value, path = []) {
  const findings = [];

  if (!value || typeof value !== "object") {
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findings.push(...collectUnsupportedSchemaKeys(entry, [...path, String(index)]));
    });
    return findings;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (
      key === "$schema" ||
      key === "default" ||
      key === "additionalProperties" ||
      key === "exclusiveMinimum" ||
      key === "exclusiveMaximum"
    ) {
      findings.push([...path, key].join("."));
    }

    findings.push(...collectUnsupportedSchemaKeys(entry, [...path, key]));
  }

  return findings;
}

test("executeChatbotTool can create a calculator link through the shared runtime", async () => {
  let savedEstimate;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/saveAs")) {
      assert.equal(init.method, "POST");
      savedEstimate = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          body: JSON.stringify({
            savedKey: ESTIMATE_ID,
          }),
        }),
      };
    }

    if (String(url).includes(ESTIMATE_ID)) {
      return {
        ok: true,
        json: async () => savedEstimate,
      };
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  };

  const result = await executeChatbotTool(
    "generate_calculator_link",
    {
      definition: {
        Resources: {
          Assets: { Type: "AWS::S3::Bucket" },
          Distribution: { Type: "AWS::CloudFront::Distribution" },
        },
      },
      context: {
        name: "Chatbot Estimate",
        region: "us-east-1",
        targetMonthlyUsd: 120,
      },
    },
    { dynamicCatalog: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.result.link.url, buildShareLink(ESTIMATE_ID));
  assert.equal(result.result.selectedScenario.eligibility.eligible, true);
});

test("Gemini tool declarations strip unsupported JSON Schema keywords", () => {
  const declarations = listChatbotToolDeclarations();
  const unsupported = collectUnsupportedSchemaKeys(declarations);

  assert.deepEqual(unsupported, []);
  assert.deepEqual(
    declarations.map((declaration) => declaration.name),
    ["generate_calculator_link", "interpret_architecture"],
  );
  assert.equal(
    declarations[0].parameters.properties.context.properties.targetMonthlyUsd.minimum,
    0,
  );
});

test("runGeminiChatTurn executes function calls and returns the final reply", async () => {
  const requestBodies = [];

  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);

    if (requestBodies.length === 1) {
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call-1",
                      name: "generate_calculator_link",
                      args: {
                        definition: "Two S3 buckets behind CloudFront.",
                        context: {
                          region: "us-east-1",
                          targetMonthlyUsd: 7000,
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Here is the calculator link and summary.",
                },
              ],
            },
          },
        ],
      }),
    };
  };

  const result = await runGeminiChatTurn({
    apiKey: "test-key",
    messages: [
      {
        role: "user",
        text: "Create a $7k/month calculator.",
      },
    ],
    executeTool: async (name, args) => ({
      ok: true,
      tool: name,
      summary: "Tool completed.",
      result: {
        args,
        link: { url: "https://calculator.aws/#/estimate?id=fake" },
      },
    }),
  });

  assert.equal(result.reply, "Here is the calculator link and summary.");
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.toolEvents[0].name, "generate_calculator_link");
  assert.equal(requestBodies.length, 2);
  assert.equal(
    requestBodies[1].contents[2].parts[0].functionResponse.id,
    "call-1",
  );
});

test("runGeminiChatTurn injects the monthly target without changing the architecture", async () => {
  const requestBodies = [];

  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);

    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Need more details.",
                },
              ],
            },
          },
        ],
      }),
    };
  };

  await runGeminiChatTurn({
    apiKey: "test-key",
    messages: [
      {
        role: "user",
        text: "Create a $25k MRR container migration calculator.",
      },
    ],
  });

  const prompt = requestBodies[0].systemInstruction.parts[0].text;

  assert.match(prompt, /context\.targetMonthlyUsd=25000/i);
  assert.doesNotMatch(prompt, /prefer .* platform/i);
});
