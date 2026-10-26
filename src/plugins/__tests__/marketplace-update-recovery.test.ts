import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupPendingPluginUpdateBackup,
  preparePendingPluginUpdate,
  recoverPendingPluginUpdates,
} from "../marketplace-update-recovery.js";
import { installReceiptPath } from "../plugin-install-receipt.js";
import { preparePluginRegistryForBoot } from "../plugin-boot-recovery.js";
import { createRemovalTransaction, stageRemovalTransaction } from "../plugin-removal-transaction.js";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
import { sweepOrphanUninstallDirs } from "../orphan-uninstall-sweeper.js";
import { PARKED_PLUGIN_STATE_SUBDIR, TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";
import type { PluginPaths } from "../plugin-paths.js";
import { PLUGIN_DATA_FIXTURE, readPluginDataFixture, seedPluginDataFixture } from "./test-helpers.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";

const carryFault = vi.hoisted(() => ({ destination: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (args[1] === carryFault.destination) {
      carryFault.destination = undefined;
      throw Object.assign(new Error("entry move refused"), { code: "EIO" });
    }
    await actual.rename(...args);
  } };
});

describe("marketplace pending-update recovery", () => {
  let root: string;
  let paths: PluginPaths;
  const pluginId = "recoverable";
  const oldManifest = `${JSON.stringify({ id: pluginId, version: "1.0.0" })}\n`;
  const oldDist = "export const version = '1.0.0';\n";
  const oldReceipt = `${JSON.stringify({
    schemaVersion: 2,
    pluginId,
    version: "1.0.0",
    installSource: "marketplace",
    artifactSha256: "a".repeat(64),
    signerKeyId: "test-key",
    installedAt: "2026-07-22T00:00:00.000Z",
    files: [
      { path: "plugin.json", sha256: createHash("sha256").update(oldManifest).digest("hex") },
      { path: "dist/index.js", sha256: createHash("sha256").update(oldDist).digest("hex") },
    ],
  })}\n`;
  const backupSuffix = "00000000-0000-4000-8000-000000000001";
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let warnings: unknown[][];

  beforeEach(async () => {
    // The test logger routes host warnings to console.warn.
    warnings = [];
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    root = await mkdtemp(join(tmpdir(), "pending-update-recovery-"));
    paths = {
      pluginsRoot: join(root, "plugins"),
      registryPath: join(root, "plugins", "registry.json"),
      cacheRoot: join(root, "cache"),
    };
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await mkdir(join(paths.cacheRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), oldManifest);
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), oldDist);
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), oldReceipt);
    await writeFile(paths.registryPath, `${JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        manifestSha256: createHash("sha256").update(oldManifest).digest("hex"),
        enabled: true,
        installSource: "user",
        bundleRefs: ["bundle-root"],
      }],
    })}\n`);
  });

  afterEach(async () => {
    carryFault.destination = undefined;
    await rm(root, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  /** Require the parked file to exist so accidental deletion cannot pass as recovery. */
  async function findParkedFile(name: string): Promise<string> {
    const parkRoot = join(paths.pluginsRoot, PARKED_PLUGIN_STATE_SUBDIR);
    const parked = await readdir(parkRoot);
    expect(parked).toHaveLength(1);
    return join(parkRoot, parked[0]!, name);
  }

  it("clears a pre-promotion crash marker when old bytes and receipt remain exact", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const plannedBackup = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: plannedBackup,
      recoveryBackupMode: "rename",
    });

    const restarted = await recoverPendingPluginUpdates(paths);

    expect(restarted).toEqual({ recovered: [pluginId], unresolved: [] });
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
  });

  it("persists legacy registry migration before boot recovery", async () => {
    await writeFile(paths.registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        installedBy: "user",
      }],
    }));

    await expect(preparePluginRegistryForBoot(paths)).resolves.toEqual({
      recovered: [],
      unresolved: [],
      removals: { restored: [], cleaned: [], unresolved: [] },
      pendingRecoverySkipped: false,
    });
    const persisted = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(persisted.plugins[0]).toEqual(expect.objectContaining({ installSource: "user" }));
    expect(persisted.plugins[0]).not.toHaveProperty("installedBy");
  });

  it("blocks pending cleanup while removal restore is unresolved, then restores before cleanup on retry", async () => {
    const cleanupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(cleanupDir);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      registry.plugins[0]!.pendingCleanup = [{ kind: "obsolete-artifact", path: cleanupDir }];
    });
    const before = (await readPluginRegistry(paths.registryPath)).plugins;
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: [pluginId],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId, path: join(paths.pluginsRoot, pluginId) }],
    });
    await stageRemovalTransaction(paths, journal);
    const registryBytesBeforeBoot = await readFile(paths.registryPath, "utf-8");
    const renamePath = vi.fn(async () => {
      throw Object.assign(new Error("injected reverse rename failure"), { code: "EACCES" });
    });

    await expect(preparePluginRegistryForBoot(paths, {
      removalReconcile: { renamePath, retry: { attempts: 1, sleep: async () => undefined } },
    })).resolves.toEqual({
      recovered: [],
      unresolved: [],
      removals: {
        restored: [],
        cleaned: [],
        unresolved: [{
          transactionId: journal.transactionId,
          reason: "injected reverse rename failure",
        }],
      },
      pendingRecoverySkipped: true,
    });
    expect(await readFile(paths.registryPath, "utf-8")).toBe(registryBytesBeforeBoot);
    expect(existsSync(cleanupDir)).toBe(true);
    expect(existsSync(journal.mappings[0]!.stagedPath)).toBe(true);

    await expect(preparePluginRegistryForBoot(paths)).resolves.toEqual({
      recovered: [pluginId],
      unresolved: [],
      removals: { restored: [journal.transactionId], cleaned: [], unresolved: [] },
      pendingRecoverySkipped: false,
    });
    expect(existsSync(join(paths.pluginsRoot, pluginId, "plugin.json"))).toBe(true);
    expect(existsSync(cleanupDir)).toBe(false);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingCleanup).toBeUndefined();
  });

  it("restores a retained old directory and receipt after a post-promotion crash", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readFile(installReceiptPath(paths.cacheRoot, pluginId), "utf-8")).toBe(oldReceipt);
    expect(existsSync(backupDir)).toBe(false);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
  });

  it("moves plugin data out of the abandoned promoted root before restoring the old directory", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    // The crash hit after the replacement carried the data directory into the
    // promoted root and before its receipt became durable.
    await seedPluginDataFixture(join(paths.pluginsRoot, pluginId));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("returns plugin data held by the backup to a live root that still matches its receipt", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    // The crash hit after the replacement moved the data directory into the
    // backup and before the live root was replaced.
    await mkdir(backupDir);
    await seedPluginDataFixture(backupDir);

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(backupDir)).toBe(false);
  });

  /** An empty live data/ from an interrupted swap must not leave pendingUpdate stuck across boots. */
  it("resolves an empty data directory at the promoted root and restores the live state", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await mkdir(backupDir);
    await seedPluginDataFixture(backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId, "data"), { recursive: true });

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(backupDir)).toBe(false);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
  });

  /** Read parked contents again after deferred deletion would run; namespace existence alone proves nothing. */
  it("parks an unattributable data directory and keeps its contents readable", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await mkdir(backupDir);
    await seedPluginDataFixture(backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId, "data"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "data", "unattributed.bin"), "keep me");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    // The transaction state takes precedence over stray live-path writes.
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();

    const parkedFile = await findParkedFile("unattributed.bin");
    expect(await readFile(parkedFile, "utf-8")).toBe("keep me");
    await new Promise((done) => setTimeout(done, 400));
    expect(await readFile(parkedFile, "utf-8")).toBe("keep me");
    expect(existsSync(join(paths.pluginsRoot, TOMBSTONE_SUBDIR))).toBe(false);

    // No registry row points to parked state; the recovery log is its only discovery path.
    const parkWarning = warnings.find(([message]) =>
      typeof message === "string" && message.includes("could not be attributed"));
    expect(parkWarning).toBeDefined();
    expect(parkWarning![1]).toEqual(expect.objectContaining({
      pluginId,
      parked: dirname(parkedFile),
    }));
  });

  /** On rollback the backup holds authoritative state; stray writes at the live path must lose. */
  it("parks a stray live-root directory rather than carrying it over the backup's state", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await seedPluginDataFixture(backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await mkdir(join(paths.pluginsRoot, pluginId, "data"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "data", "unattributed.bin"), "keep me");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);

    const parkedFile = await findParkedFile("unattributed.bin");
    expect(await readFile(parkedFile, "utf-8")).toBe("keep me");
  });

  it("carries plugin data out of an explicitly cleaned-up backup before removing it", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(backupDir);
    // Explicit backup cleanup must preserve the only copy of plugin data.
    await seedPluginDataFixture(backupDir);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });

    expect(await cleanupPendingPluginUpdateBackup(paths, pluginId)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("carries plugin data out of a journalled cleanup root before removing it", async () => {
    const obsoleteDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(obsoleteDir);
    await seedPluginDataFixture(obsoleteDir);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      const target = registry.plugins.find((candidate) => candidate.id === pluginId)!;
      target.pendingCleanup = [{ kind: "obsolete-artifact", path: obsoleteDir }];
    });

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(existsSync(obsoleteDir)).toBe(false);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
  });

  it("restores a copy-mode backup's payload and moves the plugin data it holds into the live root", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-1`);
    await mkdir(join(backupDir, "dist"), { recursive: true });
    await writeFile(join(backupDir, "plugin.json"), oldManifest);
    await writeFile(join(backupDir, "dist", "index.js"), oldDist);
    await seedPluginDataFixture(backupDir);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "local-dev",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "copy",
    });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readFile(installReceiptPath(paths.cacheRoot, pluginId), "utf-8")).toBe(oldReceipt);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(backupDir)).toBe(false);
  });

  // Runtime recovery tombstones roots still bound to children.
  // A payload-only restore stage containing runtime directories must be refused.
  it("refuses a leftover restore stage that holds a runtime directory", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-1`);
    await mkdir(join(backupDir, "dist"), { recursive: true });
    await writeFile(join(backupDir, "plugin.json"), oldManifest);
    await writeFile(join(backupDir, "dist", "index.js"), oldDist);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "local-dev",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "copy",
    });
    const live = join(paths.pluginsRoot, pluginId);
    await writeFile(join(live, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const stale = `${live}.recovery-${process.pid}-${now}`;
    await mkdir(join(stale, "data"), { recursive: true });
    try {
      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    } finally {
      clock.mockRestore();
    }

    expect(existsSync(join(stale, "data"))).toBe(true);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
  });

  it("tombstones the discarded roots when it runs after confined processes may run", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-1`);
    await mkdir(join(backupDir, "dist"), { recursive: true });
    await writeFile(join(backupDir, "plugin.json"), oldManifest);
    await writeFile(join(backupDir, "dist", "index.js"), oldDist);
    await seedPluginDataFixture(backupDir);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "local-dev",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "copy",
    });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));
    noteConfinedProcessesMayRun();
    try {
      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    } finally {
      _resetConfinedProcessPhaseForTests();
    }

    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readPluginDataFixture(join(paths.pluginsRoot, pluginId))).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(backupDir)).toBe(false);
    const tombstoned = await readdir(join(paths.pluginsRoot, TOMBSTONE_SUBDIR));
    const manifests = await Promise.all(tombstoned.map((name) =>
      readFile(join(paths.pluginsRoot, TOMBSTONE_SUBDIR, name, "plugin.json"), "utf-8")));
    expect(manifests.sort()).toEqual([JSON.stringify({ id: pluginId, version: "2.0.0" }), oldManifest].sort());
  });

  // Runtime rollback must restore the same socket directories the predecessor is still bound to.
  describe("socket directories", () => {
    it("retains both roots after a midway failure and converges on the next boot", async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const live = join(paths.pluginsRoot, pluginId);
      const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
      await mkdir(join(backupDir, "dist"), { recursive: true });
      await writeFile(join(backupDir, "plugin.json"), oldManifest);
      await writeFile(join(backupDir, "dist", "index.js"), oldDist);
      await mkdir(join(backupDir, "run", "original"), { recursive: true });
      await mkdir(join(live, "run", "a"), { recursive: true });
      await mkdir(join(live, "run", "b"));
      const original = statSync(join(backupDir, "run")).ino;
      const firstLeaf = statSync(join(live, "run", "a")).ino;
      const secondLeaf = statSync(join(live, "run", "b")).ino;
      await preparePendingPluginUpdate(paths, entry, {
        kind: "marketplace", recoveryBackupDir: backupDir, recoveryBackupMode: "rename",
      });
      await writeFile(join(live, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
      carryFault.destination = join(backupDir, "run", "b");
      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
      expect(statSync(join(backupDir, "run")).ino).toBe(original);
      expect(statSync(join(backupDir, "run", "a")).ino).toBe(firstLeaf);
      expect(statSync(join(live, "run", "b")).ino).toBe(secondLeaf);
      expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(statSync(join(live, "run")).ino).toBe(original);
      expect(statSync(join(live, "run", "a")).ino).toBe(firstLeaf);
      expect(statSync(join(live, "run", "b")).ino).toBe(secondLeaf);
      expect(existsSync(backupDir)).toBe(false);
      expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
    });

    it.each(["rename", "copy"] as const)("preserves the original run inode after an interrupted merge during %s restore", async (mode) => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = mode === "rename"
        ? join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`)
        : join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-2`);
      await mkdir(join(backupDir, "dist"), { recursive: true });
      await writeFile(join(backupDir, "plugin.json"), oldManifest);
      await writeFile(join(backupDir, "dist", "index.js"), oldDist);
      await preparePendingPluginUpdate(paths, entry, {
        kind: mode === "rename" ? "marketplace" : "local-dev",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: mode,
      });
      const live = join(paths.pluginsRoot, pluginId);
      await writeFile(join(live, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
      // An interrupted merge can leave leaves split between the original directory and the live root.
      await mkdir(join(backupDir, "run", "already-moved"), { recursive: true });
      await mkdir(join(live, "run", "not-yet-moved"), { recursive: true });
      const inode = statSync(join(backupDir, "run")).ino;
      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(statSync(join(live, "run")).ino).toBe(inode);
      expect(await readdir(join(live, "run"))).toEqual(["already-moved", "not-yet-moved"]);
      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [] });
    });

    // Recovery must unlink child-planted links without touching targets or leaving the update pending.
    // Windows covers junctions without symlink privileges; POSIX also covers file symlinks.
    const childLinks: ReadonlyArray<"file symlink" | "directory link"> =
      process.platform === "win32" ? ["directory link"] : ["file symlink", "directory link"];
    it.each(childLinks)("resolve past a %s a child left in its sockets/", async (linkKind) => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-1`);
      await mkdir(join(backupDir, "dist"), { recursive: true });
      await writeFile(join(backupDir, "plugin.json"), oldManifest);
      await writeFile(join(backupDir, "dist", "index.js"), oldDist);
      await mkdir(join(backupDir, "sockets"), { recursive: true });
      await writeFile(join(backupDir, "sockets", "egress.sock"), "live");
      const inode = statSync(join(backupDir, "sockets")).ino;
      await preparePendingPluginUpdate(paths, entry, {
        kind: "local-dev",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "copy",
      });
      const live = join(paths.pluginsRoot, pluginId);
      await writeFile(join(live, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
      await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));
      const victim = join(dirname(paths.pluginsRoot), "victim");
      let victimFile = victim;
      if (linkKind === "file symlink") {
        await writeFile(victim, "original");
        await mkdir(join(live, "sockets"), { recursive: true });
        await symlink(victim, join(live, "sockets", "evil.sock"));
      } else {
        victimFile = join(victim, "kept.txt");
        await mkdir(victim, { recursive: true });
        await writeFile(victimFile, "original");
        await mkdir(join(live, "sockets"), { recursive: true });
        await symlink(victim, join(live, "sockets", "evil.sock"), "junction");
      }

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(await readFile(join(live, "plugin.json"), "utf-8")).toBe(oldManifest);
      expect(statSync(join(live, "sockets")).ino).toBe(inode);
      expect(await readdir(join(live, "sockets"))).toEqual(["egress.sock"]);
      expect(await readFile(victimFile, "utf-8")).toBe("original");
      expect(statSync(victimFile).nlink).toBe(1);
      if (linkKind === "directory link") expect(await readdir(victim)).toEqual(["kept.txt"]);
    });

    it("come back from a copy-mode backup into the restored root", async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-1`);
      await mkdir(join(backupDir, "dist"), { recursive: true });
      await writeFile(join(backupDir, "plugin.json"), oldManifest);
      await writeFile(join(backupDir, "dist", "index.js"), oldDist);
      await mkdir(join(backupDir, "sockets"), { recursive: true });
      await mkdir(join(backupDir, "run"), { recursive: true });
      await writeFile(join(backupDir, "sockets", "egress.sock"), "live");
      const inodes = [statSync(join(backupDir, "sockets")).ino, statSync(join(backupDir, "run")).ino];
      await preparePendingPluginUpdate(paths, entry, {
        kind: "local-dev",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "copy",
      });
      await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
      await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      const live = join(paths.pluginsRoot, pluginId);
      expect(await readFile(join(live, "plugin.json"), "utf-8")).toBe(oldManifest);
      expect([statSync(join(live, "sockets")).ino, statSync(join(live, "run")).ino]).toEqual(inodes);
      expect(await readFile(join(live, "sockets", "egress.sock"), "utf-8")).toBe("live");
      expect(existsSync(backupDir)).toBe(false);
    });

    it("leave the abandoned promoted root for the restored one", async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, ".cache", "local-install-rollback", `${pluginId}-1-2`);
      await mkdir(join(backupDir, "dist"), { recursive: true });
      await writeFile(join(backupDir, "plugin.json"), oldManifest);
      await writeFile(join(backupDir, "dist", "index.js"), oldDist);
      await preparePendingPluginUpdate(paths, entry, {
        kind: "local-dev",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "copy",
      });
      const live = join(paths.pluginsRoot, pluginId);
      await writeFile(join(live, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
      await mkdir(join(live, "sockets"), { recursive: true });
      await writeFile(join(live, "sockets", "egress.sock"), "live");
      const inode = statSync(join(live, "sockets")).ino;

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(await readFile(join(live, "plugin.json"), "utf-8")).toBe(oldManifest);
      expect(statSync(join(live, "sockets")).ino).toBe(inode);
      expect(await readFile(join(live, "sockets", "egress.sock"), "utf-8")).toBe("live");
    });

    // A live worker can create leaves at either root during recovery; neither root may be discarded wholesale.
    it("merge a backup's live worker leaf into a live root that already has one", async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
      await preparePendingPluginUpdate(paths, entry, {
        kind: "marketplace",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "rename",
      });
      const live = join(paths.pluginsRoot, pluginId);
      await mkdir(join(backupDir, "run", "w1"), { recursive: true });
      await writeFile(join(backupDir, "run", "w1", "control.sock"), "w1");
      await mkdir(join(live, "run", "w2"), { recursive: true });
      const run = statSync(join(backupDir, "run")).ino;
      const w1 = statSync(join(backupDir, "run", "w1")).ino;

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(statSync(join(live, "run")).ino).toBe(run);
      expect(statSync(join(live, "run", "w1")).ino).toBe(w1);
      expect(await readFile(join(live, "run", "w1", "control.sock"), "utf-8")).toBe("w1");
      expect(existsSync(join(live, "run", "w2"))).toBe(true);
      expect(existsSync(backupDir)).toBe(false);
    });

    it("are handed to a live root that still matches its receipt", async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
      await preparePendingPluginUpdate(paths, entry, {
        kind: "marketplace",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "rename",
      });
      await mkdir(join(backupDir, "sockets"), { recursive: true });
      const inode = statSync(join(backupDir, "sockets")).ino;

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
      expect(statSync(join(paths.pluginsRoot, pluginId, "sockets")).ino).toBe(inode);
      expect(existsSync(backupDir)).toBe(false);
    });
  });

  it("only removes a retained backup through the explicit cleanup path and keeps the row hidden", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(backupDir);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });

    await sweepOrphanUninstallDirs(paths.pluginsRoot);
    expect(existsSync(backupDir)).toBe(true);
    expect(await cleanupPendingPluginUpdateBackup(paths, pluginId)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
    const pending = (await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate;
    expect(pending).toEqual(expect.objectContaining({ kind: "marketplace" }));
    expect(pending?.recoveryBackupDir).toBeUndefined();
  });

  it("rejects a nested lookalike marketplace backup path without deleting it", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const nestedRoot = join(paths.pluginsRoot, "unrelated");
    const backupDir = join(nestedRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(backupDir, { recursive: true });
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });

    await expect(cleanupPendingPluginUpdateBackup(paths, pluginId)).rejects.toThrow(
      `Unsafe recovery backup path for plugin: ${pluginId}`,
    );
    expect(existsSync(backupDir)).toBe(true);
  });

  it("rejects a sibling plugin prefix collision without deleting either directory", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const collision = join(paths.pluginsRoot, `.${pluginId}.old-other.old-${backupSuffix}`);
    const unrelated = join(paths.pluginsRoot, "unrelated");
    await mkdir(collision, { recursive: true });
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep.txt"), "keep");
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: collision,
      recoveryBackupMode: "rename",
    });

    await expect(cleanupPendingPluginUpdateBackup(paths, pluginId)).rejects.toThrow(/Unsafe recovery backup path/);
    expect(await readFile(join(unrelated, "keep.txt"), "utf-8")).toBe("keep");
    expect(existsSync(collision)).toBe(true);
  });

  it.each([".", "..", "../outside", "nested/plugin", "nested\\plugin"])(
    "rejects unsafe recovery id %j before constructing or removing a plugin path",
    async (id) => {
      const unrelated = join(root, "outside", "keep.txt");
      await mkdir(join(root, "outside"), { recursive: true });
      await writeFile(unrelated, "keep");
      await writeFile(paths.registryPath, JSON.stringify({
        version: 1,
        plugins: [{
          id,
          manifestPath: "outside/plugin.json",
          pendingUpdate: {
            kind: "marketplace",
            previousManifestFileSha256: null,
            previousReceiptRaw: null,
          },
        }],
      }));

      await expect(recoverPendingPluginUpdates(paths)).rejects.toThrow(/invalid artifact slug/);
      expect(await readFile(unrelated, "utf-8")).toBe("keep");
    },
  );

  it("refuses recovery when a receipt-covered dist file is corrupted", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await writeFile(join(backupDir, "dist", "index.js"), "corrupted");
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");
    const unrelated = join(paths.pluginsRoot, "unrelated.txt");
    await writeFile(unrelated, "keep");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(unrelated, "utf-8")).toBe("keep");
    expect(existsSync(backupDir)).toBe(true);
  });

  // Windows uses an unprivileged junction; POSIX also covers a file symlink.
  it.each(process.platform === "win32" ? ["directory link"] : ["file symlink", "directory link"])(
    "refuses predecessor recovery when the retained payload contains an unlisted %s",
    async (linkKind) => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
      await preparePendingPluginUpdate(paths, entry, {
        kind: "marketplace",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "rename",
      });
      await rename(join(paths.pluginsRoot, pluginId), backupDir);
      if (linkKind === "file symlink") {
        const outsideExecutable = join(root, "outside-executable");
        await writeFile(outsideExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await symlink(outsideExecutable, join(backupDir, "dist", "injected-tool"));
      } else {
        const outsideDir = join(root, "outside-tools");
        await mkdir(outsideDir, { recursive: true });
        await writeFile(join(outsideDir, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await symlink(outsideDir, join(backupDir, "dist", "injected-tool"), "junction");
      }
      await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
      await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
      expect(existsSync(backupDir)).toBe(true);
      expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
    },
  );

  it("refuses recovery from a corrupted durable receipt snapshot", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    await preparePendingPluginUpdate(paths, entry, { kind: "marketplace" });
    const registry = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<{ pendingUpdate?: { previousReceiptRaw: string | null } }>;
    };
    registry.plugins[0]!.pendingUpdate!.previousReceiptRaw = "{not-json";
    await writeFile(paths.registryPath, JSON.stringify(registry));
    const unrelated = join(paths.pluginsRoot, "unrelated.txt");
    await writeFile(unrelated, "keep");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(unrelated, "utf-8")).toBe("keep");
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
  });

  it("restores directory bytes before publishing the matching receipt and leaves pending on receipt fault", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");
    const receiptPath = installReceiptPath(paths.cacheRoot, pluginId);
    await rm(receiptPath);
    await mkdir(receiptPath);

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "utf-8")).toBe(oldDist);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
  });

  it("keeps the original predecessor and grants across a crash during a superseding retry", async () => {
    const originalBackup = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    const retryBackup = join(paths.pluginsRoot, `.${pluginId}.old-00000000-0000-4000-8000-000000000002`);
    const original = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    original.approvedPluginAccess = { plugins: [{ pluginId: "trusted-peer", events: ["old.event"] }] };
    await writeFile(paths.registryPath, JSON.stringify({ version: 1, plugins: [original] }));
    await preparePendingPluginUpdate(paths, original, {
      kind: "marketplace",
      recoveryBackupDir: originalBackup,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), originalBackup);
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "unresolved v2");

    const pendingBeforeRetry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const originalPending = pendingBeforeRetry.pendingUpdate;
    await preparePendingPluginUpdate(paths, pendingBeforeRetry, {
      kind: "marketplace",
      recoveryBackupDir: retryBackup,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), retryBackup);
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "3.0.0" }));
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "unpublished v3");

    const crashState = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(crashState.pendingUpdate).toEqual(originalPending);
    expect(crashState.pendingCleanup).toEqual([
      { kind: "obsolete-artifact", path: retryBackup },
    ]);
    expect(crashState.approvedPluginAccess).toEqual(original.approvedPluginAccess);

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    const recovered = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(recovered.approvedPluginAccess).toEqual(original.approvedPluginAccess);
    expect(recovered.pendingUpdate).toBeUndefined();
    expect(recovered.pendingCleanup).toBeUndefined();
    expect(existsSync(retryBackup)).toBe(false);
  });

  it("reports unresolved when cleanup succeeds but pending recovery remains unresolved", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    await preparePendingPluginUpdate(paths, entry, { kind: "marketplace" });
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "corrupted");
    const cleanupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(cleanupDir);
    const registry = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<{ pendingCleanup?: unknown }>;
    };
    registry.plugins[0]!.pendingCleanup = [{ kind: "obsolete-artifact", path: cleanupDir }];
    await writeFile(paths.registryPath, JSON.stringify(registry));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    const unresolved = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(unresolved.pendingUpdate).toBeDefined();
    expect(unresolved.pendingCleanup).toBeUndefined();
    expect(existsSync(cleanupDir)).toBe(false);
  });
});
