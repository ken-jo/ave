/**
 * The plugin half of the first-boot migration (design §16.3), against a real
 * registry file and real install receipts: what binds, what keeps its grant,
 * what is unlocked, and that nothing already migrated or in flight moves.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstallReceipt, writeInstallReceipt } from "../../../plugins/plugin-install-receipt.js";
import type { PluginRegistry, PluginRegistryEntry } from "../../../plugins/types.js";
import { AppliedDefaults } from "../../boot-installs/applied.js";
import { migrateLegacyPlugins, type OfficialPlugin } from "../legacy-plugins.js";

const COMMIT = "c".repeat(40);
const SERVED = "a".repeat(64);
const OTHER = "b".repeat(64);
const AT = new Date("2026-09-24T00:00:00.000Z");

describe("migrateLegacyPlugins", () => {
  let root: string;
  let paths: { registryPath: string; cacheRoot: string; pluginsRoot: string };
  let applied: AppliedDefaults;
  const warn = vi.fn();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-legacy-plugins-"));
    paths = { registryPath: join(root, "plugins", "registry.json"), cacheRoot: join(root, "plugins", ".cache"), pluginsRoot: join(root, "plugins") };
    applied = await AppliedDefaults.open(join(root, "packages", "default-installs.json"));
    warn.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A plugin on disk at `version`, with a receipt whose artifact hash is `sha` (none when undefined). */
  async function plugin(id: string, version: string, sha?: string | null): Promise<string> {
    const dir = join(paths.pluginsRoot, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), `${JSON.stringify({ name: id, version, description: id, extensions: { "ai.agent-connector.ave": { entry: "dist/index.js" } } })}\n`);
    writeFileSync(join(dir, "dist", "index.js"), "export default {};\n");
    if (sha !== undefined) {
      const { receipt } = await buildInstallReceipt(dir, {
        pluginId: id,
        version,
        installSource: "marketplace",
        artifactSha256: sha,
        signerKeyId: "prod-v1",
        files: ["plugin.json", "dist/index.js"],
        installedAt: "2026-05-01T00:00:00.000Z",
      });
      await writeInstallReceipt(paths.cacheRoot, receipt);
    }
    return join(dir, "plugin.json");
  }

  function registry(entries: PluginRegistryEntry[]): void {
    mkdirSync(paths.pluginsRoot, { recursive: true });
    writeFileSync(paths.registryPath, `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`);
  }

  function readRegistry(): PluginRegistry {
    return JSON.parse(readFileSync(paths.registryPath, "utf8")) as PluginRegistry;
  }

  /** The official snapshot lists `meeting` (pinning SERVED for 0.5.0) and `calendar` (no pins). */
  const official = (name: string): OfficialPlugin | null => {
    if (name === "meeting") return { snapshotCommit: COMMIT, packagePath: "plugins/meeting", pins: (version) => (version === "0.5.0" ? [SERVED] : []) };
    if (name === "calendar") return { snapshotCommit: COMMIT, packagePath: "plugins/calendar", pins: () => [] };
    return null;
  };

  const run = () => migrateLegacyPlugins({ paths, officialPlugin: official, applied, now: () => AT, log: { warn } });

  it("binds a listed plugin as legacy, keeping its grant when the receipt matches the official pin", async () => {
    registry([{ id: "meeting", manifestPath: await plugin("meeting", "0.5.0", SERVED), installSource: "user", enabled: true }]);

    const report = await run();

    expect(report).toEqual({ bound: ["meeting"], unmanaged: [], lostGrants: [], failed: [] });
    expect(readRegistry().plugins[0]).toMatchObject({
      installSource: "user",
      origin: {
        sourceId: "ave",
        sourceOrigin: "official",
        commit: COMMIT,
        packagePath: "plugins/meeting",
        version: "0.5.0",
        rung: "legacy",
        artifactSha256: null,
        installedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    expect(applied.list()).toEqual([]);
  });

  it("names the keys a granted plugin loses when its receipt is not the pinned artifact", async () => {
    registry([{ id: "meeting", manifestPath: await plugin("meeting", "0.5.0", OTHER), installSource: "user" }]);
    const report = await run();
    expect(report.bound).toEqual(["meeting"]);
    expect(report.lostGrants).toEqual([{ plugin: "meeting", keys: expect.arrayContaining(["llm.apiKey.openai"]) }]);
  });

  it("names the keys a granted plugin loses when the index pins nothing for its version, or it has no receipt", async () => {
    registry([{ id: "meeting", manifestPath: await plugin("meeting", "0.4.0"), installSource: "user" }]);
    const report = await run();
    // No receipt: the version comes from plugin.json, and there is no hash to match.
    expect(readRegistry().plugins[0]!.origin).toMatchObject({ version: "0.4.0", installedAt: AT.toISOString() });
    expect(report.lostGrants.map((item) => item.plugin)).toEqual(["meeting"]);
  });

  it("turns a former admin install into a user install recorded as an applied default, and names every entry no source lists", async () => {
    registry([
      { id: "calendar", manifestPath: await plugin("calendar", "1.0.0", OTHER), installSource: "admin" },
      { id: "orion", manifestPath: await plugin("orion", "2.0.0", OTHER), installSource: "admin" },
      { id: "notes", manifestPath: await plugin("notes", "1.0.0", OTHER), installSource: "user" },
    ]);

    const report = await run();

    expect(report).toEqual({ bound: ["calendar"], unmanaged: ["orion", "notes"], lostGrants: [], failed: [] });
    const entries = new Map(readRegistry().plugins.map((entry) => [entry.id, entry]));
    expect(entries.get("calendar")).toMatchObject({ installSource: "user", origin: { sourceId: "ave", rung: "legacy" } });
    expect(entries.get("orion")).toMatchObject({ installSource: "user" });
    expect(entries.get("orion")!.origin).toBeUndefined();
    // A user install no source lists is named too (it gets no updates now), and left as it was.
    expect(entries.get("notes")).toEqual({ id: "notes", manifestPath: join(paths.pluginsRoot, "notes", "plugin.json"), installSource: "user" });
    expect(applied.list()).toEqual([{ kind: "plugin", name: "calendar", source: "ave", result: "migrated", at: AT.toISOString() }]);
  });

  it("leaves bound and local-dev entries alone, so a second run changes nothing", async () => {
    const bound = { sourceId: "ave", sourceOrigin: "official" as const, commit: COMMIT, packagePath: "plugins/meeting", version: "0.6.0", rung: "release" as const, artifactSha256: SERVED, installedAt: "2026-09-01T00:00:00.000Z" };
    registry([
      { id: "meeting", manifestPath: await plugin("meeting", "0.6.0", SERVED), installSource: "user", origin: bound },
      { id: "calendar", manifestPath: await plugin("calendar", "1.0.0"), installSource: "local-dev" },
    ]);
    const before = readFileSync(paths.registryPath, "utf8");

    expect(await run()).toEqual({ bound: [], unmanaged: [], lostGrants: [], failed: [] });
    expect(readFileSync(paths.registryPath, "utf8")).toBe(before);
  });

  it("keeps its report when recording an applied default fails, since the registry already changed", async () => {
    registry([{ id: "calendar", manifestPath: await plugin("calendar", "1.0.0", OTHER), installSource: "admin" }]);
    vi.spyOn(applied, "record").mockRejectedValueOnce(new Error("disk full"));

    const report = await run();

    expect(report).toEqual({ bound: ["calendar"], unmanaged: [], lostGrants: [], failed: [] });
    expect(warn).toHaveBeenCalledWith("legacy plugin calendar: recording it as an applied default failed: disk full");
  });

  it("reports an entry whose interrupted update is still pending, so the migration runs again", async () => {
    const pendingUpdate = { kind: "marketplace" as const, previousManifestFileSha256: null, previousReceiptRaw: null };
    registry([
      { id: "calendar", manifestPath: await plugin("calendar", "1.0.0", OTHER), installSource: "admin", pendingUpdate },
      { id: "meeting", manifestPath: await plugin("meeting", "0.5.0", SERVED), installSource: "user" },
    ]);
    const before = readRegistry().plugins.find((entry) => entry.id === "calendar");

    const report = await run();

    expect(report.failed).toEqual([{ plugin: "calendar", message: "an interrupted update is still pending recovery" }]);
    expect(report.bound).toEqual(["meeting"]);
    expect(readRegistry().plugins.find((entry) => entry.id === "calendar")).toEqual(before);
  });

  it("reports an entry whose plugin.json cannot be read, and migrates the rest", async () => {
    const manifestPath = await plugin("calendar", "1.0.0");
    writeFileSync(manifestPath, "{ not json");
    registry([
      { id: "calendar", manifestPath, installSource: "admin" },
      { id: "meeting", manifestPath: await plugin("meeting", "0.5.0", SERVED), installSource: "user" },
    ]);

    const report = await run();

    expect(report.bound).toEqual(["meeting"]);
    expect(report.failed).toEqual([{ plugin: "calendar", message: expect.any(String) }]);
    expect(readRegistry().plugins.find((entry) => entry.id === "calendar")).toMatchObject({ installSource: "admin" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("calendar"));
  });
});
