// Deleting a chat marks its connected schedules 대화 없음. The chat is gone by then, so a failure to mark them is logged, not shown as a
// failed delete; the next fire finds the chat missing and marks the item itself.
import { installNativeChatWindow, invokeNativeChatHandler } from "../../../__tests__/support/native-chat-window.js";
import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { createConversationSurfaceRuntime } from "../../../engine/conversation-surface-runtime.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { WindowsHoldVerdict } from "../../../shared/windows-path-facts.js";
import { backgroundShellManager, BashTool } from "../../../tools/shell-tools.js";
import * as terminalManager from "../../../main/terminal/pty-manager.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit, recordHostShellPolicyAuthorization } from "../../../permissions/host-shell-execution-permit.js";
import { getHostShellExecutionPlan } from "../../../permissions/sandbox-capability.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const OPEN = "11111111-1111-4111-8111-111111111111";
const DELETED = "66666666-6666-4666-8666-666666666666";

describe("ave:chat:sessionDelete", () => {
  async function setup(loadedSession = OPEN) {
    const { registerChatHandlers } = await import("../chat.js");
    await installNativeChatWindow();
    const deleteSession = vi.fn(async () => undefined);
    const markOrphaned = vi.fn(async () => undefined);
    const surface = createConversationSurfaceRuntime();
    registerChatHandlers({
      conversationLoop: {
        getSessionId: () => loadedSession,
        getSessionKind: () => "main",
        hasProvider: () => true,
        hasActiveTurn: () => false,
        abortCurrentTurn: vi.fn(),
        getHistory: () => ({ length: 0, getMessages: () => [] }),
      },
      conversationSurfaceRuntime: surface,
      settingsService: { get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})), patch: vi.fn(async () => undefined) },
      memoryManager: {
        sessions: {
          loadMainActiveSessionState: vi.fn(() => null),
          markMainActiveFresh: vi.fn(async () => undefined),
          saveSessionMetadata: vi.fn(async () => undefined),
          deleteSession,
        },
      },
      routinesStore: { markOrphaned },
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    const remove = () => invokeNativeChatHandler<Promise<unknown>>(handlers, CHANNELS.chat.sessionDelete, { sessionId: DELETED });
    return { deleteSession, markOrphaned, activity: surface.activity, remove };
  }

  it("reports the delete as done when marking its schedules 대화 없음 fails", async () => {
    const { deleteSession, markOrphaned, remove } = await setup();
    markOrphaned.mockRejectedValueOnce(new Error("disk full"));
    await expect(remove()).resolves.toEqual({ ok: true, wasLoaded: false });
    expect(deleteSession).toHaveBeenCalledWith(DELETED);
    expect(markOrphaned).toHaveBeenCalledWith(DELETED);
  });

  it("stops the held shell and waits for its verdict before deleting the transcript", async () => {
    const { deleteSession, remove } = await setup();
    const verdict = deferred<WindowsHoldVerdict>();
    const stopping = deferred<void>();
    const stop = vi.fn(() => { stopping.resolve(); return verdict.promise; });
    const child = new EventEmitter() as ChildProcess;
    backgroundShellManager.register({ child, sessionId: DELETED, command: "work", startedAt: "t", held: { stop, verdict: verdict.promise } });
    const deletion = remove();
    try {
      await Promise.race([deletion, stopping.promise]);
      expect(stop).toHaveBeenCalledOnce();
      expect(deleteSession).not.toHaveBeenCalled();
    } finally {
      verdict.resolve({ kind: "ok", stopped: false });
      child.emit("close", 130, null);
      await deletion;
      backgroundShellManager._resetForTest();
    }
    await expect(deletion).resolves.toEqual({ ok: true, wasLoaded: false });
    expect(deleteSession).toHaveBeenCalledWith(DELETED);
  });

  it("releases a loaded conversation mutation when its terminal never reports exit and lets deletion retry", async () => {
    const { activity, deleteSession, markOrphaned, remove } = await setup(DELETED);
    const gone = deferred<void>();
    const ending = vi.spyOn(terminalManager, "endConversationTerminalSession").mockReturnValue(gone.promise);
    vi.useFakeTimers();
    const deletion = remove();
    let result: unknown;
    void deletion.then((value) => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsHoldStopMs - 1);
      expect(ending).toHaveBeenCalledWith(DELETED);
      expect(activity.activeMutation()).not.toBeNull();
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect.soft(result).toEqual({ ok: false, error: "terminal-cleanup-unproven" });
      expect(activity.activeMutation()).toBeNull();
      expect(deleteSession).not.toHaveBeenCalled();
      expect(markOrphaned).not.toHaveBeenCalled();
      gone.resolve();
      await expect(remove()).resolves.toEqual({ ok: true, wasLoaded: true });
      expect(deleteSession).toHaveBeenCalledOnce();
    } finally {
      gone.resolve();
      await deletion;
      ending.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the conversation while an unconfirmed held launcher has no exit evidence", async () => {
    const { activity, deleteSession, remove } = await setup(DELETED);
    const verdict = deferred<WindowsHoldVerdict>();
    const stop = vi.fn(() => { verdict.resolve({ kind: "unconfirmed" }); return verdict.promise; });
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    backgroundShellManager.register({ child, sessionId: DELETED, command: "work", startedAt: "t", held: { stop, verdict: verdict.promise } });
    try {
      await expect(remove()).resolves.toEqual({ ok: false, error: "shell-cleanup-unproven" });
      expect(activity.activeMutation()).toBeNull();
      await expect(remove()).resolves.toEqual({ ok: false, error: "shell-cleanup-unproven" });
      expect(deleteSession).not.toHaveBeenCalled();
      Object.assign(child, { exitCode: 125 });
      child.emit("exit", 125, null);
      await expect(remove()).resolves.toEqual({ ok: true, wasLoaded: true });
    } finally {
      verdict.resolve({ kind: "unconfirmed" });
      backgroundShellManager._resetForTest();
    }
  });

  it.runIf(process.platform === "win32")("keeps the conversation after a foreground shell stop deadline until launcher exit", async () => {
    const { activity, deleteSession, markOrphaned, remove } = await setup(DELETED);
    const cwd = process.cwd();
    const input = { command: "printf work", executionMode: "host", justification: "Run the approved command", timeoutSeconds: 1 };
    const plan = getHostShellExecutionPlan("host");
    const toolUseId = "foreground-shell";
    const binding = buildHostShellExecutionPermitBinding({
      plan, toolName: "bash", toolUseId, rawInput: input, executionCwd: cwd, extraAllowedDirectories: [],
    });
    if (binding === undefined) throw new Error("Shell permit binding was not created");
    recordHostShellPolicyAuthorization(binding, undefined);
    const permit = mintHostShellExecutionPermit({ plan, binding, answer: undefined });
    const bound = deferred<void>();
    const verdict = deferred<WindowsHoldVerdict>();
    const stop = vi.fn(() => {
      setTimeout(() => verdict.resolve({ kind: "unconfirmed" }), TOOL_TIMEOUT_POLICY.windowsHoldStopMs);
      return verdict.promise;
    });
    const launcher = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(launcher as unknown as ChildProcess);
    const handoff = vi.spyOn(await import("../../../permissions/host-shell-execution-permit.js"), "withHostShellExecutionHandoff").mockImplementationOnce(async (_authorization, launch) => launch({
      bind() { bound.resolve(); return { stop, verdict: verdict.promise }; },
      launcherArgs: [], stdio: undefined, assertHeld() {}, dispose() {},
      command: (executable, args) => ({ executable, args: [...args] }),
    }));
    vi.useFakeTimers();
    const command = new BashTool().execute(input, {
      cwd, extraAllowedDirectories: [], metadata: { sessionId: DELETED, toolUseId },
      hostShellExecutionPlan: plan, hostShellExecutionPermit: permit,
    });
    try {
      await Promise.race([bound.promise, command.then((result) => { throw new Error(result.output); })]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stop).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsHoldStopMs);
      await expect(command).resolves.toMatchObject({ isError: true, metadata: { timedOut: true, cwdPinUnconfirmed: true } });

      await expect(remove()).resolves.toEqual({ ok: false, error: "shell-cleanup-unproven" });
      expect(activity.activeMutation()).toBeNull();
      expect(deleteSession).not.toHaveBeenCalled();
      expect(markOrphaned).not.toHaveBeenCalled();

      Object.assign(launcher, { exitCode: 125 });
      launcher.emit("exit", 125, null);
      await expect(remove()).resolves.toEqual({ ok: true, wasLoaded: true });
      expect(deleteSession).toHaveBeenCalledExactlyOnceWith(DELETED);
      expect(markOrphaned).toHaveBeenCalledExactlyOnceWith(DELETED);
    } finally {
      verdict.resolve({ kind: "unconfirmed" });
      launcher.emit("close", 125, null);
      backgroundShellManager._resetForTest();
      handoff.mockRestore();
      vi.useRealTimers();
    }
  });
});
