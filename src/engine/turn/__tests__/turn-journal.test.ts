import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistory } from "../../conversation-history.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { turnInflightPath } from "../../../memory/session-turn-journal.js";
import { TurnJournal, interruptRunningTurnsForExit, isHostExitAbort, registerRunningTurn } from "../turn-journal.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const SESSION = "7a7a7a7a-1111-2222-3333-444444444444";

function fakeStore() {
  return {
    sessions: {
      appendSessionProgress: vi.fn(async () => "appended" as const),
      beginTurnJournal: vi.fn(async () => undefined),
      writeTurnPartial: vi.fn(async (_session: string, _startedAt: number, _partial: unknown) => undefined),
      endTurnJournal: vi.fn(),
      clearTurnJournal: vi.fn(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnJournal partial snapshots", () => {
  it("writes at most one snapshot per interval however many deltas arrive, rendering only when it writes", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const store = fakeStore();
    const journal = new TurnJournal(store as never, SESSION, new ConversationHistory(), { partialIntervalMs: 1_000, now: () => now });
    await journal.begin();
    let text = "";
    const render = vi.fn(() => ({ content: text }));

    for (let i = 0; i < 300; i += 1) {
      text += "x";
      journal.notePartial(render);
      now += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(store.sessions.writeTurnPartial.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(store.sessions.writeTurnPartial.mock.calls.length).toBeLessThanOrEqual(4);
    expect(render.mock.calls.length).toBe(store.sessions.writeTurnPartial.mock.calls.length);
    // Throttled recovery may lose at most one snapshot interval of text.
    const last = store.sessions.writeTurnPartial.mock.calls.at(-1)![2] as { content: string };
    expect(text.length - last.content.length).toBeLessThanOrEqual(100);
  });

  it("files every snapshot of a round under the id its committed row will carry", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const history = new ConversationHistory();
    const journal = new TurnJournal(store as never, SESSION, history, { partialIntervalMs: 1 });
    await journal.begin();
    journal.notePartial(() => ({ content: "a" }));
    await vi.advanceTimersByTimeAsync(5);
    const roundId = journal.currentRoundRowId();
    expect((store.sessions.writeTurnPartial.mock.calls[0][2] as { messageId: string }).messageId).toBe(roundId);
    history.append({ role: "assistant", content: "a", meta: { messageId: roundId } });
    expect(journal.currentRoundRowId()).not.toBe(roundId);
  });

  it("clears a superseded snapshot only after the row replacing it was appended", async () => {
    const order: string[] = [];
    const store = {
      sessions: {
        appendSessionProgress: vi.fn(async () => { order.push("append"); return "appended" as const; }),
        beginTurnJournal: vi.fn(),
        writeTurnPartial: vi.fn((_s: string, _t: number, partial: unknown) => { order.push(partial ? "snapshot" : "clear"); }),
        endTurnJournal: vi.fn(),
        clearTurnJournal: vi.fn(),
      },
    };
    const history = new ConversationHistory();
    const journal = new TurnJournal(store as never, SESSION, history, { partialIntervalMs: 0 });
    await journal.begin();
    journal.notePartial(() => ({ content: "부분" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    history.append({ role: "assistant", content: "오류", meta: { systemNotice: "stream-error" } });
    await journal.settled();
    expect(order).toEqual(["snapshot", "append", "clear"]);
    await journal.end();
    expect(store.sessions.endTurnJournal).toHaveBeenCalledWith(SESSION);
  });

  it("retains a partial when the replacing row and final transcript sync both fail", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.sessions.appendSessionProgress.mockRejectedValue(Object.assign(new Error("write denied"), { code: "EACCES" }));
    const history = new ConversationHistory();
    const journal = new TurnJournal(store, SESSION, history, { partialIntervalMs: 0 });
    await journal.begin();
    journal.notePartial(() => ({ content: "saved partial" }));
    await vi.advanceTimersByTimeAsync(1);
    history.append({ role: "assistant", content: "stream failed", meta: { systemNotice: "stream-error" } });
    await journal.end();
    expect(store.sessions.writeTurnPartial).toHaveBeenCalledTimes(1);
    expect(store.sessions.writeTurnPartial.mock.calls[0][2]).toMatchObject({ content: "saved partial" });
    expect(store.sessions.endTurnJournal).toHaveBeenCalledWith(SESSION);
    expect(store.sessions.clearTurnJournal).not.toHaveBeenCalled();
  });

  it("removes the recovery sidecar only after the final transcript sync succeeds", async () => {
    const store = fakeStore();
    const history = new ConversationHistory();
    const journal = new TurnJournal(store, SESSION, history);
    await journal.begin();
    history.append({ role: "assistant", content: "complete" });
    await journal.end();
    expect(store.sessions.clearTurnJournal).toHaveBeenCalledWith(SESSION);
    expect(store.sessions.appendSessionProgress.mock.invocationCallOrder.at(-1)).toBeLessThan(store.sessions.endTurnJournal.mock.invocationCallOrder[0]);
    expect(store.sessions.endTurnJournal.mock.invocationCallOrder[0]).toBeLessThan(store.sessions.clearTurnJournal.mock.invocationCallOrder[0]);
  });
});

describe("running turns on quit", () => {
  it("aborts each running turn with a host-exit reason and reports when they settled", async () => {
    const reasons: unknown[] = [];
    const a = registerRunningTurn((reason) => { reasons.push(reason); setTimeout(() => a.settle(), 5); });
    const b = registerRunningTurn((reason) => { reasons.push(reason); b.settle(); });
    await expect(interruptRunningTurnsForExit(1_000)).resolves.toEqual({ turns: 2, settled: true });
    expect(reasons.every(isHostExitAbort)).toBe(true);
  });

  it("gives up at the deadline rather than holding the quit", async () => {
    vi.useFakeTimers();
    const stuck = registerRunningTurn(() => undefined);
    try {
      const quit = interruptRunningTurnsForExit(50);
      const settled = vi.fn();
      void quit.then(settled);
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(quit).resolves.toEqual({ turns: 1, settled: false });
    } finally {
      stuck.settle();
    }
  });
});

describe("append cost on a 60-round turn", () => {
  it("appends only new rows and writes one durable sidecar per snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-journal-cost-"));
    const mm = new MemoryManager({ aveDir: dir });
    const history = new ConversationHistory();
    const sessionsDir = join(dir, "sessions");
    const transcript = join(sessionsDir, `${SESSION}.jsonl`);
    const snapshot = turnInflightPath(sessionsDir, SESSION);
    const actualAsync = await vi.importActual<typeof fsPromises>("node:fs/promises");
    const open = vi.mocked(fsPromises.open);
    const rename = vi.mocked(fsPromises.rename);
    const syncFsync = vi.mocked(fs.fsyncSync);
    const syncWrite = vi.mocked(fs.writeFileSync);
    const appendBytes: number[] = [];
    const snapshotBytes: number[] = [];
    let appendSyncs = 0;
    let snapshotSyncs = 0;
    let snapshotDirectorySyncs = 0;

    try {
      for (let i = 0; i < 200; i += 1) {
        history.append({ role: i % 2 === 0 ? "user" : "assistant", content: `prior ${i} ${"y".repeat(2_000)}` });
      }
      history.append({ role: "user", content: "60 라운드 작업" });
      await mm.sessions.saveSession(SESSION, history.getMessages());
      const initial = readFileSync(transcript);
      syncFsync.mockClear();
      syncWrite.mockClear();
      rename.mockClear();
      open.mockImplementation(async (...args) => {
        const handle = await actualAsync.open(...args);
        const [path, flags] = args;
        if (path === transcript) {
          const append = handle.appendFile.bind(handle);
          handle.appendFile = async (data, options) => {
            if (typeof data !== "string") throw new TypeError("Expected transcript text");
            await append(data, options);
            appendBytes.push(Buffer.byteLength(data));
          };
          const datasync = handle.datasync.bind(handle);
          handle.datasync = async () => {
            await datasync();
            appendSyncs++;
          };
        } else if (path === dirname(snapshot) && flags === "r") {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            snapshotDirectorySyncs++;
          };
        } else if (typeof path === "string" && dirname(path) === dirname(snapshot) && flags === "wx") {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (data, options) => {
            if (typeof data !== "string") throw new TypeError("Expected snapshot text");
            await write(data, options);
            snapshotBytes.push(Buffer.byteLength(data));
          };
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            snapshotSyncs++;
          };
        }
        return handle;
      });

      const outcomes = [];
      const expectedRows = [];
      for (let round = 0; round < 60; round += 1) {
        const assistant = history.append({
          role: "assistant",
          content: `round ${round} ${"z".repeat(1_500)}`,
          toolCalls: [{ id: `call-${round}`, name: "bash", input: { command: "ls" } }],
        });
        const result = history.append({ role: "tool_result", toolUseId: `call-${round}`, toolName: "bash", content: "o".repeat(4_000) });
        expectedRows.push(assistant, result);
        outcomes.push(await mm.sessions.appendSessionProgress(SESSION, history.getMessages()));
      }
      const partialContent = "w".repeat(20_000);
      for (let i = 0; i < 20; i += 1) {
        await mm.sessions.writeTurnPartial(SESSION, 1, { messageId: "p", content: partialContent, updatedAt: i });
      }

      expect(outcomes).toEqual(Array(60).fill("appended"));
      expect(appendBytes).toHaveLength(60);
      expect(appendSyncs).toBe(60);
      expect(snapshotBytes).toHaveLength(20);
      expect(snapshotSyncs).toBe(20);
      expect(snapshotDirectorySyncs).toBe(process.platform === "win32" ? 0 : 20);
      expect(rename.mock.calls.map(([, destination]) => destination)).toEqual(Array(20).fill(snapshot));
      expect(syncWrite).not.toHaveBeenCalled();
      expect(syncFsync).not.toHaveBeenCalled();

      const current = readFileSync(transcript);
      expect(current.subarray(0, initial.length)).toEqual(initial);
      const added = current.subarray(initial.length).toString("utf8").trimEnd().split("\n");
      expect(added).toHaveLength(expectedRows.length);
      for (const [index, row] of added.entries()) {
        const expected = expectedRows[index];
        expect(JSON.parse(row)).toMatchObject({
          role: expected.role,
          content: expected.content,
          meta: { messageId: expected.meta.messageId },
        });
        expect(Buffer.byteLength(row) + 1).toBeLessThanOrEqual(Buffer.byteLength(String(expected.content)) + 512);
      }
      expect(appendBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(current.length - initial.length);
      for (const bytes of snapshotBytes) {
        expect(bytes).toBeLessThanOrEqual(Buffer.byteLength(partialContent) + 256);
      }

      expect(mm.sessions.loadSession(SESSION)?.at(-1)).toMatchObject({
        content: partialContent,
        meta: { interrupted: true, interruptedBy: "host-exit" },
      });
      await mm.sessions.saveSession(SESSION, history.getMessages());
      expect(new Set((mm.sessions.loadSession(SESSION) as Array<{ meta: { messageId: string } }>).map((m) => m.meta.messageId)).size)
        .toBe(history.length);
    } finally {
      open.mockRestore();
      await cleanupTmpDir(dir);
    }
  });
});

describe("parallel result append cost", () => {
  it("propagates transcript durability failures instead of reporting a successful append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-result-durability-"));
    const mm = new MemoryManager({ aveDir: dir });
    const history = new ConversationHistory();
    const failure = Object.assign(new Error("transcript durability failed"), { code: "EIO" });
    const actualAsync = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const open = vi.mocked(fsPromises.open);
    const datasync = vi.fn(async () => { throw failure; });
    try {
      history.append({ role: "user", content: "persist this turn" });
      await mm.sessions.saveSession(SESSION, history.getMessages());
      const path = join(dir, "sessions", SESSION + ".jsonl");
      open.mockImplementation(async (...args) => {
        const handle = await actualAsync.open(...args);
        if (args[0] === path) handle.datasync = datasync;
        return handle;
      });
      history.append({ role: "assistant", content: "new progress" });
      await expect(mm.sessions.appendSessionProgress(SESSION, history.getMessages())).rejects.toBe(failure);
      expect(datasync).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      await cleanupTmpDir(dir);
    }
  });

  it("keeps both completion orders within the new-result byte budget with no synchronous writes", async () => {
    const measure = async (reversed: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "ave-result-order-"));
      const mm = new MemoryManager({ aveDir: dir });
      const history = new ConversationHistory();
      for (let i = 0; i < 200; i++) {
        history.append({ role: i % 2 === 0 ? "user" : "assistant", content: "p".repeat(2_000) });
      }
      history.append({ role: "user", content: "six parallel calls" });
      const calls = Array.from({ length: 6 }, (_, i) => ({ id: "call-" + i, name: "read_file", input: {} }));
      history.append({ role: "assistant", content: "", toolCalls: calls });
      await mm.sessions.saveSession(SESSION, history.getMessages());
      const journal = new TurnJournal(mm, SESSION, history);
      await journal.begin();
      const path = join(dir, "sessions", SESSION + ".jsonl");
      const initial = readFileSync(path);
      let previous = initial;
      let priorContentReads = 0;
      // Row IDs may be read, but already-persisted content must not be reprocessed.
      const restoreContents: Array<() => void> = [];
      const trackPersistedContent = (message: { content: unknown }) => {
        const descriptor = Object.getOwnPropertyDescriptor(message, "content")!;
        const content = message.content;
        Object.defineProperty(message, "content", {
          configurable: true,
          enumerable: true,
          get: () => { priorContentReads++; return content; },
        });
        restoreContents.push(() => { Object.defineProperty(message, "content", descriptor); });
      };
      for (const message of history.getMessages()) trackPersistedContent(message);
      const writes: Array<{ payload: Buffer; durable: boolean }> = [];
      let asyncSyncs = 0;
      const actualAsync = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const open = vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
        const handle = await actualAsync.open(...args);
        if (args[0] !== path) return handle;
        const appendFile = handle.appendFile.bind(handle);
        const datasync = handle.datasync.bind(handle);
        const pending: typeof writes = [];
        handle.appendFile = async (...appendArgs) => {
          const [data, options] = appendArgs;
          const encoding = typeof options === "string" ? options : options?.encoding;
          if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
            throw new TypeError("Expected transcript text or bytes");
          }
          const payload = typeof data === "string"
            ? Buffer.from(data, encoding ?? "utf8")
            : Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          await appendFile(...appendArgs);
          const write = { payload, durable: false };
          writes.push(write);
          pending.push(write);
        };
        handle.datasync = async () => {
          await datasync();
          asyncSyncs++;
          for (const write of pending) write.durable = true;
        };
        return handle;
      });
      const progress = vi.spyOn(mm.sessions, "appendSessionProgress");
      let syncFsyncMs = 0;
      const { fsyncSync: fsync } = await vi.importActual<typeof import("node:fs")>("node:fs");
      const syncFsync = vi.mocked(fs.fsyncSync).mockClear().mockImplementation((fd) => {
        const start = performance.now();
        try { return fsync(fd); } finally { syncFsyncMs += performance.now() - start; }
      });
      const syncWrite = vi.mocked(fs.writeFileSync).mockClear();
      const delay = monitorEventLoopDelay({ resolution: 1 });
      delay.enable();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = performance.now();
      try {
        const completionOrder = reversed ? [...calls].reverse() : calls;
        for (const [index, call] of completionOrder.entries()) {
          const content = call.id + ":" + "r".repeat(512);
          const result = history.appendToolResult({ role: "tool_result", toolUseId: call.id, content });
          await journal.settled();
          const current = readFileSync(path);
          expect(current.subarray(0, previous.length).equals(previous)).toBe(true);
          const added = current.subarray(previous.length);
          expect(JSON.parse(added.toString("utf8"))).toMatchObject({
            role: "tool_result", toolUseId: call.id, content,
            meta: { messageId: result.meta.messageId },
          });
          expect(writes).toHaveLength(index + 1);
          expect(writes[index].payload.equals(added)).toBe(true);
          expect(writes[index].durable).toBe(true);
          expect(asyncSyncs).toBe(index + 1);
          previous = current;
          trackPersistedContent(result);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        delay.disable();
        const outcomes = await Promise.all(progress.mock.results.map((result) => result.value));
        expect(outcomes).toEqual(calls.map(() => "appended"));
        const metrics = {
          historyBytes: initial.length,
          appends: writes.length,
          writtenBytes: writes.reduce((total, write) => total + write.payload.length, 0),
          newResultBytes: previous.length - initial.length,
          asyncSyncs,
          priorContentReads,
          rewrites: outcomes.filter((outcome) => outcome === "rewritten").length,
          syncFsyncs: syncFsync.mock.calls.length,
          syncWrites: syncWrite.mock.calls.length,
          syncFsyncMs,
          maxDelayMs: delay.max / 1e6,
          elapsedMs: performance.now() - started,
        };
        process.stderr.write("[result-order bench] " + JSON.stringify({ order: reversed ? "reverse" : "forward", ...metrics }) + "\n");
        syncFsync.mockRestore();
        syncWrite.mockRestore();
        open.mockRestore();
        progress.mockRestore();
        for (const restore of restoreContents) restore();
        const expected = calls.map((call) => call.id);
        const raw = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(raw.filter((row) => row.role === "tool_result").map((row) => row.toolUseId))
          .toEqual((reversed ? [...calls].reverse() : calls).map((call) => call.id));
        // Live readers see call order before final rewrite normalizes the file.
        expect((mm.sessions.loadSession(SESSION) as Array<{ role: string; toolUseId?: string }>).filter((row) => row.role === "tool_result").map((row) => row.toolUseId)).toEqual(expected);
        await mm.sessions.saveSession(SESSION, history.getMessages());
        const saved = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(saved.filter((row) => row.role === "tool_result").map((row) => row.toolUseId)).toEqual(expected);
        return metrics;
      } finally {
        delay.disable();
        syncFsync.mockRestore();
        syncWrite.mockRestore();
        open.mockRestore();
        progress.mockRestore();
        for (const restore of restoreContents) restore();
        await journal.end();
        await cleanupTmpDir(dir);
      }
    };
    const forward: Awaited<ReturnType<typeof measure>>[] = [];
    const reverse: Awaited<ReturnType<typeof measure>>[] = [];
    for (let trial = 0; trial < 3; trial++) {
      forward.push(await measure(false));
      reverse.push(await measure(true));
    }
    for (const sample of [...forward, ...reverse]) {
      expect(sample.rewrites).toBe(0);
      expect(sample.syncFsyncs).toBe(0);
      expect(sample.syncWrites).toBe(0);
      expect(sample.appends).toBe(6);
      expect(sample.asyncSyncs).toBe(6);
      expect(sample.writtenBytes).toBe(sample.newResultBytes);
      expect(sample.priorContentReads).toBe(0);
    }
    // Timing is diagnostic; gate actual byte work, async durability, and synchronous I/O counts.
  });
});
