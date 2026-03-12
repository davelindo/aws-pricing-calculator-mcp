import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";

test("worker health endpoint responds with service status", async () => {
  const response = await worker.fetch(new Request("https://example.com/health"), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "aws-pricing-calculator-mcp");
});

test("worker root endpoint advertises the mcp endpoint", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.endpoint, "/mcp");
  assert.equal(body.health, "/health");
  assert.equal(body.transport, "streamable-http");
});

test("worker mcp endpoint is open by default", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    {},
  );

  assert.notEqual(response.status, 401);
});

test("worker enforces bearer auth on the MCP endpoint when configured", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    {
      MCP_BEARER_TOKEN: "top-secret-token",
    },
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
});

test("worker keeps root and health public when bearer auth is configured", async () => {
  const [rootResponse, healthResponse] = await Promise.all([
    worker.fetch(new Request("https://example.com/"), {
      MCP_BEARER_TOKEN: "top-secret-token",
    }),
    worker.fetch(new Request("https://example.com/health"), {
      MCP_BEARER_TOKEN: "top-secret-token",
    }),
  ]);

  assert.equal(rootResponse.status, 200);
  assert.equal(healthResponse.status, 200);
});

test("worker accepts authorized MCP requests when bearer auth is configured", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    {
      MCP_BEARER_TOKEN: "top-secret-token",
    },
  );

  assert.notEqual(response.status, 401);
});

test("worker handles CORS preflight for the MCP endpoint", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example.com",
      },
    }),
    {
      MCP_ALLOWED_ORIGINS: "https://client.example.com",
    },
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://client.example.com",
  );
  assert.match(
    response.headers.get("Access-Control-Allow-Headers") ?? "",
    /Content-Type/,
  );
  assert.match(
    response.headers.get("Access-Control-Allow-Headers") ?? "",
    /Authorization/,
  );
});
