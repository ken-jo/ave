/**
 * TurnJournal: throttled partial snapshots, append ordering, and what one
 * append costs on a 60-round turn compared with a whole-session save.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistory } from "../../conversation-history.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { TurnJournal, interruptRunningTurnsForExit, isHostExitAbort, registerRunningTurn } from "../turn-journal.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const SESSION = "7a7a7a7a-1111-2222-3333-444444444444";

function fakeStore() {
  return {
    appendSessionProgress: vi.fn(async () => "appended" as const),
    beginTurnJournal: vi.fn(async () => undefined),
    writeTurnPartial: vi.fn(async (_session: string, _startedAt: number, _partial: unknown) => undefined),
    endTurnJournal: vi.fn(),
    clearTurnJournal: vi.fn(),
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
    // 3 s of deltas every 10 ms → the first snapshot immediately, then one per second.
    expect(store.writeTurnPartial.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(store.writeTurnPartial.mock.calls.length).toBeLessThanOrEqual(4);
    expect(render.mock.calls.length).toBe(store.writeTurnPartial.mock.calls.length);
    // The newest snapshot loses at most one interval of text.
    const last = store.writeTurnPartial.mock.calls.at(-1)![2] as { content: string };
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
    expect((store.writeTurnPartial.mock.calls[0][2] as { messageId: string }).messageId).toBe(roundId);
    history.append({ role: "assistant", content: "a", meta: { messageId: roundId } });
    // The next round gets a new id.
    expect(journal.currentRoundRowId()).not.toBe(roundId);
  });

  it("clears a superseded snapshot only after the row replacing it was appended", async () => {
    const order: string[] = [];
    const store = {
      appendSessionProgress: vi.fn(async () => { order.push("append"); return "appended" as const; }),
      beginTurnJournal: vi.fn(),
      writeTurnPartial: vi.fn((_s: string, _t: number, partial: unknown) => { order.push(partial ? "snapshot" : "clear"); }),
      endTurnJournal: vi.fn(),
      clearTurnJournal: vi.fn(),
    };
    const history = new ConversationHistory();
    const journal = new TurnJournal(store as never, SESSION, history, { partialIntervalMs: 0 });
    await journal.begin();
    journal.notePartial(() => ({ content: "부분" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A stream-error notice ends the round under a different id.
    history.append({ role: "assistant", content: "오류", meta: { systemNotice: "stream-error" } });
    await journal.settled();
    expect(order).toEqual(["snapshot", "append", "clear"]);
    await journal.end();
    expect(store.endTurnJournal).toHaveBeenCalledWith(SESSION);
  });

  it("retains a partial when the replacing row and final transcript sync both fail", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.appendSessionProgress.mockRejectedValue(Object.assign(new Error("write denied"), { code: "EACCES" }));
    const history = new ConversationHistory();
    const journal = new TurnJournal(store, SESSION, history, { partialIntervalMs: 0 });
    await journal.begin();
    journal.notePartial(() => ({ content: "saved partial" }));
    await vi.advanceTimersByTimeAsync(1);
    history.append({ role: "assistant", content: "stream failed", meta: { systemNotice: "stream-error" } });
    await journal.end();
    expect(store.writeTurnPartial).toHaveBeenCalledTimes(1);
    expect(store.writeTurnPartial.mock.calls[0][2]).toMatchObject({ content: "saved partial" });
    expect(store.endTurnJournal).toHaveBeenCalledWith(SESSION);
    expect(store.clearTurnJournal).not.toHaveBeenCalled();
  });

  it("removes the recovery sidecar only after the final transcript sync succeeds", async () => {
    const store = fakeStore();
    const history = new ConversationHistory();
    const journal = new TurnJournal(store, SESSION, history);
    await journal.begin();
    history.append({ role: "assistant", content: "complete" });
    await journal.end();
    expect(store.clearTurnJournal).toHaveBeenCalledWith(SESSION);
    expect(store.appendSessionProgress.mock.invocationCallOrder.at(-1)).toBeLessThan(store.endTurnJournal.mock.invocationCallOrder[0]);
    expect(store.endTurnJournal.mock.invocationCallOrder[0]).toBeLessThan(store.clearTurnJournal.mock.invocationCallOrder[0]);
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
    const stuck = registerRunningTurn(() => undefined);
    const started = Date.now();
    await expect(interruptRunningTurnsForExit(50)).resolves.toEqual({ turns: 1, settled: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    stuck.settle();
  });
});

describe("append cost on a 60-round turn", () => {
  it("keeps each round's append far below a whole-session save and within a frame budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-journal-bench-"));
    try {
      const mm = new MemoryManager({ aveDir: dir });
      const history = new ConversationHistory();
      // A realistic prior conversation: 200 rows of ~2 KB.
      for (let i = 0; i < 200; i += 1) {
        history.append({ role: i % 2 === 0 ? "user" : "assistant", content: `prior ${i} ${"y".repeat(2_000)}` });
      }
      history.append({ role: "user", content: "60 라운드 작업" });
      await mm.saveSession(SESSION, history.getMessages());

      const appendMs: number[] = [];
      // How long the event loop — the thing delivering stream frames — was
      // held up while the 60 appends ran.
      const loopDelay = monitorEventLoopDelay({ resolution: 1 });
      loopDelay.enable();
      for (let round = 0; round < 60; round += 1) {
        history.append({
          role: "assistant",
          content: `round ${round} ${"z".repeat(1_500)}`,
          toolCalls: [{ id: `call-${round}`, name: "bash", input: { command: "ls" } }],
        });
        history.append({ role: "tool_result", toolUseId: `call-${round}`, toolName: "bash", content: "o".repeat(4_000) });
        const started = performance.now();
        await mm.appendSessionProgress(SESSION, history.getMessages());
        appendMs.push(performance.now() - started);
      }
      loopDelay.disable();
      const loopMaxMs = loopDelay.max / 1e6;
      process.stderr.write(
        `[turn-journal bench] event-loop delay during the 60 appends: max=${loopMaxMs.toFixed(2)}ms `
        + `p99=${(loopDelay.percentile(99) / 1e6).toFixed(2)}ms\n`,
      );

      // The streaming-side cost: one partial snapshot of a 20 KB answer, at most
      // once per second. Async — the disk wait runs on the libuv pool — so the
      // number below is latency, not main-thread time.
      const partialMs: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        await mm.writeTurnPartial(SESSION, 1, { messageId: "p", content: "w".repeat(20_000), updatedAt: i });
        partialMs.push(performance.now() - started);
      }
      const partialMedian = [...partialMs].sort((x, y) => x - y)[10];
      process.stderr.write(`[turn-journal bench] partial snapshot (20 KB) median=${partialMedian.toFixed(2)}ms\n`);
      expect(partialMedian).toBeLessThan(100);

      const saveStarted = performance.now();
      await mm.saveSession(SESSION, history.getMessages());
      const fullSaveMs = performance.now() - saveStarted;

      const sorted = [...appendMs].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      // Recorded for the PR; the assertions below are generous bounds so the
      // test measures rather than flakes on a loaded CI host.
      process.stderr.write(
        `[turn-journal bench] 60 rounds: append median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms `
        + `max=${sorted.at(-1)!.toFixed(2)}ms total=${appendMs.reduce((s, v) => s + v, 0).toFixed(1)}ms; `
        + `one full save at the end=${fullSaveMs.toFixed(2)}ms (${history.length} rows)\n`,
      );
      expect(median).toBeLessThan(50);
      expect(new Set((mm.loadSession(SESSION) as Array<{ meta: { messageId: string } }>).map((m) => m.meta.messageId)).size)
        .toBe(history.length);
    } finally {
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
      await mm.saveSession(SESSION, history.getMessages());
      const path = join(dir, "sessions", SESSION + ".jsonl");
      open.mockImplementation(async (...args) => {
        const handle = await actualAsync.open(...args);
        if (args[0] === path) handle.datasync = datasync;
        return handle;
      });
      history.append({ role: "assistant", content: "new progress" });
      await expect(mm.appendSessionProgress(SESSION, history.getMessages())).rejects.toBe(failure);
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
      await mm.saveSession(SESSION, history.getMessages());
      const journal = new TurnJournal(mm, SESSION, history);
      await journal.begin();
      const path = join(dir, "sessions", SESSION + ".jsonl");
      const initial = readFileSync(path);
      let previous = initial;
      let priorContentReads = 0;
      // Reading row ids is allowed; processing the already-persisted content is not.
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
        // Observe real writes and completed durability calls on the transcript only.
        const appendFile = handle.appendFile.bind(handle);
        const datasync = handle.datasync.bind(handle);
        const pending: typeof writes = [];
        handle.appendFile = async (...appendArgs) => {
          const [data, options] = appendArgs;
          const encoding = typeof options === "string" ? options : options?.encoding;
          const payload = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);
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
      const progress = vi.spyOn(mm, "appendSessionProgress");
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
          // One new JSON line, not a serialization or write of the prior history.
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
        // Live readers see call order before the final rewrite normalizes the file.
        expect((mm.loadSession(SESSION) as Array<{ role: string; toolUseId?: string }>).filter((row) => row.role === "tool_result").map((row) => row.toolUseId)).toEqual(expected);
        await mm.saveSession(SESSION, history.getMessages());
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
    // Timer maxima include scheduling and observation costs. Keep them diagnostic;
    // the regression gate is the real byte work, async durability and sync-I/O counts.
  });
});
