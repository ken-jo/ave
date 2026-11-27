import { expect, it, vi } from "vitest";
import { stageRunHarness } from "../../../work-board/workflow/__tests__/stage-run-harness.js";
import { autoStageOf } from "../../../work-board/workflow/__tests__/stage-fixtures.js";
import { observeWorkflowSkillMemory } from "../skill-memory-work-board.js";

it("uses the child recorded in the committed local workflow and ignores descendant links", async () => {
  const memory = { linkWorkBoardSession: vi.fn(), unlinkWorkBoardSession: vi.fn(), queueWorkBoard: vi.fn(async () => {}) };
  let observe: ReturnType<typeof observeWorkflowSkillMemory> | undefined;
  const h = await stageRunHarness({
    observeRunWork: true,
    onProgress: (event, project) => observe?.(event, project?.projectRoot),
  });
  observe = observeWorkflowSkillMemory(h.board, memory);
  await h.runThenEnd(async () => {
    const version = await h.confirm([autoStageOf("check")]);
    const id = await h.addItem(version, h.dir);
    const starting = h.start(id, h.local(version, h.dir));
    const [child] = await h.untilLive(1, id);
    expect(memory.linkWorkBoardSession).toHaveBeenCalledExactlyOnceWith(id, child.sessionId, h.dir);
    observe?.({ itemId: id, stageId: "check", phase: "executing", runSessionId: child.sessionId,
      subAgentSessionId: "descendant", at: new Date().toISOString() }, h.dir);
    expect(memory.linkWorkBoardSession).toHaveBeenCalledOnce();
    expect(memory.queueWorkBoard).not.toHaveBeenCalled();
    child.finish();
    await starting;
    await vi.waitFor(() => expect(memory.queueWorkBoard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id, runStatus: "completed" }), expect.any(String), [child.sessionId],
    ));
    expect(memory.unlinkWorkBoardSession).toHaveBeenCalledExactlyOnceWith(child.sessionId);
  });
});
