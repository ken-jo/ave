import { describe, it, expect, vi, beforeEach } from "vitest";
import { ROUTINES } from "../../../shared/ipc-channels.js";
import { hostFrameEvent } from "../../../__tests__/test-helpers.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const endSessionScopedPermissions = vi.fn();
vi.mock("../../../permissions/session-scope-end.js", () => ({ endSessionScopedPermissions }));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

function makeDeps(
  sessions: Array<{ id: string; modifiedAt?: Date; sessionKind?: string; routineId?: string; routineTitle?: string; routineFiredAt?: string; title?: string; preview: string }>,
  lastRoutineSessionId?: string,
) {
  return {
    routinesStore: {
      list: vi.fn(() => [
        {
          id: "routine-a",
          trigger: "schedule",
          execution: "llm-session",
          title: "Routine A",
          lastFiredAt: "2026-05-16T12:00:00.000Z",
          lastResultAcknowledgedAt: "2026-05-15T12:00:00.000Z",
          ...(lastRoutineSessionId ? { lastRoutineSessionId } : {}),
        },
      ]),
      listActive: vi.fn(() => []),
      listForDisplay: vi.fn(() => ({
        routines: [],
        invalid: [{ id: "legacy", field: "scope.forcedPluginIds", value: "a_b", reason: "invalid-plugin-id" }],
      })),
      update: vi.fn(),
      acknowledgeResult: vi.fn(async (id: string) => (id === "routine-a" ? { id } : null)),
      acknowledgeFailure: vi.fn(async (id: string, firedAt: string) =>
        id !== "routine-a" ? "not-found" : firedAt === "2026-05-16T12:00:00.000Z" ? "acknowledged" : "stale"),
      dismiss: vi.fn(),
      remove: vi.fn(),
      add: vi.fn(),
    },
    routinesScheduler: null,
    sessionTasksStore: null,
    conversationLoop: { getSessionId: vi.fn(() => "main-session") },
    memoryManager: {
      // Fixtures need complete stored-row fields because the handler uses the shared row assembler.
      listSessionsByRoutine: vi.fn(() => sessions.map((session) => ({
        modifiedAt: new Date("2026-05-16T12:00:00.000Z"),
        sessionKind: "routine",
        title: "",
        ...session,
      }))),
      deleteSession: vi.fn(async () => undefined),
      touchSessionTranscript: vi.fn(),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  };
}

async function setup(
  sessions: Array<{ id: string; modifiedAt?: Date; sessionKind?: string; routineId?: string; routineTitle?: string; routineFiredAt?: string; title?: string; preview: string }>,
  lastRoutineSessionId?: string,
) {
  handlers.clear();
  const { registerRoutineHandlers } = await import("../routines.js");
  const deps = makeDeps(sessions, lastRoutineSessionId);
  registerRoutineHandlers(deps as any);
  return deps;
}

async function invoke(channel: string, ...args: unknown[]) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return await fn(hostFrameEvent(), ...args);
}

describe("routine list", () => {
  it("returns the active routines with the held-back invalid ones", async () => {
    await setup([]);
    await expect(invoke(ROUTINES.list)).resolves.toEqual({
      routines: [],
      invalid: [{ id: "legacy", field: "scope.forcedPluginIds", value: "a_b", reason: "invalid-plugin-id" }],
    });
  });
});

describe("routine pending results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches only the stored exact routine session id", async () => {
    const deps = await setup([
      { id: "latest-wrong", routineFiredAt: "2026-05-16T13:00:00.000Z", preview: "wrong preview" },
      { id: "exact-session", routineFiredAt: "2026-05-16T12:00:00.000Z", preview: "exact preview" },
    ], "exact-session");

    const results = await invoke(ROUTINES.pendingResults);

    expect(results).toEqual([
      expect.objectContaining({
        id: "routine-a",
        routineSessionId: "exact-session",
        summary: "exact preview",
      }),
    ]);
    expect(deps.memoryManager.touchSessionTranscript)
      .toHaveBeenCalledWith(SUGGESTIONS_SESSION_ID, { bump: false });
  });

  it("does not fall back to the latest routine session when the stored id is missing", async () => {
    await setup([
      { id: "latest-wrong", routineFiredAt: "2026-05-16T13:00:00.000Z", preview: "wrong preview" },
    ]);

    const results = await invoke(ROUTINES.pendingResults);

    expect(results).toEqual([
      expect.not.objectContaining({
        routineSessionId: "latest-wrong",
      }),
    ]);
    expect(results[0]).not.toHaveProperty("routineSessionId");
    expect(results[0]).toHaveProperty("summary", "");
  });

  it("does not fall back to a firedAt match when the stored id points elsewhere", async () => {
    await setup([
      { id: "fired-at-match", routineFiredAt: "2026-05-16T12:00:00.000Z", preview: "fired-at preview" },
    ], "missing-session");

    const results = await invoke(ROUTINES.pendingResults);

    expect(results[0]).not.toHaveProperty("routineSessionId");
    expect(results[0]).toHaveProperty("summary", "");
  });

  it("returns routine session previews for the routine history list", async () => {
    await setup([
      {
        id: "routine-session-1",
        routineId: "routine-a",
        routineTitle: "Routine A",
        routineFiredAt: "2026-05-16T12:00:00.000Z",
        title: "뉴스 요약",
        preview: "뉴스 요약 완료",
      },
    ]);

    const results = await invoke(ROUTINES.listSessions, "routine-a", 10);

    expect(results).toEqual([
      {
        id: "routine-session-1",
        modifiedAt: "2026-05-16T12:00:00.000Z",
        title: "뉴스 요약",
        sessionKind: "routine",
        family: "routine",
        routineId: "routine-a",
        routineTitle: "Routine A",
        routineFiredAt: "2026-05-16T12:00:00.000Z",
        preview: "뉴스 요약 완료",
      },
    ]);
  });

  it("waits for every routine session deletion before reporting removal", async () => {
    const deps = await setup([
      { id: "routine-session-1", preview: "first" },
      { id: "routine-session-2", preview: "second" },
    ]);
    deps.routinesStore.remove.mockResolvedValue(true);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    deps.memoryManager.deleteSession.mockImplementation(async () => {
      await deleteGate;
    });
    let settled = false;
    const removing = invoke(ROUTINES.remove, "routine-a").then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => {
      expect(deps.memoryManager.deleteSession).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);

    releaseDelete();

    await expect(removing).resolves.toEqual({ ok: true });
    expect(deps.memoryManager.deleteSession.mock.calls).toEqual([
      ["routine-session-1"],
      ["routine-session-2"],
    ]);
    // Each deleted conversation's "This session" grants end with it (owner 2026-10-25).
    expect(endSessionScopedPermissions.mock.calls.map(([sessionId]) => sessionId)).toEqual(["routine-session-1", "routine-session-2"]);
  });
});

it("reports a manual missing-plugin skip without pretending the routine was not found", async () => {
  handlers.clear();
  const { registerRoutineHandlers } = await import("../routines.js");
  const deps = { ...makeDeps([]), routinesScheduler: { dispatchNow: vi.fn(async () => "plugins-missing") } };
  registerRoutineHandlers(deps as unknown as Parameters<typeof registerRoutineHandlers>[0]);
  expect(await invoke(ROUTINES.triggerNow, "routine-a")).toEqual({ ok: false, error: "plugins-missing" });
});

describe("routine result acknowledgement", () => {
  it("acknowledges through the store method that also marks that fire's failure seen", async () => {
    const deps = await setup([]);
    expect(await invoke(ROUTINES.acknowledgeResult, "routine-a", "2026-05-16T12:00:00.000Z")).toEqual({ ok: true });
    expect(deps.routinesStore.acknowledgeResult).toHaveBeenCalledWith("routine-a", "2026-05-16T12:00:00.000Z");
    expect(deps.routinesStore.update).not.toHaveBeenCalled();
  });

  it("reports an unknown routine", async () => {
    await setup([]);
    expect(await invoke(ROUTINES.acknowledgeResult, "missing", "2026-05-16T12:00:00.000Z")).toEqual({ ok: false, error: "routine-not-found" });
  });
});

describe("routine failure acknowledgement", () => {
  it("acknowledges the failure of that fire, and reports a stale one and an unknown routine explicitly", async () => {
    const deps = await setup([]);
    expect(await invoke(ROUTINES.acknowledgeFailure, "routine-a", "2026-05-16T12:00:00.000Z")).toEqual({ ok: true });
    expect(deps.routinesStore.acknowledgeFailure).toHaveBeenCalledWith("routine-a", "2026-05-16T12:00:00.000Z");
    expect(await invoke(ROUTINES.acknowledgeFailure, "routine-a", "2026-05-15T12:00:00.000Z")).toEqual({ ok: false, error: "routine-failure-stale" });
    expect(await invoke(ROUTINES.acknowledgeFailure, "missing", "2026-05-16T12:00:00.000Z")).toEqual({ ok: false, error: "routine-not-found" });
    expect(await invoke(ROUTINES.acknowledgeFailure, "routine-a", 7)).toEqual({ ok: false, error: "invalid-input" });
  });
});

describe("schedule panel IPC", () => {
  it("passes the project filter to the list and forces createdBy=user on add", async () => {
    const deps = await setup([]);
    await invoke(ROUTINES.list, { projectRoot: "/p/a" });
    expect(deps.routinesStore.listForDisplay).toHaveBeenCalledWith({ projectRoot: "/p/a" });
    deps.routinesStore.add.mockResolvedValueOnce({ id: "new" });
    await invoke(ROUTINES.add, { trigger: "schedule", execution: "notification-only", notificationTitle: "n", projectRoot: "/p/a", createdBy: "agent" });
    expect(deps.routinesStore.add).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/p/a", createdBy: "user" }));
  });

  it("edits, pauses and resumes through the store, reporting unknown items", async () => {
    const deps = await setup([]);
    const store = deps.routinesStore as typeof deps.routinesStore & Record<string, ReturnType<typeof vi.fn>>;
    store.edit = vi.fn(async (id: string) => (id === "routine-a" ? { id } : null));
    store.pause = vi.fn(async (id: string) => (id === "routine-a" ? { id } : null));
    store.resume = vi.fn(async (id: string) => (id === "routine-a" ? { id } : null));
    expect(await invoke(ROUTINES.update, "routine-a", { title: "t" })).toEqual({ ok: true, routine: { id: "routine-a" } });
    expect(store.edit).toHaveBeenCalledWith("routine-a", { title: "t" });
    expect(await invoke(ROUTINES.update, "missing", { title: "t" })).toEqual({ ok: false, error: "routine-not-found" });
    store.edit.mockRejectedValueOnce(new Error("bad cron"));
    expect(await invoke(ROUTINES.update, "routine-a", { schedule: {} })).toEqual({ ok: false, error: "bad cron" });
    expect(await invoke(ROUTINES.pause, "routine-a")).toEqual({ ok: true, routine: { id: "routine-a" } });
    expect(store.pause).toHaveBeenCalledWith("routine-a", "user");
    expect(await invoke(ROUTINES.resume, "missing")).toEqual({ ok: false, error: "routine-not-found" });
  });

  it("refuses a run-now of a paused item with its own error", async () => {
    handlers.clear();
    const { registerRoutineHandlers } = await import("../routines.js");
    const deps = { ...makeDeps([]), routinesScheduler: { dispatchNow: vi.fn(async () => "paused") } };
    registerRoutineHandlers(deps as unknown as Parameters<typeof registerRoutineHandlers>[0]);
    expect(await invoke(ROUTINES.triggerNow, "routine-a")).toEqual({ ok: false, error: "paused" });
  });

  it("lists occurrences and past runs inside a bounded range", async () => {
    const deps = await setup([
      { id: "s1", routineId: "routine-w", routineFiredAt: "2026-11-03T00:00:00.000Z", preview: "" },
      { id: "s0", routineId: "routine-w", routineFiredAt: "2026-10-01T00:00:00.000Z", preview: "" },
    ]);
    const weekly = {
        id: "routine-w", trigger: "schedule", execution: "llm-session", prePrompt: "p", createdAt: "2026-10-01T00:00:00.000Z",
        schedule: { at: "2026-11-05T00:00:00.000Z", repeat: { kind: "weekly" } }, lastFiredAt: "2026-11-03T00:00:00.000Z",
        lastFailure: { kind: "error", reason: "429", firedAt: "2026-11-03T00:00:00.000Z", at: "2026-11-03T00:01:00.000Z" },
      };
    (deps.routinesStore.listForDisplay as ReturnType<typeof vi.fn>).mockReturnValue({ routines: [weekly], invalid: [] });
    (deps.routinesStore.list as ReturnType<typeof vi.fn>).mockReturnValue([weekly]);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-04T02:20:00.000Z"));
    const result = await invoke(ROUTINES.listOccurrences, { projectRoot: "/p/a", from: "2026-11-02T00:00:00.000Z", to: "2026-11-09T00:00:00.000Z" });
    now.mockRestore();
    expect(deps.routinesStore.listForDisplay).toHaveBeenCalledWith({ projectRoot: "/p/a" });
    expect(result).toEqual({
      ok: true,
      occurrences: [{ routineId: "routine-w", at: "2026-11-05T00:00:00.000Z", status: "scheduled" }],
      runs: [{ routineId: "routine-w", firedAt: "2026-11-03T00:00:00.000Z", status: "failed", sessionId: "s1" }],
    });
    expect(await invoke(ROUTINES.listOccurrences, { from: "2026-11-02T00:00:00.000Z", to: "2027-11-02T00:00:00.000Z" })).toEqual({ ok: false, error: "invalid-range" });
    expect(await invoke(ROUTINES.listOccurrences, { from: "x", to: "y" })).toEqual({ ok: false, error: "invalid-range" });
  });
});

describe("schedule panel IPC — review fixes", () => {
  it("rejects an add without a project", async () => {
    const deps = await setup([]);
    expect(await invoke(ROUTINES.add, { trigger: "schedule", execution: "notification-only", notificationTitle: "n" }))
      .toEqual({ ok: false, error: "project-required" });
    expect(deps.routinesStore.add).not.toHaveBeenCalled();
  });

  it("keeps a completed one-shot's run in the grid after it was dismissed", async () => {
    const deps = await setup([]);
    const done = {
      id: "once", trigger: "schedule", execution: "notification-only", notificationTitle: "n", createdAt: "2026-10-01T00:00:00.000Z",
      projectRoot: "/p/a", schedule: { at: "2026-11-03T00:00:00.000Z" }, lastFiredAt: "2026-11-03T00:00:00.000Z", dismissedAt: "2026-11-03T00:00:00.000Z",
    };
    const other = { ...done, id: "elsewhere", projectRoot: "/p/b" };
    (deps.routinesStore.list as ReturnType<typeof vi.fn>).mockImplementation((filter?: { projectRoot: string }) =>
      [done, other].filter((r) => !filter || r.projectRoot === filter.projectRoot));
    (deps.routinesStore.listForDisplay as ReturnType<typeof vi.fn>).mockReturnValue({ routines: [], invalid: [] });
    const result = await invoke(ROUTINES.listOccurrences, { projectRoot: "/p/a", from: "2026-11-02T00:00:00.000Z", to: "2026-11-09T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, occurrences: [], runs: [{ routineId: "once", firedAt: "2026-11-03T00:00:00.000Z", status: "done" }] });
  });
});
