import test from "node:test";
import assert from "node:assert/strict";

import { getBlueprint, getServiceDefinition, getTemplate } from "../src/catalog.js";
import { priceArchitecture } from "../src/planner.js";
import { ARCHITECTURE_INTEGRATION_CASES } from "../test-support/architecture-integration-cases.js";
import { getScenario } from "../test-support/helpers.js";

const MIN_PRIMARY_RATIO_BY_FAMILY = {
  "application-platform": 0.6,
  "edge-platform": 0.6,
  "integration-platform": 0.5,
  "data-platform": 0.65,
};

function serviceIdsFor(items) {
  return items.map((item) => item.serviceId);
}

function nonSupportiveBreakdown(breakdown) {
  return breakdown.filter((service) => !service.supportive);
}

function assertHasServices(serviceIds, expectedServiceIds, name) {
  for (const serviceId of expectedServiceIds) {
    assert.ok(
      serviceIds.includes(serviceId),
      `${name}: expected service '${serviceId}' in the priced result`,
    );
  }
}

function assertLacksServices(serviceIds, forbiddenServiceIds, name) {
  for (const serviceId of forbiddenServiceIds) {
    assert.equal(
      serviceIds.includes(serviceId),
      false,
      `${name}: did not expect service '${serviceId}' in the priced result`,
    );
  }
}

function monthlyUsdForIds(breakdown, serviceIds) {
  return breakdown
    .filter((service) => serviceIds.has(service.serviceId))
    .reduce((sum, service) => sum + service.monthlyUsd, 0);
}

function highestCostPrimaryServiceId(breakdown) {
  const [top] = [...nonSupportiveBreakdown(breakdown)].sort(
    (left, right) => right.monthlyUsd - left.monthlyUsd,
  );

  return top?.serviceId ?? null;
}

function assertRankedCandidates(architecture, name) {
  for (let index = 1; index < architecture.candidateArchitectures.length; index += 1) {
    assert.ok(
      architecture.candidateArchitectures[index - 1].fitScore >=
        architecture.candidateArchitectures[index].fitScore,
      `${name}: candidate scores should be sorted descending`,
    );
  }
}

function assertEnvironmentModel(environmentModel, breakdown, name) {
  const environments = new Set(
    breakdown.filter((service) => !service.supportive).map((service) => service.environment),
  );

  if (environmentModel === "shared") {
    assert.deepEqual(
      [...environments],
      ["shared"],
      `${name}: shared architectures should price only shared primary environments`,
    );
    return;
  }

  for (const environment of ["dev", "staging", "prod"]) {
    assert.ok(
      environments.has(environment),
      `${name}: expected primary environment '${environment}' in the priced breakdown`,
    );
  }
}

function assertSpendShape(architecture, blueprint, template, breakdown, name) {
  const totalMonthlyUsd = breakdown.reduce((sum, service) => sum + service.monthlyUsd, 0);
  const primaryServiceIds = new Set(
    architecture.selectedServices.filter((service) => service.required).map((service) => service.serviceId),
  );
  const primaryMonthlyUsd = monthlyUsdForIds(breakdown, primaryServiceIds);
  const supportiveMonthlyUsd = breakdown
    .filter((service) => service.supportive)
    .reduce((sum, service) => sum + service.monthlyUsd, 0);
  const primaryRatio = totalMonthlyUsd > 0 ? primaryMonthlyUsd / totalMonthlyUsd : 0;
  const supportiveRatio = totalMonthlyUsd > 0 ? supportiveMonthlyUsd / totalMonthlyUsd : 0;
  const minimumPrimaryRatio =
    architecture.minimumPrimaryDominanceRatio ??
    (MIN_PRIMARY_RATIO_BY_FAMILY[blueprint.architectureFamily] ?? 0.5);
  const maximumSupportiveRatio = Math.max(template.supportiveMaxRatio ?? 0.25, 0.25);

  assert.ok(
    primaryRatio >= minimumPrimaryRatio,
    `${name}: primary services should dominate spend (${primaryRatio.toFixed(2)} < ${minimumPrimaryRatio.toFixed(2)})`,
  );

  if (blueprint.architectureFamily !== "data-platform") {
    assert.ok(
      supportiveRatio <= maximumSupportiveRatio,
      `${name}: supportive services should stay proportionate (${supportiveRatio.toFixed(2)} > ${maximumSupportiveRatio.toFixed(2)})`,
    );
  }
}

function assertPatternSelection(architecture, testCase) {
  if (!testCase.expectedPatternId) {
    return;
  }

  assert.equal(
    architecture.patternId,
    testCase.expectedPatternId,
    `${testCase.name}: unexpected selected architecture pattern`,
  );
  assert.equal(
    architecture.recommendedPatternId,
    testCase.expectedPatternId,
    `${testCase.name}: unexpected recommended architecture pattern`,
  );
}

function assertPrimaryArchitectureShape(breakdown, testCase) {
  const dominantServiceId = highestCostPrimaryServiceId(breakdown);

  if (testCase.forbiddenPrimaryServiceIds.length > 0 && dominantServiceId) {
    assert.equal(
      testCase.forbiddenPrimaryServiceIds.includes(dominantServiceId),
      false,
      `${testCase.name}: dominant primary service '${dominantServiceId}' should not define the architecture`,
    );
  }

  if (testCase.requiredPrimaryServiceIds.length === 0) {
    return;
  }

  const totalMonthlyUsd = breakdown.reduce((sum, service) => sum + service.monthlyUsd, 0);
  const requiredPrimaryMonthlyUsd = monthlyUsdForIds(
    breakdown,
    new Set(testCase.requiredPrimaryServiceIds),
  );
  const requiredPrimaryRatio = totalMonthlyUsd > 0 ? requiredPrimaryMonthlyUsd / totalMonthlyUsd : 0;
  const minimumPrimaryDominanceRatio = testCase.minimumPrimaryDominanceRatio ?? 0.4;

  assert.ok(
    requiredPrimaryRatio >= minimumPrimaryDominanceRatio,
    `${testCase.name}: required primary services should drive the architecture (${requiredPrimaryRatio.toFixed(2)} < ${minimumPrimaryDominanceRatio.toFixed(2)})`,
  );
}

function assertRequiredUnpricedCapabilities(architecture, testCase) {
  if (testCase.requiredUnpricedCapabilityIds.length === 0) {
    return;
  }

  const capabilityIds = new Set(
    (architecture.requiredUnpricedCapabilities ?? []).map((capability) => capability.id),
  );

  for (const capabilityId of testCase.requiredUnpricedCapabilityIds) {
    assert.ok(
      capabilityIds.has(capabilityId),
      `${testCase.name}: expected required unpriced capability '${capabilityId}'`,
    );
  }
}

function assertBriefInferredServicesAreJustified(architecture, brief, name) {
  const lowerBrief = brief.toLowerCase();

  for (const service of architecture.selectedServices) {
    if (service.source !== "brief-inferred") {
      continue;
    }

    const definition = getServiceDefinition(service.serviceId);
    const hasKeywordMatch = definition.keywords.some((keyword) =>
      lowerBrief.includes(keyword.toLowerCase()),
    );

    assert.ok(
      hasKeywordMatch,
      `${name}: brief-inferred service '${service.serviceId}' should be justified by a prompt keyword`,
    );
  }
}

function assertRolesAndRationales(architecture, breakdown, name) {
  for (const service of architecture.selectedServices) {
    assert.ok(service.role, `${name}: every selected service should have a role`);
    assert.ok(service.rationale, `${name}: every selected service should have a rationale`);
  }

  for (const service of breakdown) {
    assert.ok(service.role, `${name}: every breakdown service should have a role`);
    assert.ok(service.rationale, `${name}: every breakdown service should have a rationale`);
  }
}

test("architecture prompt integration matrix covers at least 50 common AWS architecture requests", () => {
  assert.ok(
    ARCHITECTURE_INTEGRATION_CASES.length >= 50,
    `expected at least 50 architecture cases, found ${ARCHITECTURE_INTEGRATION_CASES.length}`,
  );
});

test("brief-driven architecture matrix selects the expected topology and service mix", async (t) => {
  for (const testCase of ARCHITECTURE_INTEGRATION_CASES) {
    await t.test(testCase.name, () => {
      const priced = priceArchitecture({
        brief: testCase.brief,
      });
      const baseline = getScenario(priced);
      const blueprint = getBlueprint(testCase.expectedBlueprintId);
      const template = getTemplate(priced.architecture.templateId ?? blueprint.templateId);
      const architectureServiceIds = serviceIdsFor(priced.architecture.selectedServices);
      const breakdownServiceIds = serviceIdsFor(baseline.serviceBreakdown);

      assert.equal(
        priced.architecture.readyToPrice,
        true,
        `${testCase.name}: architecture should be ready to price`,
      );
      assert.equal(
        priced.architecture.blueprintId,
        testCase.expectedBlueprintId,
        `${testCase.name}: unexpected selected blueprint`,
      );
      assert.equal(
        priced.architecture.recommendedArchitectureId,
        testCase.expectedBlueprintId,
        `${testCase.name}: unexpected recommended architecture`,
      );
      assertPatternSelection(priced.architecture, testCase);
      assert.equal(
        priced.architecture.architectureFamily,
        blueprint.architectureFamily,
        `${testCase.name}: unexpected architecture family`,
      );
      assert.ok(
        Array.isArray(priced.architecture.requiredCapabilities) &&
          priced.architecture.requiredCapabilities.length > 0,
        `${testCase.name}: required capabilities should remain explicit`,
      );
      assert.ok(
        priced.architecture.candidateArchitectures.length >= 1,
        `${testCase.name}: expected at least one architecture candidate`,
      );
      assert.equal(
        priced.architecture.candidateArchitectures[0]?.blueprintId,
        testCase.expectedBlueprintId,
        `${testCase.name}: expected the top-ranked candidate to match the selected blueprint`,
      );
      assertRankedCandidates(priced.architecture, testCase.name);
      assert.deepEqual(
        priced.architecture.serviceCoverage.unavailable,
        [],
        `${testCase.name}: unexpected unavailable services`,
      );
      assert.deepEqual(
        priced.architecture.serviceCoverage.modeled,
        [],
        `${testCase.name}: unexpected modeled services`,
      );
      assert.equal(
        baseline.calculatorEligible,
        testCase.expectedCalculatorEligible,
        `${testCase.name}: unexpected calculator eligibility`,
      );
      assert.equal(
        baseline.coverage.unavailable.length,
        0,
        `${testCase.name}: baseline should not contain unavailable services`,
      );
      assert.equal(
        baseline.coverage.modeled.length,
        0,
        `${testCase.name}: baseline should not contain modeled services`,
      );
      assert.notEqual(
        baseline.budgetFit.status,
        "incompatible_budget",
        `${testCase.name}: budget should not be incompatible with the selected architecture`,
      );
      assert.ok(
        ["fits", "nearest_fit_above", "nearest_fit_below"].includes(baseline.budgetFit.status),
        `${testCase.name}: budget fit should stay in a sane local range`,
      );

      assertHasServices(architectureServiceIds, testCase.requiredServiceIds, testCase.name);
      assertHasServices(breakdownServiceIds, testCase.requiredServiceIds, testCase.name);
      assertLacksServices(breakdownServiceIds, testCase.forbiddenServiceIds, testCase.name);
      assertEnvironmentModel(
        priced.architecture.environmentModel ?? blueprint.environmentModel,
        baseline.serviceBreakdown,
        testCase.name,
      );
      assertSpendShape(
        priced.architecture,
        blueprint,
        template,
        baseline.serviceBreakdown,
        testCase.name,
      );
      assertPrimaryArchitectureShape(baseline.serviceBreakdown, testCase);
      assertRequiredUnpricedCapabilities(priced.architecture, testCase);
      assertBriefInferredServicesAreJustified(priced.architecture, testCase.brief, testCase.name);
      assertRolesAndRationales(priced.architecture, baseline.serviceBreakdown, testCase.name);

      assert.ok(
        priced.architecture.warnings.every((warning) => typeof warning === "string" && warning.length > 0),
        `${testCase.name}: warnings should remain structured strings`,
      );
    });
  }
});
