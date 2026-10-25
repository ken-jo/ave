// Persist revival rounds across restart so a fresh manager cannot reset the goal budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { SessionGoal } from "../../shared/session-goal.js";

const SESSION = "bbbbbbbb-1111-2222-3333-444444444444";

const GOAL: SessionGoal = {
  text: "ship the release",
  status: "running",
  round: 7,
  ceiling: 50,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:10:00.000Z",
};

let dir: string;
let mm: MemoryManager;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ave-session-goal-"));
  mm = new MemoryManager({ aveDir: dir });
  await mm.saveSession(SESSION, [{ role: "user", content: "hello" }]);
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("session goal sidecar", () => {
  it("brings the goal back with its spent rounds after a restart", async () => {
    await mm.saveSessionGoal(SESSION, GOAL);
    const restarted = new MemoryManager({ aveDir: dir });
    expect(restarted.loadSessionMetadata(SESSION)?.goal).toEqual(GOAL);
  });

  it("keeps the rest of the metadata when the goal is written", async () => {
    await mm.saveSessionMetadata(SESSION, {
      sessionKind: "main",
      projectRoot: "/ws/alpha",
      projectName: "alpha",
      title: "대화",
    });
    await mm.saveSessionGoal(SESSION, GOAL);
    const meta = new MemoryManager({ aveDir: dir }).loadSessionMetadata(SESSION);
    expect(meta).toMatchObject({
      projectRoot: "/ws/alpha",
      projectName: "alpha",
      title: "대화",
      goal: GOAL,
    });
  });

  it("removes the goal rather than storing a tombstone", async () => {
    await mm.saveSessionGoal(SESSION, GOAL);
    await mm.saveSessionGoal(SESSION, null);
    expect(new MemoryManager({ aveDir: dir }).loadSessionMetadata(SESSION)?.goal).toBeUndefined();
  });

  it("drops a malformed goal instead of reading a budget nobody can account for", async () => {
    await mm.saveSessionMetadata(SESSION, {
      sessionKind: "main",
      goal: { text: "x", status: "running", round: -1, ceiling: 50 } as never,
    });
    expect(new MemoryManager({ aveDir: dir }).loadSessionMetadata(SESSION)?.goal).toBeUndefined();
  });

  it("refuses to write a goal against an invalid session id", async () => {
    await expect(mm.saveSessionGoal("../escape", GOAL)).rejects.toThrow("saveSessionGoal");
  });
});
