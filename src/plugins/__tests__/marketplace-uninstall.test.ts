/**
 * `PluginMarketplaceService.uninstall()` — the removal transaction stages the
 * live directory and every path the registry row owns (recovery backups and
 * pending cleanups), commits the registry removal, and restores all of it when
 * the registry moved underneath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import {
  agentPluginsDocument,
  makeTestPluginPaths,
  makeTestTreeWritable,
  TestPluginMarketplaceService,
} from "./test-helpers.js";
import * as removalTransaction from "../plugin-removal-transaction.js";

describe("PluginMarketplaceService uninstall()", () => {
  let testDir: string;
  let registryPath: string;
  let installedDir: string;
  let cacheRoot: string;

  beforeEach(async () => {
    setIsPackaged(false);
    testDir = await mkdtemp(join(tmpdir(), "ave-marketplace-uninstall-"));
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    cacheRoot = join(testDir, ".cache");
    await mkdir(installedDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await makeTestTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  function makeService() {
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: installedDir, cacheRoot });
    return { service: new TestPluginMarketplaceService(paths) };
  }

  it("reads effective-config inputs from a disabled installed manifest without a runtime", async () => {
    const pluginId = "retired-fixture";
    await mkdir(join(installedDir, pluginId), { recursive: true });
    await writeFile(join(installedDir, pluginId, "plugin.json"), JSON.stringify({
      name: pluginId, version: "1.0.0", extensions: { "ai.agent-connector.ave": {
        config: { choice: true }, configSchema: { properties: { defaultChoice: { type: "boolean", default: true } } },
      } },
    }));
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [
      { id: pluginId, manifestPath: pluginId + "/plugin.json", enabled: false, installSource: "user" },
    ] }));
    const { service } = makeService();
    expect(await service.getInstalledConfigManifest(pluginId)).toMatchObject({
      enabled: false, sourceId: null, manifest: { id: pluginId, config: { choice: true }, configSchema: { properties: { defaultChoice: { default: true } } } },
    });
    await rm(join(installedDir, pluginId, "plugin.json"));
    await expect(service.getInstalledConfigManifest(pluginId)).rejects.toThrow();
    expect(await service.getInstalledConfigManifest("absent-fixture")).toBeNull();
  });

  it("stages the live directory and every owned recovery path during direct uninstall", async () => {
    const pluginId = "owned-direct";
    const installDir = join(installedDir, pluginId);
    const recoveryDir = join(installedDir, `.${pluginId}.old-00000000-0000-4000-8000-000000000011`);
    const cleanupDir = join(installedDir, `.${pluginId}.old-00000000-0000-4000-8000-000000000012`);
    for (const dir of [installDir, recoveryDir, cleanupDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "keep.txt"), dir);
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        installSource: "user",
        pendingUpdate: {
          kind: "marketplace",
          previousManifestFileSha256: null,
          previousReceiptRaw: null,
          recoveryBackupDir: recoveryDir,
          recoveryBackupMode: "rename",
        },
        pendingCleanup: [{ kind: "obsolete-artifact", path: cleanupDir }],
      }],
    }));
    const { service } = makeService();

    await expect(service.uninstall(pluginId)).resolves.toEqual({ pluginId, uninstalled: true });
    for (const dir of [installDir, recoveryDir, cleanupDir]) expect(existsSync(dir)).toBe(false);
    expect((JSON.parse(await readFile(registryPath, "utf-8")) as { plugins: unknown[] }).plugins).toEqual([]);
  });

  // A confined plugin writes inside its data root, so it can take its owner's
  // access away there: `chmod 000` on a directory, and on macOS the
  // user-immutable flag. The uninstall must still remove the whole tree, and
  // must not leave a committed transaction behind for boot to retry.
  it.runIf(process.platform !== "win32")(
    "removes a plugin whose data holds a directory it made unreadable or, on macOS, immutable",
    async () => {
      const pluginId = "locked-data";
      const installDir = join(installedDir, pluginId);
      const locked = join(installDir, "data", "locked");
      const immutable = join(installDir, "data", "immutable");
      await mkdir(join(locked, "deep"), { recursive: true });
      await writeFile(join(locked, "deep", "state.bin"), "state");
      await mkdir(immutable, { recursive: true });
      await writeFile(join(immutable, "pinned.txt"), "pinned");
      await writeFile(join(installDir, "plugin.json"), "{}");
      await chmod(locked, 0o000);
      if (process.platform === "darwin") {
        execFileSync("/usr/bin/chflags", ["uchg", join(immutable, "pinned.txt")]);
        execFileSync("/usr/bin/chflags", ["uchg", immutable]);
      }
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath: `${pluginId}/plugin.json`, installSource: "user" }],
      }));
      const { service } = makeService();

      await expect(service.uninstall(pluginId)).resolves.toEqual({ pluginId, uninstalled: true });
      expect(existsSync(installDir)).toBe(false);
      const transactions = join(installedDir, "+transactions+", "removals");
      expect(existsSync(transactions) ? await readdir(transactions) : []).toEqual([]);
    },
  );

  it("rejects a cross-wired registry row before it can remove another plugin directory", async () => {
    for (const id of ["owner-a", "owner-b"]) {
      await mkdir(join(installedDir, id), { recursive: true });
      await writeFile(join(installedDir, id, "plugin.json"), JSON.stringify(agentPluginsDocument({ id })));
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: "owner-a", manifestPath: "owner-b/plugin.json", installSource: "user" }],
    }));
    const { service } = makeService();

    await expect(service.uninstall("owner-a")).rejects.toThrow("Registry ownership mismatch");
    expect(existsSync(join(installedDir, "owner-a", "plugin.json"))).toBe(true);
    expect(existsSync(join(installedDir, "owner-b", "plugin.json"))).toBe(true);
  });

  it("restores the live directory and every owned path when direct uninstall commit conflicts", async () => {
    const pluginId = "owned-restore";
    const installDir = join(installedDir, pluginId);
    const recoveryDir = join(installedDir, `.${pluginId}.old-00000000-0000-4000-8000-000000000013`);
    const cleanupDir = join(installedDir, `.${pluginId}.old-00000000-0000-4000-8000-000000000014`);
    const row = {
      id: pluginId,
      manifestPath: `${pluginId}/plugin.json`,
      installSource: "user",
      pendingUpdate: {
        kind: "marketplace",
        previousManifestFileSha256: null,
        previousReceiptRaw: null,
        recoveryBackupDir: recoveryDir,
        recoveryBackupMode: "rename",
      },
      pendingCleanup: [{ kind: "obsolete-artifact", path: cleanupDir }],
    };
    for (const dir of [installDir, recoveryDir, cleanupDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "keep.txt"), dir);
    }
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [row] }));
    const originalStage = removalTransaction.stageRemovalTransaction;
    vi.spyOn(removalTransaction, "stageRemovalTransaction").mockImplementation(async (...args) => {
      await originalStage(...args);
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        plugins: [{ ...row, enabled: false }],
      }));
    });
    const { service } = makeService();

    await expect(service.uninstall(pluginId)).rejects.toThrow(/registry changed during uninstall/);
    for (const dir of [installDir, recoveryDir, cleanupDir]) {
      expect(existsSync(dir)).toBe(true);
      expect(await readFile(join(dir, "keep.txt"), "utf-8")).toBe(dir);
    }
  });

  it("stages every member recovery path during bundle uninstall", async () => {
    const rootId = "owned-bundle";
    const memberId = "owned-member";
    const rootDir = join(installedDir, rootId);
    const memberDir = join(installedDir, memberId);
    const memberRecovery = join(installedDir, `.${memberId}.old-00000000-0000-4000-8000-000000000021`);
    const memberCleanup = join(installedDir, `.${memberId}.old-00000000-0000-4000-8000-000000000022`);
    for (const dir of [rootDir, memberDir, memberRecovery, memberCleanup]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "keep.txt"), dir);
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: rootId, manifestPath: `${rootId}/plugin.json`, installSource: "user" },
        {
          id: memberId,
          manifestPath: `${memberId}/plugin.json`,
          installSource: "user",
          bundleRefs: [rootId],
          pendingUpdate: {
            kind: "marketplace",
            previousManifestFileSha256: null,
            previousReceiptRaw: null,
            recoveryBackupDir: memberRecovery,
            recoveryBackupMode: "rename",
          },
          pendingCleanup: [{ kind: "obsolete-artifact", path: memberCleanup }],
        },
      ],
    }));
    const { service } = makeService();

    await expect(service.uninstall(rootId, { removeBundleMembers: true })).resolves.toEqual({
      pluginId: rootId,
      uninstalled: true,
    });
    for (const dir of [rootDir, memberDir, memberRecovery, memberCleanup]) expect(existsSync(dir)).toBe(false);
    expect((JSON.parse(await readFile(registryPath, "utf-8")) as { plugins: unknown[] }).plugins).toEqual([]);
  });
});
