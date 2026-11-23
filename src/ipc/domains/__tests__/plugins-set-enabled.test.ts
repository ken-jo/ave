import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmpDirTracker } from "../../../__tests__/support/tmp-dir-teardown.js";
import { hostFrameEvent } from "../../../__tests__/test-helpers.js";
import { invokeAppIpcHandlerFromFrame, makeAppIpcInvoker } from "./test-helpers.js";
import type { ApprovalGate } from "../../../permissions/approval-gate.js";
import { EffectBoundaryDeniedError, gateMutatingEffect, runWithEffectGateContext } from "../../../permissions/effect-enforcement.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { PluginDeploymentDeniedError } from "../../../plugins/deployment-guard.js";
import { ContributionTrustReviewStaleError } from "../../../plugins/plugin-contribution-trust.js";
import { backgroundEffectSubject, PluginBackgroundEffectApprovals, withinBackgroundScope } from "../../../plugins/plugin-background-effects.js";
import type { PluginManifest, PluginRegistryTrust } from "../../../plugins/types.js";

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
  const stateChangeListeners = new Set<(pluginId: string, enabled: boolean) => void>();
  const notifyStateChange = (pluginId: string, enabled: boolean) => {
    for (const listener of stateChangeListeners) listener(pluginId, enabled);
  };
  const setPluginEnabled = vi.fn(async (pluginId: string, enabled: boolean) => {
    if (pluginId === "ghost") throw new Error("Plugin not found: ghost");
    notifyStateChange(pluginId, enabled);
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
  const deleteSecret = vi.fn(async () => {});
  // Declare apiKey secret so secret-write tests reach the intended handler gate.
  const pluginManifest = {
    id: "plugin-config",
    name: "Config",
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
      resolvePluginId: vi.fn((pluginId: string) => pluginId),
      subscribePluginStateChange: vi.fn((listener: (pluginId: string, enabled: boolean) => void) => {
        stateChangeListeners.add(listener);
        return () => { stateChangeListeners.delete(listener); };
      }),
      listPluginIds: vi.fn((): string[] => ["com.example.meeting"]),
      setPluginEnabled,
      isPluginEnabled: vi.fn(() => true),
      callFromUi,
      getPluginManifest: vi.fn(() => pluginManifest),
      setConfigOverride: vi.fn(),
      restartPlugin,
      listPluginCards,
      getPerfStats: vi.fn(() => [{ pluginId: "plugin-config", calls: 2 }]),
    },
    settingsService: {
      get: vi.fn(() => ({})),
      getPluginConfig: vi.fn(() => ({ ...pluginConfig })),
      setPluginConfig,
      setSecret,
      deleteSecret,
      hasStoredSecret: vi.fn(async () => false),
      getSecret: vi.fn(async () => null),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
    pluginBundleLifecycle,
    pluginBackgroundEffects: new PluginBackgroundEffectApprovals(),
  };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return {
    deps,
    appWindows,
    setPluginEnabled,
    notifyStateChange,
    callFromUi,
    pluginBundleLifecycle,
    setPluginConfig,
    restartPlugin,
    setSecret,
    deleteSecret,
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
  it("rejects isolated app-resource frames from the host renderer call channel", async () => {
    const { deps, callFromUi } = await setup();
    const handler = handlers.get("ave:plugins:call");
    expect(handler).toBeDefined();
    const pluginShellEvent = { senderFrame: { url: "ave-mcp-app://s-66697874757265/proxy.html?t=fixture" } };

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

describe("plugin background effects IPC", () => {
  const entry = (sourceId = "example-source"): PluginRegistryTrust => ({
    installSource: "user",
    origin: {
      sourceId, sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/sample", version: "1.0.0",
      rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z",
    },
  });
  const manifestWith = (allowedDomains: string[]) =>
    ({ id: "plugin-config", name: "Config", version: "1.0.0", entry: "plugin.mjs", tools: [], networkAccess: { allowedDomains } }) as never;

  async function running(allowedDomains: string[], source = entry()) {
    const context = await setup();
    const state = { manifest: manifestWith(allowedDomains), source };
    context.deps.pluginBackgroundEffects.bindSubject("plugin-config", async () => backgroundEffectSubject(state.manifest, state.source));
    return { ...context, state };
  }

  it("shows the running plugin's declared effects and approves only the review it showed", async () => {
    const { deps, state } = await running(["api.example.test"]);
    const shown = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    expect(shown).toEqual({
      ok: true, pluginId: "plugin-config", name: "Config", reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), declared: true, approved: false,
      effects: {
        ownStorage: true, networkDestinations: ["api.example.test"], alertKinds: [], suggestionSources: [], llm: false, workers: false,
      },
    });
    state.manifest = manifestWith(["api.example.test", "upload.example.test"]);
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: shown.reviewSha256 }))
      .toEqual({ ok: false, error: "background-effects-review-stale" });
    const updated = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    expect(updated).toMatchObject({ ok: true, approved: false });
    expect(updated.reviewSha256).not.toBe(shown.reviewSha256);
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: updated.reviewSha256 }))
      .toEqual({ ok: true, pluginId: "plugin-config", reviewSha256: updated.reviewSha256 });
    const subject = await deps.pluginBackgroundEffects.currentSubject("plugin-config");
    expect(subject && deps.pluginBackgroundEffects.isApproved(subject)).toBe(true);
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toMatchObject({ ok: true, approved: true });
  });

  it("re-asks when the same id now comes from another source", async () => {
    const { state } = await running(["api.example.test"]);
    const shown = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: shown.reviewSha256 });
    state.source = entry("other-source");
    const after = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    expect(after).toMatchObject({ ok: true, declared: true, approved: false });
    expect(after.reviewSha256).not.toBe(shown.reviewSha256);
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: shown.reviewSha256 }))
      .toEqual({ ok: false, error: "background-effects-review-stale" });
  });

  it("names a new review after any uninstall, so a reinstall from the same source is asked again even if its card was dismissed", async () => {
    const { deps } = await running(["api.example.test"]);
    const shown = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    deps.pluginBackgroundEffects.revoke("plugin-config");
    const reinstalled = await invoke("ave:plugins:background-effects:get", "plugin-config") as { reviewSha256: string };
    expect(reinstalled).toMatchObject({ ok: true, declared: true, approved: false, reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(reinstalled.reviewSha256).not.toBe(shown.reviewSha256);
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: shown.reviewSha256 }))
      .toEqual({ ok: false, error: "background-effects-review-stale" });
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: reinstalled.reviewSha256 }))
      .toEqual({ ok: true, pluginId: "plugin-config", reviewSha256: reinstalled.reviewSha256 });
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toMatchObject({ ok: true, approved: true, reviewSha256: reinstalled.reviewSha256 });
  });

  it("offers no review for an empty scope or an unpinned source", async () => {
    const empty = await running([]);
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toMatchObject({ ok: true, reviewSha256: null, declared: false, approved: false });
    empty.state.manifest = manifestWith(["api.example.test"]);
    empty.state.source = { installSource: "user" };
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toMatchObject({ ok: true, reviewSha256: null, declared: true, approved: false });
  });

  it("refuses malformed requests, a plugin with no running subject and an unknown plugin", async () => {
    const { deps } = await setup();
    for (const invalid of [undefined, { pluginId: "plugin-config" }, { pluginId: "plugin-config", reviewSha256: "x" }]) {
      expect(await invoke("ave:plugins:background-effects:approve", invalid)).toEqual({ ok: false, error: "invalid-background-effects-request" });
    }
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toEqual({ ok: false, error: "background-effects-unavailable" });
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "plugin-config", reviewSha256: "a".repeat(64) }))
      .toEqual({ ok: false, error: "background-effects-unavailable" });
    deps.pluginRuntime.getPluginManifest.mockReturnValue(undefined as never);
    expect(await invoke("ave:plugins:background-effects:get", "plugin-config")).toEqual({ ok: false, error: "no-such-plugin" });
  });
});

describe("plugin background effects first-launch card IPC", () => {
  const tmpDirs = createTmpDirTracker();
  afterEach(() => tmpDirs.cleanup());
  const GET = "ave:plugins:background-effects:upgrade-get";
  const DONE = "ave:plugins:background-effects:upgrade-done";
  const pinned = (packagePath: string): PluginRegistryTrust => ({
    installSource: "user",
    origin: {
      sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath, version: "1.0.0",
      rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z",
    },
  });
  const manifestOf = (id: string, capabilities: string[]) =>
    ({ id, name: `Plugin ${id}`, version: "1.0.0", entry: "plugin.mjs", tools: [], capabilities }) as unknown as PluginManifest;
  const llm = { manifest: manifestOf("llm", ["background:call-llm"]), source: pinned("plugins/llm") };
  const installed = new Map<string, { manifest: PluginManifest; source: PluginRegistryTrust }>([
    ["llm", llm],
    ["unpinned", { manifest: manifestOf("unpinned", ["background:call-llm"]), source: { installSource: "user" } }],
    ["quiet", { manifest: manifestOf("quiet", []), source: pinned("plugins/quiet") }],
    ["off", { manifest: manifestOf("off", ["background:call-llm"]), source: pinned("plugins/off") }],
  ]);
  const cardPath = (prefix: string) => join(tmpDirs.track(mkdtempSync(join(tmpdir(), prefix))), "background-effects.json");

  /** A launch over plugins already installed: boot started and bound every enabled one, and no enable or update event fired. */
  async function launch(path: string) {
    const context = await setup();
    const store = new PluginBackgroundEffectApprovals(path);
    context.deps.pluginBackgroundEffects = store;
    context.deps.pluginRuntime.listPluginIds.mockReturnValue([...installed.keys()]);
    context.deps.pluginRuntime.isPluginEnabled.mockImplementation(((pluginId: string) => pluginId !== "off") as never);
    context.deps.pluginRuntime.getPluginManifest.mockImplementation(((pluginId: string) => installed.get(pluginId)?.manifest) as never);
    for (const [pluginId, { manifest, source }] of installed) store.bindSubject(pluginId, async () => backgroundEffectSubject(manifest, source));
    return { ...context, store };
  }

  const asked = vi.fn();
  const permissionManager = () => new PermissionManager(cardPath("ave-upgrade-policy-").replace(/background-effects\.json$/u, "permissions.json"));
  /** A background callLlm through the standalone gate, with the scope check the HostApi factory wires to the same store. */
  const backgroundLlm = (store: PluginBackgroundEffectApprovals, manager: PermissionManager) =>
    runWithEffectGateContext({ headless: false, standalone: true, toolName: "background" }, () => gateMutatingEffect({
      pluginId: "llm", methodPath: "callLlm", effect: "write", target: undefined, input: [{ prompt: "hello" }],
      approvalGate: { requestAndWait: asked } as unknown as ApprovalGate, permissionManager: manager,
      standaloneScope: async (methodPath, target) => {
        const subject = backgroundEffectSubject(llm.manifest, llm.source);
        return withinBackgroundScope(subject.effects, methodPath, target) && store.isApproved(subject);
      },
    }));

  it("lists every enabled plugin with an unapproved declared scope once, and an allowed one resumes background effects", async () => {
    const path = cardPath("ave-upgrade-card-");
    const manager = permissionManager();
    const { store } = await launch(path);
    await expect(backgroundLlm(store, manager)).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    const card = await invoke(GET) as { ok: true; reviews: Array<{ pluginId: string; reviewSha256: string | null }> };
    expect(card).toEqual({ ok: true, reviews: [
      { pluginId: "llm", name: "Plugin llm", reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), effects: expect.objectContaining({ llm: true }) },
      { pluginId: "unpinned", name: "Plugin unpinned", reviewSha256: null, effects: expect.objectContaining({ llm: true }) },
    ] });
    expect(await invoke(GET)).toEqual(card);
    expect(await invoke("ave:plugins:background-effects:approve", { pluginId: "llm", reviewSha256: card.reviews[0]?.reviewSha256 }))
      .toMatchObject({ ok: true, pluginId: "llm" });
    await expect(backgroundLlm(store, manager)).resolves.toBeUndefined();
    expect(await invoke(DONE)).toEqual({ ok: true });
    expect(await invoke(GET)).toEqual({ ok: true, reviews: [] });

    const next = await launch(path);
    expect(await invoke(GET)).toEqual({ ok: true, reviews: [] });
    await expect(backgroundLlm(next.store, manager)).resolves.toBeUndefined();
    expect(asked).not.toHaveBeenCalled();
  });

  it("leaves the Review badge after Later, and shows no card at the next launch", async () => {
    const path = cardPath("ave-upgrade-later-");
    const manager = permissionManager();
    const { store } = await launch(path);
    const card = await invoke(GET) as { reviews: Array<{ pluginId: string; reviewSha256: string | null }> };
    expect(card.reviews.map(({ pluginId }) => pluginId)).toEqual(["llm", "unpinned"]);
    expect(await invoke(DONE)).toEqual({ ok: true });
    expect(await invoke(GET)).toEqual({ ok: true, reviews: [] });
    expect(await invoke("ave:plugins:background-effects:get", "llm"))
      .toMatchObject({ ok: true, declared: true, approved: false, reviewSha256: card.reviews[0]?.reviewSha256 });
    await expect(backgroundLlm(store, manager)).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    await launch(path);
    expect(await invoke(GET)).toEqual({ ok: true, reviews: [] });
    expect(await invoke("ave:plugins:background-effects:get", "llm")).toMatchObject({ ok: true, approved: false });
  });

  it("answers neither channel to a frame that is not the host renderer", async () => {
    const { store } = await launch(cardPath("ave-upgrade-sender-"));
    for (const channel of [GET, DONE]) {
      expect(await invokeAppIpcHandlerFromFrame(handlers, channel, "ave-mcp-app://s-66697874757265/proxy.html?t=fixture"))
        .toEqual({ ok: false, error: "unauthorized-frame" });
    }
    expect(store.upgradeReviewOwed()).toBe(true);
  });

  it("shows the card in the first window that lists it until that window goes away", async () => {
    await launch(cardPath("ave-upgrade-window-"));
    const windowOf = (id: number) => {
      const window = { id, destroyed: false, isDestroyed: () => window.destroyed };
      return window;
    };
    const [first, second] = [windowOf(1), windowOf(2)];
    const list = (sender: ReturnType<typeof windowOf>) =>
      handlers.get(GET)?.({ ...hostFrameEvent(), sender }) as Promise<{ ok: boolean; reviews?: unknown[]; error?: string }>;
    expect(await list(first)).toMatchObject({ ok: true, reviews: [expect.anything(), expect.anything()] });
    expect(await list(second)).toEqual({ ok: false, error: "background-effects-upgrade-elsewhere" });
    expect(await list(first)).toMatchObject({ ok: true, reviews: [expect.anything(), expect.anything()] });
    first.destroyed = true;
    expect(await list(second)).toMatchObject({ ok: true, reviews: [expect.anything(), expect.anything()] });
  });
});

describe("ave:plugins:set-enabled", () => {
  it.each([
    ["successful disable retry", false, true],
    ["plain enable", true, false],
    ["plain disable", false, false],
  ])("broadcasts exactly once for a %s", async (_label, enabled, cleanup) => {
    const { setPluginEnabled, appWindows, notifyStateChange } = await setup();
    setPluginEnabled.mockImplementationOnce(async () => {
      notifyStateChange("com.example.meeting", cleanup ? false : enabled);
    });
    await expect(invoke("ave:plugins:set-enabled", "com.example.meeting", enabled))
      .resolves.toMatchObject({ ok: true, enabled });
    expect(hostEventMock.emit).toHaveBeenCalledExactlyOnceWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting", enabled,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("ave:plugins:enabled-changed", {
        pluginId: "com.example.meeting", enabled,
      });
    }
  });

  it("forwards both transitions when recovery overlaps an enable request", async () => {
    const { setPluginEnabled, appWindows, notifyStateChange, deps } = await setup();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    setPluginEnabled.mockImplementationOnce(async () => {
      await ready;
      notifyStateChange("com.example.meeting", true);
    });
    const enable = invoke("ave:plugins:set-enabled", "meeting", true);
    notifyStateChange("com.example.meeting", false);
    release();
    await expect(enable).resolves.toMatchObject({ ok: true });
    expect(deps.pluginRuntime.subscribePluginStateChange).toHaveBeenCalledTimes(1);
    expect(hostEventMock.emit.mock.calls).toEqual([
      ["plugin.enabled-changed", { pluginId: "com.example.meeting", enabled: false }],
      ["plugin.enabled-changed", { pluginId: "com.example.meeting", enabled: true }],
    ]);
    for (const win of appWindows) {
      expect(win.webContents.send.mock.calls).toEqual([
        ["ave:plugins:enabled-changed", { pluginId: "com.example.meeting", enabled: false }],
        ["ave:plugins:enabled-changed", { pluginId: "com.example.meeting", enabled: true }],
      ]);
    }
  });

  it("broadcasts automatic recovery exactly once without a toggle request", async () => {
    const { appWindows, notifyStateChange } = await setup();
    notifyStateChange("com.example.meeting", false);
    expect(hostEventMock.emit).toHaveBeenCalledExactlyOnceWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting", enabled: false,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("ave:plugins:enabled-changed", {
        pluginId: "com.example.meeting", enabled: false,
      });
    }
  });

  it("recognizes cleanup notifications for a toggle addressed by install alias", async () => {
    const { deps, setPluginEnabled, notifyStateChange } = await setup();
    deps.pluginRuntime.resolvePluginId.mockReturnValue("com.example.meeting");
    setPluginEnabled.mockImplementationOnce(async () => {
      notifyStateChange("com.example.meeting", false);
    });
    await expect(invoke("ave:plugins:set-enabled", "meeting", false)).resolves.toMatchObject({ ok: true });
    expect(hostEventMock.emit).toHaveBeenCalledExactlyOnceWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting", enabled: false,
    });
  });

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
    const pluginShellEvent = { senderFrame: { url: "ave-mcp-app://s-66697874757265/proxy.html?t=fixture" } };
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

  it("broadcasts confirmed cleanup while preserving the refused enable result", async () => {
    const { deps, setPluginEnabled, appWindows, notifyStateChange } = await setup();
    deps.pluginRuntime.isPluginEnabled.mockReturnValue(false);
    setPluginEnabled.mockImplementationOnce(async () => {
      notifyStateChange("com.example.meeting", false);
      throw new Error("previous plugin shutdown is now confirmed for com.example.meeting; enable again");
    });
    const result = await invoke("ave:plugins:set-enabled", "com.example.meeting", true);
    expect(result).toMatchObject({ ok: false, error: "toggle-failed" });
    expect(hostEventMock.emit).toHaveBeenCalledExactlyOnceWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting", enabled: false,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("ave:plugins:enabled-changed", {
        pluginId: "com.example.meeting", enabled: false,
      });
    }
  });

  it.each(["retirement", "projection"])("broadcasts a committed disable once while reporting unfinished %s", async (failure) => {
    const { deps, setPluginEnabled, appWindows, notifyStateChange } = await setup();
    deps.pluginRuntime.isPluginEnabled.mockReturnValue(false);
    setPluginEnabled.mockImplementationOnce(async () => {
      notifyStateChange("com.example.meeting", false);
      throw new Error(`${failure} is unconfirmed; retry the enabled-state change`);
    });
    const result = await invoke("ave:plugins:set-enabled", "com.example.meeting", false);
    expect(result).toMatchObject({ ok: false, error: "toggle-failed" });
    expect(hostEventMock.emit).toHaveBeenCalledExactlyOnceWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting", enabled: false,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("ave:plugins:enabled-changed", {
        pluginId: "com.example.meeting", enabled: false,
      });
    }
  });
});

describe("ave:plugins:config:set", () => {
  it("guards performance reads while allowing the host renderer", async () => {
    const { deps } = await setup();
    const handler = handlers.get("ave:plugins:perf-stats");
    expect(handler).toBeDefined();
    if (!handler) throw new Error("Performance handler missing");
    expect(await handler({ senderFrame: { url: "https://untrusted.example" } })).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(deps.pluginRuntime.getPerfStats).not.toHaveBeenCalled();
    expect(await invoke("ave:plugins:perf-stats")).toEqual([{ pluginId: "plugin-config", calls: 2 }]);
    expect(deps.pluginRuntime.getPerfStats).toHaveBeenCalledOnce();
  });
  it.each([
    { count: -1, name: "valid" },
    { count: 11, name: "valid" },
    { count: 1.5, name: "valid" },
    { count: 4, name: "bad!" },
    { count: 4 },
  ])("rejects schema-invalid configuration before storage and restart: %j", async (config) => {
    const { deps, setPluginConfig, restartPlugin } = await setup();
    deps.pluginRuntime.getPluginManifest.mockReturnValue({
      id: "plugin-config",
      configSchema: {
        properties: {
          count: { type: "integer", minimum: 1, maximum: 10 },
          name: { type: "string", pattern: "^[a-z]+$" },
        },
        required: ["name"],
      },
    } as never);
    expect(await invoke("ave:plugins:config:set", "plugin-config", config)).toMatchObject({ ok: false, error: "plugin-config-save-failed" });
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });

  it("validates cleartext defaults against separately stored required secrets", async () => {
    const { deps, setPluginConfig } = await setup();
    deps.pluginRuntime.getPluginManifest.mockReturnValue({
      id: "plugin-config",
      configSchema: {
        properties: {
          name: { type: "string", default: "valid" },
          token: { type: "string", format: "secret" },
        },
        required: ["name", "token"],
      },
    } as never);
    deps.settingsService.hasStoredSecret.mockResolvedValueOnce(true);
    expect(await invoke("ave:plugins:config:set", "plugin-config", { token: "must-not-persist" })).toMatchObject({ ok: true });
    expect(setPluginConfig).toHaveBeenCalledExactlyOnceWith("plugin-config", {});
    expect(deps.settingsService.hasStoredSecret).toHaveBeenCalledExactlyOnceWith("plugin.plugin-config.token");
    expect(deps.settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("refuses nonsecret config writes until every required secret is stored", async () => {
    const { deps, setPluginConfig, restartPlugin } = await setup();
    deps.pluginRuntime.getPluginManifest.mockReturnValue({
      id: "plugin-config", configSchema: {
        properties: { token: { type: "string", format: "secret" }, name: { type: "string" } }, required: ["token"],
      },
    } as never);
    expect(await invoke("ave:plugins:config:set", "plugin-config", { name: "valid", token: "cleartext-does-not-count" }))
      .toMatchObject({ ok: false, error: "plugin-config-secret-required" });
    expect(deps.settingsService.hasStoredSecret).toHaveBeenCalledExactlyOnceWith("plugin.plugin-config.token");
    expect(deps.settingsService.getSecret).not.toHaveBeenCalled();
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid declared schema", async () => {
    const { deps, setPluginConfig, restartPlugin } = await setup();
    deps.pluginRuntime.getPluginManifest.mockReturnValue({
      id: "plugin-config", configSchema: { properties: { kept: { type: "invalid-type" } } },
    } as never);
    expect(await invoke("ave:plugins:config:set", "plugin-config", { kept: "new" })).toMatchObject({ ok: false });
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();
  });

  it("deletes a secret instead of storing an empty plaintext value", async () => {
    const { deleteSecret, setSecret } = await setup();
    expect(await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", "")).toMatchObject({ ok: true });
    expect(deleteSecret).toHaveBeenCalledExactlyOnceWith("plugin.plugin-config.apiKey");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it.each([undefined, "manifest-plaintext-default"])("refuses deletion of a required secret without changing storage, including manifest default %j", async (defaultValue) => {
    const { deps, deleteSecret, setSecret, setPluginConfig } = await setup();
    deps.pluginRuntime.getPluginManifest.mockReturnValue({
      id: "plugin-config", configSchema: {
        properties: { apiKey: { type: "string", format: "secret", ...(defaultValue === undefined ? {} : { default: defaultValue }) } },
        required: ["apiKey"],
      },
    } as never);
    expect(await invoke("ave:plugins:config:secret:set", "plugin-config", "apiKey", ""))
      .toMatchObject({ ok: false, error: "plugin-config-secret-required" });
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    expect(setPluginConfig).not.toHaveBeenCalled();
  });

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
