import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const INFO_PATH = "/";
const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Last-Event-ID",
  "Mcp-Protocol-Version",
  "Mcp-Session-Id",
];
const CORS_EXPOSE_HEADERS = [
  "Mcp-Protocol-Version",
  "Mcp-Session-Id",
];

function csvValues(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function originHeader(request, env) {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigins = csvValues(env?.MCP_ALLOWED_ORIGINS);

  if (allowedOrigins.length === 0) {
    return requestOrigin ?? "*";
  }

  return requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : "null";
}

function withCorsHeaders(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", originHeader(request, env));
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
  headers.append("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function optionsResponse(request, env) {
  return withCorsHeaders(new Response(null, { status: 204 }), request, env);
}

function infoResponse(request, env) {
  return withCorsHeaders(
    jsonResponse({
      name: "aws-pricing-calculator-mcp",
      transport: "streamable-http",
      endpoint: MCP_PATH,
      health: HEALTH_PATH,
    }),
    request,
    env,
  );
}

function healthResponse(request, env) {
  return withCorsHeaders(
    jsonResponse({
      ok: true,
      service: "aws-pricing-calculator-mcp",
    }),
    request,
    env,
  );
}

async function handleMcpRequest(request, env) {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onclose = () => {
    void server.close();
  };

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    return withCorsHeaders(response, request, env);
  } catch (error) {
    void server.close();
    return withCorsHeaders(
      jsonResponse(
        {
          error: "Internal Server Error",
          details: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      request,
      env,
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse(request, env);
    }

    if (request.method === "GET" && url.pathname === INFO_PATH) {
      return infoResponse(request, env);
    }

    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      return healthResponse(request, env);
    }

    if (url.pathname === MCP_PATH) {
      return handleMcpRequest(request, env);
    }

    return withCorsHeaders(
      jsonResponse(
        {
          error: "Not Found",
          details: `No route for ${url.pathname}.`,
        },
        { status: 404 },
      ),
      request,
      env,
    );
  },
};
