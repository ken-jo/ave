import type { RunWorkspace, TemplateStage } from "../../shared/workflow-template-types.js";
import type { JoinConflict } from "./shipped-shapes.js";

export interface RunRef { itemId: number; runId: string; runKey: string }
interface StageWorkspace { root: string; kind: "git" | "folder"; baseCommit?: string }
/** Every code a workspace provider refuses with; each has its text in the catalogs. */
export const WORKSPACE_REFUSALS = [
  "workspace-unavailable", "home-boundary-unverified", "git-unavailable", "inputs-need-project", "seed-too-large", "seed-unreadable", "identity-missing",
] as const;
type WorkspaceRefusal = typeof WORKSPACE_REFUSALS[number];

/** Where a run's stages work. Every stage child gets its own folder under the run root; there is no shared-folder mode. */
export interface StageWorkspaceProvider {
  /** Once, at start. */
  open(run: RunRef, projectRoot: string | undefined): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  /** Reopens the same workspace for a run/stage/attempt; repetition never creates another attempt. */
  prepare(run: RunRef, stage: TemplateStage, attempt: number): Promise<{ ok: true; workspace: StageWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  /** Freeze one immutable result for the passed attempt. Repetition returns the same seal, without another snapshot.
   * A non-idempotent implementation must commit its receipt atomically with the freeze. */
  seal(run: RunRef, stageId: string): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: WorkspaceRefusal }>;
  /** Install one immutable result per run/join from the stage seals; repetition returns that result without another merge.
   * A non-idempotent implementation must commit its receipt atomically with the integration. */
  integrate(run: RunRef, joinId: string, stageIds: readonly string[]): Promise<{ ok: true } | { ok: false; conflict: JoinConflict }>;
  /** Stage folders only; the run branch and the output folder stay. Already absent folders are a no-op. */
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;
  /** Everything the run left under the run root, the output folder included: for a run whose record is gone. The run branch stays. */
  discard(runId: string): Promise<void>;
  /** Boot: drop what no active run owns. */
  sweep(activeRunIds: readonly string[]): Promise<void>;
}
