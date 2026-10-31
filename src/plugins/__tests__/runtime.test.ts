import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createNoopHostApiForTests, PluginRuntime } from "../runtime.js";
import { hashReceiptFiles, installReceiptPath, writeInstallReceipt } from "../plugin-install-receipt.js";
import { PluginPhase } from "../lifecycle-log.js";
import { PluginBundleLifecycle } from "../plugin-bundle-lifecycle.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { SkillStore } from "../../main/skill-store.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import { runCleanupWithHardTimeout } from "../../main/shutdown-timeout.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { McpGovernance } from "../../mcp/mcp-governance.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { createDynamicTool } from "../../tools/base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { classifyApplyError } from "../../marketplace/updates/apply.js";
import { isCommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import type { PackageKey } from "../../marketplace/sources/policy.js";
import { uninstallPluginWithLifecycle } from "../uninstall-lifecycle.js";
import { mkdtempSync } from "node:fs";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime as constructTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  makeTestTreeWritable,
  bindTestPluginRuntimeGeneration,
  createTestHostApiFactory,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "./test-helpers.js";
import { agentPluginsDocument, childProcessGate, patchAveFields, pluginDataDirIn } from "./test-helpers.js";
import { buildManifestValidator, manifestDocumentSha256 } from "../runtime/manifest-validation.js";
import type { PluginManifest } from "../types.js";
import { canonicalJSON } from "../secret-access/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { raceWithTimeout } from "../../shared/abortable-deadline.js";

let manifestValidator: Awaited<ReturnType<typeof buildManifestValidator>>;
const testRuntimes = new Set<PluginRuntime>();
const retainedRuntimes = new Set<PluginRuntime>();

beforeAll(async () => {
  manifestValidator = await buildManifestValidator();
});

function prepareTestRuntime(runtime: PluginRuntime): PluginRuntime {
  // Share compiled schema code, never validation verdicts; validation and error reads are synchronous.
  (runtime as unknown as { manifestValidator: typeof manifestValidator }).manifestValidator = manifestValidator;
  testRuntimes.add(runtime);
  return runtime;
}

function makeTestPluginRuntime(...args: Parameters<typeof constructTestPluginRuntime>): PluginRuntime {
  return prepareTestRuntime(constructTestPluginRuntime(...args));
}

async function stopTestRuntimes(): Promise<boolean> {
  const runtimes = [...testRuntimes];
  const results = await Promise.allSettled(runtimes.map((runtime) => runtime.stopAll()));
  let stopped = true;
  for (const [index, result] of results.entries()) {
    const runtime = runtimes[index]!;
    testRuntimes.delete(runtime);
    if (result.status === "rejected" || result.value.unfinished.length > 0) {
      retainedRuntimes.add(runtime);
      stopped = false;
    }
  }
  return stopped;
}

async function removeStoppedTestRoot(root: string): Promise<void> {
  if (await stopTestRuntimes()) {
    await rm(root, { recursive: true, force: true });
  } else {
    console.warn("Plugin runtime shutdown is incomplete; retained temporary directory: %s", root);
  }
}

function servedPluginDocument(manifest: Record<string, unknown>): Record<string, unknown> {
  const requires = manifest.requires as Record<string, unknown> | undefined;
  return agentPluginsDocument({ ...manifest, requires: { hostProtocol: "4", ...requires } });
}

function makeGenerationBoundRuntime(
  options: Omit<ConstructorParameters<typeof PluginRuntime>[0], "createHostApi" | "encryption" | "childEntryPath">
    & Partial<Pick<ConstructorParameters<typeof PluginRuntime>[0], "createHostApi" | "encryption" | "childEntryPath">>,
): PluginRuntime {
  return prepareTestRuntime(bindTestPluginRuntimeGeneration(new PluginRuntime({ encryption: unavailableSecretEncryption,
    childEntryPath: pluginChildEntryPath(),
    ...options,
    createHostApi: createTestHostApiFactory(options.createHostApi),
  })));
}

describe("PluginRuntime.setPluginEnabled(id, false)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let required: PackageKey[] = [];
  const REQUIRED = { kind: "plugin" as const, name: "p-required", source: "corp" };
  const corpOrigin = {
    sourceId: "corp",
    sourceOrigin: "managed",
    commit: "c".repeat(40),
    packagePath: "plugins/p-required",
    version: "1.0.0",
    rung: "release",
    artifactSha256: "d".repeat(64),
    installedAt: "2026-09-24T00:00:00.000Z",
  };
  let requiredPlugin: {
    runtime: PluginRuntime;
    guard: PluginDeploymentGuard;
    registryPath: string;
    registry: string;
  };
  const sharedDisposers: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-required-policy-" });
    sharedDisposers.push(() => rm(fixture.rootDir, { recursive: true, force: true }));
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-required",
      entrySource: makeTestPluginEntrySource({ p_required_hello: JSON.stringify("hi-p-required") }),
      manifest: {
        tools: [{
          name: "p_required_hello",
          description: "p_required_hello tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
      },
    });
    await writeTestPluginRegistry(fixture, [
      { id: "p-required", manifestPath, enabled: true, origin: corpOrigin },
    ]);
    const guard = new PluginDeploymentGuard({
      registryPath: fixture.registryPath,
      pluginsRoot: fixture.pluginsRoot,
      requiredInstalls: async () => required,
    });
    const runtime = makeTestPluginRuntime(fixture, { deploymentGuard: guard });
    // Share the stateless child until every policy-check consumer finishes.
    testRuntimes.delete(runtime);
    sharedDisposers.unshift(async () => {
      const report = await runtime.stopAll();
      if (report.unfinished.length > 0) {
        retainedRuntimes.add(runtime);
        throw new Error("Required-plugin fixture shutdown is incomplete; its temporary directory was retained");
      }
    });
    required = [REQUIRED];
    await runtime.startAll();
    requiredPlugin = {
      runtime, guard, registryPath: fixture.registryPath,
      registry: await readFile(fixture.registryPath, "utf8"),
    };
  });

  afterAll(async () => {
    for (const dispose of sharedDisposers) await dispose();
  });

  async function resetRequiredPlugin() {
    required = [REQUIRED];
    vi.restoreAllMocks();
    // Refusals and idempotent enable must leave the baseline intact; never repair it between cases.
    expect(await readFile(requiredPlugin.registryPath, "utf8")).toBe(requiredPlugin.registry);
    expect(requiredPlugin.runtime.listPluginIds()).toEqual(["p-required"]);
    expect(requiredPlugin.runtime.listToolNames()).toEqual(["p_required_hello"]);
    return requiredPlugin;
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-runtime-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
    required = [];
  });

  afterEach(async () => {
    await removeStoppedTestRoot(testDir);
    vi.restoreAllMocks();
  });

  async function writeFakePlugin(
    id: string,
    installPolicy?: "admin" | "user",
  ): Promise<string> {
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    const manifest: Record<string, unknown> = {};
    if (installPolicy) manifest.installPolicy = installPolicy;
    const { manifestPath } = await writeTestPlugin(
      {
        rootDir: testDir,
        pluginsRoot: installedDir,
        registryPath,
      },
      {
        id,
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        entrySource: makeTestPluginEntrySource({
          [methodName]: JSON.stringify(`hi-${id}`),
        }),
        manifest,
      },
    );
    return manifestPath;
  }

  function makeRuntime(): PluginRuntime {
    const guard = new PluginDeploymentGuard({
      registryPath,
      pluginsRoot: installedDir,
      requiredInstalls: async () => required,
    });
    return makeTestPluginRuntime(
      {
        rootDir: testDir,
        registryPath,
        pluginsRoot: installedDir,
      },
      {
        deploymentGuard: guard,
      },
    );
  }

  it("deactivates a live generation when durable uninstall is already missing", async () => {
    const pluginId = "p-idempotent-uninstall";
    const toolName = "p_idempotent_uninstall_hello";
    const manifestPath = await writeFakePlugin(pluginId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call(toolName)).resolves.toBe(`hi-${pluginId}`);

    await expect(uninstallPluginWithLifecycle(pluginId, {
      pluginRuntime: runtime,
      pluginMarketplace: {
        getInstalledVersion: vi.fn(async () => null),
        uninstall: vi.fn(async () => {
          throw new Error(`Plugin not installed: ${pluginId}`);
        }),
      },
      settingsService: {
        deletePluginConfig: vi.fn(async () => undefined),
        deletePluginSecrets: vi.fn(async () => 0),
      },
      pluginPaths: { cacheRoot: join(testDir, ".cache") },
      clearAuthPartitionService: vi.fn(async () => undefined),
      listPluginAuthPartitionsService: vi.fn(() => [
        `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
      ]),
      forgetPluginAuthPartitionsService: vi.fn(async () => undefined),
      drainPluginInstallLockOperationsService: vi.fn(async () => undefined),
    })).resolves.toEqual({ pluginId, uninstalled: true });

    expect(runtime.listPluginIds()).not.toContain(pluginId);
    await expect(runtime.call(toolName)).rejects.toThrow(/not found/);
  });

  async function writePluginWithEntry(
    id: string,
    methodName: string,
    entrySource: string,
    manifest: Record<string, unknown> = {},
  ): Promise<string> {
    const { manifestPath } = await writeTestPlugin(
      {
        rootDir: testDir,
        pluginsRoot: installedDir,
        registryPath,
      },
      {
        id,
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        entrySource,
        manifest,
      },
    );
    return manifestPath;
  }

  it("disable removes methods + marks registry enabled=false for user plugin", async () => {
    const manifestPath = await writeFakePlugin("p-user");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "p-user", manifestPath, enabled: true },
    ]);
    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds()).toContain("p-user");
    expect(runtime.listToolNames()).toContain("p_user_hello");

    await runtime.setPluginEnabled("p-user", false);

    expect(runtime.listPluginIds()).not.toContain("p-user");
    expect(runtime.listToolNames()).not.toContain("p_user_hello");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find(
      (p: { id: string }) => p.id === "p-user",
    );
    expect(entry.enabled).toBe(false);
  });

  it("disable rejects a plugin the policy requires and leaves state unchanged", async () => {
    const { runtime, registryPath } = await resetRequiredPlugin();

    await expect(runtime.setPluginEnabled("p-required", false)).rejects.toThrow(
      /required by policy \(source corp\); it cannot be disabled/,
    );

    expect(runtime.listPluginIds()).toContain("p-required");
    expect(runtime.listToolNames()).toContain("p_required_hello");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find(
      (p: { id: string }) => p.id === "p-required",
    );
    expect(entry.enabled).toBe(true);
  });

  it("disable is not refused by a legacy admin claim in the manifest or the registry", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "admin");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "p-managed", manifestPath, enabled: true, installSource: "admin" },
    ]);
    const runtime = makeRuntime();
    await runtime.startAll();

    await runtime.setPluginEnabled("p-managed", false);

    expect(runtime.listPluginIds()).not.toContain("p-managed");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find(
      (p: { id: string }) => p.id === "p-managed",
    );
    expect(entry.enabled).toBe(false);
  });

  it("disable throws 'not found' for unknown pluginId without mutating state", async () => {
    const manifestPath = await writeFakePlugin("p-existing");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "p-existing", manifestPath, enabled: true },
    ]);
    const runtime = makeRuntime();
    await runtime.startAll();

    await expect(runtime.setPluginEnabled("p-missing", false)).rejects.toThrow(/not found/i);

    expect(runtime.listPluginIds()).toContain("p-existing");
  });

  /** The registry enabled writer must consult deployment policy so settings cannot disable required plugins. */
  function makeRuntimeWithGuard(): {
    runtime: PluginRuntime;
    guard: PluginDeploymentGuard;
  } {
    const guard = new PluginDeploymentGuard({
      registryPath,
      pluginsRoot: installedDir,
      requiredInstalls: async () => required,
    });
    const runtime = makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot: installedDir },
      { deploymentGuard: guard },
    );
    return { runtime, guard };
  }

  it("setPluginEnabled(false) rejects a plugin the policy requires and leaves it enabled", async () => {
    const { runtime, registryPath } = await resetRequiredPlugin();

    await expect(runtime.setPluginEnabled("p-required", false)).rejects.toThrow(
      /required by policy/,
    );

    expect(runtime.listPluginIds()).toContain("p-required");
    expect(runtime.listToolNames()).toContain("p_required_hello");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(
      registry.plugins.find((p: { id: string }) => p.id === "p-required").enabled,
    ).toBe(true);
  });

  it("setPluginEnabled(false) disables a registry installSource=admin plugin: no install source locks it", async () => {
    const manifestPath = await writeFakePlugin("p-managed");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "p-managed", manifestPath, enabled: true, installSource: "admin" },
    ]);
    const { runtime } = makeRuntimeWithGuard();
    await runtime.startAll();

    await runtime.setPluginEnabled("p-managed", false);

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(
      registry.plugins.find((p: { id: string }) => p.id === "p-managed").enabled,
    ).toBe(false);
  });

  it("setPluginEnabled(false) still disables an ordinary user plugin", async () => {
    const manifestPath = await writeFakePlugin("p-user");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "p-user", manifestPath, enabled: true },
    ]);
    const { runtime } = makeRuntimeWithGuard();
    await runtime.startAll();

    await runtime.setPluginEnabled("p-user", false);

    expect(runtime.listPluginIds()).not.toContain("p-user");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(
      registry.plugins.find((p: { id: string }) => p.id === "p-user").enabled,
    ).toBe(false);
  });

  it("setPluginEnabled does not consult the disable guard on the enable direction", async () => {
    // Idempotent enable must preserve the live generation.
    const { runtime, guard } = await resetRequiredPlugin();
    const canDisable = vi.spyOn(guard, "canDisable");

    await runtime.setPluginEnabled("p-required", true);

    expect(canDisable).not.toHaveBeenCalled();
    expect(runtime.listPluginIds()).toContain("p-required");
  });

  it("plugin with kebab-case id (example-plugin) and underscore methods loads correctly", async () => {
    // Plugin IDs allow kebab-case; tool names use the separate underscore namespace.
    const pluginId = "example-plugin";
    const pluginDir = join(installedDir, "com-example-test");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: { "com_example_test_hello": async () => "hi" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    const manifest = {
      id: pluginId,
      name: "Test",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: "com_example_test_hello",
          description: "com_example_test_hello tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "Test plugin fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: pluginId, manifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds()).toContain("example-plugin");
    expect(runtime.listToolNames()).toContain("com_example_test_hello");
  });

  it("plugin with dot-notation method name is dropped fail-soft with a clear error", async () => {
    const pluginDir = join(installedDir, "bad-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "bad.method": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = {
      id: "bad-plugin",
      name: "Bad",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: ["bad.method"],
      description: "Test fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "bad-plugin", manifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-plugin");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with method name starting with digit is dropped fail-soft", async () => {
    const pluginDir = join(installedDir, "bad-leading-digit");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "1bad_name": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = {
      id: "bad-leading-digit",
      name: "Bad",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: ["1bad_name"],
      description: "Test fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "bad-leading-digit", manifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-leading-digit");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with hyphen in method name is dropped fail-soft", async () => {
    const pluginDir = join(installedDir, "bad-hyphen");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "bad-name": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = {
      id: "bad-hyphen",
      name: "Bad",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: ["bad-name"],
      description: "Test fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "bad-hyphen", manifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-hyphen");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin missing description is dropped with an error (Phase 1 MUST field)", async () => {
    const pluginDir = join(installedDir, "no-description");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { no_desc_ping: async () => "pong" } };
}`,
      "utf-8",
    );

    const manifest = {
      id: "no-description",
      name: "No Desc",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: "no_desc_ping",
          description: "no_desc_ping tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "no-description", manifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("no-description");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with empty-string description is dropped with an error (Phase 1 MUST non-empty)", async () => {
    const pluginDir = join(installedDir, "empty-description");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { empty_desc_ping: async () => "pong" } };
}`,
      "utf-8",
    );

    const manifest = {
      id: "empty-description",
      name: "Empty Desc",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: "empty_desc_ping",
          description: "empty_desc_ping tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "empty-description", manifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("empty-description");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("callFromUi rejects tools not declared app-visible in _meta.ui.visibility", async () => {
    // Renderer calls require app visibility; other tools must pass conversation scope and permission gates.
    const pluginDir = join(installedDir, "ui-actions");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "uic_get": async () => "public-ok",
      "uic_private": async () => "private-ok",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "ui-actions",
        name: "ui-actions",
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: "uic_get",
            description: "uic_get tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
          {
            name: "uic_private",
            description: "uic_private tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      })),
      "utf-8");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "ui-actions", manifestPath, enabled: true },
    ]);
    const runtime = makeRuntime();
    await runtime.startAll();
    const delegate = vi.fn((method, payload) => runtime.call(method, payload));
    runtime.setToolInvocationDelegate(delegate);

    await expect(
      runtime.callFromUi("uic_get", undefined, { userAction: true }),
    ).resolves.toBe("public-ok");
    expect(delegate).toHaveBeenCalledWith(
      "uic_get",
      undefined,
      expect.objectContaining({
        origin: "ui",
        ownerPluginId: "ui-actions",
        userAction: true,
      }),
    );
    await expect(runtime.callFromUi("uic_private")).rejects.toThrow(
      /not an app-visible Tool/,
    );
    await expect(runtime.call("uic_private")).resolves.toBe("private-ok");
  });

  it("callFromUi can invoke UI-only methods that are not LLM tools", async () => {
    const pluginDir = join(installedDir, "ui-only-method");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "uio_upload_chunk": async () => "ui-only-ok",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "ui-only-method",
        name: "ui-only-method",
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: "uio_upload_chunk",
            description: "uio_upload_chunk tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      })),
      "utf-8");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "ui-only-method", manifestPath, enabled: true },
    ]);
    const runtime = makeRuntime();
    await runtime.startAll();
    runtime.setToolInvocationDelegate((method, payload) =>
      runtime.call(method, payload),
    );

    await expect(runtime.callFromUi("uio_upload_chunk")).resolves.toBe(
      "ui-only-ok",
    );
  });

  it("exposes capability/manifest/ipc binding metadata from loaded plugins", async () => {
    const pluginDir = join(installedDir, "meta-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "meta_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "meta-plugin",
        name: "meta-plugin",
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: "meta_ping",
            description: "meta_ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        capabilities: ["sample-capability"],
      })),
      "utf-8");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "meta-plugin", manifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIdsByCapability("sample-capability")).toEqual([
      "meta-plugin",
    ]);

    const manifest = runtime.getPluginManifest("meta-plugin");
    expect(manifest?.capabilities).toEqual(["sample-capability"]);
  });

  it("hands the HostApi factory the digest of the plugin.json document, the value installers pin", async () => {
    // Secret grants must hash the authored document, not the host flat projection.
    const pluginDir = join(installedDir, "pin-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), "export default async function createPlugin() { return { handlers: { pin_ping: async () => \"pong\" } }; }\n", "utf-8");
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument({
      id: "pin-plugin",
      name: "pin-plugin",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [{ name: "pin_ping", description: "pin_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "Test fixture.",
    })), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "pin-plugin", manifestPath, enabled: true }]);
    const seen: PluginManifest[] = [];
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir, requiredInstalls: async () => [] }),
      pluginsRoot: installedDir,
      createHostApi: (_pluginId, manifest) => {
        seen.push(manifest);
        return { emitEvent: () => {}, onEvent: () => () => {}, getSecret: () => null, logEvent: () => {}, onShutdown: () => {} } as never;
      },
    });
    await runtime.startAll();
    await runtime.restartPlugin("pin-plugin");

    const documentSha = sha256Hex(canonicalJSON(JSON.parse(await readFile(manifestPath, "utf-8"))));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const manifest of seen) {
      expect(manifestDocumentSha256(manifest)).toBe(documentSha);
      expect(sha256Hex(canonicalJSON(manifest))).not.toBe(documentSha);
    }
  });

  it("digests a pre-switch plugin.json as authored, though the loader drops its retired fields", async () => {
    // Registry pins cover legacy installPolicy and publisher fields until the next update.
    const pluginDir = join(installedDir, "legacy-pin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), "export default async function createPlugin() { return { handlers: { legacy_ping: async () => \"pong\" } }; }\n", "utf-8");
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument({
      id: "legacy-pin",
      name: "legacy-pin",
      version: "1.0.0",
      entry: "entry.mjs",
      installPolicy: "admin",
      publisher: "Ave",
      tools: [{ name: "legacy_ping", description: "legacy_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "Test fixture.",
    })), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "legacy-pin", manifestPath, enabled: true }]);
    const seen: PluginManifest[] = [];
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir, requiredInstalls: async () => [] }),
      pluginsRoot: installedDir,
      createHostApi: (_pluginId, manifest) => {
        seen.push(manifest);
        return { emitEvent: () => {}, onEvent: () => () => {}, getSecret: () => null, logEvent: () => {}, onShutdown: () => {} } as never;
      },
    });
    await runtime.startAll();

    const authored = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    expect(JSON.stringify(authored)).toContain("installPolicy");
    expect(seen).toHaveLength(1);
    expect(manifestDocumentSha256(seen[0]!)).toBe(sha256Hex(canonicalJSON(authored)));
  });

  describe("PluginHostApi cross-plugin isolation", () => {
    it("does not synthesize a cross-plugin callTool surface", async () => {
      const pluginDir = join(installedDir, "calltool-plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin(ctx) {
  return { handlers: { "calltool_ping": async () => "pong" } };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify(servedPluginDocument({
          id: "calltool-plugin",
          name: "calltool-plugin",
          version: "1.0.0",
          entry: "entry.mjs",
          tools: [
            {
              name: "calltool_ping",
              description: "calltool_ping tool",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model", "app"] } },
            },
          ],
          description: "Test fixture.",
        })),
        "utf-8");
      await writeTestPluginRegistry({ registryPath }, [
        { id: "calltool-plugin", manifestPath, enabled: true },
      ]);

      let injectedHostApi: Record<string, unknown> | undefined;

      const guard = new PluginDeploymentGuard({
        registryPath,
        pluginsRoot: installedDir,
        requiredInstalls: async () => [],
      });
      const runtime = makeGenerationBoundRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        pluginsRoot: installedDir,
        createHostApi: (_pluginId, _manifest) => {
          const hostApi = {
            emitEvent: () => {},
            onEvent: () => () => {},
            saveMemory: async () => {},
            getSecret: () => null,
            callLlm: async () => {
              throw new Error("not available");
            },
            logEvent: () => {},
            onShutdown: () => {},
          };
          injectedHostApi = hostApi;
          return hostApi;
        },
      });
      await runtime.startAll();

      // Runtime tools may remain callable without a direct HostApi delegate.
      expect(runtime.listToolNames()).toContain("calltool_ping");
      expect(injectedHostApi).not.toHaveProperty("callTool");
    });

    it("PluginRuntime.call still returns Promise<T> for the plugin's own tool", async () => {
      const pluginDir = join(installedDir, "calltool-delegate");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin(ctx) {
  return { handlers: { "calltool_echo": async (payload) => ({ echoed: payload }) } };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify(servedPluginDocument({
          id: "calltool-delegate",
          name: "calltool-delegate",
          version: "1.0.0",
          entry: "entry.mjs",
          tools: [
            {
              name: "calltool_echo",
              description: "calltool_echo tool",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model", "app"] } },
            },
          ],
          description: "Test fixture.",
        })),
        "utf-8");
      await writeTestPluginRegistry({ registryPath }, [
        { id: "calltool-delegate", manifestPath, enabled: true },
      ]);

      const guard = new PluginDeploymentGuard({
        registryPath,
        pluginsRoot: installedDir,
        requiredInstalls: async () => [],
      });
      const runtime = makeGenerationBoundRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        pluginsRoot: installedDir,
        createHostApi: (_pluginId, _manifest) => ({
          emitEvent: () => {},
          onEvent: () => () => {},
          saveMemory: async () => {},
          getSecret: () => null,
          callLlm: async () => {
            throw new Error("not available");
          },
          logEvent: () => {},
          onShutdown: () => {},
        }),
      });
      await runtime.startAll();

      const result = await runtime.call("calltool_echo", { msg: "hello" });
      expect(result).toEqual({ echoed: { msg: "hello" } });

      const promise = runtime.call("calltool_echo", { msg: "world" });
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).resolves.toEqual({ echoed: { msg: "world" } });
    });
  });

  it("enforces narrow cross-plugin event access for orchestrator plugins", async () => {
    const writePlugin = async (
      id: string,
      methodName: string,
      extraManifest?: Record<string, unknown>,
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin() {
  return {
    handlers: { "${methodName}": async () => "${id}" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify(servedPluginDocument({
          id,
          name: id,
          version: "1.0.0",
          description: "Test fixture.",
          entry: "entry.mjs",
          tools: [
            {
              name: methodName,
              description: `${methodName} tool`,
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model", "app"] } },
            },
          ],
          ...extraManifest,
        })),
        "utf-8");
      return manifestPath;
    };

    const workManifestPath = await writePlugin(
      "sampleassistant",
      "sampleassistant_ping",
      {
        emittedEvents: ["sampleassistant.snapshot.requested"],
        pluginAccess: {
          plugins: [
            { pluginId: "email", events: ["email.action.needed"] },
            {
              pluginId: "meeting",
              events: ["meeting.summary.created", "meeting.ended"],
            },
            { pluginId: "samplemail", events: ["samplemail.snapshot.ready"] },
          ],
        },
      },
    );
    const calendarManifestPath = await writePlugin(
      "calendar",
      "calendar_today",
    );
    const emailManifestPath = await writePlugin("email", "email_ping");
    const meetingManifestPath = await writePlugin("meeting", "meeting_ping");
    const sampleMailManifestPath = await writePlugin("samplemail", "samplemail_ping", {
      emittedEvents: ["samplemail.snapshot.ready"],
      pluginAccess: {
        plugins: [
          {
            pluginId: "sampleassistant",
            events: ["sampleassistant.snapshot.requested"],
          },
        ],
      },
    });
    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "sampleassistant",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            { pluginId: "email", events: ["email.action.needed"] },
            {
              pluginId: "meeting",
              events: ["meeting.summary.created", "meeting.ended"],
            },
            { pluginId: "samplemail", events: ["samplemail.snapshot.ready"] },
          ],
        },
      },
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
      { id: "meeting", manifestPath: meetingManifestPath, enabled: true },
      {
        id: "samplemail",
        manifestPath: sampleMailManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            {
              pluginId: "sampleassistant",
              events: ["sampleassistant.snapshot.requested"],
            },
          ],
        },
      },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(() =>
      runtime.assertPluginEventAccess("sampleassistant", "email.action.needed"),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventAccess(
        "sampleassistant",
        "meeting.summary.created",
      ),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventAccess(
        "sampleassistant",
        "samplemail.snapshot.ready",
      ),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventAccess(
        "samplemail",
        "sampleassistant.snapshot.requested",
      ),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventAccess(
        "calendar",
        "sampleassistant.snapshot.requested",
      ),
    ).toThrow(/not allowed/i);
    expect(() =>
      runtime.assertPluginEventAccess("calendar", "email.action.needed"),
    ).toThrow(/not allowed/i);
    expect(() =>
      runtime.assertPluginEventAccess(
        "calendar",
        "sampleassistant.snapshot.requested",
        {
          plugins: [{
            pluginId: "sampleassistant",
            events: ["sampleassistant.snapshot.requested"],
          }],
        },
      ),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventAccess(
        "samplemail",
        "sampleassistant.snapshot.requested",
        null,
      ),
    ).toThrow(/not allowed/i);
  });

  it("allows sampleassistant to subscribe to granted calendar events (P4 detector grants)", async () => {
    // Cross-plugin calendar subscriptions require explicit per-event grants or startup subscriptions are refused.
    const writePlugin = async (
      id: string,
      methodName: string,
      extraManifest: Record<string, unknown> = {},
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      const entryPath = join(pluginDir, "entry.js");
      await writeFile(
        entryPath,
        `export default async function createPlugin(ctx) { return { handlers: { ${methodName}: async () => "ok" } }; }`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      const manifest: Record<string, unknown> = {
        id,
        name: id,
        version: "1.0.0",
        description: "Test fixture.",
        installPolicy: "user",
        entry: relative(pluginDir, entryPath),
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        ...extraManifest,
      };
      await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
      return manifestPath;
    };

    const grantedEvents = [
      "calendar.event.upcoming",
      "calendar.event.conflict.detected",
    ];
    const workManifestPath = await writePlugin(
      "sampleassistant",
      "sampleassistant_ping",
      {
        pluginAccess: {
          plugins: [
            {
              pluginId: "calendar",
              events: grantedEvents,
            },
          ],
        },
      },
    );
    const calendarManifestPath = await writePlugin(
      "calendar",
      "calendar_today",
    );
    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "sampleassistant",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            {
              pluginId: "calendar",
              events: grantedEvents,
            },
          ],
        },
      },
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    for (const ev of grantedEvents) {
      expect(() =>
        runtime.assertPluginEventAccess("sampleassistant", ev),
      ).not.toThrow();
    }
    // A grant for one calendar event must not authorize other events in the namespace.
    expect(() =>
      runtime.assertPluginEventAccess(
        "sampleassistant",
        "calendar.event.starting",
      ),
    ).toThrow(/not allowed/i);
  });

  it("allows load-time event subscriptions when manifest pluginAccess is declared", async () => {
    const calendarManifestPath = await writePluginWithEntry(
      "calendar",
      "calendar_today",
      `export default async function createPlugin({ hostApi }) {
  hostApi.onEvent("email.analyzed", () => {});
  return {
    handlers: { "calendar_today": async () => "calendar" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      {
        pluginAccess: {
          plugins: [{ pluginId: "email", events: ["email.analyzed"] }],
        },
      },
    );
    const emailManifestPath = await writePluginWithEntry(
      "email",
      "email_ping",
      `export default async function createPlugin() {
  return {
    handlers: { "email_ping": async () => "email" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );

    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "calendar",
        manifestPath: calendarManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [{ pluginId: "email", events: ["email.analyzed"] }],
        },
      },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    let runtime!: PluginRuntime;
    runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      deploymentGuard: new PluginDeploymentGuard({
        registryPath,
        pluginsRoot: installedDir,
        requiredInstalls: async () => [],
      }),
      createHostApi: (pluginId) =>
        ({
          emitEvent: () => {},
          onEvent: (type) => runtime.assertPluginEventAccess(pluginId, type),
          getSecret: () => null,
        }) as unknown as import("../types.js").PluginHostApi,
    });
    await expect(runtime.load()).resolves.toBeUndefined();
    expect(() =>
      runtime.assertPluginEventAccess("calendar", "email.analyzed"),
    ).not.toThrow();
  });

  // Child subscriptions are asynchronous requests; missing pluginAccess refuses the subscription without failing load.
  it("refuses load-time event subscriptions to later-loaded plugins without pluginAccess", async () => {
    const calendarManifestPath = await writePluginWithEntry(
      "calendar",
      "calendar_today",
      `export default async function createPlugin({ hostApi }) {
  hostApi.onEvent("email.analyzed", () => {});
  return {
    handlers: { "calendar_today": async () => "calendar" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );
    const emailManifestPath = await writePluginWithEntry(
      "email",
      "email_ping",
      `export default async function createPlugin() {
  return {
    handlers: { "email_ping": async () => "email" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );

    await writeTestPluginRegistry({ registryPath }, [
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    const refused: Array<{ pluginId: string; type: string; message: string }> = [];
    const subscribed: Array<{ pluginId: string; type: string }> = [];
    let runtime!: PluginRuntime;
    runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      deploymentGuard: new PluginDeploymentGuard({
        registryPath,
        pluginsRoot: installedDir,
        requiredInstalls: async () => [],
      }),
      createHostApi: (pluginId) =>
        ({
          emitEvent: () => {},
          onEvent: (type) => {
            try {
              runtime.assertPluginEventAccess(pluginId, type);
            } catch (error) {
              refused.push({ pluginId, type, message: (error as Error).message });
              throw error;
            }
            subscribed.push({ pluginId, type });
            return () => {};
          },
          getSecret: () => null,
        }) as unknown as import("../types.js").PluginHostApi,
    });
    await expect(runtime.load()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(refused).toHaveLength(1));
    expect(refused[0]).toMatchObject({ pluginId: "calendar", type: "email.analyzed" });
    expect(() => runtime.assertPluginEventAccess("calendar", "email.analyzed")).toThrow(refused[0]!.message);
    expect(subscribed).toEqual([]);
    expect(runtime.listPluginCards()).toContainEqual(
      expect.objectContaining({ id: "calendar", loadStatus: "loaded", arm: "child" }),
    );
  });

  it("blocks plugins from emitting events owned by another plugin", async () => {
    const calendarManifestPath = await writeFakePlugin("calendar");
    const emailManifestPath = await writeFakePlugin("email");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(() =>
      runtime.assertPluginEventEmitAccess("email", "email.analyzed"),
    ).not.toThrow();
    expect(() =>
      runtime.assertPluginEventEmitAccess("calendar", "email.analyzed"),
    ).toThrow(/not allowed to emit/i);
  });

  it("does not let a disabled provider satisfy an enabled consumer's capabilities", async () => {
    const providerDir = join(installedDir, "cap-provider");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: {
      "cap_provider_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );
    const providerManifestPath = join(providerDir, "plugin.json");
    await writeFile(
      providerManifestPath,
      JSON.stringify(servedPluginDocument({
        id: "cap-provider",
        name: "cap-provider",
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: "cap_provider_ping",
            description: "cap_provider_ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        capabilities: ["calendar-source"],
      })),
      "utf-8");

    const consumerDir = join(installedDir, "needs-calendar");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: {
      "needs_calendar_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );
    const consumerManifestPath = join(consumerDir, "plugin.json");
    await writeFile(
      consumerManifestPath,
      JSON.stringify(servedPluginDocument({
        id: "needs-calendar",
        name: "needs-calendar",
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: "needs_calendar_ping",
            description: "needs_calendar_ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        requires: { capabilities: ["calendar-source", "mail-source"] },
      })),
      "utf-8");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "cap-provider", manifestPath: providerManifestPath, enabled: false },
      {
        id: "needs-calendar",
        manifestPath: consumerManifestPath,
        enabled: true,
      },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).not.toContain("cap-provider");
    expect(runtime.listPluginIds()).not.toContain("needs-calendar");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/needs-calendar rejected .*calendar-source.*mail-source/),
    );
    errSpy.mockRestore();
  });
});

/** Trusted manifest discovery must include pluginsRoot outside hostRoot or installed plugins disappear on restart. */
describe("PluginRuntime registry trusted-path", () => {
  let testDir: string;
  let hostRoot: string;
  let pluginsRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "trusted-path-"));
    hostRoot = join(testDir, "host");
    pluginsRoot = join(testDir, "user-installs");
    registryPath = join(hostRoot, "plugins", "registry.json");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await removeStoppedTestRoot(testDir);
    vi.restoreAllMocks();
  });

  async function writeMinimalPlugin(
    rootDir: string,
    id: string,
  ): Promise<string> {
    const pluginDir = join(rootDir, id);
    await mkdir(pluginDir, { recursive: true });
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return { handlers: { ${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping: async () => "ok" } };
}
`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id,
        name: id,
        version: "1.0.0",
        description: "Test fixture.",
        entry: "entry.mjs",
        tools: [
          {
            name: `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`,
            description: "minimal ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
      })),
      "utf-8");
    return manifestPath;
  }

  it("loads a plugin under pluginsRoot when widening is configured", async () => {
    const manifestPath = await writeMinimalPlugin(pluginsRoot, "cloud-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "cloud-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeGenerationBoundRuntime({
      hostRoot,
      pluginsRoot,
      registryPath,
    });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("cloud-plugin");
  });

  it("drops a plugin under pluginsRoot when widening is NOT configured", async () => {
    const manifestPath = await writeMinimalPlugin(pluginsRoot, "cloud-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "cloud-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = makeGenerationBoundRuntime({ hostRoot, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("cloud-plugin");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /untrusted registry manifest path for cloud-plugin/,
      ),
    );
    warnSpy.mockRestore();
  });

  it("rejects a manifest path that is outside both trusted roots", async () => {
    // A similarly named sibling belongs to neither trusted root.
    const escapeDir = join(testDir, "user-installs-evil");
    const manifestPath = await writeMinimalPlugin(escapeDir, "evil");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "evil", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = makeGenerationBoundRuntime({
      hostRoot,
      pluginsRoot,
      registryPath,
    });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("evil");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/untrusted registry manifest path for evil/),
    );
    warnSpy.mockRestore();
  });
});

/** Adding or removing one plugin must not restart others; re-adding a loaded plugin refreshes only its bundle. */
describe("PluginRuntime addPlugin/removePlugin (US-A3)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-runtime-add-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await removeStoppedTestRoot(testDir);
    vi.restoreAllMocks();
  });

  async function writePlugin(id: string): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `let started = 0;
export default async function createPlugin(ctx) {
  return {
    handlers: { "${methodName}": async () => "hi-${id}-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: methodName,
          description: `${methodName} tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "Test fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    return manifestPath;
  }

  async function writeStartFailingPlugin(
    id: string,
  ): Promise<{ manifestPath: string; stoppedPath: string }> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const stoppedPath = join(pluginDir, "stopped.txt");
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { "${methodName}": async () => "never" },
    start: async () => { throw new Error("simulated start failure"); },
    stop: async () => { await writeFile(${JSON.stringify(stoppedPath)}, "stopped", "utf-8"); },
  };
}
`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: methodName,
          description: `${methodName} tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "Start failure fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    return { manifestPath, stoppedPath };
  }

  async function writeHostDisposerStartFailingPlugin(
    id: string,
  ): Promise<{ manifestPath: string; stoppedPath: string }> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const stoppedPath = join(pluginDir, "stopped.txt");
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { writeFile } from "node:fs/promises";
export default async function createPlugin({ hostApi }) {
  return {
    handlers: { "${methodName}": async () => "never" },
    start: async () => {
      hostApi.onEvent("test.event", () => {});
      throw new Error("simulated start failure");
    },
    stop: async () => { await writeFile(${JSON.stringify(stoppedPath)}, "stopped", "utf-8"); },
  };
}
`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: methodName,
          description: `${methodName} tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "Start failure fixture.",
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(manifest)), "utf-8");
    return { manifestPath, stoppedPath };
  }

  function makeRuntime(): PluginRuntime {
    return makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
  }

  function makeRuntimeWithPreparation(
    preparePluginStart: ConstructorParameters<
      typeof PluginRuntime
    >[0]["preparePluginStart"],
  ): PluginRuntime {
    return makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      preparePluginStart,
    });
  }

  async function waitUntil<T>(fn: () => Promise<T> | T): Promise<T> {
    let lastErr: unknown;
    const deadline = Date.now() + 2_000;
    do {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } while (Date.now() < deadline);
    throw lastErr;
  }

  function makeRuntimeWithTrackedHostDisposer(
    disposed: string[],
    disabled: string[],
  ): PluginRuntime {
    return makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => disabled.push(pluginId),
      createHostApi: (pluginId, _manifest, _pluginDataDir, incarnation) => ({
        emitEvent: () => {},
        // The incarnation and subscription ledger share one disposer; its effect must run only once.
        onEvent: () => {
          let done = false;
          const dispose = () => {
            if (done) return;
            done = true;
            disposed.push(pluginId);
          };
          incarnation.registerDisposer(dispose);
          return dispose;
        },
        getInstalledPluginIds: () => [],
        onPluginsChanged: () => () => {},
        getSecret: () => null,
        callTool: async () => {
          throw new Error("not available");
        },
        callLlm: async () => {
          throw new Error("not available");
        },
        logEvent: () => {},
        onShutdown: () => {},
      }),
    });
  }

  async function writeHostDisposerPlugin(id: string): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin({ hostApi }) {
  return {
    handlers: { "${methodName}": async () => "ok" },
    start: async () => { hostApi.onEvent("test.event", () => {}); },
    stop: async () => {},
  };
}\n`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id,
        name: id,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: methodName,
            description: "Test disposer tool.",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "Disposer incarnation fixture.",
      })),
      "utf-8");
    return manifestPath;
  }

  it("startAll stops a plugin instance whose start fails", async () => {
    const { manifestPath, stoppedPath } =
      await writeStartFailingPlugin("p-start-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-start-fails", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await runtime.startAll();

    expect(runtime.listPluginIds()).not.toContain("p-start-fails");
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
    // Keep routing evidence for the failed child so repair diagnostics can identify where it ran.
    expect(runtime.listPluginCards().find((card) => card.id === "p-start-fails")).toMatchObject({
      loadStatus: "failed",
      arm: "child",
      confinement: "unconfined",
    });
  });

  it("startAll start failure cleans runtime-managed disposers before unload", async () => {
    const { manifestPath, stoppedPath } =
      await writeHostDisposerStartFailingPlugin("p-start-disposer-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-start-disposer-fails", manifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const disposed: string[] = [];
    const disabled: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, disabled);

    await runtime.startAll();

    expect(runtime.listPluginIds()).not.toContain("p-start-disposer-fails");
    expect(disposed).toEqual(["p-start-disposer-fails"]);
    expect(disabled).toEqual(["p-start-disposer-fails"]);
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
  });

  it("revokes a timed-out boot incarnation before a slow peer settles", async () => {
    const timedId = "p-start-timeout-revoked";
    const slowId = "p-start-slow-peer";
    const timedDir = join(installedDir, timedId);
    const slowDir = join(installedDir, slowId);
    const slowPeer = await childProcessGate(testDir);
    await mkdir(timedDir, { recursive: true });
    await mkdir(slowDir, { recursive: true });
    await writeFile(
      join(timedDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { p_start_timeout_revoked_ping: async () => "never" }, start: async () => new Promise(() => {}) };
}\n`,
      "utf-8",
    );
    await writeFile(
      join(slowDir, "entry.mjs"),
      `${slowPeer.moduleSource}
export default async function createPlugin() {
  return { handlers: { p_start_slow_peer_ping: async () => "ok" }, start: async () => {
    gate.signal("slow-peer-entered");
    await gate.waitFor("release-slow-peer");
  } };
}\n`,
      "utf-8",
    );
    const manifestFor = (
      id: string,
      tool: string,
      startupTimeoutMs: number,
    ) => ({
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      startupTimeoutMs,
      tools: [
        {
          name: tool,
          description: `${tool} tool`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        },
      ],
      description: "Boot timeout revocation fixture.",
    });
    const timedManifestPath = join(timedDir, "plugin.json");
    const slowManifestPath = join(slowDir, "plugin.json");
    await writeFile(
      timedManifestPath,
      JSON.stringify(servedPluginDocument(manifestFor(timedId, "p_start_timeout_revoked_ping", 30))),
      "utf-8");
    await writeFile(
      slowManifestPath,
      JSON.stringify(servedPluginDocument(manifestFor(slowId, "p_start_slow_peer_ping", 5_000))),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: timedId, manifestPath: timedManifestPath, enabled: true },
          { id: slowId, manifestPath: slowManifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let timedHostApi: { getSecret(key: string): null } | undefined;
    let timedIncarnation: { isActive(): boolean; isLifecycleHookActive(): boolean } | undefined;
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      createHostApi: (pluginId, _manifest, _pluginDataDir, incarnation) => {
        const getSecret = (_key: string): null => {
          if (!incarnation.isActive())
            throw new Error("plugin instance is no longer active");
          return null;
        };
        const hostApi = {
          emitEvent: () => {},
          onEvent: () => () => {},
          getInstalledPluginIds: () => [],
          onPluginsChanged: () => () => {},
          getSecret,
          callTool: async () => undefined,
          callLlm: async () => undefined,
          logEvent: () => {},
          onShutdown: () => {},
        };
        if (pluginId === timedId) {
          timedHostApi = hostApi;
          timedIncarnation = incarnation;
        }
        return hostApi as unknown as import("../types.js").PluginHostApi;
      },
    });
    let settled = false;
    const starting = runtime.startAll().finally(() => {
      settled = true;
    });

    try {
      for (
        let attempt = 0;
        attempt < 100 && !timedIncarnation?.isLifecycleHookActive();
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(timedIncarnation?.isLifecycleHookActive()).toBe(true);
      expect(timedHostApi).toBeDefined();
      await slowPeer.waitFor("slow-peer-entered");
      // Wait for observed revocation rather than estimating child startup with a sleep.
      const revokeDeadline = Date.now() + 5_000;
      while (timedIncarnation!.isActive() && Date.now() < revokeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(settled).toBe(false);
      expect(() => timedHostApi!.getSecret("late-write")).toThrow(
        /no longer active/,
      );
    } finally {
      await slowPeer.signal("release-slow-peer");
      await starting;
    }
    expect(runtime.listPluginIds()).not.toContain(timedId);
    expect(runtime.listPluginIds()).toContain(slowId);
  });

  it("restart disposes only the previous HostApi incarnation", async () => {
    const pluginId = "p-incarnation-disposer";
    const manifestPath = await writeHostDisposerPlugin(pluginId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const disposed: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, []);

    await runtime.startAll();
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("started");
    await waitUntil(() => {
      expect(disposed).toEqual([pluginId]);
    });
    await expect(
      runtime.call(`${pluginId.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`),
    ).resolves.toBe("ok");

    await runtime.removePlugin(pluginId);
    expect(disposed).toEqual([pluginId, pluginId]);
  });

  it("reports bounded retirement failure after atomically removing runtime tracking", async () => {
    const pluginId = "p-remove-stop-timeout";
    const toolName = "p_remove_stop_timeout_ping";
    const manifestPath = await writePlugin(pluginId);
    await writeFile(
      join(installedDir, pluginId, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(toolName)}: async () => "active" },
    stop: async () => new Promise(() => {}),
  };
}`,
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call(toolName)).resolves.toBe("active");

    // Advance the host deadline only after the real child enters stop.
    const stopping = runtime as unknown as {
      stopPluginInstance(...args: unknown[]): Promise<boolean>;
    };
    const stop = stopping.stopPluginInstance.bind(stopping);
    let entered!: () => void;
    const inStop = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(stopping, "stopPluginInstance").mockImplementation((...args) => {
      const result = stop(...args);
      entered();
      return result;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const removal = expect(
        runtime.removePluginWithCommit(pluginId, async () => "durably-removed"),
      ).rejects.toThrow(/generation retirement failed/);
      await inStop;
      await vi.advanceTimersByTimeAsync(2_000);
      await removal;
    } finally {
      vi.useRealTimers();
    }

    expect(runtime.listPluginIds()).not.toContain(pluginId);
    await expect(runtime.call(toolName)).rejects.toThrow(/not found/);
    const state = runtime as unknown as {
      knownPluginManifests: Map<string, unknown>;
      failedPluginIds: Set<string>;
    };
    expect(state.knownPluginManifests.has(pluginId)).toBe(false);
    expect(state.failedPluginIds.has(pluginId)).toBe(false);
  }, 10_000);

  it("addPlugin stops a newly-instantiated plugin when start fails", async () => {
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const { manifestPath, stoppedPath } =
      await writeStartFailingPlugin("p-new-broken");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new-broken", manifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-new-broken")).rejects.toThrow(
      /addPlugin failed/,
    );
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
    expect(runtime.listPluginCards().find((card) => card.id === "p-new-broken")).toMatchObject({
      loadStatus: "failed",
      arm: "child",
      confinement: "unconfined",
    });
    expect(runtime.listPluginIds()).toEqual(["p-existing"]);
  });

  it("uses the manifest id as the canonical lifecycle identity for a registry alias", async () => {
    const canonicalId = "p-canonical-runtime";
    const alias = "catalog-install-alias";
    const manifestPath = await writePlugin(canonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: alias, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await expect(runtime.addPlugin(alias)).resolves.toBe("started");
    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    await expect(runtime.call("p_canonical_runtime_ping")).resolves.toContain(
      "hi-p-canonical-runtime",
    );
    await expect(runtime.waitForPluginReady(alias)).resolves.toBeUndefined();
  });

  it("canonical removal cancels a deferred add requested through a registry alias", async () => {
    const canonicalId = "p-canonical-pending";
    const alias = "catalog-pending-alias";
    const manifestPath = await writePlugin(canonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: alias, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    let release!: () => void;
    const preparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = makeRuntimeWithPreparation(() => preparation);

    await expect(runtime.addPlugin(alias)).resolves.toBe("preparing");
    const ready = runtime.waitForPluginReady(alias);
    await runtime.removePlugin(canonicalId);
    release();

    await expect(ready).rejects.toThrow(/cancelled/);
    expect(runtime.listPluginIds()).not.toContain(canonicalId);
    await expect(runtime.call("p_canonical_pending_ping")).rejects.toThrow(
      /not found/,
    );
    const state = runtime as unknown as {
      knownPluginManifests: Map<string, unknown>;
      knownPluginAccessGrants: Map<string, unknown>;
      knownToolOwners: Map<string, string>;
      knownEventOwners: Map<string, string>;
      disposers: Map<string, unknown>;
      preparation: {
        isPreparing(pluginId: string): boolean;
        hasPending(pluginId: string): boolean;
      };
    };
    expect(state.knownPluginManifests.has(canonicalId)).toBe(false);
    expect(state.knownPluginAccessGrants.has(canonicalId)).toBe(false);
    expect([...state.knownToolOwners.values()]).not.toContain(canonicalId);
    expect([...state.knownEventOwners.values()]).not.toContain(canonicalId);
    expect(state.disposers.has(canonicalId)).toBe(false);
    expect(state.preparation.isPreparing(canonicalId)).toBe(false);
    expect(state.preparation.hasPending(canonicalId)).toBe(false);
  });

  it("addPlugin restart path keeps the loaded plugin when replacement start fails", async () => {
    const existingPath = await writePlugin("p-restart-broken");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-restart-broken", manifestPath: existingPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const disposed: string[] = [];
    const disabled: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, disabled);
    await runtime.startAll();
    expect(await runtime.call("p_restart_broken_ping")).toBe(
      "hi-p-restart-broken-1",
    );

    const { stoppedPath } =
      await writeHostDisposerStartFailingPlugin("p-restart-broken");

    await expect(runtime.addPlugin("p-restart-broken")).rejects.toThrow(
      /addPlugin failed/,
    );

    expect(runtime.listPluginIds()).toEqual(["p-restart-broken"]);
    expect(await runtime.call("p_restart_broken_ping")).toBe(
      "hi-p-restart-broken-1",
    );
    // Clean failed replacement subscriptions without removing the active predecessor registration.
    expect(disposed).toEqual(["p-restart-broken"]);
    expect(disabled).toEqual([]);
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
  });

  it("boot-loaded plugin methods are not callable until startAll completes start()", async () => {
    const manifestPath = await writePlugin("p-start-guard");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-start-guard", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await runtime.load();

    await expect(runtime.call("p_start_guard_ping")).rejects.toThrow(
      /not found|not active|still starting/,
    );

    await runtime.startAll();

    await expect(runtime.call("p_start_guard_ping")).resolves.toBe(
      "hi-p-start-guard-1",
    );
  });

  it("setting plugin A config does not restart plugin B (single-plugin lifecycle)", async () => {
    const aPath = await writePlugin("p-a");
    const bPath = await writePlugin("p-b");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-a", manifestPath: aPath, enabled: true },
          { id: "p-b", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds().sort()).toEqual(["p-a", "p-b"]);
    const beforeA = await runtime.call("p_a_ping");
    const beforeB = await runtime.call("p_b_ping");

    await runtime.restartPlugin("p-a");

    const afterA = await runtime.call("p_a_ping");
    const afterB = await runtime.call("p_b_ping");
    // Cache-busting restart reevaluates the target module and resets its state; other plugins keep their modules.
    expect(beforeA).toBe("hi-p-a-1");
    expect(afterA).toBe("hi-p-a-1");
    expect(beforeB).toBe("hi-p-b-1");
    expect(afterB).toBe("hi-p-b-1");
  });

  it("addPlugin does not let a disabled provider satisfy a consumer capability", async () => {
    const providerPath = await writePlugin("p-calendar-provider");
    const providerManifest = JSON.parse(await readFile(providerPath, "utf-8"));
    patchAveFields(providerManifest, { capabilities: ["calendar-source"] });
    await writeFile(providerPath, JSON.stringify(providerManifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-calendar-provider", manifestPath: providerPath, enabled: false }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const consumerPath = await writePlugin("p-calendar-consumer");
    const consumerManifest = JSON.parse(await readFile(consumerPath, "utf-8"));
    patchAveFields(consumerManifest, {
      requires: { hostProtocol: "4", capabilities: ["calendar-source"] },
    });
    await writeFile(consumerPath, JSON.stringify(consumerManifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-calendar-provider", manifestPath: providerPath, enabled: false },
          { id: "p-calendar-consumer", manifestPath: consumerPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-calendar-consumer")).rejects.toThrow(
      /Missing capabilities: calendar-source/,
    );
    expect(runtime.listPluginIds()).not.toContain("p-calendar-provider");
    expect(runtime.listPluginIds()).not.toContain("p-calendar-consumer");
  });

  it("addPlugin loads a newly-registered plugin without restarting others", async () => {
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");

    const newPath = await writePlugin("p-new");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new", manifestPath: newPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await runtime.addPlugin("p-new");

    expect(runtime.listPluginIds().sort()).toEqual(["p-existing", "p-new"]);
    expect(await runtime.call("p_new_ping")).toBe("hi-p-new-1");
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
  });

  it("startAll defers dependency-prepared plugins and guards calls until ready", async () => {
    const manifestPath = await writePlugin("p-deferred");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-deferred", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-deferred" ? preparePromise : undefined,
    );

    await runtime.startAll();

    expect(runtime.listPluginIds()).toEqual([]);
    expect(
      runtime.listPluginManifests().map((entry) => entry.pluginId),
    ).toEqual(["p-deferred"]);
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-deferred")
        ?.loadStatus,
    ).toBe("preparing");
    await expect(runtime.call("p_deferred_ping")).rejects.toThrow(
      /still installing its runtime dependencies/,
    );

    resolvePrepare();

    await expect(
      runtime.waitForPluginReady("p-deferred"),
    ).resolves.toBeUndefined();
    expect(await runtime.call("p_deferred_ping")).toBe("hi-p-deferred-1");
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-deferred")
        ?.loadStatus,
    ).toBe("loaded");
  });

  it("surfaces dependency preparation progress on plugin cards", async () => {
    const manifestPath = await writePlugin("p-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(
      ({ pluginId, reportProgress }) => {
        if (pluginId !== "p-progress") return undefined;
        reportProgress?.({
          phase: "installing-deps",
          message: "의존성 설치 중 (최초 1회)...",
          progressPct: 40.4,
        });
        return preparePromise;
      },
    );

    await runtime.startAll();

    const preparingCard = runtime
      .listPluginCards()
      .find((card) => card.id === "p-progress");
    expect(preparingCard?.loadStatus).toBe("preparing");
    expect(preparingCard?.preparationStatus).toMatchObject({
      phase: "installing-deps",
      message: "의존성 설치 중 (최초 1회)...",
      progressPct: 40,
    });

    resolvePrepare();
    await expect(
      runtime.waitForPluginReady("p-progress"),
    ).resolves.toBeUndefined();
    const loadedCard = runtime
      .listPluginCards()
      .find((card) => card.id === "p-progress");
    expect(loadedCard?.loadStatus).toBe("loaded");
    expect(loadedCard?.preparationStatus).toBeUndefined();
  });

  it("ignores stale dependency preparation progress from cancelled generations", async () => {
    const manifestPath = await writePlugin("p-stale-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-stale-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const progressReporters: Array<
      NonNullable<
        Parameters<
          NonNullable<
            ConstructorParameters<typeof PluginRuntime>[0]["preparePluginStart"]
          >
        >[0]["reportProgress"]
      >
    > = [];
    const prepareResolves: Array<() => void> = [];
    const runtime = makeRuntimeWithPreparation(
      ({ pluginId, reportProgress }) => {
        if (pluginId !== "p-stale-progress") return undefined;
        if (reportProgress) progressReporters.push(reportProgress);
        return new Promise<void>((resolve) => {
          prepareResolves.push(resolve);
        });
      },
    );

    await expect(runtime.addPlugin("p-stale-progress")).resolves.toBe(
      "preparing",
    );
    progressReporters[0]?.({
      phase: "installing-deps",
      message: "첫 번째 준비 작업",
      progressPct: 20,
    });
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-stale-progress")
        ?.preparationStatus,
    ).toMatchObject({
      phase: "installing-deps",
      message: "첫 번째 준비 작업",
      progressPct: 20,
    });

    await runtime.removePlugin("p-stale-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-stale-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-stale-progress")).resolves.toBe(
      "preparing",
    );
    progressReporters[1]?.({
      phase: "verifying",
      message: "두 번째 준비 작업",
      progressPct: 70,
    });
    progressReporters[0]?.({
      phase: "error",
      message: "취소된 이전 작업의 늦은 이벤트",
      progressPct: 99,
    });

    expect(
      runtime.listPluginCards().find((card) => card.id === "p-stale-progress")
        ?.preparationStatus,
    ).toMatchObject({
      phase: "verifying",
      message: "두 번째 준비 작업",
      progressPct: 70,
    });

    prepareResolves[1]?.();
    await expect(
      runtime.waitForPluginReady("p-stale-progress"),
    ).resolves.toBeUndefined();
    prepareResolves[0]?.();
  });

  it("addPlugin returns while dependency preparation continues asynchronously", async () => {
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-new" ? preparePromise : undefined,
    );
    await runtime.startAll();
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");

    const newPath = await writePlugin("p-new");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new", manifestPath: newPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-new")).resolves.toBe("preparing");

    expect(runtime.listPluginIds()).toEqual(["p-existing"]);
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-new")?.loadStatus,
    ).toBe("preparing");
    await expect(runtime.call("p_new_ping")).rejects.toThrow(
      /still installing its runtime dependencies/,
    );

    resolvePrepare();

    await expect(runtime.waitForPluginReady("p-new")).resolves.toBeUndefined();
    expect(await runtime.call("p_new_ping")).toBe("hi-p-new-1");
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
  });

  it("addPlugin reuses an existing pending dependency preparation", async () => {
    const manifestPath = await writePlugin("p-dedup-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-dedup-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const preparePluginStart = vi.fn(({ pluginId }) =>
      pluginId === "p-dedup-prep" ? preparePromise : undefined,
    );
    const runtime = makeRuntimeWithPreparation(preparePluginStart);

    await expect(runtime.addPlugin("p-dedup-prep")).resolves.toBe("preparing");
    await expect(runtime.addPlugin("p-dedup-prep")).resolves.toBe("preparing");

    expect(preparePluginStart).toHaveBeenCalledOnce();
    resolvePrepare();
    await expect(
      runtime.waitForPluginReady("p-dedup-prep"),
    ).resolves.toBeUndefined();
    expect(await runtime.call("p_dedup_prep_ping")).toBe("hi-p-dedup-prep-1");
  });

  it("removePlugin cancels a pending dependency-prepared start", async () => {
    const manifestPath = await writePlugin("p-pending-remove");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-pending-remove", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-pending-remove" ? preparePromise : undefined,
    );

    await expect(runtime.addPlugin("p-pending-remove")).resolves.toBe(
      "preparing",
    );
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-pending-remove")
        ?.loadStatus,
    ).toBe("preparing");

    await runtime.removePlugin("p-pending-remove");
    resolvePrepare();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.listPluginIds()).toEqual([]);
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-pending-remove"),
    ).toBeUndefined();
    await expect(runtime.call("p_pending_remove_ping")).rejects.toThrow(
      /Plugin method not found/,
    );
  });

  it("removePlugin cancellation does not invalidate another plugin preparation", async () => {
    const removedPath = await writePlugin("p-remove-one");
    const keptPath = await writePlugin("p-keep-one");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-remove-one", manifestPath: removedPath, enabled: true },
          { id: "p-keep-one", manifestPath: keptPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let resolveRemoved!: () => void;
    let resolveKept!: () => void;
    const removedPreparePromise = new Promise<void>((resolve) => {
      resolveRemoved = resolve;
    });
    const keptPreparePromise = new Promise<void>((resolve) => {
      resolveKept = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (pluginId === "p-remove-one") return removedPreparePromise;
      if (pluginId === "p-keep-one") return keptPreparePromise;
      return undefined;
    });

    await expect(runtime.addPlugin("p-remove-one")).resolves.toBe("preparing");
    await expect(runtime.addPlugin("p-keep-one")).resolves.toBe("preparing");

    await runtime.removePlugin("p-remove-one");
    resolveRemoved();
    resolveKept();

    await expect(
      runtime.waitForPluginReady("p-keep-one"),
    ).resolves.toBeUndefined();
    expect(await runtime.call("p_keep_one_ping")).toBe("hi-p-keep-one-1");
    expect(runtime.listPluginIds()).toEqual(["p-keep-one"]);
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-remove-one"),
    ).toBeUndefined();
    await expect(runtime.call("p_remove_one_ping")).rejects.toThrow(
      /Plugin method not found/,
    );
  });

  it("stale prepared start failure does not mark a newer generation failed", async () => {
    const pluginId = "p-stale-start";
    const methodName = "p_stale_start_ping";
    const staleDir = join(installedDir, `${pluginId}-stale`);
    await mkdir(staleDir, { recursive: true });
    const staleManifestPath = join(staleDir, "plugin.json");

    // Child heaps are separate; steer stale startup through files in the fixture root.
    const gate = await childProcessGate(join(testDir, "stale-start-gate"));
    await writeFile(
      join(staleDir, "entry.mjs"),
      `${gate.moduleSource}
export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(methodName)}: async () => "stale" },
    start: async () => {
      gate.signal("start-entered");
      if (await gate.waitFor("start-outcome") === "reject") throw new Error("stale start failed");
    },
    stop: async () => { gate.signal("stale-stopped"); },
  };
}
`,
      "utf-8",
    );
    await writeFile(
      staleManifestPath,
      JSON.stringify(servedPluginDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "stale start fixture",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: pluginId, manifestPath: staleManifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    let firstPrepare = true;
    const runtime = makeRuntimeWithPreparation(
      ({ pluginId: requestedId }) => {
        if (requestedId !== pluginId || !firstPrepare) return undefined;
        firstPrepare = false;
        return preparePromise;
      },
    );

    await expect(runtime.addPlugin(pluginId)).resolves.toBe("preparing");
    resolvePrepare();
    await gate.waitFor("start-entered");

    await runtime.removePlugin(pluginId);

    const freshDir = join(installedDir, `${pluginId}-fresh`);
    await mkdir(freshDir, { recursive: true });
    const freshManifestPath = join(freshDir, "plugin.json");
    await writeFile(
      join(freshDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(methodName)}: async () => "fresh" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    await writeFile(
      freshManifestPath,
      JSON.stringify(servedPluginDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.1",
        entry: "entry.mjs",
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "fresh start fixture",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: pluginId, manifestPath: freshManifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(pluginId)).resolves.toBe("started");
    await expect(runtime.call(methodName)).resolves.toBe("fresh");

    await gate.signal("start-outcome", "reject");
    await gate.waitFor("stale-stopped");

    const failedPluginIds = (
      runtime as unknown as { failedPluginIds: Set<string> }
    ).failedPluginIds;
    expect(failedPluginIds.has(pluginId)).toBe(false);
    await expect(runtime.call(methodName)).resolves.toBe("fresh");
  });

  it("restartPlugin keeps the existing plugin loaded when dependency preparation fails", async () => {
    const manifestPath = await writePlugin("p-restart-prepare-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-restart-prepare-fails", manifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let failRestartPreparation = false;
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (!failRestartPreparation || pluginId !== "p-restart-prepare-fails")
        return undefined;
      return Promise.reject(new Error("prepare failed"));
    });
    await runtime.startAll();
    expect(await runtime.call("p_restart_prepare_fails_ping")).toBe(
      "hi-p-restart-prepare-fails-1",
    );

    failRestartPreparation = true;
    await expect(
      runtime.restartPlugin("p-restart-prepare-fails"),
    ).resolves.toBe("failed");

    expect(runtime.listPluginIds()).toEqual(["p-restart-prepare-fails"]);
    expect(await runtime.call("p_restart_prepare_fails_ping")).toBe(
      "hi-p-restart-prepare-fails-1",
    );
  });

  it("restartPlugin applies a preparation config overlay before creating the replacement", async () => {
    const pluginId = "p-restart-config-overlay";
    const pluginDir = join(installedDir, pluginId);
    const methodName = "p_restart_config_overlay_ping";
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(context) {
  return {
    handlers: {
      "${methodName}": async () => context.config.pythonExecutable ?? "missing",
    },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "Restart configuration fixture.",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let prepareRestart = false;
    const runtime = makeRuntimeWithPreparation(({ pluginId: preparingId }) => {
      if (!prepareRestart || preparingId !== pluginId) return undefined;
      return Promise.resolve({
        configOverride: { pythonExecutable: "/managed/python" },
      });
    });
    await runtime.startAll();
    await expect(runtime.call(methodName)).resolves.toBe("missing");

    prepareRestart = true;
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("started");

    await expect(runtime.call(methodName)).resolves.toBe("/managed/python");
    expect(runtime.getConfigOverride(pluginId)).toEqual({
      pythonExecutable: "/managed/python",
    });
  });

  it("removePlugin does not wait for an invalidated restart preparation", async () => {
    const pluginId = "p-remove-during-restart-prep";
    const manifestPath = await writePlugin(pluginId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    let prepareRestart = false;
    let entered!: () => void;
    let release!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preparationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = makeRuntimeWithPreparation(() => {
      if (!prepareRestart) return undefined;
      entered();
      return preparationGate;
    });
    await runtime.startAll();
    prepareRestart = true;

    const restart = runtime.restartPlugin(pluginId);
    await preparationEntered;
    await expect(runtime.removePlugin(pluginId)).resolves.toBeUndefined();
    expect(runtime.listPluginIds()).not.toContain(pluginId);

    release();
    await expect(restart).resolves.toBe("failed");
  });

  it("addPlugin restart path prepares dependencies before stopping the loaded plugin", async () => {
    const manifestPath = await writePlugin("p-restart-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let prepareRestart = false;
    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      prepareRestart && pluginId === "p-restart-prep"
        ? preparePromise
        : undefined,
    );
    await runtime.startAll();
    expect(await runtime.call("p_restart_prep_ping")).toBe(
      "hi-p-restart-prep-1",
    );

    prepareRestart = true;
    let restartCompleted = false;
    const restartPromise = runtime
      .addPlugin("p-restart-prep")
      .then((result) => {
        restartCompleted = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.listPluginIds()).toEqual(["p-restart-prep"]);
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-restart-prep")
        ?.loadStatus,
    ).toBe("loaded");
    expect(await runtime.call("p_restart_prep_ping")).toBe(
      "hi-p-restart-prep-1",
    );
    expect(restartCompleted).toBe(false);

    resolvePrepare();

    await expect(restartPromise).resolves.toBe("started");
    await expect(
      waitUntil(() => runtime.call("p_restart_prep_ping")),
    ).resolves.toBe("hi-p-restart-prep-1");
  });

  it("addPlugin restart path preserves the loaded plugin when dependency preparation fails", async () => {
    const manifestPath = await writePlugin("p-restart-add-prepare-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-restart-add-prepare-fails", manifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let failRestartPreparation = false;
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (!failRestartPreparation || pluginId !== "p-restart-add-prepare-fails")
        return undefined;
      return Promise.reject(new Error("prepare failed"));
    });
    await runtime.startAll();
    expect(await runtime.call("p_restart_add_prepare_fails_ping")).toBe(
      "hi-p-restart-add-prepare-fails-1",
    );

    failRestartPreparation = true;
    await expect(
      runtime.addPlugin("p-restart-add-prepare-fails"),
    ).rejects.toThrow(/addPlugin failed/);

    expect(runtime.listPluginIds()).toEqual(["p-restart-add-prepare-fails"]);
    expect(await runtime.call("p_restart_add_prepare_fails_ping")).toBe(
      "hi-p-restart-add-prepare-fails-1",
    );
  });

  it("restartPlugin coalesces concurrent dependency preparation for a loaded plugin", async () => {
    const manifestPath = await writePlugin("p-restart-dedup-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-dedup-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let prepareRestart = false;
    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const preparePluginStart = vi.fn(({ pluginId }) =>
      prepareRestart && pluginId === "p-restart-dedup-prep"
        ? preparePromise
        : undefined,
    );
    const runtime = makeRuntimeWithPreparation(preparePluginStart);
    await runtime.startAll();
    preparePluginStart.mockClear();

    prepareRestart = true;
    const first = runtime.restartPlugin("p-restart-dedup-prep");
    const second = runtime.restartPlugin("p-restart-dedup-prep");
    await waitUntil(() => {
      const calls = preparePluginStart.mock.calls.length;
      if (calls !== 1) throw new Error(`prepare calls: ${calls}`);
      return calls;
    });

    expect(preparePluginStart).toHaveBeenCalledTimes(1);
    expect(runtime.listPluginIds()).toEqual(["p-restart-dedup-prep"]);
    expect(await runtime.call("p_restart_dedup_prep_ping")).toBe(
      "hi-p-restart-dedup-prep-1",
    );

    resolvePrepare();

    await expect(first).resolves.toBe("started");
    await expect(second).resolves.toBe("started");
  });

  it("addPlugin on an already-loaded plugin acts as restartPlugin (reinstall path)", async () => {
    // Reinstalling a loaded plugin must refresh its bundle through restartPlugin.
    const aPath = await writePlugin("p-existing");
    const bPath = await writePlugin("p-other");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: aPath, enabled: true },
          { id: "p-other", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
    expect(await runtime.call("p_other_ping")).toBe("hi-p-other-1");

    await runtime.addPlugin("p-existing");

    // Restart reevaluates the target module; bystander state must survive.
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
    expect(await runtime.call("p_other_ping")).toBe("hi-p-other-1");
  });

  it("removePlugin drops a single plugin without restarting others", async () => {
    const aPath = await writePlugin("p-target");
    const bPath = await writePlugin("p-bystander");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-target", manifestPath: aPath, enabled: true },
          { id: "p-bystander", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_target_ping")).toBe("hi-p-target-1");
    expect(await runtime.call("p_bystander_ping")).toBe("hi-p-bystander-1");

    await runtime.removePlugin("p-target");

    expect(runtime.listPluginIds()).toEqual(["p-bystander"]);
    expect(runtime.listToolNames()).not.toContain("p_target_ping");
    expect(await runtime.call("p_bystander_ping")).toBe("hi-p-bystander-1");
  });

  it("removePlugin on an unloaded plugin is a no-op (idempotent)", async () => {
    const runtime = makeRuntime();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runtime.removePlugin("nonexistent");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("removePlugin: plugin not loaded — nonexistent"),
    );
    warnSpy.mockRestore();
  });

  it("addPlugin throws when registry has no entry for the id", async () => {
    const runtime = makeRuntime();
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    await expect(runtime.addPlugin("ghost")).rejects.toThrow(
      /not found in registry/,
    );
  });

  it("addPlugin surfaces the manifest read error when registry entry exists but manifest is invalid (update-banner regression)", async () => {
    // A schema-invalid installed manifest must surface its validation error so the install handler can recover.
    const pluginDir = join(installedDir, "p-broken");
    await mkdir(pluginDir, { recursive: true });
    const badManifest = {
      id: "p-broken",
      name: "Broken",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: ["bad.tool"],
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedPluginDocument(badManifest)), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-broken", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await expect(runtime.addPlugin("p-broken")).rejects.toThrow(
      /schema validation failed|Invalid tool name/,
    );
  });

  it("addPlugin throws when the entry module fails to import (atomic-install rollback signal)", async () => {
    // Import failures must propagate from addPlugin so the install handler can roll back durable state.
    const pluginDir = join(installedDir, "p-broken-entry");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `throw new Error("simulated dynamic-require fallback shim throw");
export default async function createPlugin() { return {}; }`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "p-broken-entry",
        name: "Broken Entry",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: "broken_entry_hello",
            description: "broken_entry_hello tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "test fixture for addPlugin import-fail rollback signal",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-broken-entry", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await expect(runtime.addPlugin("p-broken-entry")).rejects.toThrow(
      /addPlugin failed/,
    );
  });

  it("addPlugin on a running plugin re-reads manifest from disk (update entry-point regression)", async () => {
    // Restart must reread the on-disk manifest to pick up a changed entry path.
    const pluginDir = join(installedDir, "p-update");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry-v1.mjs"),
      `
let started = 0;
export default async function createPlugin() {
  return {
    handlers: { p_update_ping: async () => "v1-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "p-update",
        name: "Update",
        version: "1.0.0",
        description: "regression fixture",
        entry: "entry-v1.mjs",
        tools: [
          {
            name: "p_update_ping",
            description: "p_update_ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        configSchema: {
          properties: {
            endpoint: { type: "string", title: "endpoint" },
          },
        },
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-update", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_update_ping")).toBe("v1-1");
    expect(
      runtime.listPluginCards().find((card) => card.id === "p-update")
        ?.configSchema?.properties,
    ).toHaveProperty("endpoint");

    await writeFile(
      join(pluginDir, "entry-v2.mjs"),
      `
let started = 0;
export default async function createPlugin() {
  return {
    handlers: { p_update_ping: async () => "v2-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedPluginDocument({
        id: "p-update",
        name: "Update",
        version: "2.0.0",
        description: "regression fixture v2",
        entry: "entry-v2.mjs",
        tools: [
          {
            name: "p_update_ping",
            description: "p_update_ping tool",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        configSchema: {
          properties: {
            baseUrl: { type: "string", title: "baseUrl" },
          },
        },
      })),
      "utf-8");

    await runtime.addPlugin("p-update");

    // Verify restart through module-state reset; a reused entry URL can still cache the handler body.
    expect(runtime.listPluginIds()).toContain("p-update");
    const card = runtime
      .listPluginCards()
      .find((candidate) => candidate.id === "p-update");
    expect(card?.version).toBe("2.0.0");
    expect(card?.configSchema?.properties).toHaveProperty("baseUrl");
    expect(card?.configSchema?.properties).not.toHaveProperty("endpoint");
  });

  it("addPlugin on a running plugin follows updated registry manifestPath and refreshes plugin cards", async () => {
    const pluginId = "p-update-schema";
    const toolName = "p_update_schema_ping";

    async function writeVersion(
      version: string,
      fieldName: string,
    ): Promise<string> {
      const pluginDir = join(installedDir, pluginId, version);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin() {
  return {
    handlers: { "${toolName}": async () => "${version}" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify(servedPluginDocument({
          id: pluginId,
          name: "Update Schema",
          version,
          description: `schema fixture ${version}`,
          entry: "entry.mjs",
          tools: [
            {
              name: toolName,
              description: `${toolName} tool`,
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model", "app"] } },
            },
          ],
          configSchema: {
            properties: {
              [fieldName]: { type: "string", title: fieldName },
            },
          },
        })),
        "utf-8");
      return manifestPath;
    }

    const v1ManifestPath = await writeVersion("1.0.0", "endpoint");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: pluginId, manifestPath: v1ManifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(
      runtime.listPluginCards().find((card) => card.id === pluginId)?.version,
    ).toBe("1.0.0");

    const v2ManifestPath = await writeVersion("2.0.0", "baseUrl");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: pluginId, manifestPath: v2ManifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await runtime.addPlugin(pluginId);

    const card = runtime
      .listPluginCards()
      .find((candidate) => candidate.id === pluginId);
    expect(runtime.getPluginRoot(pluginId)).toBe(
      join(installedDir, pluginId, "2.0.0"),
    );
    expect(card?.version).toBe("2.0.0");
    expect(card?.configSchema?.properties).toHaveProperty("baseUrl");
    expect(card?.configSchema?.properties).not.toHaveProperty("endpoint");
  });
});

describe("PluginRuntime lifecycle log emission", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-lifecycle-log-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await removeStoppedTestRoot(testDir);
    vi.restoreAllMocks();
  });

  async function writeLifecycleLogPlugin(id: string, entrySource?: string): Promise<string> {
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    const { manifestPath } = await writeTestPlugin(
      {
        rootDir: testDir,
        pluginsRoot: installedDir,
        registryPath,
      },
      {
        id,
        tools: [
          {
            name: methodName,
            description: `${methodName} tool`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        entrySource: entrySource ?? makeTestPluginEntrySource({
          [methodName]: JSON.stringify("hi"),
        }),
      },
    );
    return manifestPath;
  }

  it("emits LOAD_START phase for each plugin entry during load()", async () => {
    const manifestPath = await writeLifecycleLogPlugin("lifecycle-log-test");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "lifecycle-log-test", manifestPath, enabled: true },
    ]);
    // The test logger passes structured context as console.log argument 2.
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      calls.push(args);
    });
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.load();
    const hasLoadStart = calls.some((args) => {
      const flat = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      return (
        flat.includes(PluginPhase.LOAD_START) || flat.includes("loading plugin")
      );
    });
    expect(hasLoadStart).toBe(true);
    spy.mockRestore();
  });

  it("emits LOAD_OK phase after a plugin successfully loads", async () => {
    const manifestPath = await writeLifecycleLogPlugin("lifecycle-log-ok");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "lifecycle-log-ok", manifestPath, enabled: true },
    ]);
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      calls.push(args);
    });
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.load();
    const hasLoadOk = calls.some((args) => {
      const flat = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      return (
        flat.includes(PluginPhase.LOAD_OK) || flat.includes("plugin loaded")
      );
    });
    expect(hasLoadOk).toBe(true);
    spy.mockRestore();
  });

  it("emits RESTART_REQUEST phase when restartPlugin is called", async () => {
    const manifestPath = await writeLifecycleLogPlugin("lifecycle-log-restart");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "lifecycle-log-restart", manifestPath, enabled: true },
    ]);
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.load();
    const calls: unknown[][] = [];
    const spyLog = vi.spyOn(console, "log").mockImplementation((...args) => {
      calls.push(args);
    });
    await runtime.restartPlugin("lifecycle-log-restart");
    const hasRestartRequest = calls.some((args) => {
      const flat = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      return (
        flat.includes(PluginPhase.RESTART_REQUEST) ||
        flat.includes("restart requested")
      );
    });
    expect(hasRestartRequest).toBe(true);
    spyLog.mockRestore();
  });

  it("reports a successful stop during normal plugin retirement", async () => {
    const pluginId = "lifecycle-log-stop";
    const manifestPath = await writeLifecycleLogPlugin(pluginId);
    await writeTestPluginRegistry({ registryPath }, [
      { id: pluginId, manifestPath, enabled: true },
    ]);
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();
    await runtime.waitForPluginReady(pluginId);

    const spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runtime.setPluginEnabled(pluginId, false);
      expect(runtime.isPluginEnabled(pluginId)).toBe(false);
      expect(runtime.listPluginIds()).not.toContain(pluginId);
      expect(spyLog).toHaveBeenCalledWith(
        "[plugin-lifecycle] plugin stopped",
        { pluginId, phase: PluginPhase.STOP_OK },
      );
    } finally {
      spyLog.mockRestore();
      await runtime.stopAll();
    }
  });

  it("reports a stop failure during normal plugin retirement", async () => {
    const pluginId = "lifecycle-log-stop-fail";
    const manifestPath = await writeLifecycleLogPlugin(pluginId, `export default function createPlugin() {
  return {
    handlers: { lifecycle_log_stop_fail_hello: async () => "hi" },
    stop() { throw new Error("stop rejected"); }
  };
}
`);
    await writeTestPluginRegistry({ registryPath }, [
      { id: pluginId, manifestPath, enabled: true },
    ]);
    const runtime = makeGenerationBoundRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();
    await runtime.waitForPluginReady(pluginId);

    const spyError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runtime.setPluginEnabled(pluginId, false)).rejects.toThrow(/retirement failed/);
      expect(runtime.isPluginEnabled(pluginId)).toBe(false);
      expect(spyError).toHaveBeenCalledWith(
        "[plugin-lifecycle] plugin stop failed",
        expect.objectContaining({ pluginId, phase: PluginPhase.STOP_FAIL, err: expect.any(Error) }),
      );
    } finally {
      spyError.mockRestore();
      await runtime.stopAll();
    }
  });
});

/** Each failed attempt owns its routing evidence; overlapping attempts must not overwrite one another. */
describe("PluginRuntime attempt diagnostics belong to their attempt", () => {
  const WORKING = 'export default async () => ({ handlers: {}, start: async () => {}, stop: async () => {} });\n';
  const BROKEN_START = 'export default async () => ({ handlers: {}, start: async () => { throw new Error("child startup refused"); }, stop: async () => {} });\n';
  const ID = "attemptowned";
  const fixtures: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of fixtures.splice(0)) await dispose();
  });

  async function setup(entrySource = WORKING) {
    const fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-attempt-owned-" });
    const written = await writeTestPlugin(fixture, { id: ID, entrySource });
    await writeTestPluginRegistry(fixture, [{ id: ID, manifestPath: written.manifestPath }]);
    const runtime = makeTestPluginRuntime(fixture);
    testRuntimes.delete(runtime);
    const internals = runtime as unknown as {
      ensureDataDir(...args: unknown[]): string;
      buildHostApiIncarnation(...args: unknown[]): unknown;
      runPluginLifecycleHook(scope: unknown, hook: () => unknown): Promise<unknown>;
    };
    fixtures.push(async () => {
      await runtime.stopAll();
      await makeTestTreeWritable(fixture.rootDir);
      await rm(fixture.rootDir, { recursive: true, force: true });
    });
    const requires = async (next: Record<string, unknown>) => {
      const document = JSON.parse(await readFile(written.manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(written.manifestPath, JSON.stringify(patchAveFields(document, { requires: next })), "utf8");
    };
    const card = () => runtime.listPluginCards().find((entry) => entry.id === ID);
    return { runtime, internals, requires, card };
  }

  function parkAfterConstruct(internals: Awaited<ReturnType<typeof setup>>["internals"], count: number) {
    const releases: Array<() => void> = [];
    const entries = Array.from({ length: count }, () => deferred<void>());
    let entered = 0;
    const original = internals.runPluginLifecycleHook.bind(internals);
    internals.runPluginLifecycleHook = async (scope, hook) => {
      const result = await original(scope, hook);
      if (result && typeof result === "object" && "handlers" in result && entered < count) {
        entered += 1;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          entries[entered - 1]!.resolve();
        });
      }
      return result;
    };
    return {
      entered: async (n: number) => {
        await raceWithTimeout(entries[n - 1]!.promise, 10_000,
          () => new Error(`Plugin construction ${n} did not enter within 10000 ms`));
        expect(entered).toBe(n);
      },
      release: (index: number) => releases[index]?.(),
      releaseAll: () => { for (const release of releases) release(); },
    };
  }

  const settle = <T,>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));

  it.each([
    ["the plugin data directory", "ensureDataDir", "EACCES: permission denied creating plugin data"],
    ["the HostApi incarnation", "buildHostApiIncarnation", "HostApi construction failed before invocation"],
  ] as const)("leaves a failed child/not-spawned card when add throws building %s", async (_what, seam, message) => {
    const { runtime, internals, card } = await setup();
    internals[seam] = () => { throw new Error(message); };
    await expect(runtime.addPlugin(ID)).rejects.toThrow(message);
    expect(card()).toMatchObject({
      loadStatus: "failed",
      installFailureKind: "load-crash",
      arm: "child",
      confinement: "not-spawned",
    });
    expect(card()?.installFailureMessage).toContain(message);
    expect(runtime.listPluginIds()).not.toContain(ID);
  });

  it("drops an earlier child failure's arm when a later add is refused before routing", async () => {
    const { runtime, requires, card } = await setup(BROKEN_START);
    await expect(runtime.addPlugin(ID)).rejects.toThrow();
    expect(card()).toMatchObject({ loadStatus: "failed", arm: "child", confinement: "unconfined" });
    await requires({ hostProtocol: "4", capabilities: ["attempt-owned-missing-capability"] });
    await expect(runtime.addPlugin(ID)).rejects.toThrow(/Missing capabilities|missing required capabilities/);
    expect(card()?.loadStatus).toBe("failed");
    expect(card()?.arm).toBeUndefined();
    expect(card()?.confinement).toBeUndefined();
  });

  it("does not lend a parked child attempt's diagnostics to an overlapping add refused before routing", async () => {
    const { runtime, internals, requires, card } = await setup();
    const parked = parkAfterConstruct(internals, 1);
    const first = settle(runtime.addPlugin(ID));
    try {
      await parked.entered(1);
      await requires({ hostProtocol: "2" });
      await expect(runtime.addPlugin(ID)).rejects.toThrow();
      expect(card()?.installFailureKind).toBe("incompatible-host-protocol");
      expect(card()?.arm).toBeUndefined();
      expect(card()?.confinement).toBeUndefined();
    } finally {
      parked.releaseAll();
      await first;
    }
  });

  it("keeps a newer add's diagnostics when an older overlapping add ends first", async () => {
    const { runtime, internals, card } = await setup(BROKEN_START);
    const parked = parkAfterConstruct(internals, 2);
    const first = settle(runtime.addPlugin(ID));
    let second: Promise<unknown> | undefined;
    try {
      await parked.entered(1);
      second = settle(runtime.addPlugin(ID));
      await parked.entered(2);
      parked.release(0);
      await first;
      parked.release(1);
      await second;
      expect(card()).toMatchObject({ loadStatus: "failed", arm: "child", confinement: "unconfined" });
    } finally {
      parked.releaseAll();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it("reports a boot attempt's own diagnostics, not those of an add in flight beside it", async () => {
    const { runtime, internals, card } = await setup(BROKEN_START);
    // Hold boot before factory invocation; the overlapping add spawns a child, then fails start.
    let releaseBoot!: () => void;
    const bootHeld = new Promise<void>((resolve) => { releaseBoot = resolve; });
    let releaseAdd!: () => void;
    const addHeld = new Promise<void>((resolve) => { releaseAdd = resolve; });
    const bootEntered = deferred<void>();
    const addEntered = deferred<void>();
    let hooks = 0;
    let addConstructed = false;
    const original = internals.runPluginLifecycleHook.bind(internals);
    internals.runPluginLifecycleHook = async (scope, hook) => {
      hooks += 1;
      const call = hooks;
      if (call === 1) {
        bootEntered.resolve();
        await bootHeld;
        throw new Error("boot construct failed before invoking the factory");
      }
      const result = await original(scope, hook);
      if (call === 2) {
        addConstructed = true;
        addEntered.resolve();
        await addHeld;
      }
      return result;
    };
    const boot = settle(runtime.load());
    let add: Promise<unknown> | undefined;
    try {
      await raceWithTimeout(bootEntered.promise, 10_000,
        () => new Error("Plugin boot did not enter within 10000 ms"));
      expect(hooks).toBe(1);
      add = settle(runtime.addPlugin(ID));
      await raceWithTimeout(addEntered.promise, 10_000,
        () => new Error("Plugin add did not construct within 10000 ms"));
      expect(addConstructed).toBe(true);
      releaseBoot();
      await boot;
      expect(card()).toMatchObject({ loadStatus: "failed", arm: "child", confinement: "not-spawned" });
      releaseAdd();
      expect(await add).toHaveProperty("error");
      expect(card()).toMatchObject({ loadStatus: "failed", arm: "child", confinement: "unconfined" });
    } finally {
      releaseBoot();
      releaseAdd();
      await Promise.allSettled([boot, ...(add ? [add] : [])]);
    }
  });

  it("does not show a removed attempt's diagnostics on a reinstall refused before routing", async () => {
    const { runtime, internals, requires, card } = await setup();
    const parked = parkAfterConstruct(internals, 1);
    const add = settle(runtime.addPlugin(ID));
    try {
      await parked.entered(1);
      await runtime.removePlugin(ID);
      expect(card()).toBeUndefined();
      await requires({ hostProtocol: "2" });
      await expect(runtime.addPlugin(ID)).rejects.toThrow();
      expect(card()?.installFailureKind).toBe("incompatible-host-protocol");
      expect(card()?.arm).toBeUndefined();
      expect(card()?.confinement).toBeUndefined();
    } finally {
      parked.releaseAll();
      await add;
    }
  });
});

// Before registration, an attempt owns its root, incarnation and child and must release each exactly once.
// Cleanup failures are audited without replacing the original error.
describe("PluginRuntime load attempts release what they own exactly once", () => {
  const ID = "attemptresources";
  const PING = "attemptresources_ping";
  const WORKING = `export default async () => ({ handlers: { ${PING}: async () => "pong" }, start: async () => {}, stop: async () => {} });\n`;
  type Mode =
    | "success" | "factory-crash" | "start-crash" | "directory-crash" | "hostapi-crash" | "duplicate"
    | "mapping-crash" | "cancel" | "cancel-mapping-crash" | "publication-crash" | "cleanup-error" | "incumbent-crash"
    | "post-registration-crash" | "cleanup-audit-crash" | "crash-audit-crash" | "hanging-tool";
  type Constructed = { instance: { handlers: Record<string, (...args: unknown[]) => Promise<unknown>>; stop?: () => Promise<void> }; stops: number; ping: (...args: unknown[]) => Promise<unknown> };
  type Internals = {
    materializeImmutableRuntimeRoot(...args: unknown[]): Promise<string>;
    removeUnpublishedRuntimeRoot(pluginId: string, root: string): Promise<void>;
    buildHostApiIncarnation(...args: unknown[]): { deactivate: () => void; drainOperations: () => Promise<void> };
    ensureDataDir(...args: unknown[]): string;
    methodMap: Map<string, { pluginId: string; handler: () => Promise<unknown> }>;
    requireCapabilityCommitLifecycle(...args: unknown[]): object;
    runPluginLifecycleHook(scope: unknown, hook: () => unknown): Promise<unknown>;
  };
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  async function setup(mode: Mode) {
    const fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-attempt-resources-" });
    const originalError = new Error(`original ${mode} error`);
    const cleanupError = new Error("root cleanup failed");
    const counts = { disposed: 0, drained: 0 };
    const timeline: string[] = [];
    const audits: string[] = [];
    const roots: string[] = [];
    const removals: string[] = [];
    const incarnations: Array<{ isActive(): boolean }> = [];
    const constructed: Constructed[] = [];
    const toolGate = mode === "hanging-tool"
      ? await childProcessGate(join(fixture.rootDir, "tool-call-gate"))
      : undefined;
    const entrySource = mode === "factory-crash"
      ? 'throw new Error("entry construction failed");\n'
      : mode === "start-crash"
        ? WORKING.replace("start: async () => {}", 'start: async () => { throw new Error("child start failed"); }')
        : mode === "hanging-tool"
          ? `${toolGate!.moduleSource}\n${WORKING.replace(`${PING}: async () => "pong"`, `${PING}: () => { gate.signal("entered"); return new Promise(() => {}); }`)}`
          : WORKING;
    const written = await writeTestPlugin(fixture, { id: ID, tools: [PING], entrySource });
    const cacheRoot = join(fixture.rootDir, "receipts");
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3,
      pluginId: ID,
      version: written.manifest.version,
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "fixture-v1",
      admission: null,
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(written.pluginDir, ["entry.mjs", "plugin.json"]),
    });
    await writeTestPluginRegistry(fixture, [{ id: ID, manifestPath: written.manifestPath }]);
    const runtime = makeTestPluginRuntime(fixture, {
      installReceiptCacheRoot: cacheRoot,
      auditLog: (_level, type) => {
        audits.push(type);
        if (mode === "cleanup-audit-crash" && type === "plugin_attempt_cleanup_failed") throw new Error("cleanup audit sink failed");
        if (mode === "crash-audit-crash" && type === "plugin_load_crashed") throw new Error("crash audit sink failed");
      },
      createHostApi: (...args) => {
        const incarnation = args[3];
        incarnations.push(incarnation);
        incarnation.registerDisposer(() => { counts.disposed += 1; timeline.push("disposer"); });
        if (mode === "hostapi-crash") throw originalError;
        return createNoopHostApiForTests(args[0], args[1], args[2]);
      },
    });
    testRuntimes.delete(runtime);
    const internals = runtime as unknown as Internals;
    // Restore real materialization so these cases exercise receipt-backed generation roots.
    delete (internals as Partial<Internals>).materializeImmutableRuntimeRoot;
    delete (internals as Partial<Internals>).removeUnpublishedRuntimeRoot;
    const materialize = internals.materializeImmutableRuntimeRoot.bind(runtime);
    internals.materializeImmutableRuntimeRoot = async (...args) => {
      const root = await materialize(...args);
      roots.push(root);
      return root;
    };
    const removeRoot = internals.removeUnpublishedRuntimeRoot.bind(runtime);
    internals.removeUnpublishedRuntimeRoot = async (pluginId, root) => {
      removals.push(root);
      timeline.push("root");
      if (mode === "cleanup-error" || mode === "cleanup-audit-crash") throw cleanupError;
      await removeRoot(pluginId, root);
    };
    const build = internals.buildHostApiIncarnation.bind(runtime);
    internals.buildHostApiIncarnation = (...args) => {
      const result = build(...args);
      const deactivate = result.deactivate;
      result.deactivate = () => { timeline.push("deactivate"); deactivate(); };
      const effects = args[3] as { discard(): void };
      const discard = effects.discard.bind(effects);
      effects.discard = () => { timeline.push("discard"); discard(); };
      const drain = result.drainOperations;
      result.drainOperations = async () => { counts.drained += 1; timeline.push("drain"); await drain(); };
      return result;
    };
    if (["directory-crash", "cleanup-error", "cleanup-audit-crash", "crash-audit-crash"].includes(mode)) {
      internals.ensureDataDir = () => { throw originalError; };
    }
    if (mode === "duplicate") {
      internals.methodMap.set(PING, { pluginId: "attemptresources-foreign", handler: async () => "foreign" });
    }
    if (mode === "publication-crash") {
      const requireLifecycle = internals.requireCapabilityCommitLifecycle.bind(runtime);
      internals.requireCapabilityCommitLifecycle = (...args) => new Proxy(requireLifecycle(...args), {
        get: (target, key) => key === "replaceRuntime"
          ? async () => { throw originalError; }
          : Reflect.get(target, key),
      });
    }
    if (mode === "post-registration-crash") {
      const requireLifecycle = internals.requireCapabilityCommitLifecycle.bind(runtime);
      internals.requireCapabilityCommitLifecycle = (...args) => new Proxy(requireLifecycle(...args), {
        get: (target, key) => key === "replaceRuntime"
          ? async (...replaceArgs: unknown[]) => {
            await (Reflect.get(target, key) as (...a: unknown[]) => Promise<void>).apply(target, replaceArgs);
            throw originalError;
          }
          : Reflect.get(target, key),
      });
    }
    const hook = internals.runPluginLifecycleHook.bind(runtime);
    internals.runPluginLifecycleHook = async (scope, invoke) => {
      const result = await hook(scope, invoke);
      if (result && typeof result === "object" && "handlers" in result) {
        const instance = result as Constructed["instance"];
        const record: Constructed = { instance, stops: 0, ping: instance.handlers[PING]! };
        const stop = instance.stop?.bind(instance);
        instance.stop = async () => { record.stops += 1; timeline.push("stop"); await stop?.(); };
        constructed.push(record);
        // Throw while mapping returned handlers to exercise cleanup after child creation.
        if (mode === "mapping-crash" || mode === "cancel-mapping-crash" || (mode === "incumbent-crash" && constructed.length === 1)) {
          Object.defineProperty(instance, "handlers", { configurable: true, get: () => { throw originalError; } });
        }
        if (mode === "cancel" || mode === "cancel-mapping-crash") await runtime.removePlugin(ID);
        if (mode === "incumbent-crash" && constructed.length === 1) await runtime.addPlugin(ID);
      }
      return result;
    };
    const exists = (root: string) => access(root).then(() => true, () => false);
    disposers.push(async () => {
      internals.removeUnpublishedRuntimeRoot = removeRoot;
      await runtime.stopAll();
      for (const record of constructed) if (record.stops === 0) await record.instance.stop?.();
      await makeTestTreeWritable(fixture.rootDir);
      await rm(fixture.rootDir, { recursive: true, force: true });
    });
    const stops = () => constructed.reduce((total, record) => total + record.stops, 0);
    const card = () => runtime.listPluginCards().find((entry) => entry.id === ID);
    const preparedInput = async () => ({
      installId: ID,
      manifest: runtime.getPluginManifest(ID)!,
      pluginRoot: written.pluginDir,
      receiptRaw: await readFile(installReceiptPath(cacheRoot, ID), "utf8"),
      registryEntry: { installSource: "user" as const },
      durableCommit: async () => "committed",
    });
    return { fixture, runtime, internals, originalError, cleanupError, counts, timeline, audits, roots, removals, incarnations, constructed, exists, stops, card, preparedInput, toolGate };
  }

  /** Use the real coordinator and commit closure with inert projections; fault injection is one-shot at the named boundary. */
  function bindNativeBundleLifecycle(
    f: Awaited<ReturnType<typeof setup>>,
    faults: { loopbackPrepare?: Error; loopbackPublish?: Error; contributionsUpdated?: Error } = {},
  ): PluginBundleLifecycle {
    const prepared = (pluginId: string, generationId: string) => ({
      pluginId,
      generationId,
      tools: [],
      registryReplacement: { publish: () => undefined, cancel: () => undefined, replacementTools: [] },
      published: false,
      disconnectPredecessor: false,
    });
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: f.runtime,
      receiptCacheRoot: join(f.fixture.rootDir, "receipts"),
      skillStore: new SkillStore({ userDir: join(f.fixture.rootDir, "native-skills") }),
      personaPromptStore: new PersonaPromptStore({ userDir: join(f.fixture.rootDir, "native-prompts") }),
      hookManager: new ScriptHookManager(),
      onContributionsUpdated: () => {
        const fault = faults.contributionsUpdated;
        faults.contributionsUpdated = undefined;
        if (fault) throw fault;
      },
      revokeOperationGeneration: () => undefined,
      skillOverlay: { clearPluginGeneration: () => undefined },
      loopbackManager: {
        prepareGeneration: async (manifest: PluginManifest, generationId: string) => {
          const fault = faults.loopbackPrepare;
          faults.loopbackPrepare = undefined;
          if (fault) throw fault;
          return prepared(manifest.id, generationId);
        },
        prepareRemoval: prepared,
        publishGeneration: (value: { published: boolean }) => {
          const fault = faults.loopbackPublish;
          faults.loopbackPublish = undefined;
          if (fault) throw fault;
          value.published = true;
        },
        postPublishGeneration: () => undefined,
        discardGeneration: async () => undefined,
        retireGeneration: async () => undefined,
      } as never,
      mcpManager: {
        bundledServerIdsForPlugin: () => [],
        prepareBundledGeneration: async () => ({
          records: [],
          predecessorServerIds: [],
          predecessorToolNames: [],
          registryReplacement: { publish: () => undefined, cancel: () => undefined, replacementTools: [] },
          published: false,
        }),
        publishBundledGeneration: () => undefined,
        discardBundledGeneration: async () => undefined,
        retirePublishedMcpReplacement: async () => undefined,
        disconnectBundledGeneration: async () => undefined,
      } as never,
    });
    f.runtime.setGenerationAccess(lifecycle);
    disposers.unshift(async () => {
      faults.loopbackPrepare = undefined;
      faults.loopbackPublish = undefined;
      faults.contributionsUpdated = undefined;
      await lifecycle.deactivate(ID);
      await lifecycle.waitForRetirements();
    });
    return lifecycle;
  }

  const failures: Record<"boot" | "add", Mode[]> = {
    boot: ["factory-crash", "start-crash", "directory-crash", "hostapi-crash", "duplicate", "mapping-crash"],
    add: ["factory-crash", "start-crash", "directory-crash", "hostapi-crash", "duplicate", "mapping-crash", "cancel", "publication-crash"],
  };
  const cases = (["boot", "add"] as const).flatMap((path) => failures[path].map((mode) => [path, mode] as const));

  it.each(["boot", "add"] as const)("%s success hands everything to the registered plugin", async (path) => {
    const f = await setup("success");
    if (path === "boot") await f.runtime.startAll();
    else await f.runtime.addPlugin(ID);
    expect(f.runtime.listPluginIds()).toContain(ID);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 0, drained: 0, stops: 0 });
    expect(f.removals).toEqual([]);
    expect(await f.exists(f.roots[0]!)).toBe(true);
    await expect(f.runtime.call(PING, {})).resolves.toBe("pong");
    await f.runtime.removePlugin(ID);
    expect(f.counts.disposed).toBe(1);
    expect(f.stops()).toBe(1);
  });

  it.each(cases)("%s %s releases the attempt's root, incarnation and child exactly once", async (path, mode) => {
    const f = await setup(mode);
    let failure: unknown;
    if (path === "boot") await f.runtime.startAll();
    else await f.runtime.addPlugin(ID).catch((error: unknown) => { failure = error; });
    expect(f.roots).toHaveLength(1);
    if (path === "add") expect(failure).toBeDefined();
    if (path === "add" && ["directory-crash", "hostapi-crash", "mapping-crash", "publication-crash"].includes(mode)) {
      expect(failure).toBe(f.originalError);
    }
    expect(f.runtime.listPluginIds()).not.toContain(ID);
    expect(f.stops()).toBe(f.constructed.length);
    for (const record of f.constructed) await expect(record.ping({})).rejects.toThrow();
    if (f.incarnations.length > 0) {
      expect(f.counts.disposed).toBe(1);
      expect(f.incarnations.every((incarnation) => !incarnation.isActive())).toBe(true);
    }
    if (f.incarnations.length > 0 && mode !== "hostapi-crash") expect(f.counts.drained).toBe(1);
    expect(f.removals).toEqual([f.roots[0]]);
    expect(await f.exists(f.roots[0]!)).toBe(false);
  });

  it("releases a cancelled add's child after a host fault, and reports nothing for it", async () => {
    const f = await setup("cancel-mapping-crash");
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(f.originalError);
    expect(f.card()).toBeUndefined();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    expect(f.removals).toEqual(f.roots);
    expect(await f.exists(f.roots[0]!)).toBe(false);
    await expect(f.constructed[0]!.ping({})).rejects.toThrow();
  });

  it("releases a crashed boot attempt's own child while a same-id add is published, and keeps the add", async () => {
    const f = await setup("incumbent-crash");
    await f.runtime.startAll();
    expect(f.constructed).toHaveLength(2);
    expect(f.incarnations).toHaveLength(2);
    expect(f.runtime.listPluginIds()).toContain(ID);
    await expect(f.runtime.call(PING, {})).resolves.toBe("pong");
    expect(f.incarnations[0]!.isActive()).toBe(false);
    expect(f.incarnations[1]!.isActive()).toBe(true);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    expect(f.removals).toEqual([f.roots[0]]);
    expect(await f.exists(f.roots[0]!)).toBe(false);
    expect(await f.exists(f.roots[1]!)).toBe(true);
    await expect(f.constructed[0]!.ping({})).rejects.toThrow();
  });

  it("rejects with the original add error and records the crash when compensating cleanup fails", async () => {
    const f = await setup("cleanup-error");
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(f.originalError);
    expect(f.card()).toMatchObject({
      loadStatus: "failed",
      installFailureKind: "load-crash",
      installFailureMessage: f.originalError.message,
      arm: "child",
      confinement: "not-spawned",
    });
    // Audit cleanup failure separately without attaching it to the original error.
    expect((failure as Error).cause).toBeUndefined();
    expect(f.audits).toContain("plugin_attempt_cleanup_failed");
  });

  it.each([
    ["frozen", (error: Error) => { Object.freeze(error); }],
    ["sealed", (error: Error) => { Object.seal(error); }],
    ["non-extensible", (error: Error) => { Object.preventExtensions(error); }],
    ["locked-cause", (error: Error) => { Object.defineProperty(error, "cause", { value: undefined, configurable: false, writable: false }); }],
  ] as const)("rejects with the unchanged %s original error when compensating cleanup fails", async (_shape, lock) => {
    const f = await setup("cleanup-error");
    lock(f.originalError);
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(f.originalError);
    expect(f.card()).toMatchObject({ installFailureKind: "load-crash", installFailureMessage: f.originalError.message });
    expect(f.audits).toContain("plugin_attempt_cleanup_failed");
  });

  it.each(["cleanup-audit-crash", "crash-audit-crash"] as const)(
    "add with a throwing audit sink (%s) still rejects with the original error and records the crash",
    async (mode) => {
      const f = await setup(mode);
      const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
      expect(failure).toBe(f.originalError);
      expect(f.card()).toMatchObject({ installFailureKind: "load-crash", installFailureMessage: f.originalError.message });
      expect(f.removals).toEqual([f.roots[0]]);
    },
  );

  it.each(["cleanup-audit-crash", "crash-audit-crash"] as const)(
    "boot with a throwing audit sink (%s) still records the crash and finishes",
    async (mode) => {
      const f = await setup(mode);
      await expect(f.runtime.startAll()).resolves.toBeUndefined();
      expect(f.card()).toMatchObject({ installFailureKind: "load-crash", installFailureMessage: f.originalError.message });
      expect(f.removals).toEqual([f.roots[0]]);
    },
  );

  it.each(["boot", "add"] as const)("%s release stops the child before disposing what it left, then drains and removes the root", async (path) => {
    const f = await setup("mapping-crash");
    if (path === "boot") await f.runtime.startAll();
    else await f.runtime.addPlugin(ID).catch(() => undefined);
    // End authority before disposing; wait for the child to stop before draining.
    expect(f.timeline).toEqual(["deactivate", "stop", "discard", "disposer", "drain", "root"]);
  });

  it("a publication failure after the coordinator commit, before the runtime publishes, leaves the committed generation owning everything", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f, { loopbackPublish: f.originalError });
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect((failure as Error).cause).toBe(f.originalError);
    expect(lifecycle.getActive(ID)).toBeDefined();
    expect(f.runtime.listPluginIds()).not.toContain(ID);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 0, drained: 0, stops: 0 });
    expect(f.incarnations[0]!.isActive()).toBe(true);
    expect(f.removals).toEqual([]);
    expect(await f.exists(f.roots[0]!)).toBe(true);
    expect(f.audits).not.toContain("plugin_load_crashed");
    expect(f.card()?.installFailureKind).toBeUndefined();
  });

  it("a normal removal retires a committed generation the runtime never published, exactly once", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f, { loopbackPublish: f.originalError });
    await f.runtime.addPlugin(ID).catch(() => undefined);
    await f.runtime.removePlugin(ID);
    await lifecycle.waitForRetirements();
    expect(lifecycle.getActive(ID)).toBeUndefined();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    expect(f.incarnations[0]!.isActive()).toBe(false);
    expect(await f.exists(f.roots[0]!)).toBe(false);
    await expect(f.constructed[0]!.ping({})).rejects.toThrow();
  });

  it("a post-commit notification failure settles dispatch: a normal call fails visibly instead of hanging", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f, { contributionsUpdated: f.originalError });
    await expect(f.runtime.addPlugin(ID)).rejects.toBe(f.originalError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = f.runtime.call(PING, {}).then(() => "served", () => "rejected");
    const pending = new Promise<"pending">((resolve) => { timer = setTimeout(() => resolve("pending"), 2_000); });
    const outcome = await Promise.race([call, pending]);
    clearTimeout(timer);
    expect(outcome).toBe("rejected");
  });

  it("the lifecycle's post-commit error stays the add's outcome when onEnable then throws too", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f, { contributionsUpdated: f.originalError });
    const secondary = new Error("onEnable failed");
    (f.runtime as unknown as { onEnable: () => void }).onEnable = () => { throw secondary; };
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(f.originalError);
    expect(f.audits).toContain("plugin_add_follow_up_failed");
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 0, drained: 0, stops: 0 });
  });

  it("boot: a publication failure after the coordinator commit leaves the committed generation owning everything until removal", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f, { loopbackPublish: f.originalError });
    await f.runtime.startAll();
    expect(lifecycle.getActive(ID)).toBeDefined();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 0, drained: 0, stops: 0 });
    expect(f.removals).toEqual([]);
    expect(await f.exists(f.roots[0]!)).toBe(true);
    await expect(f.constructed[0]!.ping({})).resolves.toBe("pong");
    await f.runtime.removePlugin(ID);
    await lifecycle.waitForRetirements();
    expect(lifecycle.getActive(ID)).toBeUndefined();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    expect(await f.exists(f.roots[0]!)).toBe(false);
  });

  it.each([
    ["before", "loopbackPublish"],
    ["after", "contributionsUpdated"],
  ] as const)("reload: a failure after the coordinator commit, %s the runtime publishes, leaves the committed replacement owning everything until removal", async (_when, point) => {
    const f = await setup("success");
    const faults: { loopbackPrepare?: Error; loopbackPublish?: Error; contributionsUpdated?: Error } = {};
    const lifecycle = bindNativeBundleLifecycle(f, faults);
    await f.runtime.addPlugin(ID);
    faults[point] = f.originalError;
    const failure = await f.runtime.reloadPlugin(ID).then(() => undefined, (error: unknown) => error);
    await lifecycle.waitForRetirements();
    expect(f.constructed).toHaveLength(2);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    expect(f.constructed[1]!.stops).toBe(0);
    expect(f.incarnations[1]!.isActive()).toBe(true);
    const replacementRoot = f.roots.at(-1)!;
    expect(await f.exists(replacementRoot)).toBe(true);
    await expect(f.constructed[1]!.ping({})).resolves.toBe("pong");
    // Reload wraps faults before publication as committed-publication errors; later faults propagate directly.
    expect(failure === f.originalError || (failure as Error).cause === f.originalError).toBe(true);
    await f.runtime.removePlugin(ID);
    await lifecycle.waitForRetirements();
    expect(lifecycle.getActive(ID)).toBeUndefined();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 2, drained: 2, stops: 2 });
    expect(await f.exists(replacementRoot)).toBe(false);
  });

  it.each(["preparation", "durable commit"] as const)("prepared activation releases its unpublished child when the %s rejects, and leaves the incumbent", async (point) => {
    const f = await setup("success");
    const faults: { loopbackPrepare?: Error } = {};
    const lifecycle = bindNativeBundleLifecycle(f, faults);
    await f.runtime.addPlugin(ID);
    const incumbent = lifecycle.getActive(ID)!;
    const input = await f.preparedInput();
    if (point === "preparation") faults.loopbackPrepare = f.originalError;
    else input.durableCommit = async () => { throw f.originalError; };
    await expect(f.runtime.activatePreparedArtifact(input)).rejects.toBe(f.originalError);
    expect(f.constructed).toHaveLength(2);
    expect(lifecycle.getActive(ID)?.generationId).toBe(incumbent.generationId);
    expect(f.constructed[1]!.stops).toBe(1);
    expect(f.incarnations[1]!.isActive()).toBe(false);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    await expect(f.constructed[1]!.ping({})).rejects.toThrow();
    await expect(f.runtime.call(PING, {})).resolves.toBe("pong");
    await f.runtime.removePlugin(ID);
    await lifecycle.waitForRetirements();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 2, drained: 2, stops: 2 });
  });

  // Boot can expose a committed generation through both maps; shutdown must stop it once.
  it.each(["add", "reload", "boot"] as const)("shutdown stops a %s generation the coordinator committed but the runtime map never received, exactly once", async (path) => {
    const f = await setup("success");
    const faults: { loopbackPublish?: Error } = {};
    const lifecycle = bindNativeBundleLifecycle(f, faults);
    if (path === "reload") await f.runtime.addPlugin(ID);
    faults.loopbackPublish = f.originalError;
    if (path === "boot") await f.runtime.startAll();
    else if (path === "reload") await f.runtime.reloadPlugin(ID).catch(() => undefined);
    else await f.runtime.addPlugin(ID).catch(() => undefined);
    await lifecycle.waitForRetirements();
    expect(lifecycle.getActive(ID)).toBeDefined();
    const candidate = f.constructed.at(-1)!;
    const prior = path === "reload" ? 1 : 0;
    expect(candidate.stops).toBe(0);
    await f.runtime.stopAll();
    expect(candidate.stops).toBe(1);
    expect(f.incarnations.at(-1)!.isActive()).toBe(false);
    await expect(candidate.ping({})).rejects.toThrow();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: prior + 1, drained: prior + 1, stops: prior + 1 });
  });

  it.each(["removal", "atomic uninstall"] as const)("a %s already retiring a committed generation when shutdown starts shares its retirement: disposer and drain run once", async (path) => {
    const f = await setup("success");
    const faults: { loopbackPublish?: Error } = { loopbackPublish: f.originalError };
    const lifecycle = bindNativeBundleLifecycle(f, faults);
    await f.runtime.addPlugin(ID).catch(() => undefined);
    const loopback = (lifecycle as unknown as { deps: { loopbackManager: { retireGeneration: (...args: unknown[]) => Promise<void> } } }).deps.loopbackManager;
    const retireLoopback = loopback.retireGeneration;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atLoopback = new Promise<void>((resolve) => { entered = resolve; });
    loopback.retireGeneration = async (...args) => { entered(); await held; return retireLoopback(...args); };
    const removal = path === "removal"
      ? f.runtime.removePlugin(ID)
      : f.runtime.removePluginWithCommit(ID, async () => "uninstalled");
    await atLoopback;
    const shutdown = f.runtime.stopAll();
    release();
    await shutdown;
    await removal;
    await lifecycle.waitForRetirements();
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
  });

  it("shutdown waits for a distinct incumbent's retirement while its lease is held, and retires it once", async () => {
    const f = await setup("success");
    const faults: { loopbackPublish?: Error } = {};
    const lifecycle = bindNativeBundleLifecycle(f, faults);
    await f.runtime.addPlugin(ID);
    let lease: Awaited<ReturnType<typeof lifecycle.acquire>> | undefined = await lifecycle.acquire(ID);
    faults.loopbackPublish = f.originalError;
    // A committed replacement may leave the incumbent in the runtime map while retirement waits for its lease.
    await lifecycle.runWithLease(lease, () => f.runtime.reloadPlugin(ID)).catch(() => undefined);
    expect(f.constructed).toHaveLength(2);
    let settled = false;
    const shutdown = f.runtime.stopAll().finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      expect(f.constructed[0]!.stops).toBe(0);
    } finally {
      lease?.release();
      lease = undefined;
    }
    await shutdown;
    await lifecycle.waitForRetirements();
    expect(f.constructed[0]!.stops).toBe(1);
    expect(f.constructed[1]!.stops).toBe(1);
    expect(f.incarnations.every((incarnation) => !incarnation.isActive())).toBe(true);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 2, drained: 2, stops: 2 });
  });

  it("shutdown rejects a call still pending with a typed shutdown error instead of leaving it waiting", async () => {
    const f = await setup("hanging-tool");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const call = f.runtime.call(PING, {}).then(() => "resolved", (error: unknown) => error);
    await f.toolGate!.waitFor("entered");
    await f.runtime.stopAll();
    expect(await call).toMatchObject({ code: "plugin-runtime-shutdown" });
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 1, drained: 1, stops: 1 });
    await expect(f.runtime.call(PING, {})).rejects.toMatchObject({ code: "plugin-runtime-shutdown" });
  });

  it("shutdown rejects a call still waiting for admission behind a durable transition", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const update = f.runtime.activatePreparedArtifact({
      ...(await f.preparedInput()),
      durableCommit: async () => { entered(); await held; return "committed"; },
    }).then(() => undefined, () => undefined);
    try {
      await atCommit;
      const call = f.runtime.call(PING, {}).then(() => "resolved", (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await f.runtime.stopAll();
      const outcome = await Promise.race([call, new Promise((resolve) => setTimeout(() => resolve("pending"), 500))]);
      expect(outcome).toMatchObject({ code: "plugin-runtime-shutdown" });
    } finally {
      release();
      await update;
    }
  });

  it("every dispatch route rejects with the typed shutdown error once shutdown has begun", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    await f.runtime.stopAll();
    const shutdown = { code: "plugin-runtime-shutdown" };
    await expect(f.runtime.call(PING, {})).rejects.toMatchObject(shutdown);
    await expect(f.runtime.callFromUi(PING, {}, { userAction: true })).rejects.toMatchObject(shutdown);
    await expect(f.runtime.callFromApp(PING, {})).rejects.toMatchObject(shutdown);
    await expect(f.runtime.callDeclaredAppOnlyTool(PING, {})).rejects.toMatchObject(shutdown);
    await expect(f.runtime.readUiResource(ID, "ui://attemptresources/card")).rejects.toMatchObject(shutdown);
    await expect(f.runtime.withPluginInstanceLease(ID, async () => "reached")).rejects.toMatchObject(shutdown);
    await expect(f.runtime.addPlugin(ID)).rejects.toMatchObject(shutdown);
    expect(f.runtime.isShuttingDown()).toBe(true);
  });

  it("shutdown retires many stalled generations concurrently, inside the application's cleanup budget", async () => {
    const f = await setup("success");
    const internals = f.internals as unknown as {
      buildHostApiIncarnation(...args: unknown[]): { commit(): void; deactivate(): void; drainOperations(): Promise<void>; disposers: Array<() => void>; lifecycleHookScope: unknown };
      plugins: Map<string, unknown>;
      disposers: Map<string, Array<() => void>>;
    };
    const finishOperations: Array<() => void> = [];
    let stopStarts = 0;
    const generations = 6;
    for (let i = 0; i < generations; i += 1) {
      const pluginId = `budget${i}`;
      const manifest = { id: pluginId, name: pluginId, version: "1.0.0", description: "shutdown budget fixture", entry: "entry.mjs", tools: [] };
      const incarnation = internals.buildHostApiIncarnation(pluginId, manifest, pluginDataDirIn(join(f.fixture.rootDir, "budget-roots", pluginId)), new HostApiGenerationScope(pluginId), null);
      (f.incarnations.at(-1) as unknown as { trackOperation(p: Promise<void>): void }).trackOperation(new Promise<void>((resolve) => { finishOperations.push(resolve); }));
      incarnation.commit();
      const instance = { handlers: {}, stop: () => { stopStarts += 1; return new Promise<void>(() => undefined); } };
      internals.plugins.set(pluginId, {
        manifest, instance, methods: new Map(), started: true,
        lifecycleHookScope: incarnation.lifecycleHookScope,
        deactivateHostApi: incarnation.deactivate,
        drainHostApiOperations: incarnation.drainOperations,
        arm: "child", confinement: "not-spawned",
      });
      internals.disposers.set(pluginId, incarnation.disposers);
    }
    vi.useFakeTimers();
    try {
      let report: { unfinished: readonly string[] } | undefined;
      const result = runCleanupWithHardTimeout(async (signal) => {
        report = await f.runtime.stopAll({ signal });
      }, TOOL_TIMEOUT_POLICY.shutdownCleanupMs);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.shutdownCleanupMs);
      expect(await result).toEqual({ status: "completed" });
      expect(stopStarts).toBe(generations);
      // Report every timed-out generation for the backstop within the shutdown budget.
      expect(report).toEqual({ unfinished: Array.from({ length: generations }, (_, i) => `budget${i}`) });
    } finally {
      for (const finish of finishOperations) finish();
      vi.useRealTimers();
    }
  });

  it("names the generations still retiring when the application's shutdown deadline passes", async () => {
    const f = await setup("hanging-tool");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const instance = f.constructed[0]!.instance as { stop?: () => Promise<void> };
    const stop = instance.stop!;
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopEntered = deferred<void>();
    instance.stop = async () => { stopEntered.resolve(); await stopHeld; await stop(); };
    const deadline = new AbortController();
    const audits = f.audits;
    const stopping = f.runtime.stopAll({ signal: deadline.signal });
    await stopEntered.promise;
    deadline.abort();
    try {
      expect(await stopping).toEqual({ unfinished: [ID] });
      expect(audits).toContain("plugin_shutdown_retirement_incomplete");
    } finally {
      releaseStop();
    }
  });

  async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ state: "resolved"; value: T } | { state: "rejected"; error: unknown } | { state: "pending" }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then((value) => ({ state: "resolved" as const, value }), (error: unknown) => ({ state: "rejected" as const, error })),
        new Promise<{ state: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ state: "pending" }), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function bundledMcpManager(f: Awaited<ReturnType<typeof setup>>, lifecycle: PluginBundleLifecycle, client: Record<string, unknown>) {
    const manager = new McpManager(new McpGovernance(join(f.fixture.rootDir, "mcp-policy.json")), new ToolRegistry(), unusedNetworkFetch, join(f.fixture.rootDir, "mcp-config.json"));
    manager.setPluginGenerationAccess(lifecycle);
    const generationId = lifecycle.getActive(ID)!.generationId;
    const serverId = "attemptresources-bundled";
    const internals = manager as unknown as { clients: Map<string, unknown>; bundledOwners: Map<string, unknown>; activeBundledServerIds: Set<string> };
    internals.clients.set(serverId, client);
    internals.bundledOwners.set(serverId, { pluginId: ID, activationId: generationId, generationId, pluginVersion: "1.0.0", localId: "fixture", fingerprint: "a".repeat(64) });
    internals.activeBundledServerIds.add(serverId);
    return { manager, serverId };
  }

  it("shutdown rejects generation consumers outside the runtime dispatcher, queued ones included", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const generationId = lifecycle.getActive(ID)!.generationId;
    let served = 0;
    const { manager, serverId } = bundledMcpManager(f, lifecycle, {
      getPrompt: async () => { served += 1; return { blocks: [], droppedBlocks: 0 }; },
      callTool: async () => { served += 1; return { text: "served", blocks: [], droppedBlocks: 0 }; },
    });
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: PING, description: "fixture tool", source: "plugin", category: "read", pluginId: ID,
      pluginGeneration: { pluginId: ID, generationId }, modelVisible: true, jsonSchema: { type: "object" },
      execute: async () => { served += 1; return { output: "served", isError: false }; },
    }));
    const permissions = new PermissionManager(join(f.fixture.rootDir, "permissions.json"));
    permissions.checkDetailed = () => ({ decision: "allow", reason: "fixture" });
    const executor = new ToolExecutor(registry, undefined, permissions, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => lifecycle);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const update = f.runtime.activatePreparedArtifact({
      ...(await f.preparedInput()),
      durableCommit: async () => { entered(); await held; return "committed"; },
    }).then(() => undefined, () => undefined);
    try {
      await atCommit;
      // Exercise real tool and bundled-server acquisition behind the coordinator transition barrier.
      const turn = new AbortController();
      const queued: Array<Promise<unknown>> = [
        executor.executeAll([{ id: "queued", name: PING, input: {} }], { sessionId: "shutdown-turn", abortSignal: turn.signal, permissionContext: { trustOrigin: "user-keyboard", allowedPluginIds: new Set([ID]) } } as never),
        manager.getPrompt(serverId, "fixture", {}),
        lifecycle.acquireExact(ID, generationId),
        lifecycle.acquire(ID),
      ];
      for (const waiting of queued) expect((await settledWithin(waiting, 20)).state).toBe("pending");
      turn.abort();
      await f.runtime.stopAll();
      const [executed, prompt, exact, any] = await Promise.all(queued.map((waiting) => settledWithin(waiting, 500)));
      expect(executed).toMatchObject({ state: "resolved", value: [{ is_error: true, content: expect.stringContaining("shutting down") }] });
      for (const outcome of [prompt, exact, any]) {
        expect(outcome).toMatchObject({ state: "rejected", error: { code: "plugin-runtime-shutdown" } });
      }
      // Shutdown must refuse new acquisitions before they reach the server.
      await expect(manager.callTool(serverId, "fixture", {})).rejects.toMatchObject({ code: "plugin-runtime-shutdown" });
      await expect(lifecycle.acquireExact(ID, generationId)).rejects.toMatchObject({ code: "plugin-runtime-shutdown" });
      expect(served).toBe(0);
    } finally {
      release();
      await update;
    }
  });

  it("shutdown releases a prepared candidate held in its durable commit, and the commit never publishes it", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const incumbent = lifecycle.getActive(ID)!.generationId;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const update = f.runtime.activatePreparedArtifact({
      ...(await f.preparedInput()),
      durableCommit: async () => { entered(); await held; return "committed"; },
    }).then(() => undefined, (error: unknown) => error);
    try {
      await atCommit;
      const deadline = new AbortController();
      const report = await f.runtime.stopAll({ signal: deadline.signal });
      expect(report).toEqual({ unfinished: [] });
      expect(f.constructed.map((record) => record.stops)).toEqual([1, 1]);
      expect(f.incarnations.map((incarnation) => incarnation.isActive())).toEqual([false, false]);
      release();
      const refused = await update;
      expect(refused).toBeInstanceOf(CommittedPluginGenerationPublicationError);
      expect((refused as CommittedPluginGenerationPublicationError).publicationCause).toMatchObject({ code: "plugin-runtime-shutdown" });
      expect(lifecycle.getActive(ID)?.generationId).toBe(incumbent);
      // Shutdown and activation cleanup must release the candidate only once.
      expect(f.constructed.map((record) => record.stops)).toEqual([1, 1]);
      expect(f.incarnations[1]!.isActive()).toBe(false);
    } finally {
      // Assertion failures must release the shared lifecycle lock.
      release();
      await update;
    }
  });

  it.each(["host integration", "panel delegate"] as const)("a %s keeps its generation until its callback settles, though shutdown rejected its caller", async (route) => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const payload = f.roots[0]!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inCallback = new Promise<void>((resolve) => { entered = resolve; });
    const callback = async () => { entered(); await held; return f.exists(payload); };
    let payloadAtResume: Promise<boolean> | undefined;
    const tracked = async () => { payloadAtResume = callback(); return payloadAtResume; };
    if (route === "panel delegate") f.runtime.setToolInvocationDelegate(tracked);
    const caller = route === "panel delegate"
      ? f.runtime.callFromUi(PING, {})
      : f.runtime.withPluginInstanceLease(ID, tracked);
    const callerOutcome = settledWithin(caller, 60_000);
    await inCallback;
    const removal = f.runtime.removePlugin(ID).then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(lifecycle.getActive(ID)).toBeUndefined());
    const deadline = new AbortController();
    const stopping = f.runtime.stopAll({ signal: deadline.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    deadline.abort();
    try {
      const report = await stopping;
      expect(await callerOutcome).toMatchObject({ state: "rejected", error: { code: "plugin-runtime-shutdown" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await f.exists(payload)).toBe(true);
      // Retirement must wait for callback leases rather than report premature completion.
      expect(report).toEqual({ unfinished: [ID] });
    } finally {
      release();
    }
    expect(await payloadAtResume).toBe(true);
    await removal;
    await lifecycle.waitForRetirements();
    expect(await f.exists(payload)).toBe(false);
  });

  it("names a generation already retiring outside the runtime map when the deadline passes", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const instance = f.constructed[0]!.instance as { stop?: () => Promise<void> };
    const stop = instance.stop!;
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopEntered!: () => void;
    const inStop = new Promise<void>((resolve) => { stopEntered = resolve; });
    instance.stop = async () => { stopEntered(); await stopHeld; await stop(); };
    const removal = f.runtime.removePlugin(ID).then(() => undefined, () => undefined);
    await inStop;
    expect(lifecycle.getActive(ID)).toBeUndefined();
    expect(f.runtime.listPluginIds()).not.toContain(ID);
    const deadline = new AbortController();
    const stopping = f.runtime.stopAll({ signal: deadline.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    deadline.abort();
    try {
      expect(await stopping).toEqual({ unfinished: [ID] });
      expect(f.audits).toContain("plugin_shutdown_retirement_incomplete");
    } finally {
      releaseStop();
      await removal;
    }
  });

  it("a boot load constructing a child when shutdown begins releases it instead of registering it", async () => {
    const f = await setup("success");
    const hook = f.internals.runPluginLifecycleHook;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFactory = new Promise<void>((resolve) => { entered = resolve; });
    f.internals.runPluginLifecycleHook = async (scope, invoke) => {
      const result = await hook(scope, invoke);
      if (result && typeof result === "object" && "handlers" in result) {
        entered();
        await held;
      }
      return result;
    };
    const loading = f.runtime.load();
    await inFactory;
    const deadline = new AbortController();
    const stopping = f.runtime.stopAll({ signal: deadline.signal });
    expect(f.runtime.isShuttingDown()).toBe(true);
    release();
    const report = await stopping;
    await loading;
    expect(f.runtime.listPluginIds()).not.toContain(ID);
    expect(f.constructed.map((record) => record.stops)).toEqual([1]);
    expect(f.incarnations[0]!.isActive()).toBe(false);
    expect(report).toEqual({ unfinished: [] });
  });

  it("starts no deferred post-commit work in a generation whose predecessor retires after shutdown began", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inIntegration = new Promise<void>((resolve) => { entered = resolve; });
    const integration = f.runtime.withPluginInstanceLease(ID, async () => { entered(); await held; })
      .then(() => undefined, () => undefined);
    await inIntegration;
    const postPublish = vi.spyOn(f.runtime, "postPublishRuntimeGeneration");
    const mcpManager = (lifecycle as unknown as { deps: { mcpManager: { prepareBundledGeneration: (...args: unknown[]) => Promise<unknown> } } }).deps.mcpManager;
    const mcpPrepare = vi.spyOn(mcpManager, "prepareBundledGeneration");
    const incumbent = lifecycle.getActive(ID)!.generationId;
    // The coordinator pointer marks commit before deferred startup finishes; observe publication rather than elapsed time.
    const loopback = (lifecycle as unknown as { deps: { loopbackManager: { publishGeneration: (value: never) => void } } }).deps.loopbackManager;
    const publishLoopback = loopback.publishGeneration.bind(loopback);
    let pointerMoved!: () => void;
    const committed = new Promise<void>((resolve) => { pointerMoved = resolve; });
    loopback.publishGeneration = (value) => { publishLoopback(value); pointerMoved(); };
    const update = f.runtime.activatePreparedArtifact(await f.preparedInput())
      .then(() => undefined, (error: unknown) => error);
    try {
      await Promise.race([
        committed,
        update.then((error) => { throw error ?? new Error("activation settled before its commit"); }),
      ]);
      expect(lifecycle.getActive(ID)?.generationId).not.toBe(incumbent);
      const deadline = new AbortController();
      const stopping = f.runtime.stopAll({ signal: deadline.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      deadline.abort();
      await stopping;
    } finally {
      // Release the incumbent lease even when an assertion fails.
      release();
      await integration;
    }
    expect(await update).toBeUndefined();
    expect(postPublish).not.toHaveBeenCalled();
    expect(mcpPrepare).not.toHaveBeenCalled();
  });

  it("runs each generation disposer once and retries only the ones that failed", async () => {
    const f = await setup("success");
    let flakyCalls = 0;
    const steady = vi.fn();
    const view = {
      manifest: { id: "disposerretry", name: "disposerretry", version: "1.0.0", description: "fixture", entry: "entry.mjs", tools: [] },
      instance: { handlers: {} },
      disposers: [steady, () => {
        flakyCalls += 1;
        if (flakyCalls === 1) throw new Error("transient cleanup failure");
      }],
    };
    const effects = () => f.runtime.prepareRuntimeRetirement(view as never)
      .find((step) => step.phase === "runtime.effects")!.run();
    await expect(effects()).rejects.toThrow(/effects retirement failed/);
    await effects();
    expect(steady).toHaveBeenCalledTimes(1);
    expect(flakyCalls).toBe(2);
  });

  async function heldUpdateWithFailingCleanup(f: Awaited<ReturnType<typeof setup>>) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const update = f.runtime.activatePreparedArtifact({
      ...(await f.preparedInput()),
      durableCommit: async () => { entered(); await held; return "committed"; },
    }).then(() => undefined, (error: unknown) => error);
    await atCommit;
    (f.runtime as unknown as { drainPluginHostApiOperations: () => Promise<void> }).drainPluginHostApiOperations =
      async () => { throw f.cleanupError; };
    return { update, release };
  }

  it("reports a prepared candidate whose cleanup failed at shutdown as unfinished", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const { update, release } = await heldUpdateWithFailingCleanup(f);
    const deadline = new AbortController();
    try {
      expect(await f.runtime.stopAll({ signal: deadline.signal })).toEqual({ unfinished: [ID] });
      expect(f.audits).toContain("plugin_shutdown_retirement_incomplete");
    } finally {
      release();
      await update;
    }
  });

  it("keeps the durable-commit marker when a withheld candidate's runtime cleanup fails", async () => {
    const f = await setup("success");
    bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const { update, release } = await heldUpdateWithFailingCleanup(f);
    try {
      await f.runtime.stopAll({ signal: new AbortController().signal });
      release();
      const refused = await update;
      expect(isCommittedPluginGenerationPublicationError(refused)).toBe(true);
      expect(classifyApplyError(refused)).toEqual({ state: "applied-not-running" });
    } finally {
      release();
      await update;
    }
  });

  it("keeps the durable-commit marker when a withheld candidate's lifecycle cleanup fails", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const loopback = (lifecycle as unknown as { deps: { loopbackManager: { discardGeneration: () => Promise<void> } } }).deps.loopbackManager;
    loopback.discardGeneration = async () => { throw f.cleanupError; };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    const update = f.runtime.activatePreparedArtifact({
      ...(await f.preparedInput()),
      durableCommit: async () => { entered(); await held; return "committed"; },
    }).then(() => undefined, (error: unknown) => error);
    try {
      await atCommit;
      await f.runtime.stopAll({ signal: new AbortController().signal });
      release();
      const refused = await update;
      expect(isCommittedPluginGenerationPublicationError(refused)).toBe(true);
      expect(classifyApplyError(refused)).toEqual({ state: "applied-not-running" });
    } finally {
      release();
      await update;
    }
  });

  it("names a generation whose retirement phase failed at shutdown as unfinished", async () => {
    const f = await setup("success");
    await f.runtime.addPlugin(ID);
    const instance = f.constructed[0]!.instance as { stop?: () => Promise<void> };
    const stop = instance.stop;
    instance.stop = async () => { throw new Error("child stop failed"); };
    let report: { unfinished: readonly string[] };
    try {
      report = await f.runtime.stopAll({ signal: new AbortController().signal });
    } finally {
      // The fixture's own teardown stops the child.
      instance.stop = stop;
    }
    expect(report).toEqual({ unfinished: [ID] });
    expect(f.audits).toContain("plugin_shutdown_retirement_incomplete");
  });

  it.each(["add", "boot"] as const)("names an %s candidate whose cleanup failed at shutdown as unfinished", async (route) => {
    const f = await setup("success");
    if (route === "add") bindNativeBundleLifecycle(f);
    const hook = f.internals.runPluginLifecycleHook;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFactory = new Promise<void>((resolve) => { entered = resolve; });
    f.internals.runPluginLifecycleHook = async (scope, invoke) => {
      const result = await hook(scope, invoke);
      if (result && typeof result === "object" && "handlers" in result) {
        entered();
        await held;
      }
      return result;
    };
    const building = (route === "add" ? f.runtime.addPlugin(ID) : f.runtime.load()).then(() => undefined, () => undefined);
    await inFactory;
    // Releasing the candidate's unpublished root fails.
    f.internals.removeUnpublishedRuntimeRoot = async () => { throw f.cleanupError; };
    const stopping = f.runtime.stopAll({ signal: new AbortController().signal });
    expect(f.runtime.isShuttingDown()).toBe(true);
    release();
    const report = await stopping;
    await building;
    expect(f.constructed.map((record) => record.stops)).toEqual([1]);
    expect(report).toEqual({ unfinished: [ID] });
    expect(f.audits).toContain("plugin_shutdown_retirement_incomplete");
  });

  it("records no post-commit fault for an MCP publication refused because shutdown began while it waited", async () => {
    const f = await setup("success");
    const lifecycle = bindNativeBundleLifecycle(f);
    await f.runtime.addPlugin(ID);
    const internals = lifecycle as unknown as {
      deps: { mcpManager: { prepareBundledGeneration: (...args: unknown[]) => Promise<unknown> } };
      coordinator: { runPostCommitWithGeneration: (pluginId: string, generationId: string, operation: () => Promise<unknown>) => Promise<unknown> };
      recordPostCommitFault: (...args: unknown[]) => void;
    };
    const faults = vi.spyOn(internals, "recordPostCommitFault");
    const prepareMcp = internals.deps.mcpManager.prepareBundledGeneration.bind(internals.deps.mcpManager);
    let releasePrepare!: () => void;
    const prepareHeld = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let prepareEntered!: () => void;
    const inPrepare = new Promise<void>((resolve) => { prepareEntered = resolve; });
    internals.deps.mcpManager.prepareBundledGeneration = async (...args) => {
      prepareEntered();
      await prepareHeld;
      return prepareMcp(...args);
    };
    const incumbent = lifecycle.getActive(ID)!.generationId;
    let releaseLease: () => void = () => undefined;
    let lease: Promise<unknown> | undefined;
    const update = f.runtime.activatePreparedArtifact(await f.preparedInput()).then(() => undefined, () => undefined);
    try {
      await inPrepare;
      const candidate = lifecycle.getActive(ID)!.generationId;
      expect(candidate).not.toBe(incumbent);
      // A lease on the candidate, so its MCP publication (quiesce) waits to drain.
      const leaseHeld = new Promise<void>((resolve) => { releaseLease = resolve; });
      let leased!: () => void;
      const inLease = new Promise<void>((resolve) => { leased = resolve; });
      lease = internals.coordinator.runPostCommitWithGeneration(ID, candidate, async () => { leased(); await leaseHeld; });
      await inLease;
      releasePrepare();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deadline = new AbortController();
      const stopping = f.runtime.stopAll({ signal: deadline.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      deadline.abort();
      await stopping;
      releaseLease();
      await lease;
      await update;
      await lifecycle.waitForRetirements().catch(() => undefined);
      expect(faults.mock.calls.filter((call) => call[2] === "mcp-publication")).toEqual([]);
    } finally {
      releasePrepare();
      releaseLease();
      await Promise.allSettled([update, lease]);
    }
  });

  it("a rejection after the plugin was registered leaves the registered generation running and disposes it once", async () => {
    const f = await setup("post-registration-crash");
    const failure = await f.runtime.addPlugin(ID).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(f.originalError);
    expect(f.runtime.listPluginIds()).toContain(ID);
    expect({ ...f.counts, stops: f.stops() }).toEqual({ disposed: 0, drained: 0, stops: 0 });
    expect(f.incarnations[0]!.isActive()).toBe(true);
    expect(f.removals).toEqual([]);
    expect(await f.exists(f.roots[0]!)).toBe(true);
    await expect(f.runtime.call(PING, {})).resolves.toBe("pong");
    // Not the attempt's failure: no crash card for a running plugin.
    expect(f.card()?.installFailureKind).toBeUndefined();
    await f.runtime.removePlugin(ID);
    expect({ disposed: f.counts.disposed, stops: f.stops() }).toEqual({ disposed: 1, stops: 1 });
  });
});
