
/** `osc133`: bounded by the shell's own markers. `heuristic`: split at Enter. */
export type TerminalBlockSource = "osc133" | "heuristic";

export interface TerminalBlockSummary {
  /** Increasing per terminal tab, starting at 1. */
  readonly id: number;
  readonly command: string;
  /** Working directory the shell reported before the command ran. */
  readonly cwd: string | null;
  /** Null while running, or when the shell reported none. */
  readonly exitCode: number | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: "running" | "done";
  readonly source: TerminalBlockSource;
  /** Plain-text output characters seen, including any that were dropped. */
  readonly outputChars: number;
  /** True when the kept output omits a middle section. */
  readonly truncated: boolean;
}

export interface TerminalBlock extends TerminalBlockSummary {
  /** Plain text: escape sequences removed, line rewrites applied. */
  readonly output: string;
}
