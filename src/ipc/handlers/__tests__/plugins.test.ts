import { describe, expect, it, vi } from "vitest";

import {
  handlePluginBundleE2eSnapshot,
  handlePluginCards,
} from "../plugins.js";
import type { IpcDeps } from "../../types.js";
import type { PluginCard } from "../../../plugins/runtime/index.js";

function makeCard(id: string): PluginCard {
  return {
    id,
    name: id,
    description: "loaded plugin",
    sampleTools: [],
    tools: [],
    capabilities: [],
    loadStatus: "loaded",
    active: true,
    runtimeLoaded: true,
  };
}

describe("handlePluginCards", () => {
  it("returns the runtime's cards", () => {
    const toolRegistry = {};
    const listPluginCards = vi.fn(() => [makeCard("loaded-plugin")]);
    const deps = { toolRegistry, pluginRuntime: { listPluginCards } } as unknown as IpcDeps;

    expect(handlePluginCards(deps)).toEqual([expect.objectContaining({ id: "loaded-plugin", loadStatus: "loaded" })]);
    expect(listPluginCards).toHaveBeenCalledWith(toolRegistry);
  });
});

describe("handlePluginBundleE2eSnapshot", () => {
  it("returns only the requested plugin generation, Skill body, and owned tools", async () => {
    const release = vi.fn();
    const generation = {
      pluginId: "orion-api",
      pluginVersion: "2.0.0",
      generationId: "runtime-g2",
      artifactGenerationId: "a".repeat(64),
      contributions: [],
      state: {},
    };
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => ({ generation, release })),
      },
      skillStore: {
        loadPluginGeneration: vi.fn(() => ({
          name: "plugin:orion-api:lifecycle",
          body: "fixture-version:2.0.0",
          pluginOwner: {
            pluginId: "orion-api",
            pluginVersion: "2.0.0",
            generationId: "runtime-g2",
            localId: "lifecycle",
            fingerprint: "b".repeat(64),
          },
        })),
      },
      toolRegistry: {
        listAll: vi.fn(() => [
          {
            name: "orion_api_read",
            source: "plugin",
            version: "2.0.0",
            pluginId: "orion-api",
            pluginGeneration: { pluginId: "orion-api", generationId: "runtime-g2" },
          },
          {
            name: "mcp_orion_api_bundle_echo",
            source: "mcp",
            version: "1.0.0",
            mcpServerId: "plugin_server_g2",
            pluginGeneration: { pluginId: "orion-api", generationId: "runtime-g2" },
          },
          {
            name: "other_read",
            source: "plugin",
            version: "1.0.0",
            pluginId: "other-plugin",
            pluginGeneration: { pluginId: "other-plugin", generationId: "runtime-g2" },
          },
          {
            name: "orion_api_old_read",
            source: "plugin",
            version: "1.0.0",
            pluginId: "orion-api",
            pluginGeneration: { pluginId: "orion-api", generationId: "runtime-g1" },
          },
        ]),
      },
      scriptHookManager: {
        hooksOfType: vi.fn(() => [
          {
            id: "plugin:orion-api:audit:matching",
            event: "pre",
            matcher: "orion_api_*",
            command: ["node", "matching.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "orion-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "c".repeat(64),
            },
          },
          {
            id: "plugin:orion-api:audit:not-matching",
            event: "pre",
            matcher: "other_*",
            command: ["node", "not-matching.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "orion-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "d".repeat(64),
            },
          },
          {
            id: "plugin:other-plugin:audit:matching",
            event: "pre",
            matcher: "orion_api_*",
            command: ["node", "other-plugin.mjs"],
            source: "config",
            timeoutMs: 5_000,
            owner: {
              pluginId: "other-plugin",
              pluginVersion: "1.0.0",
              activationId: "runtime-other",
              generationId: "artifact-other",
              localId: "audit",
              fingerprint: "e".repeat(64),
            },
          },
        ]),
      },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "orion-api",
        "lifecycle",
        "orion_api_read",
      ),
    ).resolves.toEqual({
      ok: true,
      pluginId: "orion-api",
      active: {
        version: "2.0.0",
        generationId: "runtime-g2",
        artifactGenerationId: "a".repeat(64),
      },
      skill: {
        name: "plugin:orion-api:lifecycle",
        body: "fixture-version:2.0.0",
        owner: {
          pluginId: "orion-api",
          pluginVersion: "2.0.0",
          generationId: "runtime-g2",
          localId: "lifecycle",
          fingerprint: "b".repeat(64),
        },
      },
      tools: [
        {
          name: "orion_api_read",
          source: "plugin",
          version: "2.0.0",
          pluginId: "orion-api",
          generationId: "runtime-g2",
        },
        {
          name: "mcp_orion_api_bundle_echo",
          source: "mcp",
          version: "1.0.0",
          mcpServerId: "plugin_server_g2",
          generationId: "runtime-g2",
        },
      ],
      hooks: {
        probeToolName: "orion_api_read",
        registered: [
          {
            id: "plugin:orion-api:audit:matching",
            event: "pre",
            matcher: "orion_api_*",
            owner: {
              pluginId: "orion-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "c".repeat(64),
            },
          },
          {
            id: "plugin:orion-api:audit:not-matching",
            event: "pre",
            matcher: "other_*",
            owner: {
              pluginId: "orion-api",
              pluginVersion: "2.0.0",
              activationId: "runtime-g2",
              generationId: "artifact-g2",
              localId: "audit",
              fingerprint: "d".repeat(64),
            },
          },
        ],
        matchingPreToolUse: ["plugin:orion-api:audit:matching"],
      },
    });
    expect(deps.skillStore.loadPluginGeneration).toHaveBeenCalledWith(
      generation,
      "plugin:orion-api:lifecycle",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds one generation lease while a transition publishes another generation", async () => {
    const release = vi.fn();
    const leasedGeneration = {
      pluginId: "orion-api",
      pluginVersion: "1.0.0",
      generationId: "runtime-g1",
      artifactGenerationId: "a".repeat(64),
      contributions: [],
      state: {},
    };
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => ({
          generation: leasedGeneration,
          release,
        })),
      },
      skillStore: {
        loadPluginGeneration: vi.fn(() => ({
          name: "plugin:orion-api:lifecycle",
          body: "fixture-version:1.0.0",
          pluginOwner: {
            pluginId: "orion-api",
            pluginVersion: "1.0.0",
            generationId: "runtime-g1",
            localId: "lifecycle",
            fingerprint: "b".repeat(64),
          },
        })),
      },
      toolRegistry: {
        listAll: vi.fn(() => [
          {
            name: "orion_api_read_g1",
            source: "plugin",
            version: "1.0.0",
            pluginId: "orion-api",
            pluginGeneration: { pluginId: "orion-api", generationId: "runtime-g1" },
          },
          {
            name: "orion_api_read_g2",
            source: "plugin",
            version: "2.0.0",
            pluginId: "orion-api",
            pluginGeneration: { pluginId: "orion-api", generationId: "runtime-g2" },
          },
        ]),
      },
      scriptHookManager: {
        hooksOfType: vi.fn(() => []),
      },
    } as unknown as IpcDeps;

    const snapshot = await handlePluginBundleE2eSnapshot(
      deps,
      "orion-api",
      "lifecycle",
      "orion_api_read",
    );

    expect(snapshot).toMatchObject({
      ok: true,
      active: { generationId: "runtime-g1" },
      skill: { owner: { generationId: "runtime-g1" } },
      tools: [{ name: "orion_api_read_g1", generationId: "runtime-g1" }],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports orphaned Hook registry and matcher state without an active generation", async () => {
    const deps = {
      pluginBundleLifecycle: {
        acquire: vi.fn(async () => {
          throw new Error("plugin 'orion-api' has no active generation");
        }),
      },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: {
        hooksOfType: vi.fn(() => [{
          id: "plugin:orion-api:audit:orphan",
          event: "pre",
          matcher: "orion_api_*",
          command: ["node", "orphan.mjs"],
          source: "config",
          timeoutMs: 5_000,
          owner: {
            pluginId: "orion-api",
            pluginVersion: "1.0.0",
            activationId: "retired-runtime",
            generationId: "retired-artifact",
            localId: "audit",
            fingerprint: "f".repeat(64),
          },
        }]),
      },
    } as unknown as IpcDeps;

    await expect(handlePluginBundleE2eSnapshot(
      deps,
      "orion-api",
      "lifecycle",
      "orion_api_read",
    )).resolves.toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
      hooks: {
        registered: [{ id: "plugin:orion-api:audit:orphan" }],
        matchingPreToolUse: ["plugin:orion-api:audit:orphan"],
      },
    });
    expect(deps.skillStore!.loadPluginGeneration).not.toHaveBeenCalled();
    expect(deps.toolRegistry.listAll).not.toHaveBeenCalled();
  });

  it("rejects traversal-shaped plugin ids before reading Host state", async () => {
    const deps = {
      pluginBundleLifecycle: { acquire: vi.fn() },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: { hooksOfType: vi.fn() },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "../orion-api",
        "lifecycle",
        "orion_api_read",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-plugin-id" });
    expect(deps.pluginBundleLifecycle!.acquire).not.toHaveBeenCalled();
    expect(deps.skillStore!.loadPluginGeneration).not.toHaveBeenCalled();
    expect(deps.toolRegistry.listAll).not.toHaveBeenCalled();
    expect(deps.scriptHookManager!.hooksOfType).not.toHaveBeenCalled();
  });

  it("rejects invalid Hook probe tool names before reading Host state", async () => {
    const deps = {
      pluginBundleLifecycle: { acquire: vi.fn() },
      skillStore: { loadPluginGeneration: vi.fn() },
      toolRegistry: { listAll: vi.fn() },
      scriptHookManager: { hooksOfType: vi.fn() },
    } as unknown as IpcDeps;

    await expect(
      handlePluginBundleE2eSnapshot(
        deps,
        "orion-api",
        "lifecycle",
        "orion-api.read",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-hook-probe-tool-name" });
    expect(deps.pluginBundleLifecycle!.acquire).not.toHaveBeenCalled();
    expect(deps.scriptHookManager!.hooksOfType).not.toHaveBeenCalled();
  });
});
