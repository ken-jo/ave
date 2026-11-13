import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindPluginInstanceIntegrity, readPluginInstanceIntegrity, recordPluginFactoryIntegrity } from "../runtime-integrity-evidence.js";
import { hashReceiptFiles, writeInstallReceipt } from "../plugin-install-receipt.js";
import type { PluginIntegrityEvidence } from "../runtime/index.js";
import type { RuntimePlugin, RuntimePluginFactory } from "../types.js";
import { makeTestTreeWritable, servedAgentPluginsDocument, TestPluginRuntime, writeTestPluginRegistry } from "./test-helpers.js";

const INTEGRITY: PluginIntegrityEvidence = {
  installSource: "marketplace", signerKeyId: "fixture-signer", artifactSha256: "a".repeat(64),
  rung: null, sourceOrigin: null,
};

describe("loaded runtime receipt evidence", () => {
  it("binds a frozen host snapshot to the exact factory and instance", () => {
    const instance: RuntimePlugin = { handlers: {} };
    const factory: RuntimePluginFactory = () => instance;
    const integrity = { ...INTEGRITY };
    recordPluginFactoryIntegrity(factory, "fixture-artifact", integrity);
    bindPluginInstanceIntegrity(instance, factory);
    integrity.artifactSha256 = "b".repeat(64);
    const evidence = readPluginInstanceIntegrity(instance);
    expect(evidence).toEqual({ pluginId: "fixture-artifact", integrity: INTEGRITY });
    if (evidence === undefined) throw new Error("Expected loaded receipt evidence");
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.integrity)).toBe(true);
    expect(readPluginInstanceIntegrity({ handlers: {} })).toBeUndefined();
  });

  it("does not publish failed replacement metadata under the incumbent instance", () => {
    const incumbent: RuntimePlugin = { handlers: {} };
    const first: RuntimePluginFactory = () => incumbent;
    const candidate: RuntimePluginFactory = () => ({ handlers: {} });
    recordPluginFactoryIntegrity(first, "fixture-artifact", INTEGRITY);
    bindPluginInstanceIntegrity(incumbent, first);
    recordPluginFactoryIntegrity(candidate, "fixture-artifact", { ...INTEGRITY, artifactSha256: "b".repeat(64) });
    expect(readPluginInstanceIntegrity(incumbent)?.integrity.artifactSha256).toBe(INTEGRITY.artifactSha256);
  });

  it("refuses instance metadata and clears authority when an instance has no verified factory", () => {
    const instance = { handlers: {}, integrity: INTEGRITY };
    const factory: RuntimePluginFactory = () => instance;
    expect(readPluginInstanceIntegrity(instance)).toBeUndefined();
    recordPluginFactoryIntegrity(factory, "fixture-artifact", INTEGRITY);
    bindPluginInstanceIntegrity(instance, factory);
    recordPluginFactoryIntegrity(factory, "fixture-artifact", undefined);
    bindPluginInstanceIntegrity(instance, factory);
    expect(readPluginInstanceIntegrity(instance)).toBeUndefined();
  });
});

describe("runtime publication of verified receipt identity", () => {
  let root: string | undefined;
  let runtime: TestPluginRuntime | undefined;

  afterEach(async () => {
    await runtime?.stopAll();
    if (root) {
      await makeTestTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the exact successful load evidence for the published runtime instance", async () => {
    root = await mkdtemp(join(tmpdir(), "ave-runtime-receipt-"));
    const hostRoot = join(root, "host");
    const pluginsRoot = join(root, "plugins");
    const pluginId = "fixture-artifact";
    const pluginRoot = join(pluginsRoot, pluginId);
    const registryPath = join(hostRoot, "registry.json");
    const cacheRoot = join(pluginsRoot, ".cache");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(hostRoot, { recursive: true });
    await writeFile(join(pluginRoot, "entry.mjs"), "export default async () => ({ handlers: {}, start: async () => {} });\n");
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(servedAgentPluginsDocument({
      id: pluginId, name: "Artifact fixture", version: "1.0.0", description: "Receipt identity fixture", entry: "entry.mjs", tools: [],
    })));
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3, pluginId, version: "1.0.0", installSource: "marketplace",
      artifactSha256: INTEGRITY.artifactSha256, signerKeyId: INTEGRITY.signerKeyId, admission: null,
      installedAt: new Date(0).toISOString(), files: await hashReceiptFiles(pluginRoot, ["entry.mjs", "plugin.json"]),
    });
    await writeTestPluginRegistry({ registryPath }, [{ id: pluginId, manifestPath: join(pluginRoot, "plugin.json") }]);
    runtime = new TestPluginRuntime({ hostRoot, pluginsRoot, registryPath, installReceiptCacheRoot: cacheRoot });
    await runtime.load();
    const projection = runtime.getRuntimeGenerationProjection(pluginId);
    expect(projection).toBeDefined();
    if (projection === undefined) throw new Error("Expected published plugin runtime");
    expect(readPluginInstanceIntegrity(projection.instance)).toEqual({ pluginId, integrity: INTEGRITY });
  });
});
