function safeId(value) {
  return (
    String(value ?? "input")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "input"
  );
}

function answerHintFor(binding) {
  const options = binding.input?.options ?? [];
  const units = binding.input?.units ?? [];
  const hints = [];

  if (options.length) {
    hints.push(
      `Choose one of: ${options
        .filter((option) => option.visible !== false)
        .slice(0, 12)
        .map((option) => option.label ?? option.id)
        .join(", ")}.`,
    );
  }

  if (units.length) {
    hints.push(`Include a unit (${units.map((unit) => unit.label ?? unit.id).join(", ")}).`);
  }

  const validations = binding.input?.validations ?? {};
  const minimum = validations.minimum ?? validations.min;
  const maximum = validations.maximum ?? validations.max;
  if (minimum !== undefined || maximum !== undefined) {
    hints.push(
      `Expected range: ${minimum ?? "unbounded"} to ${maximum ?? "unbounded"}.`,
    );
  }

  return hints.length ? hints.join(" ") : null;
}

function makeQuestion(binding, diagnostic, componentId) {
  const inputId = binding.inputId;
  const label = binding.label ?? inputId;
  const ambiguous = binding.status === "ambiguous";
  const invalid = binding.status === "invalid";
  const conditional = diagnostic?.code === "binding.condition-unknown";
  let prompt;

  if (ambiguous) {
    prompt = `Which architecture fact should supply '${label}' for '${componentId}'?`;
  } else if (invalid) {
    prompt = `What valid value should '${label}' use for '${componentId}'?`;
  } else if (conditional) {
    prompt = `What value determines whether '${label}' applies to '${componentId}'?`;
  } else {
    prompt = `What should '${label}' be for '${componentId}'?`;
  }

  return {
    id: `question.calculator-input.${safeId(componentId)}.${safeId(inputId)}.${
      ambiguous ? "ambiguous" : invalid ? "invalid" : conditional ? "condition" : "missing"
    }`,
    prompt,
    blocking: binding.required !== false || conditional,
    priority: binding.required !== false || conditional ? "high" : "medium",
    relatedIds: [componentId, inputId],
    answerHint: answerHintFor(binding),
    componentId,
    inputId,
    reason: diagnostic?.message ?? binding.reason ?? null,
    diagnosticIds: diagnostic ? [diagnostic.id] : [],
  };
}

/** Generate stable, targeted questions from detailed input binding results. */
export function generateInputQuestions(bindingResult, { includeOptionalAmbiguities = true } = {}) {
  const componentId = bindingResult?.componentId ?? "component";
  const diagnostics = bindingResult?.diagnostics ?? [];
  const questions = [];

  for (const binding of bindingResult?.inputBindings ?? []) {
    const shouldAskMissing = binding.status === "missing" && binding.required === true;
    const shouldAskAmbiguous =
      binding.status === "ambiguous" && (binding.required === true || includeOptionalAmbiguities);
    const shouldAskInvalid =
      binding.status === "invalid" && (binding.required === true || includeOptionalAmbiguities);
    const diagnostic = diagnostics.find((item) => item.inputId === binding.inputId);

    if (shouldAskMissing || shouldAskAmbiguous || shouldAskInvalid) {
      questions.push(makeQuestion(binding, diagnostic, componentId));
    } else if (
      binding.visibility === "unknown" &&
      binding.required !== false &&
      diagnostic?.code === "binding.condition-unknown"
    ) {
      questions.push(makeQuestion(binding, diagnostic, componentId));
    }
  }

  const seen = new Set();
  return questions.filter((question) => {
    const key = `${question.componentId}:${question.inputId}:${question.id.split(".").at(-1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

