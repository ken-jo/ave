// Row updates must preserve unrelated fields because sidecar writes replace the entire metadata file.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, toSessionListRow } from "../memory-manager.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

let dir: string;
let mm: MemoryManager;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ave-session-row-fields-"));
  mm = new MemoryManager({ aveDir: dir });
  await mm.saveSession(SESSION, [{ role: "user", content: "hello" }]);
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("updateSessionRowFields", () => {
  it("keeps the rest of the metadata when one field changes", async () => {
    await mm.saveSessionMetadata(SESSION, {
      sessionKind: "main",
      projectRoot: "/ws/alpha",
      projectName: "alpha",
    });
    await mm.updateSessionRowFields(SESSION, { title: "이름 바꾼 대화" });

    const metadata = mm.loadSessionMetadata(SESSION);
    expect(metadata?.title).toBe("이름 바꾼 대화");
    expect(metadata?.projectRoot).toBe("/ws/alpha");
    expect(metadata?.projectName).toBe("alpha");
  });

  it("round-trips archived and unread through the listing", async () => {
    await mm.updateSessionRowFields(SESSION, { archivedAt: "2026-08-27T00:00:00.000Z" });
    await mm.updateSessionRowFields(SESSION, { unreadSince: "2026-08-27T01:00:00.000Z" });

    const listed = mm.listSessions().find((entry) => entry.id === SESSION);
    expect(listed?.archivedAt).toBe("2026-08-27T00:00:00.000Z");
    expect(listed?.unreadSince).toBe("2026-08-27T01:00:00.000Z");
  });

  it("clears a flag with null and leaves the other one alone", async () => {
    await mm.updateSessionRowFields(SESSION, {
      archivedAt: "2026-08-27T00:00:00.000Z",
      unreadSince: "2026-08-27T01:00:00.000Z",
    });
    await mm.updateSessionRowFields(SESSION, { archivedAt: null });

    const metadata = mm.loadSessionMetadata(SESSION);
    expect(metadata?.archivedAt).toBeUndefined();
    // Undefined leaves unread unchanged, allowing unarchive without marking read.
    expect(metadata?.unreadSince).toBe("2026-08-27T01:00:00.000Z");
  });

  it("keeps a title the user typed rather than cutting it to a few words", async () => {
    const typed = "회의록 정리와 후속 액션 아이템 추출까지 한 번에 처리한 대화";
    await mm.updateSessionRowFields(SESSION, { title: typed });
    expect(mm.loadSessionMetadata(SESSION)?.title).toBe(typed);
  });

  it("refuses a malformed session id instead of writing somewhere else", async () => {
    await expect(
      mm.updateSessionRowFields("../escape", { title: "x" }),
    ).rejects.toThrow(/invalid sessionId/);
  });
});

describe("saveSessionTasks", () => {
  it("round-trips the task list through the sidecar, completed items included", async () => {
    await mm.saveSessionMetadata(SESSION, { sessionKind: "main", projectRoot: "/ws/alpha", title: "plan" });
    await mm.saveSessionTasks(SESSION, [
      { id: "a", content: "scan folder", status: "completed" },
      { id: "b", content: "write report", status: "in_progress" },
    ]);

    const metadata = mm.loadSessionMetadata(SESSION);
    expect(metadata?.tasks).toEqual([
      { id: "a", content: "scan folder", status: "completed" },
      { id: "b", content: "write report", status: "in_progress" },
    ]);
    expect(metadata?.projectRoot).toBe("/ws/alpha");
    expect(metadata?.title).toBe("plan");
  });

  it("survives a later field-level update and is dropped by an empty list", async () => {
    await mm.saveSessionTasks(SESSION, [{ id: "a", content: "one", status: "pending" }]);
    await mm.updateSessionRowFields(SESSION, { title: "renamed" });
    expect(mm.loadSessionMetadata(SESSION)?.tasks).toEqual([{ id: "a", content: "one", status: "pending" }]);

    await mm.saveSessionTasks(SESSION, []);
    expect(mm.loadSessionMetadata(SESSION)?.tasks).toBeUndefined();
    expect(mm.loadSessionMetadata(SESSION)?.title).toBe("renamed");
  });

  it("keeps only well-formed items when reading a sidecar", async () => {
    await mm.saveSessionMetadata(SESSION, {
      sessionKind: "main",
      tasks: [
        { id: "ok", content: "fine", status: "pending" },
        { id: "bad", content: "no status" } as never,
        "not an item" as never,
      ],
    });
    expect(mm.loadSessionMetadata(SESSION)?.tasks).toEqual([{ id: "ok", content: "fine", status: "pending" }]);
  });
});

describe("findPaneSession", () => {
  const OLDER = "bbbbbbbb-1111-2222-3333-444444444444";
  const NEWER = "cccccccc-1111-2222-3333-444444444444";
  const at = (id: string, seconds: number) =>
    utimesSync(join(sessionStorePath(dir), `${id}.jsonl`), seconds, seconds);

  it("finds the newest unarchived conversation of a pane, and none for another pane", async () => {
    for (const id of [OLDER, NEWER]) {
      await mm.saveSession(id, [{ role: "user", content: id }]);
      await mm.saveSessionMetadata(id, { sessionKind: "main", paneTabId: "browser:w-1" });
    }
    at(OLDER, 1_000);
    at(NEWER, 2_000);
    expect(mm.findPaneSession("browser:w-1")).toBe(NEWER);
    expect(mm.findPaneSession("terminal:w-1")).toBeUndefined();
    await mm.updateSessionRowFields(NEWER, { archivedAt: "2026-10-19T00:00:00.000Z" });
    expect(mm.findPaneSession("browser:w-1")).toBe(OLDER);
  });

  it("answers from its index after one scan, kept by writes and deletes made through it", async () => {
    await mm.saveSession(OLDER, [{ role: "user", content: "older" }]);
    await mm.saveSessionMetadata(OLDER, { sessionKind: "main", paneTabId: "browser:w-1" });
    expect(mm.findPaneSession("browser:w-1")).toBe(OLDER);
    await mm.saveSession(NEWER, [{ role: "user", content: "newer" }]);
    writeFileSync(join(sessionStorePath(dir), `${NEWER}.meta.json`), JSON.stringify({ sessionKind: "main", paneTabId: "browser:w-9" }));
    expect(mm.findPaneSession("browser:w-9")).toBeUndefined();
    await mm.saveSessionMetadata(NEWER, { sessionKind: "main", paneTabId: "browser:w-1" });
    at(OLDER, 1_000);
    at(NEWER, 2_000);
    expect(mm.findPaneSession("browser:w-1")).toBe(NEWER);
    await mm.deleteSession(NEWER);
    expect(mm.findPaneSession("browser:w-1")).toBe(OLDER);
    await mm.updateSessionRowFields(OLDER, { archivedAt: "2026-10-19T00:00:00.000Z" });
    expect(mm.findPaneSession("browser:w-1")).toBeUndefined();
  });

  it("carries pane binding from metadata through the shared side-chat row only", async () => {
    await mm.saveSessionMetadata(SESSION, { sessionKind: "main", paneTabId: "terminal:w-2" });
    const listed = mm.listSessions().find((entry) => entry.id === SESSION)!;
    expect(listed.paneTabId).toBe("terminal:w-2");
    expect(toSessionListRow("side-chat", listed)?.paneTabId).toBe("terminal:w-2");
    expect(toSessionListRow("main", listed)?.paneTabId).toBeUndefined();
  });

  it("reads the pane back from the metadata it was saved in", async () => {
    await mm.saveSessionMetadata(SESSION, { sessionKind: "main", paneTabId: "terminal:w-2" });
    expect(mm.loadSessionMetadata(SESSION)?.paneTabId).toBe("terminal:w-2");
    await mm.saveSessionMetadata(SESSION, { sessionKind: "main", paneTabId: "" });
    expect(mm.loadSessionMetadata(SESSION)?.paneTabId).toBeUndefined();
    expect(mm.findPaneSession("terminal:w-2")).toBeUndefined();
  });
});
