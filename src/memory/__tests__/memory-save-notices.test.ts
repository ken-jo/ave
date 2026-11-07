// Undo stays simple: undoing a create deletes it, an update puts the earlier bytes back, a delete restores it, and an undo never discards a newer edit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { MemorySaveNotices, toolNoticeTarget } from "../memory-save-notices.js";
import { isMemorySaveResultEvent, type MemorySaveResultEvent } from "../../shared/memory-save-result.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10";
const TURN = "7d1c2a4e-9f0b-4c3d-8e6f-5a4b3c2d1e0f";

let dir: string;
let manager: MemoryManager;
let notices: MemorySaveNotices;
let events: MemorySaveResultEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-memory-notices-"));
  manager = new MemoryManager({ aveDir: dir });
  notices = new MemorySaveNotices(manager);
  events = [];
  notices.setSink((event) => { events.push(event); });
});

afterEach(async () => {
  manager.stopPersistentContextWatcher();
  manager.sessions.closeSearchIndex();
  await cleanupTmpDir(dir);
});

async function save(title: string, content: string, options: Parameters<MemoryManager["saveMemory"]>[2] = {}) {
  const result = await manager.saveMemory(title, content, options, "assistant");
  const token = notices.saved({ sessionId: SESSION, anchorMessageId: TURN }, result);
  return { ...result, token };
}

describe("MemorySaveNotices", () => {
  it("announces a create and an update, each with its own undo token", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const updated = await save("Reply language", "Answer in Korean, briefly.");

    expect(created.token).toEqual(expect.any(String));
    expect(updated.token).toEqual(expect.any(String));
    expect(updated.token).not.toBe(created.token);
    expect(events).toEqual([
      {
        sessionId: SESSION,
        anchorMessageId: TURN,
        result: {
          status: "saved", op: "created", undoToken: created.token,
          entry: { id: created.entry.id, filename: created.entry.filename, title: "Reply language", scope: "global" },
        },
      },
      {
        sessionId: SESSION,
        anchorMessageId: TURN,
        result: {
          status: "saved", op: "updated", undoToken: updated.token,
          entry: { id: created.entry.id, filename: created.entry.filename, title: "Reply language", scope: "global" },
        },
      },
    ]);
    expect(events.every(isMemorySaveResultEvent)).toBe(true);
  });

  it("undoes a create by deleting it, once", async () => {
    const created = await save("Package manager", "Use pnpm.", { projectRoot: "C:\\workspace\\alpha" });

    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: true, undone: "created", title: "Package manager" });
    expect(existsSync(join(dir, "memories", created.entry.filename))).toBe(false);
    expect((await manager.getMemoryHistory(created.entry.id!, {}).catch(() => null))).toBeNull();
    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: false, error: "not-found" });
  });

  it("refuses to undo a create that was changed since, keeping the newer text", async () => {
    const created = await save("Package manager", "Use pnpm.");
    await save("Package manager", "Use pnpm 9.");

    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: false, error: "changed" });
    expect(readFileSync(join(dir, "memories", created.entry.filename), "utf-8")).toContain("Use pnpm 9.");
  });

  it("undoes an update by putting the earlier text back, keeping the id and recording it", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const before = readFileSync(join(dir, "memories", created.entry.filename), "utf-8");
    const updated = await save("Reply language", "Answer in English.");

    await expect(notices.undo(updated.token!)).resolves.toEqual({ ok: true, undone: "updated", title: "Reply language" });
    expect(readFileSync(join(dir, "memories", created.entry.filename), "utf-8")).toBe(before);
    expect(manager.listMemoryEntries()).toHaveLength(1);
    const history = await manager.getMemoryHistory(created.entry.id!, {});
    expect(history.entries.map((row) => [row.op, row.actor])).toEqual([["created", "assistant"], ["updated", "assistant"], ["updated", "user"]]);
    await expect(notices.undo(updated.token!)).resolves.toEqual({ ok: false, error: "not-found" });
  });

  it("refuses to undo an update that was changed again, keeping the newest text", async () => {
    await save("Reply language", "Answer in Korean.");
    const updated = await save("Reply language", "Answer in English.");
    const newest = await save("Reply language", "Answer in Japanese.");

    await expect(notices.undo(updated.token!)).resolves.toEqual({ ok: false, error: "changed" });
    expect(readFileSync(join(dir, "memories", newest.entry.filename), "utf-8")).toContain("Answer in Japanese.");
  });

  it("drops a memory's earlier undo records when it is deleted, keeping only the delete's own", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const updated = await save("Reply language", "Answer in English.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);

    await expect(notices.undo(updated.token!)).resolves.toEqual({ ok: false, error: "not-found" });
    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: false, error: "not-found" });
    await expect(notices.undo(token!)).resolves.toEqual({ ok: true, undone: "deleted", title: "Reply language" });
  });

  it("keeps a new create's undo when the delete of an earlier memory with the same file name is announced after it", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    // The delete's lock is released before its notice; a create of the same title lands in between and reuses the name.
    const recreated = await save("Reply language", "Answer in English.");
    expect(recreated.entry.filename).toBe(created.entry.filename);
    notices.deleted(undefined, deleted.entry!, deleted.priorContent);

    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: false, error: "not-found" });
    await expect(notices.undo(recreated.token!)).resolves.toEqual({ ok: true, undone: "created", title: "Reply language" });
  });

  it("keeps a new create's undo when it lands while an undone create's delete is finishing", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const realDelete = manager.deleteMemoryIfUnchanged.bind(manager);
    let recreated: Awaited<ReturnType<typeof save>> | undefined;
    vi.spyOn(manager, "deleteMemoryIfUnchanged").mockImplementationOnce(async (...args) => {
      const outcome = await realDelete(...args);
      // After the delete's lock is released and before the undo resumes, a create of the same title reuses the name.
      recreated = await save("Reply language", "Answer in English.");
      return outcome;
    });

    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: true, undone: "created", title: "Reply language" });
    expect(recreated!.entry.filename).toBe(created.entry.filename);
    await expect(notices.undo(recreated!.token!)).resolves.toEqual({ ok: true, undone: "created", title: "Reply language" });
  });

  it("undoes an update that kept its title even when a newer same-title copy appeared since", async () => {
    const created = await save("Release decision", "Ship Monday.");
    const result = await manager.updateMemoryById(created.entry.id!, "Release decision", "Ship Tuesday.", { source: "assistant" }, "assistant");
    const token = notices.saved(undefined, result);
    // A newer same-title copy appears afterwards (another device, an older build).
    const stored = readFileSync(join(dir, "memories", created.entry.filename), "utf-8");
    const header = /<!-- ave:memory-meta:([A-Za-z0-9_-]+) -->/.exec(stored)!;
    const metadata = JSON.parse(Buffer.from(header[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
    metadata.id = "9e8d7c6b-5a49-4382-9716-0f1e2d3c4b5a";
    const copy = join(dir, "memories", "release-decision-copy.md");
    writeFileSync(copy, stored.replace(header[1]!, Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url")), "utf-8");
    // The copy is the newest same-title file, but this restore keeps the title, so the copy does not block it.
    utimesSync(copy, new Date(2100, 0, 1), new Date(2100, 0, 1));

    await expect(notices.undo(token!)).resolves.toEqual({ ok: true, undone: "updated", title: "Release decision" });
    expect(readFileSync(join(dir, "memories", created.entry.filename), "utf-8")).toContain("Ship Monday.");
  });

  it("keeps the token when the undo throws, so it can be tried again", async () => {
    const created = await save("Package manager", "Use pnpm.");
    const failing = vi.spyOn(manager, "deleteMemoryIfUnchanged").mockRejectedValueOnce(new Error("disk busy"));

    await expect(notices.undo(created.token!)).rejects.toThrow("disk busy");
    failing.mockRestore();
    await expect(notices.undo(created.token!)).resolves.toEqual({ ok: true, undone: "created", title: "Package manager" });
  });

  it("undoes a delete by restoring the same memory, id and global index entry included", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);
    expect(manager.getMemoryIndex()).not.toContain("Reply language");

    await expect(notices.undo(token!)).resolves.toEqual({ ok: true, undone: "deleted", title: "Reply language" });
    const restored = manager.listMemoryEntries().find((entry) => entry.id === created.entry.id);
    expect(restored).toMatchObject({ title: "Reply language", content: expect.stringContaining("Answer in Korean.") });
    expect(manager.getMemoryIndex()).toContain("Reply language");
    const history = await manager.getMemoryHistory(created.entry.id!, {});
    expect(history.entries.map((row) => [row.op, row.actor])).toEqual([["created", "assistant"], ["deleted", "user"], ["created", "user"]]);
  });

  it("leaves the memory deleted when restoring its index entry fails, so the same undo works once writes do", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);
    const path = join(dir, "memories", created.entry.filename);
    const failing = vi.spyOn(manager as unknown as { updateMemoryIndexLocked: () => void }, "updateMemoryIndexLocked")
      .mockImplementationOnce(() => { throw new Error("index write refused"); });

    await expect(notices.undo(token!)).rejects.toThrow("index write refused");
    expect(existsSync(path)).toBe(false);
    expect(manager.getMemoryIndex()).not.toContain("Reply language");
    failing.mockRestore();

    await expect(notices.undo(token!)).resolves.toEqual({ ok: true, undone: "deleted", title: "Reply language" });
    expect(readFileSync(path, "utf-8")).toContain("Answer in Korean.");
    expect(manager.getMemoryIndex()).toContain("Reply language");
  });

  it("removes the restored file and index entry when recording the restore in history fails", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);
    const history = (manager as unknown as { history: { record: (...args: unknown[]) => Promise<void> } }).history;
    const failing = vi.spyOn(history, "record").mockRejectedValueOnce(new Error("history write refused"));

    await expect(notices.undo(token!)).rejects.toThrow("history write refused");
    expect(existsSync(join(dir, "memories", created.entry.filename))).toBe(false);
    expect(readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8")).not.toContain("Reply language");
    failing.mockRestore();

    await expect(notices.undo(token!)).resolves.toEqual({ ok: true, undone: "deleted", title: "Reply language" });
  });

  it("refuses to restore over a memory saved with the same title in the meantime", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);
    await save("Reply language", "Answer in English.");

    await expect(notices.undo(token!)).resolves.toEqual({ ok: false, error: "changed" });
    expect(manager.listMemoryEntries().filter((entry) => entry.title === "Reply language")).toHaveLength(1);
    expect(manager.listMemoryEntries()[0]!.content).toContain("Answer in English.");
  });

  it("refuses to restore when the file name was taken by another file", async () => {
    const created = await save("Reply language", "Answer in Korean.");
    const deleted = await manager.deleteMemory(created.entry.filename, {}, "user");
    const token = notices.deleted(undefined, deleted.entry!, deleted.priorContent);
    writeFileSync(join(dir, "memories", created.entry.filename), "# Someone else\n\nhand-written", "utf-8");

    await expect(notices.undo(token!)).resolves.toEqual({ ok: false, error: "changed" });
    expect(readFileSync(join(dir, "memories", created.entry.filename), "utf-8")).toContain("hand-written");
  });

  it("keeps only the most recent undo records", async () => {
    const small = new MemorySaveNotices(manager, 2);
    const tokens: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const result = await manager.saveMemory(title, `${title} body.`, {}, "user");
      tokens.push(small.saved(undefined, result)!);
    }
    await expect(small.undo(tokens[0]!)).resolves.toEqual({ ok: false, error: "not-found" });
    await expect(small.undo(tokens[2]!)).resolves.toMatchObject({ ok: true, undone: "created" });
  });

  it("sends nothing outside a conversation or before a window exists, and survives a failing sink", async () => {
    const result = await manager.saveMemory("Quiet", "No chat here.", {}, "user");
    notices.saved(undefined, result);
    expect(events).toEqual([]);

    const detached = new MemorySaveNotices(manager);
    expect(() => detached.skipped({ sessionId: SESSION }, "credential")).not.toThrow();

    notices.setSink(vi.fn(() => { throw new Error("window gone"); }));
    expect(() => notices.skipped({ sessionId: SESSION }, "credential")).not.toThrow();
  });

  it("reads a tool's notice target only from host metadata", () => {
    expect(toolNoticeTarget({ sessionId: SESSION, turnMessageId: TURN })).toEqual({ sessionId: SESSION, anchorMessageId: TURN });
    expect(toolNoticeTarget({ sessionId: SESSION })).toEqual({ sessionId: SESSION });
    expect(toolNoticeTarget({})).toBeUndefined();
    expect(toolNoticeTarget(undefined)).toBeUndefined();
  });
});

describe("isMemorySaveResultEvent", () => {
  it("accepts only the exact event shape", () => {
    const entry = { id: "a", filename: "a.md", title: "A", scope: "project" };
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "saved", op: "deleted", entry, undoToken: "t" } })).toBe(true);
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "skipped", reason: "unsafe-text" } })).toBe(true);
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "skipped", reason: "reviewer-skip" } })).toBe(true);
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "skipped", reason: "nope" } })).toBe(false);
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "saved", op: "promoted", entry } })).toBe(false);
    expect(isMemorySaveResultEvent({ sessionId: SESSION, result: { status: "saved", op: "created", entry: { ...entry, scope: "other" } } })).toBe(false);
    expect(isMemorySaveResultEvent({ result: { status: "skipped", reason: "credential" } })).toBe(false);
    expect(isMemorySaveResultEvent(null)).toBe(false);
  });
});
