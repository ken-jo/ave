/**
 * The boot step that builds the alerts pipeline: its predecessor answer comes
 * from the installed packages, the loaded plugins and the revocation feed;
 * its cards go to the live main window; and an uninstall anywhere in the host
 * reaches it through `plugin.uninstalled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAlerts } from "../alerts-setup.js";
import { emitEvent, onEvent } from "../../types.js";
import { revocationRegistry } from "../../../plugins/revocation/revocation-registry.js";
import type { AlertSettings, RetiredPluginConfigRecord } from "../../../shared/alerts-types.js";
import { ALERTS, OVERLAY_V1 } from "../../../shared/ipc-channels.js";
import { scanAndEmitDueSoon, DUE_SOON_EVENT } from "../../../work-board/due-soon.js";
import { createDirStorage } from "../../../work-board/storage.js";
import { openFeatureNamespace } from "../../../main/storage/feature-namespace.js";
import type { WorkItemResolved } from "../../../shared/work-board-types.js";
import type { BootContext } from "../../context.js";
import { withAllPluginInstallLocks, withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import { PluginMarketplaceService } from "../../../plugins/marketplace.js";
import { resolvePluginPaths } from "../../../plugins/plugin-paths.js";
import { readPluginRegistry } from "../../../plugins/registry.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";

const kinds = [
  {
    id: "reply",
    label: { en: "Mail needing a reply" },
    defaultEnabled: true,
    visibility: "user-visible",
    summary: { en: "A mail" },
    prompt: { en: "Help me answer." },
    inherits: [{
      pluginId: "retiredfixture",
      sourceId: "ave",
      enabled: { key: "disabledDetectors", listed: "disabled", values: ["reply"] },
    }],
  },
];

type Row = { name: string; version: string | null; sourceId: string | null; originCommit: string | null };

let home: string;
let previousHome: string | undefined;
let settings: AlertSettings;
let records: Record<string, RetiredPluginConfigRecord>;
let installed: Row[];
let loaded: string[];
const disposers: Array<() => void> = [];

function context() {
  const send = vi.fn();
  const touchSessionTranscript = vi.fn();
  const config: Record<string, Record<string, unknown>> = {};
  const listeners = new Map<string, Set<() => void>>();
  const ctx = {
    settingsService: {
      get: vi.fn((key: string) => structuredClone(key === "alerts" ? settings : records)),
      set: vi.fn(async (key: string, next: never) => {
        if (key === "alerts") settings = structuredClone(next); else records = structuredClone(next);
        for (const listener of listeners.get(key) ?? []) listener();
      }),
      onChanged: vi.fn((key: string, listener: () => void) => {
        const set = listeners.get(key) ?? new Set(); listeners.set(key, set); set.add(listener);
        return () => set.delete(listener);
      }),
      getPluginConfig: vi.fn((id: string) => structuredClone(config[id] ?? {})),
      setPluginConfig: vi.fn(async (id: string, next: Record<string, unknown>) => { config[id] = structuredClone(next); }),
    },
    pluginPaths: resolvePluginPaths({ pluginsRoot: join(home, "plugins") }),
    pluginMarketplace: { listInstalledPackages: vi.fn(async () => installed) },
    pluginRuntime: { listPluginIds: vi.fn(() => loaded), setConfigOverride: vi.fn(), restartPlugin: vi.fn(async () => "started") },
    bootAuditLogger: { log: vi.fn() },
    notificationService: { isFocusGateActive: () => false, fire: vi.fn() },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
    memoryManager: { touchSessionTranscript },
  } as unknown as BootContext;
  return { ctx, send, touchSessionTranscript };
}

async function raiseReply(ctx: BootContext) {
  await ctx.alertsService.register("fixturemail", { alerts: { reasoning: "Mail.", kinds } } as never);
  return ctx.alertsService.raise("fixturemail", { kind: "reply", key: "mail-1" });
}

beforeEach(() => {
  previousHome = process.env.AVE_HOME;
  home = mkdtempSync(join(tmpdir(), "ave-alerts-setup-"));
  process.env.AVE_HOME = home;
  settings = { osNotificationsEnabled: true, kinds: {} };
  records = {};
  installed = [];
  loaded = [];
  revocationRegistry.replace([]);
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  revocationRegistry.resetForTesting();
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("setupAlerts", () => {
  it.each(["plugin", "all"] as const)("lets a callback raise while external migration encounters its %s lifecycle lock", async (scope) => {
    const { ctx } = context();
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    disposers.push(await setupAlerts(ctx));
    await ctx.alertsService.register("fixturemail", { alerts: { reasoning: "Mail.", kinds },
      configInherits: [{ pluginId: "retiredfixture", from: "senders", to: "allowed" }],
    } as never);
    let release!: () => void;
    let enter!: () => void;
    let raise!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const raiseRequested = new Promise<void>((resolve) => { raise = resolve; });
    let raised = false;
    const callback = async () => {
      enter();
      await raiseRequested;
      // The external release also bounds failure cleanup when the regression returns.
      await Promise.race([ctx.alertsService.raise("fixturemail", { kind: "reply", key: "startup" }).then(() => { raised = true; }), released]);
      await released;
    };
    const lifecycle = scope === "all" ? withAllPluginInstallLocks(callback) : withPluginInstallLock("fixturemail", callback);
    await entered;
    records = { retiredfixture: { config: { senders: ["original"] }, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "fixturemail" }], hostKinds: [] }, consumedBy: [],
    } };
    const readConfig = vi.mocked(ctx.settingsService.getPluginConfig);
    const readCount = readConfig.mock.calls.length;
    const reconcile = ctx.alertsService.reconcileMigration();
    // Let external reconciliation reach config acquisition before requesting the callback.
    await new Promise<void>((resolve) => setImmediate(resolve));
    raise();
    try {
      await vi.waitFor(() => expect(raised).toBe(true), { timeout: 500 });
    } finally {
      release();
      await lifecycle;
      await reconcile;
      await vi.waitFor(() => expect(ctx.settingsService.getPluginConfig("fixturemail")).toEqual({ allowed: ["original"] }));
      await ctx.alertsService.flush();
    }
    expect(readConfig.mock.calls.length).toBeGreaterThan(readCount);
    expect(records).toEqual({});
  }, 3_000);

  it("retains a consumed retirement while the raw registry has a pending replacement", async () => {
    const { ctx } = context();
    mkdirSync(ctx.pluginPaths.pluginsRoot, { recursive: true });
    writeFileSync(ctx.pluginPaths.registryPath, JSON.stringify({ version: 1, plugins: [{
      id: "retiredfixture", manifestPath: "retiredfixture/plugin.json", installSource: "user",
      pendingUpdate: { kind: "marketplace", previousManifestFileSha256: null, previousReceiptRaw: null },
    }] }));
    ctx.pluginMarketplace = new PluginMarketplaceService(ctx.pluginPaths);
    expect(await ctx.pluginMarketplace.listInstalledPackages()).toEqual([]);
    records = { retiredfixture: { config: {}, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "fixturemail" }], hostKinds: [] }, consumedBy: ["fixturemail"],
    } };
    disposers.push(await setupAlerts(ctx));
    await ctx.alertsService.flush();
    expect((await readPluginRegistry(ctx.pluginPaths.registryPath)).plugins.map((entry) => entry.id)).toEqual(["retiredfixture"]);
    expect(records.retiredfixture?.consumedBy).toEqual(["fixturemail"]);
    writeFileSync(ctx.pluginPaths.registryPath, JSON.stringify({ version: 1, plugins: [] }));
    await ctx.alertsService.reconcileMigration();
    expect(records).toEqual({});
  });

  it("rechecks generation ownership after config lock admission", async () => {
    const { ctx } = context();
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    disposers.push(await setupAlerts(ctx));
    records = { retiredfixture: { config: { senders: ["original"] }, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "fixturemail" }], hostKinds: [] }, consumedBy: [],
    } };
    let current = true;
    // Lose readiness during the locked read, before the durable write begins.
    vi.mocked(ctx.settingsService.getPluginConfig).mockImplementationOnce(() => {
      current = false;
      return {};
    });
    await ctx.alertsService.register("fixturemail", { configInherits: [
      { pluginId: "retiredfixture", from: "senders", to: "allowed" },
    ] }, () => current);
    expect(ctx.settingsService.setPluginConfig).not.toHaveBeenCalled();
    expect(ctx.pluginRuntime.setConfigOverride).not.toHaveBeenCalled();
    expect(records.retiredfixture?.consumedBy).toEqual([]);
    await ctx.alertsService.flush();
  });

  it.each([false, true])("retries deferred config after lock release using the current generation (superseded=%s)", async (superseded) => {
    const { ctx } = context();
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    disposers.push(await setupAlerts(ctx));
    const registration = ctx.alertsService.prepareRegistration("fixturemail", { configInherits: [
      { pluginId: "retiredfixture", from: "senders", to: "allowed" },
    ] });
    await registration.publish();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = withPluginInstallLock("fixturemail", async () => { entered(); await released; });
    await held;
    records = { retiredfixture: { config: { senders: ["original"] }, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "fixturemail" }], hostKinds: [] }, consumedBy: [],
    } };
    try {
      await ctx.alertsService.reconcileMigration();
      expect(ctx.settingsService.setPluginConfig).not.toHaveBeenCalled();
      expect(records.retiredfixture?.consumedBy).toEqual([]);
      if (superseded) {
        registration.unpublish();
        await ctx.alertsService.register("fixturemail", {});
      }
    } finally {
      release();
      await lifecycle;
      // Queued after the deferred retry: drain it without another reconciliation.
      await withPluginInstallLock("fixturemail", async () => {});
    }
    expect(ctx.settingsService.getPluginConfig("fixturemail")).toEqual(superseded ? {} : { allowed: ["original"] });
    if (superseded) expect(records.retiredfixture?.consumedBy).toEqual([]);
    else expect(records).toEqual({});
    await ctx.alertsService.flush();
  }, 2_000);

  it("keeps consent committed when the Settings notification cannot reach the window", async () => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    send.mockImplementation(() => { throw new Error("window destroyed"); });
    await expect(ctx.alertsService.setKind("@host:due-soon", { enabled: true })).resolves.not.toHaveProperty("error");
    expect(settings.kinds["@host:due-soon"]).toMatchObject({ enabled: true, seenByUser: true });
    expect(send).toHaveBeenLastCalledWith(ALERTS.kindsChanged);
    await ctx.alertsService.flush();
  });

  it.each(["disable", "uninstall"] as const)("finishes every revoked card after a failed dismissal on a %s feed", async (action) => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    const withdrawn: unknown[] = [];
    disposers.push(onEvent("alert.withdrawn", (event) => { withdrawn.push(event); }));
    await ctx.alertsService.register("fixturemail", {
      alerts: { reasoning: "Mail.", kinds: [kinds[0], { ...kinds[0], id: "extra" }] },
    } as never);
    await ctx.alertsService.register("safeplugin", { alerts: { reasoning: "Mail.", kinds } } as never);
    const first = await ctx.alertsService.raise("fixturemail", { kind: "reply", key: "one" });
    const second = await ctx.alertsService.raise("fixturemail", { kind: "extra", key: "two" });
    const safe = await ctx.alertsService.raise("safeplugin", { kind: "reply", key: "safe" });
    expect([first.status, second.status, safe.status]).toEqual(["raised", "raised", "raised"]);
    const ids = [first, second].map((result) => (result as { alertId: string }).alertId);
    const safeId = (safe as { alertId: string }).alertId;
    installed = ["fixturemail", "safeplugin"].map((name) => ({ name, version: "1.0.0", sourceId: "ave", originCommit: null }));
    loaded = ["fixturemail", "safeplugin"];
    send.mockClear();
    send.mockImplementationOnce(() => { throw new Error("window destroyed during dismissal"); });
    const rule = { sourceId: "ave", kind: "plugin" as const, name: "fixturemail", versions: "*", reason: "revoked", at: "2026-09-01", action };
    revocationRegistry.replace([rule]);
    await vi.waitFor(() => expect(ctx.alertsService.listOpen().map((card) => card.source.alertId)).toEqual([safeId]));
    expect(send.mock.calls).toEqual([...ids.map((id) => [OVERLAY_V1.dismiss, `alert:${id}`]), [ALERTS.kindsChanged]]);
    expect(withdrawn).toEqual(ids.map((alertId, index) => ({
      pluginId: "fixturemail", kind: index === 0 ? "reply" : "extra", alertId, reason: "withdrawn",
    })));
    await ctx.alertsService.flush();
    const persisted = JSON.parse(readFileSync(join(home, "alerts", "open.json"), "utf8"));
    expect(persisted.open.map((entry: { alertId: string }) => entry.alertId)).toEqual([safeId]);
    expect(persisted.closed).toEqual([]);
    expect(settings.kinds["fixturemail:reply"]).toMatchObject({ enabled: true });
    expect(settings.kinds["fixturemail:reply"]?.absentSinceAppVersion).toBeUndefined();

    expect(revocationRegistry.replace([rule])).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.alertsService.pluginUninstalled("fixturemail");
    expect(ctx.alertsService.listOpen().map((card) => card.source.alertId)).toEqual([safeId]);
    expect(withdrawn).toHaveLength(2);
    expect(send.mock.calls.filter(([channel]) => channel === OVERLAY_V1.dismiss)).toHaveLength(2);
    expect((await ctx.alertsService.raise("safeplugin", { kind: "reply", key: "safe" })).status).toBe("refreshed");
    await ctx.alertsService.flush();
  });

  it("keeps a queued acceptance when the live window send throws once", async () => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    send.mockImplementation((channel) => {
      if (channel === OVERLAY_V1.show) {
        send.mockImplementation(() => undefined);
        throw new Error("window destroyed");
      }
    });
    const result = await raiseReply(ctx);
    expect(result).toMatchObject({ status: "raised", delivered: { card: true } });
    const { alertId } = result as { alertId: string };
    expect(ctx.alertsService.listOpen()).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ alertId }) }),
    ]);
    expect(await ctx.alertsService.raise("fixturemail", { kind: "reply", key: "mail-1" })).toEqual({ status: "refreshed", alertId });
    expect(send).toHaveBeenLastCalledWith(OVERLAY_V1.show, expect.objectContaining({ source: expect.objectContaining({ alertId }) }));
    expect(await ctx.alertsService.raise("fixturemail", { kind: "reply", key: "mail-2" })).toEqual({ status: "cooldown" });
    await ctx.alertsService.flush();
  });

  it("ignores an older installed-package read after a newer reconciliation finishes", async () => {
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    await raiseReply(ctx);
    const read = vi.mocked(ctx.pluginMarketplace.listInstalledPackages);
    let release!: (rows: never[]) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    revocationRegistry.replace([]);
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    revocationRegistry.replace([{ sourceId: "ave", kind: "plugin", name: "fixturemail", versions: "*", reason: "revoked", at: "2026-09-01", action: "disable" }]);
    await vi.waitFor(() => expect(ctx.alertsService.listOpen()).toEqual([]));
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await ctx.alertsService.raise("fixturemail", { kind: "reply", key: "new" })).toEqual({ status: "kind_not_granted", kind: "reply" });
    await ctx.alertsService.flush();
  });

  it.each(["disable", "uninstall"] as const)("withdraws cards on a %s feed while the plugin remains installed and loaded", async (action) => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    const result = await raiseReply(ctx);
    expect(result.status).toBe("raised");
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    loaded = ["fixturemail"];
    revocationRegistry.replace([{
      sourceId: "ave", kind: "plugin", name: "fixturemail", versions: "*", reason: "revoked", at: "2026-09-01", action,
    }]);
    await vi.waitFor(() => expect(ctx.alertsService.listOpen()).toEqual([]));
    expect(send).toHaveBeenCalledWith(OVERLAY_V1.dismiss, expect.any(String));
    expect(settings.kinds["fixturemail:reply"]?.absentSinceAppVersion).toBeUndefined();
    expect(settings.kinds["fixturemail:reply"]?.enabled).toBe(true);
    expect(await ctx.alertsService.raise("fixturemail", { kind: "reply", key: "another" })).toEqual({ status: "kind_not_granted", kind: "reply" });
    await ctx.alertsService.flush();
  });

  it("rechecks installed versions even when the feed rules do not change", async () => {
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    await raiseReply(ctx);
    const rule = { sourceId: "ave", kind: "plugin" as const, name: "fixturemail", versions: "1.0.0", reason: "revoked", at: "2026-09-01", action: "disable" as const };
    revocationRegistry.replace([rule]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.alertsService.listOpen()).toHaveLength(1);
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    expect(revocationRegistry.replace([rule])).toBe(false);
    await vi.waitFor(() => expect(ctx.alertsService.listOpen()).toEqual([]));
    await ctx.alertsService.flush();
  });

  it("hears installed registry changes and releases the feed subscription on disposal", async () => {
    const { ctx } = context();
    const dispose = await setupAlerts(ctx);
    await raiseReply(ctx);
    revocationRegistry.replace([{ sourceId: "ave", kind: "plugin", name: "fixturemail", versions: "*", reason: "revoked", at: "2026-09-01", action: "disable" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
    emitEvent("plugin.installed", { pluginId: "fixturemail" });
    await vi.waitFor(() => expect(ctx.alertsService.listOpen()).toEqual([]));
    dispose();
    const reads = vi.mocked(ctx.pluginMarketplace.listInstalledPackages).mock.calls.length;
    revocationRegistry.replace([]);
    emitEvent("plugin.installed", { pluginId: "fixturemail" });
    expect(vi.mocked(ctx.pluginMarketplace.listInstalledPackages).mock.calls).toHaveLength(reads);
    await ctx.alertsService.flush();
  });

  it("delivers the host deadline through the pipeline with no plugin and still emits the board event", async () => {
    const { ctx, send, touchSessionTranscript } = context();
    disposers.push(await setupAlerts(ctx));
    const now = Date.now();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    const item: WorkItemResolved = {
      id: 7, title: "Finish report", status: "planned", status_resolved: "planned", priority: "medium",
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), due_at: dueAt,
    };
    const store = { list: async () => ({ status: "ok" as const, items: [item] }) };
    const storage = createDirStorage(openFeatureNamespace("work-board").dir);
    const emit = vi.fn();
    const raise = (input: Parameters<typeof ctx.alertsService.raise>[1]) => ctx.alertsService.raise("@host", input);
    await scanAndEmitDueSoon(store, storage, emit, now, raise);
    expect(ctx.alertsService.listOpen()).toEqual([]);
    expect(emit).toHaveBeenCalledWith(DUE_SOON_EVENT, { itemId: 7, title: "Finish report", notifiedAt: new Date(now).toISOString() });
    await ctx.alertsService.setKind("@host:due-soon", { enabled: true });
    await scanAndEmitDueSoon(store, storage, emit, now + 1, raise);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(ctx.alertsService.listOpen()[0]?.source.pluginId).toBe("@host");
    expect(send).toHaveBeenCalledWith(ALERTS.kindsChanged);
    expect(send).toHaveBeenCalledWith(OVERLAY_V1.show, expect.objectContaining({ source: expect.objectContaining({ pluginId: "@host" }) }));
    // The card is addressed to the dedicated Suggestions conversation, which
    // exists (and rose in the list) before the card went out.
    expect(touchSessionTranscript).toHaveBeenCalledWith(SUGGESTIONS_SESSION_ID, { bump: true });
    await ctx.alertsService.flush();
  });
  it("blocks a successor while its predecessor from the hinted source is installed and not revoked", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect(await raiseReply(ctx)).toEqual({ status: "blocked_by_predecessor", pluginId: "retiredfixture" });
    await ctx.alertsService.flush();
  });

  it("stops blocking once the installed predecessor is revoked and not loaded", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    revocationRegistry.replace([{
      sourceId: "ave", kind: "plugin", name: "retiredfixture", versions: "*", reason: "retired", at: "2026-09-01", action: "uninstall",
    }]);
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("raised");
    expect(send).toHaveBeenCalledWith(OVERLAY_V1.show, expect.objectContaining({ source: expect.objectContaining({ kind: "alert" }) }));
    await ctx.alertsService.flush();
  });

  it("keeps blocking while a revoked predecessor is still loaded", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "ave", originCommit: null }];
    loaded = ["retiredfixture"];
    revocationRegistry.replace([{
      sourceId: "ave", kind: "plugin", name: "retiredfixture", versions: "*", reason: "retired", at: "2026-09-01", action: "uninstall",
    }]);
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("blocked_by_predecessor");
    await ctx.alertsService.flush();
  });

  it("ignores a same-named package from an unrelated source", async () => {
    installed = [{ name: "retiredfixture", version: "1.0.0", sourceId: "elsewhere", originCommit: null }];
    const { ctx } = context();
    disposers.push(await setupAlerts(ctx));
    expect((await raiseReply(ctx)).status).toBe("raised");
    await ctx.alertsService.flush();
  });

  it("hears an uninstall on the host bus: the plugin's cards go and its choices are kept absent", async () => {
    const { ctx, send } = context();
    disposers.push(await setupAlerts(ctx));
    const { alertId } = (await raiseReply(ctx)) as { alertId: string };
    emitEvent("plugin.uninstalled", { pluginId: "fixturemail" });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(OVERLAY_V1.dismiss, `alert:${alertId}`);
      expect(settings.kinds["fixturemail:reply"]?.absentSinceAppVersion).toBeDefined();
    });
    await ctx.alertsService.flush();
  });
});

it.each([true, false])("migrates a newly persisted retirement and detaches its restart (outer lock=%s)", async (outerLock) => {
  const { withPluginInstallLock, isPluginInstallLockHeld } = await import("../../../plugins/install-lifecycle.js");
  const { subscribePluginConfigChange } = await import("../../../plugins/config-change-bus.js");
  const { ctx } = context();
  installed = [{ name: "fixturemail", version: "1.0.0", sourceId: "ave", originCommit: null }];
  disposers.push(await setupAlerts(ctx));
  const changes = vi.fn();
  disposers.push(subscribePluginConfigChange("fixturemail", "*", changes));
  const restartLockContexts: boolean[] = [];
  vi.mocked(ctx.pluginRuntime.restartPlugin).mockImplementation(async () => {
    restartLockContexts.push(isPluginInstallLockHeld("fixturemail"));
    return "started";
  });
  await ctx.settingsService.setPluginConfig("fixturemail", { saved: "mine" });
  const writeLockContexts: boolean[] = [];
  const saveConfig = vi.mocked(ctx.settingsService.setPluginConfig).getMockImplementation()!;
  vi.mocked(ctx.settingsService.setPluginConfig).mockImplementation(async (id, next) => {
    writeLockContexts.push(isPluginInstallLockHeld(id));
    return await saveConfig(id, next);
  });
  const declarations = { alerts: { reasoning: "Mail.", kinds }, configInherits: [
    { pluginId: "retiredfixture", from: "senders", to: "senders" },
    { pluginId: "retiredfixture", value: "legacy", to: "saved" },
    { pluginId: "retiredfixture", from: "missing", to: "absent" },
  ] };
  await ctx.alertsService.register("fixturemail", declarations as never);
  const writeRecord = async () => {
    await ctx.settingsService.set("retiredPluginConfigs", { retiredfixture: {
      config: { disabledDetectors: [], senders: ["example.test"] }, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "fixturemail" }], hostKinds: [] }, consumedBy: [],
    } });
    await ctx.alertsService.flush();
    await vi.waitFor(() => expect(ctx.pluginRuntime.restartPlugin).toHaveBeenCalledTimes(1));
  };
  if (outerLock) await withPluginInstallLock("fixturemail", writeRecord); else await writeRecord();
  expect(restartLockContexts).toEqual([false]);
  expect(writeLockContexts).toEqual([true]);
  expect(ctx.settingsService.getPluginConfig("fixturemail")).toEqual({ saved: "mine", senders: ["example.test"] });
  expect(ctx.pluginRuntime.setConfigOverride).toHaveBeenCalledWith("fixturemail", { saved: "mine", senders: ["example.test"] });
  expect(changes.mock.calls).toEqual([["senders", ["example.test"]]]);
  expect(settings.kinds["fixturemail:reply"]!.enabled).toBe(true);
  expect(records).toEqual({});
  await ctx.alertsService.flush();
});

it("retries pending host mappings on choice registration and releases both settings observers", async () => {
  const { ctx } = context();
  records = { retiredfixture: { config: {}, enabled: true, sourceId: "ave", retiredAtAppVersion: "0.12.0",
    successors: { plugins: [], hostKinds: [{ kind: "@host:future-kind", enabled: { key: "disabled", listed: "disabled", values: ["due"] } }] }, consumedBy: [],
  } };
  const dispose = await setupAlerts(ctx); disposers.push(dispose); await ctx.alertsService.flush();
  expect(records.retiredfixture).toBeDefined();
  await ctx.settingsService.set("alerts", { osNotificationsEnabled: true, kinds: {
    "@host:future-kind": { enabled: false, osNotification: false, visibility: "user-visible", seenByUser: false },
  } });
  await ctx.alertsService.flush();
  expect(settings.kinds["@host:future-kind"]!.enabled).toBe(true);
  expect(records).toEqual({});
  dispose(); await ctx.alertsService.flush();
  const reconcile = vi.spyOn(ctx.alertsService, "reconcileMigration");
  await ctx.settingsService.set("retiredPluginConfigs", {});
  await ctx.settingsService.set("alerts", settings);
  expect(reconcile).not.toHaveBeenCalled();
});
