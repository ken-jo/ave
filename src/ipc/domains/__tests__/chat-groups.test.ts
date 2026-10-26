import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fileMentionContext from "../../handlers/file-mention-context.js";
import { formatFileMentionReference } from "../../../shared/file-mention-reference.js";
import { checkpointFileMutation, withCodeCheckpoint } from "../../../memory/code-checkpoints.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sessionUuid } from "../../../__tests__/support/session-uuid.js";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { SessionGoalStore } from "../../../main/session-goal-store.js";
import type { SessionGoal } from "../../../shared/session-goal.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const RENDERER_EVENT = { senderFrame: { url: "file:///index.html" } };

vi.mock("../../gated.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateHostRendererSender: () => true,
}));

// Releasing a group must unsubscribe its stream adapter.
vi.mock("../../../core/custom-commands.js", () => ({
  listCustomCommands: vi.fn(async (projectRoot?: string) => [
    { name: "from-project", scope: "project", description: projectRoot ?? "" },
  ]),
}));

const unsubscribes: ReturnType<typeof vi.fn>[] = [];
vi.mock("../../../api/platform-conversation-legacy-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/platform-conversation-legacy-adapter.js")>();
  return {
    ...actual,
    createPlatformConversationLegacyStreamAdapter: (...args: Parameters<typeof actual.createPlatformConversationLegacyStreamAdapter>) => {
      const adapter = actual.createPlatformConversationLegacyStreamAdapter(...args);
      return {
        ...adapter,
        subscribe: (fn: Parameters<typeof adapter.subscribe>[0]) => {
          const real = adapter.subscribe(fn);
          const spy = vi.fn(real);
          unsubscribes.push(spy);
          return spy;
        },
      };
    },
  };
});

const runtimes: import("../../../engine/conversation-surface-runtime.js").ConversationSurfaceRuntime[] = [];
vi.mock("../../../engine/conversation-surface-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../engine/conversation-surface-runtime.js")>();
  return {
    ...actual,
    createConversationSurfaceRuntime: (...args: Parameters<typeof actual.createConversationSurfaceRuntime>) => {
      const runtime = actual.createConversationSurfaceRuntime(...args);
      runtimes.push(runtime);
      return runtime;
    },
  };
});

type FakeLoop = {
  id: string;
  sessionId: string;
  hasProvider: ReturnType<typeof vi.fn>;
  abortCurrentTurn: ReturnType<typeof vi.fn>;
  newConversation: ReturnType<typeof vi.fn>;
  cleanupSession: ReturnType<typeof vi.fn>;
  runSessionTransition: ReturnType<typeof vi.fn>;
  isSessionTransitioning: () => boolean;
  getSessionId: () => string;
  getSessionKind: () => "main";
  getSessionExecutionCwd: () => string;
  getTurnAdditionalDirectories: () => readonly string[];
  hasActiveTurn: () => boolean;
  getHistory: () => {
    length: number;
    getMessages: () => unknown[];
    truncate: (count: number) => void;
    restore: () => void;
  };
  refreshProvider: () => void;
  resetAndResume: ReturnType<typeof vi.fn>;
  getSessionProjectContext: () => { projectRoot?: string };
};

function fakeLoop(id: string, seed: unknown[] = []): FakeLoop {
  // Truncation must remove rows so cutting the wrong tile cannot pass.
  let messages = [...seed];
  let transitioning = false;
  const loop: FakeLoop = {
    id,
    sessionId: sessionUuid(`session-of-${id}`),
    hasProvider: vi.fn(() => id !== MAIN_CHAT_GROUP_ID),
    abortCurrentTurn: vi.fn(),
    newConversation: vi.fn(async () => undefined),
    cleanupSession: vi.fn(async () => undefined),
    runSessionTransition: vi.fn(async (_reason: string, operation: (lease: object) => unknown) => {
      if (transitioning) throw new Error("conversation-loop:session-transition-in-progress");
      transitioning = true;
      try {
        return await operation({});
      } finally {
        transitioning = false;
      }
    }),
    isSessionTransitioning: vi.fn(() => transitioning),
    getSessionId: () => loop.sessionId,
    getSessionKind: () => "main",
    getSessionExecutionCwd: () => `/projects/${id}`,
    getTurnAdditionalDirectories: () => [],
    hasActiveTurn: () => false,
    getHistory: () => ({
      length: messages.length,
      getMessages: () => messages,
      truncate: (count: number) => { messages = messages.slice(0, count); },
      restore: () => {},
    }),
    refreshProvider: () => {},
    getSessionProjectContext: () => ({ projectRoot: `/projects/${id}` }),
    resetAndResume: vi.fn(async (sessionId: string) => {
      loop.sessionId = sessionId;
      return { ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }),
  };
  return loop;
}

function runFakeTransition<T>(
  loop: FakeLoop,
  reason: string,
  operation: () => Promise<T>,
): Promise<T> {
  const run = loop.runSessionTransition as unknown as (
    transitionReason: string,
    body: (lease: object) => Promise<T>,
  ) => Promise<T>;
  return run(reason, operation);
}

type RendererEvents = Record<string, ((...args: unknown[]) => void)[]>;

async function registerWithGroups(
  window?: {
    isDestroyed: () => boolean;
    webContents: { on: (name: string, fn: (...args: unknown[]) => void) => void };
  },
  groupSeed?: unknown[],
) {
  const { createConversationSurfaceRuntime } = await import("../../../engine/conversation-surface-runtime.js");
  const main = fakeLoop(MAIN_CHAT_GROUP_ID, [
    { role: "user", content: "from main", meta: { messageId: "main-q1" } },
    { role: "assistant", content: "main answer", meta: { messageId: "main-a1" } },
  ]);
  const groups = new Map<string, FakeLoop>();
  const resolveChatGroupLoop = vi.fn((chatGroupId: string) => {
    let loop = groups.get(chatGroupId);
    if (!loop) {
      loop = fakeLoop(chatGroupId, groupSeed ?? []);
      groups.set(chatGroupId, loop);
    }
    return loop;
  });
  const releaseChatGroupLoop = vi.fn((chatGroupId: string) => { groups.delete(chatGroupId); });
  const { registerChatHandlers } = await import("../chat.js");
  const memoryManager = {
    loadMainActiveSessionState: vi.fn(() => null),
    markMainActiveFresh: vi.fn(async () => undefined),
    markMainActiveResume: vi.fn(async () => undefined),
    saveSessionMetadata: vi.fn(async () => undefined),
    saveSession: vi.fn(async () => undefined),
    pruneCheckpointsDiscardedByRewind: vi.fn(async () => undefined),
  };
  const goalDisk = new Map<string, SessionGoal | null>();
  const sessionGoalStore = new SessionGoalStore({
    load: (sessionId) => goalDisk.get(sessionId) ?? null,
    save: async (sessionId, goal) => { goalDisk.set(sessionId, goal); },
  });
  registerChatHandlers({
    conversationLoop: main,
    conversationSurfaceRuntime: createConversationSurfaceRuntime(),
    resolveChatGroupLoop,
    releaseChatGroupLoop,
    settingsService: {
      get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})),
      patch: vi.fn(async () => undefined),
    },
    memoryManager,
    sessionGoalStore,
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => window ?? null),
  } as unknown as Parameters<typeof registerChatHandlers>[0]);
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(RENDERER_EVENT, ...args);
  return { main, groups, resolveChatGroupLoop, releaseChatGroupLoop, invoke, memoryManager, sessionGoalStore };
}

function fakeRenderer(): {
  window: {
    isDestroyed: () => boolean;
    webContents: { on: (name: string, fn: (...args: unknown[]) => void) => void };
  };
  events: RendererEvents;
} {
  const events: RendererEvents = {};
  const on = (name: string, fn: (...args: unknown[]) => void) => { (events[name] ??= []).push(fn); };
  return { window: { isDestroyed: () => false, webContents: { on } }, events };
}

describe("ave:chat:* with chat groups", () => {
  beforeEach(() => {
    handlers.clear();
    unsubscribes.length = 0;
    runtimes.length = 0;
    vi.clearAllMocks();
  });

  it("names its group or is refused — there is no default tile", async () => {
    const { invoke, resolveChatGroupLoop } = await registerWithGroups();
    expect(() => invoke(CHANNELS.chat.hasProvider)).toThrow("chat-group-required");
    expect(() => invoke(CHANNELS.chat.hasProvider, "   ")).toThrow("chat-group-required");
    expect(resolveChatGroupLoop).not.toHaveBeenCalled();
  });

  it.each([{ operation: "send", pausingGoal: false }, { operation: "send", pausingGoal: true },
    { operation: "edit", pausingGoal: false }, { operation: "edit", pausingGoal: true }])("honors desktop Stop while reference expansion is paused, mode: $operation, pending goal: $pausingGoal", async ({ operation, pausingGoal }) => {
    const { invoke, main, sessionGoalStore } = await registerWithGroups();
    let releasePause = () => {};
    let restorePause = () => {};
    if (pausingGoal) {
      await sessionGoalStore.set(main.getSessionId(), "finish the goal");
      const originalPause = sessionGoalStore.pause.bind(sessionGoalStore);
      const pauseHeld = new Promise<void>((resolve) => { releasePause = resolve; });
      const pause = vi.spyOn(sessionGoalStore, "pause").mockImplementationOnce(async (sessionId) => {
        await pauseHeld; return originalPause(sessionId);
      });
      restorePause = () => pause.mockRestore();
    }
    const model = vi.fn(async () => ({ text: "must not start", toolCalls: [], route: "default", stopReason: "end_turn" }));
    Object.assign(main, { runTurn: model });
    let entered!: () => void;
    const expansionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    let observedSignal: AbortSignal | undefined;
    const expansion = vi.spyOn(fileMentionContext, "expandFileMentionContext").mockImplementationOnce(async (_loop, input, _origin, _attachments, signal) => {
      observedSignal = signal;
      entered();
      await blocked;
      return { input };
    });
    try {
      const input = formatFileMentionReference(1, { path: "src/source.ts", startLine: 3, endLine: 5, turnId: "main-q1", hunkId: "a".repeat(64) });
      const original = [...main.getHistory().getMessages()];
      const sending = Promise.resolve(operation === "edit"
        ? invoke(CHANNELS.chat.editResend, "main-q1", input, MAIN_CHAT_GROUP_ID)
        : invoke(CHANNELS.chat.send, { input, inputOrigin: "user-keyboard", userActivation: true }, MAIN_CHAT_GROUP_ID));
      await expansionEntered;
      const stopping = Promise.resolve(invoke(CHANNELS.chat.abort, MAIN_CHAT_GROUP_ID));
      const cancelledDuringPreparation = observedSignal?.aborted;
      resume();
      await sending.catch(() => {});
      if (pausingGoal) expect(runtimes[0]!.activity.isBusy()).toBe(true);
      releasePause();
      await stopping;
      expect(model).not.toHaveBeenCalled();
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(cancelledDuringPreparation).toBe(true);
      await expect(stopping).resolves.toEqual({ ok: true });
      await expect(sending).resolves.toMatchObject(operation === "edit" ? { ok: true, result: { stopReason: "interrupted" } } : { stopReason: "interrupted" });
      expect(main.getHistory().getMessages()).toEqual(original);
    } finally { resume(); releasePause(); restorePause(); expansion.mockRestore(); }
  });

  it("lists custom commands from the project of the tile that asked", async () => {
    const { invoke } = await registerWithGroups();
    const listed = async (group: string) =>
      ((await invoke(CHANNELS.chat.listCustomCommands, group)) as { commands: Array<{ description: string }> })
        .commands.map((command) => command.description);
    expect(await listed("group-2")).toEqual(["/projects/group-2"]);
    expect(await listed(MAIN_CHAT_GROUP_ID)).toEqual([`/projects/${MAIN_CHAT_GROUP_ID}`]);
    await expect(Promise.resolve().then(() => invoke(CHANNELS.chat.listCustomCommands))).rejects.toThrow("chat-group-required");
  });

  it("runs each group on its own loop, and the primary on the primary", async () => {
    const { invoke, main, groups, resolveChatGroupLoop } = await registerWithGroups();
    expect(invoke(CHANNELS.chat.hasProvider, MAIN_CHAT_GROUP_ID)).toBe(false);
    expect(invoke(CHANNELS.chat.hasProvider, "group-2")).toBe(true);
    expect(invoke(CHANNELS.chat.hasProvider, "group-3")).toBe(true);
    expect(resolveChatGroupLoop.mock.calls.map((call) => call[0])).toEqual(["group-2", "group-3"]);
    expect(main.hasProvider).toHaveBeenCalledTimes(1);
    expect(groups.get("group-2")!.hasProvider).toHaveBeenCalledTimes(1);
    expect(groups.get("group-3")!.hasProvider).toHaveBeenCalledTimes(1);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(2);
  });

  it("replays a group's OWN history — continue and retry read the tile's conversation, not the primary's", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const loop = groups.get("group-2")!;
    const result = await invoke(CHANNELS.chat.continueLastUser, { sessionId: loop.sessionId }, "group-2");
    expect(result).toEqual({ ok: false, error: "no-user-message" });
    const retried = await invoke(CHANNELS.chat.retryEffort, {}, "group-2");
    expect(retried).toEqual({ ok: false, error: "no-user-message" });
    const mismatched = await invoke(CHANNELS.chat.continueLastUser, { sessionId: sessionUuid("session-of-main") }, "group-2");
    expect(mismatched).toEqual({ ok: false, error: "session-mismatch" });
  });

  it("rewinds the tile that asked and leaves the other tile's conversation whole", async () => {
    const { invoke, groups, main, memoryManager } = await registerWithGroups(undefined, [
      { role: "user", content: "tile question", meta: { messageId: "tile-q1" } },
      { role: "assistant", content: "tile answer", meta: { messageId: "tile-a1" } },
    ]);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const tile = groups.get("group-2")!;

    const result = await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2");

    expect(result).toMatchObject({ ok: true, text: "tile question" });
    expect(tile.getHistory().getMessages()).toEqual([]);
    expect(main.getHistory().getMessages()).toHaveLength(2);
    expect(memoryManager.saveSession).toHaveBeenCalledWith(sessionUuid("session-of-group-2"), []);
  });

  describe("code rewind at the conversation mutation boundary", () => {
    let root: string;
    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "ave-rewind-ipc-")));
      vi.stubEnv("AVE_HOME", join(root, "state"));
    });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
    async function setup() {
      const registered = await registerWithGroups(undefined, [
        { role: "user", content: "tile question", meta: { messageId: "tile-q1" } },
        { role: "assistant", content: "tile answer", meta: { messageId: "tile-a1" } },
      ]);
      registered.invoke(CHANNELS.chat.hasProvider, "group-2");
      const tile = registered.groups.get("group-2")!;
      tile.getSessionExecutionCwd = () => root;
      const file = join(root, "code.txt");
      await writeFile(file, "before");
      await withCodeCheckpoint({ sessionId: tile.getSessionId(), messageId: "tile-q1" }, () =>
        checkpointFileMutation([{ path: file, content: "agent" }], () => writeFile(file, "agent")));
      return { ...registered, tile, file };
    }
    it("exposes only readonly workspace-relative latest turn hunks for its group", async () => {
      const { invoke, tile, file, memoryManager } = await setup();
      const result = await invoke("ave:chat:get-turn-review", tile.getSessionId(), "group-2");
      expect(result).toMatchObject({ ok: true, review: { sessionId: tile.getSessionId(), turnId: "tile-q1", files: [{ path: "code.txt", hunks: [{ oldText: "before", newText: "agent" }] }] } });
      expect(await readFile(file, "utf8")).toBe("agent");
      expect(tile.getHistory().getMessages()).toHaveLength(2);
      expect(memoryManager.saveSession).not.toHaveBeenCalled();
    });
    it("retains the initiating review turn after queued guidance is injected", async () => {
      const { invoke, tile } = await setup();
      tile.getHistory().getMessages().push({ role: "user", content: "Queued follow-up", meta: { messageId: "injected-row", hostInjectionId: "guidance-batch" } });
      const result = await invoke("ave:chat:get-turn-review", tile.getSessionId(), "group-2");
      expect(result).toMatchObject({ ok: true, review: { turnId: "tile-q1", files: [{ path: "code.txt" }] } });
    });

    it("keeps recorded totals while the Files workspace details show subsequent current edits", async () => {
      const { invoke, tile, file } = await setup();
      await writeFile(file, "external\nextra\n");
      const result = await invoke("ave:chat:get-turn-review", tile.getSessionId(), "group-2");
      expect(result).toMatchObject({ ok: true, review: { files: [{ path: "code.txt", added: 1, removed: 1,
        countsKnown: true, referenceable: false, hunks: [{ oldText: "before", newText: "external\nextra\n" }],
      }] } });
      expect(await readFile(file, "utf8")).toBe("external\nextra\n");
    });
    it("does not resolve a review for another session", async () => {
      const { invoke, main } = await setup();
      expect(await invoke("ave:chat:get-turn-review", main.getSessionId(), "group-2")).toEqual({ ok: false, error: "turn-review-stale" });
    });
    it("restores code without truncating or persisting the conversation", async () => {
      const { invoke, tile, file, memoryManager } = await setup();
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "code")).toMatchObject({ ok: true });
      expect(await readFile(file, "utf8")).toBe("before");
      expect(tile.getHistory().getMessages()).toHaveLength(2);
      expect(memoryManager.saveSession).not.toHaveBeenCalled();
    });
    it("restores both files and persisted conversation", async () => {
      const { invoke, tile, file, main, memoryManager } = await setup();
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "both")).toMatchObject({ ok: true, text: "tile question" });
      expect(await readFile(file, "utf8")).toBe("before");
      expect(tile.getHistory().getMessages()).toEqual([]);
      expect(main.getHistory().getMessages()).toHaveLength(2);
      expect(memoryManager.saveSession).toHaveBeenCalledWith(tile.getSessionId(), []);
    });
    it("lists conflicts and keeps history and code unchanged on refusal", async () => {
      const { invoke, tile, file, memoryManager } = await setup();
      await writeFile(file, "external");
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "both")).toMatchObject({ ok: false, error: "code-restore-conflict", conflictingFiles: [file] });
      expect(await readFile(file, "utf8")).toBe("external");
      expect(tile.getHistory().getMessages()).toHaveLength(2);
      expect(memoryManager.saveSession).not.toHaveBeenCalled();
    });
    it("leaves code untouched for conversation-only rewind", async () => {
      const { invoke, file } = await setup();
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "conversation")).toMatchObject({ ok: true });
      expect(await readFile(file, "utf8")).toBe("agent");
    });
    it("refuses a code rewind after the tile's write scope is revoked", async () => {
      const { invoke, tile, file, memoryManager } = await setup();
      tile.getSessionExecutionCwd = () => join(root, "other");
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "both")).toMatchObject({
        ok: false, error: "code-restore-conflict", conflictingFiles: [file],
      });
      expect(await readFile(file, "utf8")).toBe("agent");
      expect(tile.getHistory().getMessages()).toHaveLength(2);
      expect(memoryManager.saveSession).not.toHaveBeenCalled();
    });
    it("rejects invalid restore modes without changing anything", async () => {
      const { invoke, tile, file } = await setup();
      expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2", "force")).toEqual({ ok: false, error: "invalid-rewind-mode" });
      expect(await readFile(file, "utf8")).toBe("agent");
      expect(tile.getHistory().getMessages()).toHaveLength(2);
    });
  });

  it("refuses a rewind while that tile is mid-turn", async () => {
    const { invoke, memoryManager } = await registerWithGroups(undefined, [
      { role: "user", content: "tile question", meta: { messageId: "tile-q1" } },
    ]);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const tileRuntime = runtimes[runtimes.length - 1];
    let releaseTurn = () => {};
    const heldTurn = tileRuntime.activity.tryTrackTurn(
      () => new Promise<void>((resolve) => { releaseTurn = resolve; }),
    );

    const result = await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2");

    expect(result).toEqual({ ok: false, error: "streaming-active" });
    expect(memoryManager.saveSession).not.toHaveBeenCalled();
    releaseTurn();
    await heldTurn;
  });

  it("refuses a rewind naming a row that lives in another tile", async () => {
    const { invoke, memoryManager } = await registerWithGroups(undefined, [
      { role: "user", content: "tile question", meta: { messageId: "tile-q1" } },
    ]);
    invoke(CHANNELS.chat.hasProvider, "group-2");

    const result = await invoke(CHANNELS.chat.rewindTo, "main-q1", "group-2");

    expect(result).toEqual({ ok: false, error: "message-not-found" });
    expect(memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("opens a session in one tile at a time — a resume of one another tile holds is refused", async () => {
    const { invoke, groups, main } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const second = groups.get("group-2")!;

    const refused = await invoke(CHANNELS.chat.sessionResume, sessionUuid("session-of-main"), "group-2");
    expect(refused).toMatchObject({ ok: false, error: "session-open-in-other-group", holderChatGroupId: MAIN_CHAT_GROUP_ID });
    expect(second.resetAndResume).not.toHaveBeenCalled();
    const refusedBack = await invoke(CHANNELS.chat.sessionResume, sessionUuid("session-of-group-2"), MAIN_CHAT_GROUP_ID);
    expect(refusedBack).toMatchObject({ ok: false, error: "session-open-in-other-group", holderChatGroupId: "group-2" });
    expect(main.resetAndResume).not.toHaveBeenCalled();

    const loaded = await invoke(CHANNELS.chat.sessionResume, sessionUuid("session-archived"), "group-2");
    expect(loaded).toMatchObject({ ok: true });
    expect(second.resetAndResume).toHaveBeenCalledWith(sessionUuid("session-archived"));
  });

  it("names the holder even while the asking tile is busy — bringing another tile forward touches nothing here", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const second = groups.get("group-2")!;

    const first = invoke(CHANNELS.chat.sessionResume, sessionUuid("session-archived"), "group-2");
    const refused = invoke(CHANNELS.chat.sessionResume, sessionUuid("session-of-main"), "group-2");
    const busy = invoke(CHANNELS.chat.sessionResume, sessionUuid("session-older"), "group-2");
    await expect(refused).resolves.toMatchObject({ ok: false, error: "session-open-in-other-group", holderChatGroupId: MAIN_CHAT_GROUP_ID });
    await expect(busy).resolves.toMatchObject({ ok: false, error: "streaming-active" });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(second.resetAndResume).toHaveBeenCalledTimes(1);
  });

  it("only the primary tile's resume becomes the window's main-active conversation", async () => {
    const { invoke, memoryManager } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");

    await invoke(CHANNELS.chat.sessionResume, sessionUuid("session-archived"), "group-2");
    expect(memoryManager.markMainActiveResume).not.toHaveBeenCalled();

    await invoke(CHANNELS.chat.sessionResume, sessionUuid("session-older"), MAIN_CHAT_GROUP_ID);
    expect(memoryManager.markMainActiveResume).toHaveBeenCalledWith(sessionUuid("session-older"));
  });

  it("releasing the primary keeps its loop and hands it a blank conversation", async () => {
    const { invoke, main, releaseChatGroupLoop, memoryManager } = await registerWithGroups();
    expect(await invoke(CHANNELS.chat.groupRelease, MAIN_CHAT_GROUP_ID)).toEqual({ ok: true, released: true });
    expect(main.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(main.newConversation).toHaveBeenCalledTimes(1);
    expect(memoryManager.markMainActiveFresh).toHaveBeenCalledTimes(1);
    expect(releaseChatGroupLoop).not.toHaveBeenCalledWith(MAIN_CHAT_GROUP_ID);
  });

  it("releases a closed tile's group: turn stopped, loop forgotten, a later use builds afresh", async () => {
    const { invoke, groups, resolveChatGroupLoop, releaseChatGroupLoop } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const first = groups.get("group-2")!;
    expect(await invoke(CHANNELS.chat.groupRelease, "group-2")).toEqual({ ok: true, released: true });
    expect(first.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(releaseChatGroupLoop).toHaveBeenCalledWith("group-2");
    expect(await invoke(CHANNELS.chat.groupRelease, "group-2")).toEqual({ ok: true, released: false });
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(2);
    expect(groups.get("group-2")).not.toBe(first);
  });

  it("release lets go of the group's frames, and waits for a turn that is still running", async () => {
    const { window } = fakeRenderer();
    const { invoke, groups, memoryManager, sessionGoalStore } = await registerWithGroups(window, [
      { role: "user", content: "tile question", meta: { messageId: "tile-q1" } },
    ]);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(unsubscribes).toHaveLength(2); // the primary's, then group-2's
    const groupRuntime = runtimes[1]!;
    let finishCleanup!: () => void;
    groups.get("group-2")!.cleanupSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishCleanup = resolve; }),
    );
    let finishTurn!: () => void;
    const lease = groupRuntime.activity.tryTrackTurn(() => new Promise<void>((resolve) => { finishTurn = resolve; }));
    expect(lease).not.toBeNull();
    let settled = false;
    const release = (invoke(CHANNELS.chat.groupRelease, "group-2") as Promise<unknown>).then((r) => { settled = true; return r; });
    expect(groupRuntime.activity.isBusy()).toBe(true);
    expect(groups.get("group-2")!.isSessionTransitioning()).toBe(false);
    await Promise.resolve();
    expect(groups.get("group-2")!.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // still waiting on the turn's lease
    finishTurn();
    await vi.waitFor(() => {
      expect(groups.get("group-2")!.cleanupSession).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false); // cleanup proof is also part of release

    // Cleanup holds the shared admission decision; turns, history edits, and goal revival remain blocked.
    expect(await invoke(CHANNELS.chat.compact, "group-2")).toEqual({ error: "streaming-active" });
    expect(await invoke(CHANNELS.chat.rewindTo, "tile-q1", "group-2")).toEqual({ ok: false, error: "streaming-active" });
    expect(await invoke(CHANNELS.chat.send, {
      input: "race cleanup",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "group-2")).toEqual({ error: "streaming-active" });
    await expect(invoke(CHANNELS.chat.groupRelease, "group-2")).rejects.toThrow(
      "conversation-activity:session-transition-in-progress",
    );
    await sessionGoalStore.set(sessionUuid("session-of-group-2"), "finish safely");
    await Promise.resolve();
    expect(sessionGoalStore.get(sessionUuid("session-of-group-2"))?.round).toBe(0);
    expect(memoryManager.saveSession).not.toHaveBeenCalled();

    finishCleanup();
    expect(await release).toEqual({ ok: true, released: true });
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).not.toHaveBeenCalled(); // the primary keeps its frames
  });

  it("seals admission synchronously and waits for an existing session mutation before cleanup", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const groupRuntime = runtimes[1]!;
    let finishMutation!: () => void;
    const mutation = groupRuntime.activity.trackMutation(
      () => new Promise<void>((resolve) => { finishMutation = resolve; }),
    );
    expect(mutation).not.toBeNull();

    const release = invoke(CHANNELS.chat.groupRelease, "group-2") as Promise<unknown>;
    expect(groupRuntime.activity.isBusy()).toBe(true);
    expect(groups.get("group-2")!.isSessionTransitioning()).toBe(false);
    await Promise.resolve();
    expect(groups.get("group-2")!.cleanupSession).not.toHaveBeenCalled();

    finishMutation();
    await expect(release).resolves.toEqual({ ok: true, released: true });
    expect(groups.get("group-2")).toBeUndefined();
  });

  it("drains a real chat.new transition owner before releasing the group", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const group = groups.get("group-2")!;
    const groupRuntime = runtimes[1]!;
    let enteredNew!: () => void;
    let finishNew!: () => void;
    const newEntered = new Promise<void>((resolve) => { enteredNew = resolve; });
    group.newConversation.mockImplementationOnce(async () =>
      runFakeTransition(group, "new-conversation", async () => {
        enteredNew();
        await new Promise<void>((resolve) => { finishNew = resolve; });
      }));

    const starting = invoke(CHANNELS.chat.new, undefined, "group-2") as Promise<unknown>;
    await newEntered;
    expect(group.isSessionTransitioning()).toBe(true);
    const releasing = invoke(CHANNELS.chat.groupRelease, "group-2") as Promise<unknown>;
    expect(groupRuntime.activity.isBusy()).toBe(true);
    await Promise.resolve();
    expect(group.cleanupSession).not.toHaveBeenCalled();

    finishNew();
    await expect(starting).resolves.toEqual({ ok: true });
    await expect(releasing).resolves.toEqual({ ok: true, released: true });
    expect(group.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it("renderer-lifetime release drains a real sessionResume transition instead of orphaning the group", async () => {
    const { window, events } = fakeRenderer();
    const { invoke, groups, releaseChatGroupLoop } = await registerWithGroups(window);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const group = groups.get("group-2")!;
    let enteredResume!: () => void;
    let finishResume!: () => void;
    const resumeEntered = new Promise<void>((resolve) => { enteredResume = resolve; });
    group.resetAndResume.mockImplementationOnce(async (sessionId: string) =>
      runFakeTransition(group, "reset-and-resume", async () => {
        enteredResume();
        await new Promise<void>((resolve) => { finishResume = resolve; });
        group.sessionId = sessionId;
        return { ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 };
      }));

    const resume = invoke(
      CHANNELS.chat.sessionResume,
      sessionUuid("session-renderer-race"),
      "group-2",
    ) as Promise<unknown>;
    await resumeEntered;
    events["did-navigate"]![0]!();
    await Promise.resolve();
    expect(releaseChatGroupLoop).not.toHaveBeenCalledWith("group-2");
    expect(group.cleanupSession).not.toHaveBeenCalled();

    finishResume();
    await expect(resume).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(releaseChatGroupLoop).toHaveBeenCalledWith("group-2"));
    expect(group.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it("lets every group go when the renderer navigates — a reload numbers its tiles from the start", async () => {
    const { window, events } = fakeRenderer();
    const { invoke, groups, resolveChatGroupLoop, releaseChatGroupLoop } = await registerWithGroups(window);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    invoke(CHANNELS.chat.hasProvider, "group-3");
    const before = groups.get("group-2")!;
    expect(events["did-navigate"]).toHaveLength(1); // installed once, not per group
    // Cancelled main-frame, in-page, and subframe navigation retain the owning document.
    expect(events["did-start-navigation"]).toBeUndefined();
    expect(releaseChatGroupLoop).not.toHaveBeenCalled();
    events["did-navigate"]![0]!();
    await vi.waitFor(() => {
      expect(releaseChatGroupLoop.mock.calls.map((call) => call[0]).sort()).toEqual(["group-2", "group-3"]);
    });
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(3);
    expect(groups.get("group-2")).not.toBe(before);
    invoke(CHANNELS.chat.hasProvider, "group-4");
    events["render-process-gone"]![0]!();
    await vi.waitFor(() => expect(releaseChatGroupLoop).toHaveBeenLastCalledWith("group-4"));
    expect(releaseChatGroupLoop).toHaveBeenLastCalledWith("group-4");
    // Only a committed main-frame error page replaces the document; aborted or subframe loads retain the tiles.
    invoke(CHANNELS.chat.hasProvider, "group-5");
    expect(events["did-fail-load"]).toBeUndefined();
    expect(events["did-fail-provisional-load"]).toHaveLength(1);
    const releasesBefore = releaseChatGroupLoop.mock.calls.length;
    events["did-fail-provisional-load"]![0]!({}, -3, "ERR_ABORTED", "file:///index.html", true);
    events["did-fail-provisional-load"]![0]!({}, -6, "ERR_FILE_NOT_FOUND", "file:///frame.html", false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(groups.get("group-5")!.abortCurrentTurn).not.toHaveBeenCalled();
    expect(releaseChatGroupLoop).toHaveBeenCalledTimes(releasesBefore);
    events["did-fail-provisional-load"]![0]!({}, -6, "ERR_FILE_NOT_FOUND", "file:///index.html", true);
    await vi.waitFor(() => expect(releaseChatGroupLoop).toHaveBeenLastCalledWith("group-5"));
  });

  it("refuses a non-primary group when the process cannot release one", async () => {
    const { createConversationSurfaceRuntime } = await import("../../../engine/conversation-surface-runtime.js");
    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers({
      conversationLoop: fakeLoop(MAIN_CHAT_GROUP_ID),
      conversationSurfaceRuntime: createConversationSurfaceRuntime(),
      resolveChatGroupLoop: vi.fn((id: string) => fakeLoop(id)),
      settingsService: { get: vi.fn(() => fakeLlmSettings()), patch: vi.fn(async () => undefined) },
      memoryManager: {},
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(RENDERER_EVENT, ...args);
    expect(() => invoke(CHANNELS.chat.hasProvider, "group-2")).toThrow("chat-groups-unavailable");
  });
});

describe("ave:chat:* across several main windows", () => {
  beforeEach(async () => {
    handlers.clear();
    unsubscribes.length = 0;
    runtimes.length = 0;
    vi.clearAllMocks();
    (await import("../../../main/app-state.js")).resetMainWindowsForTests();
  });

  function fakeMainWindow(id: number) {
    const events: RendererEvents = {};
    const webContents = {
      id: id * 10,
      isDestroyed: () => false,
      send: vi.fn(),
      on: (name: string, fn: (...args: unknown[]) => void) => { (events[name] ??= []).push(fn); },
    };
    return { window: { id, isDestroyed: () => false, webContents }, events };
  }

  it("scopes a secondary window's tiles to that window and releases only them when it closes", async () => {
    const appState = await import("../../../main/app-state.js");
    const primary = fakeMainWindow(1);
    const secondary = fakeMainWindow(2);
    appState.registerMainWindow(primary.window as never, "primary");
    appState.registerMainWindow(secondary.window as never, "secondary");
    const { main, groups, resolveChatGroupLoop, releaseChatGroupLoop } = await registerWithGroups(primary.window);
    const from = (sender: unknown) => (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ ...RENDERER_EVENT, sender }, ...args);
    const fromPrimary = from(primary.window.webContents);
    const fromSecondary = from(secondary.window.webContents);

    // Tile ids are window-scoped; only the primary conversation id is global.
    fromPrimary(CHANNELS.chat.hasProvider, "group-2");
    fromSecondary(CHANNELS.chat.hasProvider, MAIN_CHAT_GROUP_ID);
    fromSecondary(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop.mock.calls.map((call) => call[0])).toEqual([
      "group-2",
      "window-20:main",
      "window-20:group-2",
    ]);
    expect(main.hasProvider).not.toHaveBeenCalled();
    expect(groups.get("group-2")).not.toBe(groups.get("window-20:group-2"));

    await expect(fromSecondary(CHANNELS.chat.groupRelease, MAIN_CHAT_GROUP_ID))
      .resolves.toEqual({ ok: true, released: true });
    expect(releaseChatGroupLoop).toHaveBeenCalledWith("window-20:main");
    expect(main.newConversation).not.toHaveBeenCalled();

    secondary.events["destroyed"]![0]!();
    await vi.waitFor(() => expect(releaseChatGroupLoop).toHaveBeenCalledWith("window-20:group-2"));
    expect(releaseChatGroupLoop).not.toHaveBeenCalledWith("group-2");
  });

  it("answers which window shows a session, and leaves a secondary window's tiles alone when the primary closes", async () => {
    const appState = await import("../../../main/app-state.js");
    const primary = fakeMainWindow(1);
    const secondary = fakeMainWindow(2);
    let primaryClosed = false;
    const primaryWindow = { ...primary.window, isDestroyed: () => primaryClosed };
    appState.registerMainWindow(primaryWindow as never, "primary");
    appState.registerMainWindow(secondary.window as never, "secondary");
    const { main, groups, releaseChatGroupLoop } = await registerWithGroups(primaryWindow);
    const fromSecondary = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ ...RENDERER_EVENT, sender: secondary.window.webContents }, ...args);

    fromSecondary(CHANNELS.chat.hasProvider, "group-2");
    const secondarySession = groups.get("window-20:group-2")!.sessionId;
    expect(appState.findSessionMainWindowContents(secondarySession)).toBe(secondary.window.webContents);
    expect(appState.findSessionMainWindowContents(main.sessionId)).toBe(primary.window.webContents);
    expect(appState.findSessionMainWindowContents("no-tile-holds-this")).toBeNull();

    primaryClosed = true;
    appState.unregisterMainWindow(primaryWindow as never);
    expect(appState.isSecondaryMainWindowContents(secondary.window.webContents)).toBe(true);
    expect(appState.findSessionMainWindowContents(secondarySession)).toBe(secondary.window.webContents);
    expect(appState.findSessionMainWindowContents(main.sessionId)).toBeNull();
    fromSecondary(CHANNELS.chat.hasProvider, "group-2");
    expect(groups.get("window-20:group-2")!.sessionId).toBe(secondarySession);
    expect(releaseChatGroupLoop).not.toHaveBeenCalled();
  });

  it("keeps auxiliary host surfaces on the global ids", async () => {
    const appState = await import("../../../main/app-state.js");
    const primary = fakeMainWindow(1);
    appState.registerMainWindow(primary.window as never, "primary");
    const { resolveChatGroupLoop } = await registerWithGroups(primary.window);
    handlers.get(CHANNELS.chat.hasProvider)!({ ...RENDERER_EVENT, sender: { id: 999 } }, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledWith("group-2");
  });
});
