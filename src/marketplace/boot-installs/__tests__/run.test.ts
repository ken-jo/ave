import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogRow } from "../../catalog/aggregate.js";
import type { IndexVersion, PackageKind } from "../../catalog/types.js";
import type { InstalledPackage } from "../../resolve/identity.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PackageKey } from "../../sources/policy.js";
import type { SourceOrigin } from "../../sources/registry.js";
import { AppliedDefaults } from "../applied.js";
import { DEFAULT_INSTALLS } from "../default-installs.js";
import { assertNotRequiredByPolicy, bootInstallNoticeFrom, lockedByPolicy, requiredByPolicy, runBootInstalls, type BootInstallInput } from "../run.js";

const AT = new Date("2026-09-23T00:00:00.000Z");

const version = (v: string, minAppVersion = "0.12.0"): IndexVersion => ({ version: v, commit: "c".repeat(40), minAppVersion, publishedAt: AT.toISOString() });

function row(sourceId: string, name: string, choice: CatalogRow["choice"] = { state: "candidate", version: version("1.0.0") }, kind: PackageKind = "plugin"): CatalogRow {
  const versions = choice.state === "candidate" ? [choice.version] : [version("9.0.0", "0.99.0")];
  return { sourceId, sourceOrigin: "official", snapshotCommit: "d".repeat(40), kind, name, package: { kind, name, path: `plugins/${name}`, versions }, choice };
}

const key = (name: string, source = "ave", kind: PackageKind = "plugin"): PackageKey => ({ kind, name, source });

describe("runBootInstalls (design §10.2)", () => {
  let dir: string;
  let file: string;
  let installedState: Map<string, InstalledPackage>;
  let calls: Array<{ name: string; source: string; switchSource: boolean; required: boolean }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-boot-installs-"));
    file = join(dir, "packages", "default-installs.json");
    installedState = new Map();
    calls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(options: {
    policy?: Partial<MarketplacePolicy>;
    rows?: CatalogRow[];
    synced?: Record<string, SourceOrigin>;
    failing?: Set<string>;
    signal?: AbortSignal;
    /** Runs inside each install, before it lands. */
    during?: (name: string) => void;
  } = {}) {
    const input: BootInstallInput = {
      policy: { ...EMPTY_MARKETPLACE_POLICY, ...options.policy },
      defaults: DEFAULT_INSTALLS,
      rows: options.rows ?? [row("ave", "meeting"), row("ave", "local-indexer")],
      synced: new Map(Object.entries(options.synced ?? { ave: "official" })),
      installed: async (_kind, name) => installedState.get(name) ?? null,
      install: async (target, flags) => {
        calls.push({ name: target.name, source: target.sourceId, ...flags });
        options.during?.(target.name);
        if (options.failing?.has(target.name)) throw new Error("network down");
        const choice = target.choice as { version: IndexVersion };
        installedState.set(target.name, { kind: target.kind, name: target.name, version: choice.version.version, sourceId: target.sourceId });
      },
      applied: await AppliedDefaults.open(file),
      now: () => AT,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    return runBootInstalls(input);
  }

  it("lets the install in progress finish when the app shuts down, and judges, installs and records nothing after it", async () => {
    const shutdown = new AbortController();
    const reason = new Error("the update scheduler has stopped");
    await expect(boot({ signal: shutdown.signal, during: () => shutdown.abort(reason) })).rejects.toBe(reason);
    expect(calls.map((call) => call.name)).toEqual(["meeting"]);
    const applied = await AppliedDefaults.open(file);
    // The started install lands with its record; the next default is never reached.
    expect(applied.get(key("meeting"))).toMatchObject({ result: "installed" });
    expect(applied.has(key("local-indexer"))).toBe(false);

    calls = [];
    await expect(boot({ signal: shutdown.signal })).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  it("installs the app's defaults once and never again after the user uninstalls them", async () => {
    const first = await boot();
    expect(first.installed).toEqual([key("meeting"), key("local-indexer")]);
    expect(calls).toEqual([
      { name: "meeting", source: "ave", switchSource: false, required: false },
      { name: "local-indexer", source: "ave", switchSource: false, required: false },
    ]);
    installedState.clear(); // the user uninstalls both
    calls = [];
    const second = await boot();
    expect(second).toEqual({ installed: [], skipped: [], failed: [] });
    expect(calls).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 1,
      applied: [
        { kind: "plugin", name: "meeting", source: "ave", result: "installed" },
        { kind: "plugin", name: "local-indexer", source: "ave", result: "installed" },
      ],
    });
  });

  it("retries a default whose source has no snapshot yet or whose install failed, and records missing packages as skipped", async () => {
    const offline = await boot({ synced: {} });
    expect(offline.installed).toEqual([]);
    expect((await AppliedDefaults.open(file)).list()).toEqual([]);

    const failed = await boot({ failing: new Set(["meeting"]), rows: [row("ave", "meeting")] });
    expect(failed.failed).toEqual([{ key: key("meeting"), message: "network down" }]);
    expect(failed.skipped).toEqual([{ key: key("local-indexer"), reason: "ave does not list plugin local-indexer" }]);
    const applied = await AppliedDefaults.open(file);
    expect(applied.has(key("meeting"))).toBe(false);
    expect(applied.get(key("local-indexer"))).toMatchObject({ result: "skipped" });

    const retried = await boot({ rows: [row("ave", "meeting"), row("ave", "local-indexer")] });
    expect(retried.installed).toEqual([key("meeting")]);
  });

  it("records a default already installed from its source, and skips one the user installed from another source", async () => {
    installedState.set("meeting", { kind: "plugin", name: "meeting", version: "1.0.0", sourceId: "ave" });
    installedState.set("local-indexer", { kind: "plugin", name: "local-indexer", version: "1.0.0", sourceId: "acme" });
    const report = await boot();
    expect(calls).toEqual([]);
    expect(report.skipped).toEqual([{ key: key("local-indexer"), reason: "already installed from acme" }]);
    const applied = await AppliedDefaults.open(file);
    expect(applied.get(key("meeting"))).toMatchObject({ result: "installed" });
    expect(applied.get(key("local-indexer"))).toMatchObject({ result: "skipped" });
  });

  it("skips an incompatible default and names the version it needs", async () => {
    const report = await boot({ rows: [row("ave", "meeting", { state: "upgrade_required", minAppVersion: "0.99.0" }), row("ave", "local-indexer")] });
    expect(report.skipped).toEqual([{ key: key("meeting"), reason: "needs Ave 0.99.0" }]);
  });

  it("adds the policy's defaults from managed sources and refuses a custom one", async () => {
    const report = await boot({
      policy: { defaultInstalls: [key("wiki", "corp"), key("toy", "acme")] },
      rows: [row("ave", "meeting"), row("ave", "local-indexer"), row("corp", "wiki"), row("acme", "toy")],
      synced: { ave: "official", corp: "managed", acme: "custom" },
    });
    expect(report.installed).toEqual([key("meeting"), key("local-indexer"), key("wiki", "corp")]);
    expect(report.skipped).toEqual([{ key: key("toy", "acme"), reason: "source acme is neither official nor managed" }]);
  });

  it("installs a missing required package every boot, and leaves an installed one's update or switch to the apply queue (§18.7.2)", async () => {
    const policy = { requiredInstalls: [key("wiki", "corp")] };
    const synced = { ave: "official", corp: "managed" } as Record<string, SourceOrigin>;
    const rows = (v: string) => [row("ave", "meeting"), row("ave", "local-indexer"), row("corp", "wiki", { state: "candidate", version: version(v) })];

    expect((await boot({ policy, synced, rows: rows("1.0.0") })).installed).toContainEqual(key("wiki", "corp"));
    installedState.delete("wiki"); // removed behind the app's back: required means it comes back
    expect((await boot({ policy, synced, rows: rows("1.0.0") })).installed).toEqual([key("wiki", "corp")]);

    // A newer version, another source, or an unreadable version: the boot pass replaces no running generation.
    calls = [];
    expect((await boot({ policy, synced, rows: rows("1.1.0") }))).toMatchObject({ installed: [], failed: [] });
    installedState.set("wiki", { kind: "plugin", name: "wiki", version: "5.0.0", sourceId: "acme" });
    expect((await boot({ policy, synced, rows: rows("1.1.0") }))).toMatchObject({ installed: [], failed: [] });
    installedState.set("wiki", { kind: "plugin", name: "wiki", version: null, sourceId: "corp" });
    expect((await boot({ policy, synced, rows: rows("1.1.0") }))).toMatchObject({ installed: [], failed: [] });
    expect(calls).toEqual([]);
  });

  it("never records required keys as defaults, and a required key is not also installed as a default", async () => {
    const report = await boot({ policy: { requiredInstalls: [key("meeting")] } });
    expect(report.installed).toEqual([key("meeting"), key("local-indexer")]);
    expect(calls.filter((call) => call.name === "meeting")).toEqual([{ name: "meeting", source: "ave", switchSource: false, required: true }]);
    expect((await AppliedDefaults.open(file)).has(key("meeting"))).toBe(false);
  });

  it("locks uninstall and disable only for a requiredInstalls entry, from the source it names", () => {
    const policy = { ...EMPTY_MARKETPLACE_POLICY, requiredInstalls: [key("wiki", "corp")] };
    expect(requiredByPolicy(policy, "plugin", "wiki")).toEqual(key("wiki", "corp"));
    expect(requiredByPolicy(policy, "plugin", "meeting")).toBeUndefined();
    expect(requiredByPolicy(policy, "skill", "wiki")).toBeUndefined();
    expect(() => assertNotRequiredByPolicy(policy, "plugin", "wiki", "corp", "uninstall")).toThrow(
      expect.objectContaining({ code: "PACKAGE_REQUIRED_BY_POLICY", message: "plugin wiki is required by policy (source corp); it cannot be uninstalled" }),
    );
    expect(() => assertNotRequiredByPolicy(policy, "plugin", "wiki", "corp", "disable")).toThrow(/cannot be disabled/u);
    expect(() => assertNotRequiredByPolicy(policy, "plugin", "meeting", "corp", "uninstall")).not.toThrow();
    // The same name bound to another source, or to none, is not the required package.
    expect(lockedByPolicy(policy, "plugin", "wiki", "corp")).toEqual(key("wiki", "corp"));
    expect(lockedByPolicy(policy, "plugin", "wiki", "acme")).toBeUndefined();
    expect(() => assertNotRequiredByPolicy(policy, "plugin", "wiki", "acme", "uninstall")).not.toThrow();
    expect(() => assertNotRequiredByPolicy(policy, "plugin", "wiki", null, "disable")).not.toThrow();
  });

  it("leaves a default held back by a rollout or as a pre-release unrecorded, to try again next boot", async () => {
    const report = await boot({ rows: [row("ave", "meeting", { state: "unavailable", reason: "pending" }), row("ave", "local-indexer", { state: "unavailable", reason: "withheld" })] });
    expect(report.skipped).toEqual([
      { key: key("meeting"), reason: "not offered to this installation yet (rollout or pre-release)" },
      { key: key("local-indexer"), reason: "no version is offered to this installation" },
    ]);
    const applied = await AppliedDefaults.open(file);
    expect(applied.has(key("meeting"))).toBe(false);
    expect(applied.get(key("local-indexer"))).toMatchObject({ result: "skipped" });
    expect((await boot()).installed).toEqual([key("meeting")]);
  });

  it("refuses to run over an applied file it cannot read", async () => {
    mkdirSync(join(dir, "packages"));
    writeFileSync(file, "{\"version\":1,\"applied\":[{\"kind\":\"plugin\",\"name\":\"meeting\",\"source\":\"ave\",\"result\":\"done\",\"at\":\"x\"}]}");
    await expect(AppliedDefaults.open(file)).rejects.toThrow("result is invalid");
    writeFileSync(file, "not json");
    await expect(AppliedDefaults.open(file)).rejects.toThrow();
  });
});

describe("bootInstallNoticeFrom (design §15.1)", () => {
  const empty = { installed: [], skipped: [], failed: [] };

  it("is null when the boot installed, updated and moved nothing", () => {
    expect(bootInstallNoticeFrom({ ...empty, skipped: [{ key: key("a"), reason: "r" }], failed: [{ key: key("b"), message: "m" }] }, EMPTY_MARKETPLACE_POLICY, null, [])).toBeNull();
    expect(bootInstallNoticeFrom(empty, EMPTY_MARKETPLACE_POLICY, { unmanaged: [], lostGrants: [] }, [])).toBeNull();
  });

  it("offers the default installs to the user, lists what the policy required, and what the migration unlocked", () => {
    const policy: MarketplacePolicy = { ...EMPTY_MARKETPLACE_POLICY, requiredInstalls: [key("vpn", "corp")] };
    const notice = bootInstallNoticeFrom(
      { ...empty, installed: [key("meeting"), key("vpn", "corp"), key("tokyo-night", "ave", "theme")] },
      policy,
      { unmanaged: ["orion"], lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }] },
      [],
    );
    expect(notice).toEqual({
      forYou: [
        { sourceId: "ave", kind: "plugin", name: "meeting" },
        { sourceId: "ave", kind: "theme", name: "tokyo-night" },
      ],
      required: [{ sourceId: "corp", kind: "plugin", name: "vpn" }],
      unmanaged: ["orion"],
      lostGrants: [{ plugin: "meeting", keys: ["llm.apiKey.openai"] }],
      revoked: [],
      autoUpdated: [],
    });
  });

  it("reports a revocation the boot pass acted on even when nothing else moved (§10.4)", () => {
    const revoked = [{ key: { sourceId: "acme", kind: "mcp" as const, name: "scraper" }, version: "1.2.0", reason: "exfiltrates cookies", outcome: "uninstalled" as const }];
    expect(bootInstallNoticeFrom(empty, EMPTY_MARKETPLACE_POLICY, null, revoked)).toEqual({ forYou: [], required: [], unmanaged: [], lostGrants: [], revoked, autoUpdated: [] });
  });
});
