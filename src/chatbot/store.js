import { normalizeAccessEmail } from "../access.js";

const DEFAULT_CHAT_TITLE = "Untitled chat";
const DEFAULT_REPLAY_WINDOW_ITEMS = 40;

function requireChatKv(env) {
  if (!env?.CHAT_STATE) {
    throw new Error("CHAT_STATE KV binding is required.");
  }

  return env.CHAT_STATE;
}

function nowIso() {
  return new Date().toISOString();
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugId() {
  return crypto.randomUUID();
}

function metaKey(chatId) {
  return `chat:${chatId}:meta`;
}

function aclKey(chatId, email) {
  return `chat:${chatId}:acl:${normalizeAccessEmail(email)}`;
}

function turnPrefix(chatId) {
  return `chat:${chatId}:turn:`;
}

function turnKey(chatId, createdAt, order, turnId) {
  return `${turnPrefix(chatId)}${createdAt}:${String(order).padStart(4, "0")}:${turnId}`;
}

function ownedIndexKey(email, chatId) {
  return `user:${normalizeAccessEmail(email)}:owned:${chatId}`;
}

function sharedIndexKey(email, chatId) {
  return `user:${normalizeAccessEmail(email)}:shared:${chatId}`;
}

async function putJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function getJson(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function listAll(kv, prefix) {
  const keys = [];
  let cursor = undefined;

  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys.sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeChat(meta, permission) {
  return {
    chatId: meta.chatId,
    title: meta.title,
    ownerEmail: meta.ownerEmail,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.lastMessageAt,
    forkedFromChatId: meta.forkedFromChatId ?? null,
    permission,
  };
}

function deriveTitle(title, fallbackText) {
  const trimmedTitle = String(title ?? "").trim();

  if (trimmedTitle) {
    return trimmedTitle.slice(0, 120);
  }

  const trimmedText = String(fallbackText ?? "").trim();

  if (!trimmedText) {
    return DEFAULT_CHAT_TITLE;
  }

  return trimmedText.replace(/\s+/g, " ").slice(0, 80);
}

async function writeChatSummaryIndexes(kv, meta, aclEmails = []) {
  const ownerSummary = summarizeChat(meta, "owner");
  await putJson(kv, ownedIndexKey(meta.ownerEmail, meta.chatId), ownerSummary);

  await Promise.all(
    aclEmails
      .filter((email) => normalizeAccessEmail(email) !== meta.ownerEmail)
      .map((email) =>
        putJson(
          kv,
          sharedIndexKey(email, meta.chatId),
          summarizeChat(meta, "shared"),
        ),
      ),
  );
}

export function replayWindowLimit(env) {
  const value = Number(env?.CHAT_REPLAY_WINDOW_ITEMS ?? DEFAULT_REPLAY_WINDOW_ITEMS);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 200) : DEFAULT_REPLAY_WINDOW_ITEMS;
}

export function sanitizeToolEvents(toolEvents = []) {
  return toolEvents.map((event) => ({
    name: event.name,
    ok: event.ok,
    summary: event.summary,
  }));
}

export function visibleMessagesFromTurns(turns = []) {
  return turns
    .filter((turn) => turn.visible)
    .map((turn) => ({
      id: turn.id,
      role: turn.viewRole,
      text: turn.text ?? "",
      createdAt: turn.createdAt,
      toolEvents: turn.toolEvents ?? [],
    }));
}

export async function createChat({
  env,
  ownerEmail,
  title,
  forkedFromChatId = null,
}) {
  const kv = requireChatKv(env);
  const normalizedOwner = normalizeAccessEmail(ownerEmail);
  const chatId = slugId();
  const createdAt = nowIso();
  const meta = {
    chatId,
    title: deriveTitle(title),
    ownerEmail: normalizedOwner,
    createdAt,
    updatedAt: createdAt,
    lastMessageAt: null,
    forkedFromChatId,
    replayWindowCount: 0,
    contentCount: 0,
    toolStateHints: {},
  };

  await putJson(kv, metaKey(chatId), meta);
  await writeChatSummaryIndexes(kv, meta);

  return meta;
}

export async function getChatForUser({
  env,
  chatId,
  userEmail,
}) {
  const kv = requireChatKv(env);
  const meta = await getJson(kv, metaKey(chatId));

  if (!meta) {
    return null;
  }

  const normalizedUser = normalizeAccessEmail(userEmail);

  if (meta.ownerEmail === normalizedUser) {
    return {
      meta,
      permission: "owner",
    };
  }

  const acl = await getJson(kv, aclKey(chatId, normalizedUser));

  if (!acl) {
    return null;
  }

  return {
    meta,
    permission: "shared",
  };
}

export async function listChatsForUser({
  env,
  userEmail,
}) {
  const kv = requireChatKv(env);
  const normalizedUser = normalizeAccessEmail(userEmail);
  const [ownedKeys, sharedKeys] = await Promise.all([
    listAll(kv, `user:${normalizedUser}:owned:`),
    listAll(kv, `user:${normalizedUser}:shared:`),
  ]);

  const loadSummaries = async (keys) =>
    Promise.all(keys.map((entry) => getJson(kv, entry.name))).then((items) =>
      items
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
    );

  const [owned, shared] = await Promise.all([loadSummaries(ownedKeys), loadSummaries(sharedKeys)]);

  return { owned, shared };
}

export async function listChatTurns({
  env,
  chatId,
  limit = null,
}) {
  const kv = requireChatKv(env);
  const keys = await listAll(kv, turnPrefix(chatId));
  const selectedKeys =
    Number.isFinite(limit) && limit > 0 ? keys.slice(-Math.floor(limit)) : keys;
  const turns = await Promise.all(selectedKeys.map((entry) => getJson(kv, entry.name)));

  return turns.filter(Boolean);
}

function isPlainVisibleUserTurn(turn) {
  return (
    turn?.visible === true &&
    turn?.viewRole === "user" &&
    turn?.content?.role === "user" &&
    Array.isArray(turn.content.parts) &&
    turn.content.parts.every((part) => typeof part?.text === "string")
  );
}

function replayTurnsFromWindow(turns, limit) {
  const candidateTurns = turns.slice(-limit);
  const startIndex = candidateTurns.findIndex(isPlainVisibleUserTurn);

  return startIndex >= 0 ? candidateTurns.slice(startIndex) : [];
}

export async function listReplayContents({
  env,
  chatId,
  limit = replayWindowLimit(env),
}) {
  const turns = await listChatTurns({ env, chatId, limit: Math.max(limit * 2, limit) });
  const replayTurns = replayTurnsFromWindow(turns, limit);
  return replayTurns.map((turn) => turn.content);
}

export async function listAclEmails({
  env,
  chatId,
}) {
  const kv = requireChatKv(env);
  const keys = await listAll(kv, `chat:${chatId}:acl:`);
  return keys.map((entry) => entry.name.split(":").at(-1)).filter(Boolean).sort();
}

export function buildTurnRecord({
  content,
  visible,
  viewRole = null,
  text = "",
  toolEvents = [],
}) {
  const createdAt = nowIso();
  return {
    id: slugId(),
    createdAt,
    visible,
    viewRole,
    text,
    toolEvents,
    content: jsonClone(content),
  };
}

export async function appendChatTurns({
  env,
  chatId,
  meta,
  turns,
  title,
  toolStateHints = null,
}) {
  const kv = requireChatKv(env);
  const normalizedTitle = deriveTitle(title, meta.title);
  const visibleTurns = turns.filter((turn) => turn.visible);
  const lastVisibleTurn = visibleTurns.at(-1);
  const updatedAt = lastVisibleTurn?.createdAt ?? nowIso();
  const nextMeta = {
    ...meta,
    title: normalizedTitle,
    updatedAt,
    lastMessageAt: lastVisibleTurn?.createdAt ?? meta.lastMessageAt,
    replayWindowCount: Math.min(
      (meta.replayWindowCount ?? 0) + turns.length,
      replayWindowLimit(env),
    ),
    contentCount: (meta.contentCount ?? 0) + turns.length,
    toolStateHints: toolStateHints ?? meta.toolStateHints ?? {},
  };

  await Promise.all(
    turns.map((turn, index) => putJson(kv, turnKey(chatId, turn.createdAt, index, turn.id), turn)),
  );
  await putJson(kv, metaKey(chatId), nextMeta);
  await writeChatSummaryIndexes(kv, nextMeta, await listAclEmails({ env, chatId }));

  return nextMeta;
}

export async function shareChat({
  env,
  chatId,
  ownerEmail,
  targetEmail,
}) {
  const kv = requireChatKv(env);
  const access = await getChatForUser({ env, chatId, userEmail: ownerEmail });

  if (!access || access.permission !== "owner") {
    throw new Error("Only the owner can share this chat.");
  }

  const normalizedTarget = normalizeAccessEmail(targetEmail);

  if (!normalizedTarget) {
    throw new Error("A target email is required.");
  }

  if (normalizedTarget === access.meta.ownerEmail) {
    throw new Error("The owner already has access.");
  }

  await putJson(kv, aclKey(chatId, normalizedTarget), {
    email: normalizedTarget,
    grantedAt: nowIso(),
    grantedBy: access.meta.ownerEmail,
  });
  await putJson(
    kv,
    sharedIndexKey(normalizedTarget, chatId),
    summarizeChat(access.meta, "shared"),
  );

  return listAclEmails({ env, chatId });
}

export async function unshareChat({
  env,
  chatId,
  ownerEmail,
  targetEmail,
}) {
  const kv = requireChatKv(env);
  const access = await getChatForUser({ env, chatId, userEmail: ownerEmail });

  if (!access || access.permission !== "owner") {
    throw new Error("Only the owner can revoke access.");
  }

  const normalizedTarget = normalizeAccessEmail(targetEmail);

  await Promise.all([
    kv.delete(aclKey(chatId, normalizedTarget)),
    kv.delete(sharedIndexKey(normalizedTarget, chatId)),
  ]);

  return listAclEmails({ env, chatId });
}

export async function forkChat({
  env,
  sourceChatId,
  userEmail,
  title,
}) {
  const kv = requireChatKv(env);
  const access = await getChatForUser({ env, chatId: sourceChatId, userEmail });

  if (!access) {
    throw new Error("Chat not found or access denied.");
  }

  const sourceTurns = await listChatTurns({ env, chatId: sourceChatId });
  const forkMeta = await createChat({
    env,
    ownerEmail: userEmail,
    title: deriveTitle(title, access.meta.title),
    forkedFromChatId: sourceChatId,
  });

  if (sourceTurns.length === 0) {
    return forkMeta;
  }

  const clonedTurns = sourceTurns.map((turn) => ({
    ...jsonClone(turn),
    id: slugId(),
    createdAt: nowIso(),
  }));

  return appendChatTurns({
    env,
    chatId: forkMeta.chatId,
    meta: forkMeta,
    turns: clonedTurns,
    title: deriveTitle(title, access.meta.title),
    toolStateHints: access.meta.toolStateHints ?? {},
  });
}
