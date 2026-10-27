export const SHELL_FLOOR_INPUT_LIMIT = 8_000;
export const SHELL_LITERAL_DATA_LIMIT = 65_536;
const shellFloorLiteralDataLengths = new WeakMap<object, number>();
const shellFloorLiteralDataWords = new WeakSet<object>();

// Only the original-grammar heredoc verifier records this bounded data allowance.
export function recordShellFloorLiteralData(input: { readonly command: string }, chars: number, words: readonly object[] = []): void {
  if (!Number.isSafeInteger(chars) || chars < 0 || chars > SHELL_LITERAL_DATA_LIMIT || chars > input.command.length) {
    throw new Error("Invalid shell literal data length");
  }
  shellFloorLiteralDataLengths.set(input, chars);
  for (const word of words) shellFloorLiteralDataWords.add(word);
}
export function isShellFloorLiteralData(word: object): boolean { return shellFloorLiteralDataWords.has(word); }

export const SHELL_FLOOR_BUDGET_REASON = "Shell floor analysis budget exceeded";
const SHELL_PARSER_BUDGET_ERRORS = new Set([
  "Shell analysis source limit exceeded",
  "Shell analysis syntax limit exceeded",
  "Shell syntax output limit exceeded",
  "Shell analysis total token limit exceeded",
]);

export interface ShellFloorSignals {
  outcome: "visible-floor" | "unproven" | "static-complete";
  sensitive: string | null;
  exfiltration: string | null;
  ordinaryAsk?: string;
  analysisLimited?: true;
  exactLiteralEvaluation?: true;
}

export function shellFloorInputExceeded(input: string | { readonly command: string }): boolean {
  return typeof input === "string" ? input.length > SHELL_FLOOR_INPUT_LIMIT
    : input.command.length - (shellFloorLiteralDataLengths.get(input) ?? 0) > SHELL_FLOOR_INPUT_LIMIT;
}

export function shellFloorBudgetSignals(): ShellFloorSignals {
  return { outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true };
}

// Stable limit errors emitted by the repository's parser runtime; syntax refusals are not exhaustion.
export function shellFloorParserBudgetExceeded(reason: string): boolean {
  return SHELL_PARSER_BUDGET_ERRORS.has(reason) || /^(?:\d+:\d+: )?shell (?:parser recursion|total token) limit exceeded$/.test(reason);
}
import { createPathCanonicalizer, createSensitiveLocationMatcher, createSensitivePathMatcher } from "../sensitive-paths.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";

export class ShellFloorLimitError extends Error {}

// Facts live for one decision, independently of execution time or machine load.
export class ShellFloorContext {
  readonly visits = { frames: 0, stages: 0, lexes: 0, transfers: 0, walk: 0, inventory: 0, commands: 0, feeder: 0, code: 0, coverage: 0, codeNodes: 0, codeWordLinks: 0, codeSourceChars: 0, codeTokenFacts: 0, codeTokenUses: 0, codeCoverage: 0, codeRangeSteps: 0, staticTokens: 0, staticArguments: 0, staticChars: 0, staticNodes: 0, staticViews: 0 };
  readonly facts = new Map<string, unknown>();
  readonly canonicalize = createPathCanonicalizer();
  readonly locationUnder = createSensitiveLocationMatcher(this.canonicalize);
  private readonly match = createSensitivePathMatcher("read", undefined, this.canonicalize);
  private readonly matches = new Map<string, string | null>();

  matchPath(path: string): string | null {
    const cached = this.matches.get(path);
    if (cached !== undefined) return cached;
    const hit = this.match(path);
    this.matches.set(path, hit);
    return hit;
  }
}

// An unparsed tail cannot claim that apparent word boundaries are quoted data.
// Count its existing visible spans before invoking any path or effect scanner.
export function shellFloorFallbackInputExceeded(command: string): boolean {
  let tokens = 0;
  for (const _match of command.matchAll(/[^\s;|&()<>{}\[\],"'`]+/g)) {
    if (++tokens > MAX_SHELL_ANALYSIS_TOKENS) return true;
  }
  return false;
}
