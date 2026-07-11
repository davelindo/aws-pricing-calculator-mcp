import test from "node:test";
import assert from "node:assert/strict";

import { createAwsCalculatorDefinitionRuntime } from "../src/universal/dynamic-definition-runtime.js";

test("the AWS definition runtime resolves, fetches, and caches definition and pricing assets", async () => {
  const definitionUrl = "https://definitions.example/data/example/en_US.json";
  const pricingUrl =
    "https://calculator.aws/pricing/2.0/meteredUnitMaps/example/USD/current/example.json";
  const requests = [];
  const runtime = createAwsCalculatorDefinitionRuntime({
    catalog: {
      findByServiceCode(serviceCode) {
        return serviceCode === "example"
          ? { serviceCode, definitionUrl }
          : null;
      },
    },
    fetchImpl: async (url) => {
      requests.push(url);
      const body =
        url === definitionUrl
          ? { serviceCode: "example", version: "1", templates: [] }
          : { regions: {} };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  await runtime.loadDefinition("example");
  await runtime.loadDefinition("example");
  await runtime.loadPricing({
    serviceCode: "example",
    mapping: { name: "example" },
    url: "pricing/2.0/meteredUnitMaps/example/USD/current/example.json",
  });
  await runtime.loadPricing({
    serviceCode: "example",
    mapping: { name: "example" },
    url: "pricing/2.0/meteredUnitMaps/example/USD/current/example.json",
  });

  assert.deepEqual(requests, [definitionUrl, pricingUrl]);
  assert.equal(runtime.definitionCache.size, 1);
  assert.equal(runtime.pricingCache.size, 1);
});

