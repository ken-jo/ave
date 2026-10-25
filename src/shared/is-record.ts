/** Reject arrays and null but allow class instances so error metadata remains readable. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** For wire or persisted data, require Object.prototype or null rather than accepting class instances. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Require the exact own-key set; unknown fields may indicate an incompatible stored format. */
export function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** Reject unknown own keys; callers decide which optional fields must exist. */
export function hasOnlyKeys(value: object, allowed: ReadonlySet<string> | readonly string[]): boolean {
  const permitted = allowed instanceof Set ? allowed : new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

/** Read indexes directly to reject sparse arrays and custom iterators that conceal non-string elements. */
export function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}
