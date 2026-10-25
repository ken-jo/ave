/** JSON serializability must preserve types, not merely avoid throws; class instances and custom prototypes are not wire data. */
/** Undefined may mean absence in properties or at top level, never in arrays; reject cycles and non-plain prototypes. */
export function describeNonJson(
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return null;
  if (type === "number") {
    return Number.isFinite(value as number)
      ? null
      : `${path}: non-finite number (JSON.stringify emits null)`;
  }
  if (type !== "object") return `${path}: ${type}`;

  const object = value as object;
  if (seen.has(object)) return `${path}: cycle`;
  seen.add(object);

  const proto = Object.getPrototypeOf(object) as object | null;
  if (Array.isArray(object)) {
    for (const [index, item] of (object as unknown[]).entries()) {
      if (item === undefined) {
        return `${path}[${index}]: undefined in an array (JSON.stringify emits null)`;
      }
      const reason = describeNonJson(item, `${path}[${index}]`, seen);
      if (reason) return reason;
    }
    return null;
  }
  if (proto !== Object.prototype && proto !== null) {
    const name = (object.constructor as { name?: string } | undefined)?.name;
    return `${path}: ${name ?? "non-plain object"}`;
  }
  for (const [key, item] of Object.entries(object)) {
    const reason = describeNonJson(item, `${path}.${key}`, seen);
    if (reason) return reason;
  }
  return null;
}

/** Bound before decoding base64, then recheck decoded size because the decoder ignores invalid characters. */
export function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}
