import { installNativeChatWindow, invokeNativeChatHandler as invokeRegisteredHandler, nativeChatFrameEvent as hostFrameEvent } from "../../../__tests__/support/native-chat-window.js";
import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
import {
  foreignFrameEvent,
  invokeRegisteredHandlerWithEvent,
} from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const mockReadDiffSidecar = vi.fn<
  (sessionId: string, toolUseId: string) => Promise<{ before: string; after: string } | null>
>();

vi.mock("../../../tools/write-diff-cache.js", () => ({
  readDiffSidecar: mockReadDiffSidecar,
  isSafeId: (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id),
  WRITE_DIFF_PREVIEW_LIMIT: 4096,
  writeDiffSidecar: vi.fn(),
  clearSessionDiffCache: vi.fn(),
  purgeStaleSessionDiffDirs: vi.fn(),
}));

vi.mock("../../../audit/dlp-filter.js", () => ({
  redactForLLM: vi.fn((s: string) => ({ redacted: s, totalCount: 0, counts: {} })),
  redactFsPath: vi.fn((s: string) => s),
  redactAuditPayload: vi.fn((p: unknown) => p),
  maskSensitiveData: vi.fn((s: string) => ({ masked: s, findings: [] })),
  isPiiRedactionEnabled: vi.fn(() => false),
  initDlpAudit: vi.fn(),
  initPiiRedactionPolicy: vi.fn(),
}));
vi.mock("../../../engine/wire-serialize.js", () => ({ prepareMarkedToolResultsForWire: vi.fn((m: unknown) => m) }));
vi.mock("../../../boot/dev-flags.js", () => ({ isDevModeUnlocked: vi.fn(() => false) }));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));
vi.mock("../../../shared/chat-history.js", () => ({
  serializeHistoryMessage: vi.fn((m: unknown, i: number) => ({ ...m as object, index: i })),
}));

const SESSION_ID = "session-abc";
const TOOL_USE_ID = "tu-def456";

function makeConversationLoop(sessionId: string) {
  return {
    getSessionId: vi.fn(() => sessionId),
    getSessionProjectIsDefault: vi.fn(() => false),
    getSessionProjectContext: vi.fn(() => ({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    })),
    getSessionMemoryProjectContext: vi.fn(() => ({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
      includeUnscoped: false,
    })),
    getHistory: vi.fn(() => ({
      getMessages: vi.fn(() => []),
      truncate: vi.fn(),
    })),
    hasProvider: vi.fn(() => true),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
    abortCurrentTurn: vi.fn(),
    pingProvider: vi.fn(async () => ({
      configured: true,
      online: true,
      vendor: "openai",
      model: "gpt-4o",
      latencyMs: 1,
    })),
    resetAndResume: vi.fn(),
    manualCompact: vi.fn(),
    startRoutineConversation: vi.fn(),
    enterViewMode: vi.fn(),
    exitViewMode: vi.fn(),
    branchFromCheckpoint: vi.fn(),
    queueGuidance: vi.fn(() => "queued"),
    queueUserGuidance: vi.fn(() => "queued"),
    generateText: vi.fn(),
  };
}

function makeMinimalDeps(loop: ReturnType<typeof makeConversationLoop>) {
  return {
    conversationLoop: loop,
    settingsService: {
      get: vi.fn(() => ({ llm: { provider: "claude", vendors: { claude: {} } }, telemetry: {}, updates: {}, marketplace: {} })),
      patch: vi.fn(),
      getSecret: vi.fn(() => null),
    },
    memoryManager: {
      saveSession: vi.fn(),
      loadSession: vi.fn(() => null),
      listSessionEntries: vi.fn(() => []),
      searchSessions: vi.fn(() => []),
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryIndex: vi.fn(() => ""),
      updateMemoryIndexIfUnchanged: vi.fn(() => true),
      updateMemoryIndexSections: vi.fn(),
      getAgentsMd: vi.fn(() => ""),
      getAgentsCustomMd: vi.fn(() => ""),
      updateAgentsMd: vi.fn(),
      getUserPreferences: vi.fn(() => ""),
      updateUserPreferences: vi.fn(),
      loadSessionMetadata: vi.fn(() => null),
    },
    starredStore: null,
    feedbackStore: null,
    auditLogger: { log: vi.fn() },
    askUserQuestionGate: null,
    preferenceRefreshService: null,
    memoryConsolidationService: undefined,
    getMainWindow: vi.fn(() => null),
  };
}

const CHANNEL = "ave:chat:get-write-diff";

async function setupHandlers(loop: ReturnType<typeof makeConversationLoop>) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeMinimalDeps(loop);
  await installNativeChatWindow(deps.getMainWindow());
  registerChatHandlers(deps as any);
  return deps;
}

describe("ave:chat:get-write-diff", () => {
  beforeEach(() => {
    mockReadDiffSidecar.mockReset();
  });

  it("returns { before, after } when sidecar exists and sessionId matches", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    mockReadDiffSidecar.mockResolvedValue({ before: "old content", after: "new content" });

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: TOOL_USE_ID });
    expect(result).toEqual({ before: "old content", after: "new content" });
    expect(mockReadDiffSidecar).toHaveBeenCalledWith(SESSION_ID, TOOL_USE_ID);
  });

  it("returns null when sidecar is not found (readDiffSidecar returns null)", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    mockReadDiffSidecar.mockResolvedValue(null);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
  });

  it("returns null for unsafe sessionId (path traversal)", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: "../../etc/passwd", toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for unsafe toolUseId", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "../evil" });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for empty sessionId", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: "", toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for non-string payload fields", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: 123, toolUseId: null });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for null payload", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, null);
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });
});

describe("ave:llm:ping", () => {
  it("rejects an untrusted sender frame and does not ping the provider", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      "ave:llm:ping",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(loop.pingProvider).not.toHaveBeenCalled();
  });

  it("delegates trusted renderer requests to ConversationLoop.pingProvider", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:llm:ping");
    expect(result).toMatchObject({ configured: true, online: true });
    expect(loop.pingProvider).toHaveBeenCalledOnce();
  });
});

describe("ave:memory:long-term:refresh", () => {
  const CHANNEL = "ave:memory:long-term:refresh";
  const updated = {
    global: {
      status: "updated" as const,
      sourceCount: 2,
      consolidatedAt: "2026-08-02T00:00:00.000Z",
    },
    project: {
      status: "up-to-date" as const,
      sourceCount: 1,
      consolidatedAt: "2026-08-01T00:00:00.000Z",
    },
  };

  it("refreshes global memory plus the current project", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    const deps = await setupHandlers(loop) as any;
    const refresh = vi.fn(async () => updated);
    deps.memoryConsolidationService = { refresh };
    handlers.clear();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow(deps.getMainWindow());
    registerChatHandlers(deps);

    const result = await invokeRegisteredHandlerWithEvent(handlers, CHANNEL, hostFrameEvent());

    expect(result).toEqual({ ok: true, ...updated });
    expect(refresh).toHaveBeenCalledWith({
      reason: "manual",
      project: {
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      },
    });
  });

  it("refreshes the default project as its own project scope, not as global memory", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    loop.getSessionProjectIsDefault.mockReturnValue(true);
    loop.getSessionProjectContext.mockReturnValue({ projectRoot: "C:\\workspace\\default", projectName: "default" });
    const deps = await setupHandlers(loop) as any;
    const refresh = vi.fn(async () => updated);
    deps.memoryConsolidationService = { refresh };
    handlers.clear();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow(deps.getMainWindow());
    registerChatHandlers(deps);

    await invokeRegisteredHandlerWithEvent(handlers, CHANNEL, hostFrameEvent());

    expect(refresh).toHaveBeenCalledWith({
      reason: "manual",
      project: { projectRoot: "C:\\workspace\\default", projectName: "default" },
    });
  });

  it("returns a stable unavailable or refresh failure envelope", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    const unavailableDeps = await setupHandlers(loop) as any;

    expect(await invokeRegisteredHandlerWithEvent(handlers, CHANNEL, hostFrameEvent())).toEqual({
      ok: false,
      error: "memory-consolidation-service-unavailable",
    });

    const refresh = vi.fn(async () => {
      throw new Error("memory-sources-changed-during-consolidation");
    });
    unavailableDeps.memoryConsolidationService = { refresh };
    handlers.clear();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow();
    registerChatHandlers(unavailableDeps);

    expect(await invokeRegisteredHandlerWithEvent(handlers, CHANNEL, hostFrameEvent())).toEqual({
      ok: false,
      error: "memory-consolidation-failed",
    });
  });

  it("does not let plugin frames trigger a provider-backed consolidation", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    const deps = await setupHandlers(loop) as any;
    const refresh = vi.fn(async () => updated);
    deps.memoryConsolidationService = { refresh };
    handlers.clear();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow(deps.getMainWindow());
    registerChatHandlers(deps);

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      CHANNEL,
      foreignFrameEvent("file:///Applications/Ave.app/dist/plugin-ui-shell.html"),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("ave:memory:index:get project options", () => {
  it("keeps no-arg MEMORY.md reads global and scopes only explicit project reads", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    const deps = await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:memory:index:get");
    await invokeRegisteredHandler(handlers, "ave:memory:index:get", { projectRoot: process.cwd(), projectName: "spoofed-workspace-name" });

    expect(deps.memoryManager.getMemoryIndex).toHaveBeenNthCalledWith(1, {});
    expect(deps.memoryManager.getMemoryIndex).toHaveBeenNthCalledWith(2, {
      projectRoot: process.cwd(),
      // Default-root labels come from central authority, never renderer input.
      projectName: "default",
      includeUnscoped: true,
    });
  });
});

describe("ave:memory entries", () => {
  it("registers no candidate review or direct renderer save channel", async () => {
    await setupHandlers(makeConversationLoop(SESSION_ID));
    for (const channel of ["ave:memory:candidates:list", "ave:memory:candidates:activate", "ave:memory:candidates:delete", "ave:memory:entries:save"]) {
      expect(handlers.has(channel)).toBe(false);
    }
    expect(handlers.has("ave:memory:entries:delete")).toBe(true);
  });

  it("scopes ordinary memory deletion through the selected project and rejects an unauthorized root", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    const deps = await setupHandlers(loop);

    const rejected = await invokeRegisteredHandlerWithEvent(handlers,
      "ave:memory:entries:delete",
      hostFrameEvent(),
      "proposal.md",
      { projectRoot: "/not-an-authorized-workspace" },
    );
    const deleted = await invokeRegisteredHandlerWithEvent(handlers,
      "ave:memory:entries:delete",
      hostFrameEvent(),
      "proposal.md",
    );

    expect(rejected).toEqual({ ok: false, error: "project-not-allowed" });
    expect(deleted).toEqual({ ok: true });
    expect(deps.memoryManager.deleteMemory).toHaveBeenCalledTimes(1);
    expect(deps.memoryManager.deleteMemory).toHaveBeenCalledWith("proposal.md", {}, "user");
  });
});

describe("ave:chat:guide keyboard provenance", () => {
  it.each([
    ["no intent (a queue flush or a call without a gesture)", undefined],
    ["an intent preload did not consume (expired or reused)", { inputOrigin: "user-keyboard", userActivation: false }],
    ["a malformed intent", { userActivation: true }],
  ])("queues %s as another principal's guidance", async (_label, intent) => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    const result = await invokeRegisteredHandler(handlers, "ave:chat:guide", "shorter please", "main", intent);
    expect(result).toMatchObject({ ok: true });
    expect(loop.queueGuidance).toHaveBeenCalledWith("shorter please");
    expect(loop.queueUserGuidance).not.toHaveBeenCalled();
  });

  it("queues a guide carrying the composer gesture's consumed intent as the user's own words", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    const result = await invokeRegisteredHandler(handlers, "ave:chat:guide", "shorter please", "main", { inputOrigin: "user-keyboard", userActivation: true });
    expect(result).toMatchObject({ ok: true });
    expect(loop.queueUserGuidance).toHaveBeenCalledWith("shorter please");
    expect(loop.queueGuidance).not.toHaveBeenCalled();
  });
});
