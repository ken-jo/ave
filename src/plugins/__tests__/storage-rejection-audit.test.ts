// Webview storage refusals must be audited by the sink; IPC only replies to the caller.
// Use real reparse points because sanitized keys cannot express lexical escapes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntimeWithAudit,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

// Directory junctions exercise Windows reparse traversal without symlink privileges.
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

const PLUGIN_ID = "p-storage-audit";

describe("PluginRuntime.getPluginStorage — containment refusals are audited", () => {
  let fixture: TestPluginRuntimeFixture;
  let outsideDir: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-storage-audit-" });
    outsideDir = mkdtempSync(join(tmpdir(), "ave-storage-audit-outside-"));
    auditEntries = [];
    await writeTestPlugin(fixture, {
      id: PLUGIN_ID,
      entry: "entry.mjs",
      entrySource:
        "export default async function createPlugin() {\n"
        + "  return { handlers: {}, start: async () => {}, stop: async () => {} };\n"
        + "}",
    });
    await writeTestPluginRegistry(fixture, [
      { id: PLUGIN_ID, manifestPath: join(fixture.pluginsRoot, PLUGIN_ID, "plugin.json") },
    ]);
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  function pluginHostStorageDir(): string {
    const dir = join(fixture.pluginsRoot, PLUGIN_ID, "storage");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Create storage at load, never per request; mkdir during an install swap can introduce conflicting state. */
  it("does not create the storage root on a per-request basis", async () => {
    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();
    expect(runtime.listPluginIds()).toContain(PLUGIN_ID);

    // The root exists while storage is mid-move.
    const storageDir = join(fixture.pluginsRoot, PLUGIN_ID, "storage");
    expect(existsSync(storageDir)).toBe(true);
    await rm(storageDir, { recursive: true, force: true });

    expect(() => runtime.getPluginStorage(PLUGIN_ID)).toThrow(/storage root is absent/);
    expect(existsSync(storageDir)).toBe(false);
  });

  it("emits plugin_storage_path_rejected when a webview read escapes via a planted symlink", async () => {
    writeFileSync(join(outsideDir, "tokens.json"), '{"stolen":true}', "utf-8");
    symlinkSync(outsideDir, join(pluginHostStorageDir(), "ui-storage"), dirLinkType);

    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();
    expect(runtime.listPluginIds()).toContain(PLUGIN_ID);

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    expect(storage).toBeDefined();

    // Match the webview tokens key after IPC sanitization.
    await expect(storage!.readJson("ui-storage/tokens.json")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );

    const rejections = auditEntries.filter(
      (e) => e.message === "plugin_storage_path_rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.level).toBe("error");
    expect(rejections[0]!.data).toMatchObject({
      pluginId: PLUGIN_ID,
      reason: "storage: rejected symlink escape",
    });
    // Audit the resolved target so operators can distinguish an escape from a typo.
    const data = rejections[0]!.data as { real: string; target: string };
    expect(data.real).toBe(join(await realpath(outsideDir), "tokens.json"));
    expect(data.target).toContain("tokens.json");
  });

  it("emits plugin_storage_path_rejected when a webview write escapes via a planted symlink", async () => {
    symlinkSync(outsideDir, join(pluginHostStorageDir(), "ui-storage"), dirLinkType);

    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    await expect(
      storage!.writeJson("ui-storage/planted.json", { evil: true }),
    ).rejects.toThrow(/symlink escapes plugin storage root/);

    expect(
      auditEntries.filter((e) => e.message === "plugin_storage_path_rejected"),
    ).toHaveLength(1);
  });

  it("stays silent for an in-sandbox round-trip", async () => {
    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    await storage!.writeJson("ui-storage/prefs.json", { theme: "dark" });
    await expect(storage!.readJson("ui-storage/prefs.json")).resolves.toEqual({
      theme: "dark",
    });
    // Webview storage belongs in the host-only root.
    expect(existsSync(join(fixture.pluginsRoot, PLUGIN_ID, "storage", "ui-storage", "prefs.json"))).toBe(true);
    expect(existsSync(join(fixture.pluginsRoot, PLUGIN_ID, "data", "ui-storage"))).toBe(false);

    expect(
      auditEntries.filter((e) => e.message === "plugin_storage_path_rejected"),
    ).toEqual([]);
  });
});
