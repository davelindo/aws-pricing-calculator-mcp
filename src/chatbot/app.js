import { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_TOOL_CYCLES, runGeminiConversation } from "./gemini.js";
import {
  appendChatTurns,
  buildTurnRecord,
  createChat,
  forkChat,
  getChatForUser,
  listAclEmails,
  listChatsForUser,
  listChatTurns,
  listReplayContents,
  sanitizeToolEvents,
  shareChat,
  unshareChat,
  visibleMessagesFromTurns,
} from "./store.js";

const CHAT_PATH = "/chat";
const CHAT_INDEX_PATH = "/chat/index.html";

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

async function readJsonBody(request) {
  const bodyText = await request.text();

  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requireGeminiApiKey(env) {
  const apiKey = String(env?.GEMINI_API_KEY ?? "").trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  return apiKey;
}

function maxToolCycles(env) {
  const value = Number(env?.CHAT_MAX_TOOL_CYCLES ?? DEFAULT_MAX_TOOL_CYCLES);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 4) : DEFAULT_MAX_TOOL_CYCLES;
}

function normalizeUserText(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error("A non-empty text value is required.");
  }

  return text;
}

function normalizeChatId(value) {
  const chatId = String(value ?? "").trim();

  if (!chatId) {
    throw new Error("A chat id is required.");
  }

  return chatId;
}

function deriveToolStateHints(toolEvents = []) {
  const hints = {};

  for (const event of toolEvents) {
    const payload = event?.result;

    if (!payload?.ok) {
      continue;
    }

    if (event.name === "generate_calculator_link") {
      const shareLink = payload.result?.estimate?.shareLink;

      if (shareLink) {
        hints.lastCalculatorShareLink = shareLink;
      }
    }

  }

  return hints;
}

function buildVisibleAssistantTurn(content, toolEvents) {
  return buildTurnRecord({
    content,
    visible: true,
    viewRole: "assistant",
    text: content?.parts?.map((part) => part?.text ?? "").filter(Boolean).join("\n").trim(),
    toolEvents: sanitizeToolEvents(toolEvents),
  });
}

async function runStoredChatTurn({
  env,
  userEmail,
  chatId,
  text,
}) {
  const access = await getChatForUser({ env, chatId, userEmail });

  if (!access) {
    return jsonResponse({ error: "Chat not found." }, { status: 404 });
  }

  if (access.permission !== "owner") {
    return jsonResponse(
      { error: "Only the owner can continue this chat. Shared users can fork it." },
      { status: 403 },
    );
  }

  const priorContents = await listReplayContents({ env, chatId });
  const userContent = {
    role: "user",
    parts: [{ text }],
  };
  const result = await runGeminiConversation({
    apiKey: requireGeminiApiKey(env),
    model: env?.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    contents: [...priorContents, userContent],
    maxToolCycles: maxToolCycles(env),
  });

  const turns = [
    buildTurnRecord({
      content: userContent,
      visible: true,
      viewRole: "user",
      text,
    }),
  ];

  for (const content of result.appendedContents) {
    const hasFunctionCalls = content.role === "model" && content.parts?.some((part) => part?.functionCall);
    const hasFunctionResponses =
      content.role === "user" && content.parts?.some((part) => part?.functionResponse);

    if (hasFunctionCalls || hasFunctionResponses) {
      turns.push(
        buildTurnRecord({
          content,
          visible: false,
        }),
      );
      continue;
    }

    turns.push(buildVisibleAssistantTurn(content, result.toolEvents));
  }

  const nextTitle =
    access.meta.title === "Untitled chat" && (access.meta.contentCount ?? 0) === 0
      ? text
      : access.meta.title;
  const nextMeta = await appendChatTurns({
    env,
    chatId,
    meta: access.meta,
    turns,
    title: nextTitle,
    toolStateHints: deriveToolStateHints(result.toolEvents),
  });

  return jsonResponse({
    chat: {
      chatId: nextMeta.chatId,
      title: nextMeta.title,
      ownerEmail: nextMeta.ownerEmail,
      updatedAt: nextMeta.updatedAt,
      lastMessageAt: nextMeta.lastMessageAt,
      permission: "owner",
      forkedFromChatId: nextMeta.forkedFromChatId ?? null,
    },
    reply: result.reply,
    toolEvents: sanitizeToolEvents(result.toolEvents),
  });
}

function chatPayload(meta, permission) {
  return {
    chatId: meta.chatId,
    title: meta.title,
    ownerEmail: meta.ownerEmail,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.lastMessageAt,
    permission,
    forkedFromChatId: meta.forkedFromChatId ?? null,
  };
}

async function serveChatAsset(request, env) {
  if (!env?.ASSETS?.fetch) {
    throw new Error("ASSETS binding is required to serve /chat.");
  }

  const url = new URL(request.url);

  if (url.pathname === CHAT_INDEX_PATH) {
    return Response.redirect(new URL(`${CHAT_PATH}/`, request.url), 308);
  }

  if (url.pathname === CHAT_PATH) {
    return env.ASSETS.fetch(
      new Request(new URL(`${CHAT_PATH}/`, request.url), request),
    );
  }

  return env.ASSETS.fetch(request);
}

export async function handleChatAppRequest(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean);

  if (request.method === "GET" && (path === CHAT_PATH || path === `${CHAT_PATH}/` || path === CHAT_INDEX_PATH)) {
    return serveChatAsset(request, env);
  }

  if (request.method === "GET" && path === "/api/me") {
    return jsonResponse({
      email: user.email,
      subject: user.subject,
    });
  }

  if (request.method === "GET" && path === "/api/chats") {
    return jsonResponse(await listChatsForUser({ env, userEmail: user.email }));
  }

  if (request.method === "POST" && path === "/api/chats") {
    const body = await readJsonBody(request);
    const meta = await createChat({
      env,
      ownerEmail: user.email,
      title: body.title,
    });

    if (String(body.text ?? "").trim()) {
      return runStoredChatTurn({
        env,
        userEmail: user.email,
        chatId: meta.chatId,
        text: normalizeUserText(body.text),
      });
    }

    return jsonResponse({
      chat: chatPayload(meta, "owner"),
    });
  }

  if (segments[0] === "api" && segments[1] === "chats" && segments.length >= 3) {
    const chatId = normalizeChatId(segments[2]);

    if (request.method === "GET" && segments.length === 3) {
      const access = await getChatForUser({ env, chatId, userEmail: user.email });

      if (!access) {
        return jsonResponse({ error: "Chat not found." }, { status: 404 });
      }

      const [turns, aclEmails] = await Promise.all([
        listChatTurns({ env, chatId }),
        access.permission === "owner" ? listAclEmails({ env, chatId }) : Promise.resolve([]),
      ]);

      return jsonResponse({
        chat: chatPayload(access.meta, access.permission),
        aclEmails,
        messages: visibleMessagesFromTurns(turns),
      });
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "messages") {
      const body = await readJsonBody(request);
      return runStoredChatTurn({
        env,
        userEmail: user.email,
        chatId,
        text: normalizeUserText(body.text),
      });
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "shares") {
      const body = await readJsonBody(request);
      const aclEmails = await shareChat({
        env,
        chatId,
        ownerEmail: user.email,
        targetEmail: body.email,
      });

      return jsonResponse({ aclEmails });
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "shares") {
      const aclEmails = await unshareChat({
        env,
        chatId,
        ownerEmail: user.email,
        targetEmail: decodeURIComponent(segments[4]),
      });

      return jsonResponse({ aclEmails });
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "fork") {
      const body = await readJsonBody(request);
      const forkedMeta = await forkChat({
        env,
        sourceChatId: chatId,
        userEmail: user.email,
        title: body.title,
      });

      return jsonResponse({
        chat: chatPayload(forkedMeta, "owner"),
      });
    }
  }

  return null;
}
