import test from "node:test";
import assert from "node:assert/strict";

import { fetchSavedEstimate, saveEstimate } from "../src/calculator-client.js";
import { createModeledEstimate } from "../src/planner.js";
import { validateEstimatePayload } from "../src/validation.js";

const LIVE_ENABLED = process.env.AWS_CALCULATOR_LIVE === "1";
const CASES = [
  {
    templateId: "eks-rds-standard",
    targetMonthlyUsd: 7000,
  },
  {
    templateId: "linux-heavy",
    targetMonthlyUsd: 5000,
  },
  {
    templateId: "windows-heavy",
    targetMonthlyUsd: 6000,
  },
];

test(
  "live calculator round-trips preserve the modeled estimates",
  {
    skip: !LIVE_ENABLED,
  },
  async () => {
    for (const testCase of CASES) {
      const created = createModeledEstimate({
        ...testCase,
        clientName: "LiveTest",
      });
      const saved = await saveEstimate(created.estimate);
      const fetched = await fetchSavedEstimate(saved.savedKey);
      const validation = validateEstimatePayload({
        estimate: fetched.estimate,
        templateId: testCase.templateId,
        expectedMonthlyUsd: testCase.targetMonthlyUsd,
        expectedRegion: "us-east-1",
      });

      assert.equal(validation.passed, true, `live validation failed for ${testCase.templateId}`);
    }
  },
);
