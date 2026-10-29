
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

/** Fields of the OSC 133 C marker main regenerates for the renderer,
 * `ESC ] 133 ; C ; ave-block=<block id> ; ave-view=<view token> BEL`, naming the block whose command was just entered.
 * The view token is a per-incarnation secret main hands only to the renderer (on spawn), never to the shell, so a
 * program cannot forge an anchor in any OSC encoding; the renderer ignores a block id without it. */
export const TERMINAL_VIEW_BLOCK_FIELD = "ave-block=";
export const TERMINAL_VIEW_TOKEN_FIELD = "ave-view=";
