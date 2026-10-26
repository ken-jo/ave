export interface TurnReviewHunk {
  id: string;
  oldText: string;
  newText: string;
  oldStartLine: number;
  newStartLine: number;
  startLine: number;
  endLine: number;
}

export interface TurnReviewFile {
  path: string;
  bytes: number;
  lineCount: number;
  added: number;
  removed: number;
  operation: "create" | "modify" | "delete";
  countsKnown: boolean;
  referenceable: boolean;
  hunks: TurnReviewHunk[];
}

export interface TurnChangeReview {
  sessionId: string;
  turnId: string;
  workspaceRoot?: string;
  files: TurnReviewFile[];
}

export type TurnReviewError =
  | "turn-review-unavailable"
  | "turn-review-stale"
  | "turn-review-failed"
  | "streaming-active"
  | "unauthorized-frame"
  | "invalid-input";

export type TurnReviewResult =
  | { ok: true; review: TurnChangeReview }
  | { ok: false; error: TurnReviewError };
