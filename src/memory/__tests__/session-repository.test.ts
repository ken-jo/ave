import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRepository } from "../session-repository.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { syncExistingFileSync, writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { turnInflightPath, writeTurnInflightRecord } from "../session-turn-journal.js";

const appendFault = vi.hoisted(() => ({ datasync: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (appendFault.datasync && args[1] === "a+") {
        appendFault.datasync = false;
        vi.spyOn(handle, "datasync").mockRejectedValueOnce(new Error("append sync failed"));
      }
      return handle;
    },
  };
});
vi.mock("../../lib/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/atomic-file.js")>();
  return { ...actual, syncExistingFileSync: vi.fn(actual.syncExistingFileSync), writeUtf8FileAtomicSync: vi.fn(actual.writeUtf8FileAtomicSync) };
});

describe("SessionRepository", () => {
  let dir: string;
  let repository: SessionRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-session-repository-"));
    repository = new SessionRepository({ aveDir: dir });
  });

  afterEach(async () => {
    appendFault.datasync = false;
    vi.mocked(syncExistingFileSync).mockReset();
    vi.mocked(writeUtf8FileAtomicSync).mockReset();
    const actual = await vi.importActual<typeof import("../../lib/atomic-file.js")>("../../lib/atomic-file.js");
    vi.mocked(syncExistingFileSync).mockImplementation(actual.syncExistingFileSync);
    vi.mocked(writeUtf8FileAtomicSync).mockImplementation(actual.writeUtf8FileAtomicSync);
    repository.closeSearchIndex();
    await cleanupTmpDir(dir);
  });

  it.each([
    { outcome: "success", writeFails: false },
    { outcome: "file", writeFails: false },
    { outcome: "directory", writeFails: false },
    { outcome: "file", writeFails: true },
    { outcome: "directory", writeFails: true },
  ] as const)("confirms durability after a failed append with $outcome sync outcome and write failure $writeFails", async ({ outcome, writeFails }) => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "Save", meta: { messageId: "row-first" } };
    const second = { role: "assistant", content: "Saved", meta: { messageId: "row-second" } };
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    const sidecar = turnInflightPath(join(dir, "sessions"), sessionId);
    await repository.saveSession(sessionId, [first]);
    await writeTurnInflightRecord(sidecar, { v: 1, startedAt: 1_000 });
    appendFault.datasync = true;

    await expect(repository.appendSessionProgress(sessionId, [first, second])).rejects.toThrow("append sync failed");
    expect(readFileSync(path, "utf8")).toBe(`${[first, second].map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect(existsSync(sidecar)).toBe(true);
    vi.mocked(syncExistingFileSync).mockClear();
    if (outcome !== "success") {
      const actual = await vi.importActual<typeof import("../../lib/atomic-file.js")>("../../lib/atomic-file.js");
      vi.mocked(syncExistingFileSync).mockImplementationOnce((filePath) => actual.syncExistingFileSync(filePath, {
        platform: "linux",
        openFile: (filePath) => openSync(filePath, "r+"),
        open: () => -1,
        fsync: (fd) => {
          if (outcome === "file" || fd === -1) throw new Error("durability sync failed");
          fsyncSync(fd);
        },
        close: (fd) => { if (fd !== -1) closeSync(fd); },
      }));
    }

    const content = readFileSync(path, "utf8");
    vi.mocked(writeUtf8FileAtomicSync).mockClear();
    if (writeFails) {
      vi.mocked(writeUtf8FileAtomicSync).mockImplementationOnce(() => { throw new Error("atomic write failed"); });
    }
    const save = repository.saveSession(sessionId, [first, second]);
    if (writeFails) {
      await expect(save).rejects.toThrow("atomic write failed");
      expect(existsSync(sidecar)).toBe(true);
    } else {
      await expect(save).resolves.toBeUndefined();
      expect(existsSync(sidecar)).toBe(false);
    }
    expect(syncExistingFileSync).toHaveBeenCalledExactlyOnceWith(path);
    if (outcome === "success") expect(writeUtf8FileAtomicSync).not.toHaveBeenCalled();
    else expect(writeUtf8FileAtomicSync).toHaveBeenCalledExactlyOnceWith(path, content);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("retries directory durability after a rename committed but its directory sync failed", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const messages = [{ role: "user", content: "Save" }];
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    const sidecar = turnInflightPath(join(dir, "sessions"), sessionId);
    await writeTurnInflightRecord(sidecar, { v: 1, startedAt: 1_000 });
    const writeWithDirectorySyncRuntime = writeUtf8FileAtomicSync as unknown as (
      filePath: string, content: string, mode: number | undefined,
      runtime: NonNullable<Parameters<typeof syncExistingFileSync>[1]>,
    ) => void;
    expect(() => writeWithDirectorySyncRuntime(path, `${JSON.stringify(messages[0])}\n`, undefined, {
      platform: "linux", open: () => -1,
      fsync: () => { throw new Error("directory sync failed"); },
      close: () => undefined,
    })).toThrow("parent directory sync failed");
    const before = statSync(path, { bigint: true });
    const directorySync = vi.fn();
    const actual = await vi.importActual<typeof import("../../lib/atomic-file.js")>("../../lib/atomic-file.js");
    vi.mocked(syncExistingFileSync).mockImplementationOnce((filePath) => actual.syncExistingFileSync(filePath, {
      platform: "linux", openFile: (filePath) => openSync(filePath, "r+"),
      open: () => -1,
      fsync: (fd) => { if (fd === -1) directorySync(); else fsyncSync(fd); },
      close: (fd) => { if (fd !== -1) closeSync(fd); },
    }));

    await repository.saveSession(sessionId, messages);

    expect(directorySync).toHaveBeenCalledTimes(1);
    expect(existsSync(sidecar)).toBe(false);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
  });

  it("preserves transcript mtime for identical saves and refreshes the append prefix", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "안녕하세요", meta: { messageId: "row-first" } };
    const second = { role: "assistant", content: "Saved", meta: { messageId: "row-second" } };
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, [first]);
    const earlier = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, earlier, earlier);
    const before = statSync(path);

    await repository.saveSession(sessionId, [first]);

    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(await repository.appendSessionProgress(sessionId, [first, second])).toBe("appended");
    expect(repository.loadSession(sessionId)).toEqual([first, second]);
  });

  it("rewrites changed bytes even when the transcript size is unchanged", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "before" };
    const changed = { ...first, content: "after!" };
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, [first]);
    const earlier = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, earlier, earlier);
    const before = statSync(path);

    await repository.saveSession(sessionId, [changed]);

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(changed)}\n`);
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBeGreaterThan(before.mtimeMs);
  });

  it("replaces invalid on-disk bytes rather than comparing decoded text", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const messages = [{ role: "user", content: "\uFFFD" }];
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, messages);
    const expected = readFileSync(path);
    writeFileSync(path, Buffer.concat([
      Buffer.from('{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
    ]));

    await repository.saveSession(sessionId, messages);

    expect(readFileSync(path)).toEqual(expected);
  });

  it("round trips transcript progress and metadata through disk, lists and deletes the session", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "Remember this conversation", meta: { messageId: "row-first" } };
    const second = { role: "assistant", content: "Conversation saved", meta: { messageId: "row-second" } };
    await repository.saveSession(sessionId, [first]);
    await repository.appendSessionProgress(sessionId, [first, second]);
    await repository.saveSessionMetadata(sessionId, { sessionKind: "main", title: "Saved conversation" });

    expect(readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf-8"))
      .toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const reopened = new SessionRepository({ aveDir: dir });
    expect(reopened.loadSession(sessionId)).toEqual([first, second]);
    expect(reopened.loadSessionMetadata(sessionId)).toMatchObject({ sessionKind: "main", title: "Saved conversation" });
    expect(reopened.listSessions()).toMatchObject([{ id: sessionId, title: "Saved conversation" }]);

    await reopened.deleteSession(sessionId);
    expect(repository.loadSession(sessionId)).toBeNull();
    expect(repository.loadSessionMetadata(sessionId)).toBeNull();
    expect(repository.listSessions()).toEqual([]);
    reopened.closeSearchIndex();
  });
});
