import { createLogger } from "../../lib/logger.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { SkillMemoryService } from "../../memory/skill-memory-service.js";
import type { WorkBoardEngineDeps } from "../../core/work-board-engine.js";

const log = createLogger("skill-memory");
const LINKED_ITEM_LIMIT = 128;

/** Consume host workflow progress and verify the committed run before handing off an attended terminal. */
export function observeWorkflowSkillMemory(
  store: Pick<WorkBoardStore, "get" | "getRun">,
  skillMemory: Pick<SkillMemoryService, "linkWorkBoardSession" | "unlinkWorkBoardSession" | "queueWorkBoard">,
): WorkBoardEngineDeps["emitProgress"] {
  const children = new Map<number, Map<string, string>>();
  return (event, project, isOwnerCurrent) => {
    if (!isOwnerCurrent || !project?.runId) return;
    const { projectRoot, runId } = project;
    const { itemId, phase, stageId, runSessionId } = event;
    if (phase === "executing" && stageId && runSessionId && projectRoot && !event.subAgentSessionId) {
      const stages = children.get(itemId) ?? new Map<string, string>();
      const previous = stages.get(stageId);
      if (previous === runSessionId) return;
      if (previous) skillMemory.unlinkWorkBoardSession(previous);
      stages.set(stageId, runSessionId);
      children.set(itemId, stages);
      skillMemory.linkWorkBoardSession(itemId, runSessionId, projectRoot);
      const oldest = children.keys().next().value;
      if (children.size > LINKED_ITEM_LIMIT && oldest !== undefined) {
        for (const id of children.get(oldest)?.values() ?? []) skillMemory.unlinkWorkBoardSession(id);
        children.delete(oldest);
      }
    }
    if (stageId && (phase === "stage_gate" || phase === "stage_passed" || phase === "stage_failed")) {
      const stages = children.get(itemId);
      const child = stages?.get(stageId);
      if (child) skillMemory.unlinkWorkBoardSession(child);
      stages?.delete(stageId);
      if (stages?.size === 0) children.delete(itemId);
    }
    if (phase !== "done" && phase !== "error" && phase !== "denied" && phase !== "cancelled") return;
    for (const sessionId of children.get(itemId)?.values() ?? []) skillMemory.unlinkWorkBoardSession(sessionId);
    children.delete(itemId);
    // A legacy Done carries the execute child and is handled by the board engine.
    if (phase !== "done" || runSessionId) return;
    void (async () => {
      const [item, committed] = await Promise.all([store.get(itemId), store.getRun(itemId)]);
      if (item.status !== "found" || committed.status !== "found") return;
      const { run } = committed;
      if (run.settled?.status !== "completed" || run.runStartedBy.kind !== "local-create-and-run"
        || item.item.runId !== runId || run.runId !== runId) return;
      const sessions = run.stageRuns.flatMap(stage => stage.status === "passed" && stage.childSessionId ? [stage.childSessionId] : []);
      await skillMemory.queueWorkBoard(item.item, runId, sessions, isOwnerCurrent);
    })().catch(() => log.warn("Workflow skill memory evidence was unavailable"));
  };
}
