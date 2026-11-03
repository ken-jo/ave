import { describe, expect, it, vi } from "vitest";
import { runShutdownRoutines } from "../shutdown-routines.js";
import type { RoutineRecord } from "../../shared/routines-types.js";

function routine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "shutdown-llm",
    trigger: "shutdown",
    execution: "llm-session",
    prePrompt: "정리",
    title: "종료 정리",
    createdAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("runShutdownRoutines", () => {
  it("persists the llm-session routine id after markFired clears stale ids", async () => {
    const calls: string[] = [];
    const record = routine();
    const routinesStore = {
      listActive: vi.fn(() => [record]),
      markFired: vi.fn(async (id: string) => {
        calls.push(`markFired:${id}`);
        return { ...record, lastFiredAt: "2026-05-16T01:00:00.000Z" };
      }),
      update: vi.fn(async (id: string, patch: Partial<Pick<RoutineRecord, "lastRoutineSessionId">>) => {
        calls.push(`update:${id}:${patch.lastRoutineSessionId}`);
        return { ...record, ...patch };
      }),
      recordRunOutcome: vi.fn(async (id: string, firedAt: string, outcome: { ok: boolean }) => {
        calls.push(`outcome:${id}:${firedAt}:${outcome.ok}`);
        return record;
      }),
    };
    const routineEngine = {
      runRoutine: vi.fn(async () => {
        calls.push("runRoutine");
        return {
          routineId: record.id,
          trigger: "shutdown" as const,
          summary: "done",
          generatedAt: "2026-05-16T01:00:00.000Z",
          sessionId: "routine-session-2",
        };
      }),
    };

    await runShutdownRoutines({ routinesStore, routineEngine });

    expect(routineEngine.runRoutine).toHaveBeenCalledWith(expect.objectContaining({
      id: "shutdown-llm",
      trigger: "shutdown",
      prePrompt: "정리",
      title: "종료 정리",
      signal: expect.any(AbortSignal),
    }));
    expect(calls).toEqual([
      "runRoutine",
      "markFired:shutdown-llm",
      "update:shutdown-llm:routine-session-2",
      "outcome:shutdown-llm:2026-05-16T01:00:00.000Z:true",
    ]);
    expect(routinesStore.update).toHaveBeenCalledWith("shutdown-llm", {
      lastRoutineSessionId: "routine-session-2",
    });
  });

  function failingStore(record: RoutineRecord) {
    return {
      listActive: vi.fn(() => [record]),
      markFired: vi.fn(async () => ({ ...record, lastFiredAt: "2026-05-16T01:00:00.000Z" })),
      update: vi.fn(async () => record),
      recordRunOutcome: vi.fn(async () => record),
    };
  }

  it("persists a thrown run as a failure of that fire, so the next launch can show it", async () => {
    const record = routine();
    const routinesStore = failingStore(record);
    const routineEngine = { runRoutine: vi.fn(async () => { throw new Error("provider down"); }) };

    await runShutdownRoutines({ routinesStore, routineEngine });

    expect(routinesStore.markFired).toHaveBeenCalledWith("shutdown-llm");
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith(
      "shutdown-llm",
      "2026-05-16T01:00:00.000Z",
      { ok: false, reason: "provider down" },
    );
    expect(routinesStore.update).not.toHaveBeenCalled();
  });

  it("persists a run cut off by the shutdown timeout as a failure", async () => {
    const record = routine();
    const routinesStore = failingStore(record);
    const routineEngine = {
      runRoutine: vi.fn((input: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
    };

    await runShutdownRoutines({ routinesStore, routineEngine }, 5);

    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith(
      "shutdown-llm",
      "2026-05-16T01:00:00.000Z",
      { ok: false, reason: "shutdown timeout" },
    );
  });

  it("records no run outcome for a notification-only shutdown routine", async () => {
    const record = routine({ execution: "notification-only", notificationTitle: "bye" });
    const routinesStore = failingStore(record);
    const routineEngine = { runRoutine: vi.fn() };

    await runShutdownRoutines({ routinesStore, routineEngine, notificationService: { fire: vi.fn() } });

    expect(routinesStore.recordRunOutcome).not.toHaveBeenCalled();
  });
});
