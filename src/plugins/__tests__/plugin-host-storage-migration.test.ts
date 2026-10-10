/**
 * The boot migration that gives a plugin root its host-only `storage/`.
 *
 * Before the HostApi `storage` surface moved into `<root>/<id>/storage`, it
 * operated in `<root>/<id>/data` — the directory the confined child writes.
 * A file written through `storage` cannot be told apart from one the child
 * wrote, so the migration COPIES `data/` (regular files and directories only)
 * into `storage/` and leaves `data/` as it is. What is pinned here:
 *
 *  - what is copied and what is skipped (links, special files, hard links,
 *    files no storage value could be, unreadable entries);
 *  - it never follows a link — not one planted in `data/`, and not a parent
 *    swapped for one while the copy runs (macOS `O_NOFOLLOW_ANY`, Linux
 *    `/proc/self/fd`);
 *  - it is idempotent and crash-safe (`storage/` absent or complete);
 *  - it refuses to run once confined processes may run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One-shot: run `run` right before the module under test lstats `path`. */
const hooks = vi.hoisted(() => ({
  beforeLstat: undefined as { path: string; run: () => void } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (path: string, ...rest: unknown[]) => {
      const hook = hooks.beforeLstat;
      if (hook !== undefined && String(path) === hook.path) {
        hooks.beforeLstat = undefined;
        hook.run();
      }
      return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.lstat,
  };
});

import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_HOST_STORAGE_DIR_NAME,
  PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME,
  migratePluginHostStorage,
} from "../plugin-storage-layout.js";
import { FRAME_BYTES_MAX } from "../isolation/host-api-wire.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";
import { ensurePluginDataDir } from "../runtime/sandbox.js";
import { cleanupTmpDir, removeLinkOnly } from "../../__tests__/support/tmp-dir-teardown.js";

const posix = process.platform !== "win32";
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let scratch: string;
let pluginsRoot: string;
let outside: string;

beforeEach(() => {
  // Canonical, as the migration canonicalises the root it is handed.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ave-host-storage-migration-")));
  pluginsRoot = join(scratch, "plugins");
  outside = join(scratch, "outside");
  mkdirSync(pluginsRoot);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "host secret");
});

afterEach(async () => {
  hooks.beforeLstat = undefined;
  _resetConfinedProcessPhaseForTests();
  await cleanupTmpDir(scratch);
});

function dataOf(id: string): string {
  const dir = join(pluginsRoot, id, PLUGIN_DATA_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function storageOf(id: string): string {
  return join(pluginsRoot, id, PLUGIN_HOST_STORAGE_DIR_NAME);
}

/** Every file under `dir`, relative path → content. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), rel);
      else out[rel] = readFileSync(join(at, entry.name), "utf-8");
    }
  };
  walk(dir, "");
  return out;
}

describe("migratePluginHostStorage — what is copied", () => {
  it("copies the storage view, depth-2 keys included, and leaves data/ exactly as it was", async () => {
    const data = dataOf("lyra-mail");
    mkdirSync(join(data, "auth"));
    writeFileSync(join(data, "auth", "token-default.json"), "ENC(token)");
    writeFileSync(join(data, "email-watcher-state.json"), '{"cursor":1}');
    mkdirSync(join(data, "ui-storage"));
    writeFileSync(join(data, "ui-storage", "prefs.json"), '{"theme":"dark"}');
    mkdirSync(join(data, "empty"));

    const result = await migratePluginHostStorage(pluginsRoot);

    expect(result).toEqual({ migrated: [join(pluginsRoot, "lyra-mail")], skipped: [], failed: [] });
    const expected = {
      "auth/token-default.json": "ENC(token)",
      "email-watcher-state.json": '{"cursor":1}',
      "ui-storage/prefs.json": '{"theme":"dark"}',
    };
    expect(filesUnder(storageOf("lyra-mail"))).toEqual(expected);
    expect(statSync(join(storageOf("lyra-mail"), "empty")).isDirectory()).toBe(true);
    expect(filesUnder(data)).toEqual(expected);
    expect(existsSync(join(pluginsRoot, "lyra-mail", PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME))).toBe(false);
    if (posix) {
      expect(statSync(storageOf("lyra-mail")).mode & 0o777).toBe(0o700);
      expect(statSync(join(storageOf("lyra-mail"), "auth")).mode & 0o777).toBe(0o700);
      expect(statSync(join(storageOf("lyra-mail"), "auth", "token-default.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("skips what storage could never have written, and reports each", async () => {
    const data = dataOf("p");
    writeFileSync(join(data, "kept.json"), "{}");
    // A link to a file and a link to a directory, both pointing outside.
    symlinkSync(join(outside, "secret.txt"), join(data, "file-link"), "file");
    symlinkSync(outside, join(data, "dir-link"), dirLinkType);
    // A second name for an inode the plugin may not own.
    writeFileSync(join(scratch, "elsewhere.txt"), "not the plugin's");
    linkSync(join(scratch, "elsewhere.txt"), join(data, "hard-link"));
    // Larger than any storage value: it reached the host in one frame or not at all.
    writeFileSync(join(data, "index.bin"), "");
    truncateSync(join(data, "index.bin"), FRAME_BYTES_MAX + 1);
    if (posix) execFileSync("mkfifo", [join(data, "fifo")]);

    try {
      const result = await migratePluginHostStorage(pluginsRoot);

      expect(result.failed).toEqual([]);
      expect(result.migrated).toEqual([join(pluginsRoot, "p")]);
      expect(Object.fromEntries(result.skipped.map(({ path, reason }) => [path.slice(data.length + 1), reason]))).toEqual({
        "file-link": "a link",
        "dir-link": "a link",
        "hard-link": "hard-linked",
        "index.bin": "larger than any storage value",
        ...(posix ? { fifo: "not a regular file" } : {}),
      });
      expect(readdirSync(storageOf("p"))).toEqual(["kept.json"]);
      expect(readdirSync(outside)).toEqual(["secret.txt"]);
    } finally {
      removeLinkOnly(join(data, "dir-link"));
    }
  });

  it.runIf(posix && process.getuid?.() !== 0)(
    "skips an entry it cannot read rather than failing the root, so the plugin still loads",
    async () => {
      const data = dataOf("p");
      writeFileSync(join(data, "kept.json"), "{}");
      writeFileSync(join(data, "locked.json"), "{}");
      chmodSync(join(data, "locked.json"), 0o000);
      mkdirSync(join(data, "locked-dir"));
      chmodSync(join(data, "locked-dir"), 0o000);
      try {
        const result = await migratePluginHostStorage(pluginsRoot);

        expect(result.failed).toEqual([]);
        expect(result.skipped.map(({ path, reason }) => [path.slice(data.length + 1), reason]).sort()).toEqual([
          ["locked-dir", "unreadable: EACCES"],
          ["locked.json", "unreadable: EACCES"],
        ]);
        expect(readFileSync(join(storageOf("p"), "kept.json"), "utf-8")).toBe("{}");
        expect(() => ensurePluginDataDir("p", join(pluginsRoot, "p", "current"), pluginsRoot)).not.toThrow();
      } finally {
        chmodSync(join(data, "locked.json"), 0o600);
        chmodSync(join(data, "locked-dir"), 0o700);
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "skips an entry whose path fits under data/ but not under the longer staging name",
    async () => {
      const pathMax = process.platform === "darwin" ? 1024 : 4096;
      const data = dataOf("p");
      writeFileSync(join(data, "kept.json"), "{}");
      // Directories whose staging copies still fit, and one file that does not:
      // its path is under PATH_MAX in data/ and over it in the staging tree.
      const stagingGrowth = PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME.length - PLUGIN_DATA_DIR_NAME.length;
      const target = pathMax - 3;
      let dir = data;
      while (target - dir.length - 1 > 250) {
        dir = join(dir, "d".repeat(200));
        mkdirSync(dir);
      }
      const deep = join(dir, "f".repeat(target - dir.length - 1));
      expect(deep.length).toBeLessThan(pathMax);
      expect(deep.length + stagingGrowth).toBeGreaterThanOrEqual(pathMax);
      writeFileSync(deep, "deep");

      const result = await migratePluginHostStorage(pluginsRoot);

      expect(result.failed).toEqual([]);
      expect(result.migrated).toEqual([join(pluginsRoot, "p")]);
      expect(result.skipped).toEqual([{ path: deep, reason: expect.stringMatching(/^too long under storage\//) }]);
      expect(readFileSync(join(storageOf("p"), "kept.json"), "utf-8")).toBe("{}");
    },
  );

  it("leaves a root with no data/ alone; its first load creates both directories", async () => {
    mkdirSync(join(pluginsRoot, "fresh"));
    writeFileSync(join(pluginsRoot, "registry.json"), "{}");

    await expect(migratePluginHostStorage(pluginsRoot)).resolves.toEqual({ migrated: [], skipped: [], failed: [] });
    expect(existsSync(storageOf("fresh"))).toBe(false);

    ensurePluginDataDir("fresh", join(pluginsRoot, "fresh", "current"), pluginsRoot);
    expect(statSync(storageOf("fresh")).isDirectory()).toBe(true);
  });

  it("answers an absent plugins root with nothing to do", async () => {
    await expect(migratePluginHostStorage(join(scratch, "absent"))).resolves.toEqual({
      migrated: [], skipped: [], failed: [],
    });
  });
});

describe("migratePluginHostStorage — never follows a link", () => {
  /**
   * The copy's lstat of a file is where a swapped parent would be seen
   * THROUGH: `data/sub` becomes a link to `outside`, so lstat and open of
   * `data/sub/secret.txt` both reach the outside file, and the ino check
   * agrees with itself. Only `O_NOFOLLOW_ANY` (macOS) or the `/proc/self/fd`
   * path check (Linux) can refuse it. Windows has neither primitive; there the
   * migration relies on running before any confined process, as asserted below.
   */
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "refuses a parent swapped for a link between listing and copying, and copies nothing from outside",
    async () => {
      const data = dataOf("p");
      mkdirSync(join(data, "sub"));
      writeFileSync(join(data, "sub", "secret.txt"), "the plugin's own");
      const swapAt = join(data, "sub");
      hooks.beforeLstat = {
        path: join(swapAt, "secret.txt"),
        run: () => {
          renameSync(swapAt, `${swapAt}-moved`);
          symlinkSync(outside, swapAt, "dir");
        },
      };

      const result = await migratePluginHostStorage(pluginsRoot);

      expect(hooks.beforeLstat).toBeUndefined();
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([
        {
          path: join(swapAt, "secret.txt"),
          reason: process.platform === "darwin" ? "a link in its path" : "replaced while it was being copied",
        },
      ]);
      expect(existsSync(join(storageOf("p"), "sub", "secret.txt"))).toBe(false);
      expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("host secret");
      removeLinkOnly(swapAt);
    },
  );

  it("refuses to run once confined processes may run, and creates nothing", async () => {
    const data = dataOf("p");
    writeFileSync(join(data, "state.json"), "{}");
    noteConfinedProcessesMayRun();

    await expect(migratePluginHostStorage(pluginsRoot)).rejects.toThrow(
      /refusing to migrate host storage .* confined processes may already be running/,
    );
    expect(existsSync(storageOf("p"))).toBe(false);
    expect(existsSync(join(pluginsRoot, "p", PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME))).toBe(false);
  });
});

describe("migratePluginHostStorage — idempotent and crash-safe", () => {
  it("migrates a root once: a later boot copies nothing more into an existing storage/", async () => {
    const data = dataOf("p");
    writeFileSync(join(data, "state.json"), "{}");
    await migratePluginHostStorage(pluginsRoot);
    // Written by the child after the migration: data/ is its own from now on.
    writeFileSync(join(data, "later.json"), "{}");

    await expect(migratePluginHostStorage(pluginsRoot)).resolves.toEqual({ migrated: [], skipped: [], failed: [] });
    expect(readdirSync(storageOf("p"))).toEqual(["state.json"]);
  });

  it("discards what an interrupted migration staged and rebuilds it from data/", async () => {
    const data = dataOf("p");
    writeFileSync(join(data, "state.json"), '{"v":2}');
    const staging = join(pluginsRoot, "p", PLUGIN_HOST_STORAGE_MIGRATION_DIR_NAME);
    mkdirSync(join(staging, "half"), { recursive: true });
    writeFileSync(join(staging, "state.json"), '{"v":1}');
    if (posix) chmodSync(join(staging, "half"), 0o000);

    const result = await migratePluginHostStorage(pluginsRoot);

    expect(result.migrated).toEqual([join(pluginsRoot, "p")]);
    expect(filesUnder(storageOf("p"))).toEqual({ "state.json": '{"v":2}' });
    expect(existsSync(staging)).toBe(false);
  });

  it("records a root whose storage/ is not a directory as failed, and goes on with the others", async () => {
    writeFileSync(join(dataOf("broken"), "state.json"), "{}");
    writeFileSync(storageOf("broken"), "not a directory");
    writeFileSync(join(dataOf("fine"), "state.json"), "{}");

    const result = await migratePluginHostStorage(pluginsRoot);

    expect(result.failed).toEqual([
      { root: join(pluginsRoot, "broken"), error: expect.stringMatching(/storage is not a directory/) },
    ]);
    expect(result.migrated).toEqual([join(pluginsRoot, "fine")]);
  });

  it("is what a legacy root's load waits for: refused before, loaded after", async () => {
    writeFileSync(join(dataOf("legacy"), "session-snapshot.json"), "{}");
    const load = () => ensurePluginDataDir("legacy", join(pluginsRoot, "legacy", "current"), pluginsRoot);

    expect(load).toThrow(/storage is missing while .*data holds state/);
    await migratePluginHostStorage(pluginsRoot);
    expect(load).not.toThrow();
    expect(readFileSync(join(storageOf("legacy"), "session-snapshot.json"), "utf-8")).toBe("{}");
  });
});
