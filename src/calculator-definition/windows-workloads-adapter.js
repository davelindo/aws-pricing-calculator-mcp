import { fail } from "./diagnostics.js";

export const WINDOWS_WORKLOADS_SERVICE_CODE = "windowsWorkloads";

const PRESENTATIONAL = new Set([
  "workflowInstruction",
  "uploadTable",
  "dedicatedHostsReviewTable",
  "dedicatedHostsCostTable",
  "sqlSummary",
  "windowsSummary",
  "inputField",
]);

function savedValue(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, "value")) {
    return { value: value.value, ...(value.unit == null ? {} : { unit: value.unit }) };
  }
  return { value };
}

function scalar(value) {
  return value && typeof value === "object" && Object.hasOwn(value, "value") ? value.value : value;
}

function derivedValues(value) {
  if (!value || typeof value !== "object") return {};
  return { ...(value.derived ?? {}), ...(value.subtotals ?? {}) };
}

function boundComponent({ component, bindings }) {
  const binding = bindings[component.id];
  if (binding == null) {
    if (component.validations?.required) {
      fail("windows-workloads.binding.required", `Windows Workloads requires '${component.id}'.`, component.sourcePath, component.id);
    }
    return { handled: true };
  }
  return {
    handled: true,
    values: { [component.id]: scalar(binding), ...derivedValues(binding) },
    calculationComponents: { [component.id]: savedValue(binding) },
  };
}

function conditionalCheckboxes({ component, bindings }) {
  const container = bindings[component.id] ?? {};
  const values = {};
  const calculationComponents = {};
  for (const option of component.options ?? []) {
    const value = bindings[option.id] ?? container[option.id] ?? option.prechecked ?? false;
    values[option.id] = Boolean(scalar(value));
    calculationComponents[option.id] = { value: String(values[option.id]) };
  }
  return { handled: true, values, calculationComponents };
}

function conditionalComponent({ component, bindings }) {
  if (!component.storeVariable) return { handled: true };
  const binding = bindings[component.id] ?? bindings[component.storeVariable];
  if (binding == null) return { handled: true };
  const value = scalar(binding);
  return {
    handled: true,
    values: { [component.id]: value, [component.storeVariable]: value, ...derivedValues(binding) },
    calculationComponents: { [component.storeVariable]: savedValue(binding) },
  };
}

function presentation() {
  return { handled: true };
}

function componentHandler(context) {
  if (PRESENTATIONAL.has(context.component.subType)) return presentation();
  if (context.component.subType === "conditionalCheckboxes") return conditionalCheckboxes(context);
  if (context.component.subType === "workloadsConditionalComponent") return conditionalComponent(context);
  return boundComponent(context);
}

function requiredSubtotal(values, id, component) {
  const value = Number(values[id]);
  if (!Number.isFinite(value)) {
    fail(
      "windows-workloads.subtotal.required",
      `Windows Workloads '${component.id}' requires resolved subtotal '${id}'.`,
      component.sourcePath,
      id,
    );
  }
  return value;
}

function dedicatedHostsMath({ component, values }) {
  const monthlyId = component.subTotalIds?.monthly?.dedicatedHosts;
  const upfrontId = component.subTotalIds?.upfront;
  return {
    handled: true,
    value: requiredSubtotal(values, monthlyId, component),
    costs: {
      monthly: requiredSubtotal(values, monthlyId, component),
      upfront: upfrontId && values[upfrontId] != null ? requiredSubtotal(values, upfrontId, component) : 0,
    },
  };
}

function selectedPricingModel(value) {
  const strategy = value && typeof value === "object" ? (value.value ?? value) : value;
  const selected = typeof strategy === "object" ? strategy.model : strategy;
  return selected === "reserved" ? "standard" : selected;
}

function workloadInstanceMath({ component, values }) {
  const monthlyIds = component.subTotalIds?.monthly ?? {};
  let model = selectedPricingModel(values.pricingStrategy);
  if (!monthlyIds[model]) {
    const available = Object.entries(monthlyIds).filter(([, id]) => Number.isFinite(Number(values[id])));
    if (available.length === 1) model = available[0][0];
  }
  const monthlyId = monthlyIds[model];
  if (!monthlyId) {
    fail("windows-workloads.pricing-model.required", "Windows Workloads requires a resolved pricing strategy.", component.sourcePath, values.pricingStrategy);
  }
  const upfrontId = component.subTotalIds?.upfront;
  const monthly = requiredSubtotal(values, monthlyId, component);
  return {
    handled: true,
    value: monthly,
    costs: {
      monthly,
      upfront: upfrontId && values[upfrontId] != null ? requiredSubtotal(values, upfrontId, component) : 0,
    },
  };
}

function workloadStorageMath({ component, values }) {
  const monthly = requiredSubtotal(values, component.subTotalId, component);
  return { handled: true, value: monthly, costs: { monthly, upfront: 0 } };
}

export function createWindowsWorkloadsAdapter() {
  const components = Object.fromEntries([
    "conditionalCheckboxes",
    "workloadsConditionalComponent",
    "workloadPriceSetFetcher",
    "workloadStoragePricing",
    "workflowInstruction",
    "uploadTable",
    "dedicatedHostsReviewTable",
    "pricingStrategy",
    "dedicatedHostsCostTable",
    "sqlSummary",
    "windowsSummary",
    "inputField",
    "workloadDropdown",
    "windowsWorkloadStorage",
    "workloadsInstanceSearch",
    "sqlPassiveNode",
  ].map((subType) => [subType, componentHandler]));
  return {
    serviceCode: WINDOWS_WORKLOADS_SERVICE_CODE,
    components,
    maths: { dedicatedHostsMath, workloadInstanceMath, workloadStorageMath },
    capabilities: {
      nativePayload: true,
      reprice: "requires-resolved-subtotals",
      requiredDerivedFacts: [
        "selected instance pricing-strategy subtotal",
        "instance upfront subtotal when applicable",
        "storage subtotal",
        "dedicated-host monthly/upfront subtotals when selected",
      ],
    },
  };
}

export const windowsWorkloadsAdapter = createWindowsWorkloadsAdapter();
