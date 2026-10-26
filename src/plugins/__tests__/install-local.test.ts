import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PluginMarketplaceService, type PreparedMarketplacePluginActivation } from "../marketplace.js";
import { ArtifactRollbackError } from "../plugin-artifact-store.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { TOMBSTONE_SUBDIR } from "../installed-entry-fs.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";

/** Inject one root-swap failure; all other renames use the real filesystem. */
const swapFault = vi.hoisted(() => ({
  failRenameInto: undefined as string | undefined,
  /** Runs once, right after the swap rename into this root succeeds. */
  afterRenameInto: undefined as { root: string; run: () => Promise<void> } | undefined,
  /** One-shot failure of the first rename of any kind whose destination matches. */
  failRename: undefined as ((to: string) => boolean) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      const isSwap = String(from).includes(".tmp-");
      if (swapFault.failRename?.(String(to))) {
        swapFault.failRename = undefined;
        throw Object.assign(new Error(`EIO: injected move failure into '${String(to)}'`), { code: "EIO" });
      }
      if (swapFault.failRenameInto !== undefined && String(to) === swapFault.failRenameInto && isSwap) {
        swapFault.failRenameInto = undefined;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}' -> '${String(to)}'`), { code: "EBUSY" });
      }
      await actual.rename(from, to);
      const after = swapFault.afterRenameInto;
      if (after !== undefined && String(to) === after.root && isSwap) {
        swapFault.afterRenameInto = undefined;
        await after.run();
      }
    },
  };
});
import {
  makeTestPluginPaths,
  preparedActivationOptionsForTest,
  TestPluginMarketplaceService,
} from "./test-helpers.js";
import { manifestSha } from "../../__tests__/support/manifest-sha-fixture.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import {
  PLUGIN_DATA_FIXTURE,
  agentPluginsDocument,
  materialiseCandidateRuntimeDirsForTest,
  readPluginDataFixture,
  seedPluginDataFixture,
} from "./test-helpers.js";

describe("PluginMarketplaceService.installLocal", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let cacheRoot: string;
  let sourceDir: string;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    setIsPackaged(false);
    priorEnv = process.env.AVE_DEV;
    process.env.AVE_DEV = "1";

    testDir = mkdtempSync(join(tmpdir(), "ave-install-local-"));
    pluginsDir = join(testDir, "plugins");
    cacheRoot = join(pluginsDir, ".cache");
    registryPath = join(pluginsDir, "registry.json");
    sourceDir = join(testDir, "src-plugin");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );

    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          entry: "dist/hostPlugin.js",
        }),
        null,
        2,
      ),
      "utf-8");
    await writeFile(
      join(sourceDir, "dist", "hostPlugin.js"),
      "export default {};\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    if (priorEnv === undefined) {
      delete process.env.AVE_DEV;
    } else {
      process.env.AVE_DEV = priorEnv;
    }
    _resetForTest();
  });

  function makeService(): PluginMarketplaceService {
    const paths = makeTestPluginPaths({
      rootDir: testDir,
      pluginsRoot: pluginsDir,
      cacheRoot,
    });
    return new TestPluginMarketplaceService(paths);
  }

  it("resolves a local plugin id without mutating install storage", async () => {
    const service = makeService();

    await expect(service.resolveLocalInstallPluginId(sourceDir)).resolves.toBe("test-plugin");

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins?: unknown[];
    };
    expect(registry.plugins).toEqual([]);
  });

  // Local installs have no pinned artifact and must refuse process entries before copying.
  it("refuses a process-entry extension before local install changes the registry", async () => {
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "test-plugin", version: "1.2.3", description: "Process extension",
      extensions: { "ai.agent-connector.ave": {
        process: { command: "./bin/plugin" },
        requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
        tools: [],
      } },
    }), "utf8");
    const service = makeService();
    await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest))
      .rejects.toMatchObject({ code: "process-entry-requires-pinned-artifact" });
    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({ plugins: [] });
  });

  it("skips node_modules/electron, .git, and nested node_modules/electron during cp", async () => {
    // Keep the archive fixture inert: the runner uses a patched filesystem; only tree exclusion is under test.
    const electronDir = join(sourceDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "Resources");
    await mkdir(electronDir, { recursive: true });
    const electronFixture = join(electronDir, "electron-fixture.bin");
    await writeFile(electronFixture, Buffer.from([0, 1, 2, 3]));
    expect(existsSync(electronFixture)).toBe(true);
    await mkdir(join(sourceDir, "node_modules", "node-ical"), { recursive: true });
    await writeFile(
      join(sourceDir, "node_modules", "node-ical", "index.js"),
      "module.exports = {};\n",
    );
    // Nested node_modules/electron trees must also be excluded.
    const nestedElectron = join(sourceDir, "packages", "child", "node_modules", "electron");
    await mkdir(nestedElectron, { recursive: true });
    await writeFile(join(nestedElectron, "package.json"), '{"name":"electron"}\n');
    await mkdir(join(sourceDir, ".git"), { recursive: true });
    await writeFile(join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const service = makeService();
    await service.installLocal(sourceDir);

    const installDir = join(pluginsDir, "test-plugin");
    expect(existsSync(join(installDir, "node_modules", "electron"))).toBe(false);
    expect(existsSync(join(installDir, ".git"))).toBe(false);
    expect(
      existsSync(join(installDir, "packages", "child", "node_modules", "electron")),
    ).toBe(false);
    expect(
      existsSync(join(installDir, "node_modules", "node-ical", "index.js")),
    ).toBe(true);
  });

  it("rejects manifests that lack a string version field — and leaves no partial install dir / registry entry", async () => {
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        description: "fixture",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");

    const service = makeService();
    await expect(service.installLocal(sourceDir)).rejects.toThrow(/non-empty 'version' string/);

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg.plugins).toHaveLength(0);
  });

  it("promotes an existing legacy dev-link entry (rewritten to local-dev on read) and re-stamps installSource='local-dev'", async () => {
    // Reading migrates dev-link to local-dev; reinstall must preserve the non-admin install source.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "test-plugin",
            manifestPath: "test-plugin/plugin.json",
            enabled: true,
            installSource: "dev-link",
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry).toBeDefined();
    expect(entry.installSource).toBe("local-dev");
  });

  it("writes a fresh install receipt covering plugin.json + dist files", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);

    const installedManifest = JSON.parse(
      await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf-8"),
    );
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].manifestSha256).toBe(manifestSha(installedManifest));

    const receiptPath = join(cacheRoot, "test-plugin", "install-receipt.json");
    expect(existsSync(receiptPath)).toBe(true);

    const receipt = JSON.parse(await readFile(receiptPath, "utf-8"));
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.installSource).toBe("local-dev");
    expect(receipt.pluginId).toBe("test-plugin");
    expect(receipt.version).toBe("1.2.3");
    expect(receipt.signerKeyId).toBeNull();
    expect(receipt.artifactSha256).toBeNull();

    const paths = receipt.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("dist/hostPlugin.js");
    // Runtime dependencies are excluded from integrity receipts.
    for (const p of paths) {
      expect(p.startsWith("node_modules/")).toBe(false);
    }
  });

  it("install receipt verifies cleanly against installed files", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);

    const { verifyInstallReceipt } = await import("../plugin-install-receipt.js");
    const installDir = join(pluginsDir, "test-plugin");
    const result = await verifyInstallReceipt(cacheRoot, "test-plugin", installDir);
    expect(result.ok).toBe(true);
  });

  // Windows junction staging requires symlink privileges and can fail before the sideload-link guard.
  it.skipIf(process.platform === "win32")("rejects a contained source symlink before it can be promoted", async () => {
    const target = join(sourceDir, "dist", "hostPlugin.js");
    const link = join(sourceDir, "dist", "hostPlugin-link.js");
    await symlink(target, link);

    const service = makeService();
    await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest)).rejects.toThrow(
      "symbolic link is not allowed in install dir: dist/hostPlugin-link.js",
    );

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    expect(existsSync(join(cacheRoot, "test-plugin", "install-receipt.json"))).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins).toEqual([]);
    const names = await readdir(pluginsDir);
    expect(names.some((name) => name.startsWith("test-plugin.tmp-"))).toBe(false);
  });

  it("preserves the active local generation when staged candidate start fails", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const installedManifestPath = join(pluginsDir, "test-plugin", "plugin.json");
    const receiptPath = join(cacheRoot, "test-plugin", "install-receipt.json");
    const before = {
      manifest: await readFile(installedManifestPath, "utf-8"),
      receipt: await readFile(receiptPath, "utf-8"),
      registry: await readFile(registryPath, "utf-8"),
    };
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "broken staged candidate",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");
    const activatePreparedArtifact = vi.fn(async (prepared: {
      installId: string;
      pluginRoot: string;
      manifest: { version?: string };
      durableCommit(): Promise<string>;
    }) => {
      expect(prepared.pluginRoot).not.toBe(join(pluginsDir, "test-plugin"));
      expect(prepared.installId).toBe("test-plugin");
      expect(prepared.manifest.version).toBe("2.0.0");
      throw new Error("candidate start failed");
    });

    await expect(service.installLocal(sourceDir, { activatePreparedArtifact: activatePreparedArtifact as never }))
      .rejects.toThrow("candidate start failed");

    expect(activatePreparedArtifact).toHaveBeenCalledOnce();
    expect(await readFile(installedManifestPath, "utf-8")).toBe(before.manifest);
    expect(await readFile(receiptPath, "utf-8")).toBe(before.receipt);
    expect(await readFile(registryPath, "utf-8")).toBe(before.registry);
  });

  // Windows uses an unprivileged directory junction; POSIX also covers a file symlink.
  it.each(process.platform === "win32" ? ["directory link"] : ["file symlink", "directory link"])(
    "rejects an unlisted %s in the installed payload",
    async (linkKind) => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const installDir = join(pluginsDir, "test-plugin");
    if (linkKind === "file symlink") {
      const outsideExecutable = join(testDir, "outside-executable");
      await writeFile(outsideExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(outsideExecutable, join(installDir, "dist", "injected-tool"));
    } else {
      const outsideDir = join(testDir, "outside-tools");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(outsideDir, join(installDir, "dist", "injected-tool"), "junction");
    }

    const { verifyInstallReceipt } = await import("../plugin-install-receipt.js");
    await expect(verifyInstallReceipt(cacheRoot, "test-plugin", installDir)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("installed payload contains symbolic link: dist/injected-tool"),
    });
  });

  it("cleans fresh local install dir, registry, and receipt when finalization fails", async () => {
    const service = makeService();
    const store = (service as unknown as {
      artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "persistPreparedInstallReceipt").mockImplementationOnce(async () => {
      const registryDuringReceipt = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registryDuringReceipt.plugins).toEqual([]);
      throw new Error("receipt write failed");
    });

    await expect(service.installLocal(sourceDir)).rejects.toThrow("receipt write failed");

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    expect(existsSync(join(cacheRoot, "test-plugin", "install-receipt.json"))).toBe(false);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg.plugins).toHaveLength(0);
  });

  it.each(["before commit", "snapshot restore", "fresh cleanup", "snapshot cleanup"] as const)(
    "preserves the activation error when local %s fails",
    async (phase) => {
      const service = makeService();
      if (phase !== "fresh cleanup") await service.installLocal(sourceDir, preparedActivationOptionsForTest);
      await writeFile(join(sourceDir, "dist", "hostPlugin.js"), "export default { updated: true };\n", "utf8");
      const primary = new ArtifactRollbackError("directory rollback unresolved", [new Error("activation refused")], join(testDir, "rollback-backup"));
      const secondary = new Error("secondary local cleanup refused");
      const internals = service as unknown as {
        artifactStore: { persistPreparedInstallReceipt(...args: unknown[]): Promise<void> };
        restoreLocalInstallSnapshot(...args: unknown[]): Promise<void>;
        cleanupFreshInstalledPlugin(...args: unknown[]): Promise<void>;
        discardLocalInstallRollbackSnapshot(...args: unknown[]): Promise<void>;
      };
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      if (phase === "snapshot restore") {
        vi.spyOn(internals, "restoreLocalInstallSnapshot").mockRejectedValueOnce(secondary);
      } else if (phase === "fresh cleanup") {
        vi.spyOn(internals, "cleanupFreshInstalledPlugin").mockRejectedValueOnce(secondary);
      } else {
        vi.spyOn(internals, "discardLocalInstallRollbackSnapshot").mockRejectedValueOnce(secondary);
      }
      if (phase !== "before commit") {
        vi.spyOn(internals.artifactStore, "persistPreparedInstallReceipt").mockRejectedValueOnce(primary);
      }
      const activatePreparedArtifact: PreparedMarketplacePluginActivation = async (input) => {
        if (phase !== "before commit") await input.durableCommit();
        throw primary;
      };
      await expect(service.installLocal(sourceDir, { activatePreparedArtifact })).rejects.toBe(primary);
      expect(errorLog.mock.calls.map((args) => args.join(" ")).some((message) => message.includes(secondary.message))).toBe(true);
    },
  );

  it("hides an existing entry until its replacement receipt is durable", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const oldReceipt = await readFile(
      join(cacheRoot, "test-plugin", "install-receipt.json"),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");
    const store = (service as unknown as {
      artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "persistPreparedInstallReceipt").mockImplementationOnce(async () => {
      const registryDuringReceipt = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string; pendingUpdate?: { kind: string } }>;
      };
      expect(registryDuringReceipt.plugins).toEqual([
        expect.objectContaining({
          id: "test-plugin",
          pendingUpdate: expect.objectContaining({ kind: "local-dev" }),
        }),
      ]);
      throw new Error("replacement receipt write failed");
    });

    await expect(service.installLocal(sourceDir)).rejects.toThrow("replacement receipt write failed");

    const restoredRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string }>;
    };
    expect(restoredRegistry.plugins.some((entry) => entry.id === "test-plugin")).toBe(true);
    expect(await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8"))
      .toBe(oldReceipt);
  });

  it("keeps the plugin's data directory byte-identical across a sideload reinstall", async () => {
    const service = makeService();
    await service.installLocal(sourceDir, preparedActivationOptionsForTest);
    const installDir = join(pluginsDir, "test-plugin");
    await seedPluginDataFixture(installDir);
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");

    await service.installLocal(sourceDir, preparedActivationOptionsForTest);

    expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
      .toMatchObject({ version: "2.0.0" });
    expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
    const rollbackBackups = await readdir(
      join(pluginsDir, ".cache", "local-install-rollback"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(rollbackBackups).toEqual([]);
  });

  // Activation creates runtime directories at the final root before durable commit; the swap must preserve them.
  describe("socket directories of the already-activated candidate", () => {
    afterEach(() => {
      swapFault.failRenameInto = undefined;
      swapFault.afterRenameInto = undefined;
      swapFault.failRename = undefined;
    });

    const activateLikeTheRuntime: PreparedMarketplacePluginActivation = async (prepared) => {
      const granted = materialiseCandidateRuntimeDirsForTest(prepared.installId, prepared.pluginRoot, pluginsDir);
      grantedInodes = [statSync(granted.socketDir).ino, statSync(granted.workerRunRoot).ino];
      const completion = Promise.resolve();
      return { result: await prepared.durableCommit(), retirement: completion, completion, retirementDeferred: false };
    };
    let grantedInodes: number[] = [];
    const liveInodes = (installDir: string) => [
      statSync(join(installDir, "sockets")).ino,
      statSync(join(installDir, "run")).ino,
    ];

    it("survive a first local install as the same directories", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });

      const installDir = join(pluginsDir, "test-plugin");
      expect(liveInodes(installDir)).toEqual(grantedInodes);
    });

    it("survive a local reinstall with the live socket inside them", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });
      const installDir = join(pluginsDir, "test-plugin");
      await writeFile(join(installDir, "sockets", "egress.sock"), "predecessor");
      await seedPluginDataFixture(installDir);
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          entry: "dist/hostPlugin.js",
        })),
        "utf-8");

      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });

      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "2.0.0" });
      expect(liveInodes(installDir)).toEqual(grantedInodes);
      expect(await readFile(join(installDir, "sockets", "egress.sock"), "utf-8")).toBe("predecessor");
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
    });

    it("go back to the restored install when the replacement receipt fails", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });
      const installDir = join(pluginsDir, "test-plugin");
      await writeFile(join(installDir, "sockets", "egress.sock"), "predecessor");
      const predecessorInodes = liveInodes(installDir);
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          entry: "dist/hostPlugin.js",
        })),
        "utf-8");
      const store = (service as unknown as {
        artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      }).artifactStore;
      vi.spyOn(store, "persistPreparedInstallReceipt").mockRejectedValueOnce(
        new Error("replacement receipt write failed"),
      );

      await expect(service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime }))
        .rejects.toThrow("replacement receipt write failed");

      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "1.2.3" });
      expect(liveInodes(installDir)).toEqual(predecessorInodes);
      expect(await readFile(join(installDir, "sockets", "egress.sock"), "utf-8")).toBe("predecessor");
    });

    // A live worker can create a run/ leaf during the swap; both directories must merge without loss.
    it("merge with a worker leaf created at the promoted root during the swap", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });
      const installDir = join(pluginsDir, "test-plugin");
      await mkdir(join(installDir, "run", "w1"), { recursive: true });
      await writeFile(join(installDir, "run", "w1", "control.sock"), "w1");
      const run = statSync(join(installDir, "run")).ino;
      const w1 = statSync(join(installDir, "run", "w1")).ino;
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          entry: "dist/hostPlugin.js",
        })),
        "utf-8");
      swapFault.afterRenameInto = {
        root: installDir,
        run: async () => { await mkdir(join(installDir, "run", "w2"), { recursive: true }); },
      };

      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });

      expect(swapFault.afterRenameInto).toBeUndefined();
      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "2.0.0" });
      // Keep the original run/ directory identity that confines live children.
      expect(statSync(join(installDir, "run")).ino).toBe(run);
      expect(statSync(join(installDir, "run", "w1")).ino).toBe(w1);
      expect(await readFile(join(installDir, "run", "w1", "control.sock"), "utf-8")).toBe("w1");
      expect(existsSync(join(installDir, "run", "w2"))).toBe(true);
    });

    // Finish the interrupted merge before rollback so the original run/ directory identity survives.
    it("finish an interrupted merge before restoring, keeping the original run/", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });
      const installDir = join(pluginsDir, "test-plugin");
      await mkdir(join(installDir, "run", "w1"), { recursive: true });
      const run = statSync(join(installDir, "run")).ino;
      const w1 = statSync(join(installDir, "run", "w1")).ino;
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          entry: "dist/hostPlugin.js",
        })),
        "utf-8");
      swapFault.afterRenameInto = {
        root: installDir,
        run: async () => { await mkdir(join(installDir, "run", "w2"), { recursive: true }); },
      };
      swapFault.failRename = (to) => to.endsWith(`${sep}run${sep}w2`) && !to.startsWith(`${installDir}${sep}`);

      await expect(service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime }))
        .rejects.toThrow(/injected move failure/);

      expect(swapFault.failRename).toBeUndefined();
      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "1.2.3" });
      expect(statSync(join(installDir, "run")).ino).toBe(run);
      expect(statSync(join(installDir, "run", "w1")).ino).toBe(w1);
      expect((await readdir(join(installDir, "run"))).sort()).toEqual(["w1", "w2"]);
    });

    // A failed swap must restore the predecessor socket directories with its install root.
    it("go back to the restored install when the root swap itself fails", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime });
      const installDir = join(pluginsDir, "test-plugin");
      await writeFile(join(installDir, "sockets", "egress.sock"), "predecessor");
      await seedPluginDataFixture(installDir);
      const predecessorInodes = liveInodes(installDir);
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify(agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          entry: "dist/hostPlugin.js",
        })),
        "utf-8");
      swapFault.failRenameInto = installDir;

      await expect(service.installLocal(sourceDir, { activatePreparedArtifact: activateLikeTheRuntime }))
        .rejects.toMatchObject({ code: "EBUSY" });

      expect(swapFault.failRenameInto).toBeUndefined();
      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "1.2.3" });
      expect(liveInodes(installDir)).toEqual(predecessorInodes);
      expect(await readFile(join(installDir, "sockets", "egress.sock"), "utf-8")).toBe("predecessor");
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
    });
  });

  it("returns the plugin's data directory to the restored install when the replacement receipt fails", async () => {
    const service = makeService();
    await service.installLocal(sourceDir, preparedActivationOptionsForTest);
    const installDir = join(pluginsDir, "test-plugin");
    await seedPluginDataFixture(installDir);
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");
    const store = (service as unknown as {
      artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "persistPreparedInstallReceipt").mockRejectedValueOnce(
      new Error("replacement receipt write failed"),
    );

    await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest))
      .rejects.toThrow("replacement receipt write failed");

    expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8")))
      .toMatchObject({ version: "1.2.3" });
    expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
  });

  // Roots still reachable by confined children wait in tombstones until boot.
  describe("once confined processes may run", () => {
    const tombstones = async () => {
      const dir = join(pluginsDir, TOMBSTONE_SUBDIR);
      return existsSync(dir) ? (await readdir(dir)).sort() : [];
    };
    const tombstonedVersions = async () => Promise.all((await tombstones()).map(async (name) =>
      JSON.parse(await readFile(join(pluginsDir, TOMBSTONE_SUBDIR, name, "plugin.json"), "utf-8")).version as string));
    const bumpSource = () => writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");
    afterEach(() => {
      _resetConfinedProcessPhaseForTests();
      vi.restoreAllMocks();
    });

    it("tombstones the replaced live root and the rollback backup of a reinstall", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, preparedActivationOptionsForTest);
      const installDir = join(pluginsDir, "test-plugin");
      await seedPluginDataFixture(installDir);
      await bumpSource();
      noteConfinedProcessesMayRun();

      await service.installLocal(sourceDir, preparedActivationOptionsForTest);

      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8"))).toMatchObject({ version: "2.0.0" });
      expect(await readPluginDataFixture(installDir)).toEqual(PLUGIN_DATA_FIXTURE);
      expect(await tombstonedVersions()).toEqual(["1.2.3", "1.2.3"]);
    });

    it("tombstones the failed candidate's root when the restore runs", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, preparedActivationOptionsForTest);
      const installDir = join(pluginsDir, "test-plugin");
      await bumpSource();
      const store = (service as unknown as {
        artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      }).artifactStore;
      vi.spyOn(store, "persistPreparedInstallReceipt").mockRejectedValueOnce(new Error("replacement receipt write failed"));
      noteConfinedProcessesMayRun();

      await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest))
        .rejects.toThrow("replacement receipt write failed");

      expect(JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8"))).toMatchObject({ version: "1.2.3" });
      expect(await tombstonedVersions()).toContain("2.0.0");
    });

    it("tombstones a failed fresh install's root", async () => {
      const service = makeService();
      const store = (service as unknown as {
        artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      }).artifactStore;
      vi.spyOn(store, "persistPreparedInstallReceipt").mockRejectedValueOnce(new Error("receipt write failed"));
      noteConfinedProcessesMayRun();

      await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest)).rejects.toThrow("receipt write failed");

      expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
      expect(await tombstonedVersions()).toEqual(["1.2.3"]);
    });

    // Staging deletion is safe only for payload-only roots; runtime directories require tombstoning.
    it("refuses a leftover staging root that holds a runtime directory", async () => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const stale = join(pluginsDir, `test-plugin.tmp-${process.pid}-${now}`);
      await mkdir(join(stale, "data"), { recursive: true });
      const service = makeService();
      noteConfinedProcessesMayRun();

      await expect(service.installLocal(sourceDir, preparedActivationOptionsForTest))
        .rejects.toThrow(/holds runtime directory data\//);

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
      const tombstoned = await tombstones();
      expect(tombstoned).toHaveLength(1);
      expect(existsSync(join(pluginsDir, TOMBSTONE_SUBDIR, tombstoned[0]!, "data"))).toBe(true);
    });

    it("refuses a leftover restore stage that holds a runtime directory", async () => {
      const service = makeService();
      await service.installLocal(sourceDir, preparedActivationOptionsForTest);
      const installDir = join(pluginsDir, "test-plugin");
      await bumpSource();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const stale = `${installDir}.restore-${process.pid}-${now}`;
      await mkdir(join(stale, "data"), { recursive: true });
      const store = (service as unknown as {
        artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      }).artifactStore;
      const primary = new Error("replacement receipt write failed");
      vi.spyOn(store, "persistPreparedInstallReceipt").mockRejectedValueOnce(primary);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      noteConfinedProcessesMayRun();

      const failure = await service.installLocal(sourceDir, preparedActivationOptionsForTest)
        .then(() => { throw new Error("install resolved"); }, (error: unknown) => error);

      expect(failure).toBe(primary);
      expect(errorLog.mock.calls.map((args) => args.join(" ")))
        .toContainEqual(expect.stringMatching(/holds runtime directory data\//));
      expect(existsSync(join(stale, "data"))).toBe(true);
    });

    // A failed fresh-install swap must tombstone runtime directories still bound to the candidate.
    it("tombstones a staged root that holds the candidate's runtime directories when the swap fails", async () => {
      const service = makeService();
      const installDir = join(pluginsDir, "test-plugin");
      swapFault.failRenameInto = installDir;
      noteConfinedProcessesMayRun();

      try {
        await expect(service.installLocal(sourceDir, {
          activatePreparedArtifact: async (prepared) => {
            materialiseCandidateRuntimeDirsForTest(prepared.installId, prepared.pluginRoot, pluginsDir);
            const completion = Promise.resolve();
            return { result: await prepared.durableCommit(), retirement: completion, completion, retirementDeferred: false };
          },
        })).rejects.toMatchObject({ code: "EBUSY" });
      } finally {
        swapFault.failRenameInto = undefined;
      }

      expect((await readdir(pluginsDir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
      const staged = (await tombstones()).filter((name) =>
        existsSync(join(pluginsDir, TOMBSTONE_SUBDIR, name, "sockets")));
      expect(staged).toHaveLength(1);
      expect(existsSync(join(pluginsDir, TOMBSTONE_SUBDIR, staged[0]!, "run"))).toBe(true);
    });
  });

  it("does not restore a predecessor after committed local publication failure", async () => {
    const service = makeService();
    await service.installLocal(sourceDir, preparedActivationOptionsForTest);
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "committed candidate",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");
    const publicationCause = new Error("local projection publish failed");

    const failure = await service.installLocal(sourceDir, {
      activatePreparedArtifact: async (prepared) => {
        const retirement = Promise.resolve();
        const committed = Object.freeze({
          result: await prepared.durableCommit(),
          retirement,
          completion: retirement,
          retirementDeferred: false,
        });
        throw new CommittedPluginGenerationPublicationError(
          "test-plugin",
          "g2",
          publicationCause,
          { retired: retirement } as never,
          committed,
        );
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommittedPluginGenerationPublicationError);
    expect(failure).toMatchObject({ publicationCause, committed: { result: "test-plugin/plugin.json" } });
    expect(JSON.parse(await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf8")))
      .toMatchObject({ version: "2.0.0" });
    expect(JSON.parse(await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf8")))
      .toMatchObject({ version: "2.0.0" });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      plugins: Array<{ pendingUpdate?: unknown; pendingCleanup?: unknown }>;
    };
    expect(registry.plugins[0]?.pendingUpdate).toBeUndefined();
    expect(registry.plugins[0]?.pendingCleanup).toBeUndefined();
    const rollbackBackups = await readdir(
      join(pluginsDir, ".cache", "local-install-rollback"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(rollbackBackups).toEqual([]);
  });

  it("retains a replacement backup when a transient restore fault requires retry", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        entry: "dist/hostPlugin.js",
      })),
      "utf-8");

    const internals = service as unknown as {
      artifactStore: { persistPreparedInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      restoreLocalInstallSnapshot: (...args: unknown[]) => Promise<void>;
    };
    const primary = new Error("replacement receipt write failed");
    vi.spyOn(internals.artifactStore, "persistPreparedInstallReceipt").mockRejectedValueOnce(primary);
    vi.spyOn(internals, "restoreLocalInstallSnapshot").mockRejectedValueOnce(
      Object.assign(new Error("transient restore lock"), { code: "EACCES" }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await service.installLocal(sourceDir).catch((caught) => caught);
    expect(error).toBe(primary);
    expect(errorLog.mock.calls.map((args) => args.join(" ")))
      .toContainEqual(expect.stringContaining("transient restore lock"));
    const hiddenRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{
        id: string;
        pendingUpdate?: { kind: string; recoveryBackupDir?: string };
      }>;
    };
    expect(hiddenRegistry.plugins).toEqual([
      expect.objectContaining({
        id: "test-plugin",
        pendingUpdate: expect.objectContaining({ kind: "local-dev" }),
      }),
    ]);
    const retainedBackup = hiddenRegistry.plugins[0]?.pendingUpdate?.recoveryBackupDir;
    expect(retainedBackup).toBeTruthy();
    expect(existsSync(retainedBackup!)).toBe(true);
  });

  it("supersedes a cleaned unresolved pending row with a verified local reinstall", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const manifestRaw = await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf-8");
    const receiptRaw = await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8");
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    Object.assign(registry.plugins[0]!, {
      bundleRefs: ["bundle-root"],
      pendingUpdate: {
        kind: "local-dev",
        previousManifestFileSha256: createHash("sha256").update(manifestRaw).digest("hex"),
        previousReceiptRaw: receiptRaw,
      },
    });
    await writeFile(registryPath, JSON.stringify(registry));
    await writeFile(join(pluginsDir, "test-plugin", "dist", "hostPlugin.js"), "corrupted");
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(agentPluginsDocument({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "verified retry",
        entry: "dist/hostPlugin.js",
      })));

    await expect(service.installLocal(sourceDir)).resolves.toEqual({ pluginId: "test-plugin", installed: true });

    const repaired = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ bundleRefs?: string[]; pendingUpdate?: unknown; pendingCleanup?: unknown }>;
    };
    expect(repaired.plugins[0]?.bundleRefs).toEqual(["bundle-root"]);
    expect(repaired.plugins[0]?.pendingUpdate).toBeUndefined();
    expect(repaired.plugins[0]?.pendingCleanup).toBeUndefined();

  });

  it("mirrors manifest.pluginAccess into registry approvedPluginAccess (parity with marketplace install)", async () => {
    // Sideloaded cross-plugin event subscriptions require an approvedPluginAccess grant.
    const accessSpec = {
      plugins: [
        { pluginId: "samplemail", events: ["email.new", "calendar.event.upcoming"] },
      ],
    };
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          entry: "dist/hostPlugin.js",
          pluginAccess: accessSpec,
        }),
        null,
        2,
      ),
      "utf-8");

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry).toBeDefined();
    expect(entry.approvedPluginAccess).toEqual(accessSpec);
  });

  it("mirrors approvedPluginAccess on UPDATE (existing entry path) — not just on insert", async () => {
    // Reinstall must replace approvedPluginAccess so new cross-plugin subscriptions are authorized.
    const accessSpec = {
      plugins: [{ pluginId: "samplemail", events: ["email.new"] }],
    };
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          plugins: [
            {
              id: "test-plugin",
              manifestPath: "test-plugin/plugin.json",
              enabled: true,
              installSource: "local-dev",
              bundleRefs: ["sampleassistant"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        agentPluginsDocument({
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          entry: "dist/hostPlugin.js",
          pluginAccess: accessSpec,
        }),
        null,
        2,
      ),
      "utf-8");

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry.approvedPluginAccess).toEqual(accessSpec);
    expect(entry.installSource).toBe("local-dev");
    expect(entry.bundleRefs).toEqual(["sampleassistant"]);
    expect(entry.pendingUpdate).toBeUndefined();
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, pluginId: "test-plugin", version: "1", installedAt: "now", files: [null] },
    { schemaVersion: 2, pluginId: "test-plugin", version: "1", installedAt: "now", files: [{ path: 7, sha256: "a".repeat(64) }] },
    { schemaVersion: 2, pluginId: "test-plugin", version: "1", installedAt: "now", files: [{ path: "plugin.json", sha256: 7 }] },
  ])("fails closed for structurally malformed valid receipt JSON %#", async (receipt) => {
    const { verifyInstallReceiptRaw } = await import("../plugin-install-receipt.js");
    await expect(verifyInstallReceiptRaw(
      JSON.stringify(receipt),
      "test-plugin",
      sourceDir,
    )).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  it("keeps an existing schema-v2 receipt valid, reading its absent admission as none", async () => {
    // A receipt predating admission records null; never backfill it from the current catalog.
    const { hashReceiptFiles, listFilesRecursive, verifyInstallReceiptRaw } = await import(
      "../plugin-install-receipt.js"
    );
    const files = await hashReceiptFiles(sourceDir, await listFilesRecursive(sourceDir));
    const result = await verifyInstallReceiptRaw(
      JSON.stringify({
        schemaVersion: 2,
        pluginId: "test-plugin",
        version: "1.2.3",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        installedAt: new Date(0).toISOString(),
        files,
      }),
      "test-plugin",
      sourceDir,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.receipt.schemaVersion).toBe(3);
    expect(result.receipt.admission).toBeNull();
  });
});
