import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBootHostFixture } from "../../__tests__/support/host-runtime.js";
import { deferred } from "../../__tests__/support/deferred.js";
import type { AppServices } from "../../boot/types.js";

const calls: string[] = [];
const releaseSandbox = vi.fn(async () => {});
const forceKillChildren = vi.fn();
const logError = vi.fn();
const acquireHostInstanceLock = vi.fn(async () => {});
const bootstrapHost = vi.fn(async () => services());
const createDesktopBootHost = vi.fn();

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
  logger: { flush: (done: () => void) => done() },
  closeFileLogSink: () => calls.push("log-close"),
}));
vi.mock("../browser/browser-tab-registry.js", () => ({ browserTabRegistry: { flushBindingWrites: async () => {} } }));
vi.mock("../shutdown-routines.js", () => ({ runShutdownRoutines: async () => {} }));
vi.mock("../local-api-server.js", () => ({ stopLocalApiServer: async () => {} }));
vi.mock("../tailnet-surface-server.js", () => ({ stopTailnetObserverServer: async () => {} }));
vi.mock("../telegram-bridge-server.js", () => ({ stopTelegramBridgeServer: async () => {} }));
vi.mock("../a2a-remote-receiver-server.js", () => ({ stopRemoteA2AReceiverServer: async () => {} }));
vi.mock("../subscription-runtime-service.js", () => ({ stopSubscriptionRuntimes: async () => {} }));
vi.mock("../../observation/document-engine-host.js", () => ({ stopHostDocumentEngineSessions: async () => {} }));
vi.mock("../browser/browser-upload.js", () => ({ disposeBrowserUploads: async () => {} }));
vi.mock("../../engine/turn/turn-journal.js", () => ({ interruptRunningTurnsForExit: async () => ({ turns: 0, settled: 0 }) }));
vi.mock("../managed-child-processes.js", () => ({
  sealManagedChildProcessAdmission: vi.fn(),
  forceKillManagedChildProcesses: (...args: unknown[]) => forceKillChildren(...args),
  forceKillAndDrainManagedChildProcesses: async () => { calls.push("managed-drain"); },
}));
vi.mock("../terminal/pty-manager.js", () => ({ forceKillAllTerminalsForShutdown: async () => {} }));
vi.mock("../../permissions/mxc-holder-lifetime.js", () => ({ sealMxcHolderLifetimeAdmission: vi.fn(), drainMxcHolderLifetimes: async () => {} }));
vi.mock("../../tools/shell-tools.js", () => ({
  backgroundShellManager: { disposeAllBrokerShells: vi.fn(), waitForAllBrokerCleanup: async () => [] },
}));
vi.mock("../../permissions/asrt-sandbox.js", () => ({ releaseAsrtSandboxForExit: () => releaseSandbox() }));
vi.mock("../host-instance-lock.js", () => ({ acquireHostInstanceLock: () => acquireHostInstanceLock() }));
vi.mock("../../boot.js", () => ({ bootstrap: () => bootstrapHost() }));
vi.mock("../../boot/desktop-host-runtime.js", () => ({ createDesktopBootHost: () => createDesktopBootHost() }));

function services(): AppServices {
  return {
    settingsService: { get: () => ({}) },
    pluginRuntime: { beginShutdown: vi.fn(), stopAll: async () => {} },
    shutdown: async () => { calls.push("services-stop"); },
  } as unknown as AppServices;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls.length = 0;
  releaseSandbox.mockReset().mockImplementation(async () => {});
  acquireHostInstanceLock.mockReset().mockResolvedValue(undefined);
  bootstrapHost.mockReset().mockImplementation(async () => services());
});

describe("quit during resource startup", () => {
  it("holds native exit through initialization and the normal asynchronous sandbox reset", async () => {
    const state = await import("../app-state.js");
    const shutdown = await import("../app-shutdown.js");
    const initialize = deferred<void>();
    const reset = deferred<void>();
    const resources = new Set<string>();
    const exits: string[][] = [];
    const startup = initialize.promise.then(() => {
      resources.add("proxy");
      calls.push("initialized");
      state.setServices(services());
    });
    releaseSandbox.mockImplementation(async () => {
      calls.push("reset-start");
      await reset.promise;
      resources.clear();
      calls.push("reset-end");
    });
    shutdown.configureAppShutdownHost(createBootHostFixture({ close: async () => { calls.push("host-close"); } }));
    const handler = shutdown.createAppBeforeQuitHandler({
      getResourceStartup: () => startup,
      quit: attemptQuit,
    });
    function attemptQuit() {
      let prevented = false;
      handler({ preventDefault: () => { prevented = true; } });
      if (!prevented) {
        calls.push("native-exit");
        exits.push([...resources]);
      }
    }
    try {
      attemptQuit();
      attemptQuit();
      expect(exits).toEqual([]);
      expect(releaseSandbox).not.toHaveBeenCalled();
      initialize.resolve();
      await startup;
      await vi.waitFor(() => expect(releaseSandbox).toHaveBeenCalledOnce());
      expect(exits).toEqual([]);
      expect(resources.size).toBe(1);
      reset.resolve();
      await vi.waitFor(() => expect(exits).toEqual([[]]));
      expect(calls.indexOf("initialized")).toBeLessThan(calls.indexOf("services-stop"));
      expect(calls.indexOf("managed-drain")).toBeLessThan(calls.indexOf("reset-start"));
      expect(calls.indexOf("reset-end")).toBeLessThan(calls.indexOf("host-close"));
      expect(calls.indexOf("host-close")).toBeLessThan(calls.indexOf("native-exit"));
      expect(forceKillChildren).not.toHaveBeenCalled();
    } finally {
      initialize.resolve();
      reset.resolve();
      await startup;
    }
  });

  it.each(["before", "during"] as const)("cleans partial resources when startup rejects %s the quit request", async (timing) => {
    const shutdown = await import("../app-shutdown.js");
    const initialize = deferred<void>();
    const reset = deferred<void>();
    const resources = new Set<string>();
    const startup = initialize.promise.then(() => {
      resources.add("partial-proxy");
      throw new Error("Startup initialization failed");
    });
    const startupFailure = startup.catch(() => {});
    const quit = vi.fn();
    const close = vi.fn(async () => {});
    shutdown.configureAppShutdownHost(createBootHostFixture({ close }));
    releaseSandbox.mockImplementation(async () => {
      await reset.promise;
      resources.clear();
    });
    const handler = shutdown.createAppBeforeQuitHandler({ getResourceStartup: () => startup, quit });
    try {
      if (timing === "before") {
        initialize.resolve();
        await startupFailure;
      }
      const preventDefault = vi.fn();
      handler({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(quit).not.toHaveBeenCalled();
      initialize.resolve();
      await startupFailure;
      await vi.waitFor(() => expect(releaseSandbox).toHaveBeenCalledOnce());
      expect(quit).not.toHaveBeenCalled();
      expect(resources.size).toBe(1);
      reset.resolve();
      await vi.waitFor(() => expect(quit).toHaveBeenCalledExactlyOnceWith("completed"));
      expect(resources.size).toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(forceKillChildren).not.toHaveBeenCalled();
    } finally {
      initialize.resolve();
      reset.resolve();
      await startupFailure;
    }
  });

  it("does not hold an ordinary quit before any resource startup", async () => {
    const shutdown = await import("../app-shutdown.js");
    const quit = vi.fn();
    const handler = shutdown.createAppBeforeQuitHandler({ getResourceStartup: () => null, quit });
    const preventDefault = vi.fn();
    handler({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(releaseSandbox).not.toHaveBeenCalled();
  });

  it("does not join later host work once services own normal shutdown", async () => {
    const state = await import("../app-state.js");
    const shutdown = await import("../app-shutdown.js");
    const unrelated = deferred<void>();
    const quit = vi.fn();
    state.setServices(services());
    const handler = shutdown.createAppBeforeQuitHandler({ getResourceStartup: () => unrelated.promise, quit });
    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(releaseSandbox).toHaveBeenCalledOnce();
    unrelated.resolve();
  });

  it("reports incomplete startup cleanup failure before reissuing quit", async () => {
    const shutdown = await import("../app-shutdown.js");
    const quit = vi.fn();
    releaseSandbox.mockRejectedValueOnce(new Error("Sandbox reset failed"));
    const handler = shutdown.createAppBeforeQuitHandler({ getResourceStartup: () => Promise.resolve(), quit });
    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledExactlyOnceWith("failed"));
    expect(logError).toHaveBeenCalledWith({ status: "failed" }, "incomplete host bootstrap cleanup did not complete");
  });

  it("cancels after the host lock wait before constructing a boot host", async () => {
    const state = await import("../app-state.js");
    const desktop = await import("../../desktop-boot.js");
    const acquired = deferred<void>();
    acquireHostInstanceLock.mockReturnValueOnce(acquired.promise);
    const startup = desktop.bootstrap("/workspace", null, () => null, "interactive");
    state.setAppQuitRequested(true);
    acquired.resolve();
    expect(await startup).toBeNull();
    expect(createDesktopBootHost).not.toHaveBeenCalled();
    expect(bootstrapHost).not.toHaveBeenCalled();
  });

  it("does not acquire a host lock after quit was already requested", async () => {
    const state = await import("../app-state.js");
    const desktop = await import("../../desktop-boot.js");
    state.setAppQuitRequested(true);
    expect(await desktop.bootstrap("/workspace", null, () => null, "interactive")).toBeNull();
    expect(acquireHostInstanceLock).not.toHaveBeenCalled();
    expect(bootstrapHost).not.toHaveBeenCalled();
  });
});
