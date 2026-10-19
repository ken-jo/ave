/**
 * TurnJournal: throttled partial snapshots, append ordering, and what one
 * append costs on a 60-round turn compared with a whole-session save.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistory } from "../../conversation-history.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { TurnJournal, interruptRunningTurnsForExit, isHostExitAbort, registerRunningTurn } from "../turn-journal.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "7a7a7a7a-1111-2222-3333-444444444444";

function fakeStore() {
  return {
    appendSessionProgress: vi.fn(async () => "appended" as const),
    beginTurnJournal: vi.fn(),
    writeTurnPartial: vi.fn(),
    endTurnJournal: vi.fn(),
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
