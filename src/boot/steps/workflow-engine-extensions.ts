import { createLogger } from "../../lib/logger.js";
import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { createPassConditionRegistry } from "../../work-board/workflow/stage-gates.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { RemovedRun } from "../../main/workflow-run-store.js";
import type { WorkflowTemplateStore } from "../../main/workflow-template-store.js";
import { boardRunState } from "../../work-board/workflow/run-state.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { bindStageWorkspace, unbindStageWorkspace } from "../../permissions/stage-workspace-binding.js";
import type { StageRunEngineDeps } from "../../work-board/workflow/stage-run-engine.js";

const log = createLogger("ave");
/** How many removed records' projects are kept for a discard still to come; the oldest goes first. */
const KEPT_PROJECTS = 256;

type WorkflowEngineExtensions = Pick<
  StageRunEngineDeps,
  "runs" | "workspace" | "workspaceBinding" | "authoriseRunSource" | "passConditions" | "unattendedAllowed" | "lane" | "outputs" | "runScope"
>;

/** The one place the stage scheduler's replaceable parts are chosen. Each later part swaps its own line here and nowhere else. Run state
 * is the board store's covered run file. Every stage works in its own folder under the home's `worktrees`, bound to its session, and with
 * no lane only an all-read-only version may run unattended. */
export function workflowEngineExtensions(store: WorkBoardStore, attachments: Pick<WorkflowTemplateStore, "getAttachment">): WorkflowEngineExtensions {
  // A run's output folder lives as long as its item. A record can go while its row is still listed (a later run superseded it and the
  // row's history let it go): that run's output stays until the row goes. A board that cannot be read removes nothing.
  const workspace = createStageWorkspaceProvider({ removable: () => store.runsWithoutItem() });
  // The project of each run whose record this process saw go, as the run file last named it: a git run is taken apart only against
  // it, and its row may go after its record. An entry goes once a discard has used it or found no folder left of its run, and the oldest goes when more than
  // KEPT_PROJECTS wait. A run with none here (its record went in an earlier process, or its entry aged out) is left whole.
  const projects = new Map<string, string>();
  const note = (runId: string, projectRoot: string): void => {
    projects.delete(runId);
    projects.set(runId, projectRoot);
    for (const oldest of projects.keys()) {
      if (projects.size <= KEPT_PROJECTS) break;
      projects.delete(oldest);
    }
  };
  // A row can also go when none of its runs has a record left to remove, so both a removed record and a removed row ask.
  const discard = (): void => {
    // Only what this discard was given is used up by it: a root noted while it ran waits for the next.
    const given = new Map(projects);
    void workspace.discard(given)
      .then((taken) => { for (const runId of taken) if (projects.get(runId) === given.get(runId)) projects.delete(runId); })
      .catch((error: unknown) => log.warn("[workflow] a removed run's workspace was not discarded: %s", (error as Error).message));
  };
  // As the engine tells a run's project: the card's root for Create and run, the approved snapshot for a schedule. A card's root is
  // noted before anything is awaited, so a discard its row's removal asks for at once already has it.
  const scheduled = async (runId: string, attachmentId: string): Promise<void> => {
    const approved = (await attachments.getAttachment(attachmentId).catch(() => null))?.approvedScope;
    if (approved?.kind === "project") note(runId, approved.projectRoot);
  };
  store.runs.onRunsRemoved = (removed: readonly RemovedRun[]) => {
    const asked: Promise<void>[] = [];
    for (const { runId, runStartedBy: source } of removed) {
      if (source.kind === "schedule-attachment") asked.push(scheduled(runId, source.attachmentId));
      else if (source.projectRoot !== undefined) note(runId, source.projectRoot);
    }
    void Promise.all(asked).then(discard);
  };
  store.onItemRemoved = discard;
  return {
    runs: boardRunState(store),
    workspace,
    workspaceBinding: { bind: bindStageWorkspace, unbind: unbindStageWorkspace },
    authoriseRunSource,
    passConditions: createPassConditionRegistry(),
  };
}
