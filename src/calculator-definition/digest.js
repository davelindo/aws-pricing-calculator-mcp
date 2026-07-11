import crypto from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function definitionDigest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export function canonicalJson(value) {
  return canonical(value);
}
