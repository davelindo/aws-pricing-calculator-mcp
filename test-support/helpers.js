import assert from "node:assert/strict";

export const ROADMAP_REGIONS = [
  "us-east-1",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "ap-southeast-2",
  "ap-northeast-2",
];

export const NON_DEFAULT_REGION_GOVERNANCE_FAILURE_ID =
  "governance.non-default-region-justification";

export function getScenario(priced, scenarioId = "baseline") {
  const scenario = priced.scenarios.find((candidate) => candidate.id === scenarioId);

  assert.ok(scenario, `expected scenario '${scenarioId}' to exist`);
  return scenario;
}

export function allowedBlockingFailureIdsForRegion(region) {
  return region === "us-east-1" ? [] : [NON_DEFAULT_REGION_GOVERNANCE_FAILURE_ID];
}
