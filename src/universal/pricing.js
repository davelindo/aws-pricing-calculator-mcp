import crypto from "node:crypto";

import {
  buildEstimatePayloadFromEntries,
  ec2PricingStrategyMultiplier,
  modelEc2MonthlyUsd,
  modelNatMonthlyUsd,
  modelRdsMonthlyUsd,
  pricingFor,
  rdsPricingModelMultiplier,
  roundCurrency,
} from "../model.js";
import {
  exactLinkSupportedFor,
  normalizeScenarioPolicies,
} from "../scenario-policy.js";
import { capabilityForRegion } from "../services/helpers.js";
import { getServiceDefinition } from "../services/index.js";
import { validateUniversalEstimatePayload } from "./validation.js";

const CONTRACT_VERSION = "v2";
const DEFAULT_CURRENCY = "USD";
const DEFAULT_PERIOD = "month";
const MAX_COMPONENT_OCCURRENCES = 1_000;
const BUDGET_TOLERANCE_PCT = 0.1;

const RDS_BUDGET_PROFILES = [
  { instanceType: "db.t4g.large", deploymentOption: "Single-AZ", storageGb: 100 },
  { instanceType: "db.t4g.large", deploymentOption: "Multi-AZ", storageGb: 100 },
  { instanceType: "db.r6g.large", deploymentOption: "Single-AZ", storageGb: 150 },
  { instanceType: "db.r6g.large", deploymentOption: "Multi-AZ", storageGb: 150 },
  { instanceType: "db.r6g.xlarge", deploymentOption: "Single-AZ", storageGb: 200 },
  { instanceType: "db.r6g.xlarge", deploymentOption: "Multi-AZ", storageGb: 200 },
  { instanceType: "db.r6g.2xlarge", deploymentOption: "Single-AZ", storageGb: 300 },
  { instanceType: "db.r6g.2xlarge", deploymentOption: "Multi-AZ", storageGb: 300 },
  { instanceType: "db.r6g.4xlarge", deploymentOption: "Multi-AZ", storageGb: 500 },
];

class PricingInputError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "PricingInputError";
    this.field = field;
  }
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function money(amount) {
  return {
    amount: amount == null ? null : roundCurrency(Number(amount)),
    currency: DEFAULT_CURRENCY,
    period: DEFAULT_PERIOD,
  };
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null))];
}

function safeId(value) {
  return String(value ?? "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "item";
}

function derivedProvenance(source, confidence = 0.8) {
  const provenance = source?.provenance;

  return {
    mode: "derived",
    sourceIds: unique(provenance?.sourceIds ?? []),
    evidence: cloneJson(provenance?.evidence ?? []),
    confidence: Math.max(
      0,
      Math.min(1, Number(provenance?.confidence ?? confidence)),
    ),
  };
}

function pricingQuestion({ id, componentId = null, field, prompt, reason }) {
  return {
    id,
    prompt,
    blocking: true,
    priority: "high",
    relatedIds: componentId ? [componentId] : [],
    answerHint: reason ?? null,
    componentId,
    field,
    reason,
  };
}

function dedupeQuestions(questions) {
  const seen = new Set();

  return questions.filter((question) => {
    const key = `${question.id}:${question.componentId ?? "architecture"}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function componentServiceId(component) {
  const resolutionStatus =
    typeof component?.resolution === "string"
      ? component.resolution
      : component?.resolution?.status;

  if (resolutionStatus && !["resolved", "exact", "matched"].includes(resolutionStatus)) {
    return null;
  }

  return firstDefined(
    component?.resolution?.serviceId,
    component?.resolution?.catalogServiceId,
    component?.serviceId,
  ) ?? null;
}

function componentName(component) {
  return firstDefined(
    component?.name,
    component?.serviceName,
    component?.description,
    component?.id,
    "architecture component",
  );
}

function explicitBudgetFor(component) {
  const candidates = [
    [component?.monthlyBudgetUsd, "component.monthlyBudgetUsd"],
    [component?.configuration?.monthlyBudgetUsd, "configuration.monthlyBudgetUsd"],
    [component?.configuration?.monthlyCostUsd, "configuration.monthlyCostUsd"],
    [component?.usage?.monthlyBudgetUsd, "usage.monthlyBudgetUsd"],
    [component?.usage?.estimatedMonthlyUsd, "usage.estimatedMonthlyUsd"],
    [component?.usage?.monthlyCostUsd, "usage.monthlyCostUsd"],
  ];

  for (const [value, source] of candidates) {
    const amount = positiveNumber(value);

    if (amount != null) {
      return {
        amount: roundCurrency(amount),
        source,
      };
    }
  }

  return null;
}

function budgetFromConstraint(constraint) {
  const kind = String(constraint?.kind ?? constraint?.type ?? "").toLowerCase();

  if (!kind.includes("budget") && !kind.includes("cost")) {
    return null;
  }

  return positiveNumber(
    firstDefined(
      constraint?.monthlyUsd,
      constraint?.value?.monthlyUsd,
      constraint?.value?.amount,
      constraint?.value,
    ),
  );
}

function architectureTarget(architecture, suppliedTarget) {
  const explicitTarget = positiveNumber(suppliedTarget);

  if (explicitTarget != null) {
    return roundCurrency(explicitTarget);
  }

  const inlineTarget = positiveNumber(
    firstDefined(
      architecture?.targetMonthlyUsd,
      architecture?.pricingContext?.targetMonthlyUsd,
      architecture?.context?.targetMonthlyUsd,
    ),
  );

  if (inlineTarget != null) {
    return roundCurrency(inlineTarget);
  }

  for (const constraint of architecture?.constraints ?? []) {
    const appliesTo = constraint?.appliesTo ?? [];

    if (
      appliesTo.length > 0 &&
      !appliesTo.includes(architecture?.architectureId) &&
      !appliesTo.includes(architecture?.id)
    ) {
      continue;
    }

    const constrainedTarget = budgetFromConstraint(constraint);

    if (constrainedTarget != null) {
      return roundCurrency(constrainedTarget);
    }
  }

  return null;
}

function componentBudgetFromConstraints(architecture, componentId) {
  for (const constraint of architecture?.constraints ?? []) {
    if (!(constraint?.appliesTo ?? []).includes(componentId)) {
      continue;
    }

    const amount = budgetFromConstraint(constraint);

    if (amount != null) {
      return {
        amount: roundCurrency(amount),
        source: `constraint.${constraint.id ?? "component-budget"}`,
      };
    }
  }

  return null;
}

function regionValuesFromScope(scope) {
  const kind = String(scope?.kind ?? scope?.type ?? "").toLowerCase();
  const properties = scope?.properties ?? {};
  const values = [
    scope?.region,
    kind === "region" ? scope?.value : null,
    properties.region,
    ...(Array.isArray(scope?.regions) ? scope.regions : []),
    ...(Array.isArray(scope?.values) && kind === "region" ? scope.values : []),
    ...(Array.isArray(properties.regions) ? properties.regions : []),
  ];

  if (kind === "region" && typeof scope?.name === "string" && /^\w{2}-\w+-\d$/.test(scope.name)) {
    values.push(scope.name);
  }

  return unique(values.map((value) => String(value ?? "").trim()).filter(Boolean));
}

function regionForComponent(architecture, component) {
  const direct = firstDefined(
    component?.region,
    component?.configuration?.region,
    component?.properties?.region,
  );

  if (direct) {
    return String(direct);
  }

  const scopes = architecture?.scopes ?? [];
  const scopeIds = new Set(component?.scopeIds ?? []);
  const componentScopedRegions = unique(
    scopes
      .filter(
        (scope) =>
          scopeIds.has(scope.id) ||
          (Array.isArray(scope.componentIds) && scope.componentIds.includes(component.id)),
      )
      .flatMap(regionValuesFromScope),
  );

  if (componentScopedRegions.length === 1) {
    return componentScopedRegions[0];
  }

  const architectureRegions = unique([
    architecture?.region,
    ...(Array.isArray(architecture?.regions) ? architecture.regions : []),
    ...scopes.flatMap(regionValuesFromScope),
  ]);

  return architectureRegions.length === 1 ? String(architectureRegions[0]) : null;
}

function normalizedQuantity(component) {
  const raw = component?.quantity;

  if (raw == null) {
    return {
      quantity: 1,
      defaulted: true,
      valid: true,
    };
  }

  const parsed = Number(raw);
  const valid =
    Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_COMPONENT_OCCURRENCES;

  return {
    quantity: valid ? parsed : 1,
    defaulted: false,
    valid,
  };
}

function assumptionsMode(policy) {
  if (typeof policy === "string") {
    return policy.toLowerCase();
  }

  return String(policy?.mode ?? "allow-defaults").toLowerCase();
}

function mayDefaultField(policy, field) {
  if (typeof policy === "object" && policy?.allowDefaults === false) {
    return false;
  }

  const mode = assumptionsMode(policy);

  if (["strict", "explicit", "require-explicit", "no-defaults"].includes(mode)) {
    return false;
  }

  return !(policy?.requireConfirmationFor ?? []).includes(field);
}

function requiresBudgetToCompile(descriptor) {
  const configuration = descriptor.component.configuration ?? {};

  if (descriptor.definition?.universalPricingMode === "usage") {
    return false;
  }

  switch (descriptor.serviceId) {
    case "amazon-eks":
      return false;
    case "amazon-ec2":
      return !(
        positiveNumber(configuration.instanceCount) &&
        firstDefined(configuration.instanceType, configuration.instanceClass)
      );
    case "amazon-rds-postgresql":
      return !(
        firstDefined(configuration.instanceType, configuration.instanceClass) &&
        firstDefined(configuration.deploymentOption, configuration.deployment) &&
        positiveNumber(firstDefined(configuration.storageGb, configuration.storageGB))
      );
    case "amazon-vpc-nat":
      return !(
        configuration.natPlan ||
        nonNegativeNumber(
          firstDefined(configuration.dataProcessedGb, configuration.monthlyDataProcessedGb),
        ) != null
      );
    default:
      return true;
  }
}

function prepareComponents(architecture) {
  const questions = [];
  const isIgnored = (component) =>
    component?.inclusion === "excluded" ||
    component?.pricingStatus === "not-applicable" ||
    ["actor", "external"].includes(component?.kind);
  const ignoredComponents = (architecture?.components ?? []).filter(isIgnored);
  const components = (architecture?.components ?? []).filter(
    (component) => !isIgnored(component),
  );

  const descriptors = components.map((component, index) => {
    const id = String(component?.id ?? `component-${index + 1}`);
    const resolutionServiceId = componentServiceId(component);
    let definition = null;
    let definitionError = null;

    if (resolutionServiceId) {
      try {
        definition = getServiceDefinition(resolutionServiceId);
      } catch (error) {
        definitionError = error;
      }
    }

    const region = regionForComponent(architecture, component);
    const quantity = normalizedQuantity(component);
    const explicitBudget =
      explicitBudgetFor(component) ?? componentBudgetFromConstraints(architecture, id);

    if (component?.inclusion === "uncertain") {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(id)}.inclusion`,
          componentId: id,
          field: "inclusion",
          prompt: `Should '${componentName(component)}' be included in the priced architecture?`,
          reason: "The component was interpreted with uncertain inclusion.",
        }),
      );
    }

    if (!resolutionServiceId || !definition) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(id)}.service`,
          componentId: id,
          field: "serviceId",
          prompt: `Which supported AWS service should '${componentName(component)}' map to?`,
          reason:
            definitionError?.message ??
            component?.resolution?.reason ??
            "No supported service resolution is available.",
        }),
      );
    }

    if (definition && !region) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(id)}.region`,
          componentId: id,
          field: "region",
          prompt: `Which AWS region should be used for '${componentName(component)}'?`,
          reason: "Exact service pricing is region-specific and no unambiguous region was supplied.",
        }),
      );
    }

    if (!quantity.valid) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(id)}.quantity`,
          componentId: id,
          field: "quantity",
          prompt: `What whole-number quantity (1-${MAX_COMPONENT_OCCURRENCES}) should be used for '${componentName(component)}'?`,
          reason: `The supplied quantity '${component?.quantity}' cannot be represented as calculator line-item multiplicity.`,
        }),
      );
    }

    const capability =
      definition && region
        ? capabilityForRegion(definition.capabilityMatrix, region)
        : null;

    return {
      id,
      component,
      serviceId: resolutionServiceId,
      definition,
      definitionError,
      region,
      quantity: quantity.quantity,
      quantityDefaulted: quantity.defaulted,
      quantityValid: quantity.valid,
      explicitBudget,
      capability,
      allocation: null,
    };
  });

  return {
    descriptors,
    questions,
    ignoredComponentIds: ignoredComponents.map((component) => component?.id).filter(Boolean),
  };
}

function allocationWeight(descriptor) {
  return (
    positiveNumber(
      firstDefined(
        descriptor.component?.configuration?.costWeight,
        descriptor.component?.usage?.costWeight,
        descriptor.component?.properties?.costWeight,
      ),
    ) ?? descriptor.quantity
  );
}

function allocateBaseBudgets(descriptors, targetMonthlyUsd, questions) {
  const explicitTotal = roundCurrency(
    descriptors.reduce(
      (sum, descriptor) => sum + (descriptor.explicitBudget?.amount ?? 0),
      0,
    ),
  );
  const allocatable = descriptors.filter(
    (descriptor) =>
      descriptor.definition &&
      descriptor.region &&
      descriptor.quantityValid &&
      !descriptor.explicitBudget,
  );

  for (const descriptor of descriptors) {
    if (descriptor.explicitBudget) {
      descriptor.allocation = {
        monthlyBudgetUsd: descriptor.explicitBudget.amount,
        source: descriptor.explicitBudget.source,
        explicit: true,
      };
    }
  }

  if (targetMonthlyUsd == null) {
    for (const descriptor of allocatable) {
      if (!requiresBudgetToCompile(descriptor)) {
        descriptor.allocation = {
          monthlyBudgetUsd: null,
          source: "configuration",
          explicit: true,
        };
        continue;
      }

      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(descriptor.id)}.monthly-budget`,
          componentId: descriptor.id,
          field: "monthlyBudgetUsd",
          prompt: `What monthly USD budget or priced usage should be used for '${componentName(descriptor.component)}'?`,
          reason:
            "This service serializer needs a component budget, or an architecture target from which one can be allocated.",
        }),
      );
    }

    return;
  }

  const remaining = roundCurrency(targetMonthlyUsd - explicitTotal);

  if (explicitTotal > targetMonthlyUsd) {
    questions.push(
      pricingQuestion({
        id: "question.pricing.target-below-explicit-budgets",
        field: "targetMonthlyUsd",
        prompt:
          "Should the architecture target be increased, or should the explicit component budgets be reduced?",
        reason: `Explicit component budgets total ${explicitTotal.toFixed(2)} USD/month, above the ${targetMonthlyUsd.toFixed(2)} USD/month architecture target.`,
      }),
    );
  }

  if (allocatable.length === 0) {
    return;
  }

  if (remaining <= 0) {
    for (const descriptor of allocatable) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(descriptor.id)}.monthly-budget`,
          componentId: descriptor.id,
          field: "monthlyBudgetUsd",
          prompt: `What positive monthly budget should be reserved for '${componentName(descriptor.component)}'?`,
          reason: "The architecture target is fully consumed by explicit component budgets.",
        }),
      );
    }

    return;
  }

  const totalWeight = allocatable.reduce(
    (sum, descriptor) => sum + allocationWeight(descriptor),
    0,
  );
  let allocated = 0;

  allocatable.forEach((descriptor, index) => {
    const monthlyBudgetUsd =
      index === allocatable.length - 1
        ? roundCurrency(remaining - allocated)
        : roundCurrency((remaining * allocationWeight(descriptor)) / totalWeight);

    allocated = roundCurrency(allocated + monthlyBudgetUsd);
    descriptor.allocation = {
      monthlyBudgetUsd,
      source: "architecture-target-allocation",
      explicit: false,
      weight: allocationWeight(descriptor),
    };

    if (monthlyBudgetUsd <= 0) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(descriptor.id)}.monthly-budget`,
          componentId: descriptor.id,
          field: "monthlyBudgetUsd",
          prompt: `What positive monthly budget should be used for '${componentName(descriptor.component)}'?`,
          reason: "The available architecture target is too small to allocate a positive amount.",
        }),
      );
    }
  });
}

function policyBudgetMultiplier(descriptor, policy) {
  if (descriptor.allocation?.explicit) {
    return 1;
  }

  switch (descriptor.definition?.category) {
    case "compute":
      return Math.max(0, 1 - Number(policy.computeDiscountPct ?? 0) / 100);
    case "database":
      return Math.max(0, 1 - Number(policy.databaseDiscountPct ?? 0) / 100);
    case "storage":
      return Number(policy.storageCostFactor ?? 1);
    case "networking":
    case "edge":
      return (
        Number(policy.sharedServicesSpendFactor ?? policy.sharedServicesMultiplier ?? 1) *
        Number(policy.dataTransferFactor ?? policy.dataTransferMultiplier ?? 1)
      );
    case "operations":
    case "security":
      return Number(
        policy.sharedServicesSpendFactor ?? policy.sharedServicesMultiplier ?? 1,
      );
    default:
      return Number(policy.coreBudgetFactor ?? 1);
  }
}

function scenarioBudgetFor(descriptor, policy) {
  const baseBudget = descriptor.allocation?.monthlyBudgetUsd;

  if (baseBudget == null) {
    return null;
  }

  return roundCurrency(baseBudget * policyBudgetMultiplier(descriptor, policy));
}

function splitBudget(total, quantity) {
  if (total == null) {
    return Array.from({ length: quantity }, () => null);
  }

  let allocated = 0;

  return Array.from({ length: quantity }, (_, index) => {
    const amount =
      index === quantity - 1
        ? roundCurrency(total - allocated)
        : roundCurrency(total / quantity);

    allocated = roundCurrency(allocated + amount);
    return amount;
  });
}

function computePricingStrategy(configuration, policy) {
  const configured = configuration.pricingStrategy;

  if (configured && typeof configured === "object") {
    return {
      ...configured,
      selectedOption: configured.selectedOption ?? "on-demand",
      utilizationValue: configured.utilizationValue ?? "100",
    };
  }

  const selectedOption =
    typeof configured === "string"
      ? configured
      : firstDefined(configuration.purchaseOption, policy?.computeCommitment, "on-demand");

  return {
    selectedOption,
    term: "1 year",
    utilizationValue: "100",
  };
}

function databasePricingModel(configuration, policy) {
  const configured = firstDefined(configuration.pricingModel, configuration.purchaseOption);

  if (configured) {
    return configured;
  }

  if (policy?.databaseCommitment === "reserved-heavy") {
    return "ReservedHeavy";
  }

  if (policy?.databaseCommitment === "reserved") {
    return "Reserved";
  }

  return "OnDemand";
}

function requireOrDefault({ value, fallback, field, policy, addAssumption, statement }) {
  if (value !== undefined && value !== null && value !== "") {
    return value;
  }

  if (!mayDefaultField(policy, field)) {
    throw new PricingInputError(
      field,
      `Pricing field '${field}' is required by the assumptions policy.`,
    );
  }

  addAssumption(statement);
  return fallback;
}

function buildEc2Entry({
  descriptor,
  monthlyBudgetUsd,
  policy,
  assumptionsPolicy,
  addAssumption,
  notes,
}) {
  const configuration = descriptor.component.configuration ?? {};
  const operatingSystem = requireOrDefault({
    value: firstDefined(configuration.operatingSystem, configuration.os),
    fallback: "linux",
    field: "operatingSystem",
    policy: assumptionsPolicy,
    addAssumption,
    statement: "Operating system defaulted to Linux for EC2 calculator compatibility.",
  });
  const instanceType = requireOrDefault({
    value: firstDefined(configuration.instanceType, configuration.instanceClass),
    fallback: operatingSystem === "windows" ? "m6i.xlarge" : "m6i.large",
    field: "instanceType",
    policy: assumptionsPolicy,
    addAssumption,
    statement: `EC2 instance type defaulted to ${operatingSystem === "windows" ? "m6i.xlarge" : "m6i.large"}.`,
  });
  const pricingStrategy = computePricingStrategy(configuration, policy);
  let instanceCount = positiveNumber(configuration.instanceCount);

  if (instanceCount == null) {
    if (monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) {
      throw new PricingInputError(
        "instanceCount",
        "EC2 needs instanceCount or a positive component budget from which to infer it.",
      );
    }

    const perInstance =
      modelEc2MonthlyUsd(descriptor.region, operatingSystem, instanceType, 1) *
      ec2PricingStrategyMultiplier(pricingStrategy.selectedOption);
    instanceCount = Math.max(1, Math.round(monthlyBudgetUsd / perInstance));
    addAssumption(
      `EC2 instance count was inferred as ${instanceCount} from the ${monthlyBudgetUsd.toFixed(2)} USD/month line-item budget.`,
    );
  }

  const environment = requireOrDefault({
    value: firstDefined(descriptor.component.environment, configuration.environment),
    fallback: "shared",
    field: "environment",
    policy: assumptionsPolicy,
    addAssumption,
    statement: "EC2 environment label defaulted to shared.",
  });
  const args = {
    environment,
    region: descriptor.region,
    operatingSystem,
    instanceType,
    instanceCount,
    notes,
    pricingStrategy,
  };

  return {
    args,
    entry: descriptor.definition.buildEntry(args),
  };
}

function selectedRdsProfile(region, budget, pricingModel, policy) {
  const pricingMultiplier = rdsPricingModelMultiplier(pricingModel);
  const candidates = RDS_BUDGET_PROFILES.map((candidate) => {
    const deploymentOption =
      policy?.haPosture === "selective-ha"
        ? "Single-AZ"
        : policy?.haPosture === "standard"
          ? "Multi-AZ"
          : candidate.deploymentOption;
    const monthlyUsd = roundCurrency(
      modelRdsMonthlyUsd(
        region,
        candidate.instanceType,
        deploymentOption,
        candidate.storageGb,
      ) * pricingMultiplier,
    );

    return {
      ...candidate,
      deploymentOption,
      monthlyUsd,
    };
  });

  if (budget == null) {
    return candidates[0];
  }

  return candidates.sort(
    (left, right) =>
      Math.abs(left.monthlyUsd - budget) - Math.abs(right.monthlyUsd - budget),
  )[0];
}

function buildRdsPostgresqlEntry({
  descriptor,
  monthlyBudgetUsd,
  policy,
  assumptionsPolicy,
  addAssumption,
  notes,
}) {
  const configuration = descriptor.component.configuration ?? {};
  const pricingModel = databasePricingModel(configuration, policy);
  const defaultProfile = selectedRdsProfile(
    descriptor.region,
    monthlyBudgetUsd,
    pricingModel,
    policy,
  );
  const instanceType = requireOrDefault({
    value: firstDefined(configuration.instanceType, configuration.instanceClass),
    fallback: defaultProfile.instanceType,
    field: "instanceType",
    policy: assumptionsPolicy,
    addAssumption,
    statement: `RDS PostgreSQL instance type defaulted to ${defaultProfile.instanceType} as the closest compatibility profile.`,
  });
  const deploymentOption = requireOrDefault({
    value: firstDefined(configuration.deploymentOption, configuration.deployment),
    fallback: defaultProfile.deploymentOption,
    field: "deploymentOption",
    policy: assumptionsPolicy,
    addAssumption,
    statement: `RDS PostgreSQL deployment defaulted to ${defaultProfile.deploymentOption}.`,
  });
  const storageGb = Number(
    requireOrDefault({
      value: positiveNumber(firstDefined(configuration.storageGb, configuration.storageGB)),
      fallback: defaultProfile.storageGb,
      field: "storageGb",
      policy: assumptionsPolicy,
      addAssumption,
      statement: `RDS PostgreSQL storage defaulted to ${defaultProfile.storageGb} GB.`,
    }),
  );
  const environment = requireOrDefault({
    value: firstDefined(descriptor.component.environment, configuration.environment),
    fallback: "shared",
    field: "environment",
    policy: assumptionsPolicy,
    addAssumption,
    statement: "RDS PostgreSQL environment label defaulted to shared.",
  });
  const args = {
    environment,
    region: descriptor.region,
    instanceType,
    deploymentOption,
    storageGb,
    notes,
    pricingModel,
  };

  return {
    args,
    entry: descriptor.definition.buildEntry(args),
  };
}

function buildEksEntry({ descriptor, assumptionsPolicy, addAssumption, notes }) {
  const configuration = descriptor.component.configuration ?? {};
  const environment = requireOrDefault({
    value: firstDefined(descriptor.component.environment, configuration.environment),
    fallback: "shared",
    field: "environment",
    policy: assumptionsPolicy,
    addAssumption,
    statement: "EKS environment label defaulted to shared; each component occurrence represents one control plane.",
  });
  const args = {
    environment,
    region: descriptor.region,
    notes,
  };

  return {
    args,
    entry: descriptor.definition.buildEntry(args),
  };
}

function buildNatEntry({
  descriptor,
  monthlyBudgetUsd,
  assumptionsPolicy,
  addAssumption,
  notes,
}) {
  const configuration = descriptor.component.configuration ?? {};
  const configuredPlan = configuration.natPlan ?? {};
  const regionalNatGatewayCount = Number(
    requireOrDefault({
      value: nonNegativeNumber(
        firstDefined(
          configuredPlan.regionalNatGatewayCount,
          configuration.regionalNatGatewayCount,
        ),
      ),
      fallback: 1,
      field: "regionalNatGatewayCount",
      policy: assumptionsPolicy,
      addAssumption,
      statement: "NAT compatibility shape defaulted to one regional NAT gateway.",
    }),
  );
  const regionalNatGatewayAzCount = Number(
    requireOrDefault({
      value: nonNegativeNumber(
        firstDefined(
          configuredPlan.regionalNatGatewayAzCount,
          configuration.regionalNatGatewayAzCount,
        ),
      ),
      fallback: 2,
      field: "regionalNatGatewayAzCount",
      policy: assumptionsPolicy,
      addAssumption,
      statement: "NAT compatibility shape defaulted to two AZ NAT gateways.",
    }),
  );
  let dataProcessedGb = nonNegativeNumber(
    firstDefined(
      configuredPlan.dataProcessedGb,
      configuration.dataProcessedGb,
      configuration.monthlyDataProcessedGb,
      descriptor.component.usage?.dataProcessedGb,
      descriptor.component.usage?.monthlyDataProcessedGb,
    ),
  );

  if (dataProcessedGb == null) {
    if (monthlyBudgetUsd == null) {
      throw new PricingInputError(
        "dataProcessedGb",
        "NAT needs monthly data processed or a positive component budget from which to infer it.",
      );
    }

    const baseMonthlyUsd = modelNatMonthlyUsd(
      descriptor.region,
      regionalNatGatewayCount,
      regionalNatGatewayAzCount,
      0,
    );
    const perGb = pricingFor(descriptor.region).natGateway.dataPerGb;
    dataProcessedGb = Math.max(
      1_000,
      Math.round(Math.max(monthlyBudgetUsd - baseMonthlyUsd, 0) / perGb),
    );
    addAssumption(
      `NAT data processing was inferred as ${dataProcessedGb} GB/month from the line-item budget, with a 1,000 GB compatibility floor.`,
    );
  }

  const natPlan = {
    regionalNatGatewayCount,
    regionalNatGatewayAzCount,
    dataProcessedGb,
    monthlyUsd: modelNatMonthlyUsd(
      descriptor.region,
      regionalNatGatewayCount,
      regionalNatGatewayAzCount,
      dataProcessedGb,
    ),
  };
  const args = {
    region: descriptor.region,
    natPlan,
    notes,
  };

  return {
    args,
    entry: descriptor.definition.buildEntry(args),
  };
}

function buildExactEntry(context) {
  if (typeof context.descriptor.definition?.buildUniversalEntry === "function") {
    return context.descriptor.definition.buildUniversalEntry({
      region: context.descriptor.region,
      component: context.descriptor.component,
      monthlyBudgetUsd: context.monthlyBudgetUsd,
      notes: context.notes,
      policy: context.policy,
      assumptionsPolicy: context.assumptionsPolicy,
      addAssumption: context.addAssumption,
    });
  }

  switch (context.descriptor.serviceId) {
    case "amazon-ec2":
      return buildEc2Entry(context);
    case "amazon-eks":
      return buildEksEntry(context);
    case "amazon-rds-postgresql":
      return buildRdsPostgresqlEntry(context);
    case "amazon-vpc-nat":
      return buildNatEntry(context);
    default: {
      if (context.monthlyBudgetUsd == null || context.monthlyBudgetUsd <= 0) {
        throw new PricingInputError(
          "monthlyBudgetUsd",
          `${context.descriptor.definition.name} needs a positive monthly budget.`,
        );
      }

      const args = {
        region: context.descriptor.region,
        monthlyBudgetUsd: context.monthlyBudgetUsd,
        notes: context.notes,
      };

      return {
        args,
        entry: context.descriptor.definition.buildEntry(args),
      };
    }
  }
}

function assumptionCollector({ pricingId, scenarioId }) {
  const assumptions = [];
  const byKey = new Map();

  return {
    assumptions,
    add(componentId, statement) {
      const key = `${componentId}:${statement}`;

      if (byKey.has(key)) {
        return byKey.get(key);
      }

      const id = `assumption.pricing.${safeId(pricingId)}.${safeId(scenarioId)}.${safeId(componentId)}.${assumptions.length + 1}`;
      assumptions.push({
        id,
        statement,
        status: "applied",
        impact: "Pricing compatibility default or inference",
        appliesTo: [componentId],
        provenance: derivedProvenance(null, 0.7),
      });
      byKey.set(key, id);
      return id;
    },
  };
}

function pricingLineItem({
  descriptor,
  scenarioId,
  occurrence,
  monthlyBudgetUsd,
  monthlyUsd,
  details,
}) {
  return {
    id: `price.${safeId(scenarioId)}.${safeId(descriptor.id)}.${occurrence}`,
    description:
      details ??
      `${descriptor.definition?.name ?? componentName(descriptor.component)} occurrence ${occurrence}`,
    quantity: 1,
    unit: "component occurrence",
    rate: money(monthlyUsd),
    cost: money(monthlyUsd),
    provenance: derivedProvenance(descriptor.component),
    monthlyBudgetUsd,
  };
}

function unpricedComponentPlan(descriptor, status, warnings = []) {
  return {
    componentId: descriptor.id,
    serviceId: descriptor.serviceId,
    resolution: cloneJson(descriptor.component.resolution ?? null),
    status,
    calculatorServiceCode: descriptor.definition?.calculatorServiceCodes?.[0] ?? null,
    configuration: cloneJson(descriptor.component.configuration ?? {}),
    lineItems: [],
    cost: null,
    assumptionIds: [],
    warnings,
    provenance: derivedProvenance(descriptor.component, 0.4),
    quantity: descriptor.quantity,
    monthlyBudgetUsd: descriptor.allocation?.monthlyBudgetUsd ?? null,
  };
}

function coverageFor(componentPlans) {
  const priced = componentPlans.filter((plan) => plan.status === "priced");
  const estimated = componentPlans.filter((plan) => plan.status === "estimated");
  const unpriced = componentPlans.filter(
    (plan) => !["priced", "estimated"].includes(plan.status),
  );
  const coveredCount = priced.length + estimated.length;
  const componentCount = componentPlans.length;

  return {
    status:
      componentCount > 0 && unpriced.length === 0
        ? "complete"
        : coveredCount > 0
          ? "partial"
          : "unpriced",
    score: componentCount > 0 ? coveredCount / componentCount : 0,
    componentCount,
    pricedComponentCount: priced.length,
    estimatedComponentCount: estimated.length,
    unpricedComponentCount: unpriced.length,
    unpricedComponentIds: unpriced.map((plan) => plan.componentId),
    gaps: unpriced.flatMap((plan) => plan.warnings),
    exact: unique(priced.map((plan) => plan.serviceId)),
    modeled: unique(estimated.map((plan) => plan.serviceId)),
    unavailable: unique(unpriced.map((plan) => plan.serviceId ?? plan.componentId)),
    requestedQuantity: componentPlans.reduce(
      (sum, plan) => sum + Number(plan.quantity ?? 1),
      0,
    ),
    pricedLineItemCount: componentPlans.reduce(
      (sum, plan) => sum + plan.lineItems.length,
      0,
    ),
  };
}

function eligibilityFor({ componentPlans, blockers, warnings, policy }) {
  const eligibleComponentIds = componentPlans
    .filter((plan) => plan.status === "priced")
    .map((plan) => plan.componentId);
  const ineligibleComponentIds = componentPlans
    .filter((plan) => plan.status !== "priced")
    .map((plan) => plan.componentId);
  const allBlockers = [...blockers];

  if (!exactLinkSupportedFor(policy)) {
    allBlockers.push(`Scenario policy '${policy.id}' is modeled-only.`);
  }

  if (componentPlans.length === 0) {
    allBlockers.push("No included architecture components were supplied.");
  }

  const dedupedBlockers = unique(allBlockers);
  const eligible =
    dedupedBlockers.length === 0 &&
    ineligibleComponentIds.length === 0 &&
    componentPlans.length > 0;

  return {
    eligible,
    status: eligible ? "eligible" : "ineligible",
    eligibleComponentIds,
    ineligibleComponentIds,
    blockers: dedupedBlockers,
    warnings: unique(warnings),
  };
}

function compileScenario({
  architecture,
  descriptors,
  baseQuestions,
  policy,
  assumptionsPolicy,
  pricingId,
  targetMonthlyUsd,
}) {
  const collector = assumptionCollector({ pricingId, scenarioId: policy.id });
  const componentPlans = [];
  const planLineItems = [];
  const exactEntries = [];
  const questions = [...baseQuestions];
  const warnings = [];
  const blockers = [];
  const notes = firstDefined(
    architecture?.notes,
    architecture?.summary,
    `Universal architecture pricing scenario '${policy.id}'.`,
  );

  if (targetMonthlyUsd != null && descriptors.some((descriptor) => !descriptor.definition)) {
    const warning =
      "The architecture target was allocated only across resolved components; unresolved component costs are excluded from the partial total.";
    warnings.push(warning);
    collector.add("architecture", warning);
  }

  for (const descriptor of descriptors) {
    const componentWarnings = [];

    if (!descriptor.definition) {
      const warning = `Component '${descriptor.id}' has no supported service resolution.`;
      componentWarnings.push(warning);
      blockers.push(warning);
      componentPlans.push(unpricedComponentPlan(descriptor, "unpriced", componentWarnings));
      continue;
    }

    if (!descriptor.region) {
      const warning = `Component '${descriptor.id}' has no unambiguous AWS region.`;
      componentWarnings.push(warning);
      blockers.push(warning);
      componentPlans.push(unpricedComponentPlan(descriptor, "needs_input", componentWarnings));
      continue;
    }

    if (!descriptor.quantityValid) {
      const warning = `Component '${descriptor.id}' has an unsupported quantity.`;
      componentWarnings.push(warning);
      blockers.push(warning);
      componentPlans.push(unpricedComponentPlan(descriptor, "needs_input", componentWarnings));
      continue;
    }

    if (!descriptor.capability || descriptor.capability.support === "unavailable") {
      const warning =
        descriptor.capability?.reason ??
        `${descriptor.definition.name} is unavailable in ${descriptor.region}.`;
      componentWarnings.push(warning);
      blockers.push(warning);
      componentPlans.push(unpricedComponentPlan(descriptor, "unpriced", componentWarnings));
      continue;
    }

    const componentBudget = scenarioBudgetFor(descriptor, policy);
    const occurrenceBudgets = splitBudget(componentBudget, descriptor.quantity);

    if (
      descriptor.allocation == null &&
      requiresBudgetToCompile(descriptor)
    ) {
      const warning = `Component '${descriptor.id}' has no priced usage or monthly budget.`;
      componentWarnings.push(warning);
      blockers.push(warning);
      componentPlans.push(unpricedComponentPlan(descriptor, "needs_input", componentWarnings));
      continue;
    }

    if (descriptor.quantityDefaulted) {
      collector.add(
        descriptor.id,
        "Component quantity defaulted to one occurrence because none was supplied.",
      );
    }

    const assumptionIds = [];
    const resolvedOccurrences = [];
    const lineItems = [];
    const modeledBreakdowns = [];
    let failed = false;

    if (descriptor.quantity > 1 && componentBudget != null) {
      assumptionIds.push(
        collector.add(
          descriptor.id,
          `The component-level ${componentBudget.toFixed(2)} USD/month budget was split across ${descriptor.quantity} independently serialized occurrences.`,
        ),
      );
    }

    for (let occurrence = 1; occurrence <= descriptor.quantity; occurrence += 1) {
      const monthlyBudgetUsd = occurrenceBudgets[occurrence - 1];
      const addAssumption = (statement) => {
        const id = collector.add(descriptor.id, statement);
        assumptionIds.push(id);
        return id;
      };

      try {
        if (descriptor.capability.support === "modeled") {
          if (monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) {
            throw new PricingInputError(
              "monthlyBudgetUsd",
              `${descriptor.definition.name} modeled pricing needs a positive monthly budget.`,
            );
          }

          const breakdown = descriptor.definition.priceBudget({
            definition: descriptor.definition,
            region: descriptor.region,
            monthlyBudgetUsd,
            capability: descriptor.capability,
          });
          modeledBreakdowns.push(breakdown);
          lineItems.push(
            pricingLineItem({
              descriptor,
              scenarioId: policy.id,
              occurrence,
              monthlyBudgetUsd,
              monthlyUsd: breakdown.monthlyUsd,
              details: breakdown.details,
            }),
          );
          resolvedOccurrences.push({
            occurrence,
            monthlyBudgetUsd,
            modeledBreakdown: cloneJson(breakdown),
          });
          continue;
        }

        const built = buildExactEntry({
          descriptor,
          monthlyBudgetUsd,
          policy,
          assumptionsPolicy,
          addAssumption,
          notes,
        });
        const monthlyUsd = roundCurrency(built.entry.breakdown.monthlyUsd);
        const planLineItem = {
          id: `plan.${safeId(policy.id)}.${safeId(descriptor.id)}.${occurrence}`,
          componentId: descriptor.id,
          serviceId: descriptor.serviceId,
          occurrence,
          region: descriptor.region,
          monthlyBudgetUsd,
          budgetSource: descriptor.allocation?.source ?? "configuration",
          arguments: cloneJson(built.args),
          entry: cloneJson(built.entry),
        };

        exactEntries.push(built.entry);
        planLineItems.push(planLineItem);
        resolvedOccurrences.push({
          occurrence,
          monthlyBudgetUsd,
          arguments: cloneJson(built.args),
        });
        lineItems.push(
          pricingLineItem({
            descriptor,
            scenarioId: policy.id,
            occurrence,
            monthlyBudgetUsd,
            monthlyUsd,
            details: built.entry.breakdown.details,
          }),
        );
      } catch (error) {
        failed = true;
        const field =
          error instanceof PricingInputError || typeof error?.field === "string"
            ? error.field
            : "configuration";
        const warning = `Unable to price component '${descriptor.id}': ${error.message}`;
        componentWarnings.push(warning);
        blockers.push(warning);
        if (Array.isArray(error?.questions) && error.questions.length > 0) {
          questions.push(
            ...error.questions.map((question, index) => ({
              ...question,
              id:
                question.id ??
                `question.pricing.${safeId(descriptor.id)}.${safeId(field)}.${index + 1}`,
              componentId: question.componentId ?? descriptor.id,
              field: question.field ?? question.inputId ?? field,
              reason: question.reason ?? error.message,
            })),
          );
        } else {
          questions.push(
            pricingQuestion({
              id: `question.pricing.${safeId(descriptor.id)}.${safeId(field)}`,
              componentId: descriptor.id,
              field,
              prompt: `What ${field} should be used to price '${componentName(descriptor.component)}'?`,
              reason: error.message,
            }),
          );
        }
        break;
      }
    }

    if (failed) {
      componentPlans.push(unpricedComponentPlan(descriptor, "needs_input", componentWarnings));
      continue;
    }

    const componentMonthlyUsd = roundCurrency(
      lineItems.reduce((sum, lineItem) => sum + Number(lineItem.cost?.amount ?? 0), 0),
    );
    const tolerance =
      componentBudget == null
        ? null
        : Math.max(1, Math.abs(componentBudget) * BUDGET_TOLERANCE_PCT);

    if (
      componentBudget != null &&
      componentMonthlyUsd - componentBudget > tolerance
    ) {
      const warning = `Component '${descriptor.id}' compiles to ${componentMonthlyUsd.toFixed(2)} USD/month versus its ${componentBudget.toFixed(2)} USD/month allocation.`;
      componentWarnings.push(warning);
      warnings.push(warning);

      if (descriptor.allocation?.explicit) {
        blockers.push(warning);
        questions.push(
          pricingQuestion({
            id: `question.pricing.${safeId(descriptor.id)}.budget-fit.${safeId(policy.id)}`,
            componentId: descriptor.id,
            field: "monthlyBudgetUsd",
            prompt: `Should '${componentName(descriptor.component)}' use the compiled ${componentMonthlyUsd.toFixed(2)} USD/month shape, or should its explicit configuration/budget be changed?`,
            reason: warning,
          }),
        );
      }
    } else if (
      componentBudget != null &&
      componentBudget - componentMonthlyUsd > tolerance
    ) {
      const warning = `Component '${descriptor.id}' compiles below its allocation at ${componentMonthlyUsd.toFixed(2)} USD/month versus ${componentBudget.toFixed(2)} USD/month; unused budget was not fabricated into usage.`;
      componentWarnings.push(warning);
      warnings.push(warning);
    }

    componentPlans.push({
      componentId: descriptor.id,
      serviceId: descriptor.serviceId,
      resolution: cloneJson(descriptor.component.resolution ?? null),
      status: descriptor.capability.support === "exact" ? "priced" : "estimated",
      calculatorServiceCode: descriptor.definition.calculatorServiceCodes?.[0] ?? null,
      configuration: {
        requested: cloneJson(descriptor.component.configuration ?? {}),
        resolvedOccurrences,
        monthlyBudgetUsd: componentBudget,
        budgetSource: descriptor.allocation?.source ?? "configuration",
      },
      lineItems,
      cost: money(componentMonthlyUsd),
      assumptionIds: unique(assumptionIds),
      warnings: componentWarnings,
      provenance: derivedProvenance(descriptor.component),
      quantity: descriptor.quantity,
      monthlyBudgetUsd: componentBudget,
      budgetExplicit: descriptor.allocation?.explicit ?? false,
      modeledBreakdowns,
    });
  }

  const coverage = coverageFor(componentPlans);
  const total = roundCurrency(
    componentPlans.reduce((sum, plan) => sum + Number(plan.cost?.amount ?? 0), 0),
  );
  const allocatedTarget = roundCurrency(
    componentPlans.reduce(
      (sum, plan) => sum + Number(plan.monthlyBudgetUsd ?? 0),
      0,
    ),
  );
  const scenarioBudgetTolerance = Math.max(
    1,
    Math.abs(allocatedTarget) * BUDGET_TOLERANCE_PCT,
  );

  if (
    allocatedTarget > 0 &&
    total - allocatedTarget > scenarioBudgetTolerance
  ) {
    const reason = `The resolved scenario costs ${total.toFixed(2)} USD/month, above its ${allocatedTarget.toFixed(2)} USD/month allocation.`;
    blockers.push(reason);

    for (const plan of componentPlans.filter(
      (componentPlan) =>
        componentPlan.cost?.amount != null &&
        componentPlan.monthlyBudgetUsd != null &&
        componentPlan.cost.amount - componentPlan.monthlyBudgetUsd >
          Math.max(1, componentPlan.monthlyBudgetUsd * BUDGET_TOLERANCE_PCT),
    )) {
      questions.push(
        pricingQuestion({
          id: `question.pricing.${safeId(plan.componentId)}.budget-fit.${safeId(policy.id)}`,
          componentId: plan.componentId,
          field: "monthlyBudgetUsd",
          prompt: `Should component '${plan.componentId}' use its compiled ${plan.cost.amount.toFixed(2)} USD/month shape, or should its configuration/budget be changed?`,
          reason,
        }),
      );
    }
  }

  const maxAssumptions =
    typeof assumptionsPolicy === "object" &&
    Number.isInteger(assumptionsPolicy?.maxAssumptions) &&
    assumptionsPolicy.maxAssumptions >= 0
      ? assumptionsPolicy.maxAssumptions
      : null;

  if (maxAssumptions != null && collector.assumptions.length > maxAssumptions) {
    const reason = `Scenario '${policy.id}' requires ${collector.assumptions.length} pricing assumptions, above the policy limit of ${maxAssumptions}.`;
    blockers.push(reason);
    questions.push(
      pricingQuestion({
        id: `question.pricing.assumption-limit.${safeId(policy.id)}`,
        field: "assumptionsPolicy",
        prompt:
          "Should these pricing assumptions be confirmed, or will you provide the missing component configuration explicitly?",
        reason,
      }),
    );
  }

  const scenarioQuestions = dedupeQuestions(questions);

  for (const question of scenarioQuestions) {
    blockers.push(question.reason ?? question.prompt);
  }

  const eligibility = eligibilityFor({
    componentPlans,
    blockers,
    warnings,
    policy,
  });
  const regions = unique(planLineItems.map((lineItem) => lineItem.region));
  const estimateName = firstDefined(
    architecture?.estimateName,
    architecture?.title,
    architecture?.name,
    "Universal AWS Architecture",
  );
  const effectiveTarget = allocatedTarget > 0 ? allocatedTarget : total || targetMonthlyUsd;
  const lineItemPlan = deepFreeze({
    contractVersion: CONTRACT_VERSION,
    kind: "universal_line_item_plan",
    pricingId,
    architectureId: architecture?.architectureId ?? architecture?.id ?? null,
    scenarioId: policy.id,
    scenarioTitle: policy.title,
    estimateName: `${estimateName} - ${policy.title}`,
    targetMonthlyUsd: effectiveTarget ?? null,
    expectedMonthlyUsd: total,
    requestedTargetMonthlyUsd: targetMonthlyUsd ?? null,
    expectedRegion: regions.length === 1 ? regions[0] : null,
    expectedRegionMode: regions.length > 1 ? "multi-region" : "single-region",
    lineItems: cloneJson(planLineItems),
    eligibility: cloneJson(eligibility),
    exactLinkEligibility: cloneJson(eligibility),
    blockers: [...eligibility.blockers],
    coverage: cloneJson(coverage),
  });

  let validation = null;

  if (exactEntries.length > 0) {
    const estimate = buildEstimatePayloadFromEntries({
      estimateName: lineItemPlan.estimateName,
      entries: exactEntries,
    });

    validation = validateUniversalEstimatePayload({
      estimate,
      expectedMonthlyUsd: coverage.status === "complete" ? total : undefined,
      expectedRegion: lineItemPlan.expectedRegion ?? undefined,
      expectedRegionMode: lineItemPlan.expectedRegionMode,
    });
  }

  return {
    id: policy.id,
    title: policy.title,
    total: money(total),
    componentPlans,
    coverage,
    eligibility,
    exactLinkEligibility: eligibility,
    assumptionIds: unique([
      ...(architecture?.assumptions ?? []).map((assumption) => assumption?.id).filter(Boolean),
      ...collector.assumptions.map((assumption) => assumption.id),
    ]),
    warnings: unique([...warnings, ...eligibility.warnings]),
    provenance: derivedProvenance(architecture),
    policy: cloneJson(policy),
    targetMonthlyUsd: effectiveTarget ?? null,
    modeledMonthlyUsd: total,
    lineItemPlan,
    questions: scenarioQuestions,
    assumptions: collector.assumptions,
    validation,
  };
}

function overallStatus({ scenarios, questions, coverage }) {
  if (questions.length > 0) {
    return "needs_input";
  }

  if (coverage.status !== "complete") {
    return "partial";
  }

  return scenarios.some((scenario) => scenario.eligibility.eligible)
    ? "ready"
    : "partial";
}

function recommendedScenario(scenarios) {
  return (
    scenarios.find((scenario) => scenario.id === "baseline" && scenario.eligibility.eligible) ??
    scenarios.find((scenario) => scenario.eligibility.eligible) ??
    scenarios.find((scenario) => scenario.coverage.pricedComponentCount > 0) ??
    null
  );
}

/**
 * Compile an open ArchitectureIR directly into compositional pricing scenarios.
 * Every included component is retained and priced compositionally.
 */
export function priceUniversalArchitecture({
  architecture,
  targetMonthlyUsd,
  assumptionsPolicy,
  scenarioPolicies,
} = {}) {
  if (!architecture || typeof architecture !== "object") {
    throw new TypeError("priceUniversalArchitecture requires an architecture object.");
  }

  const pricingId = `pricing-${crypto.randomUUID()}`;
  const target = architectureTarget(architecture, targetMonthlyUsd);
  const prepared = prepareComponents(architecture);
  const baseQuestions = [...prepared.questions];

  allocateBaseBudgets(prepared.descriptors, target, baseQuestions);

  if (prepared.descriptors.length === 0) {
    baseQuestions.push(
      pricingQuestion({
        id: "question.pricing.components",
        field: "components",
        prompt: "Which AWS architecture components should be priced?",
        reason: "The architecture contains no included components.",
      }),
    );
  }

  const policies = normalizeScenarioPolicies(scenarioPolicies);
  const scenarios = policies.map((policy) =>
    compileScenario({
      architecture,
      descriptors: prepared.descriptors,
      baseQuestions: dedupeQuestions(baseQuestions),
      policy,
      assumptionsPolicy,
      pricingId,
      targetMonthlyUsd: target,
    }),
  );
  const recommended = recommendedScenario(scenarios);
  const baseline = scenarios.find((scenario) => scenario.id === "baseline") ?? scenarios[0] ?? null;
  const representative = recommended ?? baseline;
  const coverage = representative?.coverage ?? coverageFor([]);
  const eligibility = representative?.eligibility ?? eligibilityFor({
    componentPlans: [],
    blockers: ["No pricing scenario could be compiled."],
    warnings: [],
    policy: policies[0] ?? {},
  });
  const questions = dedupeQuestions(baseline?.questions ?? baseQuestions);
  const assumptions = unique(
    scenarios
      .flatMap((scenario) => scenario.assumptions)
      .map((assumption) => JSON.stringify(assumption)),
  ).map((assumption) => JSON.parse(assumption));
  const warnings = unique(scenarios.flatMap((scenario) => scenario.warnings));

  return {
    contractVersion: CONTRACT_VERSION,
    kind: "priced_architecture",
    pricingId,
    architecture,
    scenarios,
    recommendedScenarioId: recommended?.id ?? null,
    coverage,
    eligibility,
    warnings,
    status: overallStatus({ scenarios, questions, coverage }),
    targetMonthlyUsd: target,
    componentPlans: representative?.componentPlans ?? [],
    exactLinkEligibility: eligibility,
    lineItemPlan: representative?.lineItemPlan ?? null,
    questions,
    assumptions,
    ignoredComponentIds: prepared.ignoredComponentIds,
  };
}

/**
 * Materialize a calculator estimate from a fully resolved universal line-item plan.
 */
export function buildUniversalEstimateFromPlan(plan) {
  if (!plan || plan.kind !== "universal_line_item_plan") {
    throw new TypeError("A universal_line_item_plan is required.");
  }

  const eligibility = plan.eligibility ?? plan.exactLinkEligibility;

  if (!eligibility?.eligible) {
    throw new Error(
      `Unable to build an exact universal estimate: ${(eligibility?.blockers ?? plan.blockers ?? ["plan is not calculator-eligible"]).join(" ")}`,
    );
  }

  const entries = (plan.lineItems ?? []).map((lineItem) => cloneJson(lineItem.entry));

  if (entries.length === 0 || entries.some((entry) => !entry?.service || !entry?.key)) {
    throw new Error("Universal line-item plan does not contain resolved calculator entries.");
  }

  const estimate = buildEstimatePayloadFromEntries({
    estimateName: plan.estimateName,
    entries,
  });
  const validation = validateUniversalEstimatePayload({
    estimate,
    expectedMonthlyUsd:
      plan.expectedMonthlyUsd ?? plan.modeledMonthlyUsd ?? plan.targetMonthlyUsd ?? undefined,
    expectedRegion: plan.expectedRegion ?? undefined,
    expectedRegionMode: plan.expectedRegionMode,
  });

  return {
    estimate,
    entries,
    serviceBreakdown: entries.map((entry) => cloneJson(entry.breakdown)),
    validation,
    lineItemPlan: plan,
  };
}

export { deepFreeze as freezeUniversalPlan };
