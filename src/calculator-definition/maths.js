import { fail } from "./diagnostics.js";
import { evaluateCondition } from "./expression.js";

function numeric(value, path) {
  const parsed = Number(value?.value ?? value);
  if (!Number.isFinite(parsed)) fail("maths.value.invalid", `Expected a finite number, received '${value}'.`, path, value);
  return parsed;
}

function rounded(value, places) {
  if (!Number.isInteger(places)) return value;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function operandValue(operand, values, path) {
  if (Object.hasOwn(operand, "constant")) return numeric(operand.constant, `${path}.constant`);
  if (operand.variableId) {
    if (!Object.hasOwn(values, operand.variableId)) {
      if (operand.required === false) return 0;
      fail("maths.reference.missing", `Maths component references missing '${operand.variableId}'.`, path, operand.variableId);
    }
    return numeric(values[operand.variableId], path);
  }
  fail("maths.operand.unsupported", "Maths operands require constant or variableId.", path, operand);
}

function basicMaths(component, values) {
  const operands = (component.operands ?? []).map((operand, index) =>
    operandValue(operand, values, `${component.sourcePath}.operands[${index}]`));
  if (operands.length === 0) fail("maths.operands.missing", "A basicMaths component requires operands.", component.sourcePath);
  const operations = {
    addition: () => operands.reduce((sum, item) => sum + item, 0),
    subtraction: () => operands.slice(1).reduce((result, item) => result - item, operands[0]),
    multiplication: () => operands.reduce((result, item) => result * item, 1),
    division: () => operands.slice(1).reduce((result, item, index) => {
      if (item === 0) fail("maths.division.zero", "Division by zero is not allowed.", `${component.sourcePath}.operands[${index + 1}]`);
      return result / item;
    }, operands[0]),
    Maximum: () => Math.max(...operands),
    Minimum: () => Math.min(...operands),
    exponent: () => operands.slice(1).reduce((result, item) => result ** item, operands[0]),
  };
  const operation = operations[component.operation];
  if (!operation) fail("maths.operation.unsupported", `Unsupported maths operation '${component.operation}'.`, component.sourcePath, component.operation);
  return rounded(operation(), component.decimalPlaces);
}

function tieredCost(input, pricing, component) {
  const pricingComponent = pricing[component.tieredPricingRefer];
  if (!pricingComponent || pricingComponent.kind !== "tiers") {
    fail("maths.tiers.missing", `Missing tier pricing '${component.tieredPricingRefer}'.`, component.sourcePath, component.tieredPricingRefer);
  }
  let total = 0;
  for (const tier of pricingComponent.tiers) {
    const start = Number(tier.startOfTier ?? 0);
    const end = Number(tier.endOfTier ?? -1);
    const quantity = Math.max(0, Math.min(input, end < 0 ? input : end) - start);
    total += quantity * numeric(tier.price, `${component.sourcePath}.tiers`);
  }
  return rounded(total, component.decimalPlaces);
}

export function evaluateMaths(template, { values = {}, pricing = {}, hasMeteredUnit, adapters = {} } = {}) {
  const evaluated = { ...values };
  const outputs = [];
  for (const component of template.maths) {
    const conditionContext = { values: evaluated, hasMeteredUnit };
    if (!evaluateCondition(component.card?.displayIf, conditionContext, `${component.sourcePath}.card.displayIf`)) continue;
    if (!evaluateCondition(component.displayIf, conditionContext, `${component.sourcePath}.displayIf`)) continue;
    let value;
    let adapterMetadata = null;
    switch (component.subType) {
      case "variable":
      case "ec2Variable":
        if (!Object.hasOwn(evaluated, component.refer)) {
          fail("maths.reference.missing", `Variable references missing '${component.refer}'.`, component.sourcePath, component.refer);
        }
        value = numeric(evaluated[component.refer], component.sourcePath);
        break;
      case "basicMaths":
        value = basicMaths(component, evaluated);
        break;
      case "tieredPricingMath":
        if (!Object.hasOwn(evaluated, component.inputRefer)) {
          fail("maths.reference.missing", `Tier maths references missing '${component.inputRefer}'.`, component.sourcePath, component.inputRefer);
        }
        value = tieredCost(numeric(evaluated[component.inputRefer], component.sourcePath), pricing, component);
        break;
      case "maxMin": {
        const operands = (component.operands ?? []).map((operand, index) =>
          operandValue(operand, evaluated, `${component.sourcePath}.operands[${index}]`));
        if (operands.length === 0) fail("maths.operands.missing", "maxMin requires operands.", component.sourcePath);
        if (component.operation === "Maximum") value = Math.max(...operands);
        else if (component.operation === "Minimum") value = Math.min(...operands);
        else fail("maths.operation.unsupported", `Unsupported maxMin operation '${component.operation}'.`, component.sourcePath, component.operation);
        value = rounded(value, component.decimalPlaces);
        break;
      }
      case "rounding": {
        const operands = (component.operands ?? []).map((operand, index) =>
          operandValue(operand, evaluated, `${component.sourcePath}.operands[${index}]`));
        const candidate = operands[0] ?? numeric(evaluated[component.refer ?? component.inputRefer], component.sourcePath);
        const factor = numeric(component.factor ?? 1, `${component.sourcePath}.factor`);
        if (factor <= 0) fail("maths.rounding.factor.invalid", "Rounding factor must be positive.", component.sourcePath, factor);
        const scaled = candidate / factor;
        if (component.method === "roundUp") value = Math.ceil(scaled) * factor;
        else if (component.method === "roundDown") value = Math.floor(scaled) * factor;
        else if (component.method === "standard") value = Math.round(scaled) * factor;
        else fail("maths.rounding.method.unsupported", `Unsupported rounding method '${component.method}'.`, component.sourcePath, component.method);
        value = rounded(value, component.decimalPlaces);
        break;
      }
      default:
        {
          const adapter = adapters[`${component.type}:${component.subType}`] ?? adapters[component.subType];
          if (typeof adapter !== "function") {
            fail("maths.subtype.unsupported", `Unsupported maths subtype '${component.subType}'.`, component.sourcePath, component.subType);
          }
          const result = adapter({ component, values: evaluated, pricing });
          if (!result?.handled || !Object.hasOwn(result, "value")) {
            fail("maths.adapter.declined", `Adapter declined '${component.subType}'.`, component.sourcePath, component.subType);
          }
          value = result.value;
          adapterMetadata = result;
          if (result.values) Object.assign(evaluated, result.values);
        }
    }
    evaluated[component.id] = value;
    outputs.push({
      id: component.id,
      value,
      outputUnitLabel: adapterMetadata?.outputUnitLabel ?? component.outputUnitLabel ?? null,
      ...(adapterMetadata?.costs ? { costs: adapterMetadata.costs } : {}),
    });
  }
  return { values: evaluated, outputs };
}
