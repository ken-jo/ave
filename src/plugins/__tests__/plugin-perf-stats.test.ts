import { afterEach, describe, it, expect } from "vitest";
import { rmSync } from "node:fs";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeRuntime(plugins: Record<string, Record<string, string>> = {}) {
  const fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-plugin-perf-" });
  const runtime = makeTestPluginRuntime(fixture);
  cleanups.push(async () => {
    await runtime.stopAll();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const entries = [];
  for (const [id, handlers] of Object.entries(plugins)) {
    const plugin = await writeTestPlugin(fixture, {
      id,
      tools: Object.keys(handlers),
      entrySource: makeTestPluginEntrySource(handlers),
    });
    entries.push({ id, manifestPath: plugin.manifestPath });
  }
  await writeTestPluginRegistry(fixture, entries);
  await runtime.startAll();
  return runtime;
}

describe("PluginRuntime.getPerfStats()", () => {
  it("returns empty record when no plugins are loaded", async () => {
    const rt = await makeRuntime();
    expect(rt.getPerfStats()).toEqual({});
  });

  it("records call count and exec time on success", async () => {
    const rt = await makeRuntime({ "perf-test": { test_ping: JSON.stringify("pong") } });

    await rt.call("test_ping");
    await rt.call("test_ping");

    const stats = rt.getPerfStats();
    expect(stats["perf-test"]).toBeDefined();
    expect(stats["perf-test"].toolCallCount).toBe(2);
    expect(stats["perf-test"].errorCount).toBe(0);
    expect(stats["perf-test"].totalExecMs).toBeGreaterThanOrEqual(0);
    expect(stats["perf-test"].lastCallAt).toBeTypeOf("number");
  });

  it("increments errorCount on handler throw", async () => {
    const rt = await makeRuntime({ "perf-test": { test_fail: '{ throw new Error("boom"); }' } });

    await expect(rt.call("test_fail")).rejects.toThrow("boom");

    const stats = rt.getPerfStats();
    expect(stats["perf-test"].toolCallCount).toBe(1);
    expect(stats["perf-test"].errorCount).toBe(1);
    expect(stats["perf-test"].totalExecMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks multiple plugins independently", async () => {
    const rt = await makeRuntime({
      "perf-alpha": { alpha_get: JSON.stringify("a") },
      "perf-beta": { beta_get: JSON.stringify("b") },
    });

    await rt.call("alpha_get");
    await rt.call("alpha_get");
    await rt.call("beta_get");

    const stats = rt.getPerfStats();
    expect(stats["perf-alpha"].toolCallCount).toBe(2);
    expect(stats["perf-beta"].toolCallCount).toBe(1);
  });

  it("returns a snapshot (mutations do not affect internal state)", async () => {
    const rt = await makeRuntime({ "perf-snap": { snap_get: "null" } });
    await rt.call("snap_get");

    const snap = rt.getPerfStats();
    snap["perf-snap"].toolCallCount = 999;

    const snap2 = rt.getPerfStats();
    expect(snap2["perf-snap"].toolCallCount).toBe(1);
  });
});
