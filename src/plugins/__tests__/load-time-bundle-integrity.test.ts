/** Boot preflight must recheck unpacked payload digests against the receipt before importing code. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInstallReceipt,
  installReceiptPath,
  writeInstallReceipt,
} from "../plugin-install-receipt.js";
import { preflightPluginLoadPlan } from "../runtime/index.js";
import { verifyPluginIntegrity } from "../runtime/index.js";
import type { PluginManifest } from "../types.js";

const PLUGIN_ID = "ave-plugin-integrity-fixture";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Integrity Fixture",
  version: "1.0.0",
  description: "load-time integrity fixture",
  entry: "dist/index.js",
  tools: [],
};

describe("plugin load-time bundle integrity", () => {
  let root: string;
  let pluginsRoot: string;
  let cacheRoot: string;
  let pluginRoot: string;
  let manifestPath: string;

  async function preflight() {
    const [outcome] = await preflightPluginLoadPlan(
      [{ pluginIdHint: PLUGIN_ID, manifestPath, enabled: true }],
      {
        prepare: async () => undefined,
        verify: (pluginId, root) => verifyPluginIntegrity(cacheRoot, pluginId, root),
        readManifest: async () => MANIFEST,
      },
    );
    return outcome!;
  }

  async function integrityRefusalReason(): Promise<string> {
    const outcome = await preflight();
    if (outcome.ok || outcome.kind !== "integrity") {
      throw new Error(`expected an integrity refusal, got ${JSON.stringify(outcome)}`);
    }
    return outcome.integrityResult.reason;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ave-load-integrity-"));
    pluginsRoot = join(root, "plugins");
    cacheRoot = join(pluginsRoot, ".cache");
    pluginRoot = join(pluginsRoot, PLUGIN_ID);
    manifestPath = join(pluginRoot, "plugin.json");
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    await mkdir(join(cacheRoot, PLUGIN_ID), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");
    await writeFile(
      join(pluginRoot, "dist", "index.js"),
      "export default async () => ({ handlers: {}, start: async () => {} });\n",
      "utf8",
    );
    const { receipt } = await buildInstallReceipt(pluginRoot, {
      pluginId: PLUGIN_ID,
      version: MANIFEST.version,
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "test-signer",
      files: ["plugin.json", "dist/index.js"],
    });
    await writeInstallReceipt(cacheRoot, receipt);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("admits an unpacked bundle that still matches its install receipt", async () => {
    const outcome = await preflight();
    expect(outcome.ok).toBe(true);
    expect(outcome.integrityResult).toMatchObject({
      ok: true,
      verified: { installSource: "marketplace", signerKeyId: "test-signer" },
    });
  });

  it("refuses the load when dist/ was rewritten after install", async () => {
    await writeFile(
      join(pluginRoot, "dist", "index.js"),
      "export default async () => { require('node:child_process'); };\n",
      "utf8",
    );
    expect(await integrityRefusalReason()).toBe("receipt hash mismatch: dist/index.js");
  });

  it("refuses the load when an extra module is planted beside the entry", async () => {
    await writeFile(join(pluginRoot, "dist", "payload.js"), "export const x = 1;\n", "utf8");
    expect(await integrityRefusalReason()).toContain("unlisted file: dist/payload.js");
  });

  it("refuses the load when the receipt itself was deleted", async () => {
    await rm(installReceiptPath(cacheRoot, PLUGIN_ID));
    expect(await integrityRefusalReason()).toContain("install receipt missing");
  });

  it("still admits the load after the plugin writes into its own data dir", async () => {
    await mkdir(join(pluginRoot, "data"), { recursive: true });
    await writeFile(join(pluginRoot, "data", "index.db"), "runtime state", "utf8");
    const outcome = await preflight();
    expect(outcome.ok).toBe(true);
  });

  it("still admits the load with a leftover file in the host worker run dir", async () => {
    await mkdir(join(pluginRoot, "run", "indexer"), { recursive: true });
    await writeFile(join(pluginRoot, "run", "indexer", "worker.pid"), "4242", "utf8");
    const outcome = await preflight();
    expect(outcome.ok).toBe(true);
  });

  it("still admits the load with a leftover file in the plugin's own socket dir", async () => {
    await mkdir(join(pluginRoot, "sockets"), { recursive: true });
    await writeFile(join(pluginRoot, "sockets", "broker.pid"), "4242", "utf8");
    const outcome = await preflight();
    expect(outcome.ok).toBe(true);
  });

  // Host run/ and plugin sockets/ are separate runtime roots; both must be excluded from payload integrity scans.
  it.skipIf(process.platform === "win32")(
    "still admits the load when the plugin left its own socket behind",
    async () => {
      const shortRoot = await mkdtemp("/tmp/ave-psock-");
      const shortPluginRoot = join(shortRoot, "p");
      const shortCacheRoot = join(shortRoot, "c");
      const socketDir = join(shortPluginRoot, "sockets");
      await mkdir(join(shortPluginRoot, "dist"), { recursive: true });
      await mkdir(socketDir, { recursive: true });
      await writeFile(join(shortPluginRoot, "plugin.json"), "{}\n", "utf8");
      await writeFile(join(shortPluginRoot, "dist", "index.js"), "export default 1;\n", "utf8");
      const { receipt } = await buildInstallReceipt(shortPluginRoot, {
        pluginId: PLUGIN_ID,
        version: MANIFEST.version,
        installSource: "marketplace",
        artifactSha256: "c".repeat(64),
        signerKeyId: "test-signer",
        files: ["plugin.json", "dist/index.js"],
      });
      await mkdir(join(shortCacheRoot, PLUGIN_ID), { recursive: true });
      await writeInstallReceipt(shortCacheRoot, receipt);

      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(socketDir, "egress.sock"), resolve);
      });
      try {
        await expect(
          verifyPluginIntegrity(shortCacheRoot, PLUGIN_ID, shortPluginRoot),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(shortRoot, { recursive: true, force: true });
      }
    },
  );

  // Unix socket paths have a roughly 104-byte limit, so this fixture needs a short root.
  it.skipIf(process.platform === "win32")(
    "still admits the load when a crashed worker left its control socket behind",
    async () => {
      const shortRoot = await mkdtemp("/tmp/ave-sock-");
      const shortPluginRoot = join(shortRoot, "p");
      const shortCacheRoot = join(shortRoot, "c");
      const socketDir = join(shortPluginRoot, "run", "w");
      await mkdir(join(shortPluginRoot, "dist"), { recursive: true });
      await mkdir(socketDir, { recursive: true });
      await writeFile(join(shortPluginRoot, "plugin.json"), "{}\n", "utf8");
      await writeFile(join(shortPluginRoot, "dist", "index.js"), "export default 1;\n", "utf8");
      const { receipt } = await buildInstallReceipt(shortPluginRoot, {
        pluginId: PLUGIN_ID,
        version: MANIFEST.version,
        installSource: "marketplace",
        artifactSha256: "b".repeat(64),
        signerKeyId: "test-signer",
        files: ["plugin.json", "dist/index.js"],
      });
      await mkdir(join(shortCacheRoot, PLUGIN_ID), { recursive: true });
      await writeInstallReceipt(shortCacheRoot, receipt);

      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(socketDir, "control.sock"), resolve);
      });
      try {
        await expect(
          verifyPluginIntegrity(shortCacheRoot, PLUGIN_ID, shortPluginRoot),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(shortRoot, { recursive: true, force: true });
      }
    },
  );
});
