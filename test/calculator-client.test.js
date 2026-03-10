import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShareLink,
  extractEstimateId,
  fetchSavedEstimate,
  isOfficialCalculatorShareLink,
  saveEstimate,
} from "../src/calculator-client.js";

const ESTIMATE_ID = "0123456789abcdef0123456789abcdef01234567";

test.afterEach(() => {
  delete globalThis.fetch;
});

test("share link helpers round-trip estimate ids", () => {
  const shareLink = buildShareLink(ESTIMATE_ID);

  assert.equal(extractEstimateId(ESTIMATE_ID), ESTIMATE_ID);
  assert.equal(extractEstimateId(shareLink), ESTIMATE_ID);
  assert.equal(isOfficialCalculatorShareLink(shareLink), true);
});

test("saveEstimate unwraps the calculator save response body", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      body: JSON.stringify({
        savedKey: ESTIMATE_ID,
      }),
    }),
  });

  const saved = await saveEstimate({
    name: "Example",
    services: {},
  });

  assert.equal(saved.savedKey, ESTIMATE_ID);
  assert.equal(saved.shareLink, buildShareLink(ESTIMATE_ID));
});

test("fetchSavedEstimate loads the shared estimate document", async () => {
  const estimate = {
    name: "Example",
    services: {},
  };

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => estimate,
  });

  const fetched = await fetchSavedEstimate(ESTIMATE_ID);

  assert.equal(fetched.estimateId, ESTIMATE_ID);
  assert.equal(fetched.shareLink, buildShareLink(ESTIMATE_ID));
  assert.deepEqual(fetched.estimate, estimate);
});
