import { installNativeChatWindow, invokeNativeChatHandler as invokeRegisteredHandler } from "../../../__tests__/support/native-chat-window.js";
// Stop must cancel pending approval and release the execution lease before the approval timeout.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebContents } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import {
  makeMockWebContents,
} from "../../../__tests__/test-helpers.js";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const STOP_PROBE_WINDOW_MS = 60_000;

type StopProbe = "stopped" | "still-blocked";

describe("ave:chat:abort with a turn parked on an approval", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function parkedTurnWithStopHandler(): Promise<{
    runtime: ReturnType<typeof createConversationSurfaceRuntime>;
    approvalWindow: ReturnType<typeof makeMockWebContents>;
    approval: Promise<{ choice: string }>;
    abortCurrentTurn: ReturnType<typeof vi.fn>;
  }> {
    const runtime = createConversationSurfaceRuntime();
    const approvalWindow = makeMockWebContents();
    const gate = new ApprovalGate(approvalWindow as unknown as WebContents);
    const turnAbortController = new AbortController();
    const abortCurrentTurn = vi.fn(() => {
      turnAbortController.abort(new Error("user cancelled turn"));
    });
    const conversationLoop = {
      getSessionId: () => "conv-parked",
      getSessionKind: () => "main",
      hasProvider: () => true,
      abortCurrentTurn,
      getHistory: () => ({ length: 0, getMessages: () => [] }),
    };

    const approval = gate.requestAndWait({
      id: "parked-1",
      category: "tool",
      toolName: "fs_write",
      toolCategory: "write",
      sessionId: "conv-parked",
      args: { path: "/srv/report.md", content: "hello" },
      reason: "write outside the workspace",
      source: "builtin",
      createdAt: Date.now(),
      isReadOnly: false,
      remoteControllerOrigin: "platform-bridge",
      abortSignal: turnAbortController.signal,
    });
    const lease = runtime.activity.tryTrackTurn(async () => {
      await approval;
      return "turn-settled" as const;
    });
    expect(lease).not.toBeNull();

    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow();
    registerChatHandlers({
      conversationLoop,
      conversationSurfaceRuntime: runtime,
      settingsService: {
        get: vi.fn((key?: string) =>
          key === "llm" ? fakeLlmSettings() : {},
        ),
        patch: vi.fn(async () => undefined),
      },
      memoryManager: {
        loadMainActiveSessionState: vi.fn(() => null),
        markMainActiveFresh: vi.fn(async () => undefined),
        saveSessionMetadata: vi.fn(async () => undefined),
      },
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);

    return { runtime, approvalWindow, approval, abortCurrentTurn };
  }

  it("completes the Stop and frees the conversation for the owner", async () => {
    const { runtime, approvalWindow, approval, abortCurrentTurn } =
      await parkedTurnWithStopHandler();

    expect(approvalWindow.send).toHaveBeenCalledTimes(1);
    expect(runtime.activity.isBusy()).toBe(true);
    expect(runtime.activity.tryTrackTurn(async () => "owner-send")).toBeNull();

    const stop = Promise.resolve(
      invokeRegisteredHandler<Promise<{ ok: boolean }>>(
        handlers,
        CHANNELS.chat.abort, "main",
      ),
    );
    // A timeout-driven release must not masquerade as a responsive Stop.
    const probe = Promise.race<StopProbe>([
      stop.then(() => "stopped" as const),
      new Promise<StopProbe>((resolve) => {
        setTimeout(() => resolve("still-blocked"), STOP_PROBE_WINDOW_MS);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(STOP_PROBE_WINDOW_MS);

    expect(await probe).toBe("stopped");
    expect(await stop).toEqual({ ok: true });
    expect(abortCurrentTurn).toHaveBeenCalledTimes(1);
    await expect(approval).resolves.toMatchObject({ choice: "deny-once" });
    expect(runtime.activity.isBusy()).toBe(false);
    expect(runtime.activity.tryTrackTurn(async () => "owner-send")).not.toBeNull();
  });
});
