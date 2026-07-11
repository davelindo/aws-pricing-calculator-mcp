import crypto from "node:crypto";

import {
  ambiguousCandidates,
  ambiguousIdentifiers,
  listUniversalServiceEntries,
  normalizeIdentifier,
  serviceIdForCloudFormationType,
  serviceIdForTerraformType,
  universalServiceById,
} from "./service-registry.js";

const SCHEMA_VERSION = "2.0";
const CONTRACT_VERSION = "v2";
const EXCERPT_LENGTH = 240;
const WORD_NUMBERS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["dozen", 12],
]);

const CONDITIONAL_CLOUDFORMATION_TYPES = new Set([
  "aws::rds::dbinstance",
  "aws::rds::dbcluster",
  "aws::elasticloadbalancingv2::loadbalancer",
  "aws::ecs::cluster",
  "aws::ecs::service",
  "aws::ecs::taskdefinition",
]);

const CONDITIONAL_TERRAFORM_TYPES = new Set([
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_lb",
  "aws_ecs_cluster",
  "aws_ecs_service",
  "aws_ecs_task_definition",
]);

const NON_PRICED_COMPONENT_KINDS = new Set([
  "actor",
  "client",
  "external",
  "external-actor",
  "person",
  "user",
]);

function stableValue(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    return value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key], seen)]),
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value, length = 64) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}

function clone(value) {
  return stableValue(value);
}

function slug(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function excerpt(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH) || null;
}

function evidence(sourceId, locator = null, value = null, extensions = {}) {
  return {
    sourceId: sourceId ?? null,
    locator: locator ?? null,
    excerpt: value === null || value === undefined ? null : excerpt(value),
    ...extensions,
  };
}

function provenance(evidenceItems = [], confidence = 1, mode = "explicit") {
  const items = evidenceItems.filter(Boolean).map((item) => ({ ...item }));
  return {
    mode,
    sourceIds: [...new Set(items.map((item) => item.sourceId).filter(Boolean))],
    evidence: items,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function uniqueId(preferred, used, fallback = "item") {
  const base = String(preferred ?? "").trim() || fallback;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  const result = `${base}-${index}`;
  used.add(result);
  return result;
}

function formatHintFor(content) {
  if (typeof content !== "string") return "structured";
  const trimmed = content.trim();
  if (/^[{[]/.test(trimmed)) return "json";
  if (/\bresource\s+"aws_[a-z0-9_]+"\s+"/i.test(trimmed)) return "terraform";
  if (/^\s*(?:AWSTemplateFormatVersion|Resources)\s*:/m.test(trimmed)) return "cloudformation-yaml";
  return "text";
}

function mediaTypeFor(content, formatHint) {
  if (formatHint === "json") return "application/json";
  if (formatHint?.includes("yaml")) return "application/yaml";
  if (formatHint === "terraform") return "text/x-hcl";
  return typeof content === "string" ? "text/plain" : "application/json";
}

function normalizeSources(input) {
  const raw = [];
  if (Object.prototype.hasOwnProperty.call(input, "definition")) {
    raw.push({ id: "definition", content: input.definition });
  }
  for (const source of Array.isArray(input.sources) ? input.sources : []) {
    raw.push(source && typeof source === "object" && "content" in source ? source : { content: source });
  }

  const usedIds = new Set();
  return raw.map((source, index) => {
    const content = source.content;
    const formatHint = source.formatHint ?? formatHintFor(content);
    const id = uniqueId(source.id ?? `source-${index + 1}`, usedIds, `source-${index + 1}`);
    return {
      ...source,
      id,
      name: source.name ?? null,
      mediaType: source.mediaType ?? mediaTypeFor(content, formatHint),
      formatHint,
      content,
      metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
    };
  });
}

function sourceDescriptor(source) {
  return {
    id: source.id,
    name: source.name,
    mediaType: source.mediaType ?? null,
    formatHint: source.formatHint ?? null,
    locator: source.metadata?.locator ?? null,
    digest: `sha256:${digest(source.content)}`,
  };
}

function getCaseInsensitive(object, names) {
  if (!object || typeof object !== "object") return undefined;
  const keys = Object.keys(object);
  for (const name of names) {
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return object[key];
  }
  return undefined;
}

function asPositiveNumber(value, fallback = 1) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function arrayOf(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarFromProperty(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(scalarFromProperty);
  return clone(value);
}

function normalizeEngine(value) {
  return String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function conditionalDatabaseResolution(engine, cluster = false) {
  const normalized = normalizeEngine(engine);
  if (normalized.includes("aurora-postgresql") || normalized.includes("aurora-postgres")) {
    return { serviceId: "amazon-aurora-postgresql" };
  }
  if (normalized === "aurora-mysql" || normalized === "aurora") {
    if (normalized === "aurora") {
      return {
        candidates: ["amazon-aurora-mysql", "amazon-aurora-postgresql"],
        label: "Amazon Aurora",
      };
    }
    return { serviceId: "amazon-aurora-mysql" };
  }
  if (normalized.includes("postgres")) return { serviceId: "amazon-rds-postgresql" };
  if (normalized.includes("mysql")) return { serviceId: "amazon-rds-mysql" };
  if (normalized.includes("sqlserver") || normalized.includes("mssql")) {
    return { serviceId: "amazon-rds-sqlserver" };
  }
  return {
    candidates: cluster
      ? ["amazon-aurora-postgresql", "amazon-aurora-mysql"]
      : ["amazon-rds-postgresql", "amazon-rds-mysql", "amazon-rds-sqlserver"],
    label: cluster ? "Amazon Aurora cluster" : "Amazon RDS database",
  };
}

function conditionalContainerResolution(properties) {
  const launchType = String(
    getCaseInsensitive(properties, ["LaunchType", "launch_type", "requiresCompatibilities"]) ?? "",
  ).toLowerCase();
  const capacity = stableStringify(
    getCaseInsensitive(properties, ["CapacityProviderStrategy", "capacity_provider_strategy"]) ?? "",
  ).toLowerCase();
  if (launchType.includes("fargate") || capacity.includes("fargate")) {
    return { serviceId: "amazon-ecs-fargate" };
  }
  if (launchType.includes("ec2") || capacity.includes("ec2")) {
    return { serviceId: "amazon-ecs-ec2" };
  }
  return {
    candidates: ["amazon-ecs-ec2", "amazon-ecs-fargate"],
    label: "Amazon ECS",
  };
}

function resolveInfrastructureType(type, properties = {}, provider = null) {
  const rawType = String(type ?? "").trim();
  const lower = rawType.toLowerCase();
  const isCloudFormation = provider === "cloudformation" || lower.startsWith("aws::");
  const isTerraform = provider === "terraform" || lower.startsWith("aws_");

  if (isCloudFormation && CONDITIONAL_CLOUDFORMATION_TYPES.has(lower)) {
    if (lower === "aws::rds::dbinstance") {
      return { ...conditionalDatabaseResolution(getCaseInsensitive(properties, ["Engine"])), method: "cloudformation-type+properties" };
    }
    if (lower === "aws::rds::dbcluster") {
      return { ...conditionalDatabaseResolution(getCaseInsensitive(properties, ["Engine"]), true), method: "cloudformation-type+properties" };
    }
    if (lower === "aws::elasticloadbalancingv2::loadbalancer") {
      const lbType = String(getCaseInsensitive(properties, ["Type"]) ?? "application").toLowerCase();
      return {
        serviceId: lbType === "network" ? "network-load-balancer" : "application-load-balancer",
        method: "cloudformation-type+properties",
      };
    }
    return { ...conditionalContainerResolution(properties), method: "cloudformation-type+properties" };
  }

  if (isTerraform && CONDITIONAL_TERRAFORM_TYPES.has(lower)) {
    if (lower === "aws_db_instance") {
      return { ...conditionalDatabaseResolution(getCaseInsensitive(properties, ["engine"])), method: "terraform-type+attributes" };
    }
    if (lower === "aws_rds_cluster") {
      return { ...conditionalDatabaseResolution(getCaseInsensitive(properties, ["engine"]), true), method: "terraform-type+attributes" };
    }
    if (lower === "aws_lb") {
      const lbType = String(getCaseInsensitive(properties, ["load_balancer_type"]) ?? "application").toLowerCase();
      return {
        serviceId: lbType === "network" ? "network-load-balancer" : "application-load-balancer",
        method: "terraform-type+attributes",
      };
    }
    return { ...conditionalContainerResolution(properties), method: "terraform-type+attributes" };
  }

  const serviceId = isCloudFormation
    ? serviceIdForCloudFormationType(rawType)
    : isTerraform
      ? serviceIdForTerraformType(rawType)
      : null;
  if (serviceId) {
    return {
      serviceId,
      method: isCloudFormation ? "cloudformation-type" : "terraform-type",
    };
  }
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasRegex(value) {
  const raw = String(value);
  const pieces = raw.split(/[\s_:/.-]+/).filter(Boolean).map(escapeRegex);
  const body = pieces.length > 1 ? pieces.join("[\\s_:/.-]*") : escapeRegex(raw);
  return new RegExp(`(?<![a-z0-9])${body}(?=$|[^a-z0-9])`, "giu");
}

function textMatchers() {
  return listUniversalServiceEntries()
    .flatMap((service) =>
      service.aliases.map((alias) => ({
        ...alias,
        serviceId: service.id,
        serviceName: service.name,
        regex: aliasRegex(alias.value),
      })),
    )
    .sort((left, right) => right.priority - left.priority || right.value.length - left.value.length);
}

const AMBIGUOUS_MATCHERS = ambiguousIdentifiers().map((entry) => ({
  ...entry,
  regex: aliasRegex(entry.value),
  priority: 70,
  confidence: 0.55,
  method: "ambiguous-common-identifier",
}));

function matchText(text) {
  const candidates = [];
  for (const matcher of [...textMatchers(), ...AMBIGUOUS_MATCHERS]) {
    matcher.regex.lastIndex = 0;
    for (const match of text.matchAll(matcher.regex)) {
      candidates.push({
        ...matcher,
        start: match.index,
        end: match.index + match[0].length,
        matchedText: match[0],
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.priority - left.priority ||
      right.end - right.start - (left.end - left.start),
  );
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function isNegated(text, start, end) {
  const before = text.slice(Math.max(0, start - 180), start);
  const after = text.slice(end, Math.min(text.length, end + 80));
  const clause =
    before
      .split(
        /[.!?;\n]|\b(?:but|however|except)\b|,\s*(?=(?:use|include|add|run|deploy|store|serve|keep)\b)/i,
      )
      .at(-1) ?? "";
  const affirmativeOverrides = [
    /(?:cannot|can't|could not|couldn't)\s+(?:\w+\s+){0,5}without\s*$/i,
    /(?:do not|don't|must not|not to)\s+(?:skip|omit|exclude|remove)\s*$/i,
    /not\s+only\s*$/i,
    /not\s+without\s*$/i,
  ];
  if (affirmativeOverrides.some((pattern) => pattern.test(clause))) return false;
  const negativeBefore = /(?:^|[,:(]\s*|\b)(?:no|without|exclude(?:d|s|ing)?|omit(?:ted|s|ting)?|avoid(?:ed|s|ing)?|remove(?:d|s|ing)?|do\s+not\s+(?:include|use|add)|don't\s+(?:include|use|add)|must\s+not\s+(?:include|use|add)|instead\s+of)\b[^.!?;\n]*$/i;
  const negativeAfter = /^\s*(?:is|are|was|were|should\s+be|must\s+be)?\s*(?:not\s+(?:used|included|required|present)|excluded|omitted|disabled)\b/i;
  return negativeBefore.test(clause) || negativeAfter.test(after);
}

function quantityBefore(text, start) {
  const prefix = text.slice(Math.max(0, start - 40), start);
  const numeric = prefix.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:x|×)?\s*$/i);
  if (numeric) return asPositiveNumber(numeric[1]);
  const word = prefix.match(/(?:^|\s)(one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s*$/i);
  return word ? WORD_NUMBERS.get(word[1].toLowerCase()) : 1;
}

function openServiceId(value, provider = "aws") {
  const raw = String(value ?? "").trim();
  const explicitPrefix = /^amazon\b/i.test(raw) ? "amazon" : "aws";
  const normalized = raw
    .replace(/^AWS::/i, "")
    .replace(/^aws_/i, "")
    .replace(/^(?:AWS|Amazon)(?:[\s_:/.-])+/i, "")
    .replace(/::/g, "-")
    .replace(/_/g, "-");
  return `${provider === "aws" ? explicitPrefix : provider}-${slug(normalized, "resource")}`;
}

function unknownAwsMatches(text, occupied) {
  const matches = [];
  const patterns = [
    /\bAWS::[A-Za-z0-9]+(?:::[A-Za-z0-9]+){1,3}\b/g,
    /\baws_[a-z0-9]+(?:_[a-z0-9]+)+\b/g,
    /\b(?:Amazon|AWS)\s+(?:Step\s+Functions|[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z][A-Za-z0-9+.-]*){0,3})\b/g,
  ];
  const ignored = /^(?:aws|amazon)\s+(?:architecture|calculator|cloud|account|region|well architected|pricing)$/i;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some((item) => start < item.end && end > item.start)) continue;
      if (ignored.test(match[0].trim())) continue;
      matches.push({ start, end, matchedText: match[0] });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  return matches.filter(
    (item, index) => !matches.slice(0, index).some((prior) => item.start < prior.end && item.end > prior.start),
  );
}

function resolutionForKnown(serviceId, method, confidence, itemProvenance) {
  const service = universalServiceById(serviceId);
  return {
    status: "resolved",
    serviceId,
    catalogServiceId: serviceId,
    serviceName: service?.name ?? serviceId,
    confidence,
    candidates: [],
    rationale: [`Matched ${method}.`],
    provenance: itemProvenance,
  };
}

function resolutionForCandidates(candidates, method, itemProvenance) {
  return {
    status: "ambiguous",
    serviceId: null,
    catalogServiceId: null,
    serviceName: null,
    confidence: 0.55,
    candidates: candidates.map((serviceId) => {
      const service = universalServiceById(serviceId);
      return {
        serviceId,
        serviceName: service?.name ?? null,
        score: 0.5,
        rationale: [`'${method}' does not identify a unique calculator service.`],
      };
    }),
    rationale: ["More detail is required to select one catalog service."],
    provenance: itemProvenance,
  };
}

function resolutionForUnknown(serviceId, name, reason, itemProvenance) {
  return {
    status: "unresolved",
    serviceId,
    catalogServiceId: null,
    serviceName: name ?? null,
    confidence: 0,
    candidates: [],
    rationale: [reason],
    provenance: itemProvenance,
  };
}

function explicitInclusion(node, fallback = "included") {
  const intent = String(
    getCaseInsensitive(node, ["inclusion", "intent", "disposition", "action", "status"]) ?? "",
  ).toLowerCase();
  if (["exclude", "excluded", "omit", "omitted", "forbidden", "disabled"].includes(intent)) {
    return "excluded";
  }
  if (["uncertain", "optional", "candidate", "possible"].includes(intent)) return "uncertain";
  if (getCaseInsensitive(node, ["excluded"]) === true) return "excluded";
  if (getCaseInsensitive(node, ["include", "included", "enabled"]) === false) return "excluded";
  return fallback;
}

function makeState(sources, context, input) {
  return {
    input,
    context,
    sources,
    components: [],
    relationships: [],
    scopes: [],
    constraints: [],
    assumptions: [],
    conflicts: [],
    unresolved: [],
    questions: [],
    componentIds: new Set(),
    relationshipIds: new Set(),
    scopeIds: new Set(),
    constraintIds: new Set(),
    assumptionIds: new Set(),
    conflictIds: new Set(),
    unresolvedIds: new Set(),
    originalComponentIds: new Map(),
    defaultScopeIds: [],
    title: context.name ?? null,
    summary: null,
    budgetValues: [],
  };
}

function ensureScope(state, kind, value, itemProvenance, parentScopeId = null) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  const existing = state.scopes.find(
    (scope) => scope.kind === kind && String(scope.properties.value) === normalized && scope.parentScopeId === parentScopeId,
  );
  if (existing) return existing.id;
  const id = uniqueId(`${kind}-${slug(normalized)}`, state.scopeIds, "scope");
  state.scopes.push({
    id,
    name: normalized,
    kind,
    parentScopeId,
    componentIds: [],
    properties: { value: normalized, ...(kind === "region" ? { region: normalized } : {}) },
    provenance: itemProvenance,
  });
  return id;
}

function registerComponentOriginalId(state, sourceId, originalId, componentId) {
  if (originalId === null || originalId === undefined) return;
  const key = `${sourceId}:${String(originalId)}`;
  const values = state.originalComponentIds.get(key) ?? [];
  values.push(componentId);
  state.originalComponentIds.set(key, values);
}

function addComponent(state, spec) {
  const id = uniqueId(spec.id, state.componentIds, `component-${state.components.length + 1}`);
  const scopeIds = [...new Set([...(spec.scopeIds ?? state.defaultScopeIds)].filter(Boolean))];
  const regionScope = state.scopes.find((scope) => scopeIds.includes(scope.id) && scope.kind === "region");
  const environmentScope = state.scopes.find(
    (scope) => scopeIds.includes(scope.id) && scope.kind === "environment",
  );
  const inclusion = spec.inclusion ?? "included";
  const resolution = spec.resolution ?? null;
  const component = {
    id,
    name: spec.name ?? resolution?.serviceName ?? spec.serviceId ?? id,
    kind: spec.kind ?? "service",
    description: spec.description ?? null,
    serviceId: spec.serviceId ?? resolution?.serviceId ?? null,
    resolution,
    scopeIds,
    region: spec.region ?? regionScope?.properties.region ?? null,
    environment: spec.environment ?? environmentScope?.properties.value ?? null,
    quantity: asPositiveNumber(spec.quantity, 1),
    configuration: clone(spec.configuration ?? {}),
    usage: clone(spec.usage ?? {}),
    pricingStatus:
      inclusion === "excluded"
        ? "excluded"
        : resolution?.status === "resolved"
          ? "unpriced"
          : resolution
            ? "needs-resolution"
            : "not-applicable",
    properties: clone(spec.properties ?? {}),
    provenance: spec.provenance,
    inclusion,
    excluded: inclusion === "excluded",
    sourceResourceType: spec.sourceResourceType ?? null,
  };
  state.components.push(component);
  for (const scopeId of scopeIds) {
    const scope = state.scopes.find((candidate) => candidate.id === scopeId);
    if (scope && !scope.componentIds.includes(id)) scope.componentIds.push(id);
  }
  registerComponentOriginalId(state, spec.sourceId, spec.originalId, id);
  return component;
}

function resolveOriginalComponentId(state, sourceId, originalId) {
  const values = state.originalComponentIds.get(`${sourceId}:${String(originalId)}`);
  return values?.[0] ?? (state.componentIds.has(String(originalId)) ? String(originalId) : null);
}

function addRelationship(state, spec) {
  if (!spec.fromComponentId || !spec.toComponentId) return null;
  const id = uniqueId(
    spec.id ?? `${slug(spec.fromComponentId)}-${slug(spec.type ?? "connects-to")}-${slug(spec.toComponentId)}`,
    state.relationshipIds,
    `relationship-${state.relationships.length + 1}`,
  );
  const relationship = {
    id,
    fromComponentId: spec.fromComponentId,
    toComponentId: spec.toComponentId,
    type: spec.type ?? "connects-to",
    description: spec.description ?? null,
    properties: clone(spec.properties ?? {}),
    provenance: spec.provenance,
  };
  state.relationships.push(relationship);
  return relationship;
}

function scopesForNode(state, node, itemProvenance) {
  const result = [...state.defaultScopeIds];
  const region = getCaseInsensitive(node, ["region", "awsRegion", "aws_region"]);
  const environment = getCaseInsensitive(node, ["environment", "env", "stage"]);
  const account = getCaseInsensitive(node, ["account", "accountId", "account_id"]);
  for (const [kind, value] of [
    ["region", region],
    ["environment", environment],
    ["account", account],
  ]) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      const scopeId = ensureScope(state, kind, item, itemProvenance);
      if (scopeId) result.push(scopeId);
    }
  }
  const explicitScopeIds = getCaseInsensitive(node, ["scopeIds", "scope_ids"]);
  if (Array.isArray(explicitScopeIds)) result.push(...explicitScopeIds.map(String));
  return [...new Set(result)];
}

function configurationFor(properties, node) {
  const configuration = clone(getCaseInsensitive(node, ["configuration", "config"]) ?? properties ?? {});
  const commonKeys = {
    engine: ["Engine", "engine"],
    instanceType: ["InstanceType", "instance_type", "instanceType", "DBInstanceClass"],
    storageGb: ["AllocatedStorage", "allocated_storage", "storageGb"],
    launchType: ["LaunchType", "launch_type"],
    loadBalancerType: ["Type", "load_balancer_type"],
    region: ["Region", "region", "aws_region"],
  };
  for (const [target, names] of Object.entries(commonKeys)) {
    const value = getCaseInsensitive(properties, names) ?? getCaseInsensitive(node, names);
    if (value !== undefined && configuration[target] === undefined) {
      configuration[target] = scalarFromProperty(value);
    }
  }
  return configuration;
}

function exactIdentifierResolution(identifier) {
  if (!identifier) return null;
  const raw = String(identifier).trim();
  const direct = universalServiceById(raw);
  if (direct) return { serviceId: direct.id, method: "canonical-id", confidence: 1 };
  const infrastructure = resolveInfrastructureType(raw);
  if (infrastructure) return { ...infrastructure, confidence: 1 };
  const normalized = normalizeIdentifier(raw);
  const ambiguous = ambiguousCandidates(normalized);
  if (ambiguous) return { candidates: ambiguous, method: "ambiguous-common-identifier", confidence: 0.55 };
  const exactAliases = [];
  for (const service of listUniversalServiceEntries()) {
    for (const alias of service.aliases) {
      if (normalizeIdentifier(alias.value) === normalized) {
        exactAliases.push({ serviceId: service.id, ...alias });
      }
    }
  }
  exactAliases.sort((left, right) => right.priority - left.priority);
  if (exactAliases.length) return exactAliases[0];
  const matches = matchText(raw);
  if (matches.length === 1 && matches[0].start === 0 && matches[0].end === raw.length) {
    return matches[0];
  }
  return null;
}

function addResolvedNode(state, source, locator, node, options = {}) {
  const properties = options.properties ?? getCaseInsensitive(node, ["properties", "values", "attributes"]) ?? {};
  const rawIdentifier =
    options.identifier ??
    getCaseInsensitive(node, [
      "serviceId",
      "service_id",
      "calculatorServiceCode",
      "resourceType",
      "resource_type",
      "type",
      "service",
      "providerType",
    ]);
  const name =
    options.name ??
    getCaseInsensitive(node, ["name", "label", "title", "logicalId", "address", "id"]) ??
    rawIdentifier ??
    `component-${state.components.length + 1}`;
  const itemEvidence = evidence(source.id, locator, options.evidenceValue ?? node, {
    matchMethod: options.method ?? null,
  });
  let resolved = options.resolved ?? resolveInfrastructureType(rawIdentifier, properties, options.provider);
  if (!resolved) resolved = exactIdentifierResolution(rawIdentifier);
  if (!resolved && String(name) !== String(rawIdentifier ?? "")) {
    resolved = exactIdentifierResolution(name);
  }
  const declaredKind = String(
    getCaseInsensitive(node, ["kind", "componentKind"]) ?? rawIdentifier ?? "",
  )
    .trim()
    .toLowerCase();
  const nonPriced = !resolved && NON_PRICED_COMPONENT_KINDS.has(declaredKind);
  const inclusion = options.inclusion ?? explicitInclusion(node);
  const itemProvenance = provenance(
    [itemEvidence],
    resolved?.confidence ?? (resolved ? 1 : 0),
    resolved?.method?.includes("capability") ? "inferred" : "explicit",
  );
  let serviceId = null;
  let resolution = null;
  if (resolved?.serviceId) {
    serviceId = resolved.serviceId;
    resolution = resolutionForKnown(
      serviceId,
      options.method ?? resolved.method ?? "identifier",
      resolved.confidence ?? 1,
      itemProvenance,
    );
  } else if (resolved?.candidates) {
    resolution = resolutionForCandidates(
      resolved.candidates,
      options.method ?? resolved.method ?? rawIdentifier ?? name,
      itemProvenance,
    );
  } else if (!nonPriced) {
    const isAws =
      options.provider === "cloudformation" ||
      options.provider === "terraform" ||
      /^(?:aws::|aws_|aws\b|amazon\b)/i.test(String(rawIdentifier ?? name));
    serviceId = isAws ? openServiceId(rawIdentifier ?? name) : null;
    resolution = resolutionForUnknown(
      serviceId,
      String(name),
      isAws
        ? `AWS resource '${rawIdentifier ?? name}' is not mapped to the current calculator catalog.`
        : "The component does not identify a current calculator service.",
      itemProvenance,
    );
  }

  return addComponent(state, {
    id: options.id ?? getCaseInsensitive(node, ["id", "logicalId", "address"]) ?? slug(name),
    originalId: options.originalId ?? getCaseInsensitive(node, ["id", "logicalId", "address", "name"]),
    sourceId: source.id,
    name: String(name),
    kind:
      getCaseInsensitive(node, ["kind", "componentKind"]) ??
      (nonPriced ? declaredKind : options.provider ? "resource" : "service"),
    description: getCaseInsensitive(node, ["description"]) ?? null,
    serviceId,
    resolution,
    scopeIds: scopesForNode(state, node, itemProvenance),
    region: getCaseInsensitive(node, ["region", "awsRegion", "aws_region"]) ?? null,
    environment: getCaseInsensitive(node, ["environment", "env", "stage"]) ?? null,
    quantity:
      getCaseInsensitive(node, [
        "quantity",
        "count",
        "instances",
        "multiplicity",
        "replicas",
        "desiredCount",
        "desired_count",
      ]) ??
      getCaseInsensitive(properties, [
        "quantity",
        "count",
        "instances",
        "multiplicity",
        "replicas",
        "desiredCount",
        "desired_count",
      ]) ??
      1,
    configuration: configurationFor(properties, node),
    usage: getCaseInsensitive(node, ["usage", "demand", "workload"]) ?? {},
    properties,
    provenance: itemProvenance,
    inclusion,
    sourceResourceType: options.sourceResourceType ?? rawIdentifier ?? null,
  });
}

function referencesIn(value, result = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b(?:Ref\s*:\s*)?([A-Za-z][A-Za-z0-9]{1,127})\b/g)) {
      if (/^(?:true|false|null|http|https|arn|aws)$/i.test(match[1])) continue;
      result.add(match[1]);
    }
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => referencesIn(item, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (typeof value.Ref === "string") result.add(value.Ref);
  if (Array.isArray(value["Fn::GetAtt"]) && typeof value["Fn::GetAtt"][0] === "string") {
    result.add(value["Fn::GetAtt"][0]);
  }
  if (typeof value["Fn::GetAtt"] === "string") result.add(value["Fn::GetAtt"].split(".")[0]);
  for (const nested of Object.values(value)) referencesIn(nested, result);
  return result;
}

function parseCloudFormationObject(state, source, object, basePath = "$") {
  const resources = getCaseInsensitive(object, ["Resources"]);
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return false;
  const pendingReferences = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== "object") continue;
    const type = getCaseInsensitive(resource, ["Type"]);
    if (!type) continue;
    const properties = getCaseInsensitive(resource, ["Properties"]) ?? {};
    addResolvedNode(state, source, `${basePath}.Resources.${logicalId}`, resource, {
      id: logicalId,
      originalId: logicalId,
      name: logicalId,
      identifier: type,
      properties,
      provider: "cloudformation",
      sourceResourceType: type,
      method: "cloudformation-resource",
    });
    pendingReferences.push({ logicalId, properties });
  }
  for (const { logicalId, properties } of pendingReferences) {
    const from = resolveOriginalComponentId(state, source.id, logicalId);
    for (const reference of referencesIn(properties)) {
      if (reference === logicalId) continue;
      const to = resolveOriginalComponentId(state, source.id, reference);
      if (!to) continue;
      addRelationship(state, {
        fromComponentId: from,
        toComponentId: to,
        type: "depends-on",
        provenance: provenance(
          [evidence(source.id, `${basePath}.Resources.${logicalId}.Properties`, reference)],
          1,
          "explicit",
        ),
      });
    }
  }
  return pendingReferences.length > 0;
}

function terraformResourceArrays(object, basePath = "$") {
  const results = [];
  const visitModule = (module, path) => {
    if (!module || typeof module !== "object") return;
    if (Array.isArray(module.resources)) {
      module.resources.forEach((resource, index) =>
        results.push({ resource, path: `${path}.resources[${index}]` }),
      );
    }
    if (Array.isArray(module.child_modules)) {
      module.child_modules.forEach((child, index) => visitModule(child, `${path}.child_modules[${index}]`));
    }
  };
  visitModule(object?.planned_values?.root_module, `${basePath}.planned_values.root_module`);
  visitModule(object?.values?.root_module, `${basePath}.values.root_module`);
  visitModule(object?.root_module, `${basePath}.root_module`);
  if (Array.isArray(object?.resource_changes)) {
    object.resource_changes.forEach((resource, index) =>
      results.push({
        resource: { ...resource, values: resource.change?.after ?? resource.values ?? {} },
        path: `${basePath}.resource_changes[${index}]`,
      }),
    );
  }
  return results;
}

function flattenTerraformJsonResources(object, basePath = "$") {
  const results = terraformResourceArrays(object, basePath);
  const resourceBlocks = getCaseInsensitive(object, ["resource"]);
  if (resourceBlocks && typeof resourceBlocks === "object" && !Array.isArray(resourceBlocks)) {
    for (const [type, named] of Object.entries(resourceBlocks)) {
      if (!named || typeof named !== "object") continue;
      for (const [name, values] of Object.entries(named)) {
        results.push({
          resource: { type, name, address: `${type}.${name}`, values },
          path: `${basePath}.resource.${type}.${name}`,
        });
      }
    }
  }
  const seen = new Set();
  return results.filter(({ resource }) => {
    const type = resource.type ?? resource.resource_type ?? "resource";
    const identity = resource.address ?? `${type}.${resource.name ?? "unnamed"}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function terraformReferencesIn(value, result = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b(aws_[a-z0-9_]+\.[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_*-]+)?/g)) {
      result.add(match[1]);
    }
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => terraformReferencesIn(item, result));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => terraformReferencesIn(item, result));
  }
  return result;
}

function parseTerraformObject(state, source, object, basePath = "$") {
  const resources = flattenTerraformJsonResources(object, basePath);
  if (!resources.length) return false;
  const pendingReferences = [];
  for (const { resource, path } of resources) {
    const type = resource.type ?? resource.resource_type;
    if (!type || !String(type).startsWith("aws_")) continue;
    const name = resource.name ?? resource.address ?? `${type}-${state.components.length + 1}`;
    const address = resource.address ?? `${type}.${name}`;
    const values = resource.values ?? resource.attributes ?? {};
    addResolvedNode(state, source, path, resource, {
      id: address,
      originalId: address,
      name,
      identifier: type,
      properties: values,
      provider: "terraform",
      sourceResourceType: type,
      method: "terraform-resource",
    });
    pendingReferences.push({ address, values, path });
  }
  for (const { address, values, path } of pendingReferences) {
    const from = resolveOriginalComponentId(state, source.id, address);
    for (const reference of terraformReferencesIn(values)) {
      const to = resolveOriginalComponentId(state, source.id, reference);
      if (!to || to === from) continue;
      addRelationship(state, {
        fromComponentId: from,
        toComponentId: to,
        type: "depends-on",
        provenance: provenance([evidence(source.id, path, reference)], 1, "explicit"),
      });
    }
  }
  return true;
}

function parseScalar(value) {
  const trimmed = String(value).trim().replace(/,$/, "");
  if (/^['"].*['"]$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item));
  }
  return trimmed;
}

function parseCloudFormationYaml(text) {
  const lines = text.split(/\r?\n/);
  const resourcesLine = lines.findIndex((line) => /^\s*Resources\s*:\s*(?:#.*)?$/i.test(line));
  if (resourcesLine < 0) return null;
  const resourceIndent = (lines[resourcesLine].match(/^\s*/) ?? [""])[0].length;
  const resources = {};
  let current = null;
  let currentIndent = null;
  let inProperties = false;
  let propertyIndent = null;
  for (let index = resourcesLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = (line.match(/^\s*/) ?? [""])[0].length;
    if (indent <= resourceIndent) break;
    const header = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(?:#.*)?$/);
    if (header && (currentIndent === null || indent <= currentIndent)) {
      current = header[1];
      currentIndent = indent;
      inProperties = false;
      resources[current] = { Properties: {} };
      continue;
    }
    if (!current) continue;
    const type = line.match(/^\s*Type\s*:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/i);
    if (type) {
      resources[current].Type = type[1].trim();
      continue;
    }
    if (/^\s*Properties\s*:\s*(?:#.*)?$/i.test(line)) {
      inProperties = true;
      propertyIndent = indent;
      continue;
    }
    if (inProperties && indent > propertyIndent) {
      const property = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
      if (property && property[2]) resources[current].Properties[property[1]] = parseScalar(property[2]);
    }
  }
  return Object.values(resources).some((resource) => resource.Type) ? { Resources: resources } : null;
}

function balancedBlock(text, openingBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length - 1;
}

function parseTerraformHcl(text) {
  const resourcePattern = /\bresource\s+"(aws_[a-z0-9_]+)"\s+"([^"]+)"\s*\{/gi;
  const resources = [];
  for (const match of text.matchAll(resourcePattern)) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    const closingBrace = balancedBlock(text, openingBrace);
    const body = text.slice(openingBrace + 1, closingBrace);
    const values = {};
    for (const assignment of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/gm)) {
      values[assignment[1]] = parseScalar(assignment[2]);
    }
    resources.push({
      type: match[1],
      name: match[2],
      address: `${match[1]}.${match[2]}`,
      values: { ...values, __hclBody: body },
    });
  }
  return resources.length ? { root_module: { resources } } : null;
}

function parseTextRelationships(state, source, text, locatedComponents, basePath) {
  for (const arrow of text.matchAll(/-->|->|=>|~>|→/g)) {
    const before = locatedComponents
      .filter((item) => item.end <= arrow.index && text.slice(item.end, arrow.index).indexOf("\n") < 0)
      .at(-1);
    const after = locatedComponents.find(
      (item) => item.start >= arrow.index + arrow[0].length && text.slice(arrow.index, item.start).indexOf("\n") < 0,
    );
    if (!before || !after) continue;
    addRelationship(state, {
      fromComponentId: before.component.id,
      toComponentId: after.component.id,
      type: "connects-to",
      provenance: provenance(
        [evidence(source.id, `${basePath}@${arrow.index}`, arrow[0])],
        0.9,
        "explicit",
      ),
    });
  }
}

function parseText(state, source, text, basePath = "$") {
  const matches = matchText(text);
  const unknowns = unknownAwsMatches(text, matches);
  const locatedComponents = [];
  for (const match of matches) {
    const inclusion = isNegated(text, match.start, match.end) ? "excluded" : "included";
    const itemProvenance = provenance(
      [
        evidence(source.id, `${basePath}@${match.start}-${match.end}`, match.matchedText, {
          matchMethod: match.method,
        }),
      ],
      match.confidence,
      match.method === "capability-phrase" ? "inferred" : "explicit",
    );
    let resolution;
    let serviceId = null;
    let name;
    if (match.serviceId) {
      serviceId = match.serviceId;
      name = match.serviceName;
      resolution = resolutionForKnown(serviceId, match.method, match.confidence, itemProvenance);
    } else {
      name = match.matchedText;
      resolution = resolutionForCandidates(match.candidates, match.method, itemProvenance);
    }
    const component = addComponent(state, {
      id: `${slug(name)}-${state.components.length + 1}`,
      sourceId: source.id,
      name,
      kind: "service",
      serviceId,
      resolution,
      quantity: quantityBefore(text, match.start),
      configuration: {},
      properties: {
        matchedText: match.matchedText,
        matchMethod: match.method,
      },
      provenance: itemProvenance,
      inclusion,
      sourceResourceType: null,
    });
    if (match.method === "capability-phrase") {
      const id = uniqueId(
        `assumption-${slug(match.matchedText)}-${slug(serviceId)}`,
        state.assumptionIds,
        "assumption",
      );
      state.assumptions.push({
        id,
        statement: `Interpreted '${match.matchedText}' as ${name}.`,
        status: "proposed",
        impact: "The service mapping affects pricing and should be confirmed if the phrase was generic.",
        appliesTo: [component.id],
        provenance: itemProvenance,
      });
    }
    locatedComponents.push({ ...match, component });
  }
  for (const match of unknowns) {
    const itemProvenance = provenance(
      [evidence(source.id, `${basePath}@${match.start}-${match.end}`, match.matchedText)],
      0,
      "explicit",
    );
    const isType = /^(?:AWS::|aws_)/.test(match.matchedText);
    const serviceId = openServiceId(match.matchedText);
    const component = addComponent(state, {
      id: `${slug(match.matchedText)}-${state.components.length + 1}`,
      sourceId: source.id,
      name: match.matchedText,
      kind: isType ? "resource" : "service",
      serviceId,
      resolution: resolutionForUnknown(
        serviceId,
        match.matchedText,
        "This AWS resource is not mapped to the current calculator catalog.",
        itemProvenance,
      ),
      quantity: quantityBefore(text, match.start),
      configuration: {},
      properties: { matchedText: match.matchedText },
      provenance: itemProvenance,
      inclusion: isNegated(text, match.start, match.end) ? "excluded" : "included",
      sourceResourceType: isType ? match.matchedText : null,
    });
    locatedComponents.push({ ...match, component });
  }
  locatedComponents.sort((left, right) => left.start - right.start);
  parseTextRelationships(state, source, text, locatedComponents, basePath);
  inferTextScopesAndBudget(state, source, text, basePath);
  return locatedComponents.length > 0;
}

function inferTextScopesAndBudget(state, source, text, basePath) {
  for (const match of text.matchAll(/\b(?:us|ca|sa|eu|ap|af|me)(?:-gov)?-[a-z]+-\d\b/gi)) {
    const itemProvenance = provenance(
      [evidence(source.id, `${basePath}@${match.index}`, match[0])],
      1,
      "explicit",
    );
    const scopeId = ensureScope(state, "region", match[0].toLowerCase(), itemProvenance);
    if (scopeId && !state.defaultScopeIds.includes(scopeId)) state.defaultScopeIds.push(scopeId);
  }
  const budgetPatterns = [
    /(?:budget|under|up to|target(?:ing)?)\s*(?:of|is|:)?\s*\$\s*([\d,.]+)\s*(?:\/|per\s*)?(?:month|monthly|mo)\b/i,
    /\$\s*([\d,.]+)\s*(?:\/|per\s*)?(?:month|monthly|mo)\b/i,
    /\b([\d,.]+)\s*k\s*(?:\/|per\s*)?(?:month|monthly|mo)\b/i,
  ];
  for (const pattern of budgetPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    let value = Number(String(match[1]).replace(/,/g, ""));
    if (/\bk\b/i.test(match[0]) && !/\$\s*[\d,.]+\s*k/i.test(match[0])) value *= 1000;
    if (/\$\s*[\d,.]+\s*k/i.test(match[0])) value *= 1000;
    if (value > 0) {
      addBudgetConstraint(
        state,
        value,
        "USD",
        provenance([evidence(source.id, `${basePath}@${match.index}`, match[0])], 0.95, "inferred"),
      );
      break;
    }
  }
}

function parseGraphEdges(state, source, edges, basePath) {
  if (!Array.isArray(edges)) return;
  edges.forEach((edge, index) => {
    if (!edge || typeof edge !== "object") return;
    const fromOriginal = getCaseInsensitive(edge, ["fromComponentId", "from", "source", "sourceId"]);
    const toOriginal = getCaseInsensitive(edge, ["toComponentId", "to", "target", "targetId"]);
    const from = resolveOriginalComponentId(state, source.id, fromOriginal);
    const to = resolveOriginalComponentId(state, source.id, toOriginal);
    if (!from || !to) return;
    addRelationship(state, {
      id: edge.id,
      fromComponentId: from,
      toComponentId: to,
      type: getCaseInsensitive(edge, ["type", "relationship", "kind"]) ?? "connects-to",
      description: edge.description ?? edge.label ?? null,
      properties: edge.properties ?? edge.metadata ?? {},
      provenance: provenance(
        [evidence(source.id, `${basePath}[${index}]`, edge)],
        1,
        "explicit",
      ),
    });
  });
}

function nodeCollections(object) {
  const result = [];
  for (const key of ["components", "nodes", "services", "resources"]) {
    const value = getCaseInsensitive(object, [key]);
    if (Array.isArray(value)) result.push({ key, nodes: value });
  }
  const serviceIds = getCaseInsensitive(object, ["serviceIds", "service_ids"]);
  if (Array.isArray(serviceIds)) {
    result.push({ key: "serviceIds", nodes: serviceIds.map((serviceId) => ({ serviceId })) });
  }
  for (const key of ["excludedServiceIds", "forbiddenServiceIds", "exclusions", "exclude"]) {
    const value = getCaseInsensitive(object, [key]);
    if (!Array.isArray(value)) continue;
    result.push({
      key,
      inclusion: "excluded",
      nodes: value.map((item) =>
        typeof item === "string" ? { serviceId: item, name: item } : item,
      ),
    });
  }
  return result;
}

function parseStructuredObject(state, source, object, basePath = "$") {
  if (!object || typeof object !== "object") return false;
  const title = getCaseInsensitive(object, ["title", "architectureName"]);
  const name = getCaseInsensitive(object, ["name"]);
  const summary = getCaseInsensitive(object, ["summary"]);
  if (!state.title && typeof (title ?? name) === "string") state.title = title ?? name;
  if (!state.summary && typeof summary === "string") state.summary = summary;
  extractStructuredMetadata(state, source, object, basePath);

  let parsed = false;
  parsed = parseCloudFormationObject(state, source, object, basePath) || parsed;
  parsed = parseTerraformObject(state, source, object, basePath) || parsed;
  const collections = nodeCollections(object);
  for (const { key, nodes, inclusion } of collections) {
    nodes.forEach((node, index) => {
      if (typeof node === "string") {
        addResolvedNode(
          state,
          source,
          `${basePath}.${key}[${index}]`,
          { serviceId: node, name: node },
          { inclusion },
        );
      } else if (node && typeof node === "object") {
        addResolvedNode(state, source, `${basePath}.${key}[${index}]`, node, { inclusion });
      }
    });
    parsed = parsed || nodes.length > 0;
  }
  if (collections.length) {
    const edges = getCaseInsensitive(object, ["relationships", "edges", "connections"]);
    parseGraphEdges(state, source, edges, `${basePath}.relationships`);
  }

  if (!parsed) {
    const looksLikeNode = ["serviceId", "resourceType", "type", "service", "calculatorServiceCode"].some(
      (key) => getCaseInsensitive(object, [key]) !== undefined,
    );
    if (looksLikeNode) {
      addResolvedNode(state, source, basePath, object);
      parsed = true;
    }
  }
  if (!parsed) {
    for (const key of ["brief", "description", "summary", "architecture"]) {
      const value = getCaseInsensitive(object, [key]);
      if (typeof value === "string") parsed = parseText(state, source, value, `${basePath}.${key}`) || parsed;
    }
  }
  return parsed;
}

function parseSource(state, source) {
  const content = source.content;
  if (Array.isArray(content)) {
    content.forEach((item, index) => {
      if (typeof item === "string") parseText(state, source, item, `$[${index}]`);
      else if (item && typeof item === "object") parseStructuredObject(state, source, item, `$[${index}]`);
    });
    return;
  }
  if (content && typeof content === "object") {
    parseStructuredObject(state, source, content);
    return;
  }
  const text = String(content ?? "");
  if (!text.trim()) return;
  if (source.formatHint?.includes("json") || /^[{[]/.test(text.trim())) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        parseStructuredObject(state, source, parsed);
        return;
      }
    } catch {
      // Malformed JSON is still valuable as natural-language evidence.
    }
  }
  if (source.formatHint?.includes("cloudformation") || /^\s*Resources\s*:/m.test(text)) {
    const parsed = parseCloudFormationYaml(text);
    if (parsed && parseCloudFormationObject(state, source, parsed)) return;
  }
  if (source.formatHint === "terraform" || /\bresource\s+"aws_[a-z0-9_]+"\s+"/i.test(text)) {
    const parsed = parseTerraformHcl(text);
    if (parsed && parseTerraformObject(state, source, parsed)) return;
  }
  parseText(state, source, text);
  if (!state.summary) state.summary = excerpt(text);
}

function addBudgetConstraint(state, monthlyUsd, currency, itemProvenance) {
  const value = asPositiveNumber(monthlyUsd, 0);
  if (!value) return null;
  const existing = state.budgetValues.find((item) => item.value === value && item.currency === currency);
  if (existing) return existing.constraintId;
  const id = uniqueId("constraint-monthly-budget", state.constraintIds, "constraint");
  state.constraints.push({
    id,
    kind: "budget",
    type: "budget",
    statement: `Target monthly spend is ${currency} ${value}.`,
    appliesTo: [],
    value: { amount: value, currency, period: "month", monthlyUsd: currency === "USD" ? value : null },
    monthlyUsd: currency === "USD" ? value : null,
    operator: "target",
    provenance: itemProvenance,
  });
  state.budgetValues.push({ value, currency, constraintId: id, provenance: itemProvenance });
  return id;
}

function extractBudget(value) {
  if (typeof value === "number") return { amount: value, currency: "USD" };
  if (!value || typeof value !== "object") return null;
  const amount = getCaseInsensitive(value, ["monthlyUsd", "targetMonthlyUsd", "amount", "value"]);
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return null;
  return {
    amount: Number(amount),
    currency: String(getCaseInsensitive(value, ["currency"]) ?? "USD").toUpperCase(),
  };
}

function extractStructuredMetadata(state, source, object, basePath) {
  const itemProvenance = provenance([evidence(source.id, basePath, object)], 1, "explicit");
  const regionValues = [
    getCaseInsensitive(object, ["region", "awsRegion", "aws_region"]),
    getCaseInsensitive(object, ["regions"]),
  ].flatMap((value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]));
  const environmentValues = [
    getCaseInsensitive(object, ["environment", "env", "stage"]),
    getCaseInsensitive(object, ["environments"]),
  ].flatMap((value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]));
  for (const value of regionValues) {
    const id = ensureScope(state, "region", value, itemProvenance);
    if (id && !state.defaultScopeIds.includes(id)) state.defaultScopeIds.push(id);
  }
  for (const value of environmentValues) {
    const id = ensureScope(state, "environment", value, itemProvenance);
    if (id && !state.defaultScopeIds.includes(id)) state.defaultScopeIds.push(id);
  }
  const directBudget = getCaseInsensitive(object, ["targetMonthlyUsd", "monthlyBudgetUsd"]);
  const budget = directBudget !== undefined ? { amount: directBudget, currency: "USD" } : extractBudget(getCaseInsensitive(object, ["budget"]));
  if (budget) addBudgetConstraint(state, budget.amount, budget.currency, itemProvenance);

  const rawConstraints = getCaseInsensitive(object, ["constraints"]);
  if (Array.isArray(rawConstraints)) {
    rawConstraints.forEach((constraint, index) => addRawConstraint(state, source, constraint, `${basePath}.constraints[${index}]`));
  }
  const rawAssumptions = getCaseInsensitive(object, ["assumptions"]);
  if (Array.isArray(rawAssumptions)) {
    rawAssumptions.forEach((assumption, index) =>
      addRawAssumption(state, source, assumption, `${basePath}.assumptions[${index}]`),
    );
  }
}

function addRawConstraint(state, source, constraint, locator) {
  const itemProvenance = provenance([evidence(source.id, locator, constraint)], 1, "explicit");
  const object = constraint && typeof constraint === "object" ? constraint : {};
  const statement = typeof constraint === "string" ? constraint : object.statement ?? object.description ?? stableStringify(constraint);
  const id = uniqueId(object.id ?? `constraint-${slug(statement)}`, state.constraintIds, "constraint");
  state.constraints.push({
    id,
    kind: object.kind ?? object.type ?? "requirement",
    type: object.type ?? object.kind ?? "requirement",
    statement,
    appliesTo: Array.isArray(object.appliesTo) ? object.appliesTo.map(String) : [],
    value: object.value ?? clone(constraint),
    provenance: itemProvenance,
  });
}

function addRawAssumption(state, source, assumption, locator) {
  const object = assumption && typeof assumption === "object" ? assumption : {};
  const statement = typeof assumption === "string" ? assumption : object.statement ?? object.description ?? stableStringify(assumption);
  const id = uniqueId(object.id ?? `assumption-${slug(statement)}`, state.assumptionIds, "assumption");
  state.assumptions.push({
    id,
    statement,
    status: object.status ?? "proposed",
    impact: object.impact ?? null,
    appliesTo: Array.isArray(object.appliesTo) ? object.appliesTo.map(String) : [],
    provenance: provenance([evidence(source.id, locator, assumption)], 1, "explicit"),
  });
}

function initializeContext(state) {
  const contextEvidence = evidence(null, "$.context", state.context);
  const contextProvenance = provenance([contextEvidence], 1, "context");
  const regions = [state.context.region, ...arrayOf(state.context.regions)].filter(Boolean);
  const environments = [
    ...arrayOf(state.context.environments),
    ...(state.context.environment ? [state.context.environment] : []),
  ];
  for (const region of regions) {
    const id = ensureScope(state, "region", region, contextProvenance);
    if (id) state.defaultScopeIds.push(id);
  }
  for (const environment of environments) {
    const id = ensureScope(state, "environment", environment, contextProvenance);
    if (id) state.defaultScopeIds.push(id);
  }
  const accountValues = [state.context.accountId, ...arrayOf(state.context.accounts)].filter(Boolean);
  for (const account of accountValues) {
    const id = ensureScope(state, "account", account, contextProvenance);
    if (id) state.defaultScopeIds.push(id);
  }
  const budget = state.context.targetMonthlyUsd
    ? { amount: state.context.targetMonthlyUsd, currency: "USD" }
    : extractBudget(state.context.budget);
  if (budget) addBudgetConstraint(state, budget.amount, budget.currency, contextProvenance);
}

function addExclusionConstraints(state) {
  for (const component of state.components.filter((item) => item.inclusion === "excluded")) {
    const id = uniqueId(`constraint-exclude-${component.serviceId ?? component.id}`, state.constraintIds, "constraint-exclusion");
    state.constraints.push({
      id,
      kind: "exclusion",
      type: "exclusion",
      statement: `Exclude ${component.name}.`,
      appliesTo: [component.id],
      value: { serviceId: component.serviceId, excluded: true },
      serviceId: component.serviceId,
      operator: "exclude",
      provenance: component.provenance,
    });
  }
}

function addDetectedConflicts(state) {
  const includedByService = new Map();
  const excludedByService = new Map();
  for (const component of state.components) {
    const key = component.serviceId ?? component.resolution?.candidates?.map((item) => item.serviceId).join("|");
    if (!key) continue;
    const map = component.inclusion === "excluded" ? excludedByService : includedByService;
    const values = map.get(key) ?? [];
    values.push(component);
    map.set(key, values);
  }
  for (const [serviceId, included] of includedByService) {
    const excluded = excludedByService.get(serviceId);
    if (!excluded) continue;
    const appliesTo = [...included, ...excluded].map((component) => component.id);
    const id = uniqueId(`conflict-inclusion-${slug(serviceId)}`, state.conflictIds, "conflict");
    state.conflicts.push({
      id,
      description: `${serviceId} is both included and excluded.`,
      severity: "blocking",
      appliesTo,
      provenance: [...included, ...excluded].map((component) => component.provenance),
      kind: "inclusion-exclusion",
    });
  }
  const budgets = [...new Set(state.budgetValues.map((item) => `${item.currency}:${item.value}`))];
  if (budgets.length > 1) {
    const id = uniqueId("conflict-monthly-budget", state.conflictIds, "conflict");
    state.conflicts.push({
      id,
      description: `Multiple monthly budgets were supplied: ${budgets.join(", ")}.`,
      severity: "blocking",
      appliesTo: state.budgetValues.map((item) => item.constraintId),
      provenance: state.budgetValues.map((item) => item.provenance),
      kind: "budget",
    });
  }
}

function buildUnresolved(state) {
  for (const component of state.components) {
    if (component.inclusion === "excluded") continue;
    if (!component.resolution || component.resolution.status === "resolved") continue;
    const candidates = component.resolution.candidates.map((candidate) => candidate.serviceId);
    const id = uniqueId(`unresolved-${component.id}`, state.unresolvedIds, "unresolved");
    state.unresolved.push({
      id,
      componentId: component.id,
      path: `components.${component.id}.serviceId`,
      description:
        component.resolution.status === "ambiguous"
          ? `${component.name} could map to more than one calculator service.`
          : `${component.name} is not resolved to a current calculator service.`,
      blocking: true,
      candidateValues: candidates,
      candidates,
      provenance: component.provenance,
      reason: component.resolution.status,
    });
  }
}

function pricingInputCoverage(state, included) {
  const usageBased = included.filter((component) => {
    const serviceId = component.resolution?.serviceId ?? component.serviceId;
    return universalServiceById(serviceId)?.universalPricingMode === "usage";
  });
  const budgetBased = included.filter((component) => !usageBased.includes(component));
  const missingUsage = usageBased.filter(
    (component) =>
      !component.usage ||
      typeof component.usage !== "object" ||
      Object.keys(component.usage).length === 0,
  );
  const hasBudget = state.budgetValues.length > 0;
  const budgetReady = budgetBased.length === 0 || hasBudget;
  const usageReady = missingUsage.length === 0;

  return {
    usageBased,
    budgetBased,
    missingUsage,
    hasBudget,
    hasUsage: usageBased.length > 0 && usageReady,
    ready: budgetReady && usageReady,
  };
}

function buildQuestions(state) {
  const included = state.components.filter((component) => component.inclusion !== "excluded");
  const pricingInputs = pricingInputCoverage(state, included);
  if (!included.length) {
    state.questions.push({
      id: "question.architecture-definition",
      prompt: "Which AWS services or resources are part of the architecture?",
      blocking: true,
      priority: "high",
      relatedIds: [],
      answerHint: "Provide prose, service IDs, a node/edge graph, CloudFormation, or Terraform.",
    });
  }
  if (!state.scopes.some((scope) => scope.kind === "region")) {
    state.questions.push({
      id: "question.region",
      prompt: "Which AWS region or regions should this architecture use?",
      blocking: true,
      priority: "high",
      relatedIds: included.map((component) => component.id),
      answerHint: "For example: us-east-1.",
    });
  }
  if (!pricingInputs.hasBudget && pricingInputs.budgetBased.length > 0) {
    state.questions.push({
      id: "question.monthly-budget",
      prompt: "What monthly budget or target spend should pricing use?",
      blocking: true,
      priority: "high",
      relatedIds: pricingInputs.budgetBased.map((component) => component.id),
      answerHint: "Provide an amount and currency per month.",
    });
  }
  for (const component of pricingInputs.missingUsage) {
    state.questions.push({
      id: `question.usage-${slug(component.id)}`,
      prompt: `What workload usage should pricing use for '${component.name}'?`,
      blocking: true,
      priority: "high",
      relatedIds: [component.id],
      answerHint: "Provide the service-specific request, token, duration, storage, or throughput facts.",
    });
  }
  for (const unresolved of state.unresolved) {
    state.questions.push({
      id: `question.${unresolved.id}`,
      prompt: unresolved.candidateValues.length
        ? `Which service should '${state.components.find((item) => item.id === unresolved.componentId)?.name}' map to?`
        : `How should '${state.components.find((item) => item.id === unresolved.componentId)?.name}' be priced or represented?`,
      blocking: true,
      priority: "high",
      relatedIds: [unresolved.componentId],
      answerHint: unresolved.candidateValues.length ? unresolved.candidateValues.join(", ") : null,
    });
  }
  for (const conflict of state.conflicts) {
    state.questions.push({
      id: `question.${conflict.id}`,
      prompt: `Please resolve this conflict: ${conflict.description}`,
      blocking: conflict.severity === "blocking",
      priority: "high",
      relatedIds: [...conflict.appliesTo],
      answerHint: null,
    });
  }
}

function buildCoverage(state) {
  const included = state.components.filter((component) => component.inclusion !== "excluded");
  const resolved = included.filter((component) => component.resolution?.status === "resolved");
  const componentScore = included.length ? resolved.length / included.length : 0;
  const hasRegion = state.scopes.some((scope) => scope.kind === "region");
  const pricingInputs = pricingInputCoverage(state, included);
  const { hasBudget } = pricingInputs;
  const gaps = [];
  if (!included.length) gaps.push("No included architecture components were identified.");
  if (state.unresolved.length) gaps.push(`${state.unresolved.length} component(s) require service resolution.`);
  if (!hasRegion) gaps.push("AWS region is missing.");
  if (!pricingInputs.hasBudget && pricingInputs.budgetBased.length > 0) {
    gaps.push("Monthly budget is missing for budget-driven components.");
  }
  if (pricingInputs.missingUsage.length > 0) {
    gaps.push(
      `${pricingInputs.missingUsage.length} usage-priced component(s) require workload facts.`,
    );
  }
  if (state.conflicts.length) gaps.push(`${state.conflicts.length} conflict(s) require resolution.`);
  const score = Math.max(
    0,
    Math.min(
      1,
      componentScore * 0.6 + (hasRegion ? 0.2 : 0) + (pricingInputs.ready ? 0.2 : 0),
    ),
  );
  const status =
    state.conflicts.length > 0
      ? "conflicted"
      : !included.length
        ? "empty"
        : state.unresolved.length || !hasRegion || !pricingInputs.ready
          ? "partial"
          : "complete";
  return {
    status,
    score,
    componentCount: state.components.length,
    includedComponentCount: included.length,
    excludedComponentCount: state.components.length - included.length,
    resolvedComponentCount: resolved.length,
    relationshipCount: state.relationships.length,
    unresolvedCount: state.unresolved.length,
    dimensions: [
      {
        name: "components",
        status: included.length && componentScore === 1 ? "complete" : included.length ? "partial" : "missing",
        score: componentScore,
        gaps: state.unresolved.map((item) => item.description),
      },
      {
        name: "region",
        status: hasRegion ? "complete" : "missing",
        score: hasRegion ? 1 : 0,
        gaps: hasRegion ? [] : ["AWS region is missing."],
      },
      {
        name: "pricing-inputs",
        status: pricingInputs.ready ? "complete" : "missing",
        score: pricingInputs.ready ? 1 : 0,
        gaps: [
          ...(!pricingInputs.hasBudget && pricingInputs.budgetBased.length > 0
            ? ["Monthly budget is missing for budget-driven components."]
            : []),
          ...pricingInputs.missingUsage.map(
            (component) => `Workload usage is missing for '${component.name}'.`,
          ),
        ],
      },
      {
        name: "relationships",
        status: included.length < 2 || state.relationships.length ? "observed" : "unspecified",
        score: included.length < 2 ? 1 : state.relationships.length ? 1 : 0,
        gaps: included.length >= 2 && !state.relationships.length ? ["Relationships were not specified."] : [],
      },
    ],
    gaps,
    pricingReady: status === "complete",
    hasRegion,
    hasBudget,
    hasUsage: pricingInputs.hasUsage,
    hasPricingInputs: pricingInputs.ready,
  };
}

function finalizeScopeAssignments(state) {
  // Text sources can reveal a region after their components were emitted. Apply an architecture-wide
  // single region only when no component-level region was present; multi-region remains explicit.
  const regions = state.scopes.filter((scope) => scope.kind === "region");
  if (regions.length === 1) {
    const region = regions[0];
    for (const component of state.components) {
      if (component.region || component.scopeIds.some((id) => state.scopes.find((scope) => scope.id === id)?.kind === "region")) continue;
      component.region = region.properties.region;
      component.scopeIds.push(region.id);
      if (!region.componentIds.includes(component.id)) region.componentIds.push(component.id);
    }
  }
}

/**
 * Interpret prose, structured graphs, CloudFormation, and Terraform into a provenance-aware,
 * deliberately partial architecture graph. The interpreter only records observed resources;
 * inferred service mappings never add architecture components that were absent from the evidence.
 */
export function interpretArchitecture(input = {}) {
  let normalizedInput =
    input && typeof input === "object" && !Array.isArray(input) ? input : { definition: input };
  const directDefinitionKeys = [
    "Resources",
    "resource",
    "root_module",
    "planned_values",
    "components",
    "nodes",
    "services",
    "serviceIds",
    "brief",
  ];
  if (
    !Object.prototype.hasOwnProperty.call(normalizedInput, "definition") &&
    !Array.isArray(normalizedInput.sources) &&
    directDefinitionKeys.some((key) => getCaseInsensitive(normalizedInput, [key]) !== undefined)
  ) {
    const directDefinition = normalizedInput;
    normalizedInput = {
      definition: directDefinition,
      ...(directDefinition.context ? { context: directDefinition.context } : {}),
      ...(directDefinition.assumptionsPolicy
        ? { assumptionsPolicy: directDefinition.assumptionsPolicy }
        : {}),
    };
  }
  const context = normalizedInput.context && typeof normalizedInput.context === "object" ? normalizedInput.context : {};
  const sources = normalizeSources(normalizedInput);
  const state = makeState(sources, context, normalizedInput);
  initializeContext(state);
  for (const source of sources) parseSource(state, source);
  finalizeScopeAssignments(state);
  addExclusionConstraints(state);
  addDetectedConflicts(state);
  buildUnresolved(state);
  buildQuestions(state);
  const coverage = buildCoverage(state);
  const architectureId = String(
    normalizedInput.architectureId ??
      context.architectureId ??
      `architecture-${digest({ sources: sources.map((source) => ({ id: source.id, content: source.content })), context }, 16)}`,
  );
  const sourceEvidence = sources.map((source) =>
    evidence(source.id, source.metadata?.locator ?? null, source.content),
  );
  const rootProvenance = provenance(sourceEvidence, sources.length ? 1 : 0, sources.length > 1 ? "mixed" : "explicit");
  const architectureRef = {
    contractVersion: CONTRACT_VERSION,
    kind: "architecture_ref",
    architectureId,
    revision: null,
    token: `archref_${digest({ architectureId, sourceDigests: sources.map((source) => digest(source.content)), context }, 32)}`,
  };

  return {
    contractVersion: CONTRACT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    kind: "architecture_ir",
    architectureId,
    architectureRef,
    status: coverage.status,
    title: state.title,
    summary: state.summary,
    sources: sources.map(sourceDescriptor),
    components: state.components,
    relationships: state.relationships,
    scopes: state.scopes,
    constraints: state.constraints,
    assumptions: state.assumptions,
    conflicts: state.conflicts,
    unresolved: state.unresolved,
    unresolvedComponents: state.unresolved,
    questions: state.questions,
    coverage,
    provenance: rootProvenance,
  };
}

export default interpretArchitecture;
