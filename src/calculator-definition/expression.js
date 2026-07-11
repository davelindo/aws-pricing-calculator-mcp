import { fail } from "./diagnostics.js";

function componentValue(reference, context, path) {
  if (!reference || reference.type !== "component" || typeof reference.id !== "string") {
    fail("condition.reference.unsupported", "A condition reference must identify a component.", path, reference);
  }

  return context.values?.[reference.id];
}

function comparable(value, context, path) {
  if (value && typeof value === "object" && value.type) {
    return componentValue(value, context, path);
  }
  return value;
}

function meteredUnitExists(spec, context, path) {
  if (spec?.type === "component" && typeof spec.id === "string") {
    return Object.hasOwn(context.values ?? {}, spec.id) && context.values[spec.id] != null;
  }
  if (!spec || spec.type !== "meteredUnit" || !spec.mappingDefinitionName || !spec.meteredUnit) {
    fail("condition.exists.unsupported", "exists supports component and meteredUnit references.", path, spec);
  }

  if (typeof context.hasMeteredUnit !== "function") {
    fail("condition.pricing.missing", "Pricing existence checks require hasMeteredUnit.", path, "exists");
  }

  return Boolean(context.hasMeteredUnit(spec.mappingDefinitionName, spec.meteredUnit));
}

export function evaluateCondition(expression, context = {}, path = "$") {
  if (expression == null) return true;
  if (typeof expression === "boolean") return expression;
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
    fail("condition.invalid", "A display condition must be an object.", path, expression);
  }

  const keys = Object.keys(expression);
  if (keys.length !== 1) {
    fail("condition.shape.unsupported", "A condition must contain exactly one operator.", path, keys);
  }

  const operator = keys[0];
  const operand = expression[operator];
  if (operator === "and" || operator === "or") {
    if (!Array.isArray(operand)) fail("condition.operands.invalid", `${operator} requires an array.`, path, operator);
    const results = operand.map((entry, index) => evaluateCondition(entry, context, `${path}.${operator}[${index}]`));
    return operator === "and" ? results.every(Boolean) : results.some(Boolean);
  }
  if (operator === "not" || operator === "!") {
    return !evaluateCondition(operand, context, `${path}.${operator}`);
  }
  if (operator === "exists") return meteredUnitExists(operand, context, `${path}.exists`);
  if (operator === "checkboxChecked" || operator === "checkboxNotChecked") {
    const value = componentValue(operand, context, `${path}.${operator}`);
    const checked = value === true || value === 1 || ["true", "1", "yes", "on", "checked"].includes(String(value).toLowerCase());
    return operator === "checkboxChecked" ? checked : !checked;
  }

  const comparisons = {
    "==": (a, b) => a === b || String(a) === String(b),
    "!=": (a, b) => !(a === b || String(a) === String(b)),
    ">": (a, b) => Number(a) > Number(b),
    ">=": (a, b) => Number(a) >= Number(b),
    "<": (a, b) => Number(a) < Number(b),
    "<=": (a, b) => Number(a) <= Number(b),
  };
  if (comparisons[operator]) {
    if (!Array.isArray(operand) || operand.length !== 2) {
      fail("condition.comparison.invalid", `${operator} requires two operands.`, path, operator);
    }
    return comparisons[operator](
      comparable(operand[0], context, `${path}.${operator}[0]`),
      comparable(operand[1], context, `${path}.${operator}[1]`),
    );
  }

  fail("condition.operator.unsupported", `Unsupported condition operator '${operator}'.`, path, operator);
}
