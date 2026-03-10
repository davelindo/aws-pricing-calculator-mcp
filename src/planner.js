import {
  DEFAULT_REGION,
  getTemplate,
} from "./catalog.js";
import {
  buildEstimatePayloadFromEntries,
  buildServiceBreakdown,
  buildTemplateEstimateShape,
  normalizeEnvironmentSplit,
  pricingFor,
  roundCurrency,
  summarizeServicePlan,
} from "./model.js";
import { validateEstimatePayload } from "./validation.js";

const BRIEF_PREVIEW_LENGTH = 240;
const OPERATING_SYSTEMS = new Set(["linux", "windows"]);
const NON_MODELED_SERVICE_HINTS = [
  "waf",
  "landing zone",
  "control tower",
  "governance",
  "organization",
  "shared services",
  "bedrock",
  "handoff",
  "knowledge transfer",
  "kt",
];
const TEMPLATE_HINTS = {
  "eks-rds-standard": /(eks|kubernetes|argocd|container|containers|ecs)/i,
  "windows-heavy": /(windows|active directory|microsoft)/i,
  "linux-heavy": /(linux|ec2|vm|fleet)/i,
};
const UNSUPPORTED_DATABASES = [
  { pattern: /sql server/i, label: "SQL Server" },
  { pattern: /mysql/i, label: "MySQL" },
  { pattern: /mariadb/i, label: "MariaDB" },
  { pattern: /oracle/i, label: "Oracle" },
];

function normalizeBrief(brief) {
  return String(brief ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function briefPreview(brief) {
  const normalized = normalizeBrief(brief);
  if (!normalized) {
    return null;
  }

  return normalized.length <= BRIEF_PREVIEW_LENGTH
    ? normalized
    : `${normalized.slice(0, BRIEF_PREVIEW_LENGTH - 1)}…`;
}

function parseMoneyToken(rawToken) {
  const compact = rawToken.replace(/[\s,$]/g, "").toLowerCase();
  const hasThousandsSuffix = compact.endsWith("k");
  const numeric = hasThousandsSuffix ? compact.slice(0, -1) : compact;
  const parsed = Number(numeric.replace(/usd$/i, ""));

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return roundCurrency(parsed * (hasThousandsSuffix ? 1_000 : 1));
}

function budgetContextScore(context, baseScore) {
  const positiveSignals = [
    ["calculator", 60],
    ["mrr", 45],
    ["monthly", 35],
    ["month", 25],
    ["budget", 25],
    ["target", 20],
    ["push", 15],
    ["needed", 10],
  ];
  const negativeSignals = [
    ["arr", 45],
    ["project", 35],
    ["forecast", 20],
    ["current", 20],
    ["credits", 20],
    ["one-time", 20],
  ];

  let score = baseScore;

  for (const [signal, weight] of positiveSignals) {
    if (context.includes(signal)) {
      score += weight;
    }
  }

  for (const [signal, weight] of negativeSignals) {
    if (context.includes(signal)) {
      score -= weight;
    }
  }

  return score;
}

function extractBudgetCandidates(brief) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    {
      regex:
        /(\$?\s*\d+(?:,\d{3})*(?:\.\d+)?\s*k?)\s*(?:usd)?\s*(?:\/\s*month|per month|monthly|mrr|\/mo|\bmo\b)/gi,
      baseScore: 70,
    },
    {
      regex:
        /(?:calculator|budget|target|push)[^$\d]{0,20}(\$?\s*\d+(?:,\d{3})*(?:\.\d+)?\s*k?)/gi,
      baseScore: 55,
    },
    {
      regex: /(\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*k)?|\d+(?:\.\d+)?\s*k|\d+(?:,\d{3})*(?:\.\d+)?\s*usd)\b/gi,
      baseScore: 20,
    },
  ];

  for (const { regex, baseScore } of patterns) {
    for (const match of brief.matchAll(regex)) {
      const rawToken = (match[1] ?? match[0]).trim();
      const start = match.index ?? 0;
      const key = `${start}:${rawToken}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const usd = parseMoneyToken(rawToken);

      if (!usd) {
        continue;
      }

      const context = brief.slice(Math.max(0, start - 60), Math.min(brief.length, start + 80)).toLowerCase();

      candidates.push({
        rawToken,
        usd,
        context,
        score: budgetContextScore(context, baseScore),
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.usd - right.usd);
  return candidates;
}

function inferBudgetFromBrief(brief, warnings, assumptions) {
  const candidates = extractBudgetCandidates(brief);

  if (candidates.length === 0) {
    return null;
  }

  const selected = candidates[0];
  assumptions.push(
    `Target monthly budget was inferred as ${selected.usd.toFixed(2)} USD from the brief.`,
  );

  if (candidates.length > 1) {
    warnings.push(
      `The brief contained multiple spend-like values. Selected ${selected.usd.toFixed(2)} USD from the strongest calculator/monthly context.`,
    );
  }

  return selected.usd;
}

function inferEnvironmentSplitFromBrief(brief, assumptions) {
  const match = brief.match(/(\d{1,3})\s*\/\s*(\d{1,3})\s*\/\s*(\d{1,3})/);

  if (!match) {
    return null;
  }

  assumptions.push(
    `Environment split was inferred from the brief as ${match[1]}/${match[2]}/${match[3]}.`,
  );

  return {
    dev: Number(match[1]),
    staging: Number(match[2]),
    prod: Number(match[3]),
  };
}

function inferClientNameFromBrief(brief, assumptions) {
  if (!brief) {
    return null;
  }

  const numberedLead = brief.match(/^\s*\d+\s*-\s*([A-Za-z0-9 .&'-]+?)\s*-\s*https?:\/\//m);

  if (numberedLead?.[1]) {
    const clientName = numberedLead[1].trim();
    assumptions.push(`Client name was inferred from the brief as '${clientName}'.`);
    return clientName;
  }

  return null;
}

function inferRegionFromBrief(brief, warnings, assumptions) {
  const lower = brief.toLowerCase();

  if (lower.includes("us-east-1") || lower.includes("n. virginia") || lower.includes("virginia")) {
    assumptions.push("Region was inferred from the brief as us-east-1.");
    return DEFAULT_REGION;
  }

  if (lower.includes("sa-east-1") || lower.includes("sao paulo") || lower.includes("são paulo")) {
    warnings.push(
      "The brief references São Paulo / sa-east-1, but v1 only models us-east-1. Using us-east-1.",
    );
  }

  return null;
}

function inferTemplateId({ brief, operatingSystem, warnings, assumptions }) {
  if (brief) {
    for (const [templateId, pattern] of Object.entries(TEMPLATE_HINTS)) {
      if (pattern.test(brief)) {
        assumptions.push(`Template '${templateId}' was inferred from workload signals in the brief.`);
        return templateId;
      }
    }
  }

  if (operatingSystem === "windows") {
    assumptions.push("Template 'windows-heavy' was inferred from the operatingSystem override.");
    return "windows-heavy";
  }

  if (operatingSystem === "linux") {
    assumptions.push("Template 'linux-heavy' was inferred from the operatingSystem override.");
    return "linux-heavy";
  }

  warnings.push(
    "No template could be inferred confidently from the brief. Defaulting to 'linux-heavy'.",
  );
  return "linux-heavy";
}

function unsupportedDatabaseMention(brief) {
  if (!brief) {
    return null;
  }

  for (const candidate of UNSUPPORTED_DATABASES) {
    if (candidate.pattern.test(brief)) {
      return candidate.label;
    }
  }

  return null;
}

function collectNonModeledWarnings(brief, warnings) {
  if (!brief) {
    return;
  }

  const matchedHints = NON_MODELED_SERVICE_HINTS.filter((hint) =>
    brief.toLowerCase().includes(hint),
  );

  if (matchedHints.length > 0) {
    warnings.push(
      `The brief references non-modeled platform or project items (${matchedHints.join(", ")}). The calculator will only include the baseline services this MCP explicitly models.`,
    );
  }
}

function buildReadyPlanResult({
  sourceType,
  brief,
  template,
  region,
  targetMonthlyUsd,
  environmentSplit,
  clientName,
  estimateName,
  notes,
  assumptions,
  warnings,
}) {
  const shape = buildTemplateEstimateShape({
    template,
    region,
    targetMonthlyUsd,
    environmentSplit,
    notes,
  });
  const serviceBreakdown = buildServiceBreakdown(shape.entries);
  const servicePlanSummary = summarizeServicePlan({
    template,
    shape,
  });
  const modeledMonthlyUsd = roundCurrency(
    serviceBreakdown.reduce((sum, service) => sum + service.monthlyUsd, 0),
  );

  return {
    readyToCreate: true,
    sourceType,
    briefSummary: briefPreview(brief),
    templateId: template.id,
    templateTitle: template.title,
    clientName: clientName ?? null,
    estimateName,
    region,
    targetMonthlyUsd,
    modeledMonthlyUsd,
    environmentSplit,
    blockers: [],
    assumptions,
    warnings,
    servicePlanSummary,
    serviceBreakdown,
    createInput: {
      templateId: template.id,
      targetMonthlyUsd,
      region,
      clientName: clientName ?? null,
      estimateName,
      notes: notes ?? null,
      environmentSplit,
      operatingSystem: template.computeOs,
    },
  };
}

function buildBlockedPlanResult({
  sourceType,
  brief,
  templateId,
  templateTitle,
  clientName,
  estimateName,
  region,
  targetMonthlyUsd,
  environmentSplit,
  assumptions,
  warnings,
  blockers,
}) {
  return {
    readyToCreate: false,
    sourceType,
    briefSummary: briefPreview(brief),
    templateId,
    templateTitle,
    clientName: clientName ?? null,
    estimateName,
    region,
    targetMonthlyUsd,
    modeledMonthlyUsd: null,
    environmentSplit,
    blockers,
    assumptions,
    warnings,
    servicePlanSummary: null,
    serviceBreakdown: [],
    createInput: null,
  };
}

export function planEstimate({
  templateId,
  brief,
  targetMonthlyUsd,
  region,
  clientName,
  estimateName,
  notes,
  environmentSplit,
  operatingSystem,
} = {}) {
  const assumptions = [];
  const warnings = [];
  const blockers = [];
  const normalizedBrief = normalizeBrief(brief);
  const hasBrief = normalizedBrief.length > 0;
  const sourceType =
    templateId && hasBrief ? "hybrid" : templateId ? "template" : hasBrief ? "brief" : "template";
  const normalizedOperatingSystem =
    operatingSystem && OPERATING_SYSTEMS.has(operatingSystem) ? operatingSystem : null;
  const inferredTemplateId =
    templateId ??
    inferTemplateId({
      brief: normalizedBrief,
      operatingSystem: normalizedOperatingSystem,
      warnings,
      assumptions,
    });

  const unsupportedDatabase = unsupportedDatabaseMention(normalizedBrief);

  if (unsupportedDatabase) {
    blockers.push(
      `The brief references ${unsupportedDatabase}, but v1 only models PostgreSQL.`,
    );
  }

  const resolvedRegion = (() => {
    if (region) {
      assumptions.push(`Region was supplied explicitly as ${region}.`);
      return region;
    }

    const fromBrief = inferRegionFromBrief(normalizedBrief, warnings, assumptions);

    if (fromBrief) {
      return fromBrief;
    }

    assumptions.push(`Region defaulted to ${DEFAULT_REGION}.`);
    return DEFAULT_REGION;
  })();

  try {
    pricingFor(resolvedRegion);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  const resolvedTargetMonthlyUsd = (() => {
    if (Number.isFinite(targetMonthlyUsd) && targetMonthlyUsd > 0) {
      assumptions.push(
        `Target monthly budget was supplied explicitly as ${Number(targetMonthlyUsd).toFixed(2)} USD.`,
      );
      return roundCurrency(targetMonthlyUsd);
    }

    const inferred = inferBudgetFromBrief(normalizedBrief, warnings, assumptions);

    if (inferred != null) {
      return inferred;
    }

    blockers.push("A positive targetMonthlyUsd is required or must be inferable from the brief.");
    return null;
  })();

  const resolvedEnvironmentSplit = normalizeEnvironmentSplit(
    environmentSplit ?? inferEnvironmentSplitFromBrief(normalizedBrief, assumptions) ?? undefined,
  );

  if (!environmentSplit) {
    assumptions.push(
      `Environment split resolved to ${(resolvedEnvironmentSplit.dev * 100).toFixed(0)}/${(resolvedEnvironmentSplit.staging * 100).toFixed(0)}/${(resolvedEnvironmentSplit.prod * 100).toFixed(0)}.`,
    );
  }

  const resolvedClientName =
    clientName ?? inferClientNameFromBrief(brief, assumptions) ?? null;
  const template = getTemplate(inferredTemplateId);
  const resolvedEstimateName =
    estimateName ?? `${resolvedClientName ? `${resolvedClientName} - ` : ""}${template.title}`;

  collectNonModeledWarnings(normalizedBrief, warnings);

  if (blockers.length > 0 || resolvedTargetMonthlyUsd == null) {
    return buildBlockedPlanResult({
      sourceType,
      brief,
      templateId: template.id,
      templateTitle: template.title,
      clientName: resolvedClientName,
      estimateName: resolvedEstimateName,
      region: resolvedRegion,
      targetMonthlyUsd: resolvedTargetMonthlyUsd,
      environmentSplit: resolvedEnvironmentSplit,
      assumptions,
      warnings,
      blockers,
    });
  }

  try {
    return buildReadyPlanResult({
      sourceType,
      brief,
      template,
      region: resolvedRegion,
      targetMonthlyUsd: resolvedTargetMonthlyUsd,
      environmentSplit: resolvedEnvironmentSplit,
      clientName: resolvedClientName,
      estimateName: resolvedEstimateName,
      notes,
      assumptions,
      warnings,
    });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));

    return buildBlockedPlanResult({
      sourceType,
      brief,
      templateId: template.id,
      templateTitle: template.title,
      clientName: resolvedClientName,
      estimateName: resolvedEstimateName,
      region: resolvedRegion,
      targetMonthlyUsd: resolvedTargetMonthlyUsd,
      environmentSplit: resolvedEnvironmentSplit,
      assumptions,
      warnings,
      blockers,
    });
  }
}

function normalizeCreateInput(input) {
  if (input?.plan?.createInput) {
    return input.plan.createInput;
  }

  return {
    templateId: input?.templateId,
    targetMonthlyUsd: input?.targetMonthlyUsd,
    region: input?.region,
    clientName: input?.clientName,
    estimateName: input?.estimateName,
    notes: input?.notes,
    environmentSplit: input?.environmentSplit,
    operatingSystem: input?.operatingSystem,
    brief: input?.brief,
  };
}

export function createModeledEstimate(input) {
  const createInput = normalizeCreateInput(input);
  const plan = planEstimate(createInput);

  if (!plan.readyToCreate || !plan.createInput) {
    throw new Error(`Unable to create estimate: ${plan.blockers.join(" ")}`);
  }

  const template = getTemplate(plan.createInput.templateId);
  const shape = buildTemplateEstimateShape({
    template,
    region: plan.createInput.region,
    targetMonthlyUsd: plan.createInput.targetMonthlyUsd,
    environmentSplit: plan.createInput.environmentSplit,
    notes: plan.createInput.notes,
  });
  const estimate = buildEstimatePayloadFromEntries({
    estimateName: plan.createInput.estimateName,
    entries: shape.entries,
  });
  const validation = validateEstimatePayload({
    estimate,
    templateId: plan.createInput.templateId,
    expectedMonthlyUsd: plan.createInput.targetMonthlyUsd,
    expectedRegion: plan.createInput.region,
  });

  return {
    plan,
    template,
    estimate,
    serviceBreakdown: buildServiceBreakdown(shape.entries),
    validation,
  };
}
