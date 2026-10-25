// Canonicalize manifest JSON recursively so nested object keys contribute deterministically to the pin.
// Preserve array order and ordinary JSON serialization behavior.

export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // Use JSON serialization for primitive escaping and nonfinite numbers.
    const s = JSON.stringify(value);
    return s ?? "null";
  }
  if (Array.isArray(value)) {
    // Preserve array order while sorting nested object keys.
    const parts = value.map((e) => canonicalJSON(e));
    return `[${parts.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}
