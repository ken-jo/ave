// Deleting a chat marks its connected schedules 대화 없음. The chat is gone by then, so a failure to mark them is logged, not shown as a
// failed delete; the next fire finds the chat missing and marks the item itself.
import { installNativeChatWindow, invokeNativeChatHandler } from "../../../__tests__/support/native-chat-window.js";
import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
}));

const OPEN = "11111111-1111-4111-8111-111111111111";
const DELETED = "66666666-6666-4666-8666-666666666666";

describe("ave:chat:sessionDelete and connected schedules", () => {
  it("reports the delete as done when marking its schedules 대화 없음 fails", async () => {
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow();
    const deleteSession = vi.fn(async () => undefined);
    const markOrphaned = vi.fn(async () => { throw new Error("disk full"); });
    registerChatHandlers({
      conversationLoop: {
        getSessionId: () => OPEN,
        getSessionKind: () => "main",
        hasProvider: () => true,
        hasActiveTurn: () => false,
        abortCurrentTurn: vi.fn(),
        getHistory: () => ({ length: 0, getMessages: () => [] }),
      },
      conversationSurfaceRuntime: createConversationSurfaceRuntime(),
      settingsService: { get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})), patch: vi.fn(async () => undefined) },
      memoryManager: {
        loadMainActiveSessionState: vi.fn(() => null),
        markMainActiveFresh: vi.fn(async () => undefined),
        saveSessionMetadata: vi.fn(async () => undefined),
        deleteSession,
      },
      routinesStore: { markOrphaned },
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    const result = await invokeNativeChatHandler<Promise<unknown>>(handlers, CHANNELS.chat.sessionDelete, { sessionId: DELETED });
    expect(result).toEqual({ ok: true, wasLoaded: false });
    expect(deleteSession).toHaveBeenCalledWith(DELETED);
    expect(markOrphaned).toHaveBeenCalledWith(DELETED);
  });
});
