import { createLogger } from "../../lib/logger.js";
import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { createPassConditionRegistry } from "../../work-board/workflow/stage-gates.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import { boardRunState } from "../../work-board/workflow/run-state.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { bindStageWorkspace, unbindStageWorkspace } from "../../permissions/stage-workspace-binding.js";
import type { StageRunEngineDeps } from "../../work-board/workflow/stage-run-engine.js";

const log = createLogger("ave");

type WorkflowEngineExtensions = Pick<
  StageRunEngineDeps,
  "runs" | "workspace" | "workspaceBinding" | "authoriseRunSource" | "passConditions" | "unattendedAllowed" | "lane" | "outputs" | "runScope"
>;

/** The one place the stage scheduler's replaceable parts are chosen. Each later part swaps its own line here and nowhere else. Run state
 * is the board store's covered run file. Every stage works in its own folder under the home's `worktrees`, bound to its session, and with
 * no lane only an all-read-only version may run unattended. */
export function workflowEngineExtensions(store: WorkBoardStore): WorkflowEngineExtensions {
  // A run's output folder lives as long as its item. A record can go while its row is still listed (a later run superseded it and the
  // row's history let it go): that run's output stays until the row goes. A board that cannot be read removes nothing.
  const workspace = createStageWorkspaceProvider({ removable: () => store.runsWithoutItem() });
  // A row can also go when none of its runs has a record left to remove, so both a removed record and a removed row ask.
  const discard = (): void => {
    void workspace.discard().catch((error: unknown) => log.warn("[workflow] a removed run's workspace was not discarded: %s", (error as Error).message));
  };
  store.runs.onRunsRemoved = discard;
  store.onItemRemoved = discard;
  return {
    runs: boardRunState(store),
    workspace,
    workspaceBinding: { bind: bindStageWorkspace, unbind: unbindStageWorkspace },
    authoriseRunSource,
    passConditions: createPassConditionRegistry(),
  };
}
