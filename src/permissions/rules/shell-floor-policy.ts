export const SHELL_FLOOR_INPUT_LIMIT = 8_000;
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
  return (typeof input === "string" ? input : input.command).length > SHELL_FLOOR_INPUT_LIMIT;
}

export function shellFloorBudgetSignals(): ShellFloorSignals {
  return { sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true };
}

// Stable limit errors emitted by the repository's parser runtime; syntax refusals are not exhaustion.
export function shellFloorParserBudgetExceeded(reason: string): boolean {
  return SHELL_PARSER_BUDGET_ERRORS.has(reason) || /^(?:\d+:\d+: )?shell parser recursion limit exceeded$/.test(reason);
}
