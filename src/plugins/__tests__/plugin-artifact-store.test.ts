/**
 * Phase 2 §FU#267 — PluginArtifactStore extracted from marketplace.ts.
 *
 * The store owns history journal + version cache + zip extract atomicity.
 * These tests lock the public contract that the orchestrator (and the
 * future MCP install consumer #259) relies on:
 *
 *   - history journal append + read round-trip
 *   - findRollbackTarget skips current version, skips entries without a
 *     cached manifest, returns null when nothing is replayable
 *   - cacheVersionFromManifest is best-effort (no throw on missing source)
 *
 * Download + extract paths are exercised by the existing `marketplace-
 * installer.test.ts` and the orchestrator's integration tests; here we
 * focus on the journaling primitives that previously lived in the god
 * class with no direct coverage.
 */
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Exercise the real retry ladder and filesystem operations through its
// existing sleep seam; these cases assert cleanup outcomes, not elapsed time.
vi.mock("../../lib/transient-fs-lock-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transient-fs-lock-retry.js")>();
  return {
    ...actual,
    retryOnTransientFsLock: <T>(
      operation: () => Promise<T>,
      options: Parameters<typeof actual.retryOnTransientFsLock>[1] = {},
    ) => actual.retryOnTransientFsLock(operation, { sleep: async () => undefined, ...options }),
  };
});

/**
 * One-shot hooks on `rename`; every other rename passes through, so the rest
 * of this suite runs against the real filesystem.
 */
const renameFault = vi.hoisted(() => ({
  /** Runs once, right after a rename into exactly this path succeeds. */
  afterRenameInto: undefined as { to: string; run: () => Promise<void> } | undefined,
  /** Fails the first rename whose destination matches. */
  failRename: undefined as ((to: string) => boolean) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (renameFault.failRename?.(String(to))) {
        renameFault.failRename = undefined;
        throw Object.assign(new Error(`EIO: injected move failure into '${String(to)}'`), { code: "EIO" });
      }
      await actual.rename(from, to);
      const after = renameFault.afterRenameInto;
      if (after && String(to) === after.to) {
        renameFault.afterRenameInto = undefined;
        await after.run();
      }
    },
  };
});
import {
  ArtifactRollbackError,
  assertSafeArtifactSlug,
} from "../plugin-artifact-store.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";
import { PLUGIN_SOCKET_DISCARD_DIR_NAME } from "../plugin-storage-layout.js";
import * as installedEntryFs from "../installed-entry-fs.js";
import { cleanupTmpDir, makeStore, makeTmpDir } from "./artifact-store-test-helpers.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";
import {
  PLUGIN_DATA_FIXTURE,
  agentPluginsDocument,
  materialiseCandidateRuntimeDirsForTest,
  readPluginDataFixture,
  seedPluginDataFixture,
} from "./test-helpers.js";

describe("PluginArtifactStore — history journal", () => {
  it("appendHistory + readHistory round-trip preserves order", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-03" });
      const history = await store.readHistory("acme");
      expect(history.map((e) => e.version)).toEqual(["1.0.0", "1.0.1", "2.0.0"]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("readHistory returns [] when history.json is absent", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const history = await store.readHistory("never-installed");
      expect(history).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });
});

describe("PluginArtifactStore — findRollbackTarget", () => {
  it("returns null when history is empty", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      expect(await store.findRollbackTarget("acme")).toBeNull();
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("returns the most recent prior version with a cached manifest", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-03" });

      // Cache manifests for 1.0.0 and 1.0.1 only — 2.0.0 is the current
      // (no snapshot yet) and 1.0.1 is the rollback target.
      for (const version of ["1.0.0", "1.0.1"]) {
        const dir = resolve(tmp, "cache", "acme", version);
        await mkdir(dir, { recursive: true });
        await writeFile(
          resolve(dir, "plugin.json"),
          JSON.stringify(agentPluginsDocument({ id: "acme", version, name: "acme", entry: "x" })));
      }
      const target = await store.findRollbackTarget("acme", "2.0.0");
      expect(target).toBe("1.0.1");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("skips the current version even if it's the newest history entry", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "2.0.0", installedAt: "2026-04-02" });
      for (const version of ["1.0.0", "2.0.0"]) {
        const dir = resolve(tmp, "cache", "acme", version);
        await mkdir(dir, { recursive: true });
        await writeFile(
          resolve(dir, "plugin.json"),
          JSON.stringify(agentPluginsDocument({ id: "acme", version, name: "acme", entry: "x" })));
      }
      // Pretend 2.0.0 is current — should pick 1.0.0.
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("skips history entries without a cached manifest on disk", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "1.0.1", installedAt: "2026-04-02" });
      // Only cache 1.0.0 — 1.0.1 history entry exists but has no manifest snapshot.
      const dir = resolve(tmp, "cache", "acme", "1.0.0");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({ id: "acme", version: "1.0.0", name: "acme", entry: "x" })));
      // Current is 2.0.0 (not in history) — rollback skips 1.0.1 (missing
      // snapshot) and returns 1.0.0.
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("skips empty / whitespace history versions (PR#44 Copilot guard)", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await store.appendHistory("acme", { version: "", installedAt: "2026-04-01" });
      await store.appendHistory("acme", { version: "  ", installedAt: "2026-04-02" });
      await store.appendHistory("acme", { version: "1.0.0", installedAt: "2026-04-03" });
      const dir = resolve(tmp, "cache", "acme", "1.0.0");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({ id: "acme", version: "1.0.0", name: "acme", entry: "x" })));
      expect(await store.findRollbackTarget("acme", "2.0.0")).toBe("1.0.0");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });
});

describe("PluginArtifactStore — installDirFor", () => {
  it("anchors install dirs under installRoot", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const dir = store.installDirFor("acme");
      expect(dir).toBe(resolve(tmp, "installed", "acme"));
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects slugs that could escape the install root", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      for (const slug of ["../evil", "/tmp/evil", "evil/path", ".hidden", "bad:slug", ""]) {
        expect(() => store.installDirFor(slug)).toThrow(/invalid artifact slug/);
      }
    } finally {
      await cleanupTmpDir(tmp);
    }
  });
});

describe("PluginArtifactStore — extractZip", () => {
  it("rejects archive symlink members before extraction", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("link", Buffer.from("outside"));
      const entry = zip.getEntry("link");
      if (!entry) throw new Error("test fixture entry missing");
      entry.attr = (0o120777 << 16) >>> 0;
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toThrow(/unsupported member kind/);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects case-colliding archive members", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("Hooks/a.json", Buffer.from("one"));
      zip.addFile("hooks/A.json", Buffer.from("two"));
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toThrow(/colliding entry/);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects Unicode case-folding archive member aliases", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("skills/Straße/SKILL.md", Buffer.from("one"));
      zip.addFile("SKILLS/STRASSE/skill.md", Buffer.from("two"));
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toThrow(/colliding entry/);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects unsafe slugs before staging zip contents", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "evil" }))));
      await expect(store.extractZip("../evil", zip.toBuffer())).rejects.toThrow(
        /invalid artifact slug/,
      );
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("restores the prior install dir when commit fails after promotion", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));

      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));

      await expect(
        store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          throw new Error("config registration failed");
        }),
      ).rejects.toThrow(/config registration failed/);

      const restored = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
      expect(restored.version).toBe("old");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("carries the plugin's data directory into the upgraded install byte-identical", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      await seedPluginDataFixture(installDir);
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));

      await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined);

      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("new");
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  // The candidate was activated before the commit, so it may still run with
  // the promoted root's paths in its confinement. Once confined processes may
  // run, the rollback tombstones that root instead of deleting it.
  it("tombstones the promoted root on rollback once confined processes may run", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      noteConfinedProcessesMayRun();

      await expect(store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
        throw new Error("config registration failed");
      })).rejects.toThrow(/config registration failed/);

      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("old");
      const tombstones = await readdir(resolve(installRoot, TOMBSTONE_SUBDIR));
      expect(tombstones).toHaveLength(1);
      expect(JSON.parse(await readFile(resolve(installRoot, TOMBSTONE_SUBDIR, tombstones[0]!, "plugin.json"), "utf-8")).version).toBe("new");
    } finally {
      _resetConfinedProcessPhaseForTests();
      await cleanupTmpDir(tmp);
    }
  });

  // After a successful update the predecessor's root is payload only, so it
  // is deleted at once. A runtime directory left in it refuses that delete,
  // and the root goes to the tombstones instead.
  // An abandoned stage is deleted at once only because no confined process
  // is granted a path in it. One that holds a runtime directory breaks that
  // premise: the delete refuses and the stage goes to the tombstones.
  it("tombstones an abandoned stage that holds a runtime directory", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "1" }))));
      noteConfinedProcessesMayRun();

      await expect(store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined, {
        coordinateCommit: async ({ pluginRoot }) => {
          await mkdir(resolve(pluginRoot, "data"), { recursive: true });
          throw new Error("activation failed");
        },
      })).rejects.toThrow("activation failed");

      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
      const tombstones = await readdir(resolve(installRoot, TOMBSTONE_SUBDIR));
      expect(tombstones).toHaveLength(1);
      expect(existsSync(resolve(installRoot, TOMBSTONE_SUBDIR, tombstones[0]!, "data"))).toBe(true);
    } finally {
      _resetConfinedProcessPhaseForTests();
      await cleanupTmpDir(tmp);
    }
  });

  it("tombstones a committed backup that still holds a runtime directory", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      // The carry moves run/ and sockets/ into the promoted root; what a runtime
      // carry discarded stays in the old root until the next boot.
      await mkdir(resolve(installDir, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-left"), { recursive: true });
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      noteConfinedProcessesMayRun();

      await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined);

      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("new");
      const tombstones = await readdir(resolve(installRoot, TOMBSTONE_SUBDIR));
      expect(tombstones).toHaveLength(1);
      expect(existsSync(resolve(installRoot, TOMBSTONE_SUBDIR, tombstones[0]!, PLUGIN_SOCKET_DISCARD_DIR_NAME, "x-left"))).toBe(true);
    } finally {
      _resetConfinedProcessPhaseForTests();
      await cleanupTmpDir(tmp);
    }
  });

  it("returns the plugin's data directory to the restored install when commit fails after promotion", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      await seedPluginDataFixture(installDir);
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));

      await expect(
        store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          throw new Error("config registration failed");
        }),
      ).rejects.toThrow(/config registration failed/);

      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("old");
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  // A staged install activates its candidate before the durable commit, and the
  // activation materialises `sockets/` and `run/` at the FINAL root. The swap
  // that follows must leave the candidate those same directories — not drop
  // them with the root it renamed aside (local-indexer: `listen EACCES
  // …/sockets/egress.sock`, startup degraded until restart).
  describe("socket directories of the already-activated candidate", () => {
    const ino = (path: string) => statSync(path).ino;
    afterEach(() => {
      renameFault.afterRenameInto = undefined;
      renameFault.failRename = undefined;
    });

    it("survive a first install's promotion as the same directories", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installRoot = resolve(tmp, "installed");
        const installDir = store.installDirFor("acme");
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "1" }))));
        let granted!: ReturnType<typeof materialiseCandidateRuntimeDirsForTest>;
        let grantedInodes!: number[];

        await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined, {
          coordinateCommit: async ({ pluginRoot, durableCommit }) => {
            granted = materialiseCandidateRuntimeDirsForTest("acme", pluginRoot, installRoot);
            grantedInodes = [ino(granted.socketDir), ino(granted.workerRunRoot)];
            return { result: await durableCommit() };
          },
        });

        expect(granted.socketDir).toBe(resolve(installDir, "sockets"));
        expect([ino(granted.socketDir), ino(granted.workerRunRoot)]).toEqual(grantedInodes);
        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("1");
        expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
      } finally {
        await cleanupTmpDir(tmp);
      }
    });

    it("survive an update's promotion with the live socket inside them", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installRoot = resolve(tmp, "installed");
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
        await seedPluginDataFixture(installDir);
        await mkdir(resolve(installDir, "sockets"), { recursive: true });
        await writeFile(resolve(installDir, "sockets", "egress.sock"), "predecessor");
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
        let grantedInodes!: number[];

        await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined, {
          coordinateCommit: async ({ pluginRoot, durableCommit }) => {
            const granted = materialiseCandidateRuntimeDirsForTest("acme", pluginRoot, installRoot);
            grantedInodes = [ino(granted.socketDir), ino(granted.workerRunRoot)];
            return { result: await durableCommit() };
          },
        });

        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("new");
        expect([ino(resolve(installDir, "sockets")), ino(resolve(installDir, "run"))]).toEqual(grantedInodes);
        expect(await readFile(resolve(installDir, "sockets", "egress.sock"), "utf-8")).toBe("predecessor");
        expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
      } finally {
        await cleanupTmpDir(tmp);
      }
    });

    // The carry into the promoted root stops after a live worker created its
    // leaf there but before that leaf joined the original run/, which is still
    // in the root that went aside. The rollback must finish that merge first:
    // reversing it as found would move the original's leaves into the leaf's
    // fresh run/ and restore that directory in place of the original.
    it("finish an interrupted merge before going back, keeping the original run/", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installRoot = resolve(tmp, "installed");
        const installDir = store.installDirFor("acme");
        await mkdir(resolve(installDir, "run", "a"), { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
        const run = ino(resolve(installDir, "run"));
        const leaf = ino(resolve(installDir, "run", "a"));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
        renameFault.afterRenameInto = {
          to: installDir,
          run: async () => { await mkdir(resolve(installDir, "run", "b"), { recursive: true }); },
        };
        renameFault.failRename = (to) => to.endsWith(`${sep}run${sep}b`) && to.includes(`${sep}.acme.old-`);

        await expect(store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined))
          .rejects.toThrow(/injected move failure/);

        expect(renameFault.failRename).toBeUndefined();
        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("old");
        expect(ino(resolve(installDir, "run"))).toBe(run);
        expect(ino(resolve(installDir, "run", "a"))).toBe(leaf);
        expect((await readdir(resolve(installDir, "run"))).sort()).toEqual(["a", "b"]);
        expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
      } finally {
        await cleanupTmpDir(tmp);
      }
    });

    it("go back to the restored root when the commit fails after promotion", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installRoot = resolve(tmp, "installed");
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
        await mkdir(resolve(installDir, "sockets"), { recursive: true });
        await writeFile(resolve(installDir, "sockets", "egress.sock"), "predecessor");
        const socketInode = ino(resolve(installDir, "sockets"));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));

        await expect(store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          throw new Error("config registration failed");
        })).rejects.toThrow(/config registration failed/);

        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("old");
        expect(ino(resolve(installDir, "sockets"))).toBe(socketInode);
        expect(await readFile(resolve(installDir, "sockets", "egress.sock"), "utf-8")).toBe("predecessor");
        expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
      } finally {
        await cleanupTmpDir(tmp);
      }
    });
  });

  it("leaves the installed version and its data untouched when payload extraction fails", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      await seedPluginDataFixture(installDir);
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      zip.addFile("link", Buffer.from("outside"));
      const entry = zip.getEntry("link");
      if (!entry) throw new Error("test fixture entry missing");
      entry.attr = (0o120777 << 16) >>> 0;

      await expect(
        store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined),
      ).rejects.toThrow(/unsupported member kind/);

      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("old");
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme."))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("leaves the live payload untouched when staged candidate preparation fails", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      const durableCommit = vi.fn(async () => undefined);

      await expect(store.extractZipWithCommit("acme", zip.toBuffer(), durableCommit, {
        coordinateCommit: async () => {
          throw new Error("candidate import failed");
        },
      })).rejects.toThrow("candidate import failed");

      expect(durableCommit).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf8")).version).toBe("old");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("retains the predecessor backup until coordinated generation retirement settles", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      let releaseRetirement!: () => void;
      const retirement = new Promise<void>((resolveRetirement) => { releaseRetirement = resolveRetirement; });
      let durableFinished!: () => void;
      const durableFinishedPromise = new Promise<void>((resolveDurable) => { durableFinished = resolveDurable; });

      const installing = store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
        durableFinished();
        return "committed";
      }, {
        coordinateCommit: async ({ durableCommit }) => ({
          result: await durableCommit(),
          retirement,
        }),
      });
      await durableFinishedPromise;
      const backupBeforeDrain = (await readdir(installRoot)).filter((name) => name.startsWith(".acme.old-"));
      expect(backupBeforeDrain).toHaveLength(1);
      let installSettled = false;
      void installing.finally(() => { installSettled = true; });
      await Promise.resolve();
      expect(installSettled).toBe(false);

      releaseRetirement();
      await expect(installing).resolves.toMatchObject({ result: "committed", predecessorRetired: true });
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme.old-"))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("retains recovery ownership when committed publication and predecessor retirement both fail", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const installRoot = resolve(tmp, "installed");
      const installDir = store.installDirFor("acme");
      await mkdir(installDir, { recursive: true });
      await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
      const zip = new AdmZip();
      zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
      const publicationCause = new Error("projection publish failed");
      const retirementCause = new Error("predecessor retirement failed");
      const retirement = Promise.reject(retirementCause);
      void retirement.catch(() => undefined);
      const onCommittedBackupResolved = vi.fn(async () => undefined);

      const failure = await store.extractZipWithCommit("acme", zip.toBuffer(), async () => "committed", {
        coordinateCommit: async ({ durableCommit }) => {
          const committed = Object.freeze({
            result: await durableCommit(),
            retirement,
            completion: retirement,
            retirementDeferred: false,
          });
          throw new CommittedPluginGenerationPublicationError(
            "acme",
            "g2",
            publicationCause,
            { retired: retirement } as never,
            committed,
          );
        },
        onCommittedBackupResolved,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommittedPluginGenerationPublicationError);
      expect(failure).toMatchObject({ publicationCause, committed: { result: "committed" } });
      await expect((failure as CommittedPluginGenerationPublicationError<string>).committed?.retirement)
        .rejects.toBe(retirementCause);
      expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf8")))
        .toMatchObject({ version: "new" });
      expect((await readdir(installRoot)).filter((name) => name.startsWith(".acme.old-")))
        .toHaveLength(1);
      expect(onCommittedBackupResolved).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects compressed bytes above the configured ceiling before staging", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxCompressedBytes: 4 } });
      await expect(store.extractZip("acme", Buffer.alloc(5))).rejects.toMatchObject({
        code: "ARTIFACT_TOO_LARGE",
      });
      expect(existsSync(resolve(tmp, "installed"))).toBe(false);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects too many zip entries and removes the stage directory", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxEntryCount: 1 } });
      const zip = new AdmZip();
      zip.addFile("one.txt", Buffer.from("1"));
      zip.addFile("two.txt", Buffer.from("2"));
      await expect(store.extractZip("acme", zip.toBuffer())).rejects.toMatchObject({
        code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it.runIf(process.platform !== "win32")(
    "routes a persistently locked failed stage into the boot-swept tombstone namespace",
    async () => {
      const tmp = makeTmpDir();
      const installRoot = resolve(tmp, "installed");
      try {
        const store = makeStore(tmp, { artifactLimits: { maxEntryCount: 1 } });
        const removeStage = vi.spyOn(
          store as unknown as { removeAbandonedStage: (path: string) => Promise<void> },
          "removeAbandonedStage",
        ).mockRejectedValue(Object.assign(new Error("persistent stage lock"), { code: "EACCES" }));
        const originalTombstone = installedEntryFs.tombstoneAndDeferredRemove;
        const tombstoneSpy = vi.spyOn(installedEntryFs, "tombstoneAndDeferredRemove").mockImplementation(
          (path, root, options) => originalTombstone(path, root, { ...options, deferRemoval: false }),
        );
        try {
          const zip = new AdmZip();
          zip.addFile("one.txt", Buffer.from("1"));
          zip.addFile("two.txt", Buffer.from("2"));

          await expect(store.extractZip("acme", zip.toBuffer())).rejects.toMatchObject({
            code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
          });

          expect(removeStage.mock.calls.length).toBeGreaterThan(1);
          const rootEntries = await readdir(installRoot);
          expect(rootEntries.filter((name) => name.includes(".stage-"))).toEqual([]);
          const tombstones = await readdir(resolve(installRoot, TOMBSTONE_SUBDIR));
          expect(tombstones).toHaveLength(1);
          expect(tombstones[0]).toMatch(/^\.acme\.stage-/);
        } finally {
          tombstoneSpy.mockRestore();
          removeStage.mockRestore();
        }
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    10_000,
  );

  it("rejects an excessive declared entry count before enumerating central-directory entries", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, { artifactLimits: { maxEntryCount: 1 } });
      const zip = new AdmZip().toBuffer();
      const endOfCentralDirectoryOffset = zip.byteLength - 22;
      zip.writeUInt16LE(2, endOfCentralDirectoryOffset + 8);
      zip.writeUInt16LE(2, endOfCentralDirectoryOffset + 10);

      await expect(store.extractZip("acme", zip)).rejects.toMatchObject({
        code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
      });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("rejects a real high-compression archive before inflating the entry", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, {
        artifactLimits: { maxCompressionRatio: 10 },
      });
      const zip = new AdmZip();
      zip.addFile("bomb.bin", Buffer.alloc(1024 * 1024));
      const zipBuffer = zip.toBuffer();
      expect(zipBuffer.byteLength).toBeLessThan(16 * 1024);

      await expect(store.extractZip("acme", zipBuffer)).rejects.toMatchObject({
        code: "ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
      });
      expect(existsSync(resolve(tmp, "installed", "acme"))).toBe(false);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("enforces individual and aggregate uncompressed entry ceilings", async () => {
    const tmp = makeTmpDir();
    try {
      const individualStore = makeStore(tmp, {
        artifactLimits: { maxEntryUncompressedBytes: 2 },
      });
      const individualZip = new AdmZip();
      individualZip.addFile("large.txt", Buffer.from("123"));
      await expect(individualStore.extractZip("acme", individualZip.toBuffer()))
        .rejects.toMatchObject({ code: "ARCHIVE_ENTRY_TOO_LARGE" });

      const aggregateStore = makeStore(tmp, {
        artifactLimits: { maxEntryUncompressedBytes: 2, maxTotalUncompressedBytes: 3 },
      });
      const aggregateZip = new AdmZip();
      aggregateZip.addFile("one.txt", Buffer.from("12"));
      aggregateZip.addFile("two.txt", Buffer.from("34"));
      await expect(aggregateStore.extractZip("acme", aggregateZip.toBuffer()))
        .rejects.toMatchObject({ code: "ARCHIVE_UNCOMPRESSED_TOO_LARGE" });
      const entries = existsSync(resolve(tmp, "installed"))
        ? await readdir(resolve(tmp, "installed"))
        : [];
      expect(entries.filter((name) => name.includes(".stage-"))).toEqual([]);
      expect(existsSync(resolve(tmp, "installed", "acme"))).toBe(false);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("allows zip counts and uncompressed bytes exactly at their boundaries", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp, {
        artifactLimits: {
          maxEntryCount: 2,
          maxEntryUncompressedBytes: 2,
          maxTotalUncompressedBytes: 4,
        },
      });
      const zip = new AdmZip();
      zip.addFile("one.txt", Buffer.from("12"));
      zip.addFile("two.txt", Buffer.from("34"));
      await expect(store.extractZip("acme", zip.toBuffer())).resolves.toEqual([
        "one.txt",
        "two.txt",
      ]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it.runIf(process.platform !== "win32")(
    "surfaces persistent promoted-directory cleanup failure and retains the old backup",
    async () => {
      const tmp = makeTmpDir();
      const installRoot = resolve(tmp, "installed");
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));
        const commitError = new Error("registry publication failed");

        const error = await store.extractZipWithCommit("acme", zip.toBuffer(), async () => {
          await chmod(installRoot, 0o500);
          throw commitError;
        }).catch((caught) => caught);
        await chmod(installRoot, 0o700);

        expect(error).toBeInstanceOf(ArtifactRollbackError);
        expect((error as ArtifactRollbackError).errors[0]).toBe(commitError);
        expect((error as ArtifactRollbackError).errors[1]).toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
        expect((error as ArtifactRollbackError).backupDir).toBeTruthy();
        expect(existsSync((error as ArtifactRollbackError).backupDir!)).toBe(true);
        expect(JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8")).version).toBe("new");
      } finally {
        await chmod(installRoot, 0o700).catch(() => undefined);
        await cleanupTmpDir(tmp);
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "routes a committed old directory through the tombstone lifecycle when bounded cleanup fails",
    async () => {
      const tmp = makeTmpDir();
      const installRoot = resolve(tmp, "installed");
      try {
        const store = makeStore(tmp);
        vi.spyOn(
          store as unknown as { removeCommittedBackup: (path: string) => Promise<void> },
          "removeCommittedBackup",
        ).mockRejectedValue(Object.assign(new Error("persistent cleanup lock"), { code: "EACCES" }));
        const originalTombstone = installedEntryFs.tombstoneAndDeferredRemove;
        vi.spyOn(installedEntryFs, "tombstoneAndDeferredRemove").mockImplementation(
          (path, root, options) => originalTombstone(path, root, { ...options, deferRemoval: false }),
        );
        const installDir = store.installDirFor("acme");
        await mkdir(installDir, { recursive: true });
        await writeFile(resolve(installDir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id: "acme", version: "old" })));
        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "acme", version: "new" }))));

        await store.extractZipWithCommit("acme", zip.toBuffer(), async () => undefined);

        const tombstoneDir = resolve(installRoot, TOMBSTONE_SUBDIR);
        const tombstones = await readdir(tombstoneDir);
        expect(tombstones).toHaveLength(1);
        expect(tombstones[0]).toMatch(/^\.acme\.old-/);
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    10_000,
  );
});

describe("PluginArtifactStore — process-wide artifact resource slot", () => {
  it("serializes full artifact lifetimes across independent stores", async () => {
    const firstTmp = makeTmpDir("artifact-store-slot-a-");
    const secondTmp = makeTmpDir("artifact-store-slot-b-");
    try {
      const firstStore = makeStore(firstTmp);
      const secondStore = makeStore(secondTmp);
      let releaseFirst!: () => void;
      let firstEntered = false;
      let secondEntered = false;
      const firstBlocked = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });

      const first = firstStore.withArtifactResourceSlot(async () => {
        firstEntered = true;
        await firstBlocked;
        return "first";
      });
      await vi.waitFor(() => expect(firstEntered).toBe(true));

      const second = secondStore.withArtifactResourceSlot(async () => {
        secondEntered = true;
        return "second";
      });
      await Promise.resolve();
      expect(secondEntered).toBe(false);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(secondEntered).toBe(true);
    } finally {
      await cleanupTmpDir(firstTmp);
      await cleanupTmpDir(secondTmp);
    }
  });

  it("releases the slot after rejection so the next operation can run", async () => {
    const tmp = makeTmpDir("artifact-store-slot-reject-");
    try {
      const store = makeStore(tmp);
      const failure = new Error("inspection failed");
      await expect(store.withArtifactResourceSlot(async () => {
        throw failure;
      })).rejects.toBe(failure);
      await expect(store.withArtifactResourceSlot(async () => "next")).resolves.toBe("next");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("aborts a queued waiter without releasing the active slot early", async () => {
    const tmp = makeTmpDir("artifact-store-slot-abort-");
    try {
      const store = makeStore(tmp);
      let releaseFirst!: () => void;
      let thirdEntered = false;
      const first = store.withArtifactResourceSlot(
        () => new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; }),
      );
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));

      const controller = new AbortController();
      const second = store.withArtifactResourceSlot(async () => "second", controller.signal);
      const third = store.withArtifactResourceSlot(async () => {
        thirdEntered = true;
        return "third";
      });
      controller.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      expect(thirdEntered).toBe(false);

      releaseFirst();
      await first;
      await expect(third).resolves.toBe("third");
    } finally {
      await cleanupTmpDir(tmp);
    }
  });
});

describe("assertSafeArtifactSlug", () => {
  it("accepts marketplace-safe slugs", () => {
    expect(assertSafeArtifactSlug("browser-use_mcp.1")).toBe("browser-use_mcp.1");
  });
});

describe("PluginArtifactStore — cacheVersionFromManifest", () => {
  it("snapshots the manifest under cacheRoot/<slug>/<version>/", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const sourceManifest = resolve(tmp, "live", "plugin.json");
      await mkdir(resolve(tmp, "live"), { recursive: true });
      await writeFile(
        sourceManifest,
        JSON.stringify(agentPluginsDocument({ id: "acme", version: "1.2.3", name: "acme", entry: "x" })));
      await store.cacheVersionFromManifest("acme", sourceManifest);
      const cached = resolve(tmp, "cache", "acme", "1.2.3", "plugin.json");
      const { readFile: read } = await import("node:fs/promises");
      const raw = await read(cached, "utf-8");
      // The cached snapshot is a byte copy of the document, so identity is the
      // portable `name`, not the flat `id` the host projects it to.
      expect(JSON.parse(raw)).toMatchObject({ name: "acme", version: "1.2.3" });
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("does not stage through the predictable `<file>.tmp` a planted symlink could redirect", async () => {
    // The cache writer used a fixed `${filePath}.tmp` + writeFile + rename; the
    // shared atomic writer stages under a random O_EXCL name, so a symlink
    // sitting at the old staging path is neither followed nor renamed over
    // the target.
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const sourceManifest = resolve(tmp, "live", "plugin.json");
      await mkdir(resolve(tmp, "live"), { recursive: true });
      await writeFile(
        sourceManifest,
        JSON.stringify(agentPluginsDocument({ id: "acme", version: "1.2.3", name: "acme", entry: "x" })));
      const cacheDir = resolve(tmp, "cache", "acme", "1.2.3");
      await mkdir(cacheDir, { recursive: true });
      const planted = resolve(tmp, "planted.json");
      await writeFile(planted, "attacker");
      await symlink(planted, resolve(cacheDir, "plugin.json.tmp"));
      await store.cacheVersionFromManifest("acme", sourceManifest);
      expect(await readFile(planted, "utf-8")).toBe("attacker");
      expect(JSON.parse(await readFile(resolve(cacheDir, "plugin.json"), "utf-8"))).toMatchObject({ name: "acme" });
      expect((await readdir(cacheDir)).filter((name) => name.endsWith(".tmp"))).toEqual(["plugin.json.tmp"]);
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("snapshots registry metadata next to the cached manifest", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      const sourceManifest = resolve(tmp, "live", "plugin.json");
      await mkdir(resolve(tmp, "live"), { recursive: true });
      await writeFile(
        sourceManifest,
        JSON.stringify(agentPluginsDocument({ id: "acme", version: "1.2.3", name: "acme", entry: "x" })));

      await store.cacheVersionFromManifest("acme", sourceManifest, {
        installSource: "admin",
        bundleRefs: ["sampleassistant"],
        approvedPluginAccess: { plugins: [{ pluginId: "sampleassistant", tools: ["task_list"] }] },
      });

      const snapshot = await store.readCachedRegistryEntrySnapshot("acme", "1.2.3");
      expect(snapshot).toEqual({
        installSource: "admin",
        bundleRefs: ["sampleassistant"],
        approvedPluginAccess: { plugins: [{ pluginId: "sampleassistant" }] },
      });
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("returns null when a cached registry metadata snapshot is absent", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      expect(await store.readCachedRegistryEntrySnapshot("acme", "1.2.3")).toBeNull();
    } finally {
      await cleanupTmpDir(tmp);
    }
  });

  it("is best-effort: missing source manifest does not throw", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStore(tmp);
      await expect(
        store.cacheVersionFromManifest("acme", resolve(tmp, "does-not-exist.json")),
      ).resolves.toBeUndefined();
    } finally {
      await cleanupTmpDir(tmp);
    }
  });
});
