/** Use JSON-clean inputs: sort object keys recursively, preserve array order, and map top-level undefined to null. Exotic values inherit JSON serialization limits. */
/** Bound cycles and depth defensively for callers that may supply constructed objects. */
const MAX_DEPTH = 100;

export function canonicalStringify(value: unknown): string {
  return canonicalStringifyInner(value, new WeakSet(), 0);
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function canonicalStringifyInner(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) return '"[MaxDepth]"';
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (seen.has(value as object)) return '"[Circular]"';
  seen.add(value as object);
  let result: string;
  if (Array.isArray(value)) {
    // Canonicalize objects inside arrays too so key order cannot change approval hashes.
    const parts = value.map(
      (e) => canonicalStringifyInner(e, seen, depth + 1),
    );
    result = `[${parts.join(",")}]`;
  } else {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort();
    const parts = sortedKeys.map(
      k => `${JSON.stringify(k)}:${canonicalStringifyInner(obj[k], seen, depth + 1)}`,
    );
    result = `{${parts.join(",")}}`;
  }
  // Track ancestors only; sibling reuse is not a cycle and must preserve canonical hashes.
  seen.delete(value as object);
  return result;
}
