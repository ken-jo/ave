/** Boot, add, restart and reload must converge on the same registered runtime state. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

import { PluginRuntime } from "../runtime.js";
import { PluginPhase } from "../lifecycle-log.js";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

const PLUGIN_ID = "parity-plugin";
const TOOL = "parity_ping";

interface RegisteredState {
  listed: boolean;
  toolListed: boolean;
  callResult: unknown;
  hasPerfEntry: boolean;
  manifestTools: string[] | null;
}

async function captureState(rt: PluginRuntime): Promise<RegisteredState> {
  return {
    listed: rt.listPluginIds().includes(PLUGIN_ID),
    toolListed: rt.listToolNames().includes(TOOL),
    callResult: await rt.call(TOOL),
    hasPerfEntry: Boolean(rt.getPerfStats()[PLUGIN_ID]),
    manifestTools: rt.getPluginManifest(PLUGIN_ID)?.tools.map((t) => t.name) ?? null,
  };
}

const EXPECTED: RegisteredState = {
  listed: true,
  toolListed: true,
  callResult: "pong",
  hasPerfEntry: true,
  manifestTools: [TOOL],
};

describe("PluginRuntime instantiation parity", () => {
  let fixture: TestPluginRuntimeFixture;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-parity-" });
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: PLUGIN_ID,
      tools: [TOOL],
      entrySource: makeTestPluginEntrySource({ [TOOL]: JSON.stringify("pong") }),
    });
    await writeTestPluginRegistry(fixture, [
      { id: PLUGIN_ID, manifestPath, enabled: true },
    ]);
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("startAll (load path) and cold addPlugin reach the same registered state", async () => {
    const viaStartAll = makeTestPluginRuntime(fixture);
    await viaStartAll.startAll();
    const startState = await captureState(viaStartAll);

    const viaAddPlugin = makeTestPluginRuntime(fixture);
    await viaAddPlugin.addPlugin(PLUGIN_ID);
    const addState = await captureState(viaAddPlugin);

    expect(startState).toEqual(EXPECTED);
    expect(addState).toEqual(EXPECTED);
    expect(addState).toEqual(startState);
  });

  it("restartPlugin and reloadPlugin preserve the same registered state after startAll", async () => {
    const rt = makeTestPluginRuntime(fixture);
    await rt.startAll();
    const startState = await captureState(rt);

    await rt.restartPlugin(PLUGIN_ID);
    const restartState = await captureState(rt);

    await rt.reloadPlugin(PLUGIN_ID);
    const reloadState = await captureState(rt);

    expect(restartState).toEqual(EXPECTED);
    expect(reloadState).toEqual(EXPECTED);
    expect(restartState).toEqual(startState);
    expect(reloadState).toEqual(startState);
  });

  /** Missing runtime handlers must be skipped and reported on the structured plugin-phase stream on every activation path. */
  describe("missing-handler skip telemetry", () => {
    const DECLARED_ONLY = "parity_orphan";

    beforeEach(async () => {
      const { manifestPath } = await writeTestPlugin(fixture, {
        id: PLUGIN_ID,
        tools: [TOOL, DECLARED_ONLY],
        entrySource: makeTestPluginEntrySource({ [TOOL]: JSON.stringify("pong") }),
      });
      await writeTestPluginRegistry(fixture, [
        { id: PLUGIN_ID, manifestPath, enabled: true },
      ]);
    });

    function skipRecords(
      warn: { mock: { calls: unknown[][] } },
    ): unknown[] {
      return warn.mock.calls
        .flat()
        .filter((arg): arg is Record<string, unknown> =>
          typeof arg === "object"
          && arg !== null
          && (arg as Record<string, unknown>).phase === PluginPhase.REGISTER_TOOL_SKIP);
    }

    const EXPECTED_SKIP = {
      pluginId: PLUGIN_ID,
      phase: PluginPhase.REGISTER_TOOL_SKIP,
      toolName: DECLARED_ONLY,
      reason: "missing_handler",
    };

    it("startAll reports the skip on the plugin-phase stream", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const rt = makeTestPluginRuntime(fixture);
        await rt.startAll();
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("addPlugin reports the skip on the same stream, not as an untagged string", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const rt = makeTestPluginRuntime(fixture);
        await rt.addPlugin(PLUGIN_ID);
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("restartPlugin reports the skip on the same stream", async () => {
      const rt = makeTestPluginRuntime(fixture);
      await rt.startAll();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await rt.restartPlugin(PLUGIN_ID);
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
