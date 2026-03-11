import vm from "node:vm";

const INDEX_URL = "https://calculator.aws/";
const DEFAULT_FILTERS = [];

function extractBundlePath(indexHtml) {
  const match = indexHtml.match(/src="([^"]+static\/js\/bundle\.js)"/i);

  if (!match?.[1]) {
    throw new Error("Unable to find the calculator bundle path in index.html.");
  }

  return new URL(match[1], INDEX_URL).toString();
}

function decodeEmbeddedJson(rawLiteral) {
  const jsLiteral = `'${rawLiteral}'`;
  return vm.runInNewContext(jsLiteral);
}

function* extractJsonBlobs(bundleSource) {
  const regex = /JSON\.parse\('((?:\\.|[^'])*)'\)/g;
  let match = regex.exec(bundleSource);

  while (match) {
    try {
      yield JSON.parse(decodeEmbeddedJson(match[1]));
    } catch {
      // Ignore blobs that are not valid JSON documents after decoding.
    }

    match = regex.exec(bundleSource);
  }
}

function shouldInclude(document, filters) {
  if (filters.length === 0) {
    return true;
  }

  const haystack = JSON.stringify(document).toLowerCase();
  return filters.every((filter) => haystack.includes(filter));
}

function summarizeDocument(document) {
  if (document?.serviceCode) {
    return {
      kind: "service",
      serviceCode: document.serviceCode,
      serviceName: document.serviceName,
      version: document.version,
      regions: document.regions,
      id: document.id,
    };
  }

  if (document?.id && Array.isArray(document?.configurationSection)) {
    return {
      kind: "template",
      id: document.id,
      title: document.title,
      version: document.version,
    };
  }

  return {
    kind: "other",
    id: document?.id ?? null,
    serviceCode: document?.serviceCode ?? null,
    serviceName: document?.serviceName ?? null,
  };
}

const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const indexResponse = await fetch(INDEX_URL);

if (!indexResponse.ok) {
  throw new Error(`Failed to fetch ${INDEX_URL} (${indexResponse.status}).`);
}

const indexHtml = await indexResponse.text();
const bundleUrl = extractBundlePath(indexHtml);
const bundleResponse = await fetch(bundleUrl);

if (!bundleResponse.ok) {
  throw new Error(`Failed to fetch ${bundleUrl} (${bundleResponse.status}).`);
}

const bundleSource = await bundleResponse.text();
const matches = [];

for (const document of extractJsonBlobs(bundleSource)) {
  if (!shouldInclude(document, filters)) {
    continue;
  }

  matches.push(document);
}

const output = {
  bundleUrl,
  filters: filters.length > 0 ? filters : DEFAULT_FILTERS,
  matches: matches.map((document) => ({
    summary: summarizeDocument(document),
    document,
  })),
};

console.log(JSON.stringify(output, null, 2));
