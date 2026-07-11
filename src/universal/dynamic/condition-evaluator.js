const UNKNOWN = Symbol("unknown-condition-value");

function unwrap(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return value.value;
  }

  return value;
}

function lookup(values, id) {
  if (!id) return UNKNOWN;
  if (Object.prototype.hasOwnProperty.call(values, id)) return unwrap(values[id]);

  const normalized = normalizeConditionId(id);
  const key = Object.keys(values).find(
    (candidate) => normalizeConditionId(candidate) === normalized,
  );
  return key === undefined ? UNKNOWN : unwrap(values[key]);
}

function normalizeConditionId(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function referenceId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = String(value.type ?? value.kind ?? "").toLowerCase();

  if (["component", "input", "binding", "field", "var"].includes(type)) {
    return value.id ?? value.componentId ?? value.inputId ?? value.field ?? value.name ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(value, "var")) return value.var;
  return null;
}

function resolveOperand(operand, context, missingReferences) {
  const id = referenceId(operand);

  if (id) {
    const value = lookup(context.values, id);
    if (value === UNKNOWN) missingReferences.add(String(id));
    return value;
  }

  if (Array.isArray(operand)) {
    return operand.map((item) => resolveOperand(item, context, missingReferences));
  }

  if (!operand || typeof operand !== "object") return operand;

  const type = String(operand.type ?? operand.kind ?? "").toLowerCase();
  if (["meteredunit", "metered-unit", "meter"].includes(type)) {
    const id = operand.id ?? operand.name;
    const meters = context.pricing?.meteredUnits ?? context.meteredUnits ?? {};
    const value = lookup(meters, id);
    if (value === UNKNOWN) missingReferences.add(`meteredUnit:${id}`);
    return value;
  }

  return operand;
}

function compare(operator, left, right) {
  if (left === UNKNOWN || right === UNKNOWN) return null;

  switch (operator) {
    case "==":
    case "=":
    case "eq":
      return left === right || String(left) === String(right);
    case "!=":
    case "ne":
      return !(left === right || String(left) === String(right));
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case "in":
      return Array.isArray(right) && right.some((item) => item === left || String(item) === String(left));
    default:
      return null;
  }
}

function evaluateNode(condition, context, missingReferences) {
  if (condition === undefined || condition === null) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition !== "object") return Boolean(condition);
  if (Array.isArray(condition)) {
    const results = condition.map((item) => evaluateNode(item, context, missingReferences));
    if (results.some((item) => item === false)) return false;
    return results.every((item) => item === true) ? true : null;
  }

  // Also accept a small normalized predicate shape in addition to the AWS JSON-logic form.
  const normalizedInputId =
    condition.inputId ?? condition.componentId ?? condition.field ?? condition.dependsOn;
  if (normalizedInputId) {
    const operator = condition.operator ?? ("equals" in condition ? "==" : "exists");
    const expected = condition.value ?? condition.equals;
    const actual = lookup(context.values, normalizedInputId);
    if (actual === UNKNOWN) missingReferences.add(String(normalizedInputId));
    if (operator === "exists") return actual === UNKNOWN ? false : actual !== undefined && actual !== null;
    return compare(operator, actual, expected);
  }

  const entries = Object.entries(condition);
  if (entries.length !== 1) return null;
  const [operator, operands] = entries[0];
  const normalizedOperator = operator.toLowerCase();
  const items = Array.isArray(operands) ? operands : [operands];

  if (normalizedOperator === "and") {
    const results = items.map((item) => evaluateNode(item, context, missingReferences));
    if (results.some((item) => item === false)) return false;
    return results.every((item) => item === true) ? true : null;
  }

  if (normalizedOperator === "or") {
    const results = items.map((item) => evaluateNode(item, context, missingReferences));
    if (results.some((item) => item === true)) return true;
    return results.every((item) => item === false) ? false : null;
  }

  if (["not", "!"].includes(normalizedOperator)) {
    const result = evaluateNode(items[0], context, missingReferences);
    return result === null ? null : !result;
  }

  if (["checkboxchecked", "checkboxnotchecked"].includes(normalizedOperator)) {
    const value = resolveOperand(items[0], context, missingReferences);
    if (value === UNKNOWN) return null;
    const checked =
      value === true ||
      value === 1 ||
      ["true", "1", "yes", "on", "checked"].includes(String(value).toLowerCase());
    return normalizedOperator === "checkboxchecked" ? checked : !checked;
  }

  if (normalizedOperator === "exists") {
    const operand = items[0];
    const id = referenceId(operand);
    const type = String(operand?.type ?? operand?.kind ?? "").toLowerCase();
    let value;

    if (["meteredunit", "metered-unit", "meter"].includes(type)) {
      const mapping = operand.mappingDefinitionName;
      const unit = operand.meteredUnit ?? operand.id ?? operand.name;
      if (typeof context.pricing?.hasMeteredUnit === "function") {
        return Boolean(context.pricing.hasMeteredUnit(mapping, unit));
      }
      const meters = context.pricing?.meteredUnits ?? context.meteredUnits ?? {};
      const scoped = mapping && meters?.[mapping] ? meters[mapping] : meters;
      value = lookup(scoped, unit);
    } else {
      value = resolveOperand(operand, context, missingReferences);
    }

    if (value === UNKNOWN) {
      if (id) missingReferences.add(String(id));
      return false;
    }
    return value !== undefined && value !== null && value !== false;
  }

  if (["==", "=", "eq", "!=", "ne", ">", ">=", "<", "<=", "in"].includes(normalizedOperator)) {
    const left = resolveOperand(items[0], context, missingReferences);
    const right = resolveOperand(items[1], context, missingReferences);
    return compare(normalizedOperator, left, right);
  }

  return null;
}

/**
 * Evaluate the calculator's preserved JSON-logic display condition without executing code.
 * `value` is null when the predicate cannot yet be decided from the supplied bindings.
 */
export function evaluateDisplayCondition(condition, { values = {}, pricing = null } = {}) {
  const missingReferences = new Set();
  const value = evaluateNode(condition, { values, pricing }, missingReferences);

  return {
    value,
    known: value !== null,
    missingReferences: [...missingReferences],
  };
}

export function referencedInputIds(condition, result = new Set()) {
  if (!condition || typeof condition !== "object") return [...result];
  if (Array.isArray(condition)) {
    condition.forEach((item) => referencedInputIds(item, result));
    return [...result];
  }

  const id = referenceId(condition);
  if (id) result.add(String(id));
  const normalized =
    condition.inputId ?? condition.componentId ?? condition.field ?? condition.dependsOn;
  if (normalized) result.add(String(normalized));
  Object.values(condition).forEach((item) => referencedInputIds(item, result));
  return [...result];
}
