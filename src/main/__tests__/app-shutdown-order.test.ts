import { createBootHostFixture, createDesktopHostFixture } from "../../__tests__/support/host-runtime.js";
// Global shortcuts must release before any shutdown step can fail; the log sink must close last on every exit path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { deferred } from "../../__tests__/support/deferred.js";

const calls: string[] = [];
const hostExit = vi.fn();

const unregisterAllGlobalShortcuts = vi.fn(() => calls.push("unregister"));
const closeFileLogSink = vi.fn(() => calls.push("closeFileLogSink"));
const logWarn = vi.fn();
const logError = vi.fn();
const stopLocalApiServer = vi.fn(async () => { calls.push("stopLocalApi"); });
const stopTailnetObserverServer = vi.fn(async () => { calls.push("stopTailnetObserver"); });
const stopTelegramBridgeServer = vi.fn(async () => { calls.push("stopTelegramBridge"); });
const stopRemoteA2AReceiverServer = vi.fn(async () => { calls.push("stopRemoteReceiver"); });
const stopSubscriptionRuntimes = vi.fn(async () => { calls.push("stopSubscriptionRuntimes"); });
const stopDocumentEngineSessions = vi.fn(async () => { calls.push("stopDocumentEngines"); });
const runShutdownRoutines = vi.fn(async () => { calls.push("shutdownRoutines"); });
const forceKillManagedChildProcesses = vi.fn((_reason: string) => {
  calls.push("forceKillManagedChildren");
  return 1;
});
const sealManagedChildProcessAdmission = vi.fn((_reason: string) => {
});
const forceKillAndDrainManagedChildProcesses = vi.fn(async (_reason: string) => {
  calls.push("drainManagedChildren");
  return { killedCount: 1, unresolvedCount: 0 };
});
const forceKillAllTerminalsForShutdown = vi.fn(async () => {
  calls.push("forceKillTerminals");
  return 1;
});
let brokerCleanupReports: Array<{
  state: "complete" | "cleanup-unproven";
  outcomes: Array<{ requiresExternalRelease: boolean }>;
}> = [];
let brokerShutdownSignal: AbortSignal | undefined;
const disposeAllBrokerShells = vi.fn((signal?: AbortSignal) => {
  calls.push("disposeBrokerShells");
  brokerShutdownSignal = signal;
  return 0;
});
const waitForAllBrokerCleanup = vi.fn(async () => {
  calls.push("waitBrokerCleanup");
  return brokerCleanupReports;
});

vi.mock("electron", () => ({ app: { exit: vi.fn() } }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a), debug: vi.fn() }),
  logger: { flush: (cb: () => void) => cb() },
  closeFileLogSink: (...a: unknown[]) => closeFileLogSink(...a),
}));
vi.mock("../shutdown-routines.js", () => ({ runShutdownRoutines: (...a: unknown[]) => runShutdownRoutines(...a) }));
vi.mock("../local-api-server.js", () => ({ stopLocalApiServer: (...a: unknown[]) => stopLocalApiServer(...a) }));
vi.mock("../tailnet-surface-server.js", () => ({
  stopTailnetObserverServer: () => stopTailnetObserverServer(),
}));
vi.mock("../telegram-bridge-server.js", () => ({
  stopTelegramBridgeServer: () => stopTelegramBridgeServer(),
}));
vi.mock("../a2a-remote-receiver-server.js", () => ({
  stopRemoteA2AReceiverServer: () => stopRemoteA2AReceiverServer(),
}));
vi.mock("../subscription-runtime-service.js", () => ({
  stopSubscriptionRuntimes: () => stopSubscriptionRuntimes(),
}));
vi.mock("../../observation/libreoffice-engine.js", () => ({
  stopDocumentEngineSessions: () => stopDocumentEngineSessions(),
}));
vi.mock("../global-shortcuts.js", () => ({
  unregisterAllGlobalShortcuts: (...a: unknown[]) => unregisterAllGlobalShortcuts(...a),
}));
vi.mock("../managed-child-processes.js", () => ({
  forceKillAndDrainManagedChildProcesses: (...a: [string]) => forceKillAndDrainManagedChildProcesses(...a),
  forceKillManagedChildProcesses: (...a: [string]) => forceKillManagedChildProcesses(...a),
  sealManagedChildProcessAdmission: (...a: [string]) => sealManagedChildProcessAdmission(...a),
}));
vi.mock("../terminal/pty-manager.js", () => ({
  forceKillAllTerminalsForShutdown: () => forceKillAllTerminalsForShutdown(),
}));
vi.mock("../../tools/shell-tools.js", () => ({
  backgroundShellManager: {
    disposeAllBrokerShells: (signal?: AbortSignal) => disposeAllBrokerShells(signal),
    waitForAllBrokerCleanup: () => waitForAllBrokerCleanup(),
  },
}));
// A test that exercises the timed-out branch flips this; the body is not run then, exactly as a real deadline abandons a cleanup that never settles.
let hardTimeoutFires = false;
vi.mock("../shutdown-timeout.js", () => ({
  resolveShutdownCleanupTimeoutMs: (_settingMs?: number) => 5000,
  runCleanupWithHardTimeout: async (fn: (signal: AbortSignal) => Promise<void>) => {
    if (hardTimeoutFires) return { status: "timed-out" as const };
    try {
      await fn(new AbortController().signal);
      return { status: "completed" as const };
    } catch (error) {
      return { status: "failed" as const, error };
    }
  },
}));

const getServices = vi.fn();
let shutdownCompleted = false;
vi.mock("../app-state.js", () => ({
  getServices: (...a: unknown[]) => getServices(...a),
  isAppShutdownCompleted: () => shutdownCompleted,
  setAppShutdownCompleted: (v: boolean) => {
    shutdownCompleted = v;
  },
  setAppShutdownStarted: vi.fn(),
}));

async function configuredShutdown() {
  const runtime = await import("../app-shutdown.js");
  runtime.configureAppShutdownHost(createBootHostFixture({
    exit: hostExit,
    desktop: createDesktopHostFixture({ beforeShutdown: unregisterAllGlobalShortcuts }),
  }));
  return runtime;
}

function makeServices() {
  return {
    runPluginShutdownHandlers: vi.fn(async () => { calls.push("pluginShutdownHandlers"); }),
    shutdown: vi.fn(async () => { calls.push("servicesShutdown"); }),
    pluginRuntime: {
      beginShutdown: vi.fn(() => { calls.push("closePluginAdmission"); }),
      stopAll: vi.fn(async () => { calls.push("stopPluginRuntime"); }),
    },
    // The cleanup window is a Settings control now, so the shutdown path reads the persisted value before it arms the deadline.
    settingsService: { get: vi.fn(() => ({})) },
  };
}

beforeEach(() => {
  calls.length = 0;
  brokerCleanupReports = [];
  brokerShutdownSignal = undefined;
  shutdownCompleted = false;
  vi.clearAllMocks();
  stopDocumentEngineSessions.mockReset().mockImplementation(async () => { calls.push("stopDocumentEngines"); });
});

describe("runAppShutdownCleanup ordering (critic M1)", () => {
  it("drains partial bootstrap callbacks and children without published AppServices", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    shutdown.registerBootPluginShutdown({
      runShutdownHandlers: async () => { calls.push("partialPluginShutdownHandlers"); },
      closeAdmission: () => { calls.push("partialPluginAdmissionClosed"); },
      stopRuntime: async () => { calls.push("partialPluginRuntimeStop"); },
    });
    shutdown.registerShutdownHook("partial-watcher", () => { calls.push("partialWatcher"); });
    const host = createBootHostFixture({ close: async () => { calls.push("closeHost"); } });
    expect(await shutdown.runIncompleteBootShutdown(host)).toBe("completed");
    expect(calls).toEqual([
      "partialWatcher", "partialPluginShutdownHandlers", "partialPluginAdmissionClosed", "partialPluginRuntimeStop", "stopDocumentEngines", "stopSubscriptionRuntimes",
      "forceKillTerminals", "drainManagedChildren", "closeHost", "closeFileLogSink",
    ]);
    expect(sealManagedChildProcessAdmission).toHaveBeenCalledWith("host bootstrap interrupted or failed");
    shutdown.registerShutdownHook("late-watcher", () => { calls.push("lateWatcher"); });
    expect(calls.at(-1)).toBe("lateWatcher");
  });

  it("disconnects MCP before it stops the plugin runtime of an interrupted bootstrap, as the normal shutdown does", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    const signals: AbortSignal[] = [];
    shutdown.registerBootPluginShutdown({
      runShutdownHandlers: async () => { calls.push("partialPluginShutdownHandlers"); },
      closeAdmission: () => { calls.push("partialPluginAdmissionClosed"); },
      stopRuntime: async (signal: AbortSignal) => { signals.push(signal); calls.push("partialPluginRuntimeStop"); },
    });
    shutdown.registerBootMcpDisconnect(async () => { calls.push("partialMcpDisconnect"); });
    expect(await shutdown.runIncompleteBootShutdown()).toBe("completed");
    // Admission closes first, so no post-commit MCP publication opens once MCP is gone.
    expect(calls.slice(0, 4)).toEqual([
      "partialPluginShutdownHandlers", "partialPluginAdmissionClosed", "partialMcpDisconnect", "partialPluginRuntimeStop",
    ]);
    // The runtime still stops within the cleanup deadline.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("force-kills managed children when partial bootstrap cleanup exceeds its deadline", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    hardTimeoutFires = true;
    try {
      expect(await shutdown.runIncompleteBootShutdown()).toBe("timed-out");
      expect(forceKillManagedChildProcesses).toHaveBeenCalledWith("host bootstrap interrupted or failed");
      expect(forceKillAllTerminalsForShutdown).toHaveBeenCalled();
      expect(calls.at(-1)).toBe("closeFileLogSink");
    } finally {
      hardTimeoutFires = false;
    }
  });

  it("attempts independent partial cleanup stages after a plugin shutdown rejection", async () => {
    getServices.mockReturnValue(undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    shutdown.registerBootPluginShutdown({
      runShutdownHandlers: async () => undefined,
      closeAdmission: () => undefined,
      stopRuntime: async () => { throw new Error("plugin stop failed"); },
    });
    const close = vi.fn(async () => {});
    expect(await shutdown.runIncompleteBootShutdown(createBootHostFixture({ close }))).toBe("failed");
    expect(stopSubscriptionRuntimes).toHaveBeenCalledOnce();
    expect(forceKillAllTerminalsForShutdown).toHaveBeenCalled();
    expect(forceKillAndDrainManagedChildProcesses).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe("closeFileLogSink");
  });

  it("exits a timed-out cleanup with the code a headless run already chose", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    const previous = process.exitCode;
    process.exitCode = 2;
    hardTimeoutFires = true;
    try {
      const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: true });
      expect(outcome).toBe("timed-out");
      expect(hostExit).toHaveBeenCalledWith(2);
    } finally {
      process.exitCode = previous;
      hardTimeoutFires = false;
    }
  });

  it("waits for pending tab binding writes before disposing services", async () => {
    const services = makeServices();
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    const { browserTabRegistry } = await import("../browser/browser-tab-registry.js");
    let finishWrite!: () => void;
    browserTabRegistry.trackBindingWrite(new Promise<void>((resolve) => { finishWrite = resolve; }));
    const flush = vi.spyOn(browserTabRegistry, "flushBindingWrites");
    const cleanup = runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    try {
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
      expect(services.shutdown).not.toHaveBeenCalled();
      expect(stopLocalApiServer).not.toHaveBeenCalled();
    } finally {
      finishWrite();
      await cleanup;
      flush.mockRestore();
    }
    expect(services.shutdown).toHaveBeenCalledOnce();
  });

  it.each(["normal", "incomplete"] as const)("awaits document engine cleanup before the %s child drain", async (mode) => {
    const services = makeServices();
    getServices.mockReturnValue(mode === "normal" ? services : undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    const stopped = deferred<void>();
    stopDocumentEngineSessions.mockImplementationOnce(() => {
      calls.push("stopDocumentEngines");
      return stopped.promise;
    });
    const cleanup = mode === "normal"
      ? shutdown.runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false })
      : shutdown.runIncompleteBootShutdown();
    try {
      await vi.waitFor(() => expect(stopDocumentEngineSessions).toHaveBeenCalledOnce());
      expect(forceKillAndDrainManagedChildProcesses).not.toHaveBeenCalled();
      expect(services.shutdown).not.toHaveBeenCalled();
    } finally {
      stopped.resolve();
      await cleanup;
    }
    await expect(cleanup).resolves.toBe("completed");
    expect(calls.indexOf("stopDocumentEngines")).toBeLessThan(calls.indexOf("drainManagedChildren"));
    expect(forceKillAndDrainManagedChildProcesses).toHaveBeenCalledOnce();
    if (mode === "normal") expect(calls.indexOf("stopDocumentEngines")).toBeLessThan(calls.indexOf("servicesShutdown"));
  });

  it.each(["normal", "incomplete"] as const)("reports a document engine cleanup failure during %s shutdown", async (mode) => {
    const services = makeServices();
    getServices.mockReturnValue(mode === "normal" ? services : undefined);
    vi.resetModules();
    const shutdown = await configuredShutdown();
    stopDocumentEngineSessions.mockRejectedValueOnce(new Error("Document engine cleanup failed"));
    const cleanup = mode === "normal"
      ? shutdown.runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false })
      : shutdown.runIncompleteBootShutdown();
    await expect(cleanup).resolves.toBe("failed");
    expect(stopDocumentEngineSessions).toHaveBeenCalledOnce();
    expect(forceKillManagedChildProcesses).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe("closeFileLogSink");
    if (mode === "normal") {
      expect(services.shutdown).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith({ killedChildCount: 1 }, "%s: shutdown cleanup failed: %s",
        "before-quit", "Document engine cleanup failed");
    } else {
      expect(forceKillAndDrainManagedChildProcesses).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith({ status: "failed" }, "incomplete host bootstrap cleanup did not complete");
    }
  });

  it("closes the file log sink LAST, after unregister runs FIRST", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    const outcome = await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(outcome).toBe("completed");
    expect(sealManagedChildProcessAdmission).toHaveBeenCalledWith("before-quit");
    expect(calls[0]).toBe("unregister");
    expect(calls.at(-1)).toBe("closeFileLogSink");
    expect(calls.indexOf("unregister")).toBeLessThan(calls.indexOf("closeFileLogSink"));
  });

  it("keeps subscription runtimes live through shutdown callbacks, then stops them at the service boundary", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    expect(calls.indexOf("stopDocumentEngines")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("stopDocumentEngines")).toBeLessThan(calls.indexOf("stopLocalApi"));
    expect(calls.indexOf("stopDocumentEngines")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("stopDocumentEngines")).toBeLessThan(calls.indexOf("drainManagedChildren"));
    expect(calls.indexOf("stopLocalApi")).toBeLessThan(calls.indexOf("stopRemoteReceiver"));
    expect(calls.indexOf("stopLocalApi")).toBeLessThan(calls.indexOf("stopTailnetObserver"));
    expect(calls.indexOf("stopTailnetObserver")).toBeLessThan(calls.indexOf("stopTelegramBridge"));
    expect(calls.indexOf("stopTelegramBridge")).toBeLessThan(calls.indexOf("stopRemoteReceiver"));
    expect(calls.indexOf("stopTailnetObserver")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("stopTelegramBridge")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("stopRemoteReceiver")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("pluginShutdownHandlers")).toBeLessThan(calls.indexOf("shutdownRoutines"));
    expect(calls.indexOf("shutdownRoutines")).toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
    expect(calls.indexOf("stopSubscriptionRuntimes")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("servicesShutdown")).toBeLessThan(calls.indexOf("disposeBrokerShells"));
    expect(calls.indexOf("disposeBrokerShells")).toBeLessThan(calls.indexOf("waitBrokerCleanup"));
    expect(calls.indexOf("waitBrokerCleanup")).toBeLessThan(calls.indexOf("forceKillTerminals"));
    expect(calls.indexOf("servicesShutdown")).toBeLessThan(calls.indexOf("forceKillTerminals"));
    expect(calls.indexOf("forceKillTerminals")).toBeLessThan(calls.indexOf("stopPluginRuntime"));
    expect(calls.indexOf("stopPluginRuntime")).toBeLessThan(calls.indexOf("drainManagedChildren"));
    expect(forceKillAndDrainManagedChildProcesses)
      .toHaveBeenCalledWith("before-quit graceful shutdown");
    expect(calls.indexOf("stopRemoteReceiver")).toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
  });

  it("closes plugin admission before services shut down and disconnect MCP, and stops the runtime later", async () => {
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();
    await runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false });
    // Plugin shutdown handlers and shutdown routines may still call plugins.
    expect(calls.indexOf("shutdownRoutines")).toBeLessThan(calls.indexOf("closePluginAdmission"));
    expect(calls.indexOf("pluginShutdownHandlers")).toBeLessThan(calls.indexOf("closePluginAdmission"));
    expect(calls.indexOf("closePluginAdmission")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("closePluginAdmission")).toBeLessThan(calls.indexOf("servicesShutdown"));
    expect(calls.indexOf("servicesShutdown")).toBeLessThan(calls.indexOf("stopPluginRuntime"));
  });

  it("waits for proven broker cleanup after service shutdown", async () => {
    brokerCleanupReports = [{
      state: "complete",
      outcomes: [{ requiresExternalRelease: false }],
    }];
    getServices.mockReturnValue(makeServices());
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("completed");

    expect(calls.indexOf("servicesShutdown")).toBeLessThan(calls.indexOf("disposeBrokerShells"));
    expect(calls.indexOf("disposeBrokerShells")).toBeLessThan(calls.indexOf("waitBrokerCleanup"));
    expect(calls.indexOf("waitBrokerCleanup")).toBeLessThan(calls.indexOf("stopPluginRuntime"));
    expect(brokerShutdownSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails shutdown when broker cleanup still requires external release", async () => {
    brokerCleanupReports = [{
      state: "cleanup-unproven",
      outcomes: [{ requiresExternalRelease: true }],
    }];
    const services = makeServices();
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("failed");

    expect(services.shutdown).toHaveBeenCalledOnce();
    expect(waitForAllBrokerCleanup).toHaveBeenCalledOnce();
    expect(services.pluginRuntime.stopAll).not.toHaveBeenCalled();
    expect(forceKillManagedChildProcesses)
      .toHaveBeenCalledWith("before-quit cleanup failed");
    expect(logError).toHaveBeenCalledWith(
      { killedChildCount: 1 },
      "%s: shutdown cleanup failed: %s",
      "before-quit",
      "workload-broker:shutdown-cleanup-unproven:1",
    );
  });

  it("stops subscription runtimes and preserves a plugin failure when its fallback stop also fails", async () => {
    const services = makeServices();
    services.runPluginShutdownHandlers.mockImplementationOnce(async () => {
      calls.push("pluginShutdownHandlers-throw");
      throw new Error("plugin root failure");
    });
    stopSubscriptionRuntimes.mockImplementationOnce(async () => {
      calls.push("stopSubscriptionRuntimes-throw");
      throw new Error("subscription fallback stop failure");
    });
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("failed");

    expect(calls.indexOf("pluginShutdownHandlers-throw"))
      .toBeLessThan(calls.indexOf("stopSubscriptionRuntimes-throw"));
    expect(calls).toContain("forceKillManagedChildren");
    expect(services.shutdown).not.toHaveBeenCalled();
    expect(runShutdownRoutines).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("shutdown: subscription runtime fallback stop failed");
    expect(logError).toHaveBeenCalledWith(
      { killedChildCount: 1 },
      "%s: shutdown cleanup failed: %s",
      "before-quit",
      "plugin root failure",
    );
  });

  it("stops subscription runtimes after a routine failure and then uses the managed-child backstop", async () => {
    const services = makeServices();
    runShutdownRoutines.mockImplementationOnce(async () => {
      calls.push("shutdownRoutines-throw");
      throw new Error("routine root failure");
    });
    getServices.mockReturnValue(services);
    vi.resetModules();
    const { runAppShutdownCleanup } = await configuredShutdown();

    await expect(runAppShutdownCleanup({ reason: "before-quit", exitOnTimeout: false }))
      .resolves.toBe("failed");

    expect(calls.indexOf("pluginShutdownHandlers"))
      .toBeLessThan(calls.indexOf("shutdownRoutines-throw"));
    expect(calls.indexOf("shutdownRoutines-throw"))
      .toBeLessThan(calls.indexOf("stopSubscriptionRuntimes"));
    expect(calls.indexOf("stopSubscriptionRuntimes"))
      .toBeLessThan(calls.indexOf("forceKillManagedChildren"));
    expect(services.shutdown).not.toHaveBeenCalled();
    expect(forceKillManagedChildProcesses).toHaveBeenCalledWith("before-quit cleanup failed");
    expect(logError).toHaveBeenCalledWith(
      { killedChildCount: 1 },
      "%s: shutdown cleanup failed: %s",
      "before-quit",
      "routine root failure",
    );
  });
});

// Share one before-quit listener through shutdown hooks instead of raising the listener ceiling.
describe("shutdown hooks", () => {
  it("runs every hook once, in registration order", async () => {
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    const ran: string[] = [];
    registerShutdownHook("first", () => ran.push("first"));
    registerShutdownHook("second", () => ran.push("second"));

    runShutdownHooks();
    runShutdownHooks();

    expect(ran).toEqual(["first", "second"]);
  });

  it("runs a hook registered after the drain immediately, and only once", async () => {
    // Run hooks registered after the drain immediately; a deferred quit does not guarantee another drain.
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    runShutdownHooks();

    const late = vi.fn();
    registerShutdownHook("registered-after-drain", late);
    expect(late).toHaveBeenCalledTimes(1);

    runShutdownHooks();
    expect(late).toHaveBeenCalledTimes(1);

    // Same containment as the drain: a late hook that throws must not surface in the middle of the boot step that registered it.
    expect(() =>
      registerShutdownHook("late-and-throws", () => {
        throw new Error("timer already gone");
      }),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledWith(
      "shutdown hook failed (%s): %s",
      "late-and-throws",
      "timer already gone",
    );
  });

  it("contains a throwing hook so the ones after it still run", async () => {
    vi.resetModules();
    const { registerShutdownHook, runShutdownHooks } = await configuredShutdown();
    const ran: string[] = [];
    registerShutdownHook("throws", () => {
      throw new Error("timer already gone");
    });
    registerShutdownHook("after", () => ran.push("after"));

    runShutdownHooks();

    expect(ran).toEqual(["after"]);
    expect(logWarn).toHaveBeenCalledWith(
      "shutdown hook failed (%s): %s",
      "throws",
      "timer already gone",
    );
  });
});

// Inspect source because registrations span boot paths that cannot all run in one test.
describe("before-quit listener inventory", () => {
  // One entry per file allowed to register an Electron `before-quit` listener, with the reason it cannot be a shutdown hook instead.
  const ALLOWED_LISTENER_FILES: ReadonlyMap<string, string> = new Map([
    [
      "src/main.ts",
      "the quit orchestrator: runs the hooks, then defers the quit for the ordered cleanup",
    ],
    [
      "src/boot/desktop-host-runtime.ts",
      "defers the quit to await plugin shutdown handlers during the boot window, before AppServices is published",
    ],
  ]);

  function collectSourceFiles(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
        collectSourceFiles(full, out);
      } else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("is exactly the two listeners the host documents", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const registration =
      /\bapp\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*"before-quit"/u;
    const found = collectSourceFiles(srcRoot, [])
      .filter((file) => registration.test(readFileSync(file, "utf-8")))
      .map((file) => relative(process.cwd(), file).split(sep).join("/"))
      .sort();

    const allowed = [...ALLOWED_LISTENER_FILES.keys()].sort();
    const why = [...ALLOWED_LISTENER_FILES]
      .map(([file, reason]) => `  ${file} — ${reason}`)
      .join("\n");
    expect(
      found,
      [
        "The set of files registering an Electron `before-quit` listener changed.",
        "Allow-list (src/main/__tests__/app-shutdown-order.test.ts, ALLOWED_LISTENER_FILES):",
        why,
        "A new listener needs an entry here only when its teardown CANNOT be a",
        "shutdown hook — it has to call event.preventDefault(), or its position",
        "relative to another teardown step matters. Everything else belongs in",
        "registerShutdownHook() (src/main/app-shutdown.ts), which shares the one",
        "listener main.ts owns and keeps the App emitter under Node's ceiling.",
      ].join("\n"),
    ).toEqual(allowed);
  });
});
