import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import type { GitRuntimeStatus } from "../../../shared/git-runtime.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

/** The app's shutdown hooks, run by the test instead of `before-quit`. */
const shutdownHooks = new Map<string, () => void>();
vi.mock("../../../main/app-shutdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../main/app-shutdown.js")>()),
  registerShutdownHook: vi.fn((name: string, stop: () => void) => {
    shutdownHooks.set(name, stop);
  }),
}));

const STATUS: GitRuntimeStatus = Object.freeze({
  mode: "auto",
  state: "missing",
  active: null,
  systemTooOld: { path: "/usr/bin/git", version: "2.34.1" },
  managed: { version: "2.53.0", installed: false, available: true, size: 62348987 },
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

  it("scrubs the status and install answers and a failed step's progress, as every marketplace string (§18.8)", async () => {
    // A real token shape, assembled here so no whole token sits in the source.
    const token = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
    const service = await setup();
    const leaky: GitRuntimeStatus = {
      ...STATUS,
      active: { kind: "system", version: "2.45.0", path: `/opt/${token}/bin/git` },
      lastInstallError: { code: "SOURCE_UNREACHABLE", message: `proxy failed via https://user:${token}@proxy.example/` },
    };
    service.status.mockResolvedValue(leaky);
    service.install.mockResolvedValue(leaky as never);
    for (const answer of [
      await invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.status),
      await invokeFileIpcHandler(handlers, CHANNELS.gitRuntime.install, { intent }),
    ]) {
      expect(answer).toMatchObject({ ok: true, status: { active: { path: "/opt/[REDACTED:TOKEN]/bin/git" } } });
      expect(JSON.stringify(answer)).not.toContain(token);
    }

    const { getMarketplaceLifetime } = await import("../../../main/app-state.js");
    const { gitRuntimeProgressSender } = await import("../git-runtime.js");
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } };
    gitRuntimeProgressSender({ getMainWindow: () => window, getAppWindows: () => [window] } as never, getMarketplaceLifetime().signal)(
      { phase: "failed", code: "SOURCE_UNREACHABLE", message: `proxy failed via https://user:${token}@proxy.example/` },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain(token);
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

  it("sends install progress to every live window until the marketplace's shutdown hook runs, and nothing after", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { getMarketplaceLifetime } = await import("../../../main/app-state.js");
    const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
    const { gitRuntimeProgressSender } = await import("../git-runtime.js");
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } };
    const deps = { auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window], settingsService: { get: () => ({}) } };
    // The marketplace domain as the app registers it: with the app's shared lifetime, which the runtime's sender reads.
    const home = mkdtempSync(join(tmpdir(), "ave-git-runtime-ipc-"));
    try {
      registerGitMarketplaceHandlers(deps as never, async () => null, async () => ({ service: {} as never, close: async () => {} }), async () => {}, home);
      const progress = gitRuntimeProgressSender(deps as never, getMarketplaceLifetime().signal);
      const event = { phase: "downloading", bytes: 1, total: 2 } as never;

      progress(event);
      expect(send).toHaveBeenCalledWith(CHANNELS.gitRuntime.progress, event);
      await vi.waitFor(() => expect(shutdownHooks.has("git-marketplace-events")).toBe(true));
      shutdownHooks.get("git-marketplace-events")!();
      progress(event);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
