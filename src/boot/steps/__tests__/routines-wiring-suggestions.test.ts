import { ConversationLoop } from "../../../engine/conversation-loop.js";
import { RoutineEngine, type Routine } from "../../../routines/routine-engine.js";
import { ScriptedTurnProvider, makeBasicConversationLoopDeps } from "../../../engine/__tests__/support/conversation-loop-fixtures.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { withRoutinesStore } from "../../../main/__tests__/support/routines-store.js";
import { TEST_OWNER, futureIso } from "../../../main/__tests__/routines-fixture.js";
import type { StreamEvent } from "../../../engine/llm/types.js";
/** Create and promote the Suggestions conversation before sending scheduled routine cards. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireRoutinesScheduler } from "../routines-wiring.js";
import { ROUTINES } from "../../../shared/ipc-channels.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import type { BootContext } from "../../context.js";
import { setRoutineChatWaker, type RoutineChatWakeResult } from "../../../main/app-state.js";
import { sessionAuthorityWithheld, turnExtensionPolicyContext } from "../../../shared/turn-extension-policy.js";
import { EgressGrantStore } from "../../../permissions/egress-grants.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: { routine: Record<string, unknown> }) => void;

function wire(
  runRoutine: (input: Record<string, unknown>) => Promise<{ summary: string; sessionId?: string; skipped?: "chat-busy" }>,
  chats: Record<string, { projectRoot?: string; noTranscript?: true }> = {},
  persistedStore?: BootContext["routinesStore"],
) {
  const handlers: { llm?: Handler; notification?: Handler } = {};
  const routinesStore = {
    recordNotificationRunMetrics: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})), recordRunOutcome: vi.fn(async () => ({})),
    markOrphaned: vi.fn(async () => 1), markChatBusy: vi.fn(async () => ({})),
  };
  const send = vi.fn();
  const touchSessionTranscript = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } };
  const routinesScheduler = {
    onLlmSession: (handler: Handler) => { handlers.llm = handler; return () => {}; },
    onNotification: (handler: Handler) => { handlers.notification = handler; return () => {}; },
    markRunning: vi.fn(),
    markStopped: vi.fn(),
  };
  const notificationService = { fire: vi.fn() };
  const ctx = {
    routinesScheduler,
    routineEngine: { runRoutine: vi.fn(runRoutine) },
    routinesStore: persistedStore ?? routinesStore,
    getMainWindow: () => window,
    host: { desktop: { getAppWindows: () => [window] } },
    notificationService,
    memoryManager: {
      touchSessionTranscript,
      loadSessionMetadata: (id: string) => chats[id] ?? null,
      hasSessionTranscript: (id: string) => chats[id] !== undefined && chats[id].noTranscript !== true,
    },
  } as unknown as BootContext;
  wireRoutinesScheduler(ctx);
  return { handlers, send, touchSessionTranscript, routinesStore, routinesScheduler, notificationService };
}

const routine = { id: "routine-a", trigger: { kind: "manual" }, execution: "llm-session", title: "Morning", lastFiredAt: "2026-11-04T01:00:00.000Z" };

function expectTouchedBefore(send: ReturnType<typeof vi.fn>, touch: ReturnType<typeof vi.fn>, channel: string) {
  const at = send.mock.calls.findIndex(([sent]) => sent === channel);
  expect(at).toBeGreaterThanOrEqual(0);
  const sentOrder = send.mock.invocationCallOrder[at]!;
  expect(touch.mock.invocationCallOrder.some((order) => order < sentOrder)).toBe(true);
}

describe("routine cards and the Suggestions conversation", () => {
  it("makes the conversation exist before the running and result cards go out", async () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => ({ summary: "done", sessionId: "s-1" }));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(touchSessionTranscript).toHaveBeenCalledWith(SUGGESTIONS_SESSION_ID, { bump: true });
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.runningStarted);
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.fired);
  });

  it("does the same for a failed run's card", async () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => { throw new Error("boom"); });
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.failed, expect.anything()));
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.failed);
  });

  it("and for a notification-only routine's card", async () => {
    const { handlers, send, touchSessionTranscript } = wire(async () => ({ summary: "" }));
    handlers.notification!({ routine: { ...routine, execution: "notification-only" } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expectTouchedBefore(send, touchSessionTranscript, ROUTINES.fired);
  });
});

describe("routine run outcome persistence", () => {
  it("records a thrown run as a failure of that fire", async () => {
    const { handlers, send, routinesStore } = wire(async () => { throw new Error("boom"); });
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith(
      "routine-a",
      "2026-11-04T01:00:00.000Z",
      { ok: false, kind: "error", reason: "boom" },
      expect.objectContaining({ startedAt: expect.any(String), durationMs: expect.any(Number) }),
      undefined,
    );
  });

  it("records a successful run so an earlier failure clears", async () => {
    const { handlers, send, routinesStore } = wire(async () => ({ summary: "done", sessionId: "s-1" }));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith("routine-a", "2026-11-04T01:00:00.000Z", { ok: true }, expect.objectContaining({ durationMs: expect.any(Number) }), "s-1");
  });

  it("still sends the result card when persisting the outcome fails", async () => {
    const { handlers, send, routinesStore } = wire(async () => { throw new Error("boom"); });
    routinesStore.recordRunOutcome.mockRejectedValueOnce(new Error("disk full"));
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
  });
});

describe("runs in progress", () => {
  it.each([
    ["succeeds", async () => ({ summary: "done", sessionId: "s-1" })],
    ["rejects", async () => { throw new Error("boom"); }],
  ] as const)("marks the run stopped before the finished event when the run %s", async (_label, run) => {
    const { handlers, send, routinesScheduler } = wire(run);
    handlers.llm!({ routine });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(routinesScheduler.markRunning).toHaveBeenCalledWith("routine-a", "2026-11-04T01:00:00.000Z");
    expect(routinesScheduler.markStopped).toHaveBeenCalledExactlyOnceWith("routine-a");
    const finishedAt = send.mock.calls.findIndex(([channel]) => channel === ROUTINES.runningFinished);
    expect(routinesScheduler.markStopped.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[finishedAt]!);
  });
});

describe("a schedule connected to a chat", () => {
  const TARGET = "22222222-2222-4222-8222-222222222222";
  const connected = { ...routine, trigger: "schedule", prePrompt: "check the build", targetSessionId: TARGET };
  afterEach(() => setRoutineChatWaker(null));

  it("runs in the open chat as a marked turn that withholds the chat's session allows", async () => {
    const wakes: Array<{ sessionId: string; input: string; displayText: string; withheld: boolean }> = [];
    setRoutineChatWaker(async (sessionId, turn) => {
      await Promise.resolve();
      wakes.push({ sessionId, ...turn, withheld: sessionAuthorityWithheld() });
      return { status: "ran" };
    });
    const { handlers, send, routinesStore, routinesScheduler } = wire(async () => { throw new Error("no headless run for an open chat"); }, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.objectContaining({ routineSessionId: TARGET })));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ sessionId: TARGET, input: "check the build", withheld: true });
    expect(wakes[0]!.displayText).toContain("Morning");
    expect(wakes[0]!.displayText).toContain("check the build");
    expect(routinesStore.recordRunOutcome).toHaveBeenCalledWith("routine-a", routine.lastFiredAt, { ok: true }, expect.objectContaining({ durationMs: expect.any(Number) }), TARGET);
    expect(routinesScheduler.markStopped).toHaveBeenCalledWith("routine-a");
    // Outside the wake the flag is gone again: the next ordinary turn reads its allows.
    expect(sessionAuthorityWithheld()).toBe(false);
  });

  it("runs an unopened chat headless, loading that chat, with the same withheld authority", async () => {
    setRoutineChatWaker(async () => ({ status: "not-open" }));
    let withheld: boolean | undefined;
    const { handlers, send, routinesStore } = wire(async (input) => {
      withheld = sessionAuthorityWithheld();
      expect(input).toMatchObject({ id: "routine-a", prePrompt: "check the build", targetSessionId: TARGET });
      expect(input.displayText).toEqual(expect.stringContaining("check the build"));
      expect(input.displayText).toEqual(expect.stringContaining("Morning"));
      return { summary: "built", sessionId: TARGET };
    }, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.objectContaining({ routineSessionId: TARGET, summary: "built" })));
    expect(withheld).toBe(true);
    expect(routinesStore.update).toHaveBeenCalledWith("routine-a", { lastRoutineSessionId: TARGET });
  });

  it.each([
    ["its open chat is busy", { status: "busy" } as RoutineChatWakeResult, undefined],
    ["another conversation holds the unopened chat", { status: "not-open" } as RoutineChatWakeResult, "chat-busy" as const],
  ])("skips with a recorded reason when %s", async (_label, live, headless) => {
    setRoutineChatWaker(async () => live);
    const run = vi.fn(async () => ({ summary: "", skipped: headless }));
    const { handlers, send, routinesStore, routinesScheduler } = wire(run, { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesStore.markChatBusy).toHaveBeenCalledWith("routine-a", routine.lastFiredAt));
    await vi.waitFor(() => expect(routinesScheduler.markStopped).toHaveBeenCalledWith("routine-a"));
    expect(run).toHaveBeenCalledTimes(headless ? 1 : 0);
    expect(routinesStore.recordRunOutcome).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(ROUTINES.fired, expect.anything());
    expect(send).not.toHaveBeenCalledWith(ROUTINES.failed, expect.anything());
  });

  it("marks the item 대화 없음, not busy, when the chat's metadata outlived its transcript", async () => {
    setRoutineChatWaker(async () => ({ status: "not-open" }));
    const run = vi.fn(async () => ({ summary: "", skipped: "chat-busy" as const }));
    const { handlers, routinesStore } = wire(run, { [TARGET]: { noTranscript: true } });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesStore.markOrphaned).toHaveBeenCalledWith(TARGET));
    expect(run).not.toHaveBeenCalled();
    expect(routinesStore.markChatBusy).not.toHaveBeenCalled();
  });

  it("marks the item 대화 없음 and runs nothing when its chat no longer exists", async () => {
    const waker = vi.fn(async () => ({ status: "ran" }) as RoutineChatWakeResult);
    setRoutineChatWaker(waker);
    const run = vi.fn(async () => ({ summary: "" }));
    const { handlers, routinesStore, routinesScheduler } = wire(run);
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesStore.markOrphaned).toHaveBeenCalledWith(TARGET));
    expect(waker).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(routinesScheduler.markRunning).not.toHaveBeenCalled();
  });
});

describe("a connected schedule's withheld session, outside the turn's async context", () => {
  const TARGET = "55555555-5555-4555-8555-555555555555";
  const connected = { ...routine, trigger: "schedule", prePrompt: "check the build", targetSessionId: TARGET };
  const scopes = ["once", "session", "project", "always"] as const;
  const github = { host: "github.com", port: 443 };
  let dir: string;
  afterEach(() => { setRoutineChatWaker(null); if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function grantedStore() {
    dir = mkdtempSync(join(tmpdir(), "ave-wake-egress-"));
    const projectRoot = join(dir, "project");
    mkdirSync(projectRoot);
    const store = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    const subject = { token: "2".repeat(32), sessionId: TARGET, tabId: undefined, projectRoot, origin: "shell" as const };
    await store.grant("session", scopes, subject, github);
    // A lookup from a callback the turn's async context does not reach.
    const outside = () => turnExtensionPolicyContext.exit(() => store.matchingScope(subject, github, scopes));
    return { outside };
  }

  it("does not honour the chat's session egress grant during the wake, and honours it again afterwards", async () => {
    const { outside } = await grantedStore();
    const during: Array<string | undefined> = [];
    setRoutineChatWaker(async () => { during.push(await outside()); return { status: "ran" }; });
    const { handlers, send } = wire(async () => ({ summary: "" }), { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
    expect(during).toEqual([undefined]);
    expect(await outside()).toBe("session");
  });

  it.each([
    ["the wake throws", async () => { throw new Error("provider down"); }],
    ["the chat is busy", async () => ({ status: "busy" }) as RoutineChatWakeResult],
  ])("releases the session when %s", async (_label, waker) => {
    const { outside } = await grantedStore();
    setRoutineChatWaker(waker);
    const { handlers, routinesScheduler } = wire(async () => ({ summary: "" }), { [TARGET]: {} });
    handlers.llm!({ routine: connected });
    await vi.waitFor(() => expect(routinesScheduler.markStopped).toHaveBeenCalled());
    expect(await outside()).toBe("session");
    expect(turnExtensionPolicyContext.exit(() => sessionAuthorityWithheld(TARGET))).toBe(false);
  });
});


it("records a recovered child stream-error and parent end_turn as done with both turns' tokens", withRoutinesStore(async ({ store }) => {
  const item = await store.add({ ...TEST_OWNER, trigger: "schedule", execution: "llm-session", prePrompt: "Recover the child result", schedule: { at: futureIso() } });
  const fired = await store.markFired(item.id);
  const memoryManager = new MemoryManager();
  const createLoop = (events: StreamEvent[][], registry: ToolRegistry) => {
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({ memoryManager, toolRegistry: registry }));
    loop.provider = new ScriptedTurnProvider(events);
    return loop;
  };
  const childRegistry = new ToolRegistry();
  childRegistry.register(createDynamicTool({ name: "read_child_report", description: "Read child report", source: "builtin", category: "read", jsonSchema: { type: "object", properties: {} }, isReadOnly: () => true, execute: async () => ({ output: "report", isError: false }) }));
  const child = createLoop([
    [{ type: "tool_call", id: "child-read", name: "read_child_report", input: {} }, { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20 } }],
    [{ type: "error", error: "synthetic child failure" }],
  ], childRegistry);
  const parentRegistry = new ToolRegistry();
  parentRegistry.register(createDynamicTool({ name: "recover_child", description: "Recover child result", source: "builtin", category: "read", jsonSchema: { type: "object", properties: {} }, isReadOnly: () => true, execute: async () => {
    const result = await child.runTurn("Read the report", undefined, undefined, { inputOrigin: "plugin-emitted" });
    expect(result.stopReason).toBe("stream-error");
    return { output: "Child failed; continue with the available report", isError: false };
  } }));
  const parent = createLoop([
    [{ type: "tool_call", id: "parent-recover", name: "recover_child", input: {} }, { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 40, outputTokens: 5 } }],
    [{ type: "text_delta", text: "<summary>Recovered</summary>" }, { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } }],
  ], parentRegistry);
  const engine = new RoutineEngine({ createConversationLoop: () => parent });
  const { handlers, send } = wire((input) => engine.runRoutine(input as unknown as Routine), {}, store);
  handlers.llm!({ routine: fired! as unknown as Record<string, unknown> });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
  expect(store.list()[0]!.lastFailure).toBeUndefined();
  expect(store.list()[0]!.runs![0]).toMatchObject({ status: "done", metrics: { tokens: { input: 200, output: 35, total: 235 } } });
}));

it("does not create failure attention when scheduled notification delivery throws", async () => {
  const { handlers, send, routinesStore, notificationService } = wire(async () => ({ summary: "" }));
  notificationService.fire.mockImplementationOnce(() => { throw new Error("notification delivery failed"); });
  handlers.notification!({ routine: { ...routine, execution: "notification-only" } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ROUTINES.fired, expect.anything()));
  expect(routinesStore.recordRunOutcome).not.toHaveBeenCalled();
  expect(routinesStore.recordNotificationRunMetrics).toHaveBeenCalledWith(routine.id, routine.lastFiredAt, expect.objectContaining({ durationMs: expect.any(Number) }));
});
