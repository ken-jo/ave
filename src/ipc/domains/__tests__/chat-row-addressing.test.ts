import { installNativeChatWindow, invokeNativeChatHandler as invokeRegisteredHandler } from "../../../__tests__/support/native-chat-window.js";
// Resolve actions by durable messageId; transcript entry positions and history row positions can differ.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationHistory } from "../../../engine/conversation-history.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { serializeHistoryMessage } from "../../../shared/chat-history.js";
import { historyToEntries } from "../../../ui/renderer/utils/history.js";
import type { GenericMessage } from "../../../engine/llm/types.js";

const REWIND = "ave:chat:rewind-to";
const FORK = "ave:chat:fork";
const EDIT_RESEND = "ave:chat:edit-resend";
const ACTIVE_SESSION = "active-session";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

function driftShapedHistory(): GenericMessage[] {
  return [
    { role: "user", content: "first question", meta: { messageId: "m-q1" } },
    { role: "assistant", content: "", meta: { messageId: "m-toolround" },
      toolCalls: [{ id: "tu-1", name: "read_file", input: {} }] },
    { role: "tool_result", toolUseId: "tu-1", content: "file body", meta: { messageId: "m-tr1" } },
    { role: "assistant", content: "first answer", meta: { messageId: "m-a1" } },
    { role: "user", content: "[compacted]",
      meta: { messageId: "m-boundary", compactBoundary: true, compactNum: 1 } },
    { role: "user", content: "imported", meta: { messageId: "m-trigger",
      importedTrigger: { sessionId: "s", source: "plugin", prompt: "p", summary: "b",
        toolCallCount: 0, importedAt: "2026-01-01T00:00:00.000Z" } } },
    { role: "assistant", content: "trigger answer", meta: { messageId: "m-a2" } },
    { role: "user", content: "third question", meta: { messageId: "m-q3" } },
    { role: "assistant", content: "third answer", meta: { messageId: "m-a3" } },
  ];
}

function makeDeps(seed: GenericMessage[]) {
  let messages = [...seed];
  return {
    conversationLoop: {
      getHistory: vi.fn(() => ({
        getMessages: () => messages,
        truncate: (count: number) => {
          messages = messages.slice(0, count);
        },
        restore: vi.fn(),
      })),
      getSessionId: vi.fn(() => ACTIVE_SESSION),
      getSessionKind: vi.fn(() => "main"),
      loadSession: vi.fn(() => true),
    } as any,
    settingsService: { get: vi.fn(() => ({})), patch: vi.fn(async () => undefined) } as any,
    memoryManager: {
      saveSession: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
      loadSessionMetadata: vi.fn(() => null),
      rehydrateToolResultArtifacts: vi.fn((_id: string, msgs: GenericMessage[]) => msgs),
      markMainActiveResume: vi.fn(async () => undefined),
      pruneCheckpointsDiscardedByRewind: vi.fn(async () => undefined),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    getMainWindow: vi.fn(() => null),
  };
}

async function setup(seed: GenericMessage[]) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeDeps(seed);
  await installNativeChatWindow(deps.getMainWindow());
  registerChatHandlers(deps as any);
  return deps;
}

function savedMessages(deps: ReturnType<typeof makeDeps>): GenericMessage[] {
  const call = deps.memoryManager.saveSession.mock.calls.at(-1);
  expect(call, "rewind must persist the truncated session").toBeDefined();
  expect(call![0]).toBe(ACTIVE_SESSION);
  return call![1] as GenericMessage[];
}

describe("ave:chat:rewind-to", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("cuts at the named row, not at the row an ordinal walk would have counted to", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, REWIND, "m-q3", "main",
    );

    expect(result.ok).toBe(true);
    expect(savedMessages(deps).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1", "m-boundary", "m-trigger", "m-a2",
    ]);
  });

  it("hands back the text the composer has to restore", async () => {
    await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, "m-q3", "main",
    );

    expect(result.text).toBe("third question");
  });

  it("empties the session when the rewind targets the opening message", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, REWIND, "m-q1", "main",
    );

    expect(result.ok).toBe(true);
    expect(savedMessages(deps)).toEqual([]);
  });

  it("hands the pruner the rows this rewind discarded, not the rows that survived it", async () => {
    // Prune only boundaries removed by this rewind, not survivors of earlier compactions.
    const deps = await setup(driftShapedHistory());

    await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, REWIND, "m-q1", "main");

    expect(deps.memoryManager.pruneCheckpointsDiscardedByRewind).toHaveBeenCalledWith(
      ACTIVE_SESSION,
      driftShapedHistory(),
    );
  });

  it("restores the words the bubble showed, not the envelope stored around them", async () => {
    // Restore the user's bare text rather than the host routing envelope.
    const deps = await setup([
      { role: "user", content: "first question", meta: { messageId: "m-q1" } },
      {
        role: "user",
        content: "[injection envelope]\n더 짧게",
        meta: { messageId: "m-guide", displayText: "더 짧게" },
      },
      { role: "assistant", content: "shorter answer", meta: { messageId: "m-a1" } },
    ]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, "m-guide", "main",
    );

    expect(result).toMatchObject({ ok: true, text: "더 짧게" });
    expect(savedMessages(deps).map((m) => m.meta?.messageId)).toEqual(["m-q1"]);
  });

  it("refuses an assistant row — only the user's own input can be taken back", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-a1", "main",
    );

    expect(result).toEqual({ ok: false, error: "not-a-user-message" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a row that is no longer in the conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-compacted-away", "main",
    );

    expect(result).toEqual({ ok: false, error: "message-not-found" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a missing identifier", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "", "main",
    );

    expect(result).toEqual({ ok: false, error: "invalid-message-id" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("refuses a message with an attachment rather than cutting it and losing the image", async () => {
    const deps = await setup([
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image", image: "data:image/png;base64,AAAA", mimeType: "image/png" },
      ], meta: { messageId: "m-with-image" } },
      { role: "assistant", content: "I see it", meta: { messageId: "m-a" } },
    ]);

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, REWIND, "m-with-image", "main",
    );

    expect(result).toEqual({ ok: false, error: "attachment-not-restorable" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });

  it("returns the persona the turn was addressed with", async () => {
    await setup([
      { role: "user", content: "ask the reviewer",
        meta: { messageId: "m-persona", activePersonaPrompt: { id: "persona-7", name: "Reviewer" } } },
      { role: "assistant", content: "ok", meta: { messageId: "m-a" } },
    ]);

    const result = await invokeRegisteredHandler<
      Promise<{ ok: boolean; personaPromptId?: string }>
    >(handlers, REWIND, "m-persona", "main");

    expect(result.personaPromptId).toBe("persona-7");
  });
});

describe("ave:chat:fork — same rule, same fixture", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("branches up to and including the named row, not the row an ordinal would reach", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean }>>(
      handlers, FORK, "m-q3", "main",
    );

    expect(result.ok).toBe(true);
    const forked = deps.memoryManager.saveSession.mock.calls.find(
      ([sessionId]: [string]) => sessionId !== ACTIVE_SESSION,
    );
    expect(forked, "fork must write a new session file").toBeDefined();
    expect((forked![1] as GenericMessage[]).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1", "m-boundary", "m-trigger", "m-a2", "m-q3",
    ]);
  });

  it("can branch from an assistant row, which is where the turn footer offers it", async () => {
    const deps = await setup(driftShapedHistory());

    await invokeRegisteredHandler<Promise<{ ok: boolean }>>(handlers, FORK, "m-a1", "main");

    const forked = deps.memoryManager.saveSession.mock.calls.find(
      ([sessionId]: [string]) => sessionId !== ACTIVE_SESSION,
    );
    expect((forked![1] as GenericMessage[]).map((m) => m.meta?.messageId)).toEqual([
      "m-q1", "m-toolround", "m-tr1", "m-a1",
    ]);
  });

  it("refuses a row that is gone rather than silently branching the whole conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, FORK, "m-compacted-away", "main",
    );

    expect(result).toEqual({ ok: false, sessionId: null, error: "message-not-found" });
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();
  });
});

describe("ave:chat:edit-resend — same rule, same fixture", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("refuses a row that is gone instead of replaying whichever row an ordinal reaches", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, EDIT_RESEND, "m-compacted-away", "rewritten", "main",
    );

    expect(result).toEqual({ ok: false, error: "message-not-found" });
    expect(deps.conversationLoop.getHistory().getMessages()).toHaveLength(9);
  });

  it("refuses a missing identifier before it touches the conversation", async () => {
    const deps = await setup(driftShapedHistory());

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; error?: string }>>(
      handlers, EDIT_RESEND, "", "rewritten", "main",
    );

    expect(result).toEqual({ ok: false, error: "invalid-message-id" });
    expect(deps.conversationLoop.getHistory().getMessages()).toHaveLength(9);
  });
});

describe("renderer entry → host row, end to end", () => {
  beforeEach(() => {
    handlers.clear();
  });

  function realHistoryWithDriftShapes(): ConversationHistory {
    const history = new ConversationHistory();
    history.append({ role: "user", content: "first question" });
    history.append({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tu-1", name: "read_file", input: {} }],
    });
    history.append({ role: "tool_result", toolUseId: "tu-1", content: "file body" });
    history.append({ role: "assistant", content: "first answer" });
    history.append({
      role: "user",
      content: "[compacted]",
      meta: { compactBoundary: true, compactNum: 1, checkpointMeta: { removedMessages: 2, freedTokens: 10 } },
    });
    history.append({ role: "user", content: "third question" });
    history.append({ role: "assistant", content: "third answer" });
    return history;
  }

  it("cuts the row the clicked bubble stands for, across a tool round and a compact boundary", async () => {
    const history = realHistoryWithDriftShapes();
    const deps = makeDeps([]);
    deps.conversationLoop.getHistory = vi.fn(() => history) as never;
    handlers.clear();
    vi.clearAllMocks();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow(deps.getMainWindow());
    registerChatHandlers(deps as never);

    const serialized = history
      .getMessages()
      .map((message, index) => serializeHistoryMessage(message, index));
    const entries = historyToEntries(serialized);

    const clicked = entries.filter((e) => e.kind === "user").at(-1);
    expect(clicked?.kind === "user" ? clicked.text : "").toBe("third question");
    const messageId = clicked?.kind === "user" ? clicked.messageId : undefined;
    expect(messageId, "every rebuilt user bubble is addressable").toBeDefined();

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, messageId!, "main",
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe("third question");
    expect(history.getMessages().map((m) => m.content)).toEqual([
      "first question", "", "file body", "first answer", "[compacted]",
    ]);
  });
});

// Sidebar and resumed history must derive identical row ids for legacy sessions.
describe("a session written before rows carried an identity", () => {
  const LEGACY_SESSION = "dddddddd-0000-1111-2222-333333333333";
  let dir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    handlers.clear();
    dir = mkdtempSync(join(tmpdir(), "ave-legacy-rows-"));
    mm = new MemoryManager({ aveDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeLegacySession(): Promise<void> {
    await mm.saveSession(LEGACY_SESSION, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);
  }

  it("reads back the same identity for the same row on every load", async () => {
    await writeLegacySession();

    const first = mm.loadSession(LEGACY_SESSION)!;
    const second = mm.loadSession(LEGACY_SESSION)!;

    const ids = first.map((m) => (m as GenericMessage).meta?.messageId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.map((m) => (m as GenericMessage).meta?.messageId)).toEqual(ids);
  });

  it("restores into the loop under the ids the transcript shows, and rewinds to the clicked row", async () => {
    await writeLegacySession();
    const loaded = mm.loadSession(LEGACY_SESSION) as GenericMessage[];

    const history = new ConversationHistory();
    history.restore(loaded);
    expect(history.getMessages().map((m) => m.meta?.messageId)).toEqual(
      loaded.map((m) => m.meta?.messageId),
    );

    const deps = makeDeps([]);
    deps.conversationLoop.getHistory = vi.fn(() => history) as never;
    deps.conversationLoop.getSessionId = vi.fn(() => LEGACY_SESSION) as never;
    vi.clearAllMocks();
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow(deps.getMainWindow());
    registerChatHandlers(deps as never);

    const entries = historyToEntries(
      loaded.map((message, index) => serializeHistoryMessage(message, index)),
    );
    const clicked = entries.filter((e) => e.kind === "user").at(-1);
    const messageId = clicked?.kind === "user" ? clicked.messageId : undefined;
    expect(messageId, "a legacy row is addressable once loaded").toBeDefined();

    const result = await invokeRegisteredHandler<Promise<{ ok: boolean; text?: string }>>(
      handlers, REWIND, messageId!, "main",
    );

    expect(result).toMatchObject({ ok: true, text: "second question" });
    expect(history.getMessages().map((m) => m.content)).toEqual([
      "first question", "first answer",
    ]);
  });
});
