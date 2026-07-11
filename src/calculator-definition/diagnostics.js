export class DefinitionCompilerError extends Error {
  constructor(message, diagnostics, options = {}) {
    super(message, options);
    this.name = "DefinitionCompilerError";
    this.diagnostics = Object.freeze((diagnostics ?? []).map((item) => Object.freeze({ ...item })));
  }
}

export function diagnostic(code, message, path = "$", construct = null, details = null) {
  return {
    severity: "error",
    code,
    message,
    path,
    ...(construct == null ? {} : { construct }),
    ...(details == null ? {} : { details }),
  };
}

export function fail(code, message, path = "$", construct = null, details = null) {
  const item = diagnostic(code, message, path, construct, details);
  throw new DefinitionCompilerError(message, [item]);
}
