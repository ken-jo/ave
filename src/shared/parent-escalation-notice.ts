/** Stable provenance values retained in child escalation records and presentation. */
export type ParentEscalationCause =
  | "parent-escalated"
  | "timeout"
  | "malformed-output"
  | "rate-limited"
  | "adjudicator-unavailable"
  | "llm-error"
  | "turn-aborted"
  | "repeated-denial";

/** Keep the renderer payload separate from the approval gate runtime and its signing keys. */
export interface ParentEscalationNotice {
  cause: ParentEscalationCause;
  /** The parser sanitizes, masks, and bounds this sentence; do not truncate it again in the dock. */
  reason: string;
  /** The title originates in model input despite host transport; mask and normalize it, then display it as a quote. */
  childTitle: string;
}
