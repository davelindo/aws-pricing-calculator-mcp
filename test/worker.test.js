import test from "node:test";
import assert from "node:assert/strict";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker, { ChatCoordinator } from "../src/worker.js";

class MemoryKv {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value) {
    this.store.set(key, value);
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list({ prefix = "", cursor } = {}) {
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const pageSize = 1000;
    const slice = keys.slice(start, start + pageSize);

    return {
      keys: slice.map((name) => ({ name })),
      list_complete: start + pageSize >= keys.length,
      cursor: start + pageSize >= keys.length ? undefined : String(start + pageSize),
    };
  }
}

class MemoryChatCoordinatorNamespace {
  constructor(env) {
    this.env = env;
    this.names = [];
    this.instances = new Map();
  }

  idFromName(name) {
    this.names.push(name);
    return name;
  }

  get(id) {
    if (!this.instances.has(id)) {
      this.instances.set(id, new ChatCoordinator({}, this.env));
    }

    const instance = this.instances.get(id);
    return {
      fetch: (request) => instance.fetch(request),
    };
  }
}

function responseJson(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (input instanceof Request) {
    return input.url;
  }

  return String(input);
}

async function createAccessHarness() {
  const teamDomain = `team-${crypto.randomUUID()}.example.com`;
  const audience = `aud-${crypto.randomUUID()}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "worker-test-key";

  const sign = async (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
      .setIssuer(`https://${teamDomain}`)
      .setAudience(audience)
      .setSubject(email)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);

  return {
    teamDomain,
    audience,
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    jwks: { keys: [publicJwk] },
    sign,
  };
}

function buildEnv(overrides = {}) {
  const env = {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.example.com",
    CLOUDFLARE_ACCESS_AUD: "test-aud",
    MCP_ALLOWED_ORIGINS: "https://client.example.com",
    CHAT_STATE: new MemoryKv(),
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><html><body>worker chat</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "gemini-2.5-flash",
    ...overrides,
  };

  if (!Object.prototype.hasOwnProperty.call(overrides, "CHAT_COORDINATOR")) {
    env.CHAT_COORDINATOR = new MemoryChatCoordinatorNamespace(env);
  }

  return env;
}

function withAccessHeader(request, token) {
  const headers = new Headers(request.headers);
  headers.set("cf-access-jwt-assertion", token);
  return new Request(request, { headers });
}

test.afterEach(() => {
  delete globalThis.fetch;
});

test("worker root and health endpoints require Cloudflare Access and return authenticated metadata", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
  });
  const token = await access.sign("owner@example.com");

  globalThis.fetch = async (url) => {
    assert.equal(requestUrl(url), access.jwksUrl);
    return responseJson(access.jwks);
  };

  const unauthorized = await worker.fetch(new Request("https://example.com/"), env);
  assert.equal(unauthorized.status, 403);

  const [rootResponse, healthResponse] = await Promise.all([
    worker.fetch(withAccessHeader(new Request("https://example.com/"), token), env),
    worker.fetch(withAccessHeader(new Request("https://example.com/health"), token), env),
  ]);

  assert.equal(rootResponse.status, 200);
  assert.equal(healthResponse.status, 200);

  const rootBody = await rootResponse.json();
  const healthBody = await healthResponse.json();

  assert.equal(rootBody.auth, "cloudflare-access");
  assert.equal(rootBody.chat, "/chat");
  assert.equal(rootBody.user, "owner@example.com");
  assert.equal(healthBody.chatStateConfigured, true);
});

test("worker serves the chat asset for an authenticated user", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
  });
  const token = await access.sign("owner@example.com");

  globalThis.fetch = async () => responseJson(access.jwks);

  const response = await worker.fetch(
    withAccessHeader(new Request("https://example.com/chat"), token),
    env,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /worker chat/i);
});

test("worker does not loop when the asset layer canonicalizes /chat/index.html back to /chat/", async () => {
  const access = await createAccessHarness();
  const token = await access.sign("owner@example.com");
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
    ASSETS: {
      fetch: async (request) => {
        const url = new URL(requestUrl(request));

        if (url.pathname === "/chat/index.html") {
          return Response.redirect(new URL("/chat/", url), 307);
        }

        if (url.pathname === "/chat/") {
          return new Response("<!doctype html><html><body>worker chat</body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    },
  });

  globalThis.fetch = async () => responseJson(access.jwks);

  const chatSlash = await worker.fetch(
    withAccessHeader(new Request("https://example.com/chat/"), token),
    env,
  );
  assert.equal(chatSlash.status, 200);
  assert.match(chatSlash.headers.get("content-type") ?? "", /text\/html/);

  const chatIndex = await worker.fetch(
    withAccessHeader(new Request("https://example.com/chat/index.html"), token),
    env,
  );
  assert.equal(chatIndex.status, 308);
  assert.equal(chatIndex.headers.get("location"), "https://example.com/chat/");
});

test("worker keeps MCP behind Access and preserves CORS preflight handling", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
  });
  const token = await access.sign("owner@example.com");

  globalThis.fetch = async () => responseJson(access.jwks);

  const preflight = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://client.example.com" },
    }),
    env,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://client.example.com",
  );

  const unauthorized = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(unauthorized.status, 403);

  const authorized = await worker.fetch(
    withAccessHeader(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      token,
    ),
    env,
  );
  assert.notEqual(authorized.status, 403);
});

test("chat API supports explicit sharing and read plus fork permissions", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
  });
  const ownerToken = await access.sign("owner@example.com");
  const sharedToken = await access.sign("shared@example.com");

  globalThis.fetch = async () => responseJson(access.jwks);

  const created = await worker.fetch(
    withAccessHeader(
      new Request("https://example.com/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Migration Fund" }),
      }),
      ownerToken,
    ),
    env,
  );
  const createdBody = await created.json();
  const chatId = createdBody.chat.chatId;

  const shared = await worker.fetch(
    withAccessHeader(
      new Request(`https://example.com/api/chats/${chatId}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "shared@example.com" }),
      }),
      ownerToken,
    ),
    env,
  );
  const sharedBody = await shared.json();
  assert.deepEqual(sharedBody.aclEmails, ["shared@example.com"]);
  assert.equal(env.CHAT_COORDINATOR.names.includes(chatId), true);

  const readable = await worker.fetch(
    withAccessHeader(new Request(`https://example.com/api/chats/${chatId}`), sharedToken),
    env,
  );
  assert.equal(readable.status, 200);

  const blockedWrite = await worker.fetch(
    withAccessHeader(
      new Request(`https://example.com/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Continue this thread." }),
      }),
      sharedToken,
    ),
    env,
  );
  assert.equal(blockedWrite.status, 403);

  const forked = await worker.fetch(
    withAccessHeader(
      new Request(`https://example.com/api/chats/${chatId}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      sharedToken,
    ),
    env,
  );
  const forkedBody = await forked.json();
  assert.equal(forked.status, 200);
  assert.equal(forkedBody.chat.permission, "owner");
  assert.equal(forkedBody.chat.forkedFromChatId, chatId);
});

test("chat API can create a calculator-backed reply and persist the conversation", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
  });
  const token = await access.sign("owner@example.com");
  const estimateId = "89abcdef0123456789abcdef0123456789abcdef";
  let geminiCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const stringUrl = String(url);

    if (stringUrl === access.jwksUrl) {
      return responseJson(access.jwks);
    }

    if (stringUrl.includes("/saveAs")) {
      return responseJson({
        body: JSON.stringify({ savedKey: estimateId }),
      });
    }

    if (stringUrl.includes(estimateId)) {
      return responseJson({
        name: "Worker Estimate",
        totalCost: { monthly: 7001.12 },
        services: {},
      });
    }

    if (stringUrl.includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      const requestBody = JSON.parse(init.body);

      if (geminiCalls === 1) {
        assert.equal(requestBody.contents.at(-1).parts[0].text, "Create a $7k calculator.");
        return responseJson({
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
                        blueprintId: "container-platform",
                        region: "us-east-1",
                        targetMonthlyUsd: 7000,
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      return responseJson({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Here is the calculator link and validation summary.",
                },
              ],
            },
          },
        ],
      });
    }

    throw new Error(`Unexpected fetch url: ${stringUrl}`);
  };

  const response = await worker.fetch(
    withAccessHeader(
      new Request("https://example.com/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Create a $7k calculator." }),
      }),
      token,
    ),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.toolEvents[0].name, "generate_calculator_link");
  assert.match(body.reply, /calculator link/i);

  const loaded = await worker.fetch(
    withAccessHeader(new Request(`https://example.com/api/chats/${body.chat.chatId}`), token),
    env,
  );
  const loadedBody = await loaded.json();

  assert.equal(loaded.status, 200);
  assert.equal(loadedBody.messages.length, 2);
  assert.equal(loadedBody.messages[0].role, "user");
  assert.equal(loadedBody.messages[1].role, "assistant");
  assert.equal(loadedBody.messages[1].toolEvents[0].name, "generate_calculator_link");
});

test("chat API returns JSON when the chat model is not configured", async () => {
  const access = await createAccessHarness();
  const env = buildEnv({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: access.teamDomain,
    CLOUDFLARE_ACCESS_AUD: access.audience,
    GEMINI_API_KEY: "",
  });
  const token = await access.sign("owner@example.com");

  globalThis.fetch = async () => responseJson(access.jwks);

  const response = await worker.fetch(
    withAccessHeader(
      new Request("https://example.com/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Create a calculator." }),
      }),
      token,
    ),
    env,
  );

  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const body = await response.json();
  assert.equal(body.error, "Chat model is not configured.");
});
