/** Registry reads normalize legacy fields without writing; only explicit migration persists changes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migratePluginRegistry, readPluginRegistry } from "../registry.js";

describe("readPluginRegistry — legacy installedBy/_devLinked migration", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ave-registry-migration-"));
    registryPath = join(tmpDir, "registry.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("maps `_devLinked: true` in memory and persists only through explicit migration", async () => {
    // Normalize dev-link to local-dev; receipt verification still applies.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "samplehub",
            manifestPath: "samplehub/plugin.json",
            enabled: true,
            installedBy: "user",
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0]).toEqual({
      id: "samplehub",
      manifestPath: "samplehub/plugin.json",
      enabled: true,
      installSource: "local-dev",
    });

    const beforeMigration = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(beforeMigration.plugins[0].installedBy).toBe("user");
    await migratePluginRegistry(registryPath);
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0]._devLinked).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("local-dev");
  });

  it("maps `installedBy: \"user\"` → `installSource: \"user\"`", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
            enabled: true,
            installedBy: "user",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("user");

    await migratePluginRegistry(registryPath);
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("user");
  });

  it("maps `installedBy: \"admin\"` → `installSource: \"admin\"`", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "meeting",
            manifestPath: "meeting/plugin.json",
            enabled: true,
            installedBy: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("admin");

    await migratePluginRegistry(registryPath);
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("admin");
  });

  it("`_devLinked: true` wins over `installedBy: \"admin\"` (rewritten to local-dev post-purge)", async () => {
    // Legacy _devLinked takes precedence over installedBy and normalizes to local-dev.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "x",
            manifestPath: "x/plugin.json",
            installedBy: "admin",
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("local-dev");
    await migratePluginRegistry(registryPath);
  });

  it("rewrites pre-existing `installSource: \"dev-link\"` to `\"local-dev\"`", async () => {
    // Normalize dev-link on read and emit a one-shot audit warning.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "samplehub",
            manifestPath: "samplehub/plugin.json",
            enabled: true,
            installSource: "dev-link",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("local-dev");
    await migratePluginRegistry(registryPath);
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installSource).toBe("local-dev");
  });

  it("entries with neither legacy field nor installSource keep installSource undefined", async () => {
    // Without install-source signals, preserve undefined so deployment policy can consult the manifest.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "ancient",
            manifestPath: "ancient/plugin.json",
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBeUndefined();
  });

  it("is idempotent: a second read does not rewrite an already-migrated registry", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
            enabled: true,
            installSource: "user",
          },
        ],
      }),
      "utf-8",
    );

    const before = await readFile(registryPath, "utf-8");
    await readPluginRegistry(registryPath);
    const after = await readFile(registryPath, "utf-8");
    expect(after).toEqual(before);
  });

  it("preserves bundleRefs and approvedPluginAccess across migration", async () => {
    const accessSpec = { plugins: [{ pluginId: "samplemail", events: ["email.new"] }] };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "sampleassistant",
            manifestPath: "sampleassistant/plugin.json",
            enabled: true,
            installedBy: "user",
            bundleRefs: ["x-bundle"],
            approvedPluginAccess: accessSpec,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0]).toEqual({
      id: "sampleassistant",
      manifestPath: "sampleassistant/plugin.json",
      enabled: true,
      installSource: "user",
      bundleRefs: ["x-bundle"],
      approvedPluginAccess: accessSpec,
    });
  });

  it("leaves an already-canonical local-indexer registry entry unchanged", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "local-indexer",
            manifestPath: "local-indexer/plugin.json",
            enabled: false,
            installSource: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const before = await readFile(registryPath, "utf-8");
    const registry = await readPluginRegistry(registryPath);
    const after = await readFile(registryPath, "utf-8");
    expect(registry.plugins[0]).toEqual({
      id: "local-indexer",
      manifestPath: "local-indexer/plugin.json",
      enabled: false,
      installSource: "admin",
    });
    expect(after).toEqual(before);
  });

  it("does not rewrite a registry entry under a former plugin id to local-indexer", async () => {
    const approvedPluginAccess = { plugins: [{ pluginId: "samplehub", events: ["agent.ready"] }] };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "sampleindexer",
            manifestPath: "/opt/ave/custom-sampleindexer/plugin.json",
            enabled: false,
            installSource: "local-dev",
            bundleRefs: ["custom-bundle"],
            approvedPluginAccess,
          },
        ],
      }),
      "utf-8",
    );

    const before = await readFile(registryPath, "utf-8");
    const registry = await readPluginRegistry(registryPath);
    const after = await readFile(registryPath, "utf-8");
    expect(registry.plugins).toEqual([
      {
        id: "sampleindexer",
        manifestPath: "/opt/ave/custom-sampleindexer/plugin.json",
        enabled: false,
        installSource: "local-dev",
        bundleRefs: ["custom-bundle"],
        approvedPluginAccess,
      },
    ]);
    expect(after).toEqual(before);
  });

  it("returns the empty default and does not write anything for a missing registry (first boot)", async () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    const registry = await readPluginRegistry(missingPath);
    expect(registry.plugins).toEqual([]);
    await expect(readFile(missingPath, "utf-8")).rejects.toThrow();
  });

  it("removes legacy pluginAccess tools grants while preserving event grants", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "sampleassistant",
          manifestPath: "sampleassistant/plugin.json",
          enabled: true,
          installSource: "user",
          approvedPluginAccess: {
            plugins: [null, {
              pluginId: "samplemail",
              tools: ["samplemail_calendar_list"],
              events: ["email.new"],
            }],
          },
        }],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0]?.approvedPluginAccess).toEqual({
      plugins: [{ pluginId: "samplemail", events: ["email.new"] }],
    });

    await migratePluginRegistry(registryPath);
    const persisted = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(persisted.plugins[0]?.approvedPluginAccess).toEqual({
      plugins: [{ pluginId: "samplemail", events: ["email.new"] }],
    });
  });

  it("accepts the strict pending-update recovery shape without migrating it", async () => {
    const pendingUpdate = {
      kind: "marketplace",
      previousManifestFileSha256: "a".repeat(64),
      previousReceiptRaw: null,
      recoveryBackupDir: join(tmpDir, ".calendar.old-backup"),
      recoveryBackupMode: "rename",
    };
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        enabled: true,
        bundleRefs: ["sampleassistant"],
        pendingUpdate,
      }],
    }));

    expect((await readPluginRegistry(registryPath)).plugins[0]).toEqual(expect.objectContaining({
      id: "calendar",
      bundleRefs: ["sampleassistant"],
      pendingUpdate,
    }));
  });

  it("rejects incomplete or permissive pending-update metadata", async () => {
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        pendingUpdate: {
          kind: "unknown",
          previousManifestFileSha256: "not-a-hash",
          previousReceiptRaw: null,
          recoveryBackupDir: join(tmpDir, ".calendar.old-backup"),
        },
      }],
    }));

    await expect(readPluginRegistry(registryPath)).rejects.toThrow(/pending update/);
  });

  it.each([".", "..", "../outside", "nested/plugin", "nested\\plugin"])(
    "rejects unsafe canonical and legacy registry plugin id %j before migration",
    async (id) => {
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        plugins: [{
          id,
          manifestPath: "outside/plugin.json",
          installedBy: "user",
        }],
      }));

      await expect(readPluginRegistry(registryPath)).rejects.toThrow(/invalid artifact slug/);
      await expect(migratePluginRegistry(registryPath)).rejects.toThrow(/invalid artifact slug/);
    },
  );

  it("accepts only strict non-restorable cleanup ownership metadata", async () => {
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        pendingCleanup: [{ kind: "obsolete-artifact", path: join(tmpDir, ".calendar.old-backup") }],
      }],
    }));
    await expect(readPluginRegistry(registryPath)).resolves.toEqual(expect.objectContaining({
      plugins: [expect.objectContaining({
        pendingCleanup: [expect.objectContaining({ kind: "obsolete-artifact" })],
      })],
    }));

    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        pendingCleanup: [{ kind: "rollback", path: "unsafe", restore: true }],
      }],
    }));
    await expect(readPluginRegistry(registryPath)).rejects.toThrow(/pending cleanup/);
  });
});
