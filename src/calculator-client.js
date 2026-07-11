import { listServiceDefinitions } from "./services/index.js";

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

function supportedCalculatorServiceCodes() {
  return new Set(
    listServiceDefinitions().flatMap((service) => service.calculatorServiceCodes),
  );
}

function isSupportedBedrockService(service) {
  return (
    service?.serviceCode === "amazonBedrock" &&
    service?.estimateFor === "amazonBedrockClassesGroup" &&
    Array.isArray(service?.subServices) &&
    service.subServices.length > 0 &&
    service.subServices.every(
      (subService) =>
        typeof subService?.serviceCode === "string" &&
        subService.serviceCode.length > 0 &&
        subService.calculationComponents &&
        typeof subService.calculationComponents === "object",
    )
  );
}

export function validateEstimateServiceCodes(estimatePayload) {
  const supportedCodes = supportedCalculatorServiceCodes();
  const services = Object.values(estimatePayload?.services ?? {});
  const unsupportedCodes = [
    ...new Set(
      services
        .map((service) => service?.serviceCode)
        .filter((serviceCode, index) => {
          const service = services[index];

          if (serviceCode === "amazonBedrock") {
            return !isSupportedBedrockService(service);
          }

          return (
            serviceCode &&
            !supportedCodes.has(serviceCode)
          );
        }),
    ),
  ];

  if (unsupportedCodes.length > 0) {
    throw new Error(
      `AWS calculator viewer does not support service code(s): ${unsupportedCodes.join(", ")}. ` +
        "Do not save manual or deprecated service records as calculator line items; use only services with exact calculator serializer coverage.",
    );
  }
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
  validateEstimateServiceCodes(estimatePayload);

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
