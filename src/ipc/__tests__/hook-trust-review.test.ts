import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { hostFrameEvent, isolatedAppFrameEvent } from "../../__tests__/test-helpers.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { CHANNEL_GESTURE } from "../../contract/app-contract.js";

const { handlers, review, list } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>(),
  review: vi.fn(), list: vi.fn(),
}));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) => handlers.set(channel, handler) } }));
vi.mock("../../hooks/hook-source-controller.js", () => ({ reviewRuntimeHookTrust: review, listRuntimeHookTrustState: list }));
import { registerPermissionsHandlers } from "../domains/permissions.js";

const manager = {};
const event = hostFrameEvent();
Object.assign(event.sender, { isDestroyed: () => false, mainFrame: event.senderFrame });
const request = { sourceId: "user", fileName: "pre-review.sh", expectedSha256: "a".repeat(64), action: "accept" };
const intent = { inputOrigin: "user-keyboard", userActivation: true };
const audit = { log: vi.fn() };

beforeEach(() => {
  handlers.clear(); vi.clearAllMocks();
  review.mockResolvedValue({ ok: true, verb: "accept" });
  list.mockReturnValue({ ok: true, verb: "list", active: [], disabled: [] });
  registerPermissionsHandlers({ conversationLoop: { getSessionProjectRoot: () => "/workspace/project" }, auditLogger: audit,
    scriptHookManager: manager, getAppWindows: () => [{ isDestroyed: () => false, webContents: event.sender }] } as never);
});

function handler(channel: string) {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`Handler missing: ${channel}`);
  return handle;
}
const invoke = (sender: IpcMainInvokeEvent, payload: unknown) => handler(PERMISSIONS.hookTrustReview)(sender, payload);

describe("hook trust review IPC", () => {
  it("requires a registered native host frame and active user gesture", async () => {
    expect(CHANNEL_GESTURE[PERMISSIONS.hookTrustReview]).toBe("required");
    expect(await invoke(isolatedAppFrameEvent(), { ...request, intent })).toMatchObject({ error: "unauthorized-frame" });
    const unregistered = hostFrameEvent();
    Object.assign(unregistered.sender, { isDestroyed: () => false, mainFrame: unregistered.senderFrame });
    expect(await invoke(unregistered, { ...request, intent })).toMatchObject({ error: "unauthorized-frame" });
    expect(await invoke(event, request)).toMatchObject({ error: "user-keyboard-required" });
    expect(await invoke(event, { ...request, intent: { ...intent, userActivation: false } })).toMatchObject({ error: "user-keyboard-required" });
    expect(review).not.toHaveBeenCalled();
    expect(await invoke(event, { ...request, intent })).toEqual({ ok: true });
    expect(review).toHaveBeenCalledWith(manager, request, "/workspace/project");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ output: expect.stringContaining("hook_trust_reviewed") }));
  });

  it("rejects malformed hashes and actions before accessing trust state", async () => {
    for (const patch of [{ expectedSha256: "bad" }, { action: "remove" }, { sourceId: "" }, { fileName: "" }]) {
      expect(await invoke(event, { ...request, ...patch, intent })).toEqual({ ok: false, error: "invalid-hook-review" });
    }
    expect(review).not.toHaveBeenCalled();
  });

  it("passes stale and managed policy refusals as stable codes and hides internal errors", async () => {
    for (const code of ["hook-review-stale", "managed-hook-policy"]) {
      review.mockResolvedValueOnce({ ok: false, error: code });
      expect(await invoke(event, { ...request, intent })).toEqual({ ok: false, error: code });
    }
    review.mockRejectedValueOnce(new Error("header value must stay private"));
    expect(await invoke(event, { ...request, intent })).toEqual({ ok: false, error: "hook-review-failed" });
  });

  it("lists project trust using host-owned session context", async () => {
    expect(await handler(PERMISSIONS.hookTrustList)(event)).toMatchObject({ ok: true, totalDisabled: 0 });
    expect(list).toHaveBeenCalledWith(manager, "/workspace/project");
  });
});
