// A connected schedule's turn enters the chat tile that holds its chat, through the same host-submitted turn path session-goal
// revival uses, and only when that tile is free.
import { installNativeChatWindow } from "../../../__tests__/support/native-chat-window.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { sessionAuthorityWithheld, turnExtensionPolicyContext } from "../../../shared/turn-extension-policy.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const streamed: Array<{ input: string; options: Record<string, unknown>; withheld: boolean }> = [];
vi.mock("../../handlers/chat-stream.js", async (original) => ({
  ...(await original<typeof import("../../handlers/chat-stream.js")>()),
  runStreamedTurn: vi.fn(async (_loop: unknown, input: string, _sink: unknown, options: Record<string, unknown>) => {
    await Promise.resolve();
    streamed.push({ input, options, withheld: sessionAuthorityWithheld() });
    return { text: "", toolCalls: [], route: "llm" };
  }),
}));

const SESSION = "33333333-3333-4333-8333-333333333333";

async function setup(activeTurn = false) {
  streamed.length = 0;
  const { registerChatHandlers } = await import("../chat.js");
  const { wakeRoutineChat } = await import("../../../main/app-state.js");
  await installNativeChatWindow();
  registerChatHandlers({
    conversationLoop: {
      getSessionId: () => SESSION,
      getSessionKind: () => "main",
      hasProvider: () => true,
      hasActiveTurn: () => activeTurn,
      abortCurrentTurn: vi.fn(),
      getHistory: () => ({ length: 0, getMessages: () => [] }),
    },
    conversationSurfaceRuntime: createConversationSurfaceRuntime(),
    settingsService: { get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})), patch: vi.fn(async () => undefined) },
    memoryManager: {
      loadMainActiveSessionState: vi.fn(() => null),
      markMainActiveFresh: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  } as unknown as Parameters<typeof registerChatHandlers>[0]);
  return wakeRoutineChat;
}

const wake = <T>(operation: () => T): T => turnExtensionPolicyContext.run(Object.freeze({ withholdSessionAuthority: true }), operation);
const turn = { input: "check the build", displayText: "Scheduled prompt · Build" };

afterEach(async () => {
  (await import("../../../main/app-state.js")).setRoutineChatWaker(null);
});

describe("waking a chat for a connected schedule", () => {
  it("runs a host-submitted, non-keyboard turn in the tile that holds the chat, keeping the withheld authority", async () => {
    const wakeRoutineChat = await setup();
    expect(await wake(() => wakeRoutineChat(SESSION, turn))).toEqual({ status: "ran" });
    expect(streamed).toEqual([{
      input: "check the build",
      options: { inputOrigin: "agent-message", displayText: "Scheduled prompt · Build", hostSubmitted: true },
      withheld: true,
    }]);
  });

  it("answers not-open for a chat no tile holds", async () => {
    const wakeRoutineChat = await setup();
    expect(await wakeRoutineChat("44444444-4444-4444-8444-444444444444", turn)).toEqual({ status: "not-open" });
    expect(streamed).toEqual([]);
  });

  it("answers busy and starts nothing while the tile runs a turn", async () => {
    const wakeRoutineChat = await setup(true);
    expect(await wakeRoutineChat(SESSION, turn)).toEqual({ status: "busy" });
    expect(streamed).toEqual([]);
  });
});
