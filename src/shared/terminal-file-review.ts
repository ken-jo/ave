/** Advisory provenance; these records never confer file or terminal authority. */
export interface TerminalReviewFile {
  readonly path: string;
  readonly hash: string;
  readonly sessionIds: string[];
  readonly reviewed: boolean;
  readonly diff?: { readonly before: string; readonly after: string };
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
  readonly files: TerminalReviewFile[];
  readonly warnings: TerminalExecutionWarning[];
}
