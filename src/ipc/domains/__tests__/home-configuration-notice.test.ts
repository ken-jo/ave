// The home configuration notice's choices (restore a set-aside file at the next start, dismiss, start fresh) are user actions:
// only the host window, with a user gesture, can record one, and an untrusted or synthetic call records nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";
import { foreignFrameEvent, hostFrameEvent, makeRegisteredHandlerInvoker } from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };
const resolveNotice = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }) },
}));
vi.mock("../../../shared/ave-home-configuration.js", async (original) => ({
  ...await original<typeof import("../../../shared/ave-home-configuration.js")>(),
  resolveAveHomeConfigurationNotice: resolveNotice,
}));

const invoke = makeRegisteredHandlerInvoker(handlers);
const auditLogger = { log: vi.fn() };

describe("the home configuration notice choice", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    resolveNotice.mockReset();
    const { registerPermissionsHandlers } = await import("../permissions.js");
    registerPermissionsHandlers({
      conversationLoop: { permissionManager: { getMode: () => "default", setDeferredEntryAsk: vi.fn() } },
      approvalGate: {},
      auditLogger,
      toolRegistry: { setDenyRules: vi.fn() },
      settingsService: { get: vi.fn(() => ({})) },
      getAppWindows: vi.fn(() => []),
    } as never);
  });

  const restore = { action: "restore", folder: "20261103T010203456Z", name: "settings.json" };

  it.each([undefined, foreignFrameEvent("https://evil.example"), foreignFrameEvent("file:///app/plugin-ui-shell.html")])("rejects an untrusted sender %j", async (event) => {
    expect(await invoke(PERMISSIONS.resolveHomeConfigurationNotice, event, { ...restore, intent: USER_INTENT })).toEqual(UNAUTHORIZED_FRAME);
    expect(resolveNotice).not.toHaveBeenCalled();
  });

  it("rejects a call without a user gesture", async () => {
    expect(await invoke(PERMISSIONS.resolveHomeConfigurationNotice, hostFrameEvent(), restore)).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(resolveNotice).not.toHaveBeenCalled();
  });

  it("rejects an unknown choice", async () => {
    expect(await invoke(PERMISSIONS.resolveHomeConfigurationNotice, hostFrameEvent(), { action: "restore-all", intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "invalid-payload" });
    expect(resolveNotice).not.toHaveBeenCalled();
  });

  it("records the user's restore choice and audits it", async () => {
    expect(await invoke(PERMISSIONS.resolveHomeConfigurationNotice, hostFrameEvent(), { ...restore, intent: USER_INTENT })).toEqual({ ok: true });
    expect(resolveNotice).toHaveBeenCalledTimes(1);
    expect(resolveNotice).toHaveBeenCalledWith({ action: "restore", folder: restore.folder, name: restore.name });
    expect(JSON.parse(auditLogger.log.mock.calls[0]![0].output)).toEqual({
      action: "home_configuration_restore", who: "user-ui", file: "settings.json", folder: restore.folder,
    });
  });

  it("reports a choice that does not apply without recording anything", async () => {
    resolveNotice.mockImplementation(() => { throw new Error("Starting fresh applies only when committed configuration is missing"); });
    expect(await invoke(PERMISSIONS.resolveHomeConfigurationNotice, hostFrameEvent(), { action: "start-fresh", intent: USER_INTENT }))
      .toEqual({ ok: false, error: "not-applicable", message: "Starting fresh applies only when committed configuration is missing" });
    expect(auditLogger.log).not.toHaveBeenCalled();
  });
});
