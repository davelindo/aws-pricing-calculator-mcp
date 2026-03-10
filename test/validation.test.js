import test from "node:test";
import assert from "node:assert/strict";

import { createModeledEstimate } from "../src/planner.js";
import { validateEstimatePayload } from "../src/validation.js";

test("validateEstimatePayload passes for a modeled estimate", () => {
  const created = createModeledEstimate({
    templateId: "eks-rds-standard",
    targetMonthlyUsd: 7000,
    clientName: "ExampleCo",
  });

  const validation = validateEstimatePayload({
    estimate: created.estimate,
    templateId: "eks-rds-standard",
    expectedMonthlyUsd: 7000,
    expectedRegion: "us-east-1",
  });

  assert.equal(validation.passed, true);
  assert.equal(validation.hardFailures.length, 0);
});

test("validateEstimatePayload fails when stored totals drift from modeled totals", () => {
  const created = createModeledEstimate({
    templateId: "linux-heavy",
    targetMonthlyUsd: 5000,
  });
  const estimate = structuredClone(created.estimate);
  const firstKey = Object.keys(estimate.services)[0];

  estimate.services[firstKey].serviceCost.monthly += 123;
  estimate.totalCost.monthly += 123;
  estimate.groupSubtotal.monthly += 123;

  const validation = validateEstimatePayload({
    estimate,
    templateId: "linux-heavy",
    expectedMonthlyUsd: 5000,
    expectedRegion: "us-east-1",
  });

  assert.equal(validation.passed, false);
  assert.ok(
    validation.hardFailures.some((failure) =>
      failure.startsWith("stored_costs_match_modeled_costs:"),
    ),
  );
});

test("validateEstimatePayload infers windows-heavy from saved services", () => {
  const created = createModeledEstimate({
    templateId: "windows-heavy",
    targetMonthlyUsd: 6000,
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
