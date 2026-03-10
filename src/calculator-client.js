const SAVE_AS_ENDPOINT = "https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs";
const SHARE_LINK_PREFIX = "https://calculator.aws/#/estimate?id=";
const SHARED_ESTIMATE_PREFIX = "https://d3knqfixx3sbls.cloudfront.net/";
const JSON_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
};

function isHexEstimateId(value) {
  return /^[a-f0-9]{40}$/i.test(value);
}

export function buildShareLink(estimateId) {
  return `${SHARE_LINK_PREFIX}${estimateId}`;
}

export function isOfficialCalculatorShareLink(value) {
  try {
    const estimateId = extractEstimateId(value);
    return isHexEstimateId(estimateId);
  } catch {
    return false;
  }
}

export function extractEstimateId(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Expected a calculator share link or estimate id.");
  }

  const trimmed = input.trim();

  if (isHexEstimateId(trimmed)) {
    return trimmed.toLowerCase();
  }

  const match = trimmed.match(/[#?&]id=([a-f0-9]{40})/i);

  if (match) {
    return match[1].toLowerCase();
  }

  throw new Error(`Unable to extract an estimate id from '${input}'.`);
}

function sharedEstimateUrl(estimateId) {
  return `${SHARED_ESTIMATE_PREFIX}${estimateId}`;
}

function parseJsonSafely(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSaveResponse(payload) {
  const unwrappedBody =
    typeof payload?.body === "string"
      ? parseJsonSafely(payload.body)
      : payload?.body ?? null;

  return unwrappedBody && typeof unwrappedBody === "object"
    ? { ...payload, ...unwrappedBody }
    : payload;
}

export async function fetchSavedEstimate(shareLinkOrEstimateId) {
  const estimateId = extractEstimateId(shareLinkOrEstimateId);
  const response = await fetch(sharedEstimateUrl(estimateId), {
    headers: {
      accept: JSON_HEADERS.accept,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch saved estimate '${estimateId}' (${response.status} ${response.statusText}).`,
    );
  }

  return {
    estimateId,
    shareLink: buildShareLink(estimateId),
    estimate: await response.json(),
  };
}

export async function saveEstimate(estimatePayload) {
  const response = await fetch(SAVE_AS_ENDPOINT, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(estimatePayload),
  });

  if (!response.ok) {
    const failureBody = await response.text();
    throw new Error(
      `AWS calculator save failed (${response.status} ${response.statusText}): ${failureBody}`,
    );
  }

  const payload = await response.json();
  const normalizedPayload = normalizeSaveResponse(payload);
  const savedKey = normalizedPayload?.savedKey;

  if (!isHexEstimateId(savedKey)) {
    throw new Error(
      `AWS calculator save did not return a valid savedKey: ${JSON.stringify(payload)}`,
    );
  }

  return {
    savedKey,
    shareLink: buildShareLink(savedKey),
    rawResponse: normalizedPayload,
  };
}
