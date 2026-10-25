import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginUninstallCleanupJournal,
} from "../plugin-uninstall-cleanup-journal.js";

const roots: string[] = [];

function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ave-uninstall-journal-"));
  roots.push(root);
  return {
    root,
    path: join(root, "plugin-uninstall-cleanup.json"),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("PluginUninstallCleanupJournal", () => {
  it("round-trips captured retirement and rejects damage without discarding pending cleanup", async () => {
    const { path } = fixture();
    const retirement = { config: { disabled: ["mail"] }, enabled: true, sourceId: "fixture", retiredAtAppVersion: "0.12.0",
      successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] }, consumedBy: [] };
    const journal = new PluginUninstallCleanupJournal(path);
    const input = { pluginId: "retired-fixture", installPluginId: "retired-fixture", secretKeys: [], authPartitions: [], cleanupCache: false, retirement };
    journal.prepare(input);
    retirement.config.disabled.push("changed-after-prepare");
    const loaded = new PluginUninstallCleanupJournal(path);
    expect(loaded.find(input.pluginId)?.retirement?.config).toEqual({ disabled: ["mail"] });
    const returned = loaded.find(input.pluginId)!;
    returned.retirement!.consumedBy.push("changed-after-read");
    expect(loaded.find(input.pluginId)?.retirement?.consumedBy).toEqual([]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.version).toBe(4);
    persisted.cleanups[0].retirement.successors.plugins[0].anySource = false;
    await writeFile(path, JSON.stringify(persisted));
    expect(() => new PluginUninstallCleanupJournal(path)).toThrow("invalid plugin uninstall cleanup journal record");
  });

  it("persists phase and per-partition progress across process restart", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "sampleportal",
      installPluginId: "sampleportal",
      secretKeys: ["apiKey"],
      authPartitions: [
        "persist:plugin-auth:sampleportal",
        "persist:plugin-auth:sampleportal:tenant",
      ],
      cleanupCache: true,
    });
    journal.beginAttempt("sampleportal");
    journal.completePhase("sampleportal", "config");
    journal.completeAuthPartition(
      "sampleportal",
      "persist:plugin-auth:sampleportal:tenant",
    );

    const reloaded = new PluginUninstallCleanupJournal(path);
    expect(reloaded.find("sampleportal")).toMatchObject({
      pluginId: "sampleportal",
      attempts: 1,
      completedPhases: ["config"],
      completedAuthPartitions: [
        "persist:plugin-auth:sampleportal:tenant",
      ],
    });
  });

  it("rejects auth partitions outside the plugin-owned namespace", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);

    expect(() =>
      journal.prepare({
        pluginId: "sampleportal",
        installPluginId: "sampleportal",
        secretKeys: [],
        authPartitions: ["persist:plugin-auth:other-plugin"],
        cleanupCache: false,
      })).toThrow(/invalid plugin uninstall cleanup plan/);
    expect(journal.list()).toEqual([]);
  });

  it("fails loudly on malformed durable records", async () => {
    const { path } = fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cleanups: [{
          pluginId: "sampleportal",
          installPluginId: "sampleportal",
          secretKeys: [],
          authPartitions: ["persist:default"],
          cleanupCache: true,
          recordedAt: new Date(0).toISOString(),
          attempts: 0,
          completedPhases: [],
          completedAuthPartitions: [],
        }],
      }),
    );

    expect(() => new PluginUninstallCleanupJournal(path)).toThrow(
      /invalid plugin uninstall cleanup journal record/,
    );
  });

  it("migrates a version-2 record with runtime retirement unproven", async () => {
    const { path } = fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        cleanups: [{
          pluginId: "sampleportal",
          installPluginId: "sampleportal",
          secretKeys: [],
          authPartitions: ["persist:plugin-auth:sampleportal"],
          cleanupCache: true,
          registryRemovalCommitted: true,
          recordedAt: new Date(0).toISOString(),
          attempts: 0,
          completedPhases: [],
          completedAuthPartitions: [],
        }],
      }),
    );

    expect(
      new PluginUninstallCleanupJournal(path).find("sampleportal"),
    ).toMatchObject({
      registryRemovalCommitted: true,
      runtimeRetirementComplete: false,
    });
  });

  it("stores cleanup keys and phases without secret values or raw failures", async () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "sampleportal",
      installPluginId: "sampleportal",
      secretKeys: ["checkinToken"],
      authPartitions: ["persist:plugin-auth:sampleportal"],
      cleanupCache: false,
    });
    journal.beginAttempt("sampleportal");

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("checkinToken");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("EPERM: operator home path");
  });

  it("retains independent cleanup ownership for multiple plugins", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    for (const pluginId of ["sampleportal", "samplehub"]) {
      journal.prepare({
        pluginId,
        installPluginId: pluginId,
        secretKeys: [],
        authPartitions: [
          `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
        ],
        cleanupCache: true,
      });
    }

    expect(
      new PluginUninstallCleanupJournal(path)
        .list()
        .map((record) => record.pluginId)
        .sort(),
    ).toEqual(["samplehub", "sampleportal"]);
  });

  it("durably merges late auth partitions and reopens tracker cleanup", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "sampleportal",
      installPluginId: "sampleportal",
      secretKeys: [],
      authPartitions: ["persist:plugin-auth:sampleportal"],
      cleanupCache: false,
    });
    journal.completeAuthPartition("sampleportal", "persist:plugin-auth:sampleportal");
    journal.completePhase("sampleportal", "auth-tracker");

    journal.mergeAuthPartitions("sampleportal", [
      "persist:plugin-auth:sampleportal:late",
    ]);
    expect(new PluginUninstallCleanupJournal(path).find("sampleportal")).toMatchObject({
      authPartitions: [
        "persist:plugin-auth:sampleportal",
        "persist:plugin-auth:sampleportal:late",
      ],
      completedAuthPartitions: ["persist:plugin-auth:sampleportal"],
      completedPhases: [],
    });
    expect(() =>
      journal.mergeAuthPartitions("sampleportal", [
        "persist:plugin-auth:other-plugin",
      ])).toThrow(/invalid plugin uninstall auth partition plan/);
  });

  it("checkpoints registry removal and cache ownership in the durable record", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "sampleportal",
      installPluginId: "sampleportal",
      secretKeys: [],
      authPartitions: [],
      cleanupCache: false,
    });

    journal.markRegistryRemovalCommitted("sampleportal", { cleanupCache: true });
    journal.markRuntimeRetirementComplete("sampleportal");
    expect(new PluginUninstallCleanupJournal(path).find("sampleportal")).toMatchObject({
      registryRemovalCommitted: true,
      runtimeRetirementComplete: true,
      cleanupCache: true,
    });
  });
});

it("holds both canonical and install identities until the durable cleanup is complete", () => {
  const { path } = fixture();
  const journal = new PluginUninstallCleanupJournal(path);
  expect(journal.has("retired-plugin")).toBe(false);
  journal.prepare({ pluginId: "retired-plugin", installPluginId: "retired-package", secretKeys: [], authPartitions: [], cleanupCache: false });
  const reloaded = new PluginUninstallCleanupJournal(path);
  expect(reloaded.has("retired-plugin")).toBe(true);
  expect(reloaded.has("retired-package")).toBe(true);
  expect(reloaded.has("other-plugin")).toBe(false);
  reloaded.complete("retired-plugin");
  const completed = new PluginUninstallCleanupJournal(path);
  expect(completed.has("retired-plugin")).toBe(false);
  expect(completed.has("retired-package")).toBe(false);
});
