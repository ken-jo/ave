import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportUrl } from "../plugin-loader.js";
import { PluginChildTerminationUnverifiedError } from "../../isolation/plugin-child-transport.js";
import {
  makeTestPluginRuntime,
  TestPluginRuntime,
} from "../../__tests__/test-helpers.js";
import { servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";

describe("PluginRuntime lifecycle — restartPlugin", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-lifecycle-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRuntime() {
    return makeTestPluginRuntime({
      rootDir: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
  }

  it("restartPlugin is a no-op when plugin is not loaded (warns)", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    await expect(runtime.restartPlugin("nonexistent")).resolves.toBeUndefined();
  });

  it("restartPlugin stops and restarts a loaded plugin", async () => {
    const pluginDir = join(installedDir, "lc-restart");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `let count = 0;
export default async function createPlugin() {
  return {
    handlers: { lc_restart_ping: async () => ++count },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-restart",
        name: "LC Restart",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_restart_ping", description: "lc_restart_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle restart test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds()).toContain("lc-restart");

    await runtime.restartPlugin("lc-restart");

    expect(runtime.listPluginIds()).toContain("lc-restart");
    await expect(runtime.call("lc_restart_ping")).resolves.toBeDefined();
  });

  it("does not commit a replacement that finishes after removePlugin invalidates it", async () => {
    const pluginDir = join(installedDir, "lc-restart-remove-race");
    const armPath = join(testDir, "restart-arm");
    const enteredPath = join(testDir, "restart-entered");
    const releasePath = join(testDir, "restart-release");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { access, writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { lc_restart_remove_race_ping: async () => "pong" },
    start: async () => {
      try {
        await access(${JSON.stringify(armPath)});
        await writeFile(${JSON.stringify(enteredPath)}, "entered");
        while (true) {
          try { await access(${JSON.stringify(releasePath)}); break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
      } catch {}
    },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-restart-remove-race",
        name: "Restart Remove Race",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_restart_remove_race_ping", description: "restart removal race regression tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle race regression",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart-remove-race", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(armPath, "armed", "utf-8");
    const restart = runtime.restartPlugin("lc-restart-remove-race");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { await access(enteredPath); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    await expect(access(enteredPath)).resolves.toBeUndefined();

    const removal = runtime.removePlugin("lc-restart-remove-race");
    await writeFile(releasePath, "release", "utf-8");

    await expect(restart).resolves.toBe("failed");
    await expect(removal).resolves.toBeUndefined();
    expect(runtime.listPluginIds()).not.toContain("lc-restart-remove-race");
    await expect(runtime.call("lc_restart_remove_race_ping")).rejects.toThrow(/not found/);
  });

  it("cancels an in-flight replacement before it can start or publish", async () => {
    const pluginId = "lc-restart-shutdown-cancel";
    const pluginDir = join(installedDir, pluginId);
    const armPath = join(testDir, "restart-shutdown-arm");
    const enteredPath = join(testDir, "restart-shutdown-entered");
    const releasePath = join(testDir, "restart-shutdown-release");
    const candidateStartedPath = join(testDir, "restart-shutdown-candidate-started");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { access, writeFile } from "node:fs/promises";
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
export default async function createPlugin() {
  const candidate = await exists(${JSON.stringify(armPath)});
  if (candidate) {
    await writeFile(${JSON.stringify(enteredPath)}, "entered");
    while (!(await exists(${JSON.stringify(releasePath)}))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return {
    handlers: { lc_restart_shutdown_cancel_ping: async () => candidate ? "replacement" : "predecessor" },
    start: async () => {
      if (candidate) await writeFile(${JSON.stringify(candidateStartedPath)}, "started");
    },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: pluginId,
        name: "Restart Shutdown Cancel",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{
          name: "lc_restart_shutdown_cancel_ping",
          description: "restart cancellation shutdown regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Cancellation must prevent an in-flight replacement from starting or publishing.",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: pluginId, manifestPath, enabled: true }] }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(armPath, "armed", "utf-8");
    const restart = runtime.restartPlugin(pluginId);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { await access(enteredPath); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    await expect(access(enteredPath)).resolves.toBeUndefined();

    // If shutdown aborts during construction, never start or publish the late replacement.
    runtime.cancelAllPendingRestarts();
    await writeFile(releasePath, "release", "utf-8");

    await expect(restart).resolves.toBe("failed");
    await expect(access(candidateStartedPath)).rejects.toThrow();
    await expect(runtime.call("lc_restart_shutdown_cancel_ping")).resolves.toBe("predecessor");
  });
  it("bounds an uncertain replacement start and preserves the predecessor generation", async () => {
    const pluginDir = join(installedDir, "lc-restart-timeout");
    const armPath = join(testDir, "restart-timeout-arm");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { access } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { lc_restart_timeout_ping: async () => "old-still-live" },
    start: async () => {
      try {
        await access(${JSON.stringify(armPath)});
        await new Promise(() => {});
      } catch {}
    },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-restart-timeout",
        name: "Restart Timeout",
        version: "1.0.0",
        entry: "entry.mjs",
        startupTimeoutMs: 50,
        tools: [{
          name: "lc_restart_timeout_ping",
          description: "Restart timeout regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Lifecycle restart timeout regression.",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart-timeout", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(armPath, "armed", "utf-8");

    await expect(runtime.restartPlugin("lc-restart-timeout")).resolves.toBe("failed");
    expect(runtime.listPluginIds()).toContain("lc-restart-timeout");
    await expect(runtime.call("lc_restart_timeout_ping")).resolves.toBe("old-still-live");
    await expect(runtime.restartPlugin("lc-restart-timeout")).rejects.toMatchObject({
      code: "plugin-lifecycle-quarantined",
    });
  });

  it("quarantines a restart whose factory could not verify child termination", async () => {
    const pluginDir = join(installedDir, "lc-unverified");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_unverified_ping: async () => "old-still-live" }, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-unverified",
        name: "Unverified Termination",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{
          name: "lc_unverified_ping",
          description: "Unverified termination regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Unverified termination regression.",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "lc-unverified", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    // The host factory, not plugin code, raises this: its spawned child could not be shown to have exited.
    const routing = runtime as unknown as {
      importPluginFactoryForLifecycle(...args: unknown[]): Promise<{ createPlugin: () => Promise<never>; arm: string }>;
    };
    vi.spyOn(routing, "importPluginFactoryForLifecycle").mockResolvedValue({
      arm: "child",
      createPlugin: async () => {
        throw new PluginChildTerminationUnverifiedError("lc-unverified", { cause: new Error("cleanup unverified") });
      },
    });
    await expect(runtime.restartPlugin("lc-unverified")).resolves.toBe("failed");
    await expect(runtime.restartPlugin("lc-unverified")).rejects.toMatchObject({
      code: "plugin-lifecycle-quarantined",
    });
  });

  it("keeps the published replacement active when predecessor retirement times out", async () => {
    const pluginDir = join(installedDir, "lc-stop-timeout");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { lc_stop_timeout_ping: async () => "pong" },
    stop: async () => new Promise(() => {}),
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-stop-timeout",
        name: "Stop Timeout",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{
          name: "lc_stop_timeout_ping",
          description: "stop timeout regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Stop timeout regression.",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-stop-timeout", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call("lc_stop_timeout_ping")).resolves.toBe("pong");

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
    await expect(runtime.restartPlugin("lc-stop-timeout")).resolves.toBe("started");
    await inStop;
    expect(runtime.listPluginIds()).toContain("lc-stop-timeout");
    await expect(runtime.call("lc_stop_timeout_ping")).resolves.toBe("pong");
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(runtime.restartPlugin("lc-stop-timeout")).rejects.toMatchObject({
      code: "plugin-lifecycle-quarantined",
    });
  }, 10_000);

  it("restartPlugin re-imports the latest on-disk module (ESM cache-bust)", async () => {
    // ESM caches by import URL; restarts need a fresh URL to load changed module state.
    const pluginDir = join(installedDir, "lc-bust");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    const entryPath = join(pluginDir, "entry.mjs");

    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return {
    handlers: { lc_bust_version: async () => "v1" },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-bust",
        name: "LC Cache Bust",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_bust_version", description: "lc_bust_version tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Cache-bust regression test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-bust", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call("lc_bust_version")).resolves.toBe("v1");

    // Rewrite module content so a reused cached URL returns the wrong version.
    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return {
    handlers: { lc_bust_version: async () => "v2" },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );

    await runtime.restartPlugin("lc-bust");
    await expect(runtime.call("lc_bust_version")).resolves.toBe("v2");
  });

  it("restartPlugin marks plugin as failed when manifest is missing on disk", async () => {
    const pluginDir = join(installedDir, "lc-fail-manifest");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_fail_manifest_ping: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-fail-manifest",
        name: "LC Fail Manifest",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_fail_manifest_ping", description: "lc_fail_manifest_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle fail manifest test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-fail-manifest", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-fail-manifest");

    await rm(manifestPath);

    await runtime.restartPlugin("lc-fail-manifest");

    expect(runtime.listPluginIds()).toContain("lc-fail-manifest");
    await expect(runtime.call("lc_fail_manifest_ping")).resolves.toBe("ok");
  });

  it("restartAll re-loads all plugins", async () => {
    const pluginDir = join(installedDir, "lc-restartall");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_restartall_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-restartall",
        name: "LC RestartAll",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_restartall_ping", description: "lc_restartall_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle restartAll test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restartall", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-restartall");

    await runtime.restartAll();

    expect(runtime.listPluginIds()).toContain("lc-restartall");
    await expect(runtime.call("lc_restartall_ping")).resolves.toBe("pong");
  });

  it("disable removes plugin and updates registry", async () => {
    const pluginDir = join(installedDir, "lc-disable");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_disable_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "lc-disable",
        name: "LC Disable",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_disable_ping", description: "lc_disable_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle disable test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-disable", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-disable");

    await runtime.setPluginEnabled("lc-disable", false);

    expect(runtime.listPluginIds()).not.toContain("lc-disable");
    await expect(runtime.call("lc_disable_ping")).rejects.toThrow("Plugin method not found");
  });

  it("disabling throws when the plugin is not known", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.setPluginEnabled("does-not-exist", false)).rejects.toThrow("Plugin not found");
  });

  // Fire onEnable only after replacement publication; expose no transient disabled projection.
  async function setupLifecyclePluginFixture(pluginId: string) {
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { ${pluginId.replace(/-/g, "_")}_ping: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: `${pluginId.replace(/-/g, "_")}_ping`, description: "lifecycle ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "x",
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
    return manifestPath;
  }

  async function writeLifecyclePlugin(pluginId: string): Promise<{ pluginId: string; manifestPath: string; toolName: string }> {
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    const toolName = `${pluginId.replace(/-/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: toolName,
            description: "lifecycle integration test",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "x",
      })),
      "utf-8");
    return { pluginId, manifestPath, toolName };
  }

  async function writeLifecycleRegistry(
    plugins: Array<{ pluginId: string; manifestPath: string }>,
  ): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: plugins.map(({ pluginId, manifestPath }) => ({ id: pluginId, manifestPath, enabled: true })),
      }),
      "utf-8",
    );
  }

  it("restartAll fires onEnable once for each restarted plugin", async () => {
    const alpha = await writeLifecyclePlugin("lc-fanout-alpha");
    const beta = await writeLifecyclePlugin("lc-fanout-beta");
    await writeLifecycleRegistry([alpha, beta]);

    const enabled: string[] = [];
    const runtime = new TestPluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enabled.push(pluginId); },
    });

    await runtime.startAll();
    expect(enabled).toEqual([]);

    await runtime.restartAll();

    expect([...enabled].sort()).toEqual(["lc-fanout-alpha", "lc-fanout-beta"]);
  });

  it("restartPlugin publishes only the replacement enable callback", async () => {
    await setupLifecyclePluginFixture("lc-restart-pair");

    const events: Array<{ type: "disable" | "enable"; pluginId: string }> = [];
    const runtime = new TestPluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => { events.push({ type: "disable", pluginId }); },
      onEnable: (pluginId) => { events.push({ type: "enable", pluginId }); },
    });
    await runtime.startAll();
    events.length = 0;

    await runtime.restartPlugin("lc-restart-pair");

    expect(events).toEqual([{ type: "enable", pluginId: "lc-restart-pair" }]);
    await expect(runtime.call("lc_restart_pair_ping")).resolves.toBe("ok");
  });

  it("addPlugin (fresh-load branch) fires onEnable once after start succeeds", async () => {
    // Skip startAll so addPlugin exercises a fresh load rather than restart of an existing instance.
    await setupLifecyclePluginFixture("lc-add-fresh");

    const enableCalls: string[] = [];
    const runtime = new TestPluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enableCalls.push(pluginId); },
    });
    await runtime.addPlugin("lc-add-fresh");

    expect(enableCalls).toEqual(["lc-add-fresh"]);
    await expect(runtime.call("lc_add_fresh_ping")).resolves.toBe("ok");
  });

  it("reloadPlugin publishes only the replacement enable callback", async () => {
    await setupLifecyclePluginFixture("lc-reload-pair");

    const events: Array<{ type: "disable" | "enable"; pluginId: string }> = [];
    const runtime = new TestPluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => { events.push({ type: "disable", pluginId }); },
      onEnable: (pluginId) => { events.push({ type: "enable", pluginId }); },
    });
    await runtime.startAll();
    events.length = 0;

    await runtime.reloadPlugin("lc-reload-pair");

    expect(events).toEqual([{ type: "enable", pluginId: "lc-reload-pair" }]);
  });

  it("addPlugin failure path (start throws) does NOT fire onEnable", async () => {
    // Failed start must never fire onEnable.
    const pluginId = "lc-add-fail";
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { lc_add_fail_ping: async () => "ok" },
    start: async () => { throw new Error("simulated start failure"); },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_add_fail_ping", description: "lc_add_fail_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "x",
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

    const enableCalls: string[] = [];
    const runtime = new TestPluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enableCalls.push(pluginId); },
    });

    // Propagate failed add while retaining its failed status and suppressing onEnable.
    await runtime.addPlugin(pluginId).catch(() => undefined);

    expect(enableCalls).toEqual([]);
    expect(runtime.listPluginIds()).not.toContain(pluginId);
  });
});

describe("buildImportUrl — cache-bust contract", () => {
  // Cache-busting must produce a new URL or restart silently reuses stale modules.
  const path = "/plugins/test-plugin/dist/hostPlugin.js";

  it("default (bustCache=false) returns stable URL across calls", () => {
    const a = buildImportUrl(path);
    const b = buildImportUrl(path);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\?reload=/);
  });

  it("bustCache=true returns a fresh ?reload= URL each call", async () => {
    const a = buildImportUrl(path, true);
    // Separate clock ticks here; identical timestamps would otherwise reuse the import cache key.
    await new Promise((r) => setTimeout(r, 5));
    const b = buildImportUrl(path, true);
    expect(a).toMatch(/\?reload=\d+$/);
    expect(b).toMatch(/\?reload=\d+$/);
    expect(a).not.toBe(b);
  });
});
