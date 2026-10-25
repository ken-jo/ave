/** Reject duplicate and forbidden keys and bound nesting and optional budgets; decode scalar tokens with standard JSON semantics. Callers select byte or located-text error presets. */
export interface StrictJsonTextOptions {
  readonly maxDepth: number;
  readonly maxNodes?: number;
  readonly maxObjectMembers?: number;
  readonly maxArrayItems?: number;
  readonly forbiddenKeys: ReadonlySet<string>;
  /** Build objects with a `null` prototype instead of `Object.prototype`. */
  readonly nullPrototypeObjects: boolean;
  /** Refuse numbers that overflow to `±Infinity`. */
  readonly rejectNonFiniteNumbers: boolean;
  /** Error contract: throw for `reason` at character `offset`. */
  readonly fail: (reason: string, offset: number) => never;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

export function parseStrictJsonText(text: string, options: StrictJsonTextOptions): unknown {
  const { fail } = options;
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  const maxMembers = options.maxObjectMembers ?? Number.POSITIVE_INFINITY;
  const maxItems = options.maxArrayItems ?? Number.POSITIVE_INFINITY;
  let pos = 0;
  let nodes = 0;

  const skip = (): void => {
    WHITESPACE.lastIndex = pos;
    WHITESPACE.exec(text);
    pos = WHITESPACE.lastIndex;
  };

  const readString = (): string => {
    const start = pos;
    pos += 1;
    while (pos < text.length) {
      const ch = text.charCodeAt(pos);
      if (ch === 0x22) {
        pos += 1;
        try {
          return JSON.parse(text.slice(start, pos)) as string;
        } catch {
          return fail("invalid string", start);
        }
      }
      if (ch === 0x5c) pos += 2;
      else if (ch < 0x20) return fail("control character in string", pos);
      else pos += 1;
    }
    return fail("unterminated string", start);
  };

  const readValue = (depth: number): unknown => {
    if (depth > options.maxDepth) fail("nesting too deep", pos);
    skip();
    nodes += 1;
    if (nodes > maxNodes) fail("too many values", pos);
    const ch = text[pos];
    if (ch === "{") {
      pos += 1;
      const out: Record<string, unknown> = options.nullPrototypeObjects
        ? Object.create(null) as Record<string, unknown>
        : {};
      const seen = new Set<string>();
      skip();
      if (text[pos] === "}") {
        pos += 1;
        return out;
      }
      for (;;) {
        skip();
        if (text[pos] !== "\"") fail("expected a key", pos);
        const keyAt = pos;
        const key = readString();
        if (options.forbiddenKeys.has(key)) fail(`the key ${key} is not allowed`, keyAt);
        if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`, keyAt);
        seen.add(key);
        if (seen.size > maxMembers) fail("too many object members", keyAt);
        skip();
        if (text[pos] !== ":") fail("expected ':'", pos);
        pos += 1;
        out[key] = readValue(depth + 1);
        skip();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "}") {
          pos += 1;
          return out;
        }
        fail("expected ',' or '}'", pos);
      }
    }
    if (ch === "[") {
      pos += 1;
      const out: unknown[] = [];
      skip();
      if (text[pos] === "]") {
        pos += 1;
        return out;
      }
      for (;;) {
        if (out.length >= maxItems) fail("too many array items", pos);
        out.push(readValue(depth + 1));
        skip();
        if (text[pos] === ",") {
          pos += 1;
          continue;
        }
        if (text[pos] === "]") {
          pos += 1;
          return out;
        }
        fail("expected ',' or ']'", pos);
      }
    }
    if (ch === "\"") return readString();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, pos)) {
        pos += literal.length;
        return value;
      }
    }
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text);
    if (!match) return fail("unexpected token", pos);
    const numberAt = pos;
    pos = NUMBER.lastIndex;
    const parsed = Number(match[0]);
    if (options.rejectNonFiniteNumbers && !Number.isFinite(parsed)) fail("number out of range", numberAt);
    return parsed;
  };

  const value = readValue(0);
  skip();
  if (pos !== text.length) fail("trailing content", pos);
  return value;
}

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export interface StrictJsonLimits {
  readonly maxBytes: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxObjectMembers?: number;
  readonly maxArrayItems?: number;
}

const rejectOpaque = (): never => {
  throw new Error("strict-json-rejected");
};

export function parseStrictJson(bytes: Uint8Array, limits: StrictJsonLimits): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes) {
    throw new Error("strict-json-size-invalid");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parseStrictJsonText(text, {
    maxDepth: limits.maxDepth ?? 32,
    maxNodes: limits.maxNodes ?? 4_096,
    maxObjectMembers: limits.maxObjectMembers ?? 256,
    maxArrayItems: limits.maxArrayItems ?? 1_024,
    forbiddenKeys: DANGEROUS_KEYS,
    nullPrototypeObjects: true,
    rejectNonFiniteNumbers: true,
    fail: rejectOpaque,
  });
}
