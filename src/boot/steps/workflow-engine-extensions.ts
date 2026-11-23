import { createLogger } from "../../lib/logger.js";
import { authoriseRunSource } from "../../work-board/workflow/run-authority.js";
import { createPassConditionRegistry } from "../../work-board/workflow/stage-gates.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { RemovedRun } from "../../main/workflow-run-store.js";
import type { WorkflowTemplateStore } from "../../main/workflow-template-store.js";
import { boardRunState } from "../../work-board/workflow/run-state.js";
import type { RemovedRunProject } from "../../work-board/workflow/stage-workspace.js";
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
  // The project of each run whose record this process saw go, as the run file last named it, with the run's item: a git run is taken
  // apart only against it, and its row may go after its record. An entry goes once a discard has used it or found no folder left of its run, and the
  // oldest goes when more than KEPT_PROJECTS wait. A run with none here (its record went in an earlier process, or its entry aged out) is left whole.
  const projects = new Map<string, RemovedRunProject>();
  const note = (runId: string, itemId: number, projectRoot: string): void => {
    projects.delete(runId);
    projects.set(runId, { projectRoot, itemId });
    for (const oldest of projects.keys()) {
      if (projects.size <= KEPT_PROJECTS) break;
      projects.delete(oldest);
    }
  };
  // The runs whose schedule's approved project is still being read.
  const unread = new Set<string>();
  // A row can also go when none of its runs has a record left to remove, so both a removed record and a removed row ask.
  const discard = (): void => {
    // Only what this discard was given is used up by it: a root noted while it ran waits for the next.
    const given = new Map(projects);
    // A discard reads the stores after it was given its roots, and can so come to a run whose record went since. Such a run's root
    // is still being read, or was noted after: the run is left to the discard that removal asks for, which is given the root.
    const waits = (runId: string): boolean => unread.has(runId) || (projects.has(runId) && projects.get(runId) !== given.get(runId));
    void workspace.discard(given, waits)
      .then((taken) => { for (const runId of taken) if (projects.get(runId) === given.get(runId)) projects.delete(runId); })
      .catch((error: unknown) => log.warn("[workflow] a removed run's workspace was not discarded: %s", (error as Error).message));
  };
  // As the engine tells a run's project: the card's root for Create and run, the approved snapshot for a schedule. A card's root is
  // noted before anything is awaited, so a discard its row's removal asks for at once already has it. A schedule's is read first:
  // while such a read is open every discard waits for it, the one its row's removal asks for too, or that discard would find the
  // run with no root and leave it whole with a warning, only for the next to take it apart.
  const reading = new Set<Promise<void>>();
  const scheduled = (runId: string, itemId: number, attachmentId: string): void => {
    const read = attachments.getAttachment(attachmentId).catch(() => null).then((attachment) => {
      const approved = attachment?.approvedScope;
      if (approved?.kind === "project") note(runId, itemId, approved.projectRoot);
      reading.delete(read);
      unread.delete(runId);
    });
    reading.add(read);
    unread.add(runId);
  };
  const ask = (): void => {
    if (reading.size === 0) discard();
    else void Promise.all(reading).then(ask);
  };
  store.runs.onRunsRemoved = (removed: readonly RemovedRun[]) => {
    for (const { runId, itemId, runStartedBy: source } of removed) {
      if (source.kind === "schedule-attachment") scheduled(runId, itemId, source.attachmentId);
      else if (source.projectRoot !== undefined) note(runId, itemId, source.projectRoot);
    }
    ask();
  };
  store.onItemRemoved = ask;
  return {
    runs: boardRunState(store),
    workspace,
    workspaceBinding: { bind: bindStageWorkspace, unbind: unbindStageWorkspace },
    authoriseRunSource,
    passConditions: createPassConditionRegistry(),
  };
}
