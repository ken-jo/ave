import { createAlertMigrationPorts } from "../../../__tests__/support/alert-migration.js";
import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
/**
 * HostApi window targeting — a host→renderer send must go to the CURRENT main
 * window, not the one captured at boot.
 *
 * `showOrCreateMainWindow` (tray "Open Ave", dock `activate`, `ave://` deep
 * link) calls `createWindow()` when the previous main window is gone, which
 * registers a NEW BrowserWindow. `initPluginRuntime` runs once at boot, so the
 * `mainWindow` it captured is by then a destroyed handle: an overlay proposal
 * sent to it is a silent no-op while `triggerConversation` still answers
 * `{ accepted: true }`.
 *
 * Driven through the REAL producer (`initPluginRuntime` → captured
 * `createHostApi` → `hostApi.triggerConversation`) rather than by calling
 * `createHostApiFactory` directly, so deleting `getMainWindow` from the
 * `createHostApiFactory({...})` call site is caught here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTmpDirTracker } from "../../../__tests__/support/tmp-dir-teardown.js";

const tmpDirs = createTmpDirTracker();

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as unknown[],
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  runtime: {
    // boot installs each loaded plugin's partition policy before starting any
    // of them, so the double needs the cheap half of startAll too.
    load: vi.fn(async () => {}),
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/ave-test/plugins/${pluginId}`),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    assertPluginEventAccess: vi.fn(),
    assertPluginEventEmitAccess: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
    setConfigOverride: vi.fn(),
    mergeConfigOverride: vi.fn(),
    setWildcardConfigOverride: vi.fn(),
    getWildcardConfigOverride: vi.fn(() => ({}) as Record<string, unknown>),
    restartPlugin: vi.fn(async () => "started"),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/ave-test"),
    isPackaged: false,
    prependOnceListener: vi.fn(),
    once: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => runtimeTestState.browserWindows),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    runtimeTestState.capturedRuntimeOptions = options;
    return runtimeTestState.runtime;
  }),
}));

vi.mock("../../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../../permissions/worker-spawn.js", () => ({
  spawnWorker: vi.fn(),
}));

vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/ave-test/plugins",
    registryPath: "/tmp/ave-test/registry.json",
    cacheRoot: "/tmp/ave-test/cache",
  })),
}));

vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: runtimeTestState.readPluginRegistry,
}));

import { initPluginRuntime } from "../plugin-runtime.js";
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";
import { SuggestionLedger, suggestionLedger } from "../../../alerts/suggestion-ledger.js";
import { emitEvent } from "../../types.js";
import { AlertsService } from "../../../alerts/service.js";
import type { AlertSettings } from "../../../shared/alerts-types.js";
import type { AlertInput, AlertResult } from "../../../plugins/public-contract.js";
import { HostApiGenerationScope } from "../../../plugins/plugin-host-effect-scope.js";
import type { PluginRuntimeGenerationAccess } from "../../../plugins/plugin-host-generation.js";
import type { PluginHostApiIncarnation } from "../../../plugins/runtime/index.js";

const alertsServices: AlertsService[] = [];

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(destroyed = false): FakeWindow {
  const win: FakeWindow = {
    destroyed,
    isDestroyed: () => win.destroyed,
    webContents: { send: vi.fn() },
  };
  return win;
}

type OverlayHostApi = {
  triggerConversation: (spec: {
    source: string;
    prompt: string;
    title?: string;
    dedupeKey?: string;
  }) => Promise<{ accepted: boolean }>;
  raiseAlert: (input: AlertInput) => Promise<AlertResult>;
  withdrawAlert: (kind: string, key: string) => Promise<boolean>;
  onEvent: (type: string, handler: (data: unknown) => void) => () => void;
};

type CreateHostApi = (
  pluginId: string,
  manifest: Record<string, unknown>,
  pluginDataDir: string,
  incarnation: PluginHostApiIncarnation,
  installPluginId: string | null,
) => OverlayHostApi;

/**
 * Boot the plugin runtime exactly as `boot.ts` does and hand back the overlay
 * HostApi for one plugin. `bootWindow` is what boot captured; `getMainWindow`
 * is the live registry `showOrCreateMainWindow` re-registers into.
 */
async function overlayHostApi(input: {
  bootWindow: FakeWindow | null;
  getMainWindow?: () => FakeWindow | null;
  pluginId?: string;
  manifest?: Record<string, unknown>;
  alertsService?: AlertsService;
  incarnation?: PluginHostApiIncarnation;
  isActive?: () => boolean;
}): Promise<OverlayHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  await initPluginRuntime({
    host: createBootHostFixture({ desktop: createDesktopHostFixture({ getAppWindows: () => runtimeTestState.browserWindows as never[] }) }),
    projectRoot: "/tmp/ave-test/project",
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai" };
        if (key === "pluginConfigs") return {};
        return undefined;
      }),
      getSecret: vi.fn(() => undefined),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async () => {}),
    } as never,
    memoryManager: {} as never,
    toolRegistry: {
      unregisterByPlugin: vi.fn(),
      register: vi.fn(),
      listAll: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
    } as never,
    pythonPath: undefined,
    bootAuditLogger: { log: vi.fn() } as never,
    mainWindow: input.bootWindow as never,
    ...(input.getMainWindow ? { getMainWindow: input.getMainWindow as never } : {}),
    networkFetch: vi.fn() as unknown as typeof fetch,
    openAuthWindowService: vi.fn(),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: vi.fn(async () => {}),
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn() } as never,
    routinesStore: { list: () => [] } as never,
    // This harness has no Work Board; the proposal verbs are not exercised here.
    getWorkBoardStore: () => undefined,
    getAlertsService: () => input.alertsService,
  });
  const createHostApi = (
    runtimeTestState.capturedRuntimeOptions as { createHostApi?: CreateHostApi } | null
  )?.createHostApi;
  expect(createHostApi).toBeDefined();
  const pluginId = input.pluginId ?? "plugin-a";
  return createHostApi!(
    pluginId,
    input.manifest ?? { id: pluginId, capabilities: ["host:overlay"] },
    tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-overlay-win-"))),
    input.incarnation ?? {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: input.isActive ?? (() => true),
      isLifecycleHookActive: () => false,
    },
    null,
  );
}

beforeEach(() => {
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
});

afterEach(async () => {
  for (const alerts of alertsServices.splice(0)) await alerts.flush();
  tmpDirs.cleanup();
});

describe("hostApi.triggerConversation overlay send targets the live main window", () => {
  it("validates invalid proposals even when no desktop exists", async () => {
    const api = await overlayHostApi({ bootWindow: null, getMainWindow: () => null });
    await expect(api.triggerConversation({ source: "invalid", prompt: "Review this." }))
      .resolves.toMatchObject({ accepted: false, reason: "invalid_source" });
  });
  it("rejects without a desktop before consuming the proposal dedupe key", async () => {
    let current: FakeWindow | null = null;
    const api = await overlayHostApi({ bootWindow: null, getMainWindow: () => current });
    const spec = { source: "overlay:test", prompt: "Review this.", dedupeKey: "windowless-retry" };
    await expect(api.triggerConversation(spec)).rejects.toThrow("Host UI requires an active main window");
    current = makeWindow();
    expect((await api.triggerConversation(spec)).accepted).toBe(true);
    expect(current.webContents.send).toHaveBeenCalledOnce();
  });

  it("does not reuse the boot capture when the live registry is empty", async () => {
    const bootWindow = makeWindow();
    const api = await overlayHostApi({ bootWindow, getMainWindow: () => null });
    await expect(api.triggerConversation({ source: "overlay:test", prompt: "Review this.", dedupeKey: "no-live-window" }))
      .rejects.toThrow("Host UI requires an active main window");
    expect(bootWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("sends to the window created AFTER a close+reopen, not the boot capture", async () => {
    const bootWindow = makeWindow();
    let current: FakeWindow = bootWindow;
    const api = await overlayHostApi({
      bootWindow,
      getMainWindow: () => current,
    });

    // Close + reopen: the boot handle is destroyed and a new window registers.
    bootWindow.destroyed = true;
    const reopened = makeWindow();
    current = reopened;

    const outcome = await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "after-reopen",
    });

    expect(outcome.accepted).toBe(true);
    expect(bootWindow.webContents.send).not.toHaveBeenCalled();
    const sent = reopened.webContents.send.mock.calls.filter(
      ([channel]) => channel === OVERLAY_V1.show,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({
      source: { kind: "plugin", pluginId: "plugin-a" },
      running: false,
    });
  });

  it("still sends to the boot capture while it is the live window", async () => {
    const bootWindow = makeWindow();
    const api = await overlayHostApi({
      bootWindow,
      getMainWindow: () => bootWindow,
    });

    await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "before-reopen",
    });

    expect(
      bootWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === OVERLAY_V1.show,
      ),
    ).toHaveLength(1);
  });

  it("falls back to the boot capture when no live getter is wired", async () => {
    const bootWindow = makeWindow();
    const api = await overlayHostApi({ bootWindow });

    await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "no-getter",
    });

    expect(
      bootWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === OVERLAY_V1.show,
      ),
    ).toHaveLength(1);
  });
});

describe("hostApi.triggerConversation for a plugin that declares alerts", () => {
  const source = "overlay:fixturemail-routine";
  const manifest = {
    id: "fixturemail",
    capabilities: ["host:overlay"],
    alerts: {
      reasoning: "Tells you when a mail needs an answer.",
      kinds: [{
        id: "reply",
        label: { en: "Mail needing a reply" },
        defaultEnabled: false,
        visibility: "user-visible",
        slots: { subject: { kind: "text", maxLength: 80 } },
        summary: { en: "Reply to {subject}" },
        prompt: { en: "Help me answer {subject}." },
      }],
      suggestions: [source],
    },
  };
  let previousHome: string | undefined;

  beforeEach(() => {
    // The ledger lives in ~/.ave/alerts; this suite must never reach the real one.
    previousHome = process.env.AVE_HOME;
    process.env.AVE_HOME = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-alerts-home-")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousHome;
  });

  it("stages before a window closes while acceptance persistence is pending", async () => {
    const window = makeWindow();
    const pluginId = "flushrace";
    const api = await overlayHostApi({ bootWindow: window, getMainWindow: () => window, pluginId, manifest });
    const flush = suggestionLedger.flush.bind(suggestionLedger);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(suggestionLedger, "flush").mockImplementation(async () => {
      window.destroyed = true;
      await pending;
      await flush();
    });
    const result = api.triggerConversation({ source, prompt: "Review this." });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    const sentBeforeFlush = window.webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_V1.show);
    release();
    await expect(result).resolves.toMatchObject({ accepted: true });
    expect(sentBeforeFlush).toHaveLength(1);
    const reloaded = new SuggestionLedger(() => join(process.env.AVE_HOME!, "alerts"));
    await reloaded.load();
    expect(reloaded.isLimited(pluginId, source, Date.now())).toBe(true);
  });

  it("keeps an undelivered suggestion retryable in memory and on disk", async () => {
    const window = makeWindow();
    const pluginId = "sendrace";
    const api = await overlayHostApi({ bootWindow: window, getMainWindow: () => window, pluginId, manifest });
    window.webContents.send.mockImplementationOnce(() => {
      window.destroyed = true;
      throw new Error("Window closed during delivery");
    });
    const spec = { source, prompt: "Review this.", dedupeKey: "failed-delivery" };
    await expect(api.triggerConversation(spec)).rejects.toThrow("Window closed during delivery");
    await suggestionLedger.flush();
    expect(suggestionLedger.isLimited(pluginId, source, Date.now())).toBe(false);
    const reloaded = new SuggestionLedger(() => join(process.env.AVE_HOME!, "alerts"));
    await reloaded.load();
    expect(reloaded.isLimited(pluginId, source, Date.now())).toBe(false);
    window.destroyed = false;
    await expect(api.triggerConversation(spec)).resolves.toMatchObject({ accepted: true });
    expect(window.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("stages a declared source once, persists the acceptance, and refuses undeclared ones", async () => {
    const window = makeWindow();
    const api = await overlayHostApi({
      bootWindow: window,
      getMainWindow: () => window,
      pluginId: "fixturemail",
      manifest,
    });

    await expect(api.triggerConversation({ source: "overlay:fixturemail-other", prompt: "Review this." }))
      .resolves.toMatchObject({ accepted: false, reason: "source_not_declared" });
    await expect(api.triggerConversation({ source, prompt: "Set up a morning briefing?" }))
      .resolves.toMatchObject({ accepted: true, source });
    await expect(api.triggerConversation({ source, prompt: "Set up a morning briefing?" }))
      .resolves.toMatchObject({ accepted: false, reason: "suggestion_limit" });

    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_V1.show)).toHaveLength(1);
    const ledger = JSON.parse(
      readFileSync(join(process.env.AVE_HOME!, "alerts", "suggestions.json"), "utf8"),
    ) as { accepted: Record<string, Record<string, number>> };
    expect(Object.keys(ledger.accepted.fixturemail ?? {})).toEqual([source]);
  });
});

/**
 * The HostApi door to the alert pipeline: each start registers the plugin's
 * kinds, a raise and a withdrawal are scoped to the calling plugin, and the
 * host's `alert.*` events reach a subscriber only for its own alerts.
 */
describe("hostApi.raiseAlert, withdrawAlert and alert events", () => {
  const kinds = [{
    id: "reply",
    label: { en: "Mail needing a reply" },
    defaultEnabled: true,
    visibility: "silent",
    summary: { en: "A mail" },
    prompt: { en: "Help me answer." },
  }];
  const manifestOf = (id: string) => ({ id, alerts: { reasoning: "Tells you about mail.", kinds } });

  async function service(): Promise<AlertsService> {
    let settings: AlertSettings = { osNotificationsEnabled: true, kinds: {} };
    const dir = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-alerts-hostapi-")));
    const alerts = new AlertsService({
    migration: createAlertMigrationPorts(),
      dir: () => dir,
      settings: { get: () => settings, set: async (next) => { settings = next; } },
      installedPluginIds: async () => [],
      appVersion: "0.0.0",
      locale: () => "en",
      predecessorBlocks: async () => false,
      overlay: { show: vi.fn(), dismiss: vi.fn() },
      notifications: { isFocusGateActive: () => false, fire: vi.fn() },
      emit: emitEvent,
      audit: vi.fn(),
    });
    await alerts.load();
    alertsServices.push(alerts);
    return alerts;
  }

  it("registers the plugin's kinds at start and scopes raise and withdraw to the caller", async () => {
    const alerts = await service();
    const mail = await overlayHostApi({ bootWindow: null, pluginId: "fixturemail", manifest: manifestOf("fixturemail"), alertsService: alerts });
    const other = await overlayHostApi({ bootWindow: null, pluginId: "otherfixture", manifest: manifestOf("otherfixture"), alertsService: alerts });

    await expect(mail.raiseAlert({ kind: "reply", key: "mail-1" })).resolves.toMatchObject({ status: "raised" });
    await expect(other.withdrawAlert("reply", "mail-1")).resolves.toBe(false);
    await expect(mail.withdrawAlert("reply", "mail-1")).resolves.toBe(true);
    await alerts.flush();
  });

  it.each([false, true])("keeps incumbent grants when an inactive candidate is discarded (generation scope: %s)", async (scoped) => {
    const alerts = await service();
    const incumbent = await overlayHostApi({ bootWindow: null, pluginId: "fixturemail", manifest: manifestOf("fixturemail"), alertsService: alerts });
    expect((await incumbent.raiseAlert({ kind: "reply", key: "mail-1" })).status).toBe("raised");
    const disposers: Array<() => void> = [];
    const scope = new HostApiGenerationScope("fixturemail");
    await overlayHostApi({
      bootWindow: null,
      pluginId: "fixturemail",
      manifest: { id: "fixturemail", alerts: { reasoning: "Replacement mail.", kinds: [{ ...kinds[0], id: "replacement" }] } },
      alertsService: alerts,
      incarnation: {
        registerDisposer: (dispose) => { disposers.push(dispose); },
        trackOperation: (operation) => operation,
        isActive: () => scoped,
        isLifecycleHookActive: () => false,
        ...(scoped ? { generationScope: scope } : {}),
      },
    });
    expect((await incumbent.raiseAlert({ kind: "reply", key: "mail-1" })).status).toBe("refreshed");
    expect(await incumbent.raiseAlert({ kind: "replacement", key: "new" })).toEqual({ status: "kind_not_granted", kind: "replacement" });
    scope.discard();
    for (const dispose of disposers) dispose();
    expect((await incumbent.raiseAlert({ kind: "reply", key: "mail-1" })).status).toBe("refreshed");
    await alerts.flush();
  });

  it("publishes candidate grants, restores the incumbent on resume, and isolates retired cleanup", async () => {
    const alerts = await service();
    const access = {} as PluginRuntimeGenerationAccess;
    const incumbentScope = new HostApiGenerationScope("fixturemail");
    const candidateScope = new HostApiGenerationScope("fixturemail");
    const incarnation = (scope: HostApiGenerationScope): PluginHostApiIncarnation => ({
      registerDisposer: (dispose) => scope.registerDisposer(dispose),
      trackOperation: (operation) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
      generationScope: scope,
    });
    const incumbent = await overlayHostApi({ bootWindow: null, pluginId: "fixturemail", manifest: manifestOf("fixturemail"), alertsService: alerts, incarnation: incarnation(incumbentScope) });
    incumbentScope.bindGeneration(access, "incumbent");
    incumbentScope.publish();
    expect((await incumbent.raiseAlert({ kind: "reply", key: "mail-1" })).status).toBe("raised");
    const candidate = await overlayHostApi({
      bootWindow: null, pluginId: "fixturemail", alertsService: alerts, incarnation: incarnation(candidateScope),
      manifest: { id: "fixturemail", alerts: { reasoning: "Replacement mail.", kinds: [{ ...kinds[0], id: "replacement" }] } },
    });
    candidateScope.bindGeneration(access, "candidate");
    incumbentScope.supersede();
    await expect(alerts.raise("fixturemail", { kind: "reply", key: "mail-1" })).rejects.toThrow(/before its kinds were registered/);
    candidateScope.publish();
    expect(await candidate.raiseAlert({ kind: "reply", key: "mail-1" })).toEqual({ status: "kind_not_granted", kind: "reply" });
    // A new update kind is declared but still needs the user's opt-in.
    expect(await candidate.raiseAlert({ kind: "replacement", key: "new" })).toEqual({ status: "disabled_by_user" });
    candidateScope.supersede();
    incumbentScope.resume();
    expect((await incumbent.raiseAlert({ kind: "reply", key: "mail-1" })).status).toBe("refreshed");
    incumbentScope.supersede();
    candidateScope.resume();
    incumbentScope.retire();
    expect(await candidate.raiseAlert({ kind: "replacement", key: "new" })).toEqual({ status: "disabled_by_user" });
    candidateScope.retire();
    await expect(alerts.raise("fixturemail", { kind: "replacement", key: "new" })).rejects.toThrow(/before its kinds were registered/);
    await alerts.flush();
  });

  it("fails loudly when the host built no alerts service", async () => {
    const api = await overlayHostApi({ bootWindow: null, pluginId: "fixturemail", manifest: manifestOf("fixturemail") });
    await expect(api.raiseAlert({ kind: "reply", key: "mail-1" })).rejects.toThrow(/alerts service is not constructed/);
  });

  it("delivers an alert event to its own plugin, and another's only with a grant", async () => {
    const api = await overlayHostApi({ bootWindow: null, pluginId: "fixturemail" });
    const heard: unknown[] = [];
    const unsubscribe = api.onEvent("alert.raised", (data) => { heard.push(data); });
    emitEvent("alert.raised", { pluginId: "otherfixture", kind: "reply", alertId: "x" });
    emitEvent("alert.raised", { pluginId: "@host", kind: "due-soon", alertId: "y" });
    emitEvent("alert.raised", { pluginId: "fixturemail", kind: "reply", alertId: "z" });
    expect(heard).toEqual([{ pluginId: "fixturemail", kind: "reply", alertId: "z" }]);

    runtimeTestState.runtime.getApprovedPluginAccess.mockReturnValue({
      plugins: [{ pluginId: "otherfixture", events: ["alert.raised"] }],
    } as never);
    emitEvent("alert.raised", { pluginId: "otherfixture", kind: "reply", alertId: "w" });
    expect(heard).toHaveLength(2);
    runtimeTestState.runtime.getApprovedPluginAccess.mockReturnValue(undefined);
    unsubscribe();
  });
});

it("binds migration readiness to the exact HostApi incarnation", async () => {
  let active = false;
  const prepareRegistration = vi.fn(() => ({ publish: vi.fn(async () => {}), unpublish: vi.fn() }));
  await overlayHostApi({ bootWindow: null, isActive: () => active, alertsService: { prepareRegistration } as unknown as AlertsService });
  const readiness = (prepareRegistration.mock.calls as unknown as Array<[string, unknown, () => boolean]>)[0]![2];
  expect(readiness()).toBe(false);
  active = true;
  expect(readiness()).toBe(true);
});
