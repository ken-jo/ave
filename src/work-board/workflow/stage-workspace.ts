import type { RunWorkspace, TemplateStage } from "../../shared/workflow-template-types.js";
import type { JoinConflict } from "./shipped-shapes.js";

/** `projectRoot`: the project the caller has the run open on, as the caller holds it now; none for a run of no project, and none
 * when the call is made for a run nobody has open. A provider checks what its own record says of the project against it. */
export interface RunRef { itemId: number; runId: string; runKey: string; projectRoot?: string }
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
  /** Stage folders only; the run branch and the output folder stay. Already absent folders are a no-op. A git run is released only
   * with its project open (`run.projectRoot`): without it nothing of the run is touched. */
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;
  /** Everything left under the run root, the output folder included, of each run that has no record and whose item is gone. A run
   * whose item is still listed keeps its output folder whether or not its record stays. The run branch stays. `projects` gives,
   * by run id, the project root the host's run file named for a run when its record went; a git run is taken apart only against
   * that root, as in `sweep`, and one with none is left whole, with a warning. */
  discard(projects: ReadonlyMap<string, string>): Promise<void>;
  /** Boot: drop what no active run owns, and with it what `discard` would remove. An active run loses only what a stop during a
   * seeding left of its ignore matcher. `projects` gives, by run id, the project root the host's own run state names for a run; a
   * git run is taken apart only against that root, and one with none is left whole, with a warning. Nothing a run folder holds is
   * ever taken for it. */
  sweep(activeRunIds: readonly string[], projects?: ReadonlyMap<string, string>): Promise<void>;
}
