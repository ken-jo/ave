import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hostFrameEvent, untrustedEvent } from "../../../__tests__/test-helpers.js";
import { notifyBootstrapStatus } from "../../../boot/bootstrap-status.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const cleanupRoots: string[] = [];
const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => ""),
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: {
    fromId: vi.fn(),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(fn(hostFrameEvent(), ...args));
}

function makeWindow(options: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

async function setup(options: { appWindows?: ReturnType<typeof makeWindow>[] } = {}) {
  handlers.clear();
  vi.clearAllMocks();
  process.env.AVE_DEV = "1";
  const devFlags = await import("../../../boot/dev-flags.js");
  devFlags.setIsPackaged(false);
  const appWindows = options.appWindows ?? [makeWindow(), makeWindow()];
  const cleanupRoot = mkdtempSync(join(tmpdir(), "ave-plugin-ipc-"));
  cleanupRoots.push(cleanupRoot);
  const activePluginIds = new Set<string>();
  const deps = {
    pluginMarketplace: {
      getInstalledVersion: vi.fn(async () => "1.0.0"),
      uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
      resolveLocalInstallPluginId: vi.fn(async () => "local-plugin"),
      installLocal: vi.fn(),
    },
    pluginRuntime: {
      resolvePluginId: vi.fn((pluginId: string) => pluginId),
      resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
      resolvePluginInstallIdIfKnown: vi.fn((pluginId: string) => pluginId),
      cancelPendingRestart: vi.fn(),
      cancelAllPendingRestarts: vi.fn(),
      clearConfigOverride: vi.fn(),
      addPlugin: vi.fn(async (): Promise<"started" | "preparing" | undefined> => undefined),
      waitForPluginReady: vi.fn(async () => undefined),
      removePlugin: vi.fn(async () => undefined),
      removePluginWithCommit: vi.fn(async (
        _pluginId: string,
        durableCommit: () => Promise<unknown>,
      ) => durableCommit()),
      listPluginIds: vi.fn((): string[] => [...activePluginIds]),
      activatePreparedArtifact: vi.fn(),
      mergeConfigOverride: vi.fn(),
      setConfigOverride: vi.fn(),
      getPluginManifest: vi.fn(() => ({
        configSchema: {
          properties: {
            apiKey: { type: "string", format: "secret" },
            sttApiKey: { type: "string", format: "secret" },
          },
        },
      })),
    },
    settingsService: {
      get: vi.fn(() => ({})),
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
      setSecret: vi.fn(async () => undefined),
      getSecret: vi.fn(() => null),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async () => undefined),
    },
    auditLogger: {
      log: vi.fn(),
    },
    refreshPluginNotifications: vi.fn(),
    pluginPaths: { cacheRoot: join(cleanupRoot, ".cache") },
    clearAuthPartitionService: vi.fn(async () => undefined),
    listPluginAuthPartitionsService: vi.fn((pluginId: string) => [
      `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
      `persist:plugin-auth:${encodeURIComponent(pluginId)}:tenant`,
    ]),
    forgetPluginAuthPartitionsService: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
  };
  const runActivation = async (args: unknown[], pluginId: string): Promise<void> => {
    const options = args.find((arg): arg is {
      activatePreparedArtifact?: (prepared: {
        pluginRoot: string;
        manifest: { id: string; version: string };
        receiptRaw: string;
        registryEntry: { installSource?: "admin" | "user" | "local-dev"; manifestSha256?: string };
        durableCommit(): Promise<string>;
      }) => Promise<unknown>;
    } => typeof arg === "object" && arg !== null && "activatePreparedArtifact" in arg);
    if (!options?.activatePreparedArtifact) throw new Error("test install omitted atomic activation seam");
    await options.activatePreparedArtifact({
      installId: pluginId,
      pluginRoot: `/staged/${pluginId}`,
      manifest: { id: pluginId, version: "1.0.0" },
      receiptRaw: "{}",
      registryEntry: { installSource: "user" },
      durableCommit: async () => `${pluginId}/plugin.json`,
    });
  };
  deps.pluginRuntime.activatePreparedArtifact.mockImplementation(async (prepared: {
    installId: string;
    manifest: { id: string };
    durableCommit(): Promise<string>;
  }) => {
    const state = await deps.pluginRuntime.addPlugin(prepared.manifest.id);
    if (state === "preparing") await deps.pluginRuntime.waitForPluginReady(prepared.manifest.id);
    const result = await prepared.durableCommit();
    activePluginIds.add(prepared.manifest.id);
    return { result, retirement: Promise.resolve() };
  });
  deps.pluginMarketplace.installLocal.mockImplementation(async (...args: unknown[]) => {
    await runActivation(args, "local-plugin");
    return { pluginId: "local-plugin", installed: true };
  });
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, appWindows, runActivation };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  handlers.clear();
  delete process.env.AVE_DEV;
  electronMocks.showOpenDialog.mockReset();
});

describe("plugins IPC lifecycle broadcast", () => {
  it("serves the recorded bootstrap status to a renderer that mounted after boot", async () => {
    await setup();
    // Boot's own emit: on a cold boot there is no window listening yet, which
    // is why the record — not the send — is what the renderer can still read.
    notifyBootstrapStatus(null, {
      phase: "complete",
      installed: [],
      failed: [{ id: "meeting", error: "marketplace unreachable" }],
    });

    await expect(invoke("ave:bootstrap:status:get")).resolves.toEqual({
      phase: "complete",
      installed: [],
      failed: [{ id: "meeting", error: "marketplace unreachable" }],
    });
  });

  it("refuses the recorded bootstrap status to a foreign frame", async () => {
    const { deps } = await setup();
    notifyBootstrapStatus(null, { phase: "error", message: "catalog fetch failed" });

    const handler = handlers.get("ave:bootstrap:status:get");
    if (!handler) throw new Error("No handler registered for: ave:bootstrap:status:get");
    expect(await handler(untrustedEvent())).toBeNull();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("rejects endpoint URLs saved into API-key secret fields", async () => {
    const { deps } = await setup();

    const result = await invoke(
      "ave:plugins:config:secret:set",
      "meeting",
      "sttApiKey",
      "https://example.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions",
    );

    expect(result).toMatchObject({
      ok: false,
      error: "plugin-config-secret-invalid-value",
    });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("does not report endpoint URLs saved in API-key-like secret fields as present", async () => {
    const { deps } = await setup();
    deps.settingsService.getSecret.mockImplementation((key: string) => {
      if (key.endsWith(".apiKey")) return "sk-valid";
      if (key.endsWith(".sttApiKey")) return "https://example.openai.azure.com/openai/deployments/stt/audio/transcriptions";
      return null;
    });

    const result = await invoke("ave:plugins:config:secret:list-keys", "meeting");

    expect(result).toEqual({ ok: true, keys: ["apiKey"] });
  });
  it("broadcasts uninstall result to every app window", async () => {
    const { deps, appWindows } = await setup();

    await invoke("ave:plugins:uninstall", "agent-hub");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("agent-hub");
    expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
      "agent-hub",
      expect.any(Function),
    );
    expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("agent-hub");
    expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith("agent-hub", new Set(["apiKey", "sttApiKey"]));
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:agent-hub");
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:agent-hub:tenant");
    expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:uninstall-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("surfaces a deployment guard refusal as an uninstall failure", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(
      new Error("Managed plugin cannot be uninstalled by user: meeting"),
    );

    await expect(invoke("ave:plugins:uninstall", "meeting"))
      .rejects.toThrow("Managed plugin cannot be uninstalled by user: meeting");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("meeting");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:uninstall-result",
        { slug: "meeting", success: false, error: "Managed plugin cannot be uninstalled by user: meeting" },
      );
    }
  });

  it("removes plugin runtime BEFORE marketplace.uninstall (lifecycle §9 ordering)", async () => {
    // Regression guard for Windows EBUSY on fts5.sqlite-shm/-wal: marketplace
    // uninstall (rm files) must NOT run before runtime stop (close DB
    // handles). If the order regresses, the plugin's worker still holds
    // open SQLite WAL files when rm fires → EBUSY → half-deleted dir.
    const { deps } = await setup();

    await invoke("ave:plugins:uninstall", "agent-hub");

    const removePluginOrder = deps.pluginRuntime.removePluginWithCommit.mock.invocationCallOrder[0];
    const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
    expect(removePluginOrder).toBeLessThan(uninstallOrder);
  });

  it("surfaces removePlugin failure as uninstall failure (does not silently mutate registry)", async () => {
    // Production removePlugin (runtime/index.ts) currently swallows stop()
    // and disposer errors via try/catch + log.error and never re-throws.
    // This test guards a future tightening where removePlugin DOES throw
    // (e.g. invariant violation, runtime map corruption): the IPC handler
    // MUST surface that failure and NOT proceed to marketplace.uninstall —
    // otherwise registry mutation happens while runtime tracking still
    // references the plugin, leaving listPluginCards showing a ghost card.
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.removePluginWithCommit.mockRejectedValueOnce(new Error("dispose chain failed"));

    await expect(invoke("ave:plugins:uninstall", "agent-hub")).rejects.toThrow("dispose chain failed");

    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:uninstall-result",
        { slug: "agent-hub", success: false, error: "dispose chain failed" },
      );
    }
  });

  it("surfaces marketplace.uninstall non-idempotent failure (EACCES) after removePlugin succeeds", async () => {
    // After removePlugin already torn down runtime tracking, if marketplace
    // rm fails with a non-idempotent error (permission denied, IO error),
    // the user sees an explicit failure broadcast rather than silent ghost
    // state. removePlugin still ran — this is the expected partial-success
    // outcome, surfaced honestly.
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(invoke("ave:plugins:uninstall", "agent-hub")).rejects.toThrow("EACCES");

    expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
      "agent-hub",
      expect.any(Function),
    );
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:uninstall-result",
        { slug: "agent-hub", success: false, error: "EACCES: permission denied" },
      );
    }
  });

  it("broadcasts idempotent uninstall success when marketplace entry is already gone", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(new Error("Plugin not installed: agent-hub"));

    await expect(invoke("ave:plugins:uninstall", "agent-hub")).resolves.toEqual({
      pluginId: "agent-hub",
      uninstalled: true,
    });

    expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
      "agent-hub",
      expect.any(Function),
    );
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:uninstall-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("broadcasts local install success to every app window", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });

    await invoke("ave:plugins:install-local");

    expect(deps.pluginMarketplace.installLocal).toHaveBeenCalledWith(
      "/tmp/local-plugin",
      { activatePreparedArtifact: expect.any(Function) },
    );
    expect(deps.pluginRuntime.addPlugin).toHaveBeenCalledWith("local-plugin");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:install-result",
        { slug: "local-plugin", success: true },
      );
    }
  });

  it("blocks local install while committed cleanup remains pending", async () => {
    const { deps } = await setup();
    deps.pluginMarketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValue(null);
    deps.clearAuthPartitionService.mockRejectedValue(
      new Error("auth partition still busy"),
    );

    await expect(
      invoke("ave:plugins:uninstall", "local-plugin"),
    ).rejects.toThrow(/incomplete post-commit cleanup/);
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });

    await expect(
      invoke("ave:plugins:install-local"),
    ).rejects.toThrow(/cleanup pending/);
    expect(deps.pluginMarketplace.installLocal).not.toHaveBeenCalled();
  });

  it("broadcasts local staged activation failure without durable compensation", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("local runtime failed"));

    await expect(invoke("ave:plugins:install-local")).rejects.toThrow("local runtime failed");

    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:install-result",
        { slug: "local-plugin", success: false, error: "local runtime failed" },
      );
    }
  });

  it("keeps local reinstall durable state untouched when candidate activation fails", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });
    deps.pluginRuntime.listPluginIds.mockReturnValueOnce(["local-plugin"]);
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("local runtime failed"));

    await expect(invoke("ave:plugins:install-local")).rejects.toThrow("local runtime failed");

    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("local-plugin");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "ave:plugins:install-result",
        { slug: "local-plugin", success: false, error: "local runtime failed" },
      );
    }
  });

  it("skips destroyed app windows during lifecycle broadcast", async () => {
    const liveWindow = makeWindow();
    const destroyedWindow = makeWindow({ destroyed: true });
    await setup({ appWindows: [liveWindow, destroyedWindow] });

    await invoke("ave:plugins:uninstall", "agent-hub");

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      "ave:plugins:uninstall-result",
      { slug: "agent-hub", success: true },
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("forwards in-app notification detail clicks back to the renderer", async () => {
    const { appWindows } = await setup();
    const handler = handlers.get("ave:notification:clicked");
    expect(handler).toBeDefined();

    await Promise.resolve(handler!(
      { senderFrame: { url: "file:///tmp/ave/index.html" } },
      {
        kind: "ask-user",
        contextRef: {
          questionId: "q-1",
          ignored: "not-forwarded",
        },
      },
    ));

    expect(appWindows[0].show).toHaveBeenCalled();
    expect(appWindows[0].focus).toHaveBeenCalled();
    expect(appWindows[0].webContents.send).toHaveBeenCalledWith(
      "ave:notification:clicked",
      { kind: "ask-user", contextRef: { questionId: "q-1" } },
    );
  });

  it("rejects notification detail clicks from plugin UI frames", async () => {
    const { appWindows } = await setup();
    const handler = handlers.get("ave:notification:clicked");
    expect(handler).toBeDefined();

    const result = await Promise.resolve(handler!(
      { senderFrame: { url: "file:///tmp/ave/plugin-ui-shell.html" } },
      { kind: "ask-user", contextRef: { questionId: "q-1" } },
    ));

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(appWindows[0].show).not.toHaveBeenCalled();
    expect(appWindows[0].focus).not.toHaveBeenCalled();
    expect(appWindows[0].webContents.send).not.toHaveBeenCalledWith(
      "ave:notification:clicked",
      expect.anything(),
    );
  });
});
