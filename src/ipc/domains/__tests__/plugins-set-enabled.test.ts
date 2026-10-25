import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { PluginDeploymentDeniedError } from "../../../plugins/deployment-guard.js";
import { ContributionTrustReviewStaleError } from "../../../plugins/plugin-contribution-trust.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const hostEventMock = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

vi.mock("../../../boot/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../boot/types.js")>();
  return { ...actual, emitEvent: hostEventMock.emit };
});

// The shared invoker supplies a trusted host frame; hostile-frame cases invoke the handler directly.
const invoke = makeAppIpcInvoker(handlers);

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const appWindows = [makeWindow(), makeWindow()];
  const setPluginEnabled = vi.fn(async (pluginId: string) => {
    if (pluginId === "ghost") throw new Error("Plugin not found: ghost");
  });
  const callFromUi = vi.fn(async () => ({ ok: true }));
  const pluginBundleLifecycle = {
    listContributionTrust: vi.fn(() => [{
      kind: "hook",
      pluginId: "com.example.meeting",
      pluginVersion: "1.0.0",
      generationId: "a".repeat(64),
      localId: "policy",
      fingerprint: "b".repeat(64),
      status: "approval_required",
    }]),
    approveHook: vi.fn(async () => undefined),
    revokeHook: vi.fn(async () => undefined),
    approveMcpServer: vi.fn(async () => undefined),
    revokeMcpServer: vi.fn(async () => undefined),
  };
  let pluginConfig: Record<string, unknown> = { removed: "old", kept: "old" };
  const setPluginConfig = vi.fn(async (_pluginId: string, config: Record<string, unknown>) => {
    pluginConfig = { ...config };
    return pluginConfig;
  });
  const restartPlugin = vi.fn(async (): Promise<"started" | "failed"> => "started");
  let pluginCards: Array<{ id: string; lastAttemptRefusal?: unknown }> = [];
  const listPluginCards = vi.fn(() => pluginCards);
  const setSecret = vi.fn(async () => {});
  // Declare apiKey secret so secret-write tests reach the intended handler gate.
  const pluginManifest = {
    id: "plugin-config",
    configSchema: {
      properties: {
        apiKey: { type: "string", format: "secret" },
        kept: { type: "string" },
        removed: { type: "string" },
      },
    },
  };
  const deps = {
    pluginMarketplace: { list: vi.fn(async () => []) },
    pluginRuntime: {
      listPluginIds: vi.fn((): string[] => ["com.example.meeting"]),
      setPluginEnabled,
      callFromUi,
      getPluginManifest: vi.fn(() => pluginManifest),
      setConfigOverride: vi.fn(),
      restartPlugin,
      listPluginCards,
    },
    settingsService: {
      get: vi.fn(() => ({})),
      getPluginConfig: vi.fn(() => ({ ...pluginConfig })),
      setPluginConfig,
      setSecret,
    },
    auditLogger: { log: vi.fn() },
    refreshPluginEventBridge: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
    pluginBundleLifecycle,
  };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return {
    deps,
    appWindows,
    setPluginEnabled,
    callFromUi,
    pluginBundleLifecycle,
    setPluginConfig,
    restartPlugin,
    setSecret,
    seedPluginConfig: (next: Record<string, unknown>) => { pluginConfig = { ...next }; },
    readPluginConfig: () => ({ ...pluginConfig }),
    setPluginCards: (next: typeof pluginCards) => { pluginCards = next; },
  };
}

const REFUSAL_MESSAGE = "plugin 'plugin-config' does not declare a host protocol; this app serves 2";

function refuseRestart(
  harness: Awaited<ReturnType<typeof setup>>,
  refusal: { attempt: "update" | "restart"; at?: string } = { attempt: "restart" },
): void {
  harness.restartPlugin.mockImplementationOnce(async () => {
    harness.setPluginCards([{
      id: "plugin-config",
      lastAttemptRefusal: {
        attempt: refusal.attempt,
        kind: "incompatible-host-protocol",
        message: REFUSAL_MESSAGE,
        at: refusal.at ?? new Date().toISOString(),
      },
    }]);
    return "failed";
  });
}

beforeEach(() => {
  handlers.clear();
});

describe("ave:plugins:call", () => {
  it("rejects plugin UI shell frames from the host renderer call channel", async () => {
    const { deps, callFromUi } = await setup();
    const handler = handlers.get("ave:plugins:call");
    expect(handler).toBeDefined();
    const pluginShellEvent = { senderFrame: { url: "file:///dist/src/plugin-ui-shell.html" } };

    const res = await handler!(pluginShellEvent, "sample_ui_action", undefined, {
      userAction: true,
    });

    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(callFromUi).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("passes host renderer user action state to callFromUi", async () => {
    const { callFromUi } = await setup();

    const res = await invoke("ave:plugins:call", "sample_ui_action", { id: 1 }, {
      userAction: true,
      operationGrantToken: "opaque-token",
    });

    expect(res).toEqual({ ok: true });
    expect(callFromUi).toHaveBeenCalledWith("sample_ui_action", { id: 1 }, {
      userAction: true,
      appSessionId: "plugin-ui:0:0",
      operationGrantToken: "opaque-token",
    });
  });
});

describe("plugin bundled contribution trust IPC", () => {
  it("fails closed when the required bundle lifecycle service is unavailable", async () => {
    const { deps } = await setup();
    deps.pluginBundleLifecycle = undefined as never;

    const listed = await invoke("ave:plugins:contribution-trust:list", "com.example.meeting");

    expect(listed).toEqual({
      ok: false,
      error: "plugin-bundle-lifecycle-unavailable",
    });
  });

  it("lists quarantined exact identities and approves only the requested capability", async () => {
    const { pluginBundleLifecycle } = await setup();
    const listed = await invoke("ave:plugins:contribution-trust:list", "com.example.meeting");
    expect(listed).toEqual({ ok: true, rows: [expect.objectContaining({ localId: "policy", status: "approval_required" })] });

    const updated = await invoke("ave:plugins:contribution-trust:set", {
      pluginId: "com.example.meeting",
      localId: "policy",
      kind: "hook",
      approved: true,
      generationId: "a".repeat(64),
      approvalDigest: "c".repeat(64),
    });
    expect(updated).toEqual(expect.objectContaining({ ok: true, approved: true }));
    expect(pluginBundleLifecycle.approveHook).toHaveBeenCalledWith("com.example.meeting", "policy", { generationId: "a".repeat(64), approvalDigest: "c".repeat(64) });
    expect(pluginBundleLifecycle.approveMcpServer).not.toHaveBeenCalled();
  });

  it("an approval names the reviewed generation and digest; a revoke names neither", async () => {
    const { pluginBundleLifecycle } = await setup();
    const request = { pluginId: "com.example.meeting", localId: "policy", kind: "hook" };
    for (const invalid of [
      { ...request, approved: true },
      { ...request, approved: true, generationId: "a".repeat(64) },
      { ...request, approved: true, generationId: "not-a-generation", approvalDigest: null },
      { ...request, approved: false, generationId: "a".repeat(64), approvalDigest: null },
    ]) {
      expect(await invoke("ave:plugins:contribution-trust:set", invalid)).toEqual({ ok: false, error: "invalid-contribution-trust-request" });
    }
    expect(pluginBundleLifecycle.approveHook).not.toHaveBeenCalled();
    expect(pluginBundleLifecycle.revokeHook).not.toHaveBeenCalled();

    // An unknown closure may be approved, but the approval cannot carry forward.
    await invoke("ave:plugins:contribution-trust:set", { ...request, approved: true, generationId: "a".repeat(64), approvalDigest: null });
    expect(pluginBundleLifecycle.approveHook).toHaveBeenCalledWith("com.example.meeting", "policy", { generationId: "a".repeat(64), approvalDigest: null });
    await invoke("ave:plugins:contribution-trust:set", { ...request, approved: false });
    expect(pluginBundleLifecycle.revokeHook).toHaveBeenCalledWith("com.example.meeting", "policy");
  });

  it("reports a review of a generation that has since been replaced as stale", async () => {
    const { pluginBundleLifecycle } = await setup();
    pluginBundleLifecycle.approveMcpServer.mockRejectedValueOnce(new ContributionTrustReviewStaleError("com.example.meeting", "notes"));
    expect(await invoke("ave:plugins:contribution-trust:set", {
      pluginId: "com.example.meeting", localId: "notes", kind: "mcpServer", approved: true,
      generationId: "a".repeat(64), approvalDigest: "c".repeat(64),
    })).toEqual(expect.objectContaining({ ok: false, error: "contribution-trust-review-stale" }));
  });
});

describe("ave:plugins:set-enabled", () => {
  it("persists the toggle and emits both the host event and the window broadcast", async () => {
    const { setPluginEnabled, appWindows } = await setup();

    const res = await invoke("ave:plugins:set-enabled", "com.example.meeting", false);

    expect(res).toEqual({ ok: true, pluginId: "com.example.meeting", enabled: false });
    expect(setPluginEnabled).toHaveBeenCalledWith("com.example.meeting", false);
    expect(hostEventMock.emit).toHaveBeenCalledWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting",
      enabled: false,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith("ave:plugins:enabled-changed", {
        pluginId: "com.example.meeting",
        enabled: false,
      });
    }
  });

  it("re-enable round-trips through setPluginEnabled(true)", async () => {
    const { setPluginEnabled } = await setup();
    const res = await invoke("ave:plugins:set-enabled", "com.example.meeting", true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    expect(setPluginEnabled).toHaveBeenCalledWith("com.example.meeting", true);
  });

  it("returns a kebab-case error for an unknown plugin id", async () => {
    await setup();
    const res = await invoke("ave:plugins:set-enabled", "ghost", false);
    expect(res).toMatchObject({ ok: false, error: "no-such-plugin" });
    expect(hostEventMock.emit).not.toHaveBeenCalled();
  });

  it("rejects a non-string pluginId with invalid-plugin-id", async () => {
    await setup();
    const res = await invoke("ave:plugins:set-enabled", 42, false);
    expect(res).toMatchObject({ ok: false, error: "invalid-plugin-id" });
  });

  it("rejects a non-boolean enabled with invalid-enabled", async () => {
    await setup();
    const res = await invoke("ave:plugins:set-enabled", "com.example.meeting", "nope");
    expect(res).toMatchObject({ ok: false, error: "invalid-enabled" });
  });

  it("rejects a disallowed sender frame (validateSender)", async () => {
    const { deps, setPluginEnabled } = await setup();
    const handler = handlers.get("ave:plugins:set-enabled");
    expect(handler).toBeDefined();
    const hostileEvent = { senderFrame: { url: "https://evil.example/" } };
    const res = await handler!(hostileEvent, "com.example.meeting", false);
    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("rejects plugin UI shell file frames for this host-internal mutation", async () => {
    const { deps, setPluginEnabled } = await setup();
    const handler = handlers.get("ave:plugins:set-enabled");
    expect(handler).toBeDefined();
    const pluginShellEvent = { senderFrame: { url: "file:///dist/src/plugin-ui-shell.html" } };
    const res = await handler!(pluginShellEvent, "com.example.meeting", false);
    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("maps a deployment-guard denial to disable-not-permitted without broadcasting", async () => {
    const { setPluginEnabled, appWindows } = await setup();
    setPluginEnabled.mockRejectedValueOnce(
      new PluginDeploymentDeniedError(
        "Admin plugin cannot be uninstalled by user: com.example.meeting (registry installSource=\"admin\")",
      ),
    );

    const res = await invoke("ave:plugins:set-enabled", "com.example.meeting", false);

    expect(res).toMatchObject({ ok: false, error: "disable-not-permitted" });
    expect((res as { message: string }).message).not.toMatch(/installSource/);
    expect(hostEventMock.emit).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        "ave:plugins:enabled-changed",
        expect.anything(),
      );
    }
  });

  it("maps runtime I/O failures to generic toggle-failed without broadcasting", async () => {
    const { setPluginEnabled, appWindows } = await setup();
    setPluginEnabled.mockRejectedValueOnce(new Error("EACCES: permission denied, open /Users/example/.ave/plugins/registry.json"));
    const res = await invoke("ave:plugins:set-enabled", "com.example.meeting", false);
    expect(res).toEqual({
      ok: false,
      error: "toggle-failed",
      message: "plugin enabled state could not be changed",
    });
    expect(hostEventMock.emit).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith("ave:plugins:enabled-changed", expect.anything());
    }
  });
});

describe("ave:plugins:config:set", () => {
  it("emits undefined for deleted keys captured before persistence", async () => {
    const { subscribePluginConfigChange } = await import("../../../plugins/config-change-bus.js");
    await setup();
    const observed: unknown[] = [];
    const unsubscribe = subscribePluginConfigChange(
      "plugin-config",
      "removed",
      (_key, value) => { observed.push(value); },
    );
    try {
      const result = await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });
      expect(result).toEqual({ ok: true, config: { kept: "new" } });
      expect(observed).toEqual([undefined]);
    } finally {
      unsubscribe();
    }
  });

  it("waits for the shared plugin lifecycle lock before saving or restarting", async () => {
    const { withPluginInstallLock } = await import("../../../plugins/install-lifecycle.js");
    const { setPluginConfig, restartPlugin } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const held = withPluginInstallLock("plugin-config", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const configSet = invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });
    await Promise.resolve();
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();

    release();
    await held;
    await expect(configSet).resolves.toMatchObject({ ok: true });
    expect(setPluginConfig).toHaveBeenCalledOnce();
    expect(restartPlugin).toHaveBeenCalledOnce();
  });

  it("does not recreate config when uninstall removes the plugin before a queued save", async () => {
    const { withPluginInstallLock } = await import("../../../plugins/install-lifecycle.js");
    const { deps, setPluginConfig, restartPlugin } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const uninstall = withPluginInstallLock("plugin-config", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const configSet = invoke("ave:plugins:config:set", "plugin-config", { kept: "stale" });
    await Promise.resolve();
    expect(setPluginConfig).not.toHaveBeenCalled();
    deps.pluginRuntime.getPluginManifest.mockReturnValue(null);

    release();
    await uninstall;
    await expect(configSet).resolves.toMatchObject({
      ok: false,
      error: "plugin-config-save-failed",
    });
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });

  it("reports a saved config whose targeted runtime reload failed", async () => {
    const { restartPlugin, setPluginConfig } = await setup();
    restartPlugin.mockResolvedValueOnce("failed");

    const result = await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });

    expect(result).toMatchObject({ ok: false, error: "plugin-config-save-failed" });
    expect(result).toMatchObject({ message: expect.stringContaining("runtime reload returned failed") });
    expect(setPluginConfig).toHaveBeenCalledOnce();
  });
});

describe("config and secret saves whose restart the child factory refused", () => {
  it("replies to a config save with the recorded refusal", async () => {
    const harness = await setup();
    refuseRestart(harness);

    const result = await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });

    expect(result).toMatchObject({
      ok: false,
      error: "plugin-config-save-failed",
      message: `Plugin config saved but runtime reload refused: ${REFUSAL_MESSAGE}`,
    });
    expect(harness.setPluginConfig).toHaveBeenCalledOnce();
  });

  it("replies to a secret save with the recorded refusal", async () => {
    const harness = await setup();
    harness.seedPluginConfig({ apiKey: "sk-OLD-plaintext" });
    refuseRestart(harness);

    const result = await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "sk-live-000");

    expect(result).toMatchObject({
      ok: false,
      error: "plugin-config-secret-save-failed",
      message: `Plugin secret saved but runtime reload refused: ${REFUSAL_MESSAGE}`,
    });
  });

  it("does not explain a failure with a refusal recorded before this restart", async () => {
    const harness = await setup();
    refuseRestart(harness, { attempt: "restart", at: new Date(0).toISOString() });

    const result = await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });

    expect(result).toMatchObject({
      ok: false,
      error: "plugin-config-save-failed",
      message: expect.stringContaining("runtime reload returned failed"),
    });
  });

  it("does not explain a restart failure with an update's refusal", async () => {
    const harness = await setup();
    refuseRestart(harness, { attempt: "update" });

    const result = await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" });

    expect(result).toMatchObject({ message: expect.stringContaining("runtime reload returned failed") });
  });
});

// Restart only when cleartext config changed and restarting is safe; see plugins/config-restart-policy.ts.
describe("ave:plugins:config:secret:set — restart policy", () => {
  it("does NOT restart for a plain secret write (secrets never enter ctx.config)", async () => {
    const { restartPlugin, setPluginConfig, setSecret, seedPluginConfig } = await setup();
    seedPluginConfig({ kept: "old" });

    const result = await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "sk-live-123");

    expect(result).toEqual({ ok: true });
    expect(setSecret).toHaveBeenCalledWith("plugin.plugin-config.apiKey", "sk-live-123");
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });

  it("DOES restart when it deletes a stray cleartext copy of the secret key", async () => {
    const { restartPlugin, setPluginConfig, setSecret, seedPluginConfig, readPluginConfig } = await setup();
    // An update may reclassify an existing plaintext key as secret, leaving a legacy cleartext copy.
    seedPluginConfig({ kept: "old", apiKey: "sk-OLD-plaintext" });

    const result = await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "sk-live-456");

    expect(result).toEqual({ ok: true });
    expect(setSecret).toHaveBeenCalledWith("plugin.plugin-config.apiKey", "sk-live-456");
    expect(setPluginConfig).toHaveBeenCalledOnce();
    expect(readPluginConfig()).toEqual({ kept: "old" });
    expect(restartPlugin).toHaveBeenCalledOnce();
    expect(restartPlugin).toHaveBeenCalledWith("plugin-config", { skipPreparation: true });
  });

  it("restarts OUTSIDE the install lock, like config:set", async () => {
    const { withPluginInstallLock } = await import("../../../plugins/install-lifecycle.js");
    const { restartPlugin, setPluginConfig, seedPluginConfig } = await setup();
    seedPluginConfig({ apiKey: "sk-OLD-plaintext" });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const held = withPluginInstallLock("plugin-config", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const secretSet = invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "sk-live-789");
    await Promise.resolve();
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();

    release();
    await held;
    await expect(secretSet).resolves.toEqual({ ok: true });
    expect(restartPlugin).toHaveBeenCalledOnce();
  });

  it("reports a saved secret whose targeted runtime reload failed", async () => {
    const { restartPlugin, setSecret, seedPluginConfig } = await setup();
    seedPluginConfig({ apiKey: "sk-OLD-plaintext" });
    restartPlugin.mockResolvedValueOnce("failed");

    const result = await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "sk-live-000");

    expect(result).toMatchObject({ ok: false, error: "plugin-config-secret-save-failed" });
    expect(result).toMatchObject({ message: expect.stringContaining("runtime reload returned failed") });
    expect(setSecret).toHaveBeenCalledOnce();
  });

  it("rejects a key the manifest does not declare secret, without touching anything", async () => {
    const { restartPlugin, setPluginConfig, setSecret, seedPluginConfig } = await setup();
    seedPluginConfig({ kept: "old" });

    const result = await invoke("ave:plugins:config:secret:set", "plugin-config", "kept", "not-a-secret");

    expect(result).toMatchObject({ ok: false, error: "plugin-config-secret-invalid-key" });
    expect(setSecret).not.toHaveBeenCalled();
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });
});

describe("ave:mcp:import:claude-desktop:apply", () => {
  it("says why each server was not added as a kind the renderer words, with main's reason kept for Copy details", async () => {
    const { deps } = await setup();
    // Use the OS error shape; chmod cannot reliably deny writes on Windows or as root.
    const denied = Object.assign(new Error("EACCES: permission denied, open '/Users/me/.ave/mcp-servers.json'"), { code: "EACCES", errno: -13, syscall: "open" });
    const addConfig = vi.fn(async (config: { id: string }) => {
      if (config.id === "files") throw denied;
      if (config.id === "notes") throw new Error("[mcp-manager] governance refused notes");
      return { connected: true };
    });
    Object.assign(deps, { mcpManager: { getConfigs: vi.fn(async () => []), removeConfig: vi.fn(), addConfig } });
    const raw = JSON.stringify({ mcpServers: { files: { command: "npx", args: ["files"] }, notes: { command: "npx", args: ["notes"] }, web: { command: "npx", args: ["web"] } } });

    const res = await invoke("ave:mcp:import:claude-desktop:apply", { raw, conflictPolicy: "skip" });

    expect(res).toMatchObject({
      ok: true,
      results: [
        { id: "files", action: "failed", failure: "permission-denied", reason: denied.message },
        { id: "notes", action: "failed", failure: "other", reason: "[mcp-manager] governance refused notes" },
        { id: "web", action: "added" },
      ],
    });
  });
});
