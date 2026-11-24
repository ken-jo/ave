import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import {
  hashReceiptFiles,
  writeInstallReceipt,
  type PluginInstallReceipt,
} from "../plugin-install-receipt.js";
import {
  _resetForTest,
  isDevModeUnlocked,
  setIsPackaged,
} from "../../boot/dev-flags.js";
import {
  makeTestTreeWritable,
  TestPluginRuntime as PluginRuntime,
  writeTestPluginRegistry,
} from "./test-helpers.js";
import { servedAgentPluginsDocument } from "./test-helpers.js";

const ENTRY_SOURCE = `export default async function createPlugin(ctx) {
  return { handlers: { tb_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`;

describe("Phase 1 — plugin trust boundary", () => {
  let testDir: string;
  let hostRoot: string;
  let pluginsRoot: string;
  let cacheRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "ave-trust-"));
    hostRoot = join(testDir, "host");
    pluginsRoot = join(testDir, "userInstalled");
    cacheRoot = join(pluginsRoot, ".cache");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(pluginsRoot, { recursive: true });
    registryPath = join(hostRoot, "plugins", "registry.json");
  });

  afterEach(async () => {
    await makeTestTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePluginAt(
    pluginDir: string,
    id: string,
    opts?: { installPolicy?: "admin" | "user" },
  ): Promise<string> {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), ENTRY_SOURCE, "utf-8");
    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      entry: "entry.mjs",
      tools: [{ name: "tb_ping", description: "tb_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
    };
    if (opts?.installPolicy) manifest.installPolicy = opts.installPolicy;
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedAgentPluginsDocument(manifest)), "utf-8");
    return manifestPath;
  }

  async function writeReceipt(pluginId: string, pluginDir: string): Promise<void> {
    const receipt: PluginInstallReceipt = {
      schemaVersion: 3,
      pluginId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "prod-v1",
      admission: null,
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
    };
    await writeInstallReceipt(cacheRoot, receipt);
  }

  describe("isTrustedRegistryManifestPath single-root containment", () => {
    it("accepts a registry manifest path under pluginsRoot", async () => {
      const manifestPath = await writePluginAt(
        join(pluginsRoot, "p-user"),
        "tb-user",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-user", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.startAll();
      expect(runtime.listPluginIds()).toContain("tb-user");
    });

    it("rejects a registry manifest path under hostRoot (no longer a trust root)", async () => {
      const manifestPath = await writePluginAt(
        join(hostRoot, "plugins", "installed", "p-host"),
        "tb-host",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-host", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.startAll();
      expect(runtime.listPluginIds()).not.toContain("tb-host");
    });

    it("rejects a registry manifest path outside pluginsRoot", async () => {
      const manifestPath = await writePluginAt(
        join(testDir, "rogue", "p-rogue"),
        "tb-rogue",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-rogue", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb-rogue");
    });

    // Use Windows junctions to exercise realpath escape without requiring symlink privileges.
    it(
      "rejects a symlink under pluginsRoot that points outside the trust root",
      async () => {
        const realDir = join(testDir, "outside", "p-evil");
        const realManifest = await writePluginAt(realDir, "tb-evil");
        const linkDir = join(pluginsRoot, "p-evil");
        await symlink(realDir, linkDir, "junction");
        const linkedManifest = join(linkDir, "plugin.json");
        expect(realManifest).not.toEqual(linkedManifest);
        await writeTestPluginRegistry({ registryPath }, [{ id: "tb-evil", manifestPath: linkedManifest }]);

        const runtime = new PluginRuntime({
          hostRoot,
          registryPath,
          pluginsRoot,
        });
        await runtime.load();
        expect(runtime.listPluginIds()).not.toContain("tb-evil");
      },
    );
  });

  describe("marketplace install receipt integrity", () => {
    it("loads a registry plugin when its install receipt matches installed files", async () => {
      const pluginDir = join(pluginsRoot, "p-receipted");
      const manifestPath = await writePluginAt(pluginDir, "tb-receipted");
      await writeReceipt("tb-receipted", pluginDir);
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-receipted", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb-receipted");
      expect(auditCalls).toContainEqual({ level: "info", message: "plugin_integrity_verified" });
    });

    it("rejects a registry plugin when an installed file differs from its receipt", async () => {
      const pluginDir = join(pluginsRoot, "p-tampered");
      const manifestPath = await writePluginAt(pluginDir, "tb-receipt-tampered");
      await writeReceipt("tb-receipt-tampered", pluginDir);
      await writeFile(join(pluginDir, "entry.mjs"), `${ENTRY_SOURCE}\n// tampered`, "utf-8");
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-receipt-tampered", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb-receipt-tampered");
      expect(auditCalls).toContainEqual({ level: "error", message: "plugin_integrity_rejected" });
    });

    it("rejects a registry plugin with an unexpected executable absent from its receipt", async () => {
      const pluginDir = join(pluginsRoot, "p-unlisted");
      const manifestPath = await writePluginAt(pluginDir, "tb-receipt-unlisted");
      await writeReceipt("tb-receipt-unlisted", pluginDir);
      await writeFile(join(pluginDir, "unlisted.mjs"), "export default 'injected';\n", "utf-8");
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-receipt-unlisted", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb-receipt-unlisted");
      expect(auditCalls).toContainEqual({ level: "error", message: "plugin_integrity_rejected" });
    });

    it("loads a plugin despite Python bytecode cache (__pycache__/*.pyc) absent from its receipt", async () => {
      // Runtime bytecode caches are absent from receipts and must not fail payload integrity.
      const pluginDir = join(pluginsRoot, "p-pyc");
      const manifestPath = await writePluginAt(pluginDir, "tb-receipt-pyc");
      await writeReceipt("tb-receipt-pyc", pluginDir);
      await mkdir(join(pluginDir, "dist", "worker", "__pycache__"), { recursive: true });
      await writeFile(
        join(pluginDir, "dist", "worker", "__pycache__", "local_indexer.cpython-312.pyc"),
        "\x00\x00\x00\x00compiled-bytecode",
        "utf-8",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-receipt-pyc", manifestPath }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb-receipt-pyc");
    });

    it("still rejects a non-bytecode file smuggled into a __pycache__/ directory", async () => {
      // Only bytecode inside __pycache__ is exempt; other unlisted executable files must still fail integrity.
      const pluginDir = join(pluginsRoot, "p-pyc-smuggle");
      const manifestPath = await writePluginAt(pluginDir, "tb-receipt-pyc-smuggle");
      await writeReceipt("tb-receipt-pyc-smuggle", pluginDir);
      await mkdir(join(pluginDir, "dist", "worker", "__pycache__"), { recursive: true });
      await writeFile(
        join(pluginDir, "dist", "worker", "__pycache__", "evil.mjs"),
        "export default 'injected';\n",
        "utf-8",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-receipt-pyc-smuggle", manifestPath }]);

      const auditCalls: Array<{ level: string; message: string }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message) => auditCalls.push({ level, message }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb-receipt-pyc-smuggle");
      expect(auditCalls).toContainEqual({ level: "error", message: "plugin_integrity_rejected" });
    });

    it("rejects malformed valid receipt JSON without aborting unrelated plugin startup", async () => {
      const malformedId = "tb-malformed-receipt";
      const validId = "tb-valid-neighbor";
      const malformedDir = join(pluginsRoot, malformedId);
      const validDir = join(pluginsRoot, validId);
      const malformedManifest = await writePluginAt(malformedDir, malformedId);
      const validManifest = await writePluginAt(validDir, validId);
      await mkdir(join(cacheRoot, malformedId), { recursive: true });
      await writeFile(
        join(cacheRoot, malformedId, "install-receipt.json"),
        JSON.stringify({
          schemaVersion: 3,
          pluginId: malformedId,
          version: "1.0.0",
          installSource: "marketplace",
          installedAt: new Date(0).toISOString(),
          files: [null],
        }),
      );
      await writeReceipt(validId, validDir);
      await writeTestPluginRegistry({ registryPath }, [
        { id: malformedId, manifestPath: malformedManifest },
        { id: validId, manifestPath: validManifest },
      ]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await expect(runtime.load()).resolves.toBeUndefined();
      expect(runtime.listPluginIds()).not.toContain(malformedId);
      expect(runtime.listPluginIds()).toContain(validId);
    });

  });

  describe("no install record or manifest field locks a plugin (design §10.1)", () => {
    it("lets the user remove a legacy admin entry, whichever signal once marked it", async () => {
      // Only requiredInstalls machine policy locks a plugin; install-source and manifest policy fields cannot.
      const guard = new PluginDeploymentGuard({ registryPath, pluginsRoot, requiredInstalls: async () => [] });
      const legacy = [
        { id: "tb-tampered", entry: { installSource: "admin" as const }, installPolicy: "user" as const },
        { id: "tb-legacy-admin", entry: { installedBy: "admin" as const }, installPolicy: "user" as const },
        { id: "tb-legacy", entry: {}, installPolicy: "admin" as const },
      ];
      const entries = [];
      for (const item of legacy) {
        const manifestPath = await writePluginAt(join(pluginsRoot, item.id), item.id, { installPolicy: item.installPolicy });
        entries.push({ id: item.id, manifestPath, ...item.entry });
      }
      await writeTestPluginRegistry({ registryPath }, entries);

      for (const item of legacy) {
        await expect(guard.canUninstall(item.id)).resolves.toEqual({ allowed: true });
      }
    });
  });

  describe("dev-flags helpers hard-gate on app.isPackaged", () => {
    const ENV_NAMES = [
      "AVE_DEV",
      "AVE_DEV_RELOAD",
    ] as const;
    const saved: Partial<Record<string, string | undefined>> = {};

    beforeEach(() => {
      for (const name of ENV_NAMES) saved[name] = process.env[name];
    });

    afterEach(() => {
      _resetForTest();
      for (const name of ENV_NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it("returns false when isPackaged=true even with every flag set", () => {
      for (const name of ENV_NAMES) process.env[name] = "1";
      setIsPackaged(true);
      expect(isDevModeUnlocked()).toBe(false);
    });

    it("returns true when isPackaged=false and the matching flag is set", () => {
      for (const name of ENV_NAMES) delete process.env[name];
      setIsPackaged(false);
      expect(isDevModeUnlocked()).toBe(false);
      process.env.AVE_DEV = "1";
      expect(isDevModeUnlocked()).toBe(true);
    });

    it("explicit packaged parameter overrides cached state for testability", () => {
      process.env.AVE_DEV = "1";
      setIsPackaged(false);
      expect(isDevModeUnlocked(false)).toBe(true);
      expect(isDevModeUnlocked(true)).toBe(false);
    });
  });

  describe("local-dev installSource rejected in packaged builds", () => {
    const savedAveDev = process.env.AVE_DEV;
    beforeEach(() => {
      _resetForTest();
    });
    afterEach(() => {
      _resetForTest();
      if (savedAveDev === undefined) delete process.env.AVE_DEV;
      else process.env.AVE_DEV = savedAveDev;
    });

    it("packaged build + v2 local-dev receipt → plugin marked failed", async () => {
      delete process.env.AVE_DEV;
      setIsPackaged(true);
      const pluginDir = join(pluginsRoot, "p-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb-dev-signer");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 3,
        pluginId: "tb-dev-signer",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        admission: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-dev-signer", manifestPath, installedBy: "user" }]);

      const auditCalls: Array<{ level: string; message: string; extras?: Record<string, unknown> }> = [];
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message, extras) => auditCalls.push({ level, message, extras }),
      });
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("tb-dev-signer");
      expect(auditCalls).toContainEqual(
        expect.objectContaining({ level: "error", message: "plugin_integrity_rejected" }),
      );
    });

    it("packaged build + v1 dev: sentinel receipt → normalised to local-dev → rejected", async () => {
      // Legacy receipts with dev: signer ids normalize to local-dev provenance.
      delete process.env.AVE_DEV;
      setIsPackaged(true);
      const pluginDir = join(pluginsRoot, "p-v1-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb-v1-dev-signer");

      const v1Receipt = {
        schemaVersion: 1,
        pluginId: "tb-v1-dev-signer",
        version: "1.0.0",
        artifactSha256: "dev:local-install",
        signerKeyId: "dev:local-install",
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
      const { resolve: res } = await import("node:path");
      const receiptPath = res(cacheRoot, "tb-v1-dev-signer", "install-receipt.json");
      await mk(res(cacheRoot, "tb-v1-dev-signer"), { recursive: true });
      await wf(receiptPath, `${JSON.stringify(v1Receipt, null, 2)}\n`, "utf-8");

      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-v1-dev-signer", manifestPath, installedBy: "user" }]);
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).not.toContain("tb-v1-dev-signer");
    });

    it("v1 marketplace receipt (non-dev: signerKeyId) → normalised to marketplace → loads in packaged", async () => {
      delete process.env.AVE_DEV;
      setIsPackaged(true);
      const pluginDir = join(pluginsRoot, "p-v1-mkt");
      const manifestPath = await writePluginAt(pluginDir, "tb-v1-mkt");

      const v1Receipt = {
        schemaVersion: 1,
        pluginId: "tb-v1-mkt",
        version: "1.0.0",
        artifactSha256: "a".repeat(64),
        signerKeyId: "prod-v1",
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      const { writeFile: wf2, mkdir: mk2 } = await import("node:fs/promises");
      const { resolve: res2 } = await import("node:path");
      const receiptPath2 = res2(cacheRoot, "tb-v1-mkt", "install-receipt.json");
      await mk2(res2(cacheRoot, "tb-v1-mkt"), { recursive: true });
      await wf2(receiptPath2, `${JSON.stringify(v1Receipt, null, 2)}\n`, "utf-8");

      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-v1-mkt", manifestPath, installedBy: "user" }]);
      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();
      expect(runtime.listPluginIds()).toContain("tb-v1-mkt");
    });

    it("unpackaged build + local-dev receipt → plugin loads normally", async () => {
      process.env.AVE_DEV = "1";
      setIsPackaged(false);
      const pluginDir = join(pluginsRoot, "p-dev-signer-unpkg");
      const manifestPath = await writePluginAt(pluginDir, "tb-dev-signer-unpkg");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 3,
        pluginId: "tb-dev-signer-unpkg",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        admission: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-dev-signer-unpkg", manifestPath, installedBy: "user" }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.load();

      expect(runtime.listPluginIds()).toContain("tb-dev-signer-unpkg");
    });

    it("packaged build + local-dev receipt via restartPlugin → rejected", async () => {
      process.env.AVE_DEV = "1";
      setIsPackaged(false);
      const pluginDir = join(pluginsRoot, "p-restart-dev-signer");
      const manifestPath = await writePluginAt(pluginDir, "tb-restart-dev-signer");

      const devReceipt: PluginInstallReceipt = {
        schemaVersion: 3,
        pluginId: "tb-restart-dev-signer",
        version: "1.0.0",
        installSource: "local-dev",
        artifactSha256: null,
        signerKeyId: null,
        admission: null,
        installedAt: new Date(0).toISOString(),
        files: await hashReceiptFiles(pluginDir, ["entry.mjs", "plugin.json"]),
      };
      await writeInstallReceipt(cacheRoot, devReceipt);
      await writeTestPluginRegistry({ registryPath }, [{ id: "tb-restart-dev-signer", manifestPath, installedBy: "user" }]);

      const runtime = new PluginRuntime({
        hostRoot,
        registryPath,
        pluginsRoot,
        installReceiptCacheRoot: cacheRoot,
      });
      await runtime.startAll();
      expect(runtime.listPluginIds()).toContain("tb-restart-dev-signer");

      // Packaged mode rejects the replacement while preserving the incumbent until explicit unload.
      delete process.env.AVE_DEV;
      setIsPackaged(true);
      const auditCalls: Array<{ level: string; message: string }> = [];
      (runtime as unknown as { auditLog?: (level: string, msg: string) => void }).auditLog =
        (level, message) => auditCalls.push({ level, message });

      await runtime.restartPlugin("tb-restart-dev-signer");
      expect(runtime.listPluginIds()).toContain("tb-restart-dev-signer");
      await expect(runtime.call("tb_ping")).resolves.toBe("pong");
      expect(auditCalls).toContainEqual(
        expect.objectContaining({ level: "error", message: "plugin_integrity_rejected" }),
      );
    });
  });
});
