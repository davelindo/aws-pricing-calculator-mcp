import crypto from "node:crypto";

import {
  buildShareLink,
  fetchSavedEstimate,
  isOfficialCalculatorShareLink,
  saveEstimate,
} from "../calculator-client.js";
import {
  V2_CONTRACT_VERSION,
  architectureIRSchema,
  generateCalculatorLinkOutputSchema,
  pricedArchitectureSchema,
  pricedScenarioSchema,
} from "../contract/v2.js";
import { interpretArchitecture as interpretArchitectureDefinition } from "./architecture.js";
import { createAwsCalculatorDefinitionRuntime } from "./dynamic-definition-runtime.js";
import { ensureDynamicCalculatorCatalog } from "./dynamic-catalog.js";
import {
  hydrateDynamicArchitecturePricing,
  registerHydratedDynamicPricingDefinitions,
} from "./dynamic-pricing.js";
import {
  buildUniversalEstimateFromPlan as compileUniversalEstimate,
  priceUniversalArchitecture as compileUniversalPricing,
} from "./pricing.js";
import { listUniversalServiceEntries } from "./service-registry.js";

const ARCHITECTURE_REF_KIND = "architecture_ref";
const PRICING_COMMIT_KIND = "pricing_commit";
const CATALOG_CURSOR_KIND = "service_catalog_cursor";
const DEFAULT_CATALOG_LIMIT = 100;
const MAX_CATALOG_LIMIT = 500;
const MONEY_TOLERANCE_USD = 0.02;
let cachedDynamicDefinitionRuntime = null;
let cachedDynamicCatalogDigest = null;

export class UniversalRuntimeError extends Error {
  constructor(code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = "UniversalRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

async function dynamicRuntimeContext(options = {}) {
  const catalogResult =
    options.catalogResult ??
    (options.dynamicCatalog === false
      ? null
      : await ensureDynamicCalculatorCatalog(options.catalogOptions ?? {}));

  if (!catalogResult) return null;

  const digest = catalogResult.catalog.metadata.digest;
  const hasCustomRuntimeOptions = Boolean(
    options.fetchImpl || options.currency || options.pricingBaseUrl || options.catalogResult,
  );

  if (
    hasCustomRuntimeOptions ||
    !cachedDynamicDefinitionRuntime ||
    cachedDynamicCatalogDigest !== digest
  ) {
    const runtime = createAwsCalculatorDefinitionRuntime({
      catalog: catalogResult.catalog,
      fetchImpl:
        options.fetchImpl ?? options.catalogOptions?.fetchImpl ?? globalThis.fetch,
      currency: options.currency ?? "USD",
      pricingBaseUrl: options.pricingBaseUrl,
    });

    if (!hasCustomRuntimeOptions) {
      cachedDynamicDefinitionRuntime = runtime;
      cachedDynamicCatalogDigest = digest;
    }

    return { ...catalogResult, definitionRuntime: runtime };
  }

  return {
    ...catalogResult,
    definitionRuntime: cachedDynamicDefinitionRuntime,
  };
}

function encodeToken(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeToken(token, expectedKind) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new UniversalRuntimeError("invalid_input", `A ${expectedKind} token is required.`);
  }

  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));

    if (
      payload?.contractVersion !== V2_CONTRACT_VERSION ||
      payload?.kind !== expectedKind
    ) {
      throw new Error("Unexpected token envelope.");
    }

    return payload;
  } catch {
    throw new UniversalRuntimeError(
      "invalid_input",
      `The supplied ${expectedKind} token is not a valid v2 token.`,
    );
  }
}

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function architectureWithoutRef(architecture) {
  const { architectureRef: _architectureRef, ...portableArchitecture } = architecture;
  return portableArchitecture;
}

export function attachArchitectureRef(architecture) {
  const portableArchitecture = architectureWithoutRef(architecture);
  const revision = stableDigest(portableArchitecture).slice(0, 24);
  const token = encodeToken({
    contractVersion: V2_CONTRACT_VERSION,
    kind: ARCHITECTURE_REF_KIND,
    architectureId: portableArchitecture.architectureId,
    revision,
    architecture: portableArchitecture,
  });

  return architectureIRSchema.parse({
    ...portableArchitecture,
    architectureRef: {
      contractVersion: V2_CONTRACT_VERSION,
      kind: ARCHITECTURE_REF_KIND,
      architectureId: portableArchitecture.architectureId,
      revision,
      token,
    },
  });
}

export function decodeArchitectureRef(reference) {
  const token = typeof reference === "string" ? reference : reference?.token;
  const payload = decodeToken(token, ARCHITECTURE_REF_KIND);
  const expectedRevision = payload?.architecture
    ? stableDigest(payload.architecture).slice(0, 24)
    : null;

  if (!expectedRevision || payload.revision !== expectedRevision) {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The architecture reference failed its integrity check.",
    );
  }

  let architecture;

  try {
    architecture = attachArchitectureRef(payload.architecture);
  } catch {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The architecture reference does not contain valid v2 architecture IR.",
    );
  }

  if (
    payload.architectureId !== architecture.architectureId ||
    (typeof reference === "object" &&
      reference?.architectureId &&
      reference.architectureId !== architecture.architectureId) ||
    (typeof reference === "object" &&
      reference?.revision &&
      reference.revision !== expectedRevision)
  ) {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The architecture reference does not match its embedded architecture.",
    );
  }

  return architecture;
}

function isArchitectureIr(value) {
  return value?.contractVersion === V2_CONTRACT_VERSION && value?.kind === "architecture_ir";
}

function interpretationInputFromArchitecture(input) {
  return {
    definition: input.architecture,
    sources: input.sources,
    context: input.context,
    assumptionsPolicy: input.assumptionsPolicy,
  };
}

export function interpretArchitecture(input = {}) {
  return attachArchitectureRef(interpretArchitectureDefinition(input));
}

export async function interpretArchitectureAsync(input = {}, options = {}) {
  await dynamicRuntimeContext(options);
  return interpretArchitecture(input);
}

export function resolveUniversalArchitecture(input = {}) {
  if (input?.architectureRef) {
    return decodeArchitectureRef(input.architectureRef);
  }

  if (input?.kind === ARCHITECTURE_REF_KIND) {
    return decodeArchitectureRef(input);
  }

  if (isArchitectureIr(input)) {
    return attachArchitectureRef(input);
  }

  if (input?.architecture?.kind === ARCHITECTURE_REF_KIND) {
    return decodeArchitectureRef(input.architecture);
  }

  if (isArchitectureIr(input?.architecture)) {
    return attachArchitectureRef(input.architecture);
  }

  if (Object.hasOwn(input, "architecture")) {
    return interpretArchitecture(interpretationInputFromArchitecture(input));
  }

  if (Object.hasOwn(input, "definition") || Array.isArray(input?.sources)) {
    return interpretArchitecture({
      definition: input.definition,
      sources: input.sources,
      context: input.context,
      assumptionsPolicy: input.assumptionsPolicy,
    });
  }

  throw new UniversalRuntimeError(
    "invalid_input",
    "Supply an architecture reference, architecture IR, definition, or one or more sources.",
  );
}

function targetMonthlyUsdFor(input, architecture) {
  const candidates = [
    input.targetMonthlyUsd,
    input.pricingContext?.targetMonthlyUsd,
    input.pricingContext?.monthlyBudgetUsd,
    input.context?.targetMonthlyUsd,
    architecture.targetMonthlyUsd,
    architecture.properties?.targetMonthlyUsd,
  ];

  return candidates.find((candidate) => Number.isFinite(candidate) && candidate > 0) ?? undefined;
}

function scenarioPoliciesFor(input) {
  return input.scenarioPolicies ?? input.scenarioDefinitions;
}

function scenarioWithoutCommit(scenario) {
  const {
    pricingCommit: _pricingCommit,
    validation: _legacyValidation,
    ...portableScenario
  } = scenario;
  return portableScenario;
}

export function isFullyCalculatorEligibleScenario(scenario) {
  const eligibility = scenario?.eligibility ?? scenario?.exactLinkEligibility;
  const coverage = scenario?.coverage;

  return Boolean(
    scenario?.lineItemPlan &&
      eligibility?.eligible === true &&
      (eligibility.blockers?.length ?? 0) === 0 &&
      (eligibility.ineligibleComponentIds?.length ?? 0) === 0 &&
      (coverage?.unpricedComponentCount ?? 0) === 0 &&
      (coverage?.estimatedComponentCount ?? 0) === 0,
  );
}

function createPricingCommit(priced, scenario) {
  if (!isFullyCalculatorEligibleScenario(scenario)) {
    return null;
  }

  const architecture = architectureWithoutRef(priced.architecture);
  const portableScenario = scenarioWithoutCommit(scenario);
  const revision = stableDigest({
    pricingId: priced.pricingId,
    architecture,
    scenario: portableScenario,
  }).slice(0, 24);
  const token = encodeToken({
    contractVersion: V2_CONTRACT_VERSION,
    kind: PRICING_COMMIT_KIND,
    pricingId: priced.pricingId,
    architectureId: architecture.architectureId,
    scenarioId: portableScenario.id,
    revision,
    architecture,
    scenario: portableScenario,
  });

  return Object.freeze({
    contractVersion: V2_CONTRACT_VERSION,
    kind: PRICING_COMMIT_KIND,
    pricingId: priced.pricingId,
    architectureId: architecture.architectureId,
    scenarioId: portableScenario.id,
    revision,
    token,
  });
}

export function attachPricingCommits(pricedArchitecture) {
  const architecture = attachArchitectureRef(pricedArchitecture.architecture);
  const priced = {
    ...pricedArchitecture,
    architecture,
  };

  priced.scenarios = (priced.scenarios ?? []).map((scenario) => ({
    ...scenarioWithoutCommit(scenario),
    pricingCommit: createPricingCommit(priced, scenarioWithoutCommit(scenario)),
  }));

  return pricedArchitectureSchema.parse(priced);
}

export function decodePricingCommit(commit) {
  const token = typeof commit === "string" ? commit : commit?.token;
  const payload = decodeToken(token, PRICING_COMMIT_KIND);
  const expectedRevision =
    payload?.architecture && payload?.scenario
      ? stableDigest({
          pricingId: payload.pricingId,
          architecture: payload.architecture,
          scenario: payload.scenario,
        }).slice(0, 24)
      : null;

  if (!expectedRevision || payload.revision !== expectedRevision) {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The pricing commit failed its integrity check.",
    );
  }

  let architecture;
  let scenario;

  try {
    architecture = attachArchitectureRef(payload.architecture);
    scenario = pricedScenarioSchema.parse(payload.scenario);
  } catch {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The pricing commit does not contain a valid v2 architecture and scenario.",
    );
  }

  if (
    payload.architectureId !== architecture.architectureId ||
    payload.scenarioId !== scenario.id ||
    (typeof commit === "object" && commit?.scenarioId && commit.scenarioId !== scenario.id) ||
    (typeof commit === "object" && commit?.revision && commit.revision !== expectedRevision)
  ) {
    throw new UniversalRuntimeError(
      "invalid_input",
      "The pricing commit does not match its embedded architecture and scenario.",
    );
  }

  return {
    architecture,
    scenario: {
      ...scenario,
      pricingCommit: typeof commit === "object" ? commit : null,
    },
    pricingId: payload.pricingId,
  };
}

export function priceUniversalArchitecture(input = {}) {
  const architecture = resolveUniversalArchitecture(input);
  const priced = compileUniversalPricing({
    architecture,
    targetMonthlyUsd: targetMonthlyUsdFor(input, architecture),
    assumptionsPolicy: input.assumptionsPolicy,
    scenarioPolicies: scenarioPoliciesFor(input),
  });

  return attachPricingCommits({
    ...priced,
    architecture: priced.architecture ?? architecture,
  });
}

export async function priceUniversalArchitectureAsync(input = {}, options = {}) {
  const context = await dynamicRuntimeContext(options);

  if (!context) return priceUniversalArchitecture(input);

  const architecture = resolveUniversalArchitecture(input);
  const hydrated = await hydrateDynamicArchitecturePricing({
    architecture,
    catalog: context.catalog,
    compiler: context.definitionRuntime.compiler,
    assumptionsPolicy: input.assumptionsPolicy,
  });
  const priced = compileUniversalPricing({
    architecture: hydrated.architecture,
    targetMonthlyUsd: targetMonthlyUsdFor(input, hydrated.architecture),
    assumptionsPolicy: input.assumptionsPolicy,
    scenarioPolicies: scenarioPoliciesFor(input),
  });

  return attachPricingCommits({
    ...priced,
    architecture: priced.architecture ?? hydrated.architecture,
  });
}

export function buildUniversalEstimateFromPlan(plan) {
  return compileUniversalEstimate(plan);
}

function mapPricingSupport(entry) {
  if (entry.implementationStatus === "dynamic") {
    return "dynamic-definition";
  }

  const available = entry.capabilityMatrix.filter((capability) => capability.support !== "unavailable");

  if (available.some((capability) => capability.calculatorSaveSupported)) {
    return "exact";
  }

  if (available.length > 0) {
    return "modeled";
  }

  return "unavailable";
}

function toCatalogService(entry) {
  const availableRegions = entry.capabilityMatrix
    .filter((capability) => capability.support !== "unavailable")
    .map((capability) => capability.region);
  return {
    id: entry.id,
    provider: "aws",
    name: entry.name,
    description: null,
    category: entry.category ?? null,
    aliases: entry.aliases.map((alias) => alias.value),
    capabilities: [...(entry.hints?.capabilities ?? [])],
    regions: availableRegions.length > 0 ? availableRegions : [...(entry.regions ?? [])],
    pricingSupport: mapPricingSupport(entry),
    calculatorServiceCodes: [...entry.calculatorServiceCodes],
    metadata: {
      implementationStatus: entry.implementationStatus,
      pricingInputMode: entry.universalPricingMode,
      pricingStrategies: [...entry.pricingStrategies],
      capabilityMatrix: entry.capabilityMatrix.map((capability) => ({ ...capability })),
      identifiers: entry.aliases.map((alias) => ({ ...alias })),
      cloudFormationTypes: [...(entry.hints?.cloudFormation ?? [])],
      terraformTypes: [...(entry.hints?.terraform ?? [])],
    },
  };
}

function catalogOffset(cursor) {
  if (!cursor) return 0;

  const payload = decodeToken(cursor, CATALOG_CURSOR_KIND);

  if (!Number.isInteger(payload.offset) || payload.offset < 0) {
    throw new UniversalRuntimeError("invalid_input", "The service catalog cursor is invalid.");
  }

  return payload.offset;
}

function matchesCatalogQuery(service, query) {
  if (!query) return true;

  const needle = query.toLowerCase();
  const values = [
    service.id,
    service.name,
    service.category,
    ...service.aliases,
    ...service.capabilities,
    ...service.calculatorServiceCodes,
  ];

  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

export function listUniversalServiceCatalog(input = {}) {
  const serviceIdFilter = input.serviceIds ? new Set(input.serviceIds) : null;
  const catalogServices = listUniversalServiceEntries().map(toCatalogService);
  const allServices = catalogServices
    .filter((service) => !serviceIdFilter || serviceIdFilter.has(service.id))
    .filter((service) => !input.region || service.regions.includes(input.region))
    .filter((service) => matchesCatalogQuery(service, input.query));
  const offset = catalogOffset(input.cursor);
  const limit = Math.min(input.limit ?? DEFAULT_CATALOG_LIMIT, MAX_CATALOG_LIMIT);
  const services = allServices.slice(offset, offset + limit);
  const nextOffset = offset + services.length;
  const nextCursor =
    nextOffset < allServices.length
      ? encodeToken({
          contractVersion: V2_CONTRACT_VERSION,
          kind: CATALOG_CURSOR_KIND,
          offset: nextOffset,
        })
      : null;

  return {
    catalogVersion: `v2-${stableDigest(catalogServices.map((service) => service.id)).slice(0, 12)}`,
    generatedAt: null,
    services,
    nextCursor,
  };
}

export async function listUniversalServiceCatalogAsync(input = {}, options = {}) {
  const context = await dynamicRuntimeContext(options);
  const result = listUniversalServiceCatalog(input);

  if (!context) return result;

  return {
    ...result,
    catalogVersion: context.catalog.metadata.version,
    generatedAt: context.catalog.metadata.fetchedAt,
    discoveryCoverage: context.manifestCoverage.active,
    manifest: {
      digest: context.catalog.metadata.digest,
      sourceUrl: context.catalog.metadata.sourceUrl,
      cacheState: context.catalog.metadata.cacheState,
      stale: context.catalog.metadata.stale,
    },
  };
}

function serviceSignatures(estimate) {
  return Object.values(estimate?.services ?? {})
    .map((service) =>
      [
        service?.serviceCode ?? "",
        service?.region ?? "",
        Number(service?.serviceCost?.monthly ?? 0).toFixed(2),
      ].join("|"),
    )
    .sort();
}

function roundTripCheck(id, passed, expected, actual) {
  return {
    id,
    status: passed ? "pass" : "fail",
    expected,
    actual,
  };
}

export function validateUniversalEstimateRoundTrip(expectedEstimate, fetchedEstimate) {
  const expectedMonthlyUsd = Number(expectedEstimate?.totalCost?.monthly ?? 0);
  const actualMonthlyUsd = Number(fetchedEstimate?.totalCost?.monthly ?? 0);
  const expectedSignatures = serviceSignatures(expectedEstimate);
  const actualSignatures = serviceSignatures(fetchedEstimate);
  const checks = [
    roundTripCheck(
      "estimate-name",
      expectedEstimate?.name === fetchedEstimate?.name,
      expectedEstimate?.name ?? null,
      fetchedEstimate?.name ?? null,
    ),
    roundTripCheck(
      "monthly-total",
      Number.isFinite(actualMonthlyUsd) &&
        Math.abs(expectedMonthlyUsd - actualMonthlyUsd) <= MONEY_TOLERANCE_USD,
      expectedMonthlyUsd,
      actualMonthlyUsd,
    ),
    roundTripCheck(
      "service-count",
      expectedSignatures.length === actualSignatures.length,
      expectedSignatures.length,
      actualSignatures.length,
    ),
    roundTripCheck(
      "service-signatures",
      JSON.stringify(expectedSignatures) === JSON.stringify(actualSignatures),
      expectedSignatures,
      actualSignatures,
    ),
  ];

  return {
    passed: checks.every((check) => check.status === "pass"),
    mode: "generic-exact-round-trip",
    checks,
    expectedMonthlyUsd,
    storedMonthlyUsd: actualMonthlyUsd,
    serviceCount: actualSignatures.length,
  };
}

function eligibleScenarioFromPriced(priced, scenarioId) {
  const scenarios = priced?.scenarios ?? [];
  const selected = scenarioId
    ? scenarios.find((scenario) => scenario.id === scenarioId)
    : scenarios.find(
        (scenario) =>
          scenario.id === priced.recommendedScenarioId &&
          isFullyCalculatorEligibleScenario(scenario),
      ) ?? scenarios.find(isFullyCalculatorEligibleScenario);

  if (scenarioId && !selected) {
    throw new UniversalRuntimeError(
      "not_found",
      `Scenario '${scenarioId}' was not found. Available scenarios: ${
        scenarios.map((scenario) => scenario.id).join(", ") || "none"
      }.`,
    );
  }

  if (!selected || !isFullyCalculatorEligibleScenario(selected)) {
    const blockers = selected?.eligibility?.blockers ??
      scenarios.flatMap((scenario) => scenario?.eligibility?.blockers ?? []);
    throw new UniversalRuntimeError(
      "not_calculator_eligible",
      `No fully calculator-eligible scenario is available.${
        blockers.length > 0 ? ` ${blockers.join(" ")}` : ""
      }`,
      { details: { blockers } },
    );
  }

  return selected;
}

function committedScenarioFromInput(scenario) {
  if (typeof scenario === "string" || scenario?.kind === PRICING_COMMIT_KIND) {
    return decodePricingCommit(scenario);
  }

  if (scenario?.pricingCommit) {
    return decodePricingCommit(scenario.pricingCommit);
  }

  return null;
}

function resolveLinkSelection(input) {
  const committed = input.scenario ? committedScenarioFromInput(input.scenario) : null;

  if (committed) {
    if (input.scenarioId && committed.scenario.id !== input.scenarioId) {
      throw new UniversalRuntimeError(
        "not_found",
        `Scenario '${input.scenarioId}' does not match pricing commit scenario '${committed.scenario.id}'.`,
      );
    }

    return committed;
  }

  if (input.pricedArchitecture) {
    const priced = attachPricingCommits(pricedArchitectureSchema.parse(input.pricedArchitecture));
    return {
      architecture: priced.architecture,
      scenario: eligibleScenarioFromPriced(priced, input.scenarioId),
      pricingId: priced.pricingId,
      priced,
    };
  }

  if (input.scenario) {
    const architecture = resolveUniversalArchitecture(input);
    const scenario = pricedScenarioSchema.parse(input.scenario);

    if (input.scenarioId && scenario.id !== input.scenarioId) {
      throw new UniversalRuntimeError(
        "not_found",
        `Scenario '${input.scenarioId}' does not match supplied scenario '${scenario.id}'.`,
      );
    }

    return { architecture, scenario, pricingId: null, priced: null };
  }

  const priced = priceUniversalArchitecture(input);
  return {
    architecture: priced.architecture,
    scenario: eligibleScenarioFromPriced(priced, input.scenarioId),
    pricingId: priced.pricingId,
    priced,
  };
}

export async function generateUniversalCalculatorLink(input = {}) {
  const selection = resolveLinkSelection(input);

  if (!isFullyCalculatorEligibleScenario(selection.scenario)) {
    throw new UniversalRuntimeError(
      "not_calculator_eligible",
      `Scenario '${selection.scenario.id}' is not fully calculator-eligible.`,
      { details: { blockers: selection.scenario?.eligibility?.blockers ?? [] } },
    );
  }

  const built = buildUniversalEstimateFromPlan(selection.scenario.lineItemPlan);
  const expectedEstimate = built.estimate ?? built;
  const saved = await saveEstimate(expectedEstimate);
  const fetched = await fetchSavedEstimate(saved.savedKey);
  const validation = validateUniversalEstimateRoundTrip(expectedEstimate, fetched.estimate);

  if (!validation.passed) {
    throw new UniversalRuntimeError(
      "validation_failed",
      "The saved estimate did not match the exact universal line-item plan.",
      {
        details: {
          failedChecks: validation.checks.filter((check) => check.status === "fail"),
        },
      },
    );
  }

  const selectedScenario = {
    ...selection.scenario,
    pricingCommit:
      selection.scenario.pricingCommit ??
      (selection.priced
        ? createPricingCommit(selection.priced, selection.scenario)
        : null),
  };
  const linkUrl = saved.shareLink ?? buildShareLink(saved.savedKey);
  const result = {
    contractVersion: V2_CONTRACT_VERSION,
    kind: "calculator_link",
    architecture: selection.architecture,
    selectedScenario,
    link: {
      url: linkUrl,
      estimateId: saved.savedKey,
      provider: "aws-pricing-calculator",
      official: isOfficialCalculatorShareLink(linkUrl),
      readOnly: true,
      createdAt: fetched.estimate?.metaData?.createdOn ?? null,
      expiresAt: null,
    },
    coverage: selectedScenario.coverage,
    eligibility: selectedScenario.eligibility,
    warnings: [...new Set(selectedScenario.warnings ?? [])],
    validation,
    storedEstimate: {
      name: fetched.estimate?.name ?? null,
      monthlyUsd: Number(fetched.estimate?.totalCost?.monthly ?? 0),
      serviceCount: Object.keys(fetched.estimate?.services ?? {}).length,
    },
  };

  return generateCalculatorLinkOutputSchema.parse(result);
}

async function validateDynamicDefinitionRoundTrip(result, context) {
  const dynamicLineItems = (
    result?.selectedScenario?.lineItemPlan?.lineItems ?? []
  ).filter((lineItem) => lineItem?.arguments?.dynamic === true);

  if (dynamicLineItems.length === 0) return result;

  const fetched = await fetchSavedEstimate(result.link.estimateId);
  const checks = [];

  for (const lineItem of dynamicLineItems) {
    const serviceKey = lineItem?.entry?.key;
    const service = fetched.estimate?.services?.[serviceKey];

    if (!service) {
      checks.push({
        id: `dynamic-definition-${lineItem.id}`,
        status: "fail",
        expected: serviceKey,
        actual: null,
      });
      continue;
    }

    try {
      const repriced = await context.definitionRuntime.compiler.repriceService(
        service,
        { metadata: lineItem.arguments.definitionMetadata },
      );
      checks.push({
        id: `dynamic-definition-${lineItem.id}`,
        status: repriced.matchesStoredCost ? "pass" : "fail",
        expected: repriced.monthlyUsd,
        actual: repriced.storedMonthlyUsd,
      });
    } catch (error) {
      checks.push({
        id: `dynamic-definition-${lineItem.id}`,
        status: "fail",
        expected: lineItem.entry?.service?.serviceCost?.monthly ?? null,
        actual: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const passed = checks.every((check) => check.status === "pass");

  if (!passed) {
    throw new UniversalRuntimeError(
      "validation_failed",
      "A saved dynamic calculator service failed definition and pricing-map parity.",
      { details: { failedChecks: checks.filter((check) => check.status === "fail") } },
    );
  }

  return generateCalculatorLinkOutputSchema.parse({
    ...result,
    validation: {
      ...result.validation,
      passed: result.validation.passed && passed,
      checks: [...result.validation.checks, ...checks],
    },
    dynamicDefinitionValidation: {
      passed,
      checks,
    },
  });
}

export async function generateUniversalCalculatorLinkAsync(input = {}, options = {}) {
  const context = await dynamicRuntimeContext(options);

  if (!context) return generateUniversalCalculatorLink(input);

  let preparedInput = input;

  if (input.pricedArchitecture) {
    registerHydratedDynamicPricingDefinitions(input.pricedArchitecture.architecture);
  } else if (input.scenario) {
    const committed = committedScenarioFromInput(input.scenario);
    if (committed) {
      registerHydratedDynamicPricingDefinitions(committed.architecture);
    } else if (input.architecture || input.architectureRef || input.definition || input.sources) {
      const priced = await priceUniversalArchitectureAsync(input, options);
      preparedInput = {
        pricedArchitecture: priced,
        scenarioId: input.scenarioId,
      };
    }
  } else {
    const priced = await priceUniversalArchitectureAsync(input, options);
    preparedInput = {
      pricedArchitecture: priced,
      scenarioId: input.scenarioId,
    };
  }

  const result = await generateUniversalCalculatorLink(preparedInput);
  return validateDynamicDefinitionRoundTrip(result, context);
}
