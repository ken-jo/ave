/** Advisory provenance; these records never confer file or terminal authority. */
export interface TerminalReviewFile {
  readonly path: string;
  readonly hash: string;
  readonly sessionIds: string[];
  readonly reviewed: boolean;
  readonly diff?: { readonly before: string; readonly after: string };
  readonly lastUsed: { readonly command: string; readonly when: number } | null;
}

export interface TerminalExecutionWarning {
  readonly blockId: number;
  readonly command: string;
  readonly files: string[];
  readonly unresolved: boolean;
}

export interface TerminalFileReviewSnapshot {
  readonly files: TerminalReviewFile[];
  readonly warnings: TerminalExecutionWarning[];
}
