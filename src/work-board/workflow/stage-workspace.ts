import type { RunWorkspace, TemplateStage } from "../../shared/workflow-template-types.js";
import type { JoinConflict } from "./shipped-shapes.js";

export interface RunRef { itemId: number; runId: string; runKey: string }
interface StageWorkspace { root: string; kind: "git" | "folder"; baseCommit?: string }
type WorkspaceRefusal = "workspace_unavailable" | "home-boundary-unverified" | "git-unavailable" | "inputs-need-project"
  | "seed-too-large" | "seed-unreadable" | "identity-missing";

/** Where a run's stages work. Every stage child gets its own folder under the run root; there is no shared-folder mode. */
export interface StageWorkspaceProvider {
  /** Once, at start. */
  open(run: RunRef, projectRoot: string | undefined): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  prepare(run: RunRef, stage: TemplateStage, attempt: number): Promise<{ ok: true; workspace: StageWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  /** After the stage passed. */
  seal(run: RunRef, stageId: string): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: WorkspaceRefusal }>;
  integrate(run: RunRef, joinId: string, stageIds: readonly string[]): Promise<{ ok: true } | { ok: false; conflict: JoinConflict }>;
  /** Stage folders only; the run branch and the output folder stay. */
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;
  /** Boot: drop what no active run owns. */
  sweep(activeRunIds: readonly string[]): Promise<void>;
}

/** The default until a real provider is wired: no template run can start. */
export const unavailableWorkspaceProvider: StageWorkspaceProvider = {
  open: async () => ({ ok: false, code: "workspace_unavailable" }),
  prepare: async () => ({ ok: false, code: "workspace_unavailable" }),
  seal: async () => ({ ok: false, code: "workspace_unavailable" }),
  integrate: async () => { throw new Error("stage workspaces are not available"); },
  release: async () => {},
  sweep: async () => {},
};
