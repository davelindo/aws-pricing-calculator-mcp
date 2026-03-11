import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalculatorEstimateFromScenario,
  priceArchitecture,
} from "../src/planner.js";
import { validateEstimatePayload } from "../src/validation.js";
import { getScenario } from "../test-support/helpers.js";

function buildExactContainerEstimate(targetMonthlyUsd = 7000) {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd,
    includeDefaultAddOns: false,
  });
  const baseline = getScenario(priced);

  return buildCalculatorEstimateFromScenario({
    pricedScenario: baseline,
  });
}

test("validateEstimatePayload passes for an exact scenario-backed estimate", () => {
  const created = buildExactContainerEstimate();

  const validation = validateEstimatePayload({
    estimate: created.estimate,
    templateId: "eks-rds-standard",
    expectedMonthlyUsd: 7000,
    expectedRegion: "us-east-1",
  });

  assert.equal(validation.passed, true);
  assert.equal(validation.hardFailures.length, 0);
  assert.equal(validation.schemaVersion, "4.0");
  assert.equal(validation.validationMode, "intent-aware");
  assert.equal(validation.contextSource, "explicit");
  assert.ok(validation.parityDetails.length > 0);
  assert.ok(validation.packs.some((pack) => pack.id === "platform-governance"));
  assert.ok(validation.checks.some((check) => check.id === "pricing.saved-modeled-parity"));
  assert.ok(
    validation.checks.every(
      (check) => typeof check.title === "string" && typeof check.remediation === "string",
    ),
  );
  const savedParity = validation.checks.find((check) => check.id === "pricing.saved-modeled-parity");
  const regionCheck = validation.checks.find((check) => check.id === "architecture.expected-region");

  assert.equal(savedParity?.evidence?.kind, "parity_summary");
  assert.equal(regionCheck?.evidence?.kind, "expected_found");
});

test("validateEstimatePayload fails when stored totals drift from modeled totals", () => {
  const created = buildExactContainerEstimate(5000);
  const estimate = structuredClone(created.estimate);
  const firstKey = Object.keys(estimate.services)[0];

  estimate.services[firstKey].serviceCost.monthly += 123;
  estimate.totalCost.monthly += 123;
  estimate.groupSubtotal.monthly += 123;

  const validation = validateEstimatePayload({
    estimate,
    templateId: "eks-rds-standard",
    expectedMonthlyUsd: 5000,
    expectedRegion: "us-east-1",
  });

  assert.equal(validation.passed, false);
  assert.ok(
    validation.blockingFailures.some((failure) => failure.id === "pricing.saved-modeled-parity"),
  );
  assert.ok(
    validation.blockingFailures.every(
      (failure) =>
        typeof failure.title === "string" &&
        typeof failure.details === "string" &&
        typeof failure.remediation === "string",
    ),
  );
});

test("validateEstimatePayload infers windows-heavy from saved services", () => {
  const priced = priceArchitecture({
    blueprintId: "windows-app-stack",
    region: "us-east-1",
    targetMonthlyUsd: 6000,
    includeDefaultAddOns: false,
  });
  const baseline = getScenario(priced);
  const created = buildCalculatorEstimateFromScenario({
    pricedScenario: baseline,
  });

  const validation = validateEstimatePayload({
    estimate: created.estimate,
  });

  assert.equal(validation.validationMode, "generic");
  assert.equal(validation.contextSource, "inferred");
  assert.equal(validation.templateId, undefined);
  assert.equal(validation.bestMatchBlueprintId, "windows-app-stack");
  assert.equal(validation.passed, true);
  assert.ok(
    validation.assumptions.some((assumption) =>
      assumption.includes("Best-match template 'windows-heavy'"),
    ),
  );
});

test("validateEstimatePayload infers streaming-data-platform-standard when firehose is present", () => {
  const priced = priceArchitecture({
    blueprintId: "lakehouse-platform",
    region: "us-east-1",
    targetMonthlyUsd: 25000,
    serviceIds: ["amazon-kinesis-firehose"],
  });
  const baseline = getScenario(priced);
  const created = buildCalculatorEstimateFromScenario({
    pricedScenario: baseline,
  });

  const validation = validateEstimatePayload({
    estimate: created.estimate,
  });

  assert.equal(validation.validationMode, "generic");
  assert.equal(validation.contextSource, "inferred");
  assert.equal(validation.templateId, undefined);
  assert.equal(validation.bestMatchBlueprintId, "streaming-data-platform");
  assert.equal(validation.passed, true);
  assert.ok(
    validation.assumptions.some((assumption) =>
      assumption.includes("Best-match template 'streaming-data-platform-standard'"),
    ),
  );
});

test("validateEstimatePayload does not block explicit non-default regions", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "sa-east-1",
    targetMonthlyUsd: 7000,
    includeDefaultAddOns: false,
    notes: "Deploy in sa-east-1 for Brazil data residency and local latency requirements.",
  });
  const baseline = getScenario(priced);
  const created = buildCalculatorEstimateFromScenario({
    pricedScenario: baseline,
  });

  const validation = validateEstimatePayload({
    estimate: created.estimate,
    templateId: "eks-rds-standard",
    blueprintId: "container-platform",
    expectedMonthlyUsd: 7000,
    expectedRegion: "sa-east-1",
    expectedRegionMode: "single-region",
    validationMode: "intent-aware",
    contextSource: "explicit",
    userAuthoredText: "Deploy in sa-east-1 for Brazil data residency and local latency requirements.",
  });
  const regionRule = validation.checks.find(
    (check) => check.id === "governance.non-default-region-justification",
  );

  assert.equal(validation.passed, true);
  assert.equal(
    validation.blockingFailures.some(
      (failure) => failure.id === "governance.non-default-region-justification",
    ),
    false,
  );
  assert.equal(regionRule?.status, "pass");
  assert.equal(regionRule?.blocking, false);
});

test("scenario validation emits typed evidence for key architecture and funding checks", () => {
  const priced = priceArchitecture({
    blueprintId: "container-platform",
    region: "us-east-1",
    targetMonthlyUsd: 7000,
  });
  const baseline = getScenario(priced);
  const blueprintServices = baseline.validation.checks.find(
    (check) => check.id === "architecture.required-blueprint-services",
  );
  const calculatorReady = baseline.validation.checks.find(
    (check) => check.id === "funding.calculator-link-ready",
  );

  assert.equal(blueprintServices?.evidence?.kind, "required_present_missing");
  assert.equal(calculatorReady?.evidence?.kind, "state_summary");
});
