/**
 * JSON parsing for files read from marketplace repositories.
 *
 * `JSON.parse` keeps the last of two equal keys, so `{"name":"a","name":"b"}`
 * would mean one thing to a reviewer reading the file and another to the app.
 * Marketplace files are rejected instead (design §2.2: duplicate keys reject
 * the index). Nesting depth is bounded and `__proto__` keys are refused.
 *
 * This is a preset of the one strict grammar in `shared/strict-json.ts`: text
 * input, depth 64, no size budgets, ordinary objects, and a located
 * {@link StrictJsonError} so a publisher can find the offending byte.
 */
import { parseStrictJsonText } from "../../shared/strict-json.js";

export class StrictJsonError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "StrictJsonError";
  }
}

const MARKETPLACE_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

const throwLocated = (reason: string, offset: number): never => {
  throw new StrictJsonError(reason, offset);
};

export function parseStrictJson(text: string): unknown {
  return parseStrictJsonText(text, {
    maxDepth: 64,
    forbiddenKeys: MARKETPLACE_FORBIDDEN_KEYS,
    nullPrototypeObjects: false,
    rejectNonFiniteNumbers: false,
    fail: throwLocated,
  });
}
