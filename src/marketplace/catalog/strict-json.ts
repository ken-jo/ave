/** Reject duplicate and __proto__ keys; bound nesting to keep reviewer and runtime interpretations aligned. */
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
