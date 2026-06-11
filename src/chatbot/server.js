import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_GEMINI_MODEL, runGeminiChatTurn } from "./gemini.js";

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;

const PAGE_HTML = await readFile(new URL("./index.html", import.meta.url), "utf8");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Pass a non-empty messages array.");
  }

  return messages.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw new Error("Each message must have role 'user' or 'assistant'.");
    }

    if (typeof message.text !== "string" || message.text.trim().length === 0) {
      throw new Error("Each message must have a non-empty text string.");
    }

    return {
      role: message.role,
      text: message.text.trim(),
    };
  });
}

async function handleChat(request, response) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 500, {
      error: "GEMINI_API_KEY is not configured.",
    });
    return;
  }

  const body = await readJsonBody(request);
  const messages = normalizeMessages(body.messages);
  const result = await runGeminiChatTurn({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    messages,
  });

  sendJson(response, 200, result);
}

export function startChatbotServer({
  host = "0.0.0.0",
  port = Number(process.env.PORT ?? DEFAULT_PORT),
} = {}) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        sendHtml(response, PAGE_HTML);
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, {
          ok: true,
          model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
          geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/chat") {
        await handleChat(request, response);
        return;
      }

      sendJson(response, 404, {
        error: "Not found.",
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, host, () => {
    console.log(
      `gemini-tool-chatbot listening on http://${host}:${port} using ${process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL}`,
    );
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startChatbotServer();
}
