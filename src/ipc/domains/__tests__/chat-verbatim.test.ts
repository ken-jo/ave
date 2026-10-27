import { installNativeChatWindow, invokeNativeChatHandler as invokeRegisteredHandler } from "../../../__tests__/support/native-chat-window.js";
import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { configureHostResources } from "../../../main/host-resources.js";
import path from "node:path";
import os from "node:os";
beforeAll(() => configureHostResources({ resourcePath: path.resolve("resources"), isPackaged: false }));
import { mkdirSync, realpathSync } from "node:fs";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import * as shellTasks from "../../../tools/shell-tools.js";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_FENCE_OPEN,
} from "../../../shared/mcp-resource-bounds.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
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
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));
vi.mock("../../../shared/chat-history.js", () => ({
  serializeHistoryMessage: vi.fn((m: unknown, i: number) => ({ ...m as object, index: i })),
}));
// Authorize an explicit project so metadata tests exercise the real workspace authority.
const EXPLICIT_TEST_PROJECT_ROOT = path.resolve(os.tmpdir(), "ave-explicit-project-fixture");
vi.mock("../../../permissions/permission-settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>();
  return {
    ...actual,
    readPermissionSettings: vi.fn((...args: Parameters<typeof actual.readPermissionSettings>) => {
      const real = actual.readPermissionSettings(...args);
      return {
        ...real,
        permissions: {
          ...real.permissions,
          additionalDirectories: [...(real.permissions.additionalDirectories ?? []), EXPLICIT_TEST_PROJECT_ROOT],
        },
      };
    }),
  };
});

function makeToolResultMsg(opts: {
  toolUseId: string;
  content: string;
  toolName?: string;
  compactedAt?: string;
  truncated?: {
    originalLines: number;
    originalTokens: number;
    originalBytes: number;
    trimmedAt: string;
  };
  serializedStub?: boolean;
}) {
  return {
    role: "tool_result" as const,
    toolUseId: opts.toolUseId,
    toolName: opts.toolName ?? "Read",
    content: opts.content,
    ...(opts.compactedAt !== undefined || opts.truncated !== undefined || opts.serializedStub === true
      ? {
          meta: {
            ...(opts.compactedAt !== undefined ? { compactedAt: opts.compactedAt } : {}),
            ...(opts.truncated !== undefined ? { truncated: opts.truncated } : {}),
            ...(opts.serializedStub === true ? { serializedStub: true } : {}),
          },
        }
      : {}),
  };
}

function makeConversationLoop(
  sessionId: string,
  messages: Array<ReturnType<typeof makeToolResultMsg> | Record<string, unknown>>,
) {
  const history = {
    length: messages.length,
    getMessages: vi.fn(() => messages),
    truncate: vi.fn((count: number) => {
      messages.splice(count);
      history.length = messages.length;
    }),
    restore: vi.fn((restoredMessages: typeof messages) => {
      messages.splice(0, messages.length, ...restoredMessages);
      history.length = messages.length;
    }),
  };
  return {
    getSessionId: vi.fn(() => sessionId),
    getSessionKind: vi.fn(() => "main"),
    getSessionRoutineId: vi.fn(() => null),
    getSessionRoutineTitle: vi.fn(() => null),
    // Default false models an explicit project; override for default-project cases.
    getSessionProjectIsDefault: vi.fn(() => false),
    getHistory: vi.fn(() => history),
    hasProvider: vi.fn(() => true),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    listSubAgentSessionsForOrigin: vi.fn(() => []),
    refreshProvider: vi.fn(),
    abortCurrentTurn: vi.fn(),
    resetAndResume: vi.fn(),
    manualCompact: vi.fn(),
    startRoutineConversation: vi.fn(),
  };
}

function makeMinimalDeps(
  loop: ReturnType<typeof makeConversationLoop>,
  opts: { getMainWindow?: () => unknown; personaPromptStore?: unknown; getSubAgentRunner?: () => unknown } = {},
) {
  return {
    conversationLoop: loop as any,
    settingsService: {
      get: vi.fn((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: false };
        return {};
      }),
      patch: vi.fn(async () => undefined),
    } as any,
    memoryManager: {
      listSessionsPage: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(),
      loadToolResultArtifact: vi.fn(() => null),
      loadSessionMetadata: vi.fn(() => null),
      listSubAgentSessionsForOrigin: vi.fn(() => []),
      saveSessionMetadata: vi.fn(),
      rehydrateToolResultArtifacts: vi.fn((_sessionId: string, messages: unknown[]) => messages),
      loadMainActiveSessionState: vi.fn(() => null),
      markMainActiveFresh: vi.fn(async () => undefined),
      markMainActiveResume: vi.fn(async () => undefined),
      saveSession: vi.fn(),
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      searchSessions: vi.fn(() => []),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
      listSessionEntries: vi.fn(() => []),
    } as any,
    routineEngine: undefined,
    triggerExecutor: undefined,
    starredStore: undefined,
    feedbackStore: undefined,
    auditLogger: { log: vi.fn() } as any,
    personaPromptStore: opts.personaPromptStore,
    getSubAgentRunner: opts.getSubAgentRunner,
    askUserQuestionGate: undefined,
    notificationService: undefined,
    getMainWindow: opts.getMainWindow ?? vi.fn(() => null),
  };
}

async function setupHandlers(
  loop: ReturnType<typeof makeConversationLoop>,
  opts: { getMainWindow?: () => unknown; personaPromptStore?: unknown; getSubAgentRunner?: () => unknown } = {},
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeMinimalDeps(loop, opts);
  await installNativeChatWindow(deps.getMainWindow());
  registerChatHandlers(deps as any);
  return deps;
}

class SessionMutationGate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

describe("session command controls", () => {
  it("binds list and control to the active group session and refuses malformed input", async () => {
    const loop = makeConversationLoop("commands-session", []);
    await setupHandlers(loop);
    const list = vi.spyOn(shellTasks, "listShellTasks").mockReturnValue([]);
    const control = vi.spyOn(shellTasks, "controlShellTask").mockReturnValue({ ok: true, shellId: "owned-shell" });
    try {
      expect(invokeRegisteredHandler(handlers, "ave:chat:list-shell-tasks", "main", "commands-session")).toEqual([]);
      expect(list).toHaveBeenCalledWith("commands-session");
      expect(invokeRegisteredHandler(handlers, "ave:chat:control-shell-task", "main", "commands-session", "background")).toEqual({ ok: true, shellId: "owned-shell" });
      expect(control).toHaveBeenCalledWith("commands-session", "background", undefined);
      expect(invokeRegisteredHandler(handlers, "ave:chat:control-shell-task", "main", "commands-session", "start", "foreign")).toEqual({ ok: false, error: "invalid-shell-action" });
      expect(control).toHaveBeenCalledTimes(1);
      const unauthorized = handlers.get("ave:chat:control-shell-task")!;
      expect(unauthorized({ senderFrame: { url: "https://untrusted.example" } }, "main", "commands-session", "background")).toEqual({ ok: false, error: "unauthorized-frame" });
      expect(control).toHaveBeenCalledTimes(1);
      loop.getSessionId.mockReturnValue("switched-session");
      expect(invokeRegisteredHandler(handlers, "ave:chat:control-shell-task", "main", "commands-session", "background")).toEqual({ ok: false, error: "session-changed" });
      expect(invokeRegisteredHandler(handlers, "ave:chat:list-shell-tasks", "main", "commands-session")).toEqual([]);
      expect(control).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
    } finally { list.mockRestore(); control.mockRestore(); }
  });
});

describe("ave:chat:get-verbatim-tool-result", () => {
  const CHANNEL = "ave:chat:get-verbatim-tool-result";
  const SESSION_ID = "df98a854-4084-4ba1-8fbc-f00faea193bf";

  it("returns verbatim content + lineCount for matching in-session tool_result", async () => {
    const content = "line1\nline2\nline3";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toEqual({ content, lineCount: 3 });
  });

  it("returns null when sessionId does not match active session", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "some content" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: "5f711b23-ee4f-4cbb-88e0-53b872bbda82", toolUseId: "tu-1" }, "main");
    expect(result).toBeNull();
  });

  it("returns null when toolUseId not found in history", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "some content" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-UNKNOWN" }, "main");
    expect(result).toBeNull();
  });

  it("returns null when content is already a stub (verbatim lost)", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result stripped: tool=Read, origLen=12345]",
        compactedAt: "2026-05-08T00:00:00Z",
        serializedStub: true,
      }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toBeNull();
  });

  it("returns null when content is already a host-truncated stub (verbatim lost)", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result truncated by host (Issue #902): tool=Read, originalBytes=12345]",
        truncated: {
          originalLines: 200,
          originalTokens: 5000,
          originalBytes: 12345,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
        serializedStub: true,
      }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toBeNull();
  });

  it("returns artifact content when a host-truncated disk stub is backed by a file artifact", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result truncated by host (Issue #902): tool=Read, toolUseId=tu-1, originalBytes=12345]",
      }),
    ]);
    const deps = await setupHandlers(loop);
    const artifactContent = "artifact line one\nartifact line two";
    deps.memoryManager.loadToolResultArtifact.mockReturnValue({
      toolUseId: "tu-1",
      toolName: "Read",
      content: artifactContent,
      truncated: {
        originalLines: 2,
        originalTokens: 20,
        originalBytes: artifactContent.length,
        trimmedAt: "2026-05-19T00:00:00.000Z",
      },
      sha256: "sha",
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toEqual({ content: artifactContent, lineCount: 2 });
    expect(deps.memoryManager.loadToolResultArtifact).toHaveBeenCalledWith(SESSION_ID, "tu-1");
  });

  it("returns null for non-compacted tool_result (meta.compactedAt not set)", async () => {
    // Only compacted tool results may use this IPC.
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "verbatim content no compact" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toBeNull();
  });

  it("returns verbatim for size-capped tool_result that still has in-memory content", async () => {
    const content = "verbatim capped content\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content,
        truncated: {
          originalLines: 2,
          originalTokens: 20,
          originalBytes: content.length,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toEqual({ content, lineCount: 2 });
  });

  it("returns in-memory verbatim when raw size-capped content starts with a stub prefix", async () => {
    const content = "[tool_result truncated by host but real output]\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-prefix",
        content,
        truncated: {
          originalLines: 2,
          originalTokens: 20,
          originalBytes: content.length,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-prefix" }, "main");
    expect(result).toEqual({ content, lineCount: 2 });
  });

  it("returns verbatim for compacted tool_result that still has verbatim content", async () => {
    const content = "verbatim still present\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content,
        compactedAt: "2026-05-08T01:00:00Z",
      }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" }, "main");
    expect(result).toEqual({ content, lineCount: 2 });
  });

  it("computes lineCount accurately for multi-line content", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-50", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-50" }, "main") as {
      content: string;
      lineCount: number;
    };
    expect(result).not.toBeNull();
    expect(result.lineCount).toBe(50);
    expect(result.content).toBe(content);
  });

  it("returns lineCount of 1 for single-line content", async () => {
    const content = "single line no newline";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-single", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-single" }, "main") as {
      content: string;
      lineCount: number;
    };
    expect(result).not.toBeNull();
    expect(result.lineCount).toBe(1);
  });

  it("matches the first tool_result when history has multiple messages", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user" as const, content: "hello" } as any,
      { role: "assistant" as const, content: "I'll read it" } as any,
      makeToolResultMsg({ toolUseId: "tu-A", content: "content-A", compactedAt: "2026-05-08T00:00:00Z" }),
      makeToolResultMsg({ toolUseId: "tu-B", content: "content-B", compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const resultA = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-A" }, "main");
    const resultB = invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-B" }, "main");
    expect((resultA as any).content).toBe("content-A");
    expect((resultB as any).content).toBe("content-B");
  });
});

describe("ave:chat:get-sub-agent-transcript", () => {
  const CHANNEL = "ave:chat:get-sub-agent-transcript";
  const SESSION_ID = "df98a854-4084-4ba1-8fbc-f00faea193bf";

  it("returns the shared unavailable code when no sub-agent runner is configured", async () => {
    const loop = makeConversationLoop(SESSION_ID, []);
    const deps = await setupHandlers(loop);
    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    }, "main");

    expect(result).toEqual({ ok: false, error: "sub-agent-runner-unavailable" });
    expect(deps.memoryManager.rehydrateToolResultArtifacts).not.toHaveBeenCalled();
  });

  function makeAgentSpawnMessages() {
    return [
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "tu-agent",
            name: "agent_spawn",
            input: { title: "Research", instructions: "collect", resumeId: "sub-6e7c039b-33d44823-24c4-43ce-8492-9c72860b19e1" },
          },
        ],
      },
      {
        role: "tool_result" as const,
        toolUseId: "tu-agent",
        toolName: "agent_spawn",
        content: JSON.stringify({
          spawnId: "spawn-live",
          childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
          summary: "done",
        }),
      },
    ];
  }

  it("hydrates only when the active parent transcript contains the requested sub-agent reference", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
      messages: [{ role: "assistant", content: "done" }],
    }));
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    }, "main");

    expect(result).toEqual({
      ok: true,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
      messages: [{ role: "assistant", content: "done" }],
    });
    expect(getPersistedTranscript).toHaveBeenCalledWith({
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    });
  });

  it("rejects toolUseId/spawnId-only requests instead of reconstructing a legacy child lookup", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      toolUseId: "tu-agent",
      spawnId: "spawn-live",
    }, "main");

    expect(result).toEqual({ ok: false, error: "invalid-child-session-id" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("uses childSessionId alone when a grouped sub-agent row has a direct child link", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
      messages: [{ role: "assistant", content: "done" }],
    }));
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    }, "main");

    expect(result).toEqual({
      ok: true,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
      messages: [{ role: "assistant", content: "done" }],
    });
    expect(getPersistedTranscript).toHaveBeenCalledWith({
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    });
  });

  it("uses artifact-rehydrated parent agent_spawn handles for the childSessionId gate", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "sub-6e7c039b-5edf391c-3311-4102-8f7e-ff9f491ec606",
      messages: [{ role: "assistant", content: "artifact-backed child transcript" }],
    }));
    const messages = makeAgentSpawnMessages();
    messages[0] = {
      ...(messages[0] as any),
      toolCalls: [
        {
          id: "tu-agent",
          name: "agent_spawn",
          input: { title: "Research", instructions: "collect" },
        },
      ],
    };
    messages[1] = {
      ...(messages[1] as any),
      content: "[tool_result stripped: tool=agent_spawn, origLen=2048]",
    };
    const loop = makeConversationLoop(SESSION_ID, messages);
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });
    deps.memoryManager.rehydrateToolResultArtifacts.mockImplementation((_sessionId: string, raw: unknown[]) =>
      raw.map((message) =>
        (message as any).role === "tool_result" && (message as any).toolUseId === "tu-agent"
          ? {
              ...(message as any),
              content: JSON.stringify({
                childSessionId: "sub-6e7c039b-5edf391c-3311-4102-8f7e-ff9f491ec606",
                summary: "done",
              }),
            }
          : message,
      ),
    );

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-5edf391c-3311-4102-8f7e-ff9f491ec606",
    }, "main");

    expect(deps.memoryManager.rehydrateToolResultArtifacts).toHaveBeenCalledWith(SESSION_ID, expect.any(Array));
    expect(result).toEqual({
      ok: true,
      childSessionId: "sub-6e7c039b-5edf391c-3311-4102-8f7e-ff9f491ec606",
      messages: [{ role: "assistant", content: "artifact-backed child transcript" }],
    });
  });


  it("rejects requests for a non-active parent session before runner lookup", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: "5f711b23-ee4f-4cbb-88e0-53b872bbda82",
      childSessionId: "sub-6e7c039b-1ae80cfb-d8c8-4a02-806d-4f4d2872a62d",
    }, "main");

    expect(result).toEqual({ ok: false, error: "origin-session-not-active" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("rejects an unrelated childSessionId", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invokeRegisteredHandler(handlers, CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "sub-6e7c039b-cafeb2d0-9bb2-4190-8f4f-26b2ebe2e507",
    }, "main");

    expect(result).toEqual({ ok: false, error: "sub-agent-reference-not-found" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
  });
});

describe("ave:chat active main state", () => {
  it("marks fresh state when a new main chat starts", async () => {
    const loop = makeConversationLoop("d1c00b95-b0af-4bd6-8179-4210161fffc3", []);
    const deps = await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main");

    expect(loop.newConversation).toHaveBeenCalled();
    expect(deps.memoryManager.markMainActiveFresh).toHaveBeenCalledTimes(1);
  });

  it("does NOT persist project metadata for a plain new chat (no explicit project — the default binding)", async () => {
    // Default-directory tool access must not label new sessions with an explicit project.
    const loop = makeConversationLoop("d1c00b95-b0af-4bd6-8179-4210161fffc3", []);
    const deps = await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main");

    expect(deps.memoryManager.saveSessionMetadata).not.toHaveBeenCalled();
  });

  it("persists the resolved project identity when the user explicitly selects a real project", async () => {
    // Explicit project selection persists metadata at creation for immediate project grouping.
    mkdirSync(EXPLICIT_TEST_PROJECT_ROOT, { recursive: true });
    const explicitProjectRoot = realpathSync(EXPLICIT_TEST_PROJECT_ROOT);
    const loop = makeConversationLoop("d1c00b95-b0af-4bd6-8179-4210161fffc3", []);
    const deps = await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:chat:new", { projectRoot: explicitProjectRoot, projectName: "spoofed-project-name" }, "main");

    expect(deps.memoryManager.saveSessionMetadata).toHaveBeenCalledTimes(1);
    const [savedId, savedMeta] = (deps.memoryManager.saveSessionMetadata as any).mock.calls[0];
    expect(savedId).toBe("d1c00b95-b0af-4bd6-8179-4210161fffc3");
    // Compare roots without slash/case sensitivity because authorization normalizes them.
    expect(savedMeta.sessionKind).toBe("main");
    // Persist the registry-owned display name; renderer labels cannot choose project identity.
    expect(savedMeta.projectName).toBe(path.basename(explicitProjectRoot));
    expect((savedMeta.projectRoot as string).toLowerCase().replace(/\\/g, "/")).toBe(
      explicitProjectRoot.toLowerCase().replace(/\\/g, "/"),
    );
  });

  it("marks explicit main session resume but ignores routine session resume", async () => {
    const mainLoop = makeConversationLoop("8ce2040c-ee54-4799-8044-8683bfd037ae", []);
    mainLoop.resetAndResume.mockReturnValue({ ok: true });
    const mainDeps = await setupHandlers(mainLoop);

    await invokeRegisteredHandler(handlers, "ave:chat:session-resume", "8ce2040c-ee54-4799-8044-8683bfd037ae", "main");

    expect(mainDeps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("8ce2040c-ee54-4799-8044-8683bfd037ae");

    const routineLoop = makeConversationLoop("5b31b09a-de06-4171-8492-94fbff746a81", []);
    routineLoop.getSessionKind.mockReturnValue("routine");
    routineLoop.resetAndResume.mockReturnValue({ ok: true });
    const routineDeps = await setupHandlers(routineLoop);

    await invokeRegisteredHandler(handlers, "ave:chat:session-resume", "5b31b09a-de06-4171-8492-94fbff746a81", "main");

    expect(routineDeps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
  });

  it("rejects unsafe session ids before resuming", async () => {
    const loop = makeConversationLoop("8ce2040c-ee54-4799-8044-8683bfd037ae", []);
    const deps = await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:chat:session-resume", "../evil", "main") as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(loop.resetAndResume).not.toHaveBeenCalled();
    expect(deps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
  });

  it("marks main active after main turns but not after routine turns", async () => {
    const mainLoop = makeConversationLoop("8ce2040c-ee54-4799-8044-8683bfd037ae", [{ role: "user", content: "existing" }]);
    mainLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const mainDeps = await setupHandlers(mainLoop);

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "next",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(mainDeps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("8ce2040c-ee54-4799-8044-8683bfd037ae");

    const routineLoop = makeConversationLoop("5b31b09a-de06-4171-8492-94fbff746a81", [{ role: "user", content: "existing" }]);
    routineLoop.getSessionKind.mockReturnValue("routine");
    routineLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const routineDeps = await setupHandlers(routineLoop);

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "continue routine",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(routineDeps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
    expect(routineDeps.memoryManager.markMainActiveFresh).not.toHaveBeenCalled();
  });
});

describe("ave:chat:session-history parent provenance", () => {
  it("does not load or merge the parent transcript when a child has parentSessionId", async () => {
    const loop = makeConversationLoop("a3386854-f241-42c9-8979-fd37d7cb633f", []);
    const deps = await setupHandlers(loop);
    deps.memoryManager.loadSession.mockImplementation((sessionId: string) => {
      if (sessionId === "sub-8410443e-3e323a73-28d0-4dce-8229-3b0eca68d32a") {
        return [{ role: "user", content: "child only" }];
      }
      if (sessionId === "a1bdc27a-c758-4a74-8955-5e9188412366") {
        return [{ role: "user", content: "parent should not render" }];
      }
      return [];
    });
    deps.memoryManager.loadSessionMetadata.mockReturnValue({
      parentSessionId: "a1bdc27a-c758-4a74-8955-5e9188412366",
      summaryPreamble: "요약된 부모 맥락",
      title: "Child",
    });

    const result = await invokeRegisteredHandler(handlers, "ave:chat:session-history", "sub-8410443e-3e323a73-28d0-4dce-8229-3b0eca68d32a") as {
      ok: boolean;
      messages: Array<{ content: string }>;
      preambleChars?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.messages.map((message) => message.content)).toEqual(["child only"]);
    expect(result.preambleChars).toBe("요약된 부모 맥락".length);
    expect(deps.memoryManager.loadSession).toHaveBeenCalledTimes(1);
    expect(deps.memoryManager.loadSession).toHaveBeenCalledWith("sub-8410443e-3e323a73-28d0-4dce-8229-3b0eca68d32a");
    expect(deps.memoryManager.loadSession).not.toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366");
  });
});

describe("ave:chat:fork", () => {
  it("carries the active rolling summary preamble into a normal fork", async () => {
    const loop = makeConversationLoop("02bde5ab-2204-4072-8851-84a51c4ff368", [
      { role: "user", content: "old context" },
      { role: "assistant", content: "old answer" },
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    deps.memoryManager.loadSessionMetadata.mockReturnValue({
      sessionKind: "main",
      summaryPreamble: "요약된 이전 맥락",
    });

    const result = await invokeRegisteredHandler(handlers, "ave:chat:fork", undefined, "main") as { ok: boolean; sessionId: string | null };

    expect(result.ok).toBe(true);
    expect(result.sessionId).toEqual(expect.any(String));
    expect(deps.memoryManager.saveSessionMetadata).toHaveBeenCalledWith(
      result.sessionId,
      expect.objectContaining({
        sessionKind: "main",
        summaryPreamble: "요약된 이전 맥락",
      }),
    );
  });

  it("rehydrates artifact-backed tool_result stubs before saving a forked session", async () => {
    const compactedResultText = "[tool_result truncated by host (Issue #902): tool=long_output_query, toolUseId=\"tu-art\", originalBytes=12000]";
    const rawContent = "artifact-backed result\n".repeat(120);
    const loop = makeConversationLoop("02bde5ab-2204-4072-8851-84a51c4ff368", [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "tu-art", name: "long_output_query", input: {} }] },
      makeToolResultMsg({
        toolUseId: "tu-art",
        toolName: "long_output_query",
        content: compactedResultText,
      }),
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    deps.memoryManager.rehydrateToolResultArtifacts.mockImplementation((_sessionId: string, messages: unknown[]) =>
      messages.map((message) => {
        if ((message as { role?: string; toolUseId?: string }).role !== "tool_result") return message;
        return {
          ...message as Record<string, unknown>,
          content: rawContent,
          meta: {
            truncated: {
              originalLines: 120,
              originalTokens: 2000,
              originalBytes: rawContent.length,
              trimmedAt: "2026-05-19T00:00:00.000Z",
            },
          },
        };
      }),
    );

    const result = await invokeRegisteredHandler(handlers, "ave:chat:fork", undefined, "main") as { ok: boolean; sessionId: string | null };

    expect(result.ok).toBe(true);
    expect(deps.memoryManager.rehydrateToolResultArtifacts).toHaveBeenCalledWith(
      "02bde5ab-2204-4072-8851-84a51c4ff368",
      expect.arrayContaining([expect.objectContaining({ toolUseId: "tu-art", content: compactedResultText })]),
    );
    expect(deps.memoryManager.saveSession).toHaveBeenCalledWith(
      result.sessionId,
      expect.arrayContaining([expect.objectContaining({ toolUseId: "tu-art", content: rawContent })]),
    );
  });

  it("holds a session-mutation lease across fork persistence awaits", async () => {
    const loop = makeConversationLoop("02bde5ab-2204-4072-8851-84a51c4ff368", [
      { role: "user", content: "source prompt" },
      { role: "assistant", content: "source answer" },
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    const firstSaveEntered = new SessionMutationGate<void>();
    const firstSaveGate = new SessionMutationGate<void>();
    let saveCallCount = 0;
    deps.memoryManager.saveSession.mockImplementation(async () => {
      saveCallCount += 1;
      if (saveCallCount === 1) {
        firstSaveEntered.resolve(undefined);
        await firstSaveGate.promise;
      }
    });

    const forkPromise = invokeRegisteredHandler(handlers, "ave:chat:fork", undefined, "main") as Promise<unknown>;

    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "must not enter fork",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main")).resolves.toEqual({ error: "streaming-active" });

    await firstSaveEntered.promise;
    await expect(invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });
    await expect(invokeRegisteredHandler(handlers, "ave:chat:session-resume", "02bde5ab-2204-4072-8851-84a51c4ff368", "main")).resolves.toEqual(
      expect.objectContaining({ ok: false, error: "streaming-active" }),
    );
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.newConversation).not.toHaveBeenCalled();
    expect(loop.resetAndResume).not.toHaveBeenCalled();

    firstSaveGate.resolve(undefined);
    await expect(forkPromise).resolves.toEqual({
      ok: true,
      sessionId: expect.any(String),
    });
  });
});

describe("ave:chat:continue-last-user", () => {
  const CHANNEL = "ave:chat:continue-last-user";
  const SESSION_ID = "00e839f0-e00d-4caf-8f28-2eceb20d8bfe";

  it("rejects stale session ids before replaying the last user turn", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user", content: "question" },
    ]);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: "5f711b23-ee4f-4cbb-88e0-53b872bbda82" }, "main");

    expect(result).toEqual({ ok: false, error: "session-mismatch" });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.getHistory().truncate).not.toHaveBeenCalled();
  });

  it("fails closed when the active session no longer ends with a user message", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID }, "main");

    expect(result).toEqual({ ok: false, error: "last-message-not-user" });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.getHistory().truncate).not.toHaveBeenCalled();
  });

  it("restores the terminal user message when turn startup fails", async () => {
    const terminalUser = { role: "user", content: "question" };
    const loop = makeConversationLoop(SESSION_ID, [terminalUser]);
    loop.runTurn.mockRejectedValueOnce(new Error("provider missing"));
    await setupHandlers(loop);
    const history = loop.getHistory();

    await expect(invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID }, "main")).rejects.toThrow("provider missing");

    expect(history.truncate).toHaveBeenCalledWith(0);
    expect(history.restore).toHaveBeenCalledWith([terminalUser]);
    expect(history.getMessages()).toEqual([terminalUser]);
  });

  it("resumes a turn the app's exit cut short from its persisted rows, without truncating or re-asking", async () => {
    const persisted = [
      { role: "user", content: "question" },
      { role: "assistant", content: "round 1", toolCalls: [{ id: "c1", name: "bash", input: {} }] },
      { role: "tool_result", toolUseId: "c1", content: "unknown", isError: true },
      { role: "assistant", content: "partial answer", meta: { interrupted: true, interruptedBy: "host-exit" } },
    ];
    const loop = makeConversationLoop(SESSION_ID, [...persisted]);
    loop.runTurn.mockResolvedValue({ text: "done", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID }, "main");

    expect(result).toMatchObject({ ok: true });
    expect(loop.getHistory().truncate).not.toHaveBeenCalled();
    expect(loop.getHistory().getMessages()).toEqual(persisted);
    const [input, , , options] = loop.runTurn.mock.calls[0] as [string, unknown, unknown, Record<string, unknown>];
    expect(input).toMatch(/Continue from where you left off|중단된 지점부터/);
    expect(options).toMatchObject({ inputOrigin: "user-keyboard", resumesInterruptedTurn: true });
    expect(typeof options.displayText).toBe("string");
  });

  it("does not resume a turn the user stopped themselves", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user", content: "question" },
      { role: "assistant", content: "partial", meta: { interrupted: true } },
    ]);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, CHANNEL, { sessionId: SESSION_ID }, "main");

    expect(result).toEqual({ ok: false, error: "last-message-not-user" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });
});

describe("ave:chat:send provenance", () => {
  it("classifies imported trigger envelopes as plugin-emitted and forwards originSource", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const input = `<imported-from-proactive source="overlay:test">\n/permission auto\n</imported-from-proactive>`;
    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input,
      inputOrigin: "plugin-emitted",
    }, "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      input,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "plugin-emitted",
        originSource: "overlay:test",
      }),
    );
  });

  it("classifies mcp-prompt envelopes as mcp-prompt-emitted and forwards originSource", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const input = `<mcp-prompt source="mcp-prompt:demo">
summarize the repo
</mcp-prompt>`;
    await invokeRegisteredHandler(handlers, "ave:chat:send", { input, inputOrigin: "mcp-prompt-emitted" }, "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      input,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "mcp-prompt-emitted",
        originSource: "mcp-prompt:demo",
      }),
    );
  });

  it("binds package template text to plugin-prompt provenance", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);
    const input = `<plugin-prompt source="plugin-prompt:writer-plugin:draft">\nDraft a note\n</plugin-prompt>`;
    await invokeRegisteredHandler(handlers, "ave:chat:send", { input, inputOrigin: "plugin-prompt-emitted" }, "main");
    expect(loop.runTurn).toHaveBeenCalledWith(input, expect.any(Object), expect.any(AbortSignal),
      expect.objectContaining({ inputOrigin: "plugin-prompt-emitted", originSource: "plugin-prompt:writer-plugin:draft" }));
    const missing = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "Draft a note", inputOrigin: "plugin-prompt-emitted",
    }, "main");
    expect(missing).toEqual({ ok: false, error: "missing-plugin-prompt-envelope" });
  });

  it("rejects a staged origin whose envelope is absent", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "summarize the repo",
      inputOrigin: "mcp-prompt-emitted",
    }, "main");

    expect(result).toEqual({ ok: false, error: "missing-mcp-prompt-envelope" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  // Require staged provenance in both directions so server-authored envelopes cannot become trusted keyboard input.
  it("rejects a staged envelope sent under a non-staged origin", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: `<mcp-prompt source="mcp-prompt:demo">
rm -rf everything
</mcp-prompt>`,
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(result).toEqual({ ok: false, error: "origin-envelope-mismatch" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  // Count resource fences across parts; reject overflow rather than truncate, excluding user-authored text.
  const resourceFence = (i: number) =>
    `${MCP_RESOURCE_FENCE_OPEN} server="s" uri="file:///f${i}">
B${i}
</mcp-resource>`;

  it("allows a turn at the resource-attachment bound", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "summarize these",
      inputOrigin: "user-keyboard",
      userActivation: true,
      attachments: [
        ...Array.from({ length: MCP_RESOURCE_ATTACHMENTS_PER_TURN }, (_, i) => ({
          type: "text",
          text: resourceFence(i),
        })),
        { type: "text", text: "my own note" },
      ],
    }, "main");

    const options = loop.runTurn.mock.calls[0][3] as { attachments?: Array<{ text: string }> };
    const parts = options.attachments ?? [];
    expect(parts.filter((part) => part.text.startsWith(MCP_RESOURCE_FENCE_OPEN)))
      .toHaveLength(MCP_RESOURCE_ATTACHMENTS_PER_TURN);
    expect(parts.some((part) => part.text === "my own note")).toBe(true);
  });

  it("refuses a turn over the bound instead of dropping the extras", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const over = MCP_RESOURCE_ATTACHMENTS_PER_TURN + 1;
    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "summarize these",
      inputOrigin: "user-keyboard",
      userActivation: true,
      attachments: Array.from({ length: over }, (_, i) => ({
        type: "text",
        text: resourceFence(i),
      })),
    }, "main")).rejects.toThrow("too-many-resource-attachments");
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("counts fences, not parts, so joining them into one part is not a bypass", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const joined = Array.from({ length: 12 }, (_, i) => resourceFence(i)).join("\n\n");
    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "summarize these",
      inputOrigin: "user-keyboard",
      userActivation: true,
      attachments: [{ type: "text", text: joined }],
    }, "main")).rejects.toThrow("too-many-resource-attachments");
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  // Attachment limits apply to host-attached resources; user-pasted fences remain ordinary text.
  it("never refuses a turn for fences the user typed themselves", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const pasted = Array.from({ length: 12 }, (_, i) => resourceFence(i)).join("\n\n");
    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: `why were these ignored?\n\n${pasted}`,
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(result).not.toMatchObject({ ok: false });
    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    expect(loop.runTurn.mock.calls[0][0]).toContain(MCP_RESOURCE_FENCE_OPEN);
  });

  it("rejects chat sends that omit explicit inputOrigin", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", { input: "/permission auto" }, "main");

    expect(result).toEqual({ ok: false, error: "missing-input-origin" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("rejects user-keyboard chat sends without an active user gesture", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    await setupHandlers(loop);

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "/permission reviewer mode disabled",
      inputOrigin: "user-keyboard",
    }, "main");

    expect(result).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("accepts user-keyboard chat sends only with an active user gesture", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ inputOrigin: "user-keyboard" }),
    );
  });

  it("resolves personaPromptId through PersonaPromptStore at the chat boundary", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "reviewer",
    }, "main");

    expect(personaPromptStore.get).toHaveBeenCalledWith("reviewer");
    expect(loop.runTurn).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
      }),
    );
  });

  it("preserves package persona provenance only for keyboard sends", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const origin = { kind: "agent-plugin" as const, package: "writer-plugin", version: "1.0.0" };
    const personaPromptStore = { get: vi.fn(async () => ({
      id: "agent-plugin:writer-plugin:reviewer",
      name: "reviewer (writer-plugin)",
      systemPromptAdd: "Review the draft.", origin,
    })) };
    await setupHandlers(loop, { personaPromptStore });
    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "hello", inputOrigin: "user-keyboard", userActivation: true,
      personaPromptId: "agent-plugin:writer-plugin:reviewer",
    }, "main");
    expect(loop.runTurn).toHaveBeenCalledWith("hello", expect.any(Object), expect.any(AbortSignal),
      expect.objectContaining({ rolePrompt: expect.objectContaining({ origin }) }));
    const rejected = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "queued", inputOrigin: "queue-auto", personaPromptId: "agent-plugin:writer-plugin:reviewer",
    }, "main");
    expect(rejected).toEqual({ ok: false, error: "persona-prompt-origin-restricted" });
    expect(personaPromptStore.get).toHaveBeenCalledTimes(1);
  });

  it("rejects the original input when the session changes during persona resolution", async () => {
    const loop = makeConversationLoop("4bd6ffd9-1846-440d-8323-0d5d600848d7", []);
    const personaEntered = new SessionMutationGate<void>();
    const personaGate = new SessionMutationGate<{
      id: string;
      name: string;
      systemPromptAdd: string;
    }>();
    const personaPromptStore = {
      get: vi.fn(() => {
        personaEntered.resolve(undefined);
        return personaGate.promise;
      }),
    };
    const runner = {
      peekParentMailbox: vi.fn(),
      acknowledgeParentMailbox: vi.fn(),
    };
    await setupHandlers(loop, {
      personaPromptStore,
      getSubAgentRunner: () => runner,
    });

    const sendPromise = invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "must stay in the original session",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "reviewer",
    }, "main") as Promise<unknown>;

    await personaEntered.promise;
    loop.getSessionId.mockReturnValue("9eebb178-4d79-433a-887e-68f286fcff1b");
    personaGate.resolve({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Current file prompt.",
    });

    await expect(sendPromise).resolves.toEqual({
      ok: false,
      error: "session-mismatch",
    });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
  });
  it("fails closed when selected personaPromptId is missing from the prompt store", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    const personaPromptStore = { get: vi.fn(async () => null) };
    await setupHandlers(loop, { personaPromptStore });

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "deleted",
    }, "main");

    expect(result).toEqual({ ok: false, error: "persona-prompt-not-found" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("rejects personaPromptId on queue-auto chat sends", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    const personaPromptStore = { get: vi.fn() };
    await setupHandlers(loop, { personaPromptStore });

    const result = await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "queued follow-up",
      inputOrigin: "queue-auto",
      personaPromptId: "reviewer",
    }, "main");

    expect(result).toEqual({ ok: false, error: "persona-prompt-origin-restricted" });
    expect(personaPromptStore.get).not.toHaveBeenCalled();
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("forwards permission mode change callbacks to the chat stream", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockImplementation(async (_input, callbacks) => {
      callbacks.onPermissionModeChanged("allow");
      return { text: "ok", toolCalls: [], stopReason: "end_turn" };
    });
    await setupHandlers(loop, {
      getMainWindow: () => ({
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      }),
    });

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "/permission mode allow",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(sent).toContainEqual({
      channel: "ave:chat:stream",
      payload: expect.objectContaining({
        type: "permission_mode_changed",
        mode: "allow",
        streamId: 1,
      }),
    });
  });

  it("keeps chat send alive when the renderer stream target is destroyed mid-turn", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", []);
    loop.runTurn.mockImplementation(async (_input, callbacks) => {
      callbacks.onTextDelta("before");
      callbacks.onError("permission deferred");
      return { text: "ok", toolCalls: [], stopReason: "end_turn" };
    });
    const send = vi.fn((channel: string, payload: unknown) => {
      if ((payload as { type?: string }).type === "error") {
        throw new TypeError("Object has been destroyed");
      }
      sent.push({ channel, payload });
    });
    await setupHandlers(loop, {
      getMainWindow: () => ({
        webContents: {
          isDestroyed: () => false,
          send,
        },
      }),
    });

    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main") as Promise<unknown>).resolves.toEqual({ text: "ok", toolCalls: [], stopReason: "end_turn" });

    expect(sent).toEqual([
      {
        channel: "ave:chat:stream",
        payload: expect.objectContaining({ type: "user_message", text: "hello", origin: "user-keyboard", streamId: 1 }),
      },
      {
        channel: "ave:chat:stream",
        payload: expect.objectContaining({ type: "text_delta", text: "before", streamId: 1 }),
      },
      {
        channel: "ave:chat:stream",
        payload: expect.objectContaining({ type: "suggested_replies", reply: null, streamId: 1 }),
      },
      {
        channel: "ave:chat:stream",
        payload: expect.objectContaining({ type: "done", streamId: 1 }),
      },
    ]);
  });

  it("resolves stored persona prompt id when edit-resending a user message", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", [
      {
        role: "user",
        content: "old text",
        meta: {
          messageId: "row-old-text",
          activePersonaPrompt: {
            id: "reviewer",
            name: "Reviewer",
          },
        },
      },
      { role: "assistant", content: "old answer", meta: { messageId: "row-old-answer" } },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invokeRegisteredHandler(handlers, "ave:chat:edit-resend", "row-old-text", "new text", "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "new text",
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
      }),
    );
  });

  it("redacts raw edit-resend and legacy resource replay content at the shared provider boundary", async () => {
    const redactPii = async () => {
      const dlp = await import("../../../audit/dlp-filter.js");
      const redactForLLM = vi.mocked(dlp.redactForLLM);
      redactForLLM.mockImplementation((text: string) => {
        const emailHits = text.match(/alice@example\.com/g)?.length ?? 0;
        const phoneHits = text.match(/010-1234-5678/g)?.length ?? 0;
        const counts: Record<string, number> = {};
        if (emailHits > 0) counts.EMAIL = emailHits;
        if (phoneHits > 0) counts.PHONE_KR = phoneHits;
        return {
          redacted: text
            .replaceAll("alice@example.com", "[REDACTED:EMAIL]")
            .replaceAll("010-1234-5678", "[REDACTED:PHONE]"),
          totalCount: emailHits + phoneHits,
          counts,
        };
      });
      return () => {
        redactForLLM.mockImplementation((text: string) => ({
          redacted: text,
          totalCount: 0,
          counts: {},
        }));
      };
    };
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const send = vi.fn((channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    });

    const editLoop = makeConversationLoop("10231d68-969e-4fcd-82e5-ce6830158729", [
      { role: "user", content: "old text", meta: { messageId: "row-old-text" } },
      { role: "assistant", content: "old answer", meta: { messageId: "row-old-answer" } },
    ]);
    editLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const editDeps = await setupHandlers(editLoop, {
      getMainWindow: () => ({ webContents: { isDestroyed: () => false, send } }),
    });
    editDeps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "llm") return fakeLlmSettings();
      if (key === "privacy") return { piiRedactEnabled: true };
      return {};
    });
    const restoreRedactor = await redactPii();

    try {
      await invokeRegisteredHandler(handlers, "ave:chat:edit-resend", "row-old-text", "contact alice@example.com", "main");

      expect(editLoop.runTurn.mock.calls[0]?.[0]).toBe("contact [REDACTED:EMAIL]");
      expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "redact_notice"))
        .toEqual([
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 1, byKind: { EMAIL: 1 }, chatGroupId: "main" },
          },
        ]);

      const image = { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" };
      const rawFence =
        '<mcp-resource trust="untrusted-server-data" uri="mcp://alice@example.com/resource">contact alice@example.com</mcp-resource>';
      const replayLoop = makeConversationLoop("f7b2cd7d-a877-45aa-8b50-756c10ca2d0c", [
        { role: "assistant", content: "earlier" },
        {
          role: "user",
          content: [
            { type: "text", text: "summarize [Resource #1]" },
            { type: "text", text: rawFence },
            image,
          ],
        },
      ]);
      replayLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
      const replayDeps = await setupHandlers(replayLoop, {
        getMainWindow: () => ({ webContents: { isDestroyed: () => false, send } }),
      });
      replayDeps.settingsService.get.mockImplementation((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: true };
        return {};
      });

      await invokeRegisteredHandler(handlers, "ave:chat:continue-last-user", { sessionId: "f7b2cd7d-a877-45aa-8b50-756c10ca2d0c" }, "main");

      const replayInput = replayLoop.runTurn.mock.calls[0]?.[0] as string;
      const replayOptions = replayLoop.runTurn.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(replayInput).not.toContain("alice@example.com");
      expect(replayInput).toContain("[REDACTED:EMAIL]");
      expect(replayInput).toContain("<mcp-resource");
      expect(replayInput).toContain("</mcp-resource>");
      expect(replayOptions.attachments).toEqual([image]);
      expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "redact_notice"))
        .toEqual([
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 1, byKind: { EMAIL: 1 }, chatGroupId: "main" },
          },
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 2, byKind: { EMAIL: 2 }, chatGroupId: "main" },
          },
        ]);

      const stagedLoop = makeConversationLoop("1a75feb0-5469-4d73-8f2e-484c2e309d77", [
        {
          role: "user",
          content: '<app-message source="app:010-1234-5678">\\nstaged body\\n</app-message>',
        },
      ]);
      stagedLoop.runTurn.mockResolvedValue({ text: "must not run", toolCalls: [], stopReason: "end_turn" });
      const stagedDeps = await setupHandlers(stagedLoop, {
        getMainWindow: () => ({ webContents: { isDestroyed: () => false, send } }),
      });
      stagedDeps.settingsService.get.mockImplementation((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: true };
        return {};
      });

      // If DLP destroys the source header, replay must fail closed rather than infer keyboard provenance.
      await expect(invokeRegisteredHandler(handlers, "ave:chat:continue-last-user", { sessionId: "1a75feb0-5469-4d73-8f2e-484c2e309d77" }, "main"))
        .rejects.toThrow("missing-app-envelope");
      expect(stagedLoop.runTurn).not.toHaveBeenCalled();
      expect(sent.filter(({ payload }) => (payload as { type?: string }).type === "redact_notice"))
        .toEqual([
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 1, byKind: { EMAIL: 1 }, chatGroupId: "main" },
          },
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 2, byKind: { EMAIL: 2 }, chatGroupId: "main" },
          },
          {
            channel: CHANNELS.chat.stream,
            payload: { type: "redact_notice", count: 1, byKind: { PHONE_KR: 1 }, chatGroupId: "main" },
          },
        ]);
    } finally {
      restoreRedactor();
    }
  });

  it("restores edit-resend and retry history when staged-header redaction fails closed", async () => {
    const dlp = await import("../../../audit/dlp-filter.js");
    const redactForLLM = vi.mocked(dlp.redactForLLM);
    redactForLLM.mockImplementation((text: string) => {
      const phoneHits = text.match(/010-1234-5678/g)?.length ?? 0;
      const counts: Record<string, number> = phoneHits > 0 ? { PHONE_KR: phoneHits } : {};
      return {
        redacted: text.replaceAll("010-1234-5678", "[REDACTED:PHONE]"),
        totalCount: phoneHits,
        counts,
      };
    });
    const stagedInput = '<app-message source="app:010-1234-5678">\\nstaged body\\n</app-message>';
    const original = [
      { role: "user", content: "existing user text", meta: { messageId: "row-existing-user" } },
      { role: "assistant", content: "existing assistant text", meta: { messageId: "row-existing-assistant" } },
    ];

    try {
      const editLoop = makeConversationLoop("3955cc67-b1d0-4ed9-8960-b8f6ae2ded0c", [...original]);
      const editDeps = await setupHandlers(editLoop);
      editDeps.settingsService.get.mockImplementation((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: true };
        return {};
      });

      await expect(invokeRegisteredHandler(handlers, "ave:chat:edit-resend", "row-existing-user", stagedInput, "main"))
        .rejects.toThrow("missing-app-envelope");
      expect(editLoop.runTurn).not.toHaveBeenCalled();
      expect(editLoop.getHistory().restore).toHaveBeenCalledWith(original);
      expect(editLoop.getHistory().getMessages()).toEqual(original);

      const retryLoop = makeConversationLoop("e325b22e-ab7b-4cd5-8835-a98b63689506", [
        { role: "user", content: stagedInput },
        { role: "assistant", content: "existing assistant text" },
      ]);
      const retryOriginal = [...retryLoop.getHistory().getMessages()];
      const retryDeps = await setupHandlers(retryLoop);
      retryDeps.settingsService.get.mockImplementation((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: true };
        return {};
      });

      await expect(invokeRegisteredHandler(handlers, "ave:chat:retry-effort", { enableThinking: true }, "main"))
        .rejects.toThrow("missing-app-envelope");
      expect(retryLoop.runTurn).not.toHaveBeenCalled();
      expect(retryLoop.getHistory().restore).toHaveBeenCalledWith(retryOriginal);
      expect(retryLoop.getHistory().getMessages()).toEqual(retryOriginal);
    } finally {
      redactForLLM.mockImplementation((text: string) => ({
        redacted: text,
        totalCount: 0,
        counts: {},
      }));
    }
  });

  it.each([
    [32_000, undefined, 16_000],
    [32_000, 20_000, 16_000],
    [32_000, 14_000, 14_000],
    [16_000, undefined, 8_000],
    [16_000, 32_000, 8_000],
    [64_000, undefined, 32_000],
    [32_001, undefined, 32_000],
    [32_000, "32000", 8_000],
  ])("bounds retry thinking with output %i and input %s, then restores settings", async (outputTokenLimit, thinkingBudgetTokens, expected) => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", [
      { role: "user", content: "retry text" }, { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const deps = await setupHandlers(loop);
    const llm = fakeLlmSettings({ outputTokenLimit });
    llm.vendors.openai.thinkingBudgetTokens = Math.min(14_000, Math.floor(outputTokenLimit / 2));
    const originalGet = deps.settingsService.get.getMockImplementation();
    deps.settingsService.get.mockImplementation((key?: string) => key === "llm" ? llm : originalGet(key));
    await invokeRegisteredHandler(handlers, "ave:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens }, "main");
    expect(deps.settingsService.patch).toHaveBeenCalledTimes(2);
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(1, {
      llm: { vendors: { openai: { ...llm.vendors.openai, enableThinking: true, thinkingBudgetTokens: expected } } },
    });
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(2, {
      llm: { vendors: { openai: llm.vendors.openai } },
    });
    expect(loop.runTurn).toHaveBeenCalledOnce();
  });

  it("resolves stored persona prompt id when retrying with effort settings", async () => {
    const loop = makeConversationLoop("f54c7bda-1854-4991-8708-8d60d079368a", [
      {
        role: "user",
        content: [
          { type: "text", text: "retry text" },
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
        meta: {
          activePersonaPrompt: {
            id: "reviewer",
            name: "Reviewer",
          },
        },
      },
      { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invokeRegisteredHandler(handlers, "ave:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens: 12345 }, "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "retry text",
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
        attachments: [
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
      }),
    );
  });
});

describe("sub-agent parent mailbox on manual turns", () => {
  it("joins durable child messages into the user's next parent turn and acknowledges them", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      peekParentMailbox: vi.fn(async () => [{
        id: "message-1",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    await invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "What changed?",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "What changed?",
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        initialGuidance: expect.stringMatching(/\[Sub-Agent: Researcher\]\nfinished$/),
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
        subAgentReport: {},
      }),
    );
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366", ["message-1"]);
  });

  it("acknowledges a consumed mailbox before post-turn bookkeeping fails", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", [
      { role: "user", content: "existing parent input" },
    ]);
    loop.getSessionProjectIsDefault.mockReturnValue(true);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      peekParentMailbox: vi.fn(async () => [{
        id: "message-bookkeeping-failure",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    deps.memoryManager.markMainActiveResume.mockRejectedValueOnce(
      new Error("main-active-bookkeeping-failed"),
    );

    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "Consume child result",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main") as Promise<unknown>).rejects.toThrow("main-active-bookkeeping-failed");

    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "a1bdc27a-c758-4a74-8955-5e9188412366",
      ["message-bookkeeping-failure"],
    );
    expect(deps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366");
    expect(acknowledgeParentMailbox.mock.invocationCallOrder[0])
      .toBeLessThan(deps.memoryManager.markMainActiveResume.mock.invocationCallOrder[0]!);
  });
  it("holds the turn lease from mailbox peek through ACK and blocks session mutation", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const peekGate = new SessionMutationGate<Array<{ id: string; formattedText: string; approvalLabel: string }>>();
    const peekEntered = new SessionMutationGate<void>();
    const ackGate = new SessionMutationGate<number>();
    const ackEntered = new SessionMutationGate<void>();
    let reentrantNew: Promise<unknown> | undefined;
    const runner = {
      peekParentMailbox: vi.fn(() => {
        reentrantNew = invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main") as Promise<unknown>;
        peekEntered.resolve(undefined);
        return peekGate.promise;
      }),
      acknowledgeParentMailbox: vi.fn(() => {
        ackEntered.resolve(undefined);
        return ackGate.promise;
      }),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const sendPromise = invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "Consume child result",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main") as Promise<unknown>;

    await peekEntered.promise;
    await expect(reentrantNew).resolves.toEqual({ ok: false, error: "streaming-active" });
    await expect(invokeRegisteredHandler(handlers, "ave:chat:session-resume", "a1bdc27a-c758-4a74-8955-5e9188412366", "main")).resolves.toEqual(
      expect.objectContaining({ ok: false, error: "streaming-active" }),
    );
    await expect(invokeRegisteredHandler(handlers, "ave:chat:fork", undefined, "main")).resolves.toEqual({
      ok: false,
      sessionId: null,
      error: "streaming-active",
    });
    expect(loop.newConversation).not.toHaveBeenCalled();
    expect(loop.resetAndResume).not.toHaveBeenCalled();
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();

    peekGate.resolve([{
      id: "message-lease",
      formattedText: "[Sub-Agent: Researcher]\nfinished",
      approvalLabel: "[Sub-Agent: Researcher]",
    }]);
    await ackEntered.promise;

    // Hold the lease through durable ACK removal, even after the model turn returns.
    await expect(invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });
    expect(loop.newConversation).not.toHaveBeenCalled();

    ackGate.resolve(1);
    await sendPromise;
    expect(runner.acknowledgeParentMailbox).toHaveBeenCalledWith(
      "a1bdc27a-c758-4a74-8955-5e9188412366",
      ["message-lease"],
    );
  });
});


describe("sub-agent autonomous parent wake", () => {
  it("starts a current idle parent turn through agent-message provenance and acknowledges after completion", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn = vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: (parentSessionId: string) => Promise<void>) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-1",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    expect(wakeHandler).toBeTypeOf("function");
    await wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366");

    expect(loop.runTurn).toHaveBeenCalledWith(
      expect.stringMatching(/\[Sub-Agent: Researcher\]\nfinished$/),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
        subAgentReport: {},
      }),
    );
    expect(loop.runTurn.mock.calls[0]?.[3]).not.toHaveProperty("initialGuidance");
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366", ["message-1"]);
  });

  it("acknowledges an autonomous mailbox before post-turn bookkeeping fails", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", [
      { role: "user", content: "existing parent input" },
    ]);
    loop.getSessionProjectIsDefault.mockReturnValue(true);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn =
      vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-wake-bookkeeping-failure",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    deps.memoryManager.markMainActiveResume.mockRejectedValueOnce(
      new Error("wake-bookkeeping-failed"),
    );

    await expect(wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366")).rejects.toThrow(
      "wake-bookkeeping-failed",
    );

    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "a1bdc27a-c758-4a74-8955-5e9188412366",
      ["message-wake-bookkeeping-failure"],
    );
    expect(deps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("a1bdc27a-c758-4a74-8955-5e9188412366");
    expect(acknowledgeParentMailbox.mock.invocationCallOrder[0])
      .toBeLessThan(deps.memoryManager.markMainActiveResume.mock.invocationCallOrder[0]!);
  });
  it("single-flights autonomous wake before mailbox peek starts", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    let finishTurn!: (result: any) => void;
    loop.runTurn.mockReturnValue(new Promise((resolve) => { finishTurn = resolve; }));
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const peekGate = new SessionMutationGate<Array<{ id: string; formattedText: string; approvalLabel: string }>>();
    const peekEntered = new SessionMutationGate<void>();
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(() => {
        peekEntered.resolve(undefined);
        return peekGate.promise;
      }),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const wakePromise = wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366");

    // Publish the lease synchronously before deferred mailbox I/O.
    await expect(invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "concurrent user message",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main")).resolves.toEqual({ error: "streaming-active" });
    await expect(invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });

    await peekEntered.promise;
    expect(loop.runTurn).not.toHaveBeenCalled();
    peekGate.resolve([{
      id: "message-1",
      formattedText: "[Sub-Agent: Researcher]\nfinished",
      approvalLabel: "[Sub-Agent: Researcher]",
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(loop.runTurn).toHaveBeenCalledTimes(1);

    finishTurn({ text: "done", toolCalls: [], route: "default", stopReason: "end_turn" });
    await wakePromise;
    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
  });
  it("does not start or acknowledge when the requested parent is not current", async () => {
    const loop = makeConversationLoop("7d997d58-4f1b-4e93-86f3-81937b915655", []);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn = vi.fn(() => false);
    const acknowledgeParentMailbox = vi.fn(async () => 0);
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: (parentSessionId: string) => Promise<void>) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => []),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    await wakeHandler!("bebd469f-b3d4-42a8-8340-f0a27e66162b");

    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
    expect(acknowledgeParentMailbox).not.toHaveBeenCalled();
  });
  it("waits for the current stream lease once, then wakes a late mailbox delivery", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    const manualTurn = new SessionMutationGate<any>();
    const manualEntered = new SessionMutationGate<void>();
    loop.runTurn
      .mockImplementationOnce(() => {
        manualEntered.resolve(undefined);
        return manualTurn.promise;
      })
      .mockResolvedValue({
        text: "wake response",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });

    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "message-late",
          formattedText: "[Sub-Agent: Researcher]\nlate result",
          approvalLabel: "[Sub-Agent: Researcher]",
        }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const sendPromise = invokeRegisteredHandler(handlers, "ave:chat:send", {
      input: "manual parent turn",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main") as Promise<unknown>;
    await manualEntered.promise;

    const wakePromise = wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366");
    await Promise.resolve();
    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(1);
    expect(loop.runTurn).toHaveBeenCalledTimes(1);

    manualTurn.resolve({
      text: "manual response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    await sendPromise;
    await wakePromise;

    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(2);
    expect(loop.runTurn).toHaveBeenCalledTimes(2);
    expect(loop.runTurn.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ inputOrigin: "agent-message" }),
    );
    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "a1bdc27a-c758-4a74-8955-5e9188412366",
      ["message-late"],
    );
  });

  it("waits for one same-session mutation lease and then wakes exactly once", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "wake response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-after-mutation",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox: vi.fn(async () => 1),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    const mutationGate = new SessionMutationGate<void>();
    const mutationEntered = new SessionMutationGate<void>();
    deps.memoryManager.markMainActiveFresh.mockImplementation(() => {
      mutationEntered.resolve(undefined);
      return mutationGate.promise;
    });

    const mutationPromise = invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main") as Promise<unknown>;
    await mutationEntered.promise;
    const wakePromise = wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366");
    await Promise.resolve();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();

    mutationGate.resolve(undefined);
    await mutationPromise;
    await wakePromise;

    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(1);
    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    expect(runner.acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
  });

  it("does not wake after the captured mutation switches sessions", async () => {
    const loop = makeConversationLoop("a1bdc27a-c758-4a74-8955-5e9188412366", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    loop.newConversation.mockImplementation(() => {
      loop.getSessionId.mockReturnValue("5f711b23-ee4f-4cbb-88e0-53b872bbda82");
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-stays-durable",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox: vi.fn(async () => 1),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    const mutationGate = new SessionMutationGate<void>();
    const mutationEntered = new SessionMutationGate<void>();
    deps.memoryManager.markMainActiveFresh.mockImplementation(() => {
      mutationEntered.resolve(undefined);
      return mutationGate.promise;
    });

    const mutationPromise = invokeRegisteredHandler(handlers, "ave:chat:new", undefined, "main") as Promise<unknown>;
    await mutationEntered.promise;
    const wakePromise = wakeHandler!("a1bdc27a-c758-4a74-8955-5e9188412366");
    mutationGate.resolve(undefined);
    await mutationPromise;
    await wakePromise;
    await Promise.resolve();

    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.acknowledgeParentMailbox).not.toHaveBeenCalled();
  });

});

// Replay folds resource fences into turn text; preserve provenance and the user's original display text.
describe("ave:chat:continue-last-user — a resource turn's row", () => {
  const SESSION_ID = "7d9d1608-67c6-43cf-8379-e8bd1a188e3e";
  const FENCE = [
    `${MCP_RESOURCE_FENCE_OPEN} server="hr-mcp" uri="file:///policy.md">`,
    "SERVER BODY THE USER DID NOT WRITE",
    "</mcp-resource>",
  ].join("\n");

  function resourceTurn(meta?: Record<string, unknown>) {
    return {
      role: "user",
      content: [
        { type: "text", text: "summarize [Resource #1]" },
        { type: "text", text: FENCE },
      ],
      ...(meta ? { meta } : {}),
    };
  }

  it("carries the prior row's displayText into the replayed turn", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "assistant", content: "earlier" },
      resourceTurn({ displayText: "summarize [Resource #1]" }),
    ]);
    await setupHandlers(loop);
    // Install the mock after setup clears mocks.
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });

    const seeded = loop.getHistory().getMessages();
    expect((seeded[seeded.length - 1] as { meta?: { displayText?: string } }).meta?.displayText)
      .toBe("summarize [Resource #1]");

    await invokeRegisteredHandler(handlers, "ave:chat:continue-last-user", { sessionId: SESSION_ID }, "main");

    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    const options = loop.runTurn.mock.calls[0][3] as { displayText?: string };
    // Reload must render the user's original row text, excluding folded resource fences.
    expect(options.displayText).toBe("summarize [Resource #1]");
    expect(options.displayText).not.toContain("SERVER BODY");
    expect(loop.runTurn.mock.calls[0][0]).toContain(MCP_RESOURCE_FENCE_OPEN);
  });

  it("forwards no displayText when the prior row had none", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "assistant", content: "earlier" },
      { role: "user", content: "an ordinary question" },
    ]);
    await setupHandlers(loop);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });

    await invokeRegisteredHandler(handlers, "ave:chat:continue-last-user", { sessionId: SESSION_ID }, "main");

    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    const options = loop.runTurn.mock.calls[0][3] as Record<string, unknown>;
    expect(options).not.toHaveProperty("displayText");
  });
});

describe("shared main-conversation lease on replay commands", () => {
  it("does not truncate history or patch retry settings while another surface owns the turn", async () => {
    const messages = [
      { role: "user", content: "previous question", meta: { messageId: "row-lease-user" } },
      { role: "assistant", content: "previous answer", meta: { messageId: "row-lease-assistant" } },
    ];
    const loop = makeConversationLoop("7b9c0647-fc72-47d5-8330-c8ea0a2f8274", messages);
    const turnEntered = new SessionMutationGate<void>();
    let finishTurn!: (result: { text: string; toolCalls: unknown[]; stopReason: string }) => void;
    loop.runTurn.mockImplementation(() => {
      turnEntered.resolve(undefined);
      return new Promise((resolve) => {
        finishTurn = resolve;
      });
    });
    const deps = await setupHandlers(loop);
    const history = loop.getHistory();

    const activeTurn = invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "from-local-api-surface",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }, "main") as Promise<unknown>;
    await turnEntered.promise;

    await expect(invokeRegisteredHandler(handlers, CHANNELS.chat.editResend, "row-lease-user", "replacement", "main"))
      .resolves.toEqual({ ok: false, error: "streaming-active" });
    await expect(invokeRegisteredHandler(handlers, CHANNELS.chat.continueLastUser, {
      sessionId: "7b9c0647-fc72-47d5-8330-c8ea0a2f8274",
    }, "main")).resolves.toEqual({ ok: false, error: "streaming-active" });
    await expect(invokeRegisteredHandler(handlers, CHANNELS.chat.retryEffort, { enableThinking: true }, "main"))
      .resolves.toEqual({ ok: false, error: "streaming-active" });

    expect(history.truncate).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
    expect(loop.refreshProvider).not.toHaveBeenCalled();

    finishTurn({ text: "done", toolCalls: [], stopReason: "end_turn" });
    await activeTurn;
  });
});

describe("an interrupt send while a turn is running", () => {
  function runningTurn() {
    const loop = makeConversationLoop("ad6a7bdb-a5ef-4f37-84d6-a0388b18191c", []);
    const turnEntered = new SessionMutationGate<void>();
    let finishTurn!: (result: { text: string; toolCalls: unknown[]; route: string; stopReason: string }) => void;
    loop.runTurn.mockImplementation(async () => ({ text: "second answer", toolCalls: [], route: "llm", stopReason: "end_turn" }));
    loop.runTurn.mockImplementationOnce(() => {
      turnEntered.resolve(undefined);
      return new Promise((resolve) => {
        finishTurn = resolve;
      });
    });
    loop.abortCurrentTurn.mockImplementation(() => {
      finishTurn({ text: "", toolCalls: [], route: "llm", stopReason: "aborted" });
    });
    return { loop, turnEntered };
  }

  it("stops the running turn inside the send and runs the new one after it settles", async () => {
    const { loop, turnEntered } = runningTurn();
    await setupHandlers(loop);

    const first = invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "first", inputOrigin: "user-keyboard", userActivation: true,
    }, "main") as Promise<unknown>;
    await turnEntered.promise;

    const second = await invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "second", inputOrigin: "user-keyboard", userActivation: true, interrupt: true,
    }, "main");
    await first;

    expect(loop.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(loop.runTurn).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ text: "second answer" });
  });

  it("leaves the running turn alone when the interrupting send would be refused", async () => {
    const { loop, turnEntered } = runningTurn();
    await setupHandlers(loop);

    const first = invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "first", inputOrigin: "user-keyboard", userActivation: true,
    }, "main") as Promise<unknown>;
    await turnEntered.promise;

    await expect(invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "second", inputOrigin: "user-keyboard", interrupt: true,
    }, "main")).resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    expect(loop.abortCurrentTurn).not.toHaveBeenCalled();

    loop.abortCurrentTurn();
    await first;
  });

  it("reports that the turn was already stopped when the refusal comes after the abort", async () => {
    const { loop, turnEntered } = runningTurn();
    await setupHandlers(loop);

    const first = invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "first", inputOrigin: "user-keyboard", userActivation: true,
    }, "main") as Promise<unknown>;
    await turnEntered.promise;

    const second = await invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "second", inputOrigin: "user-keyboard", userActivation: true, interrupt: true,
      personaPromptId: "persona-that-does-not-exist",
    }, "main");
    await first;

    expect(loop.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ ok: false, interrupted: true });
    expect(loop.runTurn).toHaveBeenCalledTimes(1);
  });

  it("without the flag a send during a running turn is refused, and nothing is aborted", async () => {
    const { loop, turnEntered } = runningTurn();
    await setupHandlers(loop);

    const first = invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "first", inputOrigin: "user-keyboard", userActivation: true,
    }, "main") as Promise<unknown>;
    await turnEntered.promise;

    await expect(invokeRegisteredHandler(handlers, CHANNELS.chat.send, {
      input: "second", inputOrigin: "user-keyboard", userActivation: true,
    }, "main")).resolves.toEqual({ error: "streaming-active" });
    expect(loop.abortCurrentTurn).not.toHaveBeenCalled();

    loop.abortCurrentTurn();
    await first;
  });
});

describe("ave:chat:compact focus", () => {
  const SESSION_ID = "df98a854-4084-4ba1-8fbc-f00faea193bf";

  it("passes a trimmed focus to manual compaction and omits an empty one", async () => {
    const loop = makeConversationLoop(SESSION_ID, []);
    loop.manualCompact.mockResolvedValue({ compacted: false, compactedAt: null, summary: "noop", removedMessageCount: 0 });
    await setupHandlers(loop);

    await invokeRegisteredHandler(handlers, CHANNELS.chat.compact, "main", "  the auth migration ");
    await invokeRegisteredHandler(handlers, CHANNELS.chat.compact, "main", "   ");

    expect(loop.manualCompact.mock.calls[0]![0]).toMatchObject({ focus: "the auth migration" });
    expect(loop.manualCompact.mock.calls[1]![0]).not.toHaveProperty("focus");
  });

  it("rejects a focus that is not a string", async () => {
    const loop = makeConversationLoop(SESSION_ID, []);
    await setupHandlers(loop);

    expect(() => invokeRegisteredHandler(handlers, CHANNELS.chat.compact, "main", { text: "x" })).toThrow("invalid compact focus");
    expect(loop.manualCompact).not.toHaveBeenCalled();
  });
});
