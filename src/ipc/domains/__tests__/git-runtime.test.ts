import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import type { GitRuntimeStatus } from "../../../shared/git-runtime.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const STATUS: GitRuntimeStatus = Object.freeze({
  mode: "auto",
  state: "missing",
  active: null,
  systemTooOld: { path: "/usr/bin/git", version: "2.34.1" },
  managed: { version: "2.53.0", installed: false, available: true },
  lastInstallError: null,
});

async function setup() {
  handlers.clear();
  const service = {
    status: vi.fn(async () => STATUS),
    install: vi.fn(async () => ({ ...STATUS, state: "ready" as const, managed: { ...STATUS.managed, installed: true } })),
  };
  const { registerGitRuntimeHandlers } = await import("../git-runtime.js");
  registerGitRuntimeHandlers({ auditLogger: { log: vi.fn() }, getMainWindow: () => null } as never, service);
  return service;
}

beforeEach(() => {
  handlers.clear();
});

describe("git runtime IPC boundary", () => {
  it("reports the status to the host renderer", async () => {
    await setup();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status)).resolves.toEqual({ ok: true, status: STATUS });
  });

  it("refuses plugin frames on both channels", async () => {
    const service = await setup();
    for (const channel of [CHANNELS.gitRuntime.status, CHANNELS.gitRuntime.install]) {
      await expect(invokeAppIpcHandlerFromFrame(handlers, channel, "file:///app/plugin-ui-shell.html", { intent }))
        .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    }
    expect(service.status).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("installs only with a live keyboard intent", async () => {
    const service = await setup();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.install)).resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.install, { intent: { inputOrigin: "script" } }))
      .resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    expect(service.install).not.toHaveBeenCalled();

    const result = await invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.install, { intent });
    expect(result).toMatchObject({ ok: true, status: { state: "ready", managed: { installed: true } } });
    expect(service.install).toHaveBeenCalledTimes(1);
  });

  it("classifies install as gesture-required and keeps both channels internal", async () => {
    const { CHANNEL_GESTURE, isPublicChannel } = await import("../../../contract/app-contract.js");
    expect(CHANNEL_GESTURE[CHANNELS.gitRuntime.install]).toBe("required");
    expect(isPublicChannel(CHANNELS.gitRuntime.status)).toBe(false);
    expect(isPublicChannel(CHANNELS.gitRuntime.install)).toBe(false);
  });
});
