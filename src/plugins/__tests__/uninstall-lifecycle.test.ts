import { createPluginRetirementPort } from "../retired-config.js";
import type { RetiredPluginConfigRecord } from "../../shared/alerts-types.js";
import { PluginUninstallCleanupJournal, pluginUninstallCleanupJournalPath } from "../plugin-uninstall-cleanup-journal.js";
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginUninstallLifecycleDeps,
  ensurePluginStateReadyForInstall,
  recoverPendingPluginUninstallCleanups,
  uninstallPluginWithLifecycle,
} from "../uninstall-lifecycle.js";
import {
  drainPluginInstallLockOperations,
  withPluginInstallLock,
} from "../install-lifecycle.js";

function makeDeps(pluginId: string, cacheRoot: string, uninstallError?: Error) {
  const pluginRuntime = {
    resolvePluginId: vi.fn((requestedPluginId: string) => requestedPluginId),
    resolvePluginInstallId: vi.fn((requestedPluginId: string) => requestedPluginId),
    resolvePluginInstallIdIfKnown: vi.fn(
      (requestedPluginId: string) => requestedPluginId,
    ),
    cancelPendingRestart: vi.fn(),
    clearConfigOverride: vi.fn(),
    getPluginManifest: vi.fn(() => ({
      configSchema: {
        properties: {
          token: { type: "string", format: "secret" },
        },
      },
    })),
    removePlugin: vi.fn(async () => undefined),
    removePluginWithCommit: vi.fn(async <T>(_pluginId: string, commit: () => Promise<T>) => {
      return commit();
    }),
  };
  return {
    pluginMarketplace: {
      getInstalledVersion: vi.fn(async () =>
        uninstallError && /not installed|not found/i.test(uninstallError.message)
          ? null
          : "1.0.0"),
      uninstall: vi.fn(async () => {
        if (uninstallError) throw uninstallError;
        return { pluginId, uninstalled: true as const };
      }),
    },
    pluginRuntime,
    settingsService: {
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
    },
    pluginPaths: { cacheRoot },
    clearAuthPartitionService: vi.fn(async () => undefined),
    listPluginAuthPartitionsService: vi.fn(() => [
      `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
      `persist:plugin-auth:${encodeURIComponent(pluginId)}:tenant`,
    ]),
    forgetPluginAuthPartitionsService: vi.fn(),
    drainPluginInstallLockOperationsService: vi.fn(
      drainPluginInstallLockOperations,
    ),
    emitHostEvent: vi.fn(),
    refreshPluginEventBridge: vi.fn(),
    log: { warn: vi.fn() },
  };
}

describe("uninstallPluginWithLifecycle", () => {
  it("captures before removal and replays a failed config phase without rewriting consumed choices", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-retaining-uninstall-"));
    try {
      const pluginId = "retired-fixture";
      const deps = makeDeps(pluginId, join(root, "cache"));
      let records: Record<string, RetiredPluginConfigRecord> = {};
      const set = vi.fn(async (_key: string, value: typeof records) => { records = structuredClone(value); });
      const retirement = createPluginRetirementPort({
        settings: { get: () => structuredClone(records), set, getPluginConfig: () => ({ choice: true }) } as never,
        marketplace: { getInstalledConfigManifest: async () => ({ manifest: { id: pluginId } as never, enabled: true, sourceId: "fixture" }) },
        wildcard: () => ({}), appVersion: () => "0.12.0",
      });
      const journalPath = pluginUninstallCleanupJournalPath(deps.pluginPaths.cacheRoot);
      deps.pluginMarketplace.uninstall.mockImplementation(async () => {
        expect(new PluginUninstallCleanupJournal(journalPath).find(pluginId)?.retirement?.config).toEqual({ choice: true });
        deps.pluginMarketplace.getInstalledVersion.mockResolvedValue(null);
        return { pluginId, uninstalled: true };
      });
      deps.settingsService.deletePluginConfig.mockRejectedValueOnce(new Error("config write failed"));
      await expect(uninstallPluginWithLifecycle(pluginId, { ...deps, retirement } as unknown as PluginUninstallLifecycleDeps, {
        reason: "superseded", sourceId: "fixture", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] },
      })).rejects.toThrow("incomplete post-commit cleanup");
      expect(records[pluginId]?.config).toEqual({ choice: true });
      expect(new PluginUninstallCleanupJournal(journalPath).find(pluginId)?.completedPhases).not.toContain("config");
      // Consumption may finish while cleanup is pending. Its durable decision
      // must survive the stale capture stored before registry removal.
      records[pluginId]!.consumedBy = ["successor-fixture"];
      const consumed = structuredClone(records[pluginId]);
      set.mockClear();
      await expect(recoverPendingPluginUninstallCleanups({ ...deps, retirement } as unknown as PluginUninstallLifecycleDeps)).resolves.toEqual([]);
      expect(records[pluginId]).toEqual(consumed);
      expect(set).not.toHaveBeenCalled();
      expect(new PluginUninstallCleanupJournal(journalPath).find(pluginId)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers a prepared retaining journal after the manifest and runtime are gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-prepared-retirement-"));
    try {
      const pluginId = "retired-fixture";
      const deps = makeDeps(pluginId, join(root, "cache"));
      deps.pluginMarketplace.getInstalledVersion.mockResolvedValue(null);
      deps.pluginRuntime.getPluginManifest.mockImplementation(() => { throw new Error("runtime gone"); });
      const retirement = { capture: vi.fn(), writeIfAbsent: vi.fn(async () => undefined) };
      const record: RetiredPluginConfigRecord = { config: { choice: true }, enabled: true, sourceId: null,
        retiredAtAppVersion: "0.12.0", successors: { plugins: [], hostKinds: [] }, consumedBy: [] };
      const path = pluginUninstallCleanupJournalPath(deps.pluginPaths.cacheRoot);
      new PluginUninstallCleanupJournal(path).prepare({ pluginId, installPluginId: pluginId, secretKeys: [], authPartitions: [], cleanupCache: false, retirement: record });
      await expect(recoverPendingPluginUninstallCleanups({ ...deps, retirement } as unknown as PluginUninstallLifecycleDeps)).resolves.toEqual([]);
      expect(retirement.capture).not.toHaveBeenCalled();
      expect(retirement.writeIfAbsent).toHaveBeenCalledWith(pluginId, record);
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith(pluginId);
      expect(new PluginUninstallCleanupJournal(path).list()).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("deletes normal plugin cache and preserves shared cache directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-cache-"));
    try {
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "agent-hub"), { recursive: true });
      await mkdir(join(cacheRoot, "verified-downloads"), { recursive: true });
      writeFileSync(join(cacheRoot, "agent-hub", "history.json"), "{}");
      writeFileSync(join(cacheRoot, "verified-downloads", "sentinel"), "keep");

      await uninstallPluginWithLifecycle("agent-hub", makeDeps("agent-hub", cacheRoot));
      await uninstallPluginWithLifecycle(
        "verified-downloads",
        makeDeps("verified-downloads", cacheRoot),
      );

      expect(existsSync(join(cacheRoot, "agent-hub"))).toBe(false);
      expect(existsSync(join(cacheRoot, "verified-downloads", "sentinel"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The plugin's cache holds receipts, version caches and retained
  // generations, none granted to a confined process. A runtime directory in
  // it would be, so the cleanup refuses rather than racing a writer.
  it("refuses to delete a plugin cache that holds a runtime directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-cache-runtime-"));
    try {
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "agent-hub", "data"), { recursive: true });

      await expect(uninstallPluginWithLifecycle("agent-hub", makeDeps("agent-hub", cacheRoot)))
        .rejects.toThrow();

      expect(existsSync(join(cacheRoot, "agent-hub", "data"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips cache deletion on idempotent missing-plugin cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-cache-missing-"));
    try {
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "agent-hub"), { recursive: true });
      writeFileSync(join(cacheRoot, "agent-hub", "history.json"), "{}");

      await uninstallPluginWithLifecycle(
        "agent-hub",
        makeDeps("agent-hub", cacheRoot, new Error("Plugin not installed: agent-hub")),
      );

      expect(existsSync(join(cacheRoot, "agent-hub", "history.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes exact manifest-declared secret keys and all tracked auth partitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-state-"));
    try {
      const deps = makeDeps("com.example", join(root, ".cache"));

      await uninstallPluginWithLifecycle("com.example", deps);

      expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith(
        "com.example",
        new Set(["token"]),
      );
      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:com.example");
      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:com.example:tenant");
      expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith("com.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs durable marketplace removal inside the runtime generation barrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-order-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));

      await uninstallPluginWithLifecycle("agent-hub", deps);

      const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
      const barrierOrder = deps.pluginRuntime.removePluginWithCommit.mock.invocationCallOrder[0];
      expect(barrierOrder).toBeLessThan(uninstallOrder);
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
        "agent-hub",
        expect.any(Function),
      );
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains detached stop-hook mutations before deleting durable plugin state", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-detached-"));
    try {
      const order: string[] = [];
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      let releaseWrite!: () => void;
      let writeEntered!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const writeStarted = new Promise<void>((resolve) => { writeEntered = resolve; });
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        void withPluginInstallLock("agent-hub", async () => {
          order.push("write:start");
          writeEntered();
          await writeGate;
          order.push("write:end");
        });
        await writeStarted;
        order.push("remove:end");
        return commit();
      });
      deps.settingsService.deletePluginConfig.mockImplementationOnce(async () => {
        order.push("config:delete");
      });

      const uninstall = uninstallPluginWithLifecycle("agent-hub", deps);
      await writeStarted;
      await Promise.resolve();
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();

      releaseWrite();
      await uninstall;
      expect(order).toEqual(["write:start", "remove:end", "write:end", "config:delete"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes an install alias under the canonical id and clears late config state", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-alias-"));
    try {
      const order: string[] = [];
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "canonical-plugin"), { recursive: true });
      await mkdir(join(cacheRoot, "marketplace-alias"), { recursive: true });
      writeFileSync(join(cacheRoot, "canonical-plugin", "generation"), "old");
      writeFileSync(join(cacheRoot, "marketplace-alias", "receipt"), "old");
      const deps = makeDeps("canonical-plugin", cacheRoot);
      deps.pluginRuntime.resolvePluginId.mockReturnValue("canonical-plugin");
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        await withPluginInstallLock("canonical-plugin", async () => {
          order.push("stop-write");
        });
        order.push("remove");
        return commit();
      });
      deps.pluginRuntime.clearConfigOverride.mockImplementationOnce(() => {
        order.push("override:clear");
      });
      deps.settingsService.deletePluginConfig.mockImplementationOnce(async () => {
        order.push("settings:clear");
      });

      await uninstallPluginWithLifecycle("marketplace-alias", deps);

      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
        "canonical-plugin",
        expect.any(Function),
      );
      expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("marketplace-alias");
      expect(deps.pluginRuntime.clearConfigOverride).toHaveBeenCalledWith("canonical-plugin");
      expect(order).toEqual([
        "stop-write",
        "remove",
        "override:clear",
        "settings:clear",
      ]);
      expect(existsSync(join(cacheRoot, "canonical-plugin"))).toBe(false);
      expect(existsSync(join(cacheRoot, "marketplace-alias"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the active generation after EACCES and completes cleanup on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-restore-"));
    try {
      const failure = Object.assign(new Error("locked by Windows handle"), { code: "EACCES" });
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      deps.pluginMarketplace.uninstall
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ pluginId: "agent-hub", uninstalled: true as const });

      await expect(uninstallPluginWithLifecycle("agent-hub", deps)).rejects.toBe(failure);

      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledTimes(1);
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      expect(deps.emitHostEvent).not.toHaveBeenCalled();

      await expect(uninstallPluginWithLifecycle("agent-hub", deps)).resolves.toEqual({
        pluginId: "agent-hub",
        uninstalled: true,
      });
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledTimes(2);
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("agent-hub");
      expect(deps.emitHostEvent).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original durable uninstall failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-fail-"));
    try {
      const uninstallFailure = new Error("uninstall failed");
      const deps = makeDeps("agent-hub", join(root, ".cache"), uninstallFailure);

      const error = await uninstallPluginWithLifecycle("agent-hub", deps).catch((caught) => caught);
      expect(error).toBe(uninstallFailure);
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers residual cleanup after a committed retirement failure until boot recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-retirement-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      const retirementFailure = new Error("generation retirement failed");
      deps.pluginMarketplace.getInstalledVersion
        .mockResolvedValueOnce("1.0.0")
        .mockResolvedValue(null);
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        await commit();
        throw retirementFailure;
      });

      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).rejects.toThrow(/pending runtime retirement/);

      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      expect(deps.settingsService.deletePluginSecrets).not.toHaveBeenCalled();
      expect(deps.clearAuthPartitionService).not.toHaveBeenCalled();
      expect(deps.forgetPluginAuthPartitionsService).not.toHaveBeenCalled();
      expect(deps.emitHostEvent).not.toHaveBeenCalled();
      const pending = JSON.parse(
        await readFile(
          join(root, ".cache", "plugin-uninstall-cleanup.json"),
          "utf8",
        ),
      );
      expect(pending.cleanups).toMatchObject([{
        pluginId: "agent-hub",
        registryRemovalCommitted: true,
        runtimeRetirementComplete: false,
      }]);

      await expect(
        recoverPendingPluginUninstallCleanups(deps),
      ).resolves.toEqual([]);
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith(
        "agent-hub",
      );
      expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalled();
      expect(deps.clearAuthPartitionService).toHaveBeenCalledTimes(2);
      expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith(
        "agent-hub",
      );
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledOnce();
      const completed = JSON.parse(
        await readFile(
          join(root, ".cache", "plugin-uninstall-cleanup.json"),
          "utf8",
        ),
      );
      expect(completed.cleanups).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels the prepared cleanup plan when removal fails before durable commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-precommit-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      const precommitFailure = new Error("runtime barrier failed");
      deps.pluginRuntime.removePluginWithCommit.mockRejectedValueOnce(
        precommitFailure,
      );

      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).rejects.toBe(precommitFailure);

      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      expect(deps.clearAuthPartitionService).not.toHaveBeenCalled();
      expect(deps.emitHostEvent).not.toHaveBeenCalled();
      const journal = JSON.parse(
        await readFile(
          join(root, ".cache", "plugin-uninstall-cleanup.json"),
          "utf8",
        ),
      );
      expect(journal.cleanups).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checkpoints each auth partition and resumes cleanup without removing runtime twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-resume-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      deps.pluginMarketplace.getInstalledVersion
        .mockResolvedValueOnce("1.0.0")
        .mockResolvedValue(null);
      deps.clearAuthPartitionService.mockImplementation(
        async (partition: string) => {
          if (partition === "persist:plugin-auth:agent-hub") {
            throw new Error("partition locked");
          }
        },
      );

      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).rejects.toThrow(/incomplete post-commit cleanup/);

      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith(
        "persist:plugin-auth:agent-hub:tenant",
      );
      expect(deps.forgetPluginAuthPartitionsService).not.toHaveBeenCalled();
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledTimes(1);
      expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledTimes(1);
      expect(deps.emitHostEvent).not.toHaveBeenCalled();

      deps.clearAuthPartitionService.mockResolvedValue(undefined);
      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).resolves.toEqual({
        pluginId: "agent-hub",
        uninstalled: true,
      });

      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledTimes(1);
      expect(deps.clearAuthPartitionService).toHaveBeenCalledTimes(3);
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledTimes(1);
      expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledTimes(1);
      expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledTimes(1);
      expect(deps.emitHostEvent).toHaveBeenCalledWith(
        "plugin.uninstalled",
        { pluginId: "agent-hub" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably merges auth partitions observed after the initial cleanup plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-late-auth-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      const base = "persist:plugin-auth:agent-hub";
      const late = `${base}:late-tenant`;
      const partitions = [base];
      deps.listPluginAuthPartitionsService.mockImplementation(
        () => [...partitions],
      );
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        partitions.push(late);
        return commit();
      });

      await uninstallPluginWithLifecycle("agent-hub", deps);

      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith(base);
      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith(late);
      expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains cleanup ownership when lock drain times out and resumes after settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-uninstall-drain-timeout-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      deps.pluginMarketplace.getInstalledVersion
        .mockResolvedValueOnce("1.0.0")
        .mockResolvedValue(null);
      deps.drainPluginInstallLockOperationsService
        .mockRejectedValueOnce(
          Object.assign(new Error("detached mutation did not settle"), {
            code: "plugin-lifecycle-drain-timeout",
          }),
        )
        .mockResolvedValue(undefined);

      const firstError = await uninstallPluginWithLifecycle(
        "agent-hub",
        deps,
      ).catch((error) => error);
      expect(firstError).toBeInstanceOf(AggregateError);
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      const pending = JSON.parse(
        await readFile(
          join(root, ".cache", "plugin-uninstall-cleanup.json"),
          "utf8",
        ),
      );
      expect(pending.cleanups).toHaveLength(1);

      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).resolves.toEqual({ pluginId: "agent-hub", uninstalled: true });
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledOnce();
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks reinstall until a committed residual cleanup can finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-install-cleanup-gate-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      deps.pluginMarketplace.getInstalledVersion
        .mockResolvedValueOnce("1.0.0")
        .mockResolvedValue(null);
      deps.clearAuthPartitionService.mockRejectedValueOnce(
        new Error("partition still busy"),
      );
      await expect(
        uninstallPluginWithLifecycle("agent-hub", deps),
      ).rejects.toThrow(/incomplete post-commit cleanup/);

      deps.clearAuthPartitionService.mockRejectedValueOnce(
        new Error("partition still busy"),
      );
      await expect(
        ensurePluginStateReadyForInstall("agent-hub", deps),
      ).rejects.toThrow(/cleanup pending/);

      deps.clearAuthPartitionService.mockResolvedValue(undefined);
      await expect(
        ensurePluginStateReadyForInstall("agent-hub", deps),
      ).resolves.toBeUndefined();
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
