export const SHELL_FLOOR_INPUT_LIMIT = 8_000;
export const SHELL_LITERAL_DATA_LIMIT = 65_536;
const shellFloorLiteralDataLengths = new WeakMap<object, number>();

// Only the original-grammar heredoc verifier records this bounded data allowance.
export function recordShellFloorLiteralData(input: { readonly command: string }, chars: number): void {
  if (!Number.isSafeInteger(chars) || chars < 0 || chars > SHELL_LITERAL_DATA_LIMIT || chars > input.command.length) {
    throw new Error("Invalid shell literal data length");
  }
  shellFloorLiteralDataLengths.set(input, chars);
}
export const SHELL_FLOOR_BUDGET_REASON = "Shell floor analysis budget exceeded";
const SHELL_PARSER_BUDGET_ERRORS = new Set([
  "Shell analysis source limit exceeded",
  "Shell analysis syntax limit exceeded",
  "Shell syntax output limit exceeded",
]);

export interface ShellFloorSignals {
  sensitive: string | null;
  exfiltration: string | null;
  ordinaryAsk?: string;
  analysisLimited?: true;
}

export function shellFloorInputExceeded(input: string | { readonly command: string }): boolean {
  return typeof input === "string" ? input.length > SHELL_FLOOR_INPUT_LIMIT
    : input.command.length - (shellFloorLiteralDataLengths.get(input) ?? 0) > SHELL_FLOOR_INPUT_LIMIT;
}

export function shellFloorBudgetSignals(): ShellFloorSignals {
  return { sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true };
}

// Stable limit errors emitted by the repository's parser runtime; syntax refusals are not exhaustion.
export function shellFloorParserBudgetExceeded(reason: string): boolean {
  return SHELL_PARSER_BUDGET_ERRORS.has(reason) || /^(?:\d+:\d+: )?shell (?:parser recursion|lexer work|command word) limit exceeded$/.test(reason);
}
