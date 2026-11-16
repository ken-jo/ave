import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { createPassConditionRegistry } from "../../work-board/workflow/stage-gates.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import { boardRunState } from "../../work-board/workflow/run-state.js";
import { unavailableWorkspaceProvider } from "../../work-board/workflow/stage-workspace.js";
import type { StageRunEngineDeps } from "../../work-board/workflow/stage-run-engine.js";

type WorkflowEngineExtensions = Pick<
  StageRunEngineDeps,
  "runs" | "workspace" | "authoriseRunSource" | "passConditions" | "unattendedAllowed" | "lane" | "outputs" | "runScope"
>;

/** The one place the stage scheduler's replaceable parts are chosen. Each later part swaps its own line here and nowhere else. Run state
 * is the board store's covered run file. With the default workspace provider a start is refused `workspace_unavailable`, and with no lane
 * only an all-read-only version may run unattended. */
export function workflowEngineExtensions(store: WorkBoardStore): WorkflowEngineExtensions {
  return {
    runs: boardRunState(store),
    workspace: unavailableWorkspaceProvider,
    authoriseRunSource,
    passConditions: createPassConditionRegistry(),
  };
}
