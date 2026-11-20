export interface TurnReviewHunk {
  id: string;
  oldText: string;
  newText: string;
  oldStartLine: number;
  newStartLine: number;
  startLine: number;
  endLine: number;
  /** True once the person kept this change; a kept hunk needs no further decision. */
  kept: boolean;
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
  /** True when the host can keep or undo this file's changes: its current content is the turn's result and is text. */
  decidable: boolean;
}

/**
 * A person's decision on the latest turn's changes. Keep marks a change as reviewed; undo writes the
 * earlier text back. Both are the person's own action on their files, so neither asks for confirmation.
 */
export type TurnReviewDecision =
  | { action: "keep" | "undo"; scope: "hunk"; path: string; hunkId: string }
  | { action: "keep" | "undo"; scope: "file"; path: string }
  | { action: "keep" | "undo"; scope: "turn" };

/**
 * A decision as it travels to the host: it names the turn whose review the person was looking at. The host applies it only
 * while that turn is still the latest one, so a decision made on one turn's review can never land on a later turn.
 */
export type TurnReviewDecisionRequest = TurnReviewDecision & { turnId: string };

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
  | "turn-review-write-denied"
  /** An undo of several files put some back and was then stopped; the files already put back stay that way. */
  | "turn-review-partial"
  /** An undo put every file back, but the review to answer with could not be read afterwards. */
  | "turn-review-applied"
  | "streaming-active"
  | "unauthorized-frame"
  | "invalid-input";

export type TurnReviewResult =
  | { ok: true; review: TurnChangeReview }
  | { ok: false; error: TurnReviewError };

/** Validate a decision that crossed a process boundary; anything but the exact shape is refused. */
export function parseTurnReviewDecision(value: unknown): TurnReviewDecisionRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { action, scope, path, hunkId, turnId } = value as Record<string, unknown>;
  if (action !== "keep" && action !== "undo") return null;
  if (typeof turnId !== "string" || turnId.length === 0 || turnId.length > 256) return null;
  if (scope === "turn") return { action, scope, turnId };
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return null;
  if (scope === "file") return { action, scope, path, turnId };
  if (scope === "hunk" && typeof hunkId === "string" && /^[a-f0-9]{64}$/.test(hunkId)) return { action, scope, path, hunkId, turnId };
  return null;
}
