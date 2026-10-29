import type { TurnReviewFile } from "./turn-change-review.js";

/** Advisory provenance; these records never confer file or terminal authority. */
export interface TerminalReviewFile {
  readonly path: string;
  readonly sessionIds: string[];
  /** The change against the recorded baseline, read only from the file the agent write left; absent when unknown. */
  readonly review?: TurnReviewFile;
  readonly lastUsed: { readonly command: string; readonly when: number } | null;
}

/** A host command positively matched to at least one agent-changed file. Commands with no match, including
 * unresolved dynamic indirection, produce no warning. */
export interface TerminalExecutionWarning {
  readonly blockId: number;
  readonly command: string;
  readonly files: string[];
}

export interface TerminalFileReviewSnapshot {
  /** Physical working directory the paths are displayed relative to. */
  readonly cwd: string;
  /** Most recent command block; a warning is current only while its block is the latest command. */
  readonly latestBlockId: number | null;
  /** The agent-changed files this terminal's commands used. */
  readonly files: TerminalReviewFile[];
  readonly warnings: TerminalExecutionWarning[];
}
