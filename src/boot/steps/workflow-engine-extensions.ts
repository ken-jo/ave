import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { createPassConditionRegistry } from "../../work-board/workflow/stage-gates.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import { boardRunState } from "../../work-board/workflow/run-state.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { bindStageWorkspace, unbindStageWorkspace } from "../../permissions/stage-workspace-binding.js";
import type { StageRunEngineDeps } from "../../work-board/workflow/stage-run-engine.js";

type WorkflowEngineExtensions = Pick<
  StageRunEngineDeps,
  "runs" | "workspace" | "workspaceBinding" | "authoriseRunSource" | "passConditions" | "unattendedAllowed" | "lane" | "outputs" | "runScope"
>;

/** The one place the stage scheduler's replaceable parts are chosen. Each later part swaps its own line here and nowhere else. Run state
 * is the board store's covered run file. Every stage works in its own folder under the home's `worktrees`, bound to its session, and with
 * no lane only an all-read-only version may run unattended. */
export function workflowEngineExtensions(store: WorkBoardStore): WorkflowEngineExtensions {
  return {
    runs: boardRunState(store),
    workspace: createStageWorkspaceProvider(),
    workspaceBinding: { bind: bindStageWorkspace, unbind: unbindStageWorkspace },
    authoriseRunSource,
    passConditions: createPassConditionRegistry(),
  };
}
