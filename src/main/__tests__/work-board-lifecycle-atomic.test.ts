import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkBoardStore, itemDigestOf } from "../work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { workBoardStage } from "../../shared/work-board-lifecycle.js";

const NOW = "2026-11-15T00:00:00.000Z";
let root: string;
let store: WorkBoardStore;
let peer: WorkBoardStore;
let id: number;
async function current() {
  const found = await store.get(id);
  if (found.status !== "found") throw new Error("Item missing");
  return found.item;
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "board-atomic-"));
  store = new WorkBoardStore(join(root, "board.json"), () => Date.parse(NOW));
  peer = new WorkBoardStore(join(root, "board.json"), () => Date.parse(NOW));
  const created = await store.create({ title: "Export notes" });
  if (created.status !== "created") throw new Error("Create failed");
  id = created.itemId;
  await peer.load();
});
afterEach(() => cleanupTmpDir(root));

describe("atomic board lifecycle", () => {
  it.each(["complete", "move"] as const)("rejects a stale %s while a concurrent run starts, even with a fixed clock", async (operation) => {
    const snapshot = await current();
    const [started, mutated] = await Promise.all([
      peer.beginRun(id, "next-run", NOW),
      operation === "complete" ? store.complete(id, snapshot.mutationRevision)
        : store.transition(id, "in_progress", "transitioned", snapshot.mutationRevision),
    ]);
    expect(started.status).toBe("updated");
    expect(mutated).toMatchObject({ status: "invalid", reason: "work-item-changed" });
    const saved = await current();
    expect(saved.status).toBe("planned");
    expect(saved.runStatus).toBe("planning");
    expect(saved.completed_at).toBeUndefined();
    expect(workBoardStage(saved)).toBe("in_progress");
  });
  it("refuses a run that loses the lock to completion", async () => {
    const snapshot = await current();
    const [completed, started] = await Promise.all([
      store.complete(id, snapshot.mutationRevision), peer.beginRun(id, "late-run", NOW),
    ]);
    expect(completed.status).toBe("completed");
    expect(started).toMatchObject({ status: "invalid", reason: "work-item-completed" });
    expect((await current()).runStatus).toBeUndefined();
  });
  it.each(["planning", "executing", "awaiting_approval"] as const)("refuses direct host completion and moves during %s without relying on a renderer", async runStatus => {
    await store.beginRun(id, "active-run", NOW);
    await store.setRunStatus(id, runStatus);
    expect((await store.complete(id)).status).toBe("invalid");
    for (const target of ["planned", "in_progress", "completed"] as const) {
      expect((await peer.transition(id, target)).status).toBe("invalid");
    }
    expect((await current()).completed_at).toBeUndefined();
  });
  it("keeps a pending plan and its decision intact when a direct host caller tries to complete it", async () => {
    const item = await current();
    await store.beginRun(id, "plan-run", NOW);
    await store.setPlanAwaitingApproval(id, { runId: "plan-run", plan: "Export three files", runSessionId: "plan-session", revision: 0, itemDigest: itemDigestOf(item) });
    const before = readFileSync(join(root, "board.json"), "utf8");
    expect(await peer.complete(id)).toMatchObject({ status: "invalid", reason: "movePlanDecision" });
    expect(readFileSync(join(root, "board.json"), "utf8")).toBe(before);
    expect(workBoardStage(await current())).toBe("review");
  });
  it("binds completion to the shown output even when a result changes within the same millisecond", async () => {
    await store.beginRun(id, "result-run", NOW);
    await store.setRunResult(id, { runStatus: "completed", output: "First output" });
    const snapshot = await current();
    await peer.setRunResult(id, { runStatus: "completed", output: "Revised output" });
    expect(await store.complete(id, snapshot.mutationRevision)).toMatchObject({ status: "invalid", reason: "work-item-changed" });
    const latest = await current();
    expect((await store.complete(id, latest.mutationRevision)).status).toBe("completed");
    const persisted = JSON.parse(readFileSync(join(root, "board.json"), "utf8"));
    expect(persisted.items[0]).not.toHaveProperty("mutationRevision");
  });
  it("allows a completed result to reopen into its derived review lane", async () => {
    await store.beginRun(id, "result-run", NOW);
    await store.setRunResult(id, { runStatus: "completed", output: "Saved output" });
    await store.complete(id, (await current()).mutationRevision);
    const reopened = await store.reopen(id, (await current()).mutationRevision);
    expect(reopened.status).toBe("reopened");
    expect(workBoardStage(await current())).toBe("review");
  });
});
