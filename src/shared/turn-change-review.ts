type TurnReviewDecision = "pending" | "accepted" | "rejected";

export interface TurnReviewHunk {
  id: string;
  oldText: string;
  newText: string;
  oldStartLine: number;
  newStartLine: number;
  decision: TurnReviewDecision;
}

export interface TurnReviewFile {
  path: string;
  hunks: TurnReviewHunk[];
}

export interface TurnChangeReview {
  sessionId: string;
  turnId: string;
  version: string;
  files: TurnReviewFile[];
}

export type TurnReviewError =
  | "turn-review-unavailable"
  | "turn-review-conflict"
  | "turn-review-stale"
  | "turn-review-write-denied"
  | "turn-review-failed"
  | "streaming-active"
  | "unauthorized-frame"
  | "invalid-input";

export type TurnReviewResult =
  | { ok: true; review: TurnChangeReview }
  | { ok: false; error: TurnReviewError; conflictingFiles?: string[] };

export interface TurnHunkDecisionRequest {
  sessionId: string;
  turnId: string;
  version: string;
  hunkId: string;
  decision: "accept" | "reject";
}
