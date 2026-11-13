const MAX_EXACT_JSON_DEPTH = 100;

/** Canonical identity for exact consent. Unsupported inputs fail instead of losing information. */
export function exactCanonicalStringify(value: unknown): string {
  const ancestors = new WeakSet<object>();
  const encode = (item: unknown, depth: number): string => {
    if (depth > MAX_EXACT_JSON_DEPTH) throw new Error("Exact input exceeds the nesting limit");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (item === null || typeof item !== "object" || ancestors.has(item)) {
      throw new Error("Exact input must contain only acyclic JSON values");
    }
    if (Object.getOwnPropertySymbols(item).length !== 0) throw new Error("Exact input contains symbol properties");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Exact input contains a non-JSON object");
    }
    const keys = Object.keys(item);
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) {
      throw new Error("Exact input contains a non-JSON array");
    }
    ancestors.add(item);
    try {
      const values = (array ? keys : keys.sort()).map(key => {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (property === undefined || !Object.hasOwn(property, "value")) throw new Error("Exact input contains an accessor");
        const encoded = encode(property.value, depth + 1);
        return array ? encoded : `${JSON.stringify(key)}:${encoded}`;
      });
      return array ? `[${values.join(",")}]` : `{${values.join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value, 0);
}
