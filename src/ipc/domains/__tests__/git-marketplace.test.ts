import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { MARKETPLACE_ERROR_DETAIL_FIELDS, MarketplaceError } from "../../../marketplace/errors.js";
import { NetworkGate } from "../../../marketplace/net/network-gate.js";
import { normalizeSourceUrl } from "../../../marketplace/net/source-url.js";
import { createPinnedFetch } from "../../../marketplace/net/pinned-fetch.js";
import { FilePolicySource } from "../../../marketplace/sources/policy.js";
import { parseGitMarketplaceResult, type EnteredTargetWarningView } from "../../../shared/git-marketplace.js";
import { scrubDiagnosticSecrets } from "../../../shared/dlp.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../../shared/__tests__/fixtures/diagnostic-secret-probes.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestBootstrapStatus } from "../../../boot/bootstrap-status.js";
import { revocationRegistry, type RevocationRule } from "../../../plugins/revocation/revocation-registry.js";
import { FakeVolume, nodeFolders, TEST_FOLDER_LIMITS, writeFolderFiles } from "../../../marketplace/__tests__/fixtures/folder-fs.js";
import { folderService } from "../../../marketplace/__tests__/fixtures/folder-service.js";
import { policyLoad, policySource } from "../../../marketplace/__tests__/fixtures/policy.js";
import { translate } from "../../../i18n/translate.js";
import { ENTRY_SUBJECT, failureText, warningText } from "../../../ui/renderer/tabs/git-marketplace/labels.js";

vi.mock("../../../lib/admin-policy-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-policy-file.js")>()),
  readAdminPolicyFile: (path: string) => import("node:fs/promises").then(({ readFile }) => readFile(path)),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const resumeListeners = new Set<() => void>();

const desktop = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async (..._args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] })),
  showItemInFolder: vi.fn((_path: string) => undefined),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: desktop.showOpenDialog },
  shell: { showItemInFolder: desktop.showItemInFolder },
  session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
  powerMonitor: {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "resume") resumeListeners.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resume") resumeListeners.delete(listener);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const shutdownHooks = new Map<string, () => void>();
vi.mock("../plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins.js")>()),
  pluginLifecycleServices: () => ({ ensureInstallStateReady: async () => {}, uninstall: async () => {}, retirement: {} }),
}));
vi.mock("../../../main/app-shutdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../main/app-shutdown.js")>()),
  registerShutdownHook: vi.fn((name: string, stop: () => void) => {
    shutdownHooks.set(name, stop);
  }),
}));

// Hold only completed apply-check saves so the test can observe an in-flight check.
const historySave = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock("../../../marketplace/updates/history.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../marketplace/updates/history.js")>();
  return {
    ...original,
    updateHistoryStore: (path: string) => {
      const store = original.updateHistoryStore(path);
      return {
        ...store,
        save: async (history: Parameters<typeof store.save>[0]) => {
          if (history.applyCheckAt !== null && historySave.held) await historySave.held;
          await store.save(history);
        },
      };
    },
  };
});

function holdApplyCheckSaves(): () => void {
  let release!: () => void;
  historySave.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    historySave.held = null;
    release();
  };
}

const channels = CHANNELS.gitMarketplace;

async function setup(overrides: Record<string, unknown> = {}, window: unknown = null) {
  handlers.clear();
  const service = {
    listSources: vi.fn(async () => []),
    previewSource: vi.fn(async (request: unknown) => ({ kind: "marketplace", request })),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    setEnabled: vi.fn(),
    refresh: vi.fn(async () => []),
    repairSource: vi.fn(async () => []),
    acceptRewrite: vi.fn(),
    acknowledgeSource: vi.fn(async (id: string, warnings: unknown) => ({ id, acknowledged: warnings })),
    setToken: vi.fn(async (host: string) => ({ host })),
    deleteToken: vi.fn(),
    catalog: vi.fn(async (query: unknown) => ({ entries: [], query })),
    detail: vi.fn(),
    planInstall: vi.fn(async (request: unknown) => ({ planId: "p1", request })),
    planUpdate: vi.fn(),
    executeInstall: vi.fn(async () => {
      throw new MarketplaceError("PLAN_EXPIRED", "the install plan is no longer valid; start again");
    }),
    uninstall: vi.fn(async (request: unknown) => ({ key: request, keptDataDir: null })),
    previewDirectMcp: vi.fn(),
    updates: vi.fn(async () => []),
    discover: vi.fn(async () => ({ result: "ok", reached: ["ave"] })),
    enforceRevocations: vi.fn(async () => {}),
    takeRevocationNotice: vi.fn(() => null),
    revealFolder: vi.fn(async (): Promise<string | null> => null),
    updateCandidates: vi.fn(async () => []),
    autoUpdateContext: vi.fn(async () => ({ policy: "user", requiredInstalls: [], unmetRequired: [], sources: [], installed: [] })),
    applyUpdate: vi.fn(async () => ({ state: "applied" })),
    appliedState: vi.fn(async () => null),
    callsInFlight: vi.fn(async () => false),
    approveComponents: vi.fn(async () => {}),
    applyBootInstalls: vi.fn(async () => ({
      report: { installed: [{ kind: "plugin", name: "meeting", source: "ave" }], skipped: [], failed: [] },
      notice: { forYou: [{ sourceId: "ave", kind: "plugin", name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] },
    })),
    ...overrides,
  };
  const create = vi.fn(async () => ({ service: service as never, close: async () => {} }));
  const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
  const onBuilt = vi.fn(async () => {});
  const home = mkdtempSync(join(tmpdir(), "ave-git-marketplace-ipc-"));
  setupHomes.push(home);
  const marketplace: Record<string, unknown> = { updateCheckIntervalMs: 0 };
  const settings = {
    get: () => marketplace,
    patch: vi.fn(async (partial: { marketplace?: Record<string, unknown> }) => {
      Object.assign(marketplace, partial.marketplace ?? {});
    }),
  };
  const activity = { isBusy: vi.fn(() => false), onIdle: vi.fn(() => () => {}) };
  // Use a private lifetime; the app's shared lifetime would outlive test shutdown.
  const lifetime = new AbortController();
  const registration = registerGitMarketplaceHandlers(
    { auditLogger: { log: vi.fn() }, getMainWindow: () => window, settingsService: settings, conversationSurfaceRuntime: { activity } } as never,
    async () => null,
    create,
    onBuilt,
    home,
    lifetime,
  );
  return { service, create, onBuilt, registration, home, marketplace, lifetime, settings, activity };
}

const setupHomes: string[] = [];

beforeEach(() => {
  handlers.clear();
  resumeListeners.clear();
});

afterEach(() => {
  for (const home of setupHomes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe("git marketplace IPC boundary", () => {
  it("removes the kept artifacts when keeping is turned off, and only then", async () => {
    // Clear the environment override to isolate the setting.
    const saved = process.env.AVE_MARKETPLACE_USE_CACHE;
    delete process.env.AVE_MARKETPLACE_USE_CACHE;
    try {
      const { registration, home, marketplace } = await setup();
      const kept = join(home, "packages", "artifacts");
      mkdirSync(kept, { recursive: true });
      writeFileSync(join(kept, `${"a".repeat(64)}.zip`), "zip");

      registration.settingsChanged();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(kept)).toBe(true);

      marketplace.offlineCacheEnabled = false;
      registration.settingsChanged();
      await vi.waitFor(() => expect(existsSync(kept)).toBe(false));
    } finally {
      if (saved === undefined) delete process.env.AVE_MARKETPLACE_USE_CACHE;
      else process.env.AVE_MARKETPLACE_USE_CACHE = saved;
    }
  });

  it("registers every request channel, keeps them internal, and builds the service once", async () => {
    const { create, onBuilt } = await setup();
    const requests = Object.entries(channels).filter(([, channel]) => channel.startsWith("ave:")).map(([, channel]) => channel);
    expect(requests.every((channel) => handlers.has(channel))).toBe(true);
    expect(requests.some((channel) => isPublicChannel(channel))).toBe(false);
    expect(create).not.toHaveBeenCalled();
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    await invokeFileIpcHandler(handlers, channels.catalogList, {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(onBuilt).toHaveBeenCalledTimes(1);
  });

  it("hands a held deep link to the tab once, and holds the boot-install notice until dismissed, building no marketplace", async () => {
    const { create } = await setup();
    const state = await import("../../../main/app-state.js");
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: null });
    state.setPendingGitMarketplaceLink({ action: "install", key: { sourceId: "ave", kind: "plugin", name: "calendar" } });
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({
      ok: true,
      value: { action: "install", key: { sourceId: "ave", kind: "plugin", name: "calendar" } },
    });
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: null });

    const notice = { forYou: [{ sourceId: "ave", kind: "plugin" as const, name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] };
    state.setBootInstallNotice(notice);
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: notice });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: notice });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsDismiss)).resolves.toEqual({ ok: true, value: null });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: null });
    state.setBootInstallNotice({ forYou: [], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: null });

    state.setPendingGitMarketplaceLink({ action: "add", url: "acme/tools" });
    await expect(invokeAppIpcHandlerFromFrame(handlers, channels.deepLinkTake, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: { action: "add", url: "acme/tools" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("runs the boot pass once started, publishes its notice and status, and runs it again on Retry", async () => {
    const { registration, service } = await setup();
    const state = await import("../../../main/app-state.js");
    state.setBootInstallNotice(null);
    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({
      ok: false,
      error: "the marketplace boot pass has not started",
    });
    expect(service.discover).not.toHaveBeenCalled();

    await registration.startBackground();
    expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: ["meeting"], failed: [] });
    expect(service.discover).toHaveBeenCalledTimes(1);
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    expect(state.getBootInstallNotice()).toEqual({ forYou: [{ sourceId: "ave", kind: "plugin", name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [], autoUpdated: [] });
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(2));

    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({ ok: true });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
    await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.bootstrap.retry, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
  });

  it("joins the boot pass in flight on Retry, and the boot's apply check in flight on Check now", async () => {
    const { registration, service } = await setup();
    const release = holdApplyCheckSaves();
    try {
      const started = registration.startBackground();
      await vi.waitFor(async () => {
        const status = await invokeFileIpcHandler(handlers, channels.updatesStatus) as { ok: true; value: { running: boolean; applyCheckAt: string | null } };
        expect(status.value).toMatchObject({ running: true, applyCheckAt: expect.any(String) });
      });
      const retried = invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry);
      const checked = invokeFileIpcHandler(handlers, channels.updatesCheck);
      release();
      await expect(retried).resolves.toEqual({ ok: true });
      await expect(checked).resolves.toMatchObject({ ok: true, value: { running: false } });
      await started;
    } finally {
      release();
    }
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    expect(service.discover).toHaveBeenCalledTimes(1);
  });

  it("rechecks the updates when marketplace settings are written, once the boot pass runs", async () => {
    const { registration, service } = await setup();
    registration.settingsChanged();
    expect(service.updates).not.toHaveBeenCalled();

    await registration.startBackground();
    expect(service.updates).toHaveBeenCalledTimes(2);
    registration.settingsChanged();
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(3));
    expect(service.discover).toHaveBeenCalledTimes(1);
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it("answers the update scheduler's status and Check now from the host renderer only, once the scheduler runs", async () => {
    const update = { key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "1.1.0" };
    const { registration, service, home, marketplace } = await setup({
      updates: vi.fn(async () => [update]),
      updateCandidates: vi.fn(async () => [{
        ...update,
        commitRange: { from: null, to: "b".repeat(40) },
        switchSource: false,
        provides: [],
        needs: [],
        facts: {
          switchKey: "meeting", to: "1.1.0", change: "upgrade", enabled: true, required: false, policyBlocked: false,
          source: { id: "ave", origin: "official", http: false, acknowledgedUnencryptedUpdates: false, shown: true, pendingRewrite: false },
          consent: [], unconfirmedApprovals: [],
        },
      }]),
    });
    marketplace.autoUpdate = false;
    await expect(invokeFileIpcHandler(handlers, channels.updatesStatus)).resolves.toEqual({ ok: false, code: "unavailable", message: "update checks have not started" });

    await registration.startBackground();
    const status = await invokeFileIpcHandler(handlers, channels.updatesStatus) as { ok: true; value: { applyCheckAt: string | null; running: boolean } };
    expect(status).toMatchObject({ ok: true, value: { running: false } });
    expect(status.value.applyCheckAt).not.toBeNull();
    const checked = await invokeFileIpcHandler(handlers, channels.updatesCheck) as { ok: true; value: { running: boolean; discovery: { result: string }; packages: unknown[] } };
    expect(checked).toMatchObject({ ok: true, value: { running: false, discovery: { result: "ok" }, packages: [{ key: { name: "meeting" }, state: "manual" }] } });
    expect(service.discover).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(home, "marketplaces", "updates.json"), "utf8"))).toMatchObject({ version: 1, discovery: { result: "ok" } });

    for (const channel of [channels.updatesStatus, channels.updatesCheck]) {
      await expect(invokeAppIpcHandlerFromFrame(handlers, channel, "file:///app/plugin-ui-shell.html"))
        .resolves.toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    }
    expect(service.discover).toHaveBeenCalledTimes(2);

    expect(resumeListeners.size).toBe(1);
    resumeListeners.forEach((listener) => listener());
    expect(service.discover).toHaveBeenCalledTimes(2);
  });

  it("answers every scheduler request with its declared refusal once the app has stopped the scheduler", async () => {
    shutdownHooks.clear();
    const { registration, service } = await setup();
    // Bootstrap status is process-wide; use this scheduler's own boot pass.
    await registration.startBackground();
    expect(latestBootstrapStatus()).toMatchObject({ phase: "complete" });
    await vi.waitFor(() => expect(shutdownHooks.has("git-marketplace-events")).toBe(true));
    shutdownHooks.get("git-marketplace-events")!();
    const discoveries = service.discover.mock.calls.length;

    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({ ok: false, error: "the update scheduler has stopped" });
    await expect(invokeFileIpcHandler(handlers, channels.updatesCheck)).resolves.toEqual({ ok: false, code: "unavailable", message: "the update scheduler has stopped" });
    await expect(invokeFileIpcHandler(handlers, channels.updatesStatus)).resolves.toMatchObject({ ok: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      registration.settingsChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(service.discover.mock.calls.length).toBe(discoveries);
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    await registration.startBackground();
    expect(service.discover.mock.calls.length).toBe(discoveries);
  });

  it("approves an approval-pending agent plugin's components bound to its install, and clears its state (§18.7.5)", async () => {
    const key = { sourceId: "ave", kind: "agent-plugin", name: "notes" };
    const consents = [{ name: "search", digest: "a".repeat(64), approvalDigest: "b".repeat(64) }, { kind: "hook", index: 0, digest: "c".repeat(64), approvalDigest: null }];
    const approveComponents = vi.fn(async () => {});
    const { registration, service } = await setup({ approveComponents });
    await expect(invokeFileIpcHandler(handlers, channels.componentsApprove, key, "install-1", consents)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await registration.startBackground();
    expect(service.updates).toHaveBeenCalledTimes(2);

    const answer = await invokeFileIpcHandler(handlers, channels.componentsApprove, key, "install-1", consents);
    expect(answer).toMatchObject({ ok: true, value: { packages: [] } });
    expect(approveComponents).toHaveBeenCalledWith(key, "install-1", consents);

    approveComponents.mockRejectedValueOnce(new MarketplaceError("PLAN_EXPIRED", "agent plugin notes changed since it was reviewed", { detail: { reason: "package-changed" } }));
    await expect(invokeFileIpcHandler(handlers, channels.componentsApprove, key, "install-0", consents)).resolves.toEqual({
      ok: false, code: "PLAN_EXPIRED", message: "agent plugin notes changed since it was reviewed", detail: { reason: "package-changed" },
    });

    for (const bad of [[consents[0], consents[0]], [{ kind: "extension", component: "hook", localId: "x", approvalDigest: null }], [{ name: "search", digest: "a".repeat(64) }], []]) {
      await expect(invokeFileIpcHandler(handlers, channels.componentsApprove, key, "install-1", bad)).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    }
    expect(approveComponents).toHaveBeenCalledTimes(2);
  });

  it("applies queued updates now on Apply now, from the host renderer only (§18.7.4)", async () => {
    const { registration, service } = await setup();
    await registration.startBackground();
    expect(service.updates).toHaveBeenCalledTimes(2);
    await expect(invokeFileIpcHandler(handlers, channels.updatesApplyNow)).resolves.toMatchObject({ ok: true, value: { waitingSince: null, escalated: false } });
    for (const channel of [channels.updatesApplyNow, channels.componentsApprove]) {
      await expect(invokeAppIpcHandlerFromFrame(handlers, channel, "file:///app/plugin-ui-shell.html"))
        .resolves.toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    }
  });

  it("records the version a rollback by hand left as skipped, so the next apply check does not undo it (§18.7.5)", async () => {
    const result = (action: unknown) => ({ key: { sourceId: "ave", kind: "plugin", name: "meeting" }, version: "1.0.0", action, rungs: [], connectionWarning: null });
    const executeInstall = vi.fn(async () => result({ action: "replace", direction: "downgrade", from: "1.2.0" }));
    const { settings, marketplace } = await setup({ executeInstall });
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1")).resolves.toMatchObject({ ok: true });
    expect(settings.patch).toHaveBeenCalledTimes(1);
    expect({ ...(marketplace.skippedPluginUpdates as object) }).toEqual({ meeting: "1.2.0" });

    executeInstall.mockResolvedValueOnce(result({ action: "replace", direction: "upgrade", from: "1.0.0" }));
    await invokeFileIpcHandler(handlers, channels.installExecute, "p2");
    expect(settings.patch).toHaveBeenCalledTimes(1);
  });

  it("accepts an extension's component consent by local id with its approval digest (§18.7.3)", async () => {
    const installed = { key: { sourceId: "ave", kind: "plugin", name: "meeting" }, version: "1.1.0", action: { action: "install" }, rungs: [], connectionWarning: null };
    const executeInstall = vi.fn(async () => installed);
    await setup({ executeInstall });
    const consents = [{ kind: "extension", component: "mcpServer", localId: "notes", approvalDigest: "d".repeat(64) }, { kind: "extension", component: "hook", localId: "audit", approvalDigest: null }];
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", consents)).resolves.toMatchObject({ ok: true });
    expect(executeInstall).toHaveBeenLastCalledWith("p1", consents, true);
    for (const bad of [
      [{ kind: "extension", component: "process", localId: "x", approvalDigest: null }],
      [{ kind: "extension", component: "hook", localId: "x", approvalDigest: "not-a-digest" }],
      [{ kind: "extension", component: "hook", localId: "x", approvalDigest: null, extra: 1 }],
    ]) {
      await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", bad)).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  it("lets a plugin install that lands after the shutdown hook finish, without telling the host or refreshing the bridge", async () => {
    shutdownHooks.clear();
    const { lifetime } = await setup();
    const { onEvent } = await import("../../../boot/types.js");
    const { pluginInstaller } = await import("../git-marketplace.js");
    const { whileRunning } = await import("../../../marketplace/app/background.js");
    const announced = vi.fn();
    const off = onEvent("plugin.installed", announced);
    let land: () => void = () => {};
    const installGitPlugin = vi.fn(
      () =>
        new Promise<{ pluginId: string; action: "install"; staged: false }>((resolve) => {
          land = () => resolve({ pluginId: "calendar", action: "install", staged: false });
        }),
    );
    const deps = {
      pluginMarketplace: { installGitPlugin },
      pluginRuntime: {
        resolvePluginId: (id: string) => id,
        resolvePluginInstallIdIfKnown: () => "calendar@1",
        cancelPendingRestart: vi.fn(),
        listPluginIds: () => ["calendar"],
        activatePreparedArtifact: vi.fn(),
      },
      refreshPluginEventBridge: vi.fn(),
    };
    const port = pluginInstaller(deps as never, whileRunning(lifetime.signal));
    const plan = { name: "calendar" } as never;
    try {
      const first = port.install(plan, { stage: false, switchSource: false } as never);
      await vi.waitFor(() => expect(installGitPlugin).toHaveBeenCalledTimes(1));
      land();
      await expect(first).resolves.toEqual({ action: "install", staged: false });
      expect(announced).toHaveBeenCalledTimes(1);
      expect(deps.refreshPluginEventBridge).toHaveBeenCalledTimes(1);

      const second = port.install(plan, { stage: false, switchSource: false } as never);
      await vi.waitFor(() => expect(installGitPlugin).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(shutdownHooks.has("git-marketplace-events")).toBe(true));
      shutdownHooks.get("git-marketplace-events")!();
      land();
      await expect(second).resolves.toEqual({ action: "install", staged: false });
      expect(announced).toHaveBeenCalledTimes(1);
      expect(deps.refreshPluginEventBridge).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("reports the boot pass skipped in an isolated E2E run, and never builds the marketplace", async () => {
    const { registration, create } = await setup();
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    let started: Promise<void>;
    try {
      started = registration.startBackground();
    } finally {
      vi.unstubAllEnvs();
    }
    await started;
    expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: [], failed: [], skipped: { reason: "e2e-isolated" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses plugin frames without building the service", async () => {
    const { create, service } = await setup();
    const answer = await invokeAppIpcHandlerFromFrame(handlers, channels.installExecute, "file:///app/plugin-ui-shell.html", "p1");
    expect(answer).toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    expect(parseGitMarketplaceResult(answer)).toMatchObject({ ok: false, code: "unauthorized-frame" });
    expect(create).not.toHaveBeenCalled();
    expect(service.executeInstall).not.toHaveBeenCalled();
  });

  it("passes reviewed authority and validated MCP consent through one install request", async () => {
    const installed = { key: { sourceId: "ave", kind: "agent-plugin", name: "notes" }, version: "1.0.0", action: { action: "install" }, rungs: [], connectionWarning: null };
    const executeInstall = vi.fn(async () => installed);
    await setup({ executeInstall });
    const consents = [{ name: "notes", digest: "a".repeat(64) }];
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", consents))
      .resolves.toEqual({ ok: true, value: installed });
    expect(executeInstall).toHaveBeenLastCalledWith("p1", consents, true);
    await invokeFileIpcHandler(handlers, channels.installExecute, "p2");
    expect(executeInstall).toHaveBeenLastCalledWith("p2", [], true);
  });

  it("answers a marketplace failure with its code, and an unexpected one as unavailable", async () => {
    await setup({ listSources: vi.fn(async () => { throw new Error("disk gone"); }) });
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1")).resolves.toEqual({
      ok: false,
      code: "PLAN_EXPIRED",
      message: "the install plan is no longer valid; start again",
    });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: false, code: "unavailable", message: "disk gone" });
  });

  it("carries a failure's detail in its envelope, and the renderer's parse keeps it", async () => {
    const detail = { reason: "dns", host: "nowhere.invalid" } as const;
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", "git fetch failed: Could not resolve host", { detail }); }) });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toEqual({ ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed: Could not resolve host", detail });
    expect(parseGitMarketplaceResult(answer)).toEqual(answer);
  });

  describe("source refusals the renderer turns into advice (§18.4, §18.8)", () => {
    const sentences = (answer: unknown) => {
      const parsed = parseGitMarketplaceResult(answer);
      if (parsed.ok) throw new Error("expected a failure");
      return {
        en: failureText((key, vars) => translate("en", key, vars), parsed, ENTRY_SUBJECT),
        ko: failureText((key, vars) => translate("ko", key, vars), parsed, ENTRY_SUBJECT),
      };
    };

    it("answers a drive whose classifier cannot run with classifier-unavailable, rendered as reinstall advice", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
      const volume = new FakeVolume("win32").file("C:\\m\\SKILL.md", "---\nname: note\ndescription: d\n---\n");
      volume.queryDosDevice = async () => {
        throw new Error("Windows folder classifier is missing: C:\\Ave\\resources\\windows-path-kind\\x64\\ave-path-kind.exe. Reinstall Ave.");
      };
      const harness = await folderService({ root, folders: { fs: volume, platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
      try {
        await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "C:\\m", auth: "none" });
        expect(answer).toMatchObject({ ok: false, code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "C:\\m" } });
        expect((answer as { message: string }).message).toContain("classifier is missing");
        expect(sentences(answer)).toEqual({
          en: "Ave cannot tell whether C:\\m is on another computer because its folder classifier is missing or broken. Reinstall Ave.",
          ko: "Ave의 폴더 분류 도구가 없거나 손상되어 C:\\m이(가) 다른 컴퓨터에 있는지 알 수 없습니다. Ave를 다시 설치하세요.",
        });
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("answers a folder overlapping a source with the relation and the source, rendered as what to do instead of another id", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
      const skill = "---\nname: note\ndescription: d\n---\n";
      const volume = new FakeVolume("linux").file("/m/SKILL.md", skill).file("/m/inner/SKILL.md", skill);
      const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
      try {
        const outer = await harness.service.previewSource({ input: "/m", auth: "none" });
        if (outer.type === "confirm") throw new Error("unexpected confirmation");
        await harness.service.addSource({ previewId: outer.previewId, id: "team" });
        await setup({
          previewSource: vi.fn((request: never) => harness.service.previewSource(request)),
          addSource: vi.fn((request: never) => harness.service.addSource(request)),
        });
        const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m/inner", auth: "none" })) as { ok: true; value: { previewId: string } };
        const inside = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: "inner" });
        expect(inside).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "folder-inside-source", path: "/m/inner", existingId: "team", existingPath: "/m" } });
        expect(sentences(inside)).toEqual({
          en: "Folder sources cannot overlap: /m/inner lies inside /m, which is already added as team. Use team, or remove it and add the folder you want.",
          ko: "폴더 소스는 서로 겹칠 수 없습니다. /m/inner은(는) 이미 team(으)로 추가된 /m 안에 있습니다. team을(를) 쓰거나, 지운 뒤 원하는 폴더를 추가하세요.",
        });
        const again = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
        const same = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: again.value.previewId, id: "again" });
        expect(same).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "folder-already-added", path: "/m", existingId: "team" } });
        expect(sentences(same).en).toBe("/m is already added as team. Use team, or remove it before adding this folder again.");
        expect(sentences(same).ko).toBe("/m은(는) 이미 team(으)로 추가되어 있습니다. team을(를) 쓰거나, 지운 뒤 이 폴더를 다시 추가하세요.");
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    describe("a token in any string main hands the renderer (§18.8)", () => {
      // Assemble credential-shaped fixtures at runtime so no complete token appears in source.
      const TOKENS = [`gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`, `sk${"-proj-"}${"Z9y8X7w6".repeat(8)}`];
      const leaks = (text: string) => TOKENS.some((token) => text.toLowerCase().includes(token.toLowerCase()));
      const poison = (value: unknown, token: string): unknown =>
        typeof value === "string" ? token
          : Array.isArray(value) ? value.map((item) => poison(item, token))
            : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poison(item, token)]))
              : value;
      const fields = Object.entries(MARKETPLACE_ERROR_DETAIL_FIELDS).flatMap(([code, reasons]) =>
        Object.entries(reasons as Record<string, Record<string, string>>).flatMap(([reason, declared]) =>
          // Only string fields can contain credentials; exercise every string-bearing field.
          Object.entries(declared).filter(([, kind]) => kind !== "number" && kind !== "credential-issuer").flatMap(([field]) => TOKENS.map((token) => ({ code, reason, declared, field, token })))));

      it.each(fields)("$code $reason: a token in $field never crosses, identifier or not", async ({ code, reason, declared, field, token }) => {
        const benign = (kind: string) => (kind === "number" ? 1 : kind === "string[]" ? ["x"] : kind === "credential-issuer" ? "gitlab" : "x");
        const detail = Object.fromEntries(Object.entries(declared).map(([name, kind]) => [name, name === field ? (kind === "string[]" ? [token] : token) : benign(kind)]));
        await setup({
          refresh: vi.fn(async () => {
            throw new MarketplaceError(code as never, "failed", { detail: { reason, ...detail } as never });
          }),
        });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
        expect(answer).toMatchObject({ ok: false, code, detail: { reason } });
        const { en, ko } = sentences(answer);
        expect(leaks(JSON.stringify(answer))).toBe(false);
        expect(leaks(`${en}\n${ko}`)).toBe(false);
      });

      it("never lets one cross in an answer of the preview, list, add, sync and update-status channels", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-payload-"));
        const skill = "---\nname: note\ndescription: d\n---\n";
        const harness = await folderService({ root, folders: { fs: new FakeVolume("linux").file("/m/SKILL.md", skill), platform: "linux", limits: TEST_FOLDER_LIMITS } });
        const network = await folderService({ root: mkdtempSync(join(root, "win-")), folders: { fs: new FakeVolume("win32"), platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
        try {
          const preview = await harness.service.previewSource({ input: "/m", auth: "none" });
          if (preview.type === "confirm") throw new Error("unexpected confirmation");
          const confirm = await network.service.previewSource({ input: "\\\\server\\share\\m", auth: "none" });
          expect(confirm.type).toBe("confirm");
          const added = await harness.service.addSource({ previewId: preview.previewId, id: "team" });
          const listed = await harness.service.listSources();
          const synced = await harness.service.refresh("team");
          for (const token of TOKENS) {
            const sent = vi.fn();
            await setup({
              previewSource: vi.fn(async (request: { input: string }) => poison(request.input === "c" ? confirm : preview, token)),
              listSources: vi.fn(async () => poison(listed, token)),
              addSource: vi.fn(async () => poison(added, token)),
              acknowledgeSource: vi.fn(async () => poison(added, token)),
              setEnabled: vi.fn(async () => poison(added, token)),
              refresh: vi.fn(async () => poison(synced, token)),
              repairSource: vi.fn(async () => poison(synced, token)),
              updates: vi.fn(async () => [{ key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: `Meeting ${token}`, from: "1.0.0", to: "1.1.0" }]),
              autoUpdateContext: vi.fn(async () => ({
                policy: "user",
                requiredInstalls: [{ source: "corp", kind: "skill", name: "audit" }],
                unmetRequired: [{
                  key: { sourceId: "corp", kind: "skill", name: "audit" },
                  sourceLabel: `Corp ${token}`,
                  reason: "source-unreachable",
                  minAppVersion: null,
                  installedFrom: { sourceId: "team", label: `Team ${token}`, removal: "confirm" },
                }],
                sources: [],
                installed: [],
              })),
            }, { isDestroyed: () => false, webContents: { send: sent } }).then(async ({ registration }) => {
              const answers = [
                await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" }),
                await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "c", auth: "none" }),
                await invokeFileIpcHandler(handlers, channels.sourcesList),
                await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "team" }),
                await invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "team", ["network-folder"]),
                await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, "team", false),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "team"),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "team", "repair"),
              ];
              await registration.startBackground();
              answers.push(await invokeFileIpcHandler(handlers, channels.updatesStatus), await invokeFileIpcHandler(handlers, channels.updatesCheck));
              for (const answer of answers) {
                expect(answer).toMatchObject({ ok: true });
                expect(leaks(JSON.stringify(answer))).toBe(false);
              }
              expect(answers.at(-1)).toMatchObject({ value: { unmetRequired: [{ reason: "source-unreachable", sourceLabel: expect.stringMatching(/^Corp /u), installedFrom: { label: expect.stringMatching(/^Team /u) } }] } });
              expect(sent.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([channels.updateStatusChanged, channels.bootInstallsApplied, CHANNELS.bootstrap.status]));
              expect(leaks(JSON.stringify(sent.mock.calls))).toBe(false);
            });
          }
        } finally {
          harness.service.close();
          network.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("names a source and a package whose names only look like a credential back to main unchanged: list, disable, catalog, plan", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-roundtrip-"));
        const name = "test-marketplace2026";
        const volume = new FakeVolume("linux")
          .file("/m/marketplace.json", JSON.stringify({ schemaVersion: 2, name, displayName: "Test marketplace", packages: [{ kind: "skill", name, path: `skills/${name}` }] }))
          .file(`/m/skills/${name}/ave-package.json`, JSON.stringify({ schemaVersion: 2, kind: "skill", name, version: "1.0.0", minAppVersion: "0.12.0", payload: { entry: "SKILL.md" } }))
          .file(`/m/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\nBody.\n`);
        const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
        try {
          const real = harness.service;
          await setup({
            previewSource: vi.fn((request: never) => real.previewSource(request)),
            addSource: vi.fn((request: never) => real.addSource(request)),
            listSources: vi.fn(() => real.listSources()),
            setEnabled: vi.fn((id: string, enabled: boolean) => real.setEnabled(id, enabled)),
            catalog: vi.fn((query: never) => real.catalog(query)),
            planInstall: vi.fn((request: never) => real.planInstall(request)),
          });
          const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
          expect(await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: name })).toMatchObject({ ok: true, value: { id: name } });
          const listed = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string }> };
          const id = listed.value.find((source) => source.id.startsWith("test-"))!.id;
          expect(id).toBe(name);
          expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, id, false)).toMatchObject({ ok: true });
          expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, id, true)).toMatchObject({ ok: true });
          const catalog = (await invokeFileIpcHandler(handlers, channels.catalogList, { sourceId: id })) as { ok: true; value: { entries: Array<{ key: { sourceId: string; kind: string; name: string } }> } };
          const [entry] = catalog.value.entries;
          expect(entry?.key).toEqual({ sourceId: name, kind: "skill", name });
          expect(await invokeFileIpcHandler(handlers, channels.installPlan, entry!.key)).toMatchObject({ ok: true, value: { planId: expect.any(String) } });
        } finally {
          harness.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });

      describe("an identifier with a credential's shape is refused where it enters, with its reason in both languages", () => {
        const NAME_TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;
        const KEY_TOKEN = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
        const refusal = async (volume: FakeVolume, act: (harness: Awaited<ReturnType<typeof folderService>>) => Promise<unknown>) => {
          const root = mkdtempSync(join(tmpdir(), "ave-ipc-ingress-"));
          const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
          try {
            return await act(harness);
          } finally {
            harness.service.close();
            rmSync(root, { recursive: true, force: true });
          }
        };
        const noToken = (answer: unknown) => {
          const text = JSON.stringify(answer);
          expect(text).not.toContain(NAME_TOKEN);
          expect(text).not.toContain(KEY_TOKEN);
        };

        it.each([
          ["a token", () => NAME_TOKEN, "glpat-", "a GitLab token", "GitLab 토큰"],
          // Reserved credential prefixes remain reserved even when followed by ordinary words.
          ["an ordinary name under a GitLab prefix", () => "glpat-rotation-documentation-for-local-marketplaces", "glpat-", "a GitLab token", "GitLab 토큰"],
          ["a digest under an OpenAI prefix", () => `sk-${createHash("sha224").update("ordinary task inputs").digest("hex")}`, "sk-", "an OpenAI API key", "OpenAI API 키"],
          ["a reserved part after a word", () => "docs-glpat-rotation-documentation-for-local", "glpat-", "a GitLab token", "GitLab 토큰"],
        ])("refuses a source id that is %s, naming its reserved prefix", async (_label, id, prefix, enIssuer, koIssuer) => {
          const answer = await refusal(new FakeVolume("linux").file("/m/SKILL.md", "---\nname: note\ndescription: d\n---\n"), async (harness) => {
            await setup({
              previewSource: vi.fn((request: never) => harness.service.previewSource(request)),
              addSource: vi.fn((request: never) => harness.service.addSource(request)),
            });
            const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
            return invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: id() });
          });
          // A prefix alone is not a credential and remains visible.
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "reserved-prefix", prefix } });
          noToken(answer);
          expect(sentences(answer)).toEqual({
            en: `Ids starting with “${prefix}”, or with a part after “-” starting with it, are reserved because they look like ${enIssuer}. Choose a different id.`,
            ko: `“${prefix}”로 시작하거나 “-” 뒤 부분이 그것으로 시작하는 ID는 ${koIssuer}처럼 보여 예약되어 있습니다. 다른 ID를 고르세요.`,
          });
        });

        it.each([
          ["a package name", new FakeVolume("linux").file("/m/SKILL.md", `---\nname: ${NAME_TOKEN}\ndescription: d\n---\n`), { reason: "name-reserved-prefix", prefix: "glpat-", issuer: "gitlab" }, {
            en: "Package names starting with “glpat-”, or with a part after “-” starting with it, are reserved because they look like a GitLab token, so Ave does not offer this package. Ask the package's author to choose a different name.",
            ko: "“glpat-”로 시작하거나 “-” 뒤 부분이 그것으로 시작하는 패키지 이름은 GitLab 토큰처럼 보여 예약되어 있으므로 Ave가 이 패키지를 제공하지 않습니다. 패키지 작성자에게 다른 이름을 골라 달라고 하세요.",
          }],
          ["a package version", new FakeVolume("linux").file("/m/SKILL.md", `---\nname: note\nversion: 1.0.0-${NAME_TOKEN}\ndescription: d\n---\n`), { reason: "version-reserved-prefix", prefix: "glpat-", issuer: "gitlab" }, {
            en: "Versions with a part starting with “glpat-” are reserved because they look like a GitLab token, so Ave does not offer this package. Ask the package's author to change the version.",
            ko: "“glpat-”로 시작하는 부분이 있는 버전은 GitLab 토큰처럼 보여 예약되어 있으므로 Ave가 이 패키지를 제공하지 않습니다. 패키지 작성자에게 버전을 바꿔 달라고 하세요.",
          }],
          // When credential signatures overlap, prefer the more specific classification.
          ["a package version under an overlapping prefix", new FakeVolume("linux").file("/m/SKILL.md", `---\nname: note\nversion: 1.0.0-sk${"-ant-api03-"}${"a".repeat(12)}T3Blbk${"FJ"}${"b".repeat(12)}\ndescription: d\n---\n`), { reason: "version-reserved-prefix", prefix: "sk-ant-", issuer: "anthropic" }, {
            en: "Versions with a part starting with “sk-ant-” are reserved because they look like an Anthropic API key, so Ave does not offer this package. Ask the package's author to change the version.",
            ko: "“sk-ant-”로 시작하는 부분이 있는 버전은 Anthropic API 키처럼 보여 예약되어 있으므로 Ave가 이 패키지를 제공하지 않습니다. 패키지 작성자에게 버전을 바꿔 달라고 하세요.",
          }],
          ["an MCP server's name with a word glued to its token", new FakeVolume("linux")
            .file("/m/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer", version: "1.0.0", description: "Writes" }))
            .file("/m/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [`backup_${KEY_TOKEN}`]: { type: "stdio", command: "./server/editor", args: [] } } }))
            .file("/m/server/editor", "#!/bin/sh\n"), { reason: "component-reserved-prefix", prefix: "ghp_", issuer: "github" }, {
            en: "A skill, agent, prompt, routine or MCP server in this package has a name with a part starting with “ghp_”. Such names are reserved because they look like a GitHub token, so Ave does not offer this package. Ask the package's author to choose a different name.",
            ko: "이 패키지에 든 스킬, 에이전트, 프롬프트, 루틴 또는 MCP 서버의 이름에 “ghp_”로 시작하는 부분이 있습니다. 그런 이름은 GitHub 토큰처럼 보여 예약되어 있으므로 Ave가 이 패키지를 제공하지 않습니다. 패키지 작성자에게 다른 이름을 골라 달라고 하세요.",
          }],
          ["an MCP server's name", new FakeVolume("linux")
            .file("/m/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer", version: "1.0.0", description: "Writes" }))
            .file("/m/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [KEY_TOKEN]: { type: "stdio", command: "./server/editor", args: [] } } }))
            .file("/m/server/editor", "#!/bin/sh\n"), { reason: "component-reserved-prefix", prefix: "ghp_", issuer: "github" }, {
            en: "A skill, agent, prompt, routine or MCP server in this package has a name with a part starting with “ghp_”. Such names are reserved because they look like a GitHub token, so Ave does not offer this package. Ask the package's author to choose a different name.",
            ko: "이 패키지에 든 스킬, 에이전트, 프롬프트, 루틴 또는 MCP 서버의 이름에 “ghp_”로 시작하는 부분이 있습니다. 그런 이름은 GitHub 토큰처럼 보여 예약되어 있으므로 Ave가 이 패키지를 제공하지 않습니다. 패키지 작성자에게 다른 이름을 골라 달라고 하세요.",
          }],
        ])("refuses a direct folder package by %s, naming its reserved prefix", async (_label, volume, detail, expected) => {
          const answer = await refusal(volume, async (harness) => {
            await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
            return invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" });
          });
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_INDEX_INVALID", detail });
          noToken(answer);
          expect(sentences(answer)).toEqual(expected);
        });

        it("quarantines a source an earlier build stored under one, and removes it through the handle its row carries", async () => {
          const root = mkdtempSync(join(tmpdir(), "ave-ipc-legacy-"));
          const skill = "---\nname: note\ndescription: d\n---\n";
          const volume = new FakeVolume("linux").file("/m/SKILL.md", skill).file("/n/SKILL.md", skill);
          try {
            const first = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
            const preview = await first.service.previewSource({ input: "/m", auth: "none" });
            if (preview.type === "confirm") throw new Error("unexpected confirmation");
            await first.service.addSource({ previewId: preview.previewId, id: "team" });
            const other = await first.service.previewSource({ input: "/n", auth: "none" });
            if (other.type === "confirm") throw new Error("unexpected confirmation");
            await first.service.addSource({ previewId: other.previewId, id: "notes" });
            first.service.close();
            const list = join(root, "marketplaces", "sources.json");
            writeFileSync(list, readFileSync(list, "utf8").replace('"team"', JSON.stringify(NAME_TOKEN)));
            const data = join(root, "marketplaces", NAME_TOKEN);
            renameSync(join(root, "marketplaces", "team"), data);
            for (const file of readdirSync(join(data, "snapshots"))) {
              const snapshot = join(data, "snapshots", file);
              writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace('"sourceId":"team"', `"sourceId":${JSON.stringify(NAME_TOKEN)}`));
            }

            const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
            try {
              const real = harness.service;
              await setup({
                listSources: vi.fn(() => real.listSources()),
                setEnabled: vi.fn((id: string, enabled: boolean) => real.setEnabled(id, enabled)),
                refresh: vi.fn((id?: string) => real.refresh(id)),
                removeSource: vi.fn((id: string) => real.removeSource(id)),
                catalog: vi.fn((query: never) => real.catalog(query)),
              });
              const listed = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string; status: { state: string }; canRemove: boolean; canDisable: boolean; enabled: boolean }> };
              noToken(listed);
              const row = listed.value.find((source) => source.status.state === "id-holds-credential")!;
              expect(row).toMatchObject({ id: expect.stringMatching(/^ave-legacy-[0-9a-f]{32}$/u), canRemove: true, canDisable: false, enabled: false });
              expect(await harness.registry.readState(NAME_TOKEN)).toMatchObject({ enabled: true });
              expect((await harness.syncer.readSnapshot(NAME_TOKEN))?.packages).toHaveLength(1);
              expect(listed.value.find((source) => source.id === "notes")).toMatchObject({ status: { state: expect.not.stringMatching("id-holds-credential") } });
              const catalog = (await invokeFileIpcHandler(handlers, channels.catalogList, {})) as { ok: true; value: { entries: Array<{ key: { sourceId: string } }> } };
              expect(catalog.value.entries.map((entry) => entry.key.sourceId)).toEqual(["notes"]);
              for (const answer of [
                await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, row.id, true),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, row.id),
              ]) {
                expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
                noToken(answer);
                expect(sentences(answer)).toEqual({
                  en: "This source's id looks like a password or token, so Ave does not sync it or offer its packages. Remove the source and add it again with another id.",
                  ko: "이 소스의 ID가 비밀번호나 토큰처럼 보여 Ave가 동기화하거나 패키지를 제공하지 않습니다. 소스를 제거한 뒤 다른 ID로 다시 추가하세요.",
                });
              }
              const synced = vi.spyOn(harness.syncer, "sync");
              await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
              expect(synced.mock.calls.map(([id]) => id)).toContain("notes");
              expect(synced.mock.calls.map(([id]) => id)).not.toContain(NAME_TOKEN);
              const statePath = join(root, "marketplaces", NAME_TOKEN, "state.json");
              const stateBefore = readFileSync(statePath, "utf8");
              expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, NAME_TOKEN, false)).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
              expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
              expect(await invokeFileIpcHandler(handlers, channels.sourcesRemove, "[REDACTED:TOKEN]")).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID" });
              expect(await invokeFileIpcHandler(handlers, channels.sourcesRemove, row.id)).toMatchObject({ ok: true });
              const after = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string }> };
              expect(after.value.map((source) => source.id)).not.toContain(row.id);
              expect(after.value.map((source) => source.id)).toContain("notes");
              expect(readFileSync(list, "utf8")).not.toContain(NAME_TOKEN);
            } finally {
              harness.service.close();
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        });

        it("refuses a pasted server.json whose name ends in one", async () => {
          const answer = await refusal(new FakeVolume("linux"), async (harness) => {
            await setup({ previewDirectMcp: vi.fn((request: never) => harness.service.previewDirectMcp(request)) });
            return invokeFileIpcHandler(handlers, channels.directPreview, { serverJson: JSON.stringify({ name: `io.github.acme/${NAME_TOKEN}`, version: "1.0.0" }) });
          });
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_INDEX_INVALID", detail: { reason: "name-reserved-prefix", prefix: "glpat-", issuer: "gitlab" } });
          noToken(answer);
        });
      });

      it("answers a folder preview whose path holds a token with the confirmation, the path masked in it and in both sentences", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
        const harness = await folderService({ root, folders: { fs: new FakeVolume("win32"), platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
        try {
          await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
          const mixed = "A1b2C3d4".repeat(43);
          const appToken = `gh${"s_"}123456_eyJ${"hbGciOiJSUzI1NiJ9"}.eyJ${"pc3MiOiIxMjM0NTYifQ"}.${mixed.slice(0, 342)}`;
          const googleDash = `AI${"za"}${mixed.slice(0, 34)}-`;
          for (const token of [...TOKENS, appToken, googleDash]) {
            for (const segment of [token, `backup_${token}`, `backup-${token}`, `${token}_old`]) {
              const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: `//server/share/${segment}`, auth: "none" }) as { ok: true; value: { type: string; warnings: EnteredTargetWarningView[] } };
              expect(answer).toMatchObject({ ok: true, value: { type: "confirm", warnings: [{ warning: "network-folder", address: expect.stringContaining("[REDACTED:") }] } });
              expect(JSON.stringify(answer), segment).not.toContain(token);
              for (const language of ["en", "ko"] as const) {
                expect(warningText((key, vars) => translate(language, key, vars), answer.value.warnings[0]!)).not.toContain(token);
              }
            }
          }
        } finally {
          harness.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    it("answers a repository that is already a source with that source's id, rendered as what to do instead of another id", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-repository-"));
      const harness = await folderService({ root, folders: { fs: new FakeVolume("linux"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
      try {
        await harness.registry.add({ id: "acme", origin: "custom", url: "https://github.com/acme/market", auth: { kind: "none" } });
        await setup({
          addSource: vi.fn(() => harness.registry.add({ id: "acme-ssh", origin: "custom", url: "git@github.com:Acme/Market.git", auth: { kind: "ssh" } })),
        });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "acme-ssh" });
        expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "repository-already-added", url: "ssh://git@github.com/Acme/Market", existingId: "acme" } });
        expect(sentences(answer)).toEqual({
          en: "ssh://git@github.com/Acme/Market is already added as acme. Use acme, or remove it before adding this repository again.",
          ko: "ssh://git@github.com/Acme/Market은(는) 이미 acme(으)로 추가되어 있습니다. acme을(를) 쓰거나, 지운 뒤 이 저장소를 다시 추가하세요.",
        });
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("masks a token pasted as the ssh account of an address a refusal names, in the envelope and both sentences", async () => {
      // Normalization retains SSH account names, including credential-shaped names.
      const token = `ghp_${"a".repeat(36)}`;
      const pasted = `ssh://${token}@github.com/acme/market`;
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-repository-"));
      const harness = await folderService({ root, folders: { fs: new FakeVolume("linux"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
      const gate = new NetworkGate({ policy: policySource(policyLoad({ allowDirectInstall: false })), allowLoopback: false, transport: createPinnedFetch() });
      try {
        await harness.registry.add({ id: "acme", origin: "custom", url: "https://github.com/acme/market", auth: { kind: "none" } });
        await setup({
          addSource: vi.fn(() => harness.registry.add({ id: "acme-ssh", origin: "custom", url: pasted, auth: { kind: "ssh" } })),
          previewSource: vi.fn(async () => gate.checkDirectInstall(normalizeSourceUrl(pasted).url)),
        });
        const duplicate = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "acme-ssh" });
        expect(duplicate).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "repository-already-added", url: "ssh://[REDACTED:TOKEN]@github.com/acme/market", existingId: "acme" } });
        const direct = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: pasted, auth: "ssh" });
        expect(direct).toMatchObject({ ok: false, code: "SOURCE_POLICY_BLOCKED", detail: { reason: "direct-install-blocked", target: "ssh://[REDACTED:TOKEN]@github.com/acme/market" } });
        for (const answer of [duplicate, direct]) {
          expect(JSON.stringify(answer)).not.toContain(token);
          const { en, ko } = sentences(answer);
          expect(en).toContain("ssh://[REDACTED:TOKEN]@github.com/acme/market");
          expect(ko).toContain("ssh://[REDACTED:TOKEN]@github.com/acme/market");
          expect(`${en}\n${ko}`).not.toContain(token);
        }
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("repairs through the refresh channel with the repair intent, and keeps a failed repair's code and detail", async () => {
    const detail = { reason: "repair-failed", sourceId: "ave" } as const;
    const { service } = await setup({
      repairSource: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", "could not move the downloaded copy of source ave aside (EBUSY)", { detail });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "ave", "repair");
    expect(answer).toEqual({ ok: false, code: "SOURCE_LOCAL_DATA_DAMAGED", message: "could not move the downloaded copy of source ave aside (EBUSY)", detail });
    expect(parseGitMarketplaceResult(answer)).toEqual(answer);
    expect(service.repairSource).toHaveBeenCalledWith("ave");
    expect(service.refresh).not.toHaveBeenCalled();

    await expect(invokeFileIpcHandler(handlers, channels.sourcesRefresh, undefined, "repair")).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesRefresh, "ave", "wipe")).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    expect(service.repairSource).toHaveBeenCalledTimes(1);
  });

  it("refuses an address with a password by its reason, and the password never reaches the renderer", async () => {
    await setup({ previewSource: vi.fn(async (request: { input: string }) => normalizeSourceUrl(request.input)) });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "https://alice:verifier-secret@example.com/owner/repo", auth: "none" });
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_URL_REJECTED", detail: { reason: "credentials-in-url" } });
    expect(JSON.stringify(parseGitMarketplaceResult(answer))).not.toContain("verifier-secret");
  });

  it("masks the whole value of an Authorization header of any scheme in a failure it answers with (§18.8)", async () => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `proxy returned Authorization: Custom ${secret}`, { detail: { reason: "proxy", host: "git.example", proxy: `Proxy-Authorization: Weird ${secret}` } });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE", message: "proxy returned Authorization: [REDACTED:TOKEN]", detail: { reason: "proxy", proxy: "Proxy-Authorization: [REDACTED:TOKEN]" } });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it.each([
    ["an escaped NBSP", "\\u00a0"],
    ["an escaped EM SPACE", "\\u2003"],
    ["an escaped BOM", "\\uFEFF"],
    ["an escaped vertical tab, two levels deep", "\\\\v"],
  ])("masks an Authorization value with %s before its colon in a failure it answers with (§18.8)", async (_label, space) => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `proxy returned Authorization${space}: Custom ${secret}`, {
          detail: { reason: "proxy", host: "git.example", proxy: `{"Proxy-Authorization${space}":${space}"Custom ${secret}"}` },
        });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: `proxy returned Authorization${space}: [REDACTED:TOKEN]`,
      detail: { reason: "proxy", proxy: `{"Proxy-Authorization${space}":${space}[REDACTED:TOKEN]` },
    });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it.each([
    ["a space", "authorization header", '{"authorization header":'],
    ["an escaped tab", "authorization\\tvalue", '{"authorization\\tvalue":'],
    ["an NBSP", `authorization${String.fromCharCode(0xa0)}header`, `{"authorization${String.fromCharCode(0xa0)}header":`],
    // An escaped key separator still marks where masking begins.
    ["an escaped colon", "authorization\\u003aheader", '{"authorization\\u003a'],
    ["an escaped equals sign", "authorization\\u003dheader", '{"authorization\\u003d'],
  ])("masks the value of a quoted key with %s after the word in a failure it answers with (§18.8)", async (_label, key, masked) => {
    const secret = "opaque-pass-12345";
    const message = `{"${key}":"Custom ${secret}"}`;
    expect(Object.values(JSON.parse(message))).toEqual([`Custom ${secret}`]);
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", message, { detail: { reason: "proxy", host: "git.example", proxy: JSON.stringify({ level: 30, msg: message }) } });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE", message: `${masked}[REDACTED:TOKEN]` });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it.each([
    ["an apostrophe", "client's authorization header", 0],
    ["an apostrophe", "client's authorization header", 2],
    ["an escaped quote", 'client "authorization header', 0],
    ["an escaped quote", 'client "authorization header', 2],
    ["quoted words", 'prefix "quoted" authorization header', 0],
    ["quoted words", 'prefix "quoted" authorization header', 2],
  ])("masks the value of a key with %s inside it, serialized %i deep, in a failure it answers with (§18.8)", async (_label, key, depth) => {
    const secret = "opaque-pass-12345";
    let message = JSON.stringify({ [key]: `Custom ${secret}` });
    for (let level = 0; level < depth; level++) message = JSON.stringify({ msg: message });
    expect(() => JSON.parse(message)).not.toThrow();
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", message); }) });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE" });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it("masks the value of a key that holds `authorization` as a word in a failure it answers with (§18.8)", async () => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `config rejected: authorization_header="Basic ${secret}"`, {
          detail: { reason: "proxy", host: "git.example", proxy: JSON.stringify({ proxy_authorization: `Basic ${secret}`, safe: "keep" }) },
        });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: "config rejected: authorization_header=[REDACTED:TOKEN]",
      detail: { reason: "proxy", proxy: '{"proxy_authorization":[REDACTED:TOKEN]' },
    });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it("masks an Authorization value whole in a failure it answers with, past a marker already in it (§18.8)", async () => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `proxy said: Authorization: [REDACTED:TOKEN] ${secret}\nretry later`, {
          detail: { reason: "proxy", host: "git.example", proxy: `Proxy-Authorization: [REDACTED:TOKEN]\r\n\t${secret}\r\nVia: proxy.example` },
        });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: "proxy said: Authorization: [REDACTED:TOKEN]\nretry later",
      detail: { reason: "proxy", proxy: "Proxy-Authorization: [REDACTED:TOKEN]\r\nVia: proxy.example" },
    });
    expect(JSON.stringify(answer)).not.toContain(secret);
  });

  it("masks an Authorization value to its line's end in a failure it answers with, past any quote in it (§18.8)", async () => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        const body = `{"message":"Couldn't fetch: Authorization: Custom foo' ${secret}","safe":"keep"}`;
        throw new MarketplaceError("SOURCE_UNREACHABLE", `Couldn't authenticate: Authorization: Digest username="O'Neil", response="${secret}"\nretry later\n${body}`, {
          detail: {
            reason: "proxy",
            host: "git.example",
            proxy: `Proxy-Authorization: Digest username="O'Neil",\r\n\tresponse="${secret}"\r\nVia: proxy.example`,
          },
        });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: `Couldn't authenticate: Authorization: [REDACTED:TOKEN]\nretry later\n{"message":"Couldn't fetch: Authorization: [REDACTED:TOKEN]`,
      detail: { reason: "proxy", proxy: "Proxy-Authorization: [REDACTED:TOKEN]\r\nVia: proxy.example" },
    });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(JSON.stringify(answer)).not.toContain("Neil");
  });

  it("scrubs credentials from every failure message it answers with", async () => {
    const bearer = "abc123def456ghi789";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", "fatal: unable to access 'https://alice:verifier-secret@example.com/owner/repo/'");
      }),
      listSources: vi.fn(async () => { throw new Error(`proxy said no\nAuthorization: Bearer ${bearer}\npassword=hunter2`); }),
    });
    const refreshed = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(refreshed).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE", message: expect.stringContaining("https://[REDACTED:CREDENTIALS]@example.com/owner/repo/") });
    expect(JSON.stringify(refreshed)).not.toContain("verifier-secret");
    const listed = await invokeFileIpcHandler(handlers, channels.sourcesList);
    expect(listed).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("proxy said no") });
    expect(JSON.stringify(listed)).not.toMatch(new RegExp(`${bearer}|hunter2`, "u"));
  });

  it("scrubs every credential spelling a git error can carry, and keeps ssh account names", async () => {
    const raw = [
      "pip: git+https://canary-token@github.com/acme/tools",
      'helper failed: token="canarypass"; retry',
      "askpass: secret='canary pass' then",
      "ssh://alice%3Acanary-secret@git.example/acme/tools",
      "scp: alice:canary-scp@github.com:acme/tools",
      "remote ssh://git@git.example/acme/tools",
    ].join("\n");
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", raw); }) });
    const answer = parseGitMarketplaceResult(await invokeFileIpcHandler(handlers, channels.sourcesRefresh));
    if (answer === null || answer.ok) throw new Error("expected a failure envelope");
    expect(answer.message).not.toMatch(/canary/u);
    expect(answer.message).toContain("git+https://[REDACTED:CREDENTIALS]@github.com/acme/tools");
    expect(answer.message).toContain("ssh://git@git.example/acme/tools");
  });

  it.each(DIAGNOSTIC_SECRET_PROBES)("scrubs the $id spelling from the envelope it answers with", async ({ text, secret, address, kept }) => {
    await setup({
      previewSource: vi.fn(async (request: { input: string }) => {
        if (address) return normalizeSourceUrl(request.input);
        throw new MarketplaceError("SOURCE_UNREACHABLE", request.input);
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: text, auth: "none" });
    expect(answer).toMatchObject({ ok: false });
    expect(JSON.stringify(answer)).not.toContain(secret);
    if (kept !== undefined) expect((answer as { message: string }).message).toContain(kept);
  });

  it("keeps a failure's code when the scrubber fails closed, its message wholly redacted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", "git said token=canarysentinel"); }) });
    const restore = breakDiagnosticScrubberOn("canarysentinel");
    let answer: unknown;
    try {
      answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    } finally {
      restore();
      warn.mockRestore();
    }
    expect(answer).toEqual({ ok: false, code: "SOURCE_UNREACHABLE", message: "[REDACTED:DIAGNOSTIC]" });
  });

  it("keeps diagnostics that name no credential", async () => {
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", DIAGNOSTIC_KEPT.join("\n")); }) });
    const answer = parseGitMarketplaceResult(await invokeFileIpcHandler(handlers, channels.sourcesRefresh));
    if (answer === null || answer.ok) throw new Error("expected a failure envelope");
    expect(answer.message).toBe(DIAGNOSTIC_KEPT.join("\n"));
  });

  it("scrubs a detail's diagnostic text before it crosses, as for a policy file the loader refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-mkt-policy-"));
    try {
      const key = "https://alice:detail-canary@example.com/x";
      writeFileSync(join(dir, "policy.json"), `{"${key}": 1, "${key}": 2}`);
      const policy = await FilePolicySource.open(join(dir, "policy.json"));
      const gate = new NetworkGate({ policy, allowLoopback: false, transport: createPinnedFetch() });
      await setup({ refresh: vi.fn(async () => gate.checkRemote(normalizeSourceUrl("https://1.1.1.1/acme/market"), { official: false, acknowledged: new Set() })) });
      const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
      expect(answer).toMatchObject({
        ok: false,
        code: "SOURCE_POLICY_BLOCKED",
        detail: { reason: "policy-invalid", error: expect.stringContaining("https://[REDACTED:CREDENTIALS]@example.com/x") },
      });
      expect(JSON.stringify(answer)).not.toContain("detail-canary");
      expect(parseGitMarketplaceResult(answer)).toEqual(answer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the service again after a failed build", async () => {
    handlers.clear();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("policy unreadable"))
      .mockResolvedValue({ service: { listSources: async () => [] }, close: async () => {} });
    const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
    registerGitMarketplaceHandlers({ auditLogger: { log: vi.fn() } } as never, async () => null, create, async () => {});
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("closes a service whose quit hook failed to register, and builds a fresh one next time", async () => {
    handlers.clear();
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    const create = vi.fn()
      .mockResolvedValueOnce({ service: { listSources: async () => [] }, close: closes[0] })
      .mockResolvedValueOnce({ service: { listSources: async () => [] }, close: closes[1] });
    const onBuilt = vi.fn().mockRejectedValueOnce(new Error("shutdown hook unavailable")).mockResolvedValue(undefined);
    const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
    registerGitMarketplaceHandlers({ auditLogger: { log: vi.fn() } } as never, async () => null, create, onBuilt);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(closes[0]).toHaveBeenCalledTimes(1);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(closes[1]).not.toHaveBeenCalled();
  });

  it("checks each request before the service sees it", async () => {
    const { service } = await setup();
    const invalid = { ok: false, code: "invalid-request" };
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "acme/tools", auth: "password" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "widget", name: "x" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "plugin", name: "x", switchSource: "yes" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, "acme", "true")).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.catalogList, { installedOnly: 1 })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", [{ name: "notes", digest: "not-a-digest" }])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", [{ name: "notes", digest: "a".repeat(64) }, { name: "notes", digest: "a".repeat(64) }])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.directPreview, { serverJson: "{}", select: { package: -1 } })).resolves.toMatchObject(invalid);
    expect(service.previewSource).not.toHaveBeenCalled();
    expect(service.planInstall).not.toHaveBeenCalled();
    expect(service.executeInstall).not.toHaveBeenCalled();
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect(service.catalog).not.toHaveBeenCalled();
    expect(service.previewDirectMcp).not.toHaveBeenCalled();

    await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "acme/tools", auth: "token", token: "t0k", extra: 1 });
    expect(service.previewSource).toHaveBeenCalledWith({ input: "acme/tools", auth: "token", token: "t0k" });
    await invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "plugin", name: "x", version: "1.2.0", switchSource: true });
    expect(service.planInstall).toHaveBeenCalledWith({ sourceId: "acme", kind: "plugin", name: "x", version: "1.2.0", switchSource: true });
    await invokeFileIpcHandler(handlers, channels.catalogList, { kind: "skill", query: "" });
    expect(service.catalog).toHaveBeenCalledWith({ kind: "skill" });
  });

  it("passes only known confirmations, each once, to a preview and to Allow… (§18.5)", async () => {
    const { service } = await setup();
    const invalid = { ok: false, code: "invalid-request" };
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["not-a-warning"] })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "unencrypted"] })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: "unencrypted" })).resolves.toMatchObject(invalid);
    expect(service.previewSource).not.toHaveBeenCalled();
    await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "internal-network"] });
    expect(service.previewSource).toHaveBeenCalledWith({ input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "internal-network"] });

    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", [])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", ["everything"])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, 7, ["unencrypted"])).resolves.toMatchObject(invalid);
    expect(service.acknowledgeSource).not.toHaveBeenCalled();
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", ["internal-downloads"])).resolves.toEqual({ ok: true, value: { id: "corp", acknowledged: ["internal-downloads"] } });
    expect(service.acknowledgeSource).toHaveBeenCalledWith("corp", ["internal-downloads"]);
  });

  it("uninstalls a package bound to no source", async () => {
    const { service } = await setup();
    await expect(invokeFileIpcHandler(handlers, channels.uninstall, { sourceId: null, kind: "mcp", name: "weather", removeData: true })).resolves.toMatchObject({ ok: true });
    expect(service.uninstall).toHaveBeenCalledWith({ sourceId: null, kind: "mcp", name: "weather", removeData: true });
  });
});

describe("revocationSink", () => {
  const rule: RevocationRule = { kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable", sourceId: "acme" };

  it("feeds the registry, and reloads content and the catalog only when the rules change", async () => {
    revocationRegistry.resetForTesting();
    const reload = vi.fn(async () => {});
    const catalogChanged = vi.fn();
    const { revocationSink } = await import("../git-marketplace.js");
    const sink = revocationSink(async () => ({ reload }) as never, catalogChanged);

    await sink.apply({ rules: [rule], unreadable: [] });
    expect(revocationRegistry.evaluate("skill", "review", "1.0.0")).toMatchObject({ kind: "block", sourceId: "acme" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(catalogChanged).toHaveBeenCalledTimes(1);

    await sink.apply({ rules: [rule], unreadable: [{ sourceId: "broken", message: "unreadable" }] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(catalogChanged).toHaveBeenCalledTimes(1);

    await sink.apply({ rules: [], unreadable: [] });
    expect(revocationRegistry.evaluate("skill", "review", "1.0.0")).toEqual({ kind: "allow" });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(catalogChanged).toHaveBeenCalledTimes(2);
    revocationRegistry.resetForTesting();
  });

  it("refreshes the catalog when no installed content runtime exists yet", async () => {
    revocationRegistry.resetForTesting();
    const catalogChanged = vi.fn();
    const { revocationSink } = await import("../git-marketplace.js");
    await revocationSink(async () => null, catalogChanged).apply({ rules: [rule], unreadable: [] });
    expect(catalogChanged).toHaveBeenCalledTimes(1);
    revocationRegistry.resetForTesting();
  });
});

describe("a package installed from a source stored under a credential-shaped id (§18.8)", () => {
  const TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;

  it.each([
    ["while its source is listed", false],
    ["after its source is removed", true],
  ])("is refused detail with the quarantine reason but uninstalled through its row's handle, %s", async (_label, removeFirst) => {
    const root = mkdtempSync(join(tmpdir(), "ave-git-marketplace-quarantine-"));
    const folder = join(mkdtempSync(join(tmpdir(), "ave-git-marketplace-quarantine-source-")), "market");
    const volume = new FakeVolume(process.platform, { drives: { [tmpdir().slice(0, 2).toUpperCase()]: "\\Device\\HarddiskVolume1" } });
    volume.file(join(folder, "SKILL.md"), "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n");
    const folders = { ...nodeFolders(), fs: volume };
    const installed = [{ kind: "skill" as const, name: "note", version: "1.0.0", sourceId: TOKEN, originCommit: null }];
    let harness = await folderService({ root, folders, installed });
    try {
      const preview = await harness.service.previewSource({ input: folder, auth: "none" });
      if (preview.type === "confirm") throw new Error("a local folder needs no confirmation");
      await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
      harness.service.close();
      const marketplaces = join(root, "marketplaces");
      const list = join(marketplaces, "sources.json");
      writeFileSync(list, readFileSync(list, "utf8").replaceAll('"notes"', JSON.stringify(TOKEN)));
      renameSync(join(marketplaces, "notes"), join(marketplaces, TOKEN));
      for (const file of readdirSync(join(marketplaces, TOKEN, "snapshots"))) {
        const path = join(marketplaces, TOKEN, "snapshots", file);
        writeFileSync(path, readFileSync(path, "utf8").replace('"sourceId":"notes"', `"sourceId":${JSON.stringify(TOKEN)}`));
      }
      harness = await folderService({ root, folders, installed });
      handlers.clear();
      const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
      registerGitMarketplaceHandlers(
        { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: { get: () => ({}) } } as never,
        async () => null,
        async () => ({ service: harness.service as never, close: async () => {} }),
        async () => {},
        root,
        new AbortController(),
      );

      const catalog = await invokeFileIpcHandler(handlers, channels.catalogList, { installedOnly: true });
      const entry = (catalog as { value: { entries: Array<{ key: { sourceId: string; kind: string; name: string } }> } }).value.entries.find((item) => item.key.name === "note")!;
      const handle = entry.key.sourceId;
      expect(handle).toMatch(/^ave-legacy-[0-9a-f]{32}$/u);
      if (removeFirst) {
        await expect(invokeFileIpcHandler(handlers, channels.sourcesRemove, handle)).resolves.toMatchObject({ ok: true, value: { orphanedPackages: [{ sourceId: handle, kind: "skill", name: "note" }] } });
      }
      const detail = await invokeFileIpcHandler(handlers, channels.packageDetail, entry.key);
      expect(detail).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
      expect(JSON.stringify(detail)).not.toContain(TOKEN);

      const removed = await invokeFileIpcHandler(handlers, channels.uninstall, entry.key);
      expect(removed).toMatchObject({ ok: true, value: { key: { sourceId: handle, kind: "skill", name: "note" } } });
      expect(installed).toEqual([]);
      expect(JSON.stringify(removed)).not.toContain(TOKEN);
    } finally {
      harness.service.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(join(folder, ".."), { recursive: true, force: true });
    }
  });
});

describe("folder dialogs (§18.9)", () => {
  const PLUGIN_FRAME = "file:///app/plugin-ui-shell.html";

  it("answers the chosen folder, null on cancel, and builds no marketplace for it", async () => {
    const { create } = await setup();
    desktop.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPickFolder)).resolves.toEqual({ ok: true, value: null });
    desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/example/market"] });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPickFolder)).resolves.toEqual({ ok: true, value: { pick: expect.stringMatching(/^pick-[0-9a-f]{32}$/u), display: "/Users/example/market" } });
    expect(desktop.showOpenDialog.mock.calls.at(-1)?.at(-1)).toMatchObject({ properties: ["openDirectory", "dontAddToRecent"] });
    const token = `glp${"at-"}${"abcd1234".repeat(3)}`;
    desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [`/Users/example/${token}`] });
    const masked = await invokeFileIpcHandler(handlers, channels.sourcesPickFolder);
    expect(JSON.stringify(masked)).not.toContain(token);
    expect(masked).toMatchObject({ ok: true, value: { pick: expect.stringMatching(/^pick-[0-9a-f]{32}$/u), display: expect.stringMatching(/^\/Users\/example\/\[REDACTED/u) } });
    expect(create).not.toHaveBeenCalled();
  });

  describe("a chosen folder is previewed by its pick, not by the text the tab shows (§18.9)", () => {
    const TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;
    const marketplace = (displayName: string) => ({
      "marketplace.json": `${JSON.stringify({ schemaVersion: 2, name: "team", displayName, packages: [] })}\n`,
    });
    // The mask contains a colon, which cannot be part of a Windows filename.
    const SIBLING_POSSIBLE = process.platform !== "win32";
    let root: string;
    let parent: string;
    let harness: Awaited<ReturnType<typeof folderService>> | undefined;
    beforeEach(async () => {
      harness = undefined;
      root = mkdtempSync(join(tmpdir(), "ave-git-marketplace-pick-"));
      parent = mkdtempSync(join(tmpdir(), "ave-git-marketplace-pick-parent-"));
      writeFolderFiles(join(parent, TOKEN), marketplace("Team Folder"));
      if (SIBLING_POSSIBLE) writeFolderFiles(join(parent, scrubDiagnosticSecrets(TOKEN)), marketplace("Different Folder"));
      const built = await folderService({ root, folders: nodeFolders() });
      harness = built;
      handlers.clear();
      const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
      registerGitMarketplaceHandlers(
        { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: { get: () => ({}) } } as never,
        async () => null,
        async () => ({ service: built.service as never, close: async () => {} }),
        async () => {},
        root,
        new AbortController(),
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      harness?.service.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    });

    async function choose(path: string): Promise<{ pick: string; display: string }> {
      desktop.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
      const answer = await invokeFileIpcHandler(handlers, channels.sourcesPickFolder);
      if (!(answer as { ok: boolean }).ok) throw new Error(`the pick failed: ${JSON.stringify(answer)}`);
      return (answer as { value: { pick: string; display: string } }).value;
    }

    it("reads and adds the folder main chose, never the sibling its masked display names", async () => {
      const chosen = await choose(join(parent, TOKEN));
      expect(chosen.display).toBe(join(parent, scrubDiagnosticSecrets(TOKEN)));
      const preview = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { pick: chosen.pick, auth: "none" });
      expect(preview).toMatchObject({ ok: true, value: { type: "marketplace", marketplace: { displayName: "Team Folder" } } });
      expect(JSON.stringify(preview)).not.toContain(TOKEN);
      const added = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: (preview as { value: { previewId: string } }).value.previewId, id: "team" });
      expect(added).toMatchObject({ ok: true, value: { id: "team", transport: "folder" } });
      expect(harness!.registry.get("team")).toMatchObject({ transport: "folder", path: realpathSync.native(join(parent, TOKEN)) });
      // A typed masked address names the literal sibling, not the originally redacted folder.
      const typed = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: chosen.display, auth: "none" });
      if (SIBLING_POSSIBLE) expect(typed).toMatchObject({ ok: true, value: { marketplace: { displayName: "Different Folder" } } });
      else expect(typed).toMatchObject({ ok: false });
    });

    it.each([
      ["a pick main never issued", async () => `pick-${"0".repeat(32)}`],
      ["a pick a newer choice replaced", async () => {
        const old = await choose(join(parent, TOKEN));
        await choose(join(parent, scrubDiagnosticSecrets(TOKEN)));
        return old.pick;
      }],
      ["a pick already used for an add", async () => {
        const chosen = await choose(join(parent, TOKEN));
        const preview = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { pick: chosen.pick, auth: "none" });
        await expect(invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: (preview as { value: { previewId: string } }).value.previewId, id: "team" })).resolves.toMatchObject({ ok: true });
        return chosen.pick;
      }],
      ["a pick older than fifteen minutes", async () => {
        const chosen = await choose(join(parent, TOKEN));
        const at = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(at + 15 * 60_000);
        return chosen.pick;
      }],
    ])("refuses %s with folder-pick-unknown and its sentence, reading nothing", async (_label, pickOf) => {
      const pick = await pickOf();
      const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { pick, auth: "none" });
      expect(answer).toMatchObject({ ok: false, code: "SOURCE_URL_REJECTED", detail: { reason: "folder-pick-unknown" } });
      const parsed = parseGitMarketplaceResult(answer);
      if (parsed.ok) throw new Error("expected a failure");
      expect(failureText((key, vars) => translate("en", key, vars), parsed, ENTRY_SUBJECT)).toBe(
        "Ave no longer has the folder you chose (it was replaced by a newer choice, already used, or chosen too long ago). Choose the folder again.",
      );
    });

    it("keeps a pick for a second preview, as a confirmation asks, and takes no address, branch or sign-in beside it", async () => {
      const chosen = await choose(join(parent, TOKEN));
      for (let round = 0; round < 2; round += 1) {
        await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { pick: chosen.pick, auth: "none" })).resolves.toMatchObject({ ok: true });
      }
      for (const extra of [{ input: "/tmp" }, { ref: "main" }, { subdir: "x" }, { token: "t" }, { auth: "token" }]) {
        await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { pick: chosen.pick, auth: "none", ...extra }), JSON.stringify(extra)).resolves.toMatchObject({ ok: false, code: "invalid-request" });
      }
    });
  });

  it("refuses a plugin frame before any dialog opens or any folder is shown", async () => {
    const { service } = await setup({ revealFolder: vi.fn(async () => "/Users/example/market") });
    desktop.showOpenDialog.mockClear();
    desktop.showItemInFolder.mockClear();
    const refused = { ok: false, code: "unauthorized-frame", message: "unauthorized-frame" };
    await expect(invokeAppIpcHandlerFromFrame(handlers, channels.sourcesPickFolder, PLUGIN_FRAME)).resolves.toEqual(refused);
    await expect(invokeAppIpcHandlerFromFrame(handlers, channels.sourcesReveal, PLUGIN_FRAME, "team")).resolves.toEqual(refused);
    expect(desktop.showOpenDialog).not.toHaveBeenCalled();
    expect(desktop.showItemInFolder).not.toHaveBeenCalled();
    expect(service.revealFolder).not.toHaveBeenCalled();
  });

  it("shows only a folder source's folder: a git source and an unknown id are refused and nothing opens", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-git-marketplace-reveal-"));
    const folder = join(mkdtempSync(join(tmpdir(), "ave-git-marketplace-reveal-source-")), "market");
    writeFolderFiles(folder, { "SKILL.md": "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n" });
    const harness = await folderService({ root, folders: nodeFolders() });
    try {
      const preview = await harness.service.previewSource({ input: folder, auth: "none" });
      if (preview.type === "confirm") throw new Error("a local folder needs no confirmation");
      const added = await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
      const git = (await harness.service.listSources()).find((item) => item.transport === "git")!;
      handlers.clear();
      const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
      registerGitMarketplaceHandlers(
        { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: { get: () => ({}) } } as never,
        async () => null,
        async () => ({ service: harness.service as never, close: async () => {} }),
        async () => {},
        root,
        new AbortController(),
      );
      desktop.showItemInFolder.mockClear();

      await expect(invokeFileIpcHandler(handlers, channels.sourcesReveal, git.id)).resolves.toMatchObject({ ok: false, code: "invalid-request" });
      await expect(invokeFileIpcHandler(handlers, channels.sourcesReveal, "nowhere")).resolves.toMatchObject({ ok: false, code: "SOURCE_ID_INVALID" });
      await expect(invokeFileIpcHandler(handlers, channels.sourcesReveal, added.path)).resolves.toMatchObject({ ok: false });
      expect(desktop.showItemInFolder).not.toHaveBeenCalled();

      await expect(invokeFileIpcHandler(handlers, channels.sourcesReveal, "notes")).resolves.toEqual({ ok: true, value: null });
      expect(desktop.showItemInFolder).toHaveBeenCalledExactlyOnceWith(added.path);
    } finally {
      harness.service.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(join(folder, ".."), { recursive: true, force: true });
    }
  });

  it("refuses to show a folder on a drive whose classifier cannot run, with the reinstall advice and nothing opened", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-git-marketplace-reveal-"));
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3" } }).file("C:\\m\\SKILL.md", "---\nname: note\ndescription: d\n---\n");
    const harness = await folderService({ root, folders: { fs: volume, platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
    try {
      const preview = await harness.service.previewSource({ input: "C:\\m", auth: "none" });
      if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
      await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
      volume.queryDosDevice = async () => {
        throw new Error("Windows folder classifier is missing: C:\\Ave\\resources\\windows-path-kind\\x64\\ave-path-kind.exe. Reinstall Ave.");
      };
      handlers.clear();
      const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
      registerGitMarketplaceHandlers(
        { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: { get: () => ({}) } } as never,
        async () => null,
        async () => ({ service: harness.service as never, close: async () => {} }),
        async () => {},
        root,
        new AbortController(),
      );
      desktop.showItemInFolder.mockClear();

      const answer = await invokeFileIpcHandler(handlers, channels.sourcesReveal, "notes");
      expect(answer).toMatchObject({ ok: false, code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "C:\\m" } });
      expect(desktop.showItemInFolder).not.toHaveBeenCalled();
      const parsed = parseGitMarketplaceResult(answer);
      if (parsed.ok) throw new Error("expected a failure");
      expect(failureText((key, vars) => translate("en", key, vars), parsed, ENTRY_SUBJECT)).toBe(
        "Ave cannot tell whether C:\\m is on another computer because its folder classifier is missing or broken. Reinstall Ave.",
      );
    } finally {
      harness.service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
