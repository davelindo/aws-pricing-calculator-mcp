import test from "node:test";
import assert from "node:assert/strict";

import { createModeledEstimate, planEstimate } from "../src/planner.js";

test("plan_estimate resolves a template brief into a ready plan", () => {
  const result = planEstimate({
    brief:
      "ExampleCo runs ECS + Postgres today. Needed: calculator (7k MRR EKS+RDS). Always use us-east-1. Usually 20/30/50 dev staging prod.",
  });

  assert.equal(result.readyToCreate, true);
  assert.equal(result.templateId, "eks-rds-standard");
  assert.equal(result.region, "us-east-1");
  assert.equal(result.targetMonthlyUsd, 7000);
  assert.deepEqual(result.environmentSplit, {
    dev: 0.2,
    staging: 0.3,
    prod: 0.5,
  });
  assert.equal(result.createInput?.templateId, "eks-rds-standard");
  assert.equal(result.servicePlanSummary?.includesEks, true);
});

test("plan_estimate blocks unsupported database engines", () => {
  const result = planEstimate({
    brief:
      "Need a 6k monthly Windows-heavy funding calculator, but the database is SQL Server.",
  });

  assert.equal(result.readyToCreate, false);
  assert.match(result.blockers.join(" "), /SQL Server/);
});

test("createModeledEstimate builds a funding-ready baseline", () => {
  const result = createModeledEstimate({
    templateId: "linux-heavy",
    targetMonthlyUsd: 5000,
    clientName: "ExampleCo",
  });

  assert.equal(result.template.id, "linux-heavy");
  assert.equal(result.estimate.name, "ExampleCo - Linux Heavy Baseline");
  assert.equal(result.validation.passed, true);
  assert.ok(result.serviceBreakdown.length >= 4);
});
