/**
 * JSON parsing for files read from marketplace repositories.
 *
 * `JSON.parse` keeps the last of two equal keys, so `{"name":"a","name":"b"}`
 * would mean one thing to a reviewer reading the file and another to the app.
 * Marketplace files are rejected instead (design §2.2: duplicate keys reject
 * the index). Nesting depth is bounded and `__proto__` keys are refused.
 * String and number tokens are still decoded by `JSON.parse`, so escapes and
 * number syntax follow the standard exactly.
 */
export class StrictJsonError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "StrictJsonError";
  }
}

const MAX_DEPTH = 64;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

export function parseStrictJson(text: string): unknown {
  let pos = 0;

  const skip = () => {
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
          throw new StrictJsonError("invalid string", start);
        }
      }
      if (ch === 0x5c) pos += 2;
      else if (ch < 0x20) throw new StrictJsonError("control character in string", pos);
      else pos += 1;
    }
    throw new StrictJsonError("unterminated string", start);
  };

  const readValue = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new StrictJsonError("nesting too deep", pos);
    skip();
    const ch = text[pos];
    if (ch === "{") {
      pos += 1;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      skip();
      if (text[pos] === "}") {
        pos += 1;
        return out;
      }
      for (;;) {
        skip();
        if (text[pos] !== "\"") throw new StrictJsonError("expected a key", pos);
        const keyAt = pos;
        const key = readString();
        if (key === "__proto__") throw new StrictJsonError("the key __proto__ is not allowed", keyAt);
        if (seen.has(key)) throw new StrictJsonError(`duplicate key ${JSON.stringify(key)}`, keyAt);
        seen.add(key);
        skip();
        if (text[pos] !== ":") throw new StrictJsonError("expected ':'", pos);
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
        throw new StrictJsonError("expected ',' or '}'", pos);
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
        throw new StrictJsonError("expected ',' or ']'", pos);
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
    if (match) {
      pos = NUMBER.lastIndex;
      return Number(match[0]);
    }
    throw new StrictJsonError("unexpected token", pos);
  };

  const value = readValue(0);
  skip();
  if (pos !== text.length) throw new StrictJsonError("trailing content", pos);
  return value;
}
