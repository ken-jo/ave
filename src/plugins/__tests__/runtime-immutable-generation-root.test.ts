import { mkdtemp } from "node:fs/promises";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoopHostApiForTests, PluginRuntime } from "../runtime.js";
import { hashReceiptFiles, writeInstallReceipt } from "../plugin-install-receipt.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import { agentPluginsDocument, servedAgentPluginsDocument, makeTestTreeWritable } from "./test-helpers.js";
import {
  HOST_PROTOCOL_VERSIONS_SERVED,
  IncompatibleHostProtocolError,
} from "../isolation/host-api-wire.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("PluginRuntime immutable generation root", () => {
  it("keeps canonical generations immutable while an alias-backed receipt restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-runtime-generation-root-"));
    roots.push(root);
    const pluginsRoot = join(root, "plugins");
    const cacheRoot = join(root, "cache");
    const pluginId = "immutable-root";
    const installId = "immutable-root-marketplace";
    const pluginRoot = join(pluginsRoot, pluginId);
    const registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginRoot, { recursive: true });
    const manifest = {
      id: pluginId,
      name: "Immutable root",
      version: "1.0.0",
      entry: "entry.mjs",
      description: "Reads one receipt-covered fixture byte.",
      tools: [{
        name: "immutable_root_read",
        description: "Read the immutable generation fixture.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        _meta: { ui: { visibility: ["model"] } },
      }],
    };
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(servedAgentPluginsDocument(manifest)), "utf8");
    await writeFile(join(pluginRoot, "value.txt"), "g1", "utf8");
    await writeFile(
      join(pluginRoot, "entry.mjs"),
      `import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export default async function createPlugin(ctx) {
  return { handlers: { immutable_root_read: async () => readFile(resolve(ctx.pluginRoot, "value.txt"), "utf8") } };
}`,
      "utf8",
    );
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: installId, manifestPath: join(pluginRoot, "plugin.json"), enabled: true }],
    }), "utf8");
    const receiptFiles = ["entry.mjs", "plugin.json", "value.txt"];
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3,
      pluginId: installId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "test-v1",
      admission: null,
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginRoot, receiptFiles),
    });

    let runtime!: PluginRuntime;
    let active: {
      pluginId: string;
      generationId: string;
      state: HostPluginGenerationState;
    } | undefined;
    const generationId = "b".repeat(64);
    const access = {
      getActive: vi.fn(() => active),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      acquireExact: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      runWithLease: vi.fn(async (_lease, operation) => operation()),
      replaceRuntime: vi.fn(async (projection: PluginRuntimeGenerationProjection) => {
        projection.hostEffects?.bindGeneration(access as never, generationId);
        runtime.prepareRuntimeGeneration(projection, active?.generationId).publish();
        active = {
          pluginId,
          generationId,
          state: {
            payloadRoot: projection.pluginRoot,
            runtime: projection,
            hooks: [],
            mcpServers: [],
          },
        };
      }),
      waitForRetirements: vi.fn(async () => undefined),
    };
    runtime = new PluginRuntime({ childEntryPath: pluginChildEntryPath(), encryption: unavailableSecretEncryption,
      hostRoot: root,
      registryPath,
      pluginsRoot,
      installReceiptCacheRoot: cacheRoot,
      createHostApi: createNoopHostApiForTests,
    });
    runtime.setGenerationAccess(access as never);
    await runtime.startAll();

    const bootProjection = runtime.getRuntimeGenerationProjection(pluginId);
    expect(bootProjection?.pluginRoot).toContain(`${join(cacheRoot, pluginId, "generations")}`);
    expect(bootProjection?.installId).toBe(installId);
    expect(await runtime.call("immutable_root_read")).toBe("g1");

    await writeFile(join(pluginRoot, "value.txt"), "g2", "utf8");
    expect(await readFile(join(pluginRoot, "value.txt"), "utf8")).toBe("g2");
    expect(await runtime.call("immutable_root_read")).toBe("g1");
    expect(access.acquire).toHaveBeenCalled();

    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3,
      pluginId: installId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "b".repeat(64),
      signerKeyId: "test-v1",
      admission: null,
      installedAt: new Date(1).toISOString(),
      files: await hashReceiptFiles(pluginRoot, receiptFiles),
    });
    await expect(runtime.restartPlugin(installId)).resolves.toBe("started");
    expect(await runtime.call("immutable_root_read")).toBe("g2");

    const generationsRoot = join(cacheRoot, pluginId, "generations");
    const generationIdsBeforeFailedRestart = await readdir(generationsRoot);
    await writeFile(join(pluginRoot, "entry.mjs"), "export default {", "utf8");
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3,
      pluginId: installId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "c".repeat(64),
      signerKeyId: "test-v1",
      admission: null,
      installedAt: new Date(2).toISOString(),
      files: await hashReceiptFiles(pluginRoot, receiptFiles),
    });
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("failed");
    expect(await readdir(generationsRoot)).toEqual(generationIdsBeforeFailedRestart);
    expect(await runtime.call("immutable_root_read")).toBe("g2");
  });

  it("keeps the running generation when the child factory refuses a restart's manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-runtime-refused-restart-"));
    roots.push(root);
    const pluginsRoot = join(root, "plugins");
    const cacheRoot = join(root, "cache");
    const pluginId = "refused-restart";
    const pluginRoot = join(pluginsRoot, pluginId);
    const registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginRoot, { recursive: true });
    const manifest = {
      id: pluginId,
      name: "Refused restart",
      version: "1.0.0",
      entry: "entry.mjs",
      description: "Answers which generation is serving.",
      tools: [{
        name: "refused_restart_which",
        description: "Name the serving generation.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        _meta: { ui: { visibility: ["model"] } },
      }],
    };
    const receiptFiles = ["entry.mjs", "plugin.json"];
    const writeGeneration = async (document: Record<string, unknown>, answer: string, at: number) => {
      await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(document), "utf8");
      await writeFile(
        join(pluginRoot, "entry.mjs"),
        `export default async function createPlugin() {
  return { handlers: { refused_restart_which: async () => ${JSON.stringify(answer)} } };
}`,
        "utf8",
      );
      await writeInstallReceipt(cacheRoot, {
        schemaVersion: 3,
        pluginId,
        version: "1.0.0",
        installSource: "marketplace",
        artifactSha256: String(at).repeat(64),
        signerKeyId: "test-v1",
        admission: null,
        installedAt: new Date(at).toISOString(),
        files: await hashReceiptFiles(pluginRoot, receiptFiles),
      });
    };
    await writeGeneration(servedAgentPluginsDocument(manifest), "incumbent", 1);
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: pluginId, manifestPath: join(pluginRoot, "plugin.json"), enabled: true }],
    }), "utf8");

    let runtime!: PluginRuntime;
    let active: {
      pluginId: string;
      generationId: string;
      state: HostPluginGenerationState;
    } | undefined;
    let published = 0;
    const access = {
      getActive: vi.fn(() => active),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      acquireExact: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      runWithLease: vi.fn(async (_lease, operation) => operation()),
      replaceRuntime: vi.fn(async (projection: PluginRuntimeGenerationProjection) => {
        const generationId = String(++published).repeat(64);
        projection.hostEffects?.bindGeneration(access as never, generationId);
        runtime.prepareRuntimeGeneration(projection, active?.generationId).publish();
        active = {
          pluginId,
          generationId,
          state: {
            payloadRoot: projection.pluginRoot,
            runtime: projection,
            hooks: [],
            mcpServers: [],
          },
        };
      }),
      waitForRetirements: vi.fn(async () => undefined),
    };
    const audit: Array<{ level: string; message: string; data?: unknown }> = [];
    runtime = new PluginRuntime({ childEntryPath: pluginChildEntryPath(), encryption: unavailableSecretEncryption,
      hostRoot: root,
      registryPath,
      pluginsRoot,
      installReceiptCacheRoot: cacheRoot,
      createHostApi: createNoopHostApiForTests,
      auditLog: (level, message, data) => { audit.push({ level, message, data }); },
    });
    runtime.setGenerationAccess(access as never);
    await runtime.startAll();
    expect(await runtime.call("refused_restart_which")).toBe("incumbent");
    const incumbentGenerationId = active?.generationId;
    const generationsRoot = join(cacheRoot, pluginId, "generations");
    const generationsBefore = await readdir(generationsRoot);
    expect(generationsBefore).toHaveLength(1);

    const undeclared = { ...manifest, requires: undefined };
    await writeGeneration(agentPluginsDocument(undeclared), "replacement", 2);
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("failed");

    const expectedMessage = new IncompatibleHostProtocolError(pluginId, { declared: null }).message;
    expect(audit.filter((entry) => entry.message === "plugin_incompatible_host_protocol")).toEqual([{
      level: "error",
      message: "plugin_incompatible_host_protocol",
      data: { pluginId, declared: null, served: [...HOST_PROTOCOL_VERSIONS_SERVED] },
    }]);
    const card = runtime.listPluginCards().find((entry) => entry.id === pluginId);
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.installFailureKind).toBeUndefined();
    expect(card?.lastAttemptRefusal).toEqual({
      attempt: "restart",
      kind: "incompatible-host-protocol",
      message: expectedMessage,
      at: expect.any(String),
    });
    expect(active?.generationId).toBe(incumbentGenerationId);
    expect(await runtime.call("refused_restart_which")).toBe("incumbent");
    expect(await readdir(generationsRoot)).toEqual(generationsBefore);

    await writeGeneration(servedAgentPluginsDocument(manifest), "fixed", 3);
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("started");
    expect(await runtime.call("refused_restart_which")).toBe("fixed");
    expect(runtime.listPluginCards().find((entry) => entry.id === pluginId)?.lastAttemptRefusal)
      .toBeUndefined();
  });
});
