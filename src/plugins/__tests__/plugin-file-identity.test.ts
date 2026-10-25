import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const identities = vi.hoisted(() => ({
  linked: new Map<string, bigint>(),
  opened: new Map<string, bigint[]>(),
  reads: [] as string[],
  chmods: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    lstat: async (path: Parameters<typeof real.lstat>[0], options?: { bigint?: boolean }) => {
      const entry = options?.bigint ? await real.lstat(path, { bigint: true }) : await real.lstat(path);
      const ino = identities.linked.get(String(path));
      return ino === undefined ? entry : Object.assign(Object.create(entry) as typeof entry, {
        dev: options?.bigint ? 11n : 11,
        ino: options?.bigint ? ino : Number(ino),
      });
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const path = String(args[0]);
      if (!identities.opened.has(path)) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") return async (options?: { bigint?: boolean }) => {
            const entry = options?.bigint ? await target.stat({ bigint: true }) : await target.stat();
            const sequence = identities.opened.get(path)!;
            const ino = sequence.length > 1 ? sequence.shift()! : sequence[0]!;
            return Object.assign(Object.create(entry) as typeof entry, {
              dev: options?.bigint ? 11n : 11,
              ino: options?.bigint ? ino : Number(ino),
            });
          };
          if (key === "readFile") return (...readArgs: Parameters<typeof target.readFile>) => {
            identities.reads.push(path);
            return target.readFile(...readArgs);
          };
          if (key === "chmod") return (...chmodArgs: Parameters<typeof target.chmod>) => {
            identities.chmods.push(path);
            return target.chmod(...chmodArgs);
          };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    statSync: (path: Parameters<typeof real.statSync>[0], options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
      const entry = options?.bigint
        ? real.statSync(path, { bigint: true, throwIfNoEntry: options.throwIfNoEntry })
        : real.statSync(path, { throwIfNoEntry: options?.throwIfNoEntry });
      const ino = identities.linked.get(String(path));
      return !entry || ino === undefined ? entry : Object.assign(Object.create(entry) as typeof entry, {
        dev: options?.bigint ? 11n : 11,
        ino: options?.bigint ? ino : Number(ino),
      });
    },
  };
});

import { capturePluginSandboxGrant, isPluginSandboxGrantCovered } from "../isolation/out-of-process-plugin.js";
import { carryPluginSocketDirs, migratePluginHostStorage } from "../plugin-storage-layout.js";
import { createRemovalTransaction, readRemovalTransactionJournal } from "../plugin-removal-transaction.js";
import { restoreOwnerAccess } from "../installed-entry-fs.js";
import type { PluginPaths } from "../plugin-paths.js";
import { _resetConfinedProcessPhaseForTests } from "../../lib/confined-process-phase.js";

const LARGE_INO = 2n ** 60n;

describe("plugin filesystem identity precision", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "plugin-identity-")));
    identities.linked.clear();
    identities.opened.clear();
    identities.reads = [];
    identities.chmods = [];
    _resetConfinedProcessPhaseForTests();
  });
  afterEach(async () => {
    identities.linked.clear();
    identities.opened.clear();
    _resetConfinedProcessPhaseForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("revokes a directory grant when its file id changes above numeric precision", () => {
    identities.linked.set(root, LARGE_INO);
    const grant = capturePluginSandboxGrant(root);
    expect(grant.identity).toEqual({ dev: 11n, ino: LARGE_INO });
    expect(isPluginSandboxGrantCovered(grant, dirname(root), root)).toBe(true);
    identities.linked.set(root, LARGE_INO + 1n);
    expect(isPluginSandboxGrantCovered(grant, dirname(root), root)).toBe(false);
  });

  it("skips a storage migration file replaced above numeric precision before opening", async () => {
    const pluginsRoot = join(root, "plugins");
    const plugin = join(pluginsRoot, "sample");
    await mkdir(join(plugin, "data"), { recursive: true });
    const source = join(plugin, "data", "value.json");
    await writeFile(source, "private state");
    identities.linked.set(source, LARGE_INO);
    identities.opened.set(source, [LARGE_INO + 1n]);
    const result = await migratePluginHostStorage(pluginsRoot);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toContainEqual({ path: source, reason: "replaced while it was being copied" });
    expect(identities.reads).not.toContain(source);
    expect(existsSync(join(plugin, "storage", "value.json"))).toBe(false);
  });

  it("refuses distinct socket entries whose file ids differ above numeric precision", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(join(from, "sockets"), { recursive: true });
    await mkdir(join(to, "sockets"), { recursive: true });
    const source = join(from, "sockets", "live.sock");
    const target = join(to, "sockets", "live.sock");
    await writeFile(source, "source");
    await writeFile(target, "target");
    identities.linked.set(source, LARGE_INO);
    identities.linked.set(target, LARGE_INO + 1n);
    await expect(carryPluginSocketDirs(from, to, { onConflict: "reject" })).rejects.toThrow(/both roots hold/);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  async function makeJournal(): Promise<{ paths: PluginPaths; transactionId: string; path: string }> {
    const paths = { pluginsRoot: join(root, "plugins"), registryPath: join(root, "plugins", "registry.json"), cacheRoot: join(root, "cache") };
    await mkdir(paths.pluginsRoot);
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: ["sample"],
      registryBefore: [{ id: "sample", manifestPath: "sample/plugin.json", enabled: true }],
      registryAfter: [],
      originals: [{ pluginId: "sample", path: join(paths.pluginsRoot, "sample") }],
    });
    const path = join(paths.pluginsRoot, "+transactions+", "removals", journal.transactionId, "journal.json");
    return { paths, transactionId: journal.transactionId, path };
  }

  it("refuses a removal journal replaced above numeric precision before reading", async () => {
    const { paths, transactionId, path } = await makeJournal();
    identities.linked.set(path, LARGE_INO + 1n);
    identities.opened.set(path, [LARGE_INO]);
    await expect(readRemovalTransactionJournal(paths, transactionId)).rejects.toThrow(/size or ownership/);
    expect(identities.reads).not.toContain(path);
  });

  it("refuses a removal journal whose file id changes above numeric precision while reading", async () => {
    const { paths, transactionId, path } = await makeJournal();
    identities.linked.set(path, LARGE_INO);
    identities.opened.set(path, [LARGE_INO, LARGE_INO + 1n]);
    await expect(readRemovalTransactionJournal(paths, transactionId)).rejects.toThrow(/changed while reading/);
    expect(identities.reads).toContain(path);
  });

  it.skipIf(process.platform === "win32")("refuses owner access restoration on a directory replaced above numeric precision", async () => {
    identities.linked.set(root, LARGE_INO);
    identities.opened.set(root, [LARGE_INO + 1n]);
    await expect(restoreOwnerAccess(root)).rejects.toThrow(/changed while its access was being restored/);
    expect(identities.chmods).not.toContain(root);
  });
});
