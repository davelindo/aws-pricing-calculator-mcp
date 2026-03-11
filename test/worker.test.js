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
});
