import { getTemplate } from "./catalog.js";
import { designArchitecture, priceArchitecture, buildExactEstimateFromLinkPlan } from "./architecture.js";

export { designArchitecture, priceArchitecture };

export function buildCalculatorEstimateFromScenario({ pricedScenario }) {
  const linkPlan = pricedScenario?.linkPlan;

  if (!linkPlan) {
    throw new Error(
      `Unable to create estimate: ${pricedScenario?.calculatorBlockers?.join(" ") || "scenario is not calculator-eligible."}`,
    );
  }

  const template = getTemplate(linkPlan.templateId);
  const built = buildExactEstimateFromLinkPlan(linkPlan);

  return {
    template,
    estimate: built.estimate,
    serviceBreakdown: built.breakdown,
    validation: built.validation,
    linkPlan,
  };
}
