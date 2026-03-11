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
  assert.ok(validation.parityDetails.length > 0);
  assert.ok(validation.packs.some((pack) => pack.id === "platform-governance"));
  assert.ok(validation.checks.some((check) => check.id === "pricing.saved-modeled-parity"));
  assert.ok(
    validation.checks.every(
      (check) => typeof check.title === "string" && typeof check.remediation === "string",
    ),
  );
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

  assert.equal(validation.templateId, "windows-heavy");
  assert.equal(validation.passed, true);
  assert.ok(
    validation.assumptions.some((assumption) =>
      assumption.includes("Template was inferred as 'windows-heavy'"),
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

  assert.equal(validation.templateId, "streaming-data-platform-standard");
  assert.equal(validation.passed, true);
  assert.ok(
    validation.assumptions.some((assumption) =>
      assumption.includes("Template was inferred as 'streaming-data-platform-standard'"),
    ),
  );
});
