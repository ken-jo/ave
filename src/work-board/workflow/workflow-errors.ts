import type { EnvelopeToolRef } from "../../shared/workflow-template-types.js";

export type WorkflowInvariantCode =
  | "run-not-authorised" | "workspace-missing" | "lane-blocked" | "version-missing" | "graph-mismatch" | "stage-not-in-version"
  | "stage-not-ready" | "attempt-out-of-range" | "run-stopped" | "duplicate-stage-child" | "outputs-unavailable" | "graph-invalid"
  | "run-state-failed";

/** A broken scheduler invariant. `reasonCode` and `reasonTool` carry the run-authority verdict behind `run-not-authorised`; `reasonCode`
 * carries the run-file refusal behind `run-state-failed`. */
export class WorkflowInvariantError extends Error {
  override readonly name = "WorkflowInvariantError";
  constructor(
    readonly code: WorkflowInvariantCode,
    readonly reasonCode?: string,
    readonly reasonTool?: EnvelopeToolRef,
  ) {
    super(reasonCode ? `${code}: ${reasonCode}` : code);
  }
}
