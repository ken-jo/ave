import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePluginTreeNowOrAtBoot, tombstoneAndDeferredRemove, TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";

describe("tombstoneAndDeferredRemove", () => {
  let pluginsRoot: string;
  let installedDir: string;

  beforeEach(async () => {
    pluginsRoot = await mkdtemp(join(tmpdir(), "tombstone-fs-"));
    installedDir = join(pluginsRoot, "local-indexer");
    await mkdir(installedDir);
    await writeFile(join(installedDir, "plugin.json"), JSON.stringify({ id: "local-indexer" }));
    await mkdir(join(installedDir, "data"));
    await writeFile(join(installedDir, "data", "fts5.sqlite"), "stub");
  });

  afterEach(async () => {
    await rm(pluginsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("renames the install dir into +tombstones+/<id>-<ts>-<rand>", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 1715000000000,
      randomSuffix: () => "deadbeef",
    });

    expect(tombstone).toBe(join(pluginsRoot, TOMBSTONE_SUBDIR, "local-indexer-1715000000000-deadbeef"));
    await expect(stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the tombstone subdir if missing (idempotent on repeat)", async () => {
    await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 1,
      randomSuffix: () => "a",
    });
    const second = join(pluginsRoot, "second-plugin");
    await mkdir(second);
    await writeFile(join(second, "plugin.json"), "{}");
    const tombstone2 = await tombstoneAndDeferredRemove(second, pluginsRoot, {
      now: () => 2,
      randomSuffix: () => "b",
    });
    expect(tombstone2).toBe(join(pluginsRoot, TOMBSTONE_SUBDIR, "second-plugin-2-b"));
  });

  it("returns null when the install dir is already gone (ENOENT)", async () => {
    await rm(installedDir, { recursive: true, force: true });

    const result = await tombstoneAndDeferredRemove(installedDir, pluginsRoot);

    expect(result).toBeNull();
  });

  it("eventually rms the tombstone (deferred rm completes)", async () => {
    const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 9999,
      randomSuffix: () => "x",
    });
    expect(tombstone).not.toBeNull();

    await vi.waitFor(
      async () => {
        const remainingInTombstones = await readdir(join(pluginsRoot, TOMBSTONE_SUBDIR));
        expect(remainingInTombstones).toEqual([]);
      },
      { timeout: 2_000, interval: 25 },
    );
  });

  it("does not throw when the deferred rm callback is omitted", async () => {
    await expect(
      tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
        now: () => 42,
        randomSuffix: () => "z",
      }),
    ).resolves.toMatch(/local-indexer-42-z$/);
  });

  const openHandleRenameIt = process.platform === "win32" ? it.skip : it;
  openHandleRenameIt("renames even with an open file handle inside on POSIX", async () => {
    // macOS/Linux allow rename of a directory with open child files.
    const fh = await open(join(installedDir, "data", "fts5.sqlite"), "r");
    try {
      const tombstone = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
        now: () => 7,
        randomSuffix: () => "w",
      });
      expect(tombstone).toMatch(/local-indexer-7-w$/);
      await expect(stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fh.close();
    }
  });

  const windowsOpenHandleIt = process.platform === "win32" ? it : it.skip;
  windowsOpenHandleIt("surfaces EPERM when an open Windows handle blocks rename", async () => {
    const fh = await open(join(installedDir, "data", "fts5.sqlite"), "r");
    try {
      await expect(
        tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
          now: () => 7,
          randomSuffix: () => "w",
        }),
      ).rejects.toMatchObject({ code: "EPERM" });
      await expect(stat(installedDir)).resolves.toBeTruthy();
    } finally {
      await fh.close();
    }
  });

  it("uses random suffix to avoid same-millisecond collision", async () => {
    // Random suffixes prevent same-millisecond uninstall collisions.
    const second = join(pluginsRoot, "second-plugin");
    await mkdir(second);
    await writeFile(join(second, "plugin.json"), "{}");

    const t1 = await tombstoneAndDeferredRemove(installedDir, pluginsRoot, {
      now: () => 100,
      randomSuffix: () => "aaaa",
    });
    const t2 = await tombstoneAndDeferredRemove(second, pluginsRoot, {
      now: () => 100,
      randomSuffix: () => "bbbb",
    });
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/-100-aaaa$/);
    expect(t2).toMatch(/-100-bbbb$/);
  });
});

// A renamed directory remains writable through a live bind mount; only boot may sweep it.
describe("confined-process phase and plugin tree removal", () => {
  let pluginsRoot: string;
  let tree: string;

  beforeEach(async () => {
    _resetConfinedProcessPhaseForTests();
    pluginsRoot = await mkdtemp(join(tmpdir(), "tree-removal-"));
    tree = join(pluginsRoot, "local-indexer");
    await mkdir(join(tree, "data"), { recursive: true });
    await writeFile(join(tree, "data", "state"), "live");
  });

  afterEach(async () => {
    _resetConfinedProcessPhaseForTests();
    await rm(pluginsRoot, { recursive: true, force: true });
  });

  it("removes the tree now before any confined process can run", async () => {
    const removeNow = vi.fn(async (path: string) => { await rm(path, { recursive: true, force: true }); });
    expect(await removePluginTreeNowOrAtBoot(tree, pluginsRoot, removeNow)).toBe("removed");
    expect(removeNow).toHaveBeenCalledWith(tree);
    await expect(stat(tree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tombstones the tree, deleting nothing, once confined processes may run", async () => {
    noteConfinedProcessesMayRun();
    const dataIno = (await stat(join(tree, "data"))).ino;
    const removeNow = vi.fn(async () => undefined);
    expect(await removePluginTreeNowOrAtBoot(tree, pluginsRoot, removeNow)).toBe("deferred");
    expect(removeNow).not.toHaveBeenCalled();
    const [tombstone] = await readdir(join(pluginsRoot, TOMBSTONE_SUBDIR));
    expect((await stat(join(pluginsRoot, TOMBSTONE_SUBDIR, tombstone!, "data"))).ino).toBe(dataIno);
  });

  it("leaves a tombstone for the boot sweep once confined processes may run", async () => {
    noteConfinedProcessesMayRun();
    const tombstone = await tombstoneAndDeferredRemove(tree, pluginsRoot);
    await new Promise((settle) => setTimeout(settle, 50));
    expect((await stat(join(tombstone!, "data", "state"))).isFile()).toBe(true);
  });
});
