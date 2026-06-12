import { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_TOOL_CYCLES, runGeminiConversation } from "./gemini.js";
import {
  InvalidShareTargetEmailError,
  MAX_VISIBLE_TURNS,
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
const MAX_CHAT_BODY_BYTES = 1024 * 1024;
const MAX_USER_TEXT_CHARS = 8000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

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
  const contentLength = Number(request.headers.get("content-length") ?? 0);

  if (contentLength > MAX_CHAT_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }

  const bodyText = await request.text();

  if (!bodyText) {
    return {};
  }

  if (bodyText.length > MAX_CHAT_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function requireGeminiApiKey(env) {
  const apiKey = String(env?.GEMINI_API_KEY ?? "").trim();

  if (!apiKey) {
    throw new HttpError(503, "Chat model is not configured.");
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
    throw new HttpError(400, "A non-empty text value is required.");
  }

  if (text.length > MAX_USER_TEXT_CHARS) {
    throw new HttpError(413, `Text must be ${MAX_USER_TEXT_CHARS} characters or fewer.`);
  }

  return text;
}

function normalizeChatId(value) {
  const chatId = String(value ?? "").trim();

  if (!chatId) {
    throw new HttpError(400, "A chat id is required.");
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
    throw new HttpError(404, "Chat not found.");
  }

  if (access.permission !== "owner") {
    throw new HttpError(403, "Only the owner can continue this chat. Shared users can fork it.");
  }

  const priorContents = await listReplayContents({ env, chatId });
  const userContent = {
    role: "user",
    parts: [{ text }],
  };
  const nextTitle =
    access.meta.title === "Untitled chat" && (access.meta.contentCount ?? 0) === 0
      ? text
      : access.meta.title;
  const userTurn = buildTurnRecord({
    content: userContent,
    visible: true,
    viewRole: "user",
    text,
  });
  const metaAfterUser = await appendChatTurns({
    env,
    chatId,
    meta: access.meta,
    turns: [userTurn],
    title: nextTitle,
    toolStateHints: access.meta.toolStateHints ?? {},
  });
  const result = await runGeminiConversation({
    apiKey: requireGeminiApiKey(env),
    model: env?.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    contents: [...priorContents, userContent],
    maxToolCycles: maxToolCycles(env),
  });

  const turns = [];

  for (const content of result.appendedContents) {
    const hasFunctionCalls = content.role === "model" && content.parts?.some((part) => part?.functionCall);
    const hasFunctionResponses =
      content.role === "user" && content.parts?.some((part) => part?.functionResponse);
    const visibleText = content.parts?.map((part) => part?.text ?? "").filter(Boolean).join("\n").trim();

    if (hasFunctionCalls || hasFunctionResponses) {
      if (hasFunctionCalls && visibleText) {
        turns.push(
          buildTurnRecord({
            content: {
              role: "model",
              parts: [{ text: visibleText }],
            },
            visible: true,
            viewRole: "assistant",
            text: visibleText,
            replay: false,
          }),
        );
      }

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

  const nextMeta = await appendChatTurns({
    env,
    chatId,
    meta: metaAfterUser,
    turns,
    title: metaAfterUser.title,
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
  try {
    return await handleChatAppRequestInner(request, env, user);
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof InvalidShareTargetEmailError
          ? 400
          : 500;

    if (!(error instanceof HttpError) && !(error instanceof InvalidShareTargetEmailError)) {
      console.error(error);
    }

    return jsonResponse(
      {
        error:
          error instanceof HttpError || error instanceof InvalidShareTargetEmailError
            ? error.message
            : "Internal Server Error",
      },
      { status },
    );
  }
}

async function handleChatAppRequestInner(request, env, user) {
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
        throw new HttpError(404, "Chat not found.");
      }

      const [turns, aclEmails] = await Promise.all([
        listChatTurns({ env, chatId, limit: MAX_VISIBLE_TURNS }),
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
      const access = await getChatForUser({ env, chatId, userEmail: user.email });

      if (!access) {
        throw new HttpError(404, "Chat not found.");
      }

      if (access.permission !== "owner") {
        throw new HttpError(403, "Only the owner can share this chat.");
      }

      const aclEmails = await shareChat({
        env,
        chatId,
        ownerEmail: user.email,
        targetEmail: body.email,
      });

      return jsonResponse({ aclEmails });
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "shares") {
      const access = await getChatForUser({ env, chatId, userEmail: user.email });

      if (!access) {
        throw new HttpError(404, "Chat not found.");
      }

      if (access.permission !== "owner") {
        throw new HttpError(403, "Only the owner can revoke access.");
      }

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
      const access = await getChatForUser({ env, chatId, userEmail: user.email });

      if (!access) {
        throw new HttpError(404, "Chat not found.");
      }

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

  if (segments[0] === "api") {
    throw new HttpError(404, "Not found.");
  }

  return null;
}
