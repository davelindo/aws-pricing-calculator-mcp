import { evaluateDisplayCondition, referencedInputIds } from "./condition-evaluator.js";
import { generateInputQuestions } from "./questions.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "of",
  "per",
  "the",
  "value",
  "estimated",
]);

const CONCEPT_PATTERNS = [
  ["operating-system", /\b(?:operating system|operating-system|os|platform os)\b/],
  ["instance-type", /\b(?:instance type|instance class|machine type|vm type|node type)\b/],
  ["instance-count", /\b(?:instance count|number instances|instances|server count|node count|replicas|quantity|count)\b/],
  ["storage-class", /\b(?:storage class|volume type|disk type|storage tier)\b/],
  ["storage-size", /\b(?:storage|storage size|storage amount|storage capacity|allocated storage|disk size|volume size|storage gb|size gb|capacity gb)\b/],
  ["iops", /\b(?:iops|input output operations)\b/],
  ["throughput", /\b(?:throughput|mbps|gbps)\b/],
  ["hours", /\b(?:hours per month|monthly hours|instance hours|hours)\b/],
  ["utilization", /\b(?:utilization|usage percent|utilisation)\b/],
  ["requests", /\b(?:request count|monthly requests|requests)\b/],
  ["data-transfer", /\b(?:data transfer|transfer gb|egress|ingress)\b/],
  ["region", /\b(?:aws region|region)\b/],
  ["pricing-model", /\b(?:pricing model|purchase option|pricing strategy|commitment)\b/],
];

const STORAGE_FACTORS = {
  b: 1 / 1_000_000_000,
  byte: 1 / 1_000_000_000,
  bytes: 1 / 1_000_000_000,
  kb: 1 / 1_000_000,
  kib: 1024 / 1_000_000_000,
  mb: 1 / 1000,
  mib: (1024 * 1024) / 1_000_000_000,
  gb: 1,
  gib: (1024 ** 3) / 1_000_000_000,
  tb: 1000,
  tib: (1024 ** 4) / 1_000_000_000,
  pb: 1_000_000,
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function normalizeBindingId(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function semanticTokens(value) {
  return normalizeBindingId(value)
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
}

function semanticConcept(value) {
  const normalized = normalizeBindingId(value);
  return CONCEPT_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

function provenanceFrom(source, confidence = 1, mode = "bound") {
  const provenance = source?.provenance ?? source ?? {};
  const sourceConfidence = Number(provenance.confidence ?? 1);
  return {
    mode,
    sourceIds: [...new Set(provenance.sourceIds ?? [])],
    evidence: clone(provenance.evidence ?? []),
    confidence: Math.max(0, Math.min(1, sourceConfidence * confidence)),
  };
}

function publishedDefaultProvenance(definition, input) {
  const sourcePath = input.sourcePath ?? definition.sourcePath ?? null;
  return {
    mode: "published-default",
    sourceIds: definition.id ? [String(definition.id)] : [],
    evidence: [
      {
        sourceId: definition.id ? String(definition.id) : null,
        locator: sourcePath,
        excerpt: input.defaultValue === undefined ? null : JSON.stringify(input.defaultValue),
      },
    ],
    confidence: 1,
  };
}

function isNativeValue(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}

function factUnitFromKey(key) {
  const tokens = semanticTokens(key);
  return tokens.find((token) => token in STORAGE_FACTORS || ["hours", "hour", "iops", "mbps", "gbps", "percent", "pct"].includes(token)) ?? null;
}

function extractFacts(component) {
  const facts = [];
  const baseProvenance = component?.provenance ?? null;
  let sequence = 0;

  const add = (key, path, value, unit, sourceKind, ownProvenance = null) => {
    if (value === undefined || value === null || value === "") return;
    facts.push({
      id: `fact-${++sequence}`,
      key,
      normalizedKey: normalizeBindingId(key),
      path,
      value,
      unit: unit ?? factUnitFromKey(key),
      sourceKind,
      provenance: clone(ownProvenance ?? baseProvenance),
    });
  };

  const walk = (value, path, key, sourceKind) => {
    if (value === undefined || value === null) return;
    if (isNativeValue(value)) {
      add(key, path, value.value, value.unit ?? null, sourceKind, value.provenance);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") walk(item, `${path}[${index}]`, key, sourceKind);
        else add(key, `${path}[${index}]`, item, null, sourceKind);
      });
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        if (["provenance", "evidence", "sourceIds"].includes(childKey)) continue;
        walk(child, `${path}.${childKey}`, childKey, sourceKind);
      }
      return;
    }
    add(key, path, value, null, sourceKind);
  };

  for (const root of ["configuration", "usage", "properties"]) {
    const value = component?.[root];
    if (value && typeof value === "object") walk(value, root, root, root);
  }
  for (const key of ["region", "environment", "quantity", "description"]) {
    if (component?.[key] !== undefined && component?.[key] !== null) {
      add(key, key, component[key], null, "component");
    }
  }
  return facts;
}

function normalizeOptions(values) {
  if (!Array.isArray(values)) return [];
  return values.map((option) =>
    option && typeof option === "object"
      ? {
          ...option,
          id: String(option.id ?? option.value ?? option.key ?? option.label ?? ""),
          label: String(option.label ?? option.name ?? option.title ?? option.id ?? option.value ?? ""),
          aliases: Array.isArray(option.aliases) ? option.aliases.map(String) : [],
        }
      : { id: String(option), label: String(option), aliases: [] },
  );
}

function normalizeUnits(values) {
  if (!Array.isArray(values)) return [];
  return values.map((unit) =>
    unit && typeof unit === "object"
      ? {
          ...unit,
          id: String(unit.id ?? unit.value ?? unit.key ?? unit.label ?? ""),
          label: String(unit.label ?? unit.name ?? unit.id ?? unit.value ?? ""),
        }
      : { id: String(unit), label: String(unit) },
  );
}

export function normalizeBindableInputs(definition = {}) {
  let inputs = Array.isArray(definition.inputs) ? definition.inputs : null;
  if (!inputs && Array.isArray(definition.templates) && definition.templates.length === 1) {
    inputs = definition.templates[0]?.inputs ?? null;
  }
  if (!inputs && Array.isArray(definition.components)) {
    inputs = definition.components.filter(
      (component) => component?.type === "input" || component?.inputType || component?.subType,
    );
  }
  if (!inputs && definition.componentById && typeof definition.componentById === "object") {
    inputs = Object.values(definition.componentById).filter(
      (component) => component?.type === "input" || component?.inputType || component?.subType,
    );
  }

  return (inputs ?? []).map((input, index) => {
    const publishedOptions = normalizeOptions(input.options ?? input.choices ?? input.values);
    const frequency = normalizeBindingId(input.subType) === "frequency";
    return {
      ...input,
      id: String(input.id ?? input.key ?? input.componentId ?? `input-${index + 1}`),
      label: String(input.label ?? input.name ?? input.title ?? input.id ?? `Input ${index + 1}`),
      aliases: Array.isArray(input.aliases) ? input.aliases.map(String) : [],
      options: frequency ? [] : publishedOptions,
      units: normalizeUnits(input.units?.length ? input.units : frequency ? publishedOptions : []),
      defaultValue:
        input.defaultValue !== undefined
          ? input.defaultValue
          : input.default !== undefined
            ? input.default
            : undefined,
      defaultUnit: input.defaultUnit ?? input.unit ?? undefined,
      validations: input.validations ?? input.validation ?? {},
    };
  });
}

function inputTerms(input) {
  return [input.id, input.label, ...(input.aliases ?? [])]
    .map((value) => normalizeBindingId(value))
    .filter(Boolean);
}

function keyScore(input, fact) {
  const terms = inputTerms(input);
  if (terms.includes(fact.normalizedKey)) return 1;
  const factTokens = semanticTokens(fact.normalizedKey);

  for (const term of terms) {
    const termTokens = semanticTokens(term);
    if (
      termTokens.length &&
      factTokens.length &&
      termTokens.length === factTokens.length &&
      termTokens.every((token) => factTokens.includes(token))
    ) {
      return 0.97;
    }
    if (
      Math.min(termTokens.length, factTokens.length) >= 2 &&
      (termTokens.every((token) => factTokens.includes(token)) ||
        factTokens.every((token) => termTokens.includes(token)))
    ) {
      return 0.9;
    }
  }

  const inputConcept = semanticConcept(terms.join(" "));
  const factConcept = semanticConcept(fact.normalizedKey);
  return inputConcept && inputConcept === factConcept ? 0.84 : 0;
}

function phrasePresent(text, phrase) {
  const haystack = ` ${normalizeBindingId(text)} `;
  const needle = ` ${normalizeBindingId(phrase)} `;
  return needle.trim().length >= 2 && haystack.includes(needle);
}

function optionForValue(input, rawValue) {
  const selected =
    rawValue && typeof rawValue === "object"
      ? rawValue.selectedId ?? rawValue.id ?? rawValue.value ?? rawValue.label
      : rawValue;
  const normalized = normalizeBindingId(selected);
  const matches = input.options.filter((option) =>
    [option.id, option.label, ...(option.aliases ?? [])].some(
      (value) => normalizeBindingId(value) === normalized,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function numericToken(text, concept) {
  const patterns = {
    "instance-count": /(\d+(?:\.\d+)?)\s*(?:instances?|servers?|nodes?|vms?|replicas?)/i,
    "storage-size": /(\d+(?:[,.]\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib|pb)\b/i,
    iops: /(\d+(?:[,.]\d+)?)\s*iops\b/i,
    throughput: /(\d+(?:[,.]\d+)?)\s*(mbps|gbps)\b/i,
    hours: /(\d+(?:\.\d+)?)\s*hours?\b/i,
    utilization: /(\d+(?:\.\d+)?)\s*(%|percent|pct)\b/i,
  };
  const pattern = patterns[concept];
  if (!pattern) return null;
  const match = text.match(pattern);
  if (!match) return null;
  return {
    value: Number(match[1].replace(/,/g, "")),
    unit: match[2] ?? null,
  };
}

function candidateFacts(input, facts) {
  const candidates = [];
  for (const fact of facts) {
    const score = keyScore(input, fact);
    if (score > 0) candidates.push({ fact, rawValue: fact.value, unit: fact.unit, score, method: score === 1 ? "normalized-id" : "semantic-key" });
  }

  if (input.options.length) {
    for (const fact of facts.filter((item) => typeof item.value === "string")) {
      for (const option of input.options) {
        const terms = [option.id, option.label, ...(option.aliases ?? [])].filter(
          (term) => normalizeBindingId(term).length >= 2,
        );
        if (terms.some((term) => phrasePresent(fact.value, term))) {
          candidates.push({ fact, rawValue: option.id, unit: null, score: 0.76, method: "option-token" });
        }
      }
    }
  }

  const concept = semanticConcept(inputTerms(input).join(" "));
  if (concept) {
    for (const fact of facts.filter((item) => typeof item.value === "string")) {
      const parsed = numericToken(fact.value, concept);
      if (parsed) candidates.push({ fact, rawValue: parsed.value, unit: parsed.unit, score: 0.72, method: "numeric-token" });
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.fact.path.localeCompare(right.fact.path));
}

function inputKind(input) {
  const kind = normalizeBindingId(`${input.subType ?? ""} ${input.inputType ?? ""} ${input.dataType ?? ""}`);
  if (/number|numeric|integer|decimal|quantity|frequency|duration|file size|throughput|utilization|percent/.test(kind)) return "number";
  if (input.options.length || /dropdown|select|radio|option/.test(kind)) return "select";
  if (/boolean|checkbox|toggle/.test(kind)) return "boolean";
  return "text";
}

function normalizedUnit(value) {
  return normalizeBindingId(String(value ?? "").split("|")[0]);
}

function matchingUnit(input, factUnit) {
  const normalized = normalizedUnit(factUnit);
  return input.units.find(
    (unit) =>
      normalizedUnit(unit.id) === normalized || normalizedUnit(unit.label) === normalized,
  );
}

function storageConversion(value, from, to) {
  const fromFactor = STORAGE_FACTORS[normalizedUnit(from)];
  const toFactor = STORAGE_FACTORS[normalizedUnit(to)];
  return fromFactor && toFactor ? (Number(value) * fromFactor) / toFactor : null;
}

function coerceCandidate(input, candidate, { allowDefaultUnit = false } = {}) {
  const kind = inputKind(input);
  let value = candidate.rawValue;
  let unit = candidate.unit;

  if (kind === "select") {
    const option = optionForValue(input, value);
    if (!option) return { valid: false, reason: `Value '${value}' is not a published option.` };
    return { valid: true, value: option.id, nativeValue: option.id, selectedOption: option };
  }

  if (kind === "number") {
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(parsed)) return { valid: false, reason: `Value '${value}' is not numeric.` };
    value = parsed;
  } else if (kind === "boolean") {
    if (typeof value !== "boolean") {
      const normalized = normalizeBindingId(value);
      if (["true", "yes", "on", "enabled"].includes(normalized)) value = true;
      else if (["false", "no", "off", "disabled"].includes(normalized)) value = false;
      else return { valid: false, reason: `Value '${value}' is not boolean.` };
    }
  }

  if (input.units.length) {
    let selectedUnit = unit ? matchingUnit(input, unit) : null;
    if (unit && !selectedUnit && input.defaultUnit) {
      const converted = storageConversion(value, unit, input.defaultUnit);
      if (converted !== null) {
        value = converted;
        selectedUnit = matchingUnit(input, input.defaultUnit) ?? { id: input.defaultUnit, label: input.defaultUnit };
      }
    }
    if (unit && !selectedUnit) {
      return { valid: false, reason: `Unit '${unit}' is not accepted by '${input.label}'.` };
    }
    if (!selectedUnit && input.units.length === 1) selectedUnit = input.units[0];
    if (!selectedUnit && input.defaultUnit && allowDefaultUnit) {
      selectedUnit = matchingUnit(input, input.defaultUnit) ?? { id: input.defaultUnit, label: input.defaultUnit };
    }
    if (!selectedUnit) {
      return { valid: false, reason: `A unit is required for '${input.label}'.` };
    }
    unit = selectedUnit.id;
    return { valid: true, value, unit, nativeValue: { value, unit } };
  }

  return { valid: true, value, unit: unit ?? null, nativeValue: value };
}

function validationIssue(input, value) {
  const validations = input.validations ?? {};
  const minimum = validations.minimum ?? validations.min;
  const maximum = validations.maximum ?? validations.max;
  if (minimum !== undefined && Number(value) < Number(minimum)) return `Value must be at least ${minimum}.`;
  if (maximum !== undefined && Number(value) > Number(maximum)) return `Value must be at most ${maximum}.`;
  return null;
}

function chooseCandidate(input, facts, policy) {
  const candidates = candidateFacts(input, facts).map((candidate) => ({
    ...candidate,
    coerced: coerceCandidate(input, candidate, { allowDefaultUnit: policy.allowDefaults === true }),
  }));
  if (!candidates.length) return { status: "missing", candidates: [] };
  const topScore = candidates[0].score;
  const close = candidates.filter((candidate) => topScore - candidate.score <= 0.04);
  const distinct = new Set(
    close.map((candidate) => JSON.stringify(candidate.coerced.nativeValue ?? candidate.rawValue)),
  );
  if (distinct.size > 1) return { status: "ambiguous", candidates: close };
  const selected = close.find((candidate) => candidate.coerced.valid) ?? candidates[0];
  if (!selected.coerced.valid) return { status: "invalid", selected, candidates: close };
  const issue = validationIssue(input, selected.coerced.value);
  if (issue) return { status: "invalid", selected: { ...selected, validationIssue: issue }, candidates: close };
  return { status: "bound", selected, candidates: close };
}

function defaultsAllowed(policy, inputId) {
  if (policy === "allow-defaults") return true;
  if (!policy || typeof policy !== "object" || policy.allowDefaults !== true) return false;
  return !(policy.requireConfirmationFor ?? []).includes(inputId);
}

function visibilityFor(input, values, context) {
  const own = evaluateDisplayCondition(input.displayIf, { values, pricing: context.pricing });
  const card = evaluateDisplayCondition(input.raw?.card?.displayIf, {
    values,
    pricing: context.pricing,
  });
  if (own.value === false || card.value === false) {
    return {
      value: false,
      known: true,
      missingReferences: [...new Set([...own.missingReferences, ...card.missingReferences])],
    };
  }
  if (own.value === null || card.value === null) {
    return {
      value: null,
      known: false,
      missingReferences: [...new Set([...own.missingReferences, ...card.missingReferences])],
    };
  }
  return { value: true, known: true, missingReferences: [] };
}

function requiredFor(input, values, context, visible) {
  if (visible === false) return { value: false, missingReferences: [] };
  const conditional = input.requiredWhen ?? input.requiredIf ?? (typeof input.required === "object" ? input.required : null);
  if (conditional) return evaluateDisplayCondition(conditional, { values, pricing: context.pricing });
  return { value: input.required === true, missingReferences: [] };
}

function diagnostic(componentId, inputId, code, severity, message, details = {}) {
  return {
    id: `diagnostic.${code}.${String(componentId).replace(/[^a-zA-Z0-9]+/g, "-")}.${String(inputId).replace(/[^a-zA-Z0-9]+/g, "-")}`,
    code,
    severity,
    componentId,
    inputId,
    message,
    ...details,
  };
}

const SELECTOR_FACT_KEYS = new Set([
  "child service code",
  "model provider",
  "modelprovider",
  "provider",
  "service code",
  "sub service",
  "subservice",
  "template",
  "template id",
  "workload",
]);

function selectorFacts(facts) {
  return facts.filter((fact) => {
    const normalized = normalizeBindingId(fact.key);
    return SELECTOR_FACT_KEYS.has(normalized) || /(?:provider|subservice|template|service code)/.test(normalized);
  });
}

function normalizeChoice(choice, kind) {
  if (choice && typeof choice === "object") {
    const id = String(
      choice.serviceCode ?? choice.id ?? choice.templateId ?? choice.value ?? choice.label ?? "",
    );
    return {
      ...choice,
      id,
      serviceCode: kind === "subservice" ? String(choice.serviceCode ?? id) : null,
      label: String(choice.label ?? choice.title ?? choice.name ?? id),
      aliases: Array.isArray(choice.aliases) ? choice.aliases.map(String) : [],
      model: choice.model ?? choice.definition ?? null,
    };
  }
  const id = String(choice);
  return {
    id,
    serviceCode: kind === "subservice" ? id : null,
    label: id,
    aliases: [],
    model: null,
  };
}

function choiceMatchesFact(choice, fact) {
  const factValue = normalizeBindingId(fact.value);
  const terms = [choice.id, choice.serviceCode, choice.label, ...(choice.aliases ?? [])]
    .filter(Boolean)
    .map(normalizeBindingId);
  if (terms.includes(factValue)) return 1;
  if (factValue.length >= 3 && terms.some((term) => term.includes(factValue))) return 0.84;
  return 0;
}

function selectionQuestion(component, kind, choices, diagnosticId) {
  const label = kind === "subservice" ? "calculator subservice/provider" : "calculator template";
  return {
    id: `question.calculator-selection.${component.id}.${kind}`,
    prompt: `Which ${label} should '${component.name ?? component.id}' use?`,
    blocking: true,
    priority: "high",
    relatedIds: [component.id],
    answerHint: choices.length
      ? `Choose one of: ${choices.slice(0, 20).map((choice) => choice.label).join(", ")}.`
      : null,
    componentId: component.id,
    inputId: kind,
    reason: `The calculator definition exposes multiple ${kind} choices without one explicit match.`,
    diagnosticIds: [diagnosticId],
  };
}

/** Resolve selector children or leaf templates from explicit architecture facts. */
export function selectCalculatorTarget({ component, definition, policy = {} } = {}) {
  const facts = extractFacts(component);
  const isSelector = Boolean(definition.selector);
  const kind = isSelector ? "subservice" : "template";
  const rawChoices = isSelector
    ? definition.selector?.serviceCodes ?? definition.children ?? definition.subservices ?? []
    : definition.templates ?? [];
  const choices = rawChoices.map((choice) => normalizeChoice(choice, kind));

  if (!choices.length) {
    return {
      status: "not-applicable",
      kind: null,
      choices: [],
      selected: [],
      selectedServiceCodes: [],
      templateId: null,
      diagnostics: [],
      questions: [],
    };
  }

  const matches = [];
  for (const fact of selectorFacts(facts)) {
    for (const choice of choices) {
      const confidence = choiceMatchesFact(choice, fact);
      if (confidence) matches.push({ choice, fact, confidence });
    }
  }
  const topConfidence = Math.max(0, ...matches.map((match) => match.confidence));
  const explicit = matches.filter((match) => topConfidence - match.confidence <= 0.04);
  const explicitChoices = [...new Map(explicit.map((match) => [match.choice.id, match])).values()];
  let selected = [];
  let status;
  let method = null;

  if (explicitChoices.length === 1) {
    selected = [explicitChoices[0].choice];
    status = "selected";
    method = "explicit-selector-fact";
  } else if (explicitChoices.length > 1) {
    status = "ambiguous";
  } else if (choices.length === 1) {
    selected = [choices[0]];
    status = "selected";
    method = "sole-published-choice";
  } else if (defaultsAllowed(policy, kind)) {
    const publishedDefaults = isSelector
      ? definition.selector?.defaults ?? []
      : [definition.defaultTemplateId, definition.defaultTemplate]
          .filter(Boolean);
    const defaultChoices = choices.filter(
      (choice) =>
        choice.default === true ||
        choice.isDefault === true ||
        publishedDefaults.some((value) => normalizeBindingId(value) === normalizeBindingId(choice.id)),
    );
    if (defaultChoices.length) {
      selected = isSelector ? defaultChoices : [defaultChoices[0]];
      status = "defaulted";
      method = "published-default";
    } else {
      status = "missing";
    }
  } else {
    status = "missing";
  }

  const diagnostics = [];
  const questions = [];
  if (["missing", "ambiguous"].includes(status)) {
    const code = status === "ambiguous" ? "binding.selector-ambiguous" : "binding.selector-required";
    const item = diagnostic(
      component.id,
      kind,
      code,
      "error",
      status === "ambiguous"
        ? `Architecture facts match multiple calculator ${kind} choices.`
        : `A calculator ${kind} choice is required and defaults are not permitted.`,
      {
        choices: choices.map((choice) => ({ id: choice.id, label: choice.label, serviceCode: choice.serviceCode })),
        sourcePaths: explicit.map((match) => match.fact.path),
      },
    );
    diagnostics.push(item);
    questions.push(selectionQuestion(component, kind, choices, item.id));
  }

  return {
    status,
    kind,
    choices,
    selected,
    selectedServiceCodes: selected.map((choice) => choice.serviceCode).filter(Boolean),
    templateId: kind === "template" ? selected[0]?.id ?? null : definition.selector?.templateId ?? null,
    method,
    confidence:
      method === "explicit-selector-fact"
        ? explicitChoices[0]?.confidence ?? 1
        : status === "defaulted" || method === "sole-published-choice"
          ? 1
          : 0,
    provenance:
      method === "explicit-selector-fact"
        ? provenanceFrom(explicitChoices[0].fact, explicitChoices[0].confidence)
        : status === "defaulted" || method === "sole-published-choice"
          ? publishedDefaultProvenance(definition, { sourcePath: "$.selector", defaultValue: selected.map((choice) => choice.id) })
          : provenanceFrom(component, 0),
    diagnostics,
    questions,
  };
}

/**
 * Bind explicit architecture facts to one compiled calculator definition model.
 * The returned `bindings` record can be passed directly to DefinitionCompiler.compile().
 */
export function bindArchitectureFacts({ component, definition, policy = {}, context = {} } = {}) {
  if (!component || typeof component !== "object") throw new TypeError("component is required");
  if (!definition || typeof definition !== "object") throw new TypeError("definition is required");
  const selection = selectCalculatorTarget({ component, definition, policy });
  const selectedTemplate =
    selection.kind === "template" && selection.selected.length === 1
      ? definition.templates?.find((template) => String(template.id) === selection.templateId) ?? selection.selected[0].model
      : null;
  const effectiveDefinition = selectedTemplate ? { ...definition, inputs: selectedTemplate.inputs } : definition;
  const inputs =
    selection.kind && !["selected", "defaulted"].includes(selection.status)
      ? []
      : normalizeBindableInputs(effectiveDefinition);
  const facts = extractFacts(component);
  const choices = new Map(inputs.map((input) => [input.id, chooseCandidate(input, facts, policy)]));
  const tentativeValues = {};

  for (const input of inputs) {
    const choice = choices.get(input.id);
    if (choice.status === "bound") tentativeValues[input.id] = choice.selected.coerced.nativeValue;
  }

  // Published defaults can unlock downstream display conditions, but only under explicit policy.
  for (let pass = 0; pass < inputs.length; pass += 1) {
    let changed = false;
    for (const input of inputs) {
      if (Object.prototype.hasOwnProperty.call(tentativeValues, input.id)) continue;
      if (input.defaultValue === undefined || !defaultsAllowed(policy, input.id)) continue;
      const visibility = visibilityFor(input, tentativeValues, context);
      if (visibility.value !== true) continue;
      const coerced = coerceCandidate(
        input,
        { rawValue: input.defaultValue, unit: input.defaultUnit ?? null },
        { allowDefaultUnit: true },
      );
      if (!coerced.valid) continue;
      tentativeValues[input.id] = coerced.nativeValue;
      changed = true;
    }
    if (!changed) break;
  }

  const bindings = {};
  const inputBindings = [];
  const diagnostics = [...selection.diagnostics];

  for (const input of inputs) {
    const choice = choices.get(input.id);
    const visibilityResult = visibilityFor(input, tentativeValues, context);
    const visibility = visibilityResult.value === null ? "unknown" : visibilityResult.value ? "visible" : "hidden";
    const requiredResult = requiredFor(input, tentativeValues, context, visibilityResult.value);
    const required = requiredResult.value === true;
    let status = choice.status;
    let value = null;
    let method = null;
    let confidence = 0;
    let sourcePath = null;
    let bindingProvenance = provenanceFrom(component, 0);
    let reason = null;

    if (visibility === "hidden") {
      status = "hidden";
      if (choice.status === "bound") {
        diagnostics.push(
          diagnostic(component.id, input.id, "binding.hidden-explicit", "warning", `Explicit fact '${choice.selected.fact.path}' was ignored because '${input.label}' is hidden.`, {
            sourcePaths: [choice.selected.fact.path],
          }),
        );
      }
    } else if (visibility === "unknown") {
      status = choice.status === "bound" ? "bound" : "conditional";
      if (status !== "bound") {
        diagnostics.push(
          diagnostic(component.id, input.id, "binding.condition-unknown", "warning", `Cannot determine whether '${input.label}' is visible until ${visibilityResult.missingReferences.join(", ") || "its condition"} is supplied.`, {
            missingReferences: visibilityResult.missingReferences,
          }),
        );
      }
    }

    if (status === "bound") {
      const selected = choice.selected;
      value = selected.coerced.nativeValue;
      method = selected.method;
      confidence = selected.score;
      sourcePath = selected.fact.path;
      bindingProvenance = provenanceFrom(selected.fact, selected.score);
      bindings[input.id] = value;
    } else if (
      visibility === "visible" &&
      input.defaultValue !== undefined &&
      defaultsAllowed(policy, input.id)
    ) {
      const coerced = coerceCandidate(
        input,
        { rawValue: input.defaultValue, unit: input.defaultUnit ?? null },
        { allowDefaultUnit: true },
      );
      if (coerced.valid) {
        status = "defaulted";
        value = coerced.nativeValue;
        method = "published-default";
        confidence = 1;
        sourcePath = input.sourcePath ?? null;
        bindingProvenance = publishedDefaultProvenance(definition, input);
        bindings[input.id] = value;
      }
    }

    if (status === "ambiguous") {
      reason = `Multiple architecture facts can bind '${input.label}'.`;
      diagnostics.push(
        diagnostic(component.id, input.id, "binding.ambiguous", required ? "error" : "warning", reason, {
          candidates: choice.candidates.map((candidate) => ({
            sourcePath: candidate.fact.path,
            value: candidate.coerced.nativeValue ?? candidate.rawValue,
            score: candidate.score,
            method: candidate.method,
          })),
        }),
      );
    } else if (status === "invalid") {
      reason = choice.selected.validationIssue ?? choice.selected.coerced.reason;
      diagnostics.push(
        diagnostic(component.id, input.id, "binding.invalid", required ? "error" : "warning", reason, {
          sourcePaths: [choice.selected.fact.path],
          value: choice.selected.rawValue,
        }),
      );
    } else if (status === "missing" && required) {
      reason = `Required calculator input '${input.label}' has no matching architecture fact.`;
      diagnostics.push(diagnostic(component.id, input.id, "binding.required", "error", reason));
    }

    if (requiredResult.value === null) {
      diagnostics.push(
        diagnostic(component.id, input.id, "binding.required-condition-unknown", "warning", `Cannot determine whether '${input.label}' is required.`, {
          missingReferences: requiredResult.missingReferences,
        }),
      );
    }

    const visibleOptions = input.options.map((option) => {
      const result = evaluateDisplayCondition(option.displayIf, {
        values: tentativeValues,
        pricing: context.pricing,
      });
      return { ...option, visible: result.value !== false };
    });
    inputBindings.push({
      inputId: input.id,
      label: input.label,
      input: { ...input, options: visibleOptions },
      status,
      visibility,
      required,
      value,
      method,
      confidence,
      sourcePath,
      provenance: bindingProvenance,
      candidates:
        choice.candidates?.map((candidate) => ({
          sourcePath: candidate.fact.path,
          value: candidate.coerced.nativeValue ?? candidate.rawValue,
          confidence: candidate.score,
          method: candidate.method,
        })) ?? [],
      reason,
      conditionReferences: [
        ...new Set([
          ...referencedInputIds(input.displayIf),
          ...referencedInputIds(input.requiredWhen ?? input.requiredIf),
        ]),
      ],
    });
  }

  const unresolvedRequired = inputBindings.filter(
    (binding) => binding.required && !["bound", "defaulted", "hidden"].includes(binding.status),
  ).length;
  const visible = inputBindings.filter((binding) => binding.visibility !== "hidden");
  const resolved = visible.filter((binding) => ["bound", "defaulted"].includes(binding.status));
  const result = {
    componentId: String(component.id ?? "component"),
    serviceId: component.resolution?.serviceId ?? component.serviceId ?? null,
    serviceCode:
      selection.selectedServiceCodes[0] ??
      definition.serviceCode ??
      definition.metadata?.serviceCode ??
      definition.id ??
      null,
    definitionId: definition.id ?? definition.serviceCode ?? null,
    selection,
    templateId: selection.templateId,
    subservices: selection.selectedServiceCodes.map((serviceCode) => ({
      serviceCode,
      bindings: {},
    })),
    bindings,
    inputBindings,
    facts: facts.map(({ id, key, path, value, unit, sourceKind, provenance }) => ({
      id,
      key,
      path,
      value,
      unit,
      sourceKind,
      provenance,
    })),
    diagnostics,
    coverage: {
      status: unresolvedRequired ? "needs-input" : "ready",
      score: visible.length ? resolved.length / visible.length : 1,
      inputCount: inputs.length,
      visibleInputCount: visible.length,
      boundInputCount: resolved.length,
      requiredInputCount: inputBindings.filter((binding) => binding.required).length,
      unresolvedRequiredInputCount: unresolvedRequired,
      ambiguousInputCount: inputBindings.filter((binding) => binding.status === "ambiguous").length,
    },
  };
  result.questions = [...selection.questions, ...generateInputQuestions(result)];
  return result;
}

function definitionsList(definitions) {
  if (definitions instanceof Map) return [...definitions.values()];
  if (Array.isArray(definitions)) return definitions;
  if (definitions && typeof definitions === "object") return Object.values(definitions);
  return [];
}

function definitionForComponent(component, definitions) {
  const serviceId = component.resolution?.serviceId ?? component.resolution?.catalogServiceId ?? component.serviceId;
  const serviceCode = component.calculatorServiceCode ?? component.configuration?.calculatorServiceCode;
  return definitionsList(definitions).find((definition) =>
    [definition.id, definition.serviceId, definition.serviceCode, ...(definition.aliases ?? [])]
      .filter(Boolean)
      .some((value) => [serviceId, serviceCode].filter(Boolean).some((target) => normalizeBindingId(value) === normalizeBindingId(target))),
  );
}

/** Bind every priceable architecture component to its matching compiled definition model. */
export function bindArchitectureComponents({ architecture, components, definitions, policy = {}, context = {} } = {}) {
  const sourceComponents = components ?? architecture?.components ?? [];
  const results = [];
  const diagnostics = [];
  const questions = [];

  for (const component of sourceComponents) {
    if (
      component?.inclusion === "excluded" ||
      component?.pricingStatus === "not-applicable" ||
      ["actor", "external", "external-actor", "user", "client"].includes(component?.kind)
    ) {
      continue;
    }
    const definition = definitionForComponent(component, definitions);
    if (!definition) {
      const item = diagnostic(
        component.id,
        "definition",
        "binding.definition-missing",
        "error",
        `No calculator definition was supplied for '${component.name ?? component.id}'.`,
      );
      diagnostics.push(item);
      questions.push({
        id: `question.calculator-definition.${component.id}`,
        prompt: `Which calculator definition should price '${component.name ?? component.id}'?`,
        blocking: true,
        priority: "high",
        relatedIds: [component.id],
        answerHint: component.serviceId ?? null,
        componentId: component.id,
        inputId: null,
        reason: item.message,
        diagnosticIds: [item.id],
      });
      continue;
    }
    const result = bindArchitectureFacts({ component, definition, policy, context });
    results.push(result);
    diagnostics.push(...result.diagnostics);
    questions.push(...result.questions);
  }

  return {
    results,
    bindingsByComponentId: Object.fromEntries(results.map((result) => [result.componentId, result.bindings])),
    diagnostics,
    questions,
    coverage: {
      status: diagnostics.some((item) => item.severity === "error") ? "needs-input" : "ready",
      componentCount: sourceComponents.length,
      boundComponentCount: results.length,
      unresolvedComponentCount: diagnostics.filter((item) => item.code === "binding.definition-missing").length,
    },
  };
}
