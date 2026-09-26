import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AlertsService } from "../service.js";
import { inheritedConfig } from "../migration.js";
import type { AlertKindDeclaration, PluginManifest } from "../../plugins/public-contract.js";
import type { AlertSettings, RetiredPluginConfigRecord } from "../../shared/alerts-types.js";
import { sanitizePluginConfig, type PluginConfigRecord } from "../../shared/plugin-config.js";
import { PluginUninstallCleanupJournal } from "../../plugins/plugin-uninstall-cleanup-journal.js";

const PLUGIN = "successor";
const PREDECESSOR = "retiredfixture";
const KEY = "successor:reply";
const kind = (overrides: Partial<AlertKindDeclaration> = {}): AlertKindDeclaration => ({
  id: "reply", label: { en: "Reply" }, defaultEnabled: false, visibility: "summary-only",
  summary: { en: "Reply" }, prompt: { en: "Review" },
  osNotification: { defaultEnabled: false, body: { en: "Review mail" } },
  inherits: [{ pluginId: PREDECESSOR, sourceId: "trusted", enabled: { key: "disabled", listed: "disabled", values: ["reply", "legacy-reply"] },
    osNotification: { key: "notifications", listed: "enabled", values: ["reply"], masterKey: "master" } }],
  ...overrides,
});
const manifest = (kinds: AlertKindDeclaration[] = [kind()], configInherits?: PluginManifest["configInherits"]): Pick<PluginManifest, "alerts" | "configInherits"> => ({
  alerts: { reasoning: "Mail alerts", kinds }, ...(configInherits ? { configInherits } : {}),
});
const retirement = (overrides: Partial<RetiredPluginConfigRecord> = {}): RetiredPluginConfigRecord => ({
  config: { disabled: [], notifications: ["reply"], master: true, senders: ["example.test"] }, enabled: true,
  sourceId: "trusted", retiredAtAppVersion: "0.12.0", successors: { plugins: [{ pluginId: PLUGIN }], hostKinds: [] }, consumedBy: [], ...overrides,
});

let dir: string;
const services: AlertsService[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "alerts-migration-")); });
afterEach(async () => {
  for (const service of services.splice(0)) { service.stop(); await service.flush(); }
  await rm(dir, { recursive: true, force: true });
});

async function harness() {
  let settings: AlertSettings = { osNotificationsEnabled: true, kinds: {} };
  let records: Record<string, RetiredPluginConfigRecord> = {};
  const configs: Record<string, PluginConfigRecord> = {};
  const installed = [{ pluginId: PLUGIN, sourceId: "trusted" as string | null }];
  const blocked = new Set<string>();
  const journal = new PluginUninstallCleanupJournal(join(dir, "journal.json"));
  journal.prepare({ pluginId: PREDECESSOR, installPluginId: PREDECESSOR, secretKeys: [], authPartitions: [], cleanupCache: false });
  const warn = vi.fn();
  const restart = vi.fn();
  const writes: string[] = [];
  let failConsumption = false;
  let failChoices = false;
  const applyConfig = vi.fn(async (pluginId: string, entries: NonNullable<PluginManifest["configInherits"]>, source: PluginConfigRecord) => {
    const next = inheritedConfig(configs[pluginId] ?? {}, entries, source);
    if (!next) return false;
    configs[pluginId] = next; writes.push("config"); return true;
  });
  const service = new AlertsService({
    dir: () => dir, settings: {
      get: () => structuredClone(settings),
      set: async (next) => {
        if (failChoices) throw new Error("choice write failed");
        await Promise.resolve();
        settings = structuredClone(next); writes.push("choices");
      },
    },
    migration: {
      records: { get: () => structuredClone(records), set: async (next) => {
        if (failConsumption) throw new Error("consumption write failed");
        records = structuredClone(next); writes.push("records");
      } },
      installed: async () => installed,
      hasPendingCleanup: (id) => journal.has(id),
      applyConfig, configApplied: restart, warn,
    },
    installedPluginIds: async () => installed.map((entry) => entry.pluginId),
    predecessorBlocks: async (id) => blocked.has(id),
    appVersion: "0.14.0", locale: () => "en", overlay: { show: vi.fn(), dismiss: vi.fn() },
    notifications: { isFocusGateActive: () => false, fire: vi.fn() }, emit: vi.fn(), audit: vi.fn(),
  });
  services.push(service); await service.load();
  return { service, installed, blocked, configs, warn, restart, writes, journal, applyConfig,
    get settings() { return settings; }, get records() { return records; },
    put: (record = retirement(), id = PREDECESSOR) => { records[id] = structuredClone(record); },
    failConsumption: (value: boolean) => { failConsumption = value; },
    failChoices: (value: boolean) => { failChoices = value; },
  };
}

describe("retirement inheritance and binding", () => {
  it("keeps an old non-inheriting version pending and inherits when a later version declares the mapping", async () => {
    const h = await harness();
    await h.service.register(PLUGIN, manifest([kind({ inherits: undefined })]));
    h.put(); await h.service.reconcileMigration();
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
    expect(h.settings.kinds[KEY]!.enabled).toBe(false);
    await h.service.register(PLUGIN, manifest());
    expect(h.settings.kinds[KEY]).toMatchObject({ enabled: true, osNotification: true, seenByUser: false });
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  });

  it.each([
    [{ disabled: ["legacy-reply"], notifications: ["reply"] }, false, true],
    [{ disabled: [], notifications: ["reply"], master: false }, true, false],
    [{ disabled: [], notifications: [] }, true, false],
  ] as const)("resolves list spellings and the master switch", async (config, enabled, osNotification) => {
    const h = await harness(); h.put(retirement({ config: sanitizePluginConfig(config) }));
    await h.service.register(PLUGIN, manifest());
    expect(h.settings.kinds[KEY]).toMatchObject({ enabled, osNotification });
  });

  it.each(["visited", "repaired", "escalated"] as const)("preserves a %s entry and counts it as terminal", async (state) => {
    const h = await harness();
    await h.service.register(PLUGIN, manifest());
    Object.assign(h.settings.kinds[KEY]!, state === "visited" ? { seenByUser: true } : { [state]: true });
    h.put(); await h.service.reconcileMigration();
    expect(h.settings.kinds[KEY]!.enabled).toBe(false);
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  });

  it("does not let inheritance undo visibility escalation", async () => {
    const h = await harness(); await h.service.register(PLUGIN, manifest()); h.put();
    await h.service.register(PLUGIN, manifest([kind({ visibility: "user-visible" })]));
    expect(h.settings.kinds[KEY]).toMatchObject({ enabled: false, escalated: true, visibility: "user-visible" });
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  });

  it("persists config while kinds are blocked, then consumes only after inheritance becomes durable", async () => {
    const h = await harness(); h.blocked.add(PREDECESSOR); h.put();
    await h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, from: "senders", to: "allowed" }]));
    expect(h.configs[PLUGIN]).toEqual({ allowed: ["example.test"] });
    expect(h.restart).toHaveBeenCalledOnce();
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
    expect(h.settings.kinds[KEY]!.enabled).toBe(false);
    h.blocked.clear(); await h.service.reconcileMigration();
    expect(h.settings.kinds[KEY]!.enabled).toBe(true);
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
    expect(h.restart).toHaveBeenCalledOnce();
    expect(h.writes.at(-1)).toBe("records");
  });

  it("scopes terminal kinds to each predecessor", async () => {
    const h = await harness(); h.put(); h.blocked.add("otherfixture");
    const other = kind({ id: "other", inherits: [{ ...kind().inherits![0]!, pluginId: "otherfixture" }] });
    await h.service.register(PLUGIN, manifest([kind(), other]));
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
    expect(h.settings.kinds["successor:other"]!.enabled).toBe(false);
  });

  it.each([false, true])("treats disabled record config and kinds as terminal skips (constant=%s)", async (constant) => {
    const h = await harness(); h.put(retirement({ enabled: false }));
    await h.service.register(PLUGIN, manifest(undefined, [constant ? { pluginId: PREDECESSOR, to: "enabled", value: true } : { pluginId: PREDECESSOR, to: "allowed", from: "senders" }]));
    expect(h.configs[PLUGIN]).toBeUndefined(); expect(h.settings.kinds[KEY]!.enabled).toBe(false);
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  });

  it("fills only unset config keys, skips missing source keys, and consumes config-only declarations", async () => {
    const h = await harness(); h.put(); h.configs[PLUGIN] = { keep: false };
    await h.service.register(PLUGIN, { configInherits: [
      { pluginId: PREDECESSOR, to: "keep", value: true },
      { pluginId: PREDECESSOR, to: "missing", from: "absent" },
      { pluginId: PREDECESSOR, to: "added", value: true },
    ] });
    expect(h.configs[PLUGIN]).toStrictEqual({ keep: false, added: true });
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  });

  it.each(["unnamed", "foreign", "unbound"] as const)("refuses %s successor authorization and warns without config disclosure", async (mode) => {
    const h = await harness();
    h.put(mode === "unnamed" ? retirement({ successors: { plugins: [], hostKinds: [] } }) : retirement());
    if (mode === "foreign") h.installed[0]!.sourceId = "foreign";
    if (mode === "unbound") h.installed[0]!.sourceId = null;
    await h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, to: "allowed", from: "senders" }]));
    expect(h.settings.kinds[KEY]!.enabled).toBe(false); expect(h.configs[PLUGIN]).toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("does not authorize"));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("example.test");
  });

  it("allows any-source toggle inheritance but refuses its config entries with a warning", async () => {
    const h = await harness(); h.installed[0]!.sourceId = "foreign";
    h.put(retirement({ successors: { plugins: [{ pluginId: PLUGIN, anySource: true }], hostKinds: [] } }));
    await h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, to: "constant", value: true }]));
    expect(h.settings.kinds[KEY]!.enabled).toBe(true); expect(h.configs[PLUGIN]).toBeUndefined();
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("toggles only"));
  });

  it.each(["kinds-first", "config-first"] as const)("binds consumption to the first ready version (%s)", async (order) => {
    const h = await harness(); h.put();
    const config = [{ pluginId: PREDECESSOR, to: "allowed", from: "senders" }];
    await h.service.register(PLUGIN, order === "kinds-first" ? manifest() : { configInherits: config });
    h.put(retirement({ consumedBy: [PLUGIN], config: { disabled: ["reply"], senders: ["changed.test"] } }));
    await h.service.register(PLUGIN, manifest(undefined, config));
    if (order === "kinds-first") { expect(h.settings.kinds[KEY]!.enabled).toBe(true); expect(h.configs[PLUGIN]).toBeUndefined(); }
    else { expect(h.settings.kinds[KEY]!.enabled).toBe(false); expect(h.configs[PLUGIN]).toEqual({ allowed: ["example.test"] }); }
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("already consumed"));
  });

  it("retries idempotently after the consumption write fails", async () => {
    const h = await harness(); h.put(); h.failConsumption(true);
    await expect(h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, to: "allowed", from: "senders" }]))).rejects.toThrow("consumption write failed");
    expect(h.settings.kinds[KEY]!.enabled).toBe(true); expect(h.configs[PLUGIN]).toEqual({ allowed: ["example.test"] });
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
    h.failConsumption(false); await h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, to: "allowed", from: "senders" }]));
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]); expect(h.restart).toHaveBeenCalledOnce();
  });

  it("does not consume after a failed kind write", async () => {
    const h = await harness(); await h.service.register(PLUGIN, manifest()); h.put(); h.failChoices(true);
    await expect(h.service.reconcileMigration()).rejects.toThrow("choice write failed");
    expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
    h.failChoices(false); await h.service.reconcileMigration(); expect(h.settings.kinds[KEY]!.enabled).toBe(true);
  });
});

describe("retirement record retention", () => {
  it("requires all successors, absent predecessor, and no journal record before removal", async () => {
    const h = await harness(); h.put(retirement({ successors: { plugins: [{ pluginId: PLUGIN }, { pluginId: "later" }], hostKinds: [] } }));
    await h.service.register(PLUGIN, manifest());
    h.journal.complete(PREDECESSOR); await h.service.reconcileMigration(); expect(h.records[PREDECESSOR]).toBeDefined();
    h.installed.push({ pluginId: "later", sourceId: "trusted" }, { pluginId: PREDECESSOR, sourceId: "trusted" });
    await h.service.register("later", manifest()); expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN, "later"]);
    h.installed.pop();
    h.journal.prepare({ pluginId: PREDECESSOR, installPluginId: PREDECESSOR, secretKeys: [], authPartitions: [], cleanupCache: false });
    await h.service.reconcileMigration(); expect(h.records[PREDECESSOR]).toBeDefined();
    await h.service.register(PLUGIN, manifest(undefined, [{ pluginId: PREDECESSOR, to: "late", value: true }]));
    expect(h.configs[PLUGIN]).toBeUndefined();
    h.journal.complete(PREDECESSOR); await h.service.reconcileMigration(); expect(h.records).toEqual({});
    h.warn.mockClear(); await h.service.register(PLUGIN, manifest()); expect(h.warn).not.toHaveBeenCalled();
  });

  it("applies host mappings when a record arrives without a host consumedBy entry", async () => {
    const h = await harness(); h.settings.kinds["@host:due-soon"] = { enabled: false, osNotification: false, visibility: "user-visible", seenByUser: false };
    h.put(retirement({ successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: ["due"] } }] } }));
    h.journal.complete(PREDECESSOR); await h.service.reconcileMigration();
    expect(h.settings.kinds["@host:due-soon"]!.enabled).toBe(true); expect(h.records).toEqual({});
  });

  it("retains a mapping for a host kind whose registration has not arrived", async () => {
    const h = await harness(); h.put(retirement({ successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: ["due"] } }] } }));
    h.journal.complete(PREDECESSOR); await h.service.reconcileMigration(); expect(h.records[PREDECESSOR]).toBeDefined();
  });
});

it("waits for the registering incarnation to become active before consuming", async () => {
  const h = await harness(); h.put();
  let active = false;
  await h.service.register(PLUGIN, manifest(), () => active);
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  expect(h.settings.kinds[KEY]!.enabled).toBe(false);
  active = true;
  await h.service.reconcileMigration();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
  expect(h.settings.kinds[KEY]!.enabled).toBe(true);
});

it("does not consume a failed config write and retries the unset target", async () => {
  const h = await harness(); h.put();
  h.applyConfig.mockRejectedValueOnce(new Error("config write failed"));
  await expect(h.service.register(PLUGIN, manifest([], [{ pluginId: PREDECESSOR, to: "senders", from: "senders" }]))).rejects.toThrow("config write failed");
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  expect(h.restart).not.toHaveBeenCalled();
  await h.service.reconcileMigration();
  expect(h.configs[PLUGIN]).toEqual({ senders: ["example.test"] });
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
});

it.each(["disabled", "visited", "repaired", "escalated"] as const)("preserves %s host choices at record write", async (reason) => {
  const h = await harness();
  h.settings.kinds["@host:due-soon"] = { enabled: false, osNotification: false, visibility: "user-visible", seenByUser: reason === "visited",
    ...(reason === "repaired" ? { repaired: true } : {}), ...(reason === "escalated" ? { escalated: true } : {}) };
  h.put(retirement({ enabled: reason !== "disabled", successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: ["due"] } }] } }));
  await h.service.reconcileMigration();
  expect(h.settings.kinds["@host:due-soon"]!.enabled).toBe(false);
});

it("requires an installed successor and a bound retirement source", async () => {
  const h = await harness(); h.put(retirement({ sourceId: null }));
  await h.service.register(PLUGIN, manifest());
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  h.put(); h.installed.splice(0);
  await h.service.reconcileMigration();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
});

it("keeps simultaneous registrations and their choices in a single mutation lane", async () => {
  const h = await harness();
  h.installed.push({ pluginId: "later", sourceId: "trusted" });
  h.put(retirement({ successors: { plugins: [{ pluginId: PLUGIN }, { pluginId: "later" }], hostKinds: [] } }));
  await Promise.all([h.service.register(PLUGIN, manifest()), h.service.register("later", manifest())]);
  expect(h.settings.kinds[KEY]!.enabled).toBe(true);
  expect(h.settings.kinds["later:reply"]!.enabled).toBe(true);
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN, "later"]);
});

it("does not warn about its own consumption on a later reconciliation", async () => {
  const h = await harness(); h.put();
  await h.service.register(PLUGIN, manifest()); await h.service.reconcileMigration();
  expect(h.warn).not.toHaveBeenCalled();
  await h.service.register(PLUGIN, manifest());
  expect(h.warn).toHaveBeenCalledWith(expect.stringContaining("already consumed"));
});

it("does not bind a successor that retires during its config write", async () => {
  const h = await harness(); h.put(); let active = true;
  h.applyConfig.mockImplementationOnce(async () => { active = false; return true; });
  await h.service.register(PLUGIN, manifest([], [{ pluginId: PREDECESSOR, to: "flag", value: true }]), () => active);
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
});

it("inherits a host notification mapping alongside its enabled choice", async () => {
  const h = await harness();
  h.settings.kinds["@host:due-soon"] = { enabled: false, osNotification: false, visibility: "user-visible", seenByUser: false };
  h.put(retirement({ successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon",
    enabled: { key: "disabled", listed: "disabled", values: ["due"] },
    osNotification: { key: "notifications", listed: "enabled", values: ["reply"] },
  }] } }));
  await h.service.reconcileMigration();
  expect(h.settings.kinds["@host:due-soon"]).toMatchObject({ enabled: true, osNotification: true });
});

it("keeps a prepared generation private and consumes only after publication", async () => {
  const h = await harness(); h.put();
  const candidate = h.service.prepareRegistration(PLUGIN, manifest());
  await h.service.reconcileMigration();
  expect(h.settings.kinds[KEY]).toBeUndefined();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  await candidate.publish();
  expect(h.settings.kinds[KEY]!.enabled).toBe(true);
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
});

it("restores migration declarations on resume and ignores disposal of a superseded generation", async () => {
  const h = await harness(); h.put(); h.blocked.add(PREDECESSOR);
  const original = h.service.prepareRegistration(PLUGIN, manifest());
  await original.publish(); original.unpublish();
  const replacement = h.service.prepareRegistration(PLUGIN, manifest([kind({ inherits: undefined })]));
  await replacement.publish();
  original.unpublish();
  await h.service.reconcileMigration();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  replacement.unpublish(); h.blocked.clear();
  await original.publish(); replacement.unpublish();
  expect(h.settings.kinds[KEY]!.enabled).toBe(true);
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([PLUGIN]);
});

it("cannot consume an unpublished generation when a record arrives later", async () => {
  const h = await harness();
  const registration = h.service.prepareRegistration(PLUGIN, manifest());
  await registration.publish(); registration.unpublish(); h.put();
  await h.service.reconcileMigration();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
  expect(h.settings.kinds[KEY]!.enabled).toBe(false);
});

it("does not consume a generation unpublished during its config write", async () => {
  const h = await harness(); h.put();
  const registration = h.service.prepareRegistration(PLUGIN, manifest([], [{ pluginId: PREDECESSOR, to: "flag", value: true }]));
  h.applyConfig.mockImplementationOnce(async () => { registration.unpublish(); return true; });
  await registration.publish();
  expect(h.records[PREDECESSOR]!.consumedBy).toEqual([]);
});
