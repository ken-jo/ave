import type { ParentAdjudicationEscalationCause } from "../permissions/parent-adjudicator.js";

/** The gate owns repetition escalation because the adjudicator sees only one call at a time. */
export type ParentEscalationCause =
  | ParentAdjudicationEscalationCause
  /** Repeated parent denials escalate to the user rather than sustaining the child denial loop. */
  | "repeated-denial";

/** Keep the renderer payload separate from the approval gate runtime and its signing keys. */
export interface ParentEscalationNotice {
  cause: ParentEscalationCause;
  /** The parser sanitizes, masks, and bounds this sentence; do not truncate it again in the dock. */
  reason: string;
  /** The title originates in model input despite host transport; mask and normalize it, then display it as a quote. */
  childTitle: string;
}
