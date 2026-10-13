import { describe, expect, it } from "vitest";
import type { PluginRuntimeGenerationProjection } from "../../plugin-host-generation.js";
import type { PluginManifest } from "../../types.js";
import { PluginRuntime } from "../index.js";
import { createNoopHostApiForTests } from "../sandbox.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";

function manifest(pluginId: string, toolName: string): PluginManifest {
  return {
    id: pluginId,
    name: pluginId,
    version: "1.0.0",
    description: "concurrent publication fixture",
    entry: "entry.mjs",
    tools: [{ name: toolName, inputSchema: { type: "object", properties: {} } }],
  };
}

function projection(pluginId: string, toolName: string, digit: string): PluginRuntimeGenerationProjection {
  return {
    activationId: digit.repeat(64),
    installId: null,
    manifest: manifest(pluginId, toolName),
    pluginRoot: `/tmp/${pluginId}`,
    instance: { handlers: {} },
    methods: new Map([[toolName, async () => toolName]]),
    arm: "child",
    confinement: "unconfined",
  };
}

function runtimeFixture(): PluginRuntime {
  return new PluginRuntime({
    childEntryPath: pluginChildEntryPath(),
    encryption: unavailableSecretEncryption,
    hostRoot: "/tmp",
    createHostApi: createNoopHostApiForTests,
  });
}

describe("concurrent plugin generation publication", () => {
  it("keeps a plugin published while another plugin's generation was being prepared", () => {
    const runtime = runtimeFixture();
    const first = runtime.prepareRuntimeGeneration(projection("concurrent_first", "concurrent_first_tool", "1"), undefined);
    const second = runtime.prepareRuntimeGeneration(projection("concurrent_second", "concurrent_second_tool", "2"), undefined);

    first.publish();
    second.publish();

    expect(runtime.getPluginRoot("concurrent_first")).toBe("/tmp/concurrent_first");
    expect(runtime.getPluginRoot("concurrent_second")).toBe("/tmp/concurrent_second");
    expect([...runtime.getMethodMap().keys()].sort()).toEqual([
      "concurrent_first_tool",
      "concurrent_second_tool",
    ]);
  });

  it("keeps a removal published while another plugin's generation was being prepared", () => {
    const runtime = runtimeFixture();
    runtime.publishRuntimeGeneration(projection("concurrent_first", "concurrent_first_tool", "1"), undefined);
    const second = runtime.prepareRuntimeGeneration(projection("concurrent_second", "concurrent_second_tool", "2"), undefined);

    runtime.unpublishRuntimeGeneration("concurrent_first", "1".repeat(64));
    second.publish();

    expect(runtime.getPluginRoot("concurrent_first")).toBeUndefined();
    expect(runtime.getPluginRoot("concurrent_second")).toBe("/tmp/concurrent_second");
    expect([...runtime.getMethodMap().keys()]).toEqual(["concurrent_second_tool"]);
  });

  it("keeps a plugin published while another plugin's removal was being prepared", () => {
    const runtime = runtimeFixture();
    runtime.publishRuntimeGeneration(projection("concurrent_first", "concurrent_first_tool", "1"), undefined);
    const removal = runtime.prepareRuntimeRemoval("concurrent_first", "1".repeat(64));

    runtime.publishRuntimeGeneration(projection("concurrent_second", "concurrent_second_tool", "2"), undefined);
    removal.publish();

    expect(runtime.getPluginRoot("concurrent_first")).toBeUndefined();
    expect(runtime.getPluginRoot("concurrent_second")).toBe("/tmp/concurrent_second");
    expect([...runtime.getMethodMap().keys()]).toEqual(["concurrent_second_tool"]);
  });

  it("refuses a method another plugin published while this one was being prepared", () => {
    const runtime = runtimeFixture();
    const first = runtime.prepareRuntimeGeneration(projection("concurrent_first", "concurrent_shared_tool", "1"), undefined);
    const second = runtime.prepareRuntimeGeneration(projection("concurrent_second", "concurrent_shared_tool", "2"), undefined);

    first.publish();

    expect(() => second.publish()).toThrow("Duplicate plugin method registered: concurrent_shared_tool");
    expect(runtime.getPluginRoot("concurrent_second")).toBeUndefined();
    expect(runtime.getMethodMap().get("concurrent_shared_tool")?.pluginId).toBe("concurrent_first");
  });
});
