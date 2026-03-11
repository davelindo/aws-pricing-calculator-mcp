import crypto from "node:crypto";

import { parseNumericValue, regionNameFor, roundCurrency } from "../model.js";
import {
  buildModeledBudgetPricer,
  buildRoadmapExactCapability,
  scaledRegionalPricing,
} from "./helpers.js";

const WAF_SERVICE_CODE = "awsWebApplicationFirewall";
const WAF_ESTIMATE_FOR = "awsWaf";
const WAF_VERSION = "0.0.34";
const DAYS_PER_MONTH = 30.4167;
const WAF_PRICING = {
  "us-east-1": {
    webAclPerMonth: 5,
    rulePerMonth: 1,
    requestsPerMillion: 0.6,
  },
};

function wafPricingFor(region) {
  return scaledRegionalPricing(WAF_PRICING, region, "WAF exact pricing");
}

function parseFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "perMonth";

  switch (unit) {
    case "perDay":
      return numericValue * DAYS_PER_MONTH;
    case "perWeek":
      return numericValue * (DAYS_PER_MONTH / 7);
    case "perMonth":
    default:
      return numericValue;
  }
}

function parseMillionFrequencyValue(component) {
  if (!component || typeof component !== "object") {
    return 0;
  }

  const numericValue = parseNumericValue(component.value, 0);
  const unit = component.unit ?? "millionPerMonth";

  switch (unit) {
    case "millionPerDay":
      return numericValue * DAYS_PER_MONTH;
    case "millionPerWeek":
      return numericValue * (DAYS_PER_MONTH / 7);
    case "millionPerMonth":
    case "perMonth":
    default:
      return numericValue;
  }
}

function wafBillableRulesPerAcl({
  rulesPerWebAcl = 0,
  ruleGroupsPerWebAcl = 0,
  rulesPerRuleGroup = 0,
  managedRuleGroups = 0,
}) {
  return (
    Math.max(parseNumericValue(rulesPerWebAcl, 0), 0) +
    Math.max(parseNumericValue(ruleGroupsPerWebAcl, 0), 0) *
      Math.max(parseNumericValue(rulesPerRuleGroup, 0), 0) +
    Math.max(parseNumericValue(ruleGroupsPerWebAcl, 0), 0) +
    Math.max(parseNumericValue(managedRuleGroups, 0), 0)
  );
}

function wafMonthlyUsd({
  region,
  webAclCount,
  rulesPerWebAcl = 0,
  ruleGroupsPerWebAcl = 0,
  rulesPerRuleGroup = 0,
  managedRuleGroups = 0,
  webRequestsMillions = 0,
}) {
  const pricing = wafPricingFor(region);

  return roundCurrency(
    Math.max(parseNumericValue(webAclCount, 0), 0) * pricing.webAclPerMonth +
      Math.max(parseNumericValue(webAclCount, 0), 0) *
        wafBillableRulesPerAcl({
          rulesPerWebAcl,
          ruleGroupsPerWebAcl,
          rulesPerRuleGroup,
          managedRuleGroups,
        }) *
        pricing.rulePerMonth +
      Math.max(parseNumericValue(webRequestsMillions, 0), 0) * pricing.requestsPerMillion,
  );
}

function wafShapeForBudget(region, monthlyBudgetUsd) {
  const pricing = wafPricingFor(region);
  const budget = Math.max(parseNumericValue(monthlyBudgetUsd, 0), 0);
  const webAclCount = 1;
  const managedRuleGroups = 1;
  const minimumSpend =
    webAclCount * pricing.webAclPerMonth + managedRuleGroups * pricing.rulePerMonth;
  const rulesPerWebAcl = Math.max(Math.min(Math.floor(Math.max(budget - minimumSpend, 0) / 2), 10), 0);
  const webRequestsMillions = Math.max(
    roundCurrency((budget - minimumSpend - rulesPerWebAcl) / pricing.requestsPerMillion),
    0,
  );

  return {
    webAclCount,
    rulesPerWebAcl,
    ruleGroupsPerWebAcl: 0,
    rulesPerRuleGroup: 0,
    managedRuleGroups,
    webRequestsMillions,
    monthlyUsd: wafMonthlyUsd({
      region,
      webAclCount,
      rulesPerWebAcl,
      managedRuleGroups,
      webRequestsMillions,
    }),
  };
}

export const awsWafV2Service = {
  id: "aws-waf-v2",
  name: "AWS WAF",
  category: "security",
  implementationStatus: "implemented",
  keywords: ["waf", "firewall", "web acl"],
  pricingStrategies: ["managed-rules", "custom-rules"],
  calculatorServiceCodes: [WAF_SERVICE_CODE],
  capabilityMatrix: buildRoadmapExactCapability(),
  buildEntry({ region, monthlyBudgetUsd, notes }) {
    const profile = wafShapeForBudget(region, monthlyBudgetUsd);

    return {
      key: `${WAF_SERVICE_CODE}-shared-${crypto.randomUUID()}`,
      breakdown: {
        serviceId: "aws-waf-v2",
        kind: WAF_SERVICE_CODE,
        label: "AWS WAF",
        category: "security",
        supportive: true,
        region,
        environment: "shared",
        monthlyUsd: profile.monthlyUsd,
        implementationStatus: "implemented",
        details: `${profile.webAclCount} web ACL, ${profile.rulesPerWebAcl} custom rules, ${profile.managedRuleGroups} managed rule groups, ${profile.webRequestsMillions} million requests per month`,
      },
      service: {
        calculationComponents: {
          numberOfWebAcls: {
            value: String(profile.webAclCount),
            unit: "perMonth",
          },
          numberOfRulesPerWebAcl: {
            value: String(profile.rulesPerWebAcl),
            unit: "perMonth",
          },
          numberOfRuleGroupsPerWebAcl: {
            value: String(profile.ruleGroupsPerWebAcl),
            unit: "perMonth",
          },
          numberOfRulesPerRuleGroup: {
            value: String(profile.rulesPerRuleGroup),
            unit: "perMonth",
          },
          numberOfManangedRules: {
            value: String(profile.managedRuleGroups),
            unit: "perMonth",
          },
          numberOfWebRequests: {
            value: String(profile.webRequestsMillions),
            unit: "millionPerMonth",
          },
        },
        serviceCode: WAF_SERVICE_CODE,
        region,
        estimateFor: WAF_ESTIMATE_FOR,
        version: WAF_VERSION,
        description: `AWS WAF baseline. Environment: shared. ${profile.webAclCount} web ACL, ${profile.rulesPerWebAcl} custom rules, ${profile.managedRuleGroups} managed rule groups, and ${profile.webRequestsMillions} million requests per month.${notes ? ` ${notes}` : ""}`,
        serviceCost: {
          monthly: profile.monthlyUsd,
          upfront: 0,
        },
        serviceName: "AWS Web Application Firewall (WAF)",
        regionName: regionNameFor(region),
        configSummary: `Number of Web ACLs (${profile.webAclCount} per month), Number of Rules added per Web ACL (${profile.rulesPerWebAcl} per month), Number of Rule Groups per Web ACL (${profile.ruleGroupsPerWebAcl} per month), Number of Rules inside each Rule Group (${profile.rulesPerRuleGroup} per month), Number of Managed Rule Groups per Web ACL (${profile.managedRuleGroups} per month), Number of web requests received (${profile.webRequestsMillions} million per month)`,
      },
    };
  },
  priceBudget: buildModeledBudgetPricer({
    unitRate: 25,
    detail: (units) => `${Math.round(units)} web ACL and managed-rule monthly equivalents`,
  }),
  modelSavedMonthlyUsd(service) {
    return wafMonthlyUsd({
      region: service?.region,
      webAclCount: parseFrequencyValue(service?.calculationComponents?.numberOfWebAcls),
      rulesPerWebAcl: parseFrequencyValue(service?.calculationComponents?.numberOfRulesPerWebAcl),
      ruleGroupsPerWebAcl: parseFrequencyValue(
        service?.calculationComponents?.numberOfRuleGroupsPerWebAcl,
      ),
      rulesPerRuleGroup: parseFrequencyValue(
        service?.calculationComponents?.numberOfRulesPerRuleGroup,
      ),
      managedRuleGroups: parseFrequencyValue(service?.calculationComponents?.numberOfManangedRules),
      webRequestsMillions: parseMillionFrequencyValue(
        service?.calculationComponents?.numberOfWebRequests,
      ),
    });
  },
};
