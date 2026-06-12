import { getBlueprint, getServiceRegionCapability } from "./catalog.js";
import {
  fetchSavedEstimate,
  isOfficialCalculatorShareLink,
  saveEstimate,
} from "./calculator-client.js";
import { buildCalculatorEstimateFromScenario, priceArchitecture } from "./planner.js";
import { validateEstimatePayload } from "./validation.js";

const PRICING_COMMIT_KIND = "pricing_commit";

function encodeOpaqueToken(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeOpaqueToken(token, expectedKind) {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const payload = JSON.parse(raw);

  if (payload?.kind !== expectedKind) {
    throw new Error(`Invalid ${expectedKind} token.`);
  }

  return payload;
}

function validateBuiltEstimate({ estimate, linkPlan, expectedMonthlyUsd, estimateNotes }) {
  return validateEstimatePayload({
    estimate,
    blueprintId: linkPlan.blueprintId,
    patternId: linkPlan.patternId,
    templateId: linkPlan.templateId,
    expectedMonthlyUsd,
    expectedRegion: linkPlan.region,
    expectedRegionMode: "single-region",
    validationMode: "intent-aware",
    contextSource: "link-plan",
    userAuthoredText: estimateNotes,
  });
}

function summarizeGeneratedScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    modeledMonthlyUsd: scenario.modeledMonthlyUsd,
    calculatorEligible: scenario.calculatorEligible,
    calculatorBlockers: scenario.calculatorBlockers ?? [],
    budgetFit: scenario.budgetFit,
    strategySummary: scenario.strategySummary,
    pricingCommit: scenario.pricingCommit ?? null,
  };
}

function createPricingCommit(architecture, scenario) {
  if (!scenario?.calculatorEligible || !scenario?.linkPlan) {
    return null;
  }

  return {
    contractVersion: "v1",
    kind: PRICING_COMMIT_KIND,
    architectureId: architecture.architectureId,
    blueprintId: architecture.blueprintId,
    patternId: architecture.patternId,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    modeledMonthlyUsd: scenario.modeledMonthlyUsd,
    targetMonthlyUsd: scenario.targetMonthlyUsd,
    strategySummary: scenario.strategySummary,
    token: encodeOpaqueToken({
      kind: PRICING_COMMIT_KIND,
      linkPlan: scenario.linkPlan,
    }),
  };
}

export function attachPricingCommits(priced) {
  const architecture = {
    ...priced.architecture,
    architectureRef:
      priced.architecture.architectureRef ??
      {
        contractVersion: "v1",
        kind: "architecture_ref",
        architectureId: priced.architecture.architectureId,
        blueprintId: priced.architecture.blueprintId,
        patternId: priced.architecture.patternId,
        token: encodeOpaqueToken({
          kind: "architecture_ref",
          architecture: priced.architecture,
        }),
      },
  };

  return {
    ...priced,
    architecture,
    scenarios: priced.scenarios.map((scenario) => ({
      ...scenario,
      pricingCommit: createPricingCommit(architecture, scenario),
    })),
  };
}

export function selectScenarioForCalculatorLink(priced, scenarioId) {
  const scenarios = priced?.scenarios ?? [];

  if (scenarios.length === 0) {
    const blockers = priced?.blockers?.length
      ? ` ${priced.blockers.join(" ")}`
      : "";
    throw new Error(`Unable to create estimate: no priced scenarios were produced.${blockers}`);
  }

  if (scenarioId) {
    const selected = scenarios.find((scenario) => scenario.id === scenarioId);

    if (!selected) {
      throw new Error(
        `Scenario '${scenarioId}' was not found. Available scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}.`,
      );
    }

    if (!selected.calculatorEligible || !selected.linkPlan) {
      throw new Error(
        `Scenario '${scenarioId}' is not calculator-eligible. ${selected.calculatorBlockers?.join(" ") || "No exact link plan was produced."}`,
      );
    }

    return selected;
  }

  const eligibleScenarios = scenarios.filter(
    (scenario) => scenario.calculatorEligible && scenario.linkPlan,
  );

  if (eligibleScenarios.length === 0) {
    throw new Error(
      `Unable to create estimate: no calculator-eligible scenarios were produced. ${scenarios
        .flatMap((scenario) => scenario.calculatorBlockers ?? [])
        .join(" ")}`.trim(),
    );
  }

  const recommendedScenario = eligibleScenarios.find(
    (scenario) => scenario.id === priced.recommendedScenarioId,
  );

  if (recommendedScenario) {
    return recommendedScenario;
  }

  return [...eligibleScenarios].sort(
    (left, right) =>
      Math.abs(left.modeledMonthlyUsd - left.targetMonthlyUsd) -
      Math.abs(right.modeledMonthlyUsd - right.targetMonthlyUsd),
  )[0];
}

export async function buildGeneratedEstimateResult(pricedScenario) {
  const built = buildCalculatorEstimateFromScenario({ pricedScenario });
  const saved = await saveEstimate(built.estimate);
  const fetched = await fetchSavedEstimate(saved.savedKey);
  const validation = validateBuiltEstimate({
    estimate: fetched.estimate,
    linkPlan: built.linkPlan,
    expectedMonthlyUsd: built.linkPlan.targetMonthlyUsd,
    estimateNotes: built.linkPlan.notes,
  });

  return {
    estimateId: saved.savedKey,
    shareLink: saved.shareLink,
    officialShareLink: isOfficialCalculatorShareLink(saved.shareLink),
    readOnlyViewer: true,
    editInstructions:
      "Shared calculator links open in AWS's read-only viewer. Click 'Update estimate' inside calculator.aws to enter the editable flow.",
    blueprintId: built.linkPlan.blueprintId,
    estimateName: fetched.estimate.name,
    region: built.linkPlan.region,
    targetMonthlyUsd: built.linkPlan.targetMonthlyUsd,
    modeledMonthlyUsd: built.validation.modeledMonthlyUsd,
    storedMonthlyUsd: Number(fetched.estimate?.totalCost?.monthly ?? 0),
    assumptions: built.validation.assumptions,
    warnings: built.validation.warnings,
    serviceBreakdown: built.serviceBreakdown.map((service) => ({
      ...service,
      capability:
        service.capability ?? getServiceRegionCapability(service.serviceId, service.region),
    })),
    validation,
  };
}

function scenarioFromPricingCommit(pricingCommit) {
  const payload = decodeOpaqueToken(pricingCommit.token, PRICING_COMMIT_KIND);

  return {
    id: pricingCommit.scenarioId,
    title: pricingCommit.scenarioTitle,
    modeledMonthlyUsd: pricingCommit.modeledMonthlyUsd,
    targetMonthlyUsd: pricingCommit.targetMonthlyUsd,
    strategySummary: pricingCommit.strategySummary,
    calculatorEligible: true,
    calculatorBlockers: [],
    linkPlan: payload.linkPlan,
    pricingCommit,
  };
}

export async function generateCalculatorLinkResult({ scenarioId, ...args }) {
  const priced = attachPricingCommits(priceArchitecture(args));
  const selectedScenario = selectScenarioForCalculatorLink(priced, scenarioId);
  const estimate = await buildGeneratedEstimateResult(selectedScenario);

  return {
    architecture: {
      architectureId: priced.architecture.architectureId,
      blueprintId: priced.architecture.blueprintId,
      blueprintTitle: priced.architecture.blueprintTitle,
      patternId: priced.architecture.patternId,
      patternTitle: priced.architecture.patternTitle,
      region: priced.architecture.region,
      estimateName: priced.architecture.estimateName,
      targetMonthlyUsd: priced.architecture.targetMonthlyUsd,
      serviceSelectionMode: priced.architecture.serviceSelectionMode,
      selectedServiceIds: priced.architecture.selectedServices.map((service) => service.serviceId),
    },
    selectedScenario: summarizeGeneratedScenario(selectedScenario),
    recommendedScenarioId: priced.recommendedScenarioId,
    availableScenarios: priced.scenarios.map(summarizeGeneratedScenario),
    estimate,
  };
}

export async function createCalculatorLinkResult({ pricedScenario, pricingCommit }) {
  return buildGeneratedEstimateResult(
    pricingCommit ? scenarioFromPricingCommit(pricingCommit) : pricedScenario,
  );
}

export function validateFetchedEstimate({
  estimate,
  blueprintId,
  patternId,
  expectedMonthlyUsd,
  expectedRegion,
  expectedRegionMode,
  validationMode,
  budgetTolerancePct,
}) {
  return validateEstimatePayload({
    estimate,
    blueprintId,
    patternId,
    templateId: blueprintId ? getBlueprint(blueprintId).templateId : undefined,
    expectedMonthlyUsd,
    expectedRegion,
    expectedRegionMode,
    validationMode,
    contextSource: blueprintId || patternId ? "explicit" : undefined,
    budgetTolerancePct,
  });
}
