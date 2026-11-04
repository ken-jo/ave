// The live memory notice the host renderer shows for a save, update, delete or refusal, and the undo answer.

/** Why a save did not happen, as the notice groups it: a secret, an instruction or outside input, or a failure. */
export type MemorySaveSkipReason =
  | "sensitive-input"
  | "credential"
  | "authorization-key"
  | "unsafe-text"
  | "external-context"
  | "reviewer-unavailable"
  | "invalid-review"
  | "shutdown"
  | "write-failed"
  | "input-too-large";

export type MemorySaveNoticeResult =
  | {
    status: "saved";
    op: "created" | "updated" | "deleted";
    entry: { id: string; filename: string; title: string; scope: "project" | "global" };
    /** Present for a create or a delete; an update cannot be undone. */
    undoToken?: string;
  }
  | { status: "skipped"; reason: MemorySaveSkipReason };

/** The renderer event `memory.saveResult`. `anchorMessageId` is the user row the notice sits under. */
export interface MemorySaveResultEvent {
  sessionId: string;
  anchorMessageId?: string;
  result: MemorySaveNoticeResult;
}

export type MemoryUndoResult =
  | { ok: true; undone: "created" | "deleted"; title: string }
  | { ok: false; error: "not-found" | "changed" };

const SKIP_REASONS = new Set<MemorySaveSkipReason>([
  "sensitive-input", "credential", "authorization-key", "unsafe-text", "external-context",
  "reviewer-unavailable", "invalid-review", "shutdown", "write-failed", "input-too-large",
]);

/** The preload passes on only an event of this exact shape. */
export function isMemorySaveResultEvent(value: unknown): value is MemorySaveResultEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (typeof event.sessionId !== "string") return false;
  if (event.anchorMessageId !== undefined && typeof event.anchorMessageId !== "string") return false;
  const result = event.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") return false;
  if (result.status === "skipped") return SKIP_REASONS.has(result.reason as MemorySaveSkipReason);
  if (result.status !== "saved") return false;
  if (result.op !== "created" && result.op !== "updated" && result.op !== "deleted") return false;
  if (result.undoToken !== undefined && typeof result.undoToken !== "string") return false;
  const entry = result.entry as Record<string, unknown> | undefined;
  return !!entry && typeof entry === "object"
    && typeof entry.id === "string" && typeof entry.filename === "string" && typeof entry.title === "string"
    && (entry.scope === "project" || entry.scope === "global");
}
