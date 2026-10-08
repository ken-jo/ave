import { existsSync, lstatSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lstat` passes through, except for a path a case marks as swapped: there it
// reports the directory that used to be at that path, which is what a swap
// between the walk's `lstat` and its next call looks like from inside.
const staleLstat = vi.hoisted(() => new Map<string, unknown>());
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: async (path: string, ...rest: unknown[]) =>
      staleLstat.get(path) ?? (real.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest),
  };
});

import type { PluginPaths } from "../plugin-paths.js";
import {
  createRemovalTransaction,
  markRemovalTransactionRegistryCommitted,
  reconcileRemovalTransaction,
  reconcileRemovalTransactions,
  restoreOwnerAccess,
  stageRemovalTransaction,
} from "../plugin-removal-transaction.js";
import { updatePluginRegistry } from "../registry.js";
import { readPluginDataFixture, seedPluginDataFixture } from "./test-helpers.js";

describe("durable plugin removal transactions", () => {
  let root: string;
  let paths: PluginPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-removal-tx-"));
    paths = {
      pluginsRoot: join(root, "plugins"),
      registryPath: join(root, "plugins", "registry.json"),
      cacheRoot: join(root, "plugins", ".cache"),
    };
    await mkdir(paths.pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(ids = ["alpha", "beta"]) {
    const entries = ids.map((id) => ({ id, manifestPath: `${id}/plugin.json`, enabled: true }));
    for (const id of ids) {
      await mkdir(join(paths.pluginsRoot, id), { recursive: true });
      await writeFile(join(paths.pluginsRoot, id, "plugin.json"), JSON.stringify({ id }));
    }
    await writeFile(paths.registryPath, `${JSON.stringify({ version: 1, plugins: entries })}\n`);
    return entries;
  }

  it.each([1, 2])("restores every staged path after a crash following rename %i", async (renameCount) => {
    const before = await seed();
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["alpha", "beta"],
      registryBefore: before,
      registryAfter: [],
      originals: before.map((entry) => ({ pluginId: entry.id, path: join(paths.pluginsRoot, entry.id) })),
    });
    for (const mapping of journal.mappings.slice(0, renameCount)) {
      await rename(mapping.originalPath, mapping.stagedPath);
    }

    await expect(reconcileRemovalTransaction(paths, journal.transactionId)).resolves.toBe("restored");
    expect(existsSync(join(paths.pluginsRoot, "alpha", "plugin.json"))).toBe(true);
    expect(existsSync(join(paths.pluginsRoot, "beta", "plugin.json"))).toBe(true);
  });

  it("finishes staged cleanup after a registry commit crash before phase persistence", async () => {
    const before = await seed(["alpha"]);
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    await stageRemovalTransaction(paths, journal);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      registry.plugins = [];
    });

    await expect(reconcileRemovalTransaction(paths, journal.transactionId)).resolves.toBe("cleaned");
    expect(existsSync(journal.mappings[0]!.stagedPath)).toBe(false);
  });

  it("removes the plugin's data directory together with its root on uninstall", async () => {
    const before = await seed(["alpha"]);
    await seedPluginDataFixture(join(paths.pluginsRoot, "alpha"));
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    await stageRemovalTransaction(paths, journal);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      registry.plugins = [];
    });
    await markRemovalTransactionRegistryCommitted(paths, journal);

    await expect(reconcileRemovalTransaction(paths, journal.transactionId)).resolves.toBe("cleaned");
    expect(existsSync(join(paths.pluginsRoot, "alpha"))).toBe(false);
    expect((await readPluginDataFixture(join(paths.pluginsRoot, "alpha"))).size).toBe(0);
  });

  it("finishes staged cleanup after the committed phase is durable", async () => {
    const before = await seed(["alpha"]);
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    await stageRemovalTransaction(paths, journal);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      registry.plugins = [];
    });
    await markRemovalTransactionRegistryCommitted(paths, journal);

    await expect(reconcileRemovalTransaction(paths, journal.transactionId)).resolves.toBe("cleaned");
  });

  it("retries reverse rename failures and retains the durable mapping when unresolved", async () => {
    const before = await seed(["alpha"]);
    const journal = await createRemovalTransaction(paths, {
      kind: "install-rollback",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    await stageRemovalTransaction(paths, journal);
    const renamePath = vi.fn(async () => {
      throw Object.assign(new Error("locked"), { code: "EACCES" });
    });

    await expect(reconcileRemovalTransaction(paths, journal.transactionId, {
      renamePath,
      retry: { attempts: 3, sleep: async () => undefined },
    })).rejects.toThrow("locked");
    expect(renamePath).toHaveBeenCalledTimes(3);
    expect(existsSync(journal.mappings[0]!.stagedPath)).toBe(true);
    expect(existsSync(join(dirname(dirname(journal.mappings[0]!.stagedPath)), "journal.json"))).toBe(true);
  });

  it("fails closed on a tampered staged path escape without renaming or deleting anything", async () => {
    const before = await seed(["alpha"]);
    const journal = await createRemovalTransaction(paths, {
      kind: "quarantine",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    await stageRemovalTransaction(paths, journal);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    const txDir = dirname(dirname(journal.mappings[0]!.stagedPath));
    const raw = JSON.parse(await readFile(join(txDir, "journal.json"), "utf-8")) as typeof journal;
    raw.mappings[0]!.stagedPath = outside;
    await writeFile(join(txDir, "journal.json"), JSON.stringify(raw));

    await expect(reconcileRemovalTransactions(paths)).resolves.toEqual({
      restored: [],
      cleaned: [],
      unresolved: [{
        transactionId: journal.transactionId,
        reason: "Unsafe or ambiguous removal transaction mapping",
      }],
    });
    expect(await readFile(join(outside, "keep.txt"), "utf-8")).toBe("keep");
    expect(existsSync(journal.mappings[0]!.stagedPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a preexisting transaction namespace symlink without writing outside the plugin root",
    async () => {
      const before = await seed(["alpha"]);
      const outside = join(root, "outside-transactions");
      await mkdir(outside);
      await symlink(outside, join(paths.pluginsRoot, "+transactions+"), "dir");

      await expect(createRemovalTransaction(paths, {
        kind: "uninstall",
        pluginIds: ["alpha"],
        registryBefore: before,
        registryAfter: [],
        originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
      })).rejects.toThrow("Unsafe removal transaction namespace");
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("rejects a journal symlink and preserves its target", async () => {
    const before = await seed(["alpha"]);
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["alpha"],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId: "alpha", path: join(paths.pluginsRoot, "alpha") }],
    });
    const txDir = dirname(dirname(journal.mappings[0]!.stagedPath));
    const path = join(txDir, "journal.json");
    const outside = join(root, "outside-journal.json");
    await writeFile(outside, JSON.stringify(journal));
    await rm(path);
    await symlink(outside, path);

    const result = await reconcileRemovalTransactions(paths);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ transactionId: journal.transactionId }),
    ]);
    expect(await readFile(outside, "utf-8")).toBe(JSON.stringify(journal));
  });
});

describe("restoring owner access before a staged plugin tree is removed", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ave-owner-access-"));
    staleLstat.clear();
  });
  afterEach(async () => {
    staleLstat.clear();
    await chmod(join(root, "outside"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")(
    "opens an unreadable directory again, and leaves a link's target alone",
    async () => {
      const tree = join(root, "tree");
      const outside = join(root, "outside");
      await mkdir(join(tree, "locked", "deep"), { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(tree, "link"));
      await chmod(outside, 0o500);
      await chmod(join(tree, "locked"), 0o000);
      await restoreOwnerAccess(tree);
      expect(statSync(join(tree, "locked")).mode & 0o700).toBe(0o700);
      expect(statSync(outside).mode & 0o777).toBe(0o500);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a directory swapped for a link after its lstat, readable or not, instead of following it",
    async () => {
      const outside = join(root, "outside");
      await mkdir(outside);
      for (const mode of [0o500, 0o000]) {
        const swapped = join(root, `swapped-${mode.toString(8)}`);
        await mkdir(swapped);
        staleLstat.set(swapped, lstatSync(swapped));
        await rm(swapped, { recursive: true });
        await symlink(outside, swapped);
        await chmod(outside, mode);
        await expect(restoreOwnerAccess(swapped)).rejects.toMatchObject({ code: expect.stringMatching(/^(ELOOP|ENOTDIR)$/) });
        expect(lstatSync(outside).mode & 0o777).toBe(mode);
      }
    },
  );
});
