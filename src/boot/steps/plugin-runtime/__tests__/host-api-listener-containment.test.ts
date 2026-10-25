import { createBootHostFixture, stationaryLeaseState } from "../../../../__tests__/support/host-runtime.js";
/** Async config-listener failures must be handled at the producer boundary to avoid process-wide unhandled rejections. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApiFactory } from "../host-api-factory.js";
import { HostApiGenerationScope } from "../../../../plugins/plugin-host-effect-scope.js";
import { admittedGenerationAccess, pluginDataDirIn } from "../../../../plugins/__tests__/test-helpers.js";
import type { PluginHostApiIncarnation } from "../../../../plugins/runtime/index.js";
import type { PluginManifest } from "../../../../plugins/types.js";
import {
  emitPluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../../../../plugins/config-change-bus.js";

const PLUGIN_ID = "sampleassistant";
const GENERATION_ID = "generation-under-test";

const MANIFEST = {
  id: PLUGIN_ID,
  name: "Sample Assistant",
  version: "0.10.14",
  entry: "plugin.mjs",
  description: "subscribes to one config key",
  tools: [],
} as unknown as PluginManifest;

/** Provide only dependencies this path touches so the fixture exposes its actual boundary. */
function hostApiUnderTest(pluginDataDir: string): {
  api: ReturnType<ReturnType<typeof createHostApiFactory>>;
  scope: HostApiGenerationScope;
} {
  const scope = new HostApiGenerationScope(PLUGIN_ID);
  const incarnation: PluginHostApiIncarnation = {
    registerDisposer: () => undefined,
    trackOperation: <T>(operation: Promise<T>) => operation,
    isActive: () => true,
    isLifecycleHookActive: () => true,
    generationScope: scope,
  };
  const factory = createHostApiFactory({
    host: createBootHostFixture(),
    getPluginRuntime: () => ({
      getApprovedPluginAccess: () => undefined,
      listPluginIds: () => [PLUGIN_ID],
      getWildcardConfigOverride: () => ({}),
      isShuttingDown: () => false,
    }),
    lateBinding: {},
    getRegistryEntry: () => undefined,
    hostClassifiesRiskEnabled: () => true,
    pluginShutdownHandlers: [],
    readAppPreference: () => undefined,
    settingsService: {
        ...stationaryLeaseState, getPluginConfig: () => ({}) },
    bootAuditLogger: { log: () => undefined },
    pluginRuntimeAuditLog: () => undefined,
    networkFetch: (() => { throw new Error("not used"); }) as unknown as typeof fetch,
    mainWindow: {},
    openAuthWindowService: async () => [],
    openLinkWindowService: async () => undefined,
    openAuthPartitionViewerService: async () => undefined,
    clearAuthPartitionService: async () => undefined,
    shellOpenExternal: async () => undefined,
    approvalGate: {},
    routinesStore: {},
    getAlertsService: () => undefined,
  } as never);
  const api = factory(PLUGIN_ID, MANIFEST, pluginDataDir, incarnation, null, undefined, null);
  scope.bindGeneration(admittedGenerationAccess(GENERATION_ID), GENERATION_ID);
  scope.publish();
  return { api, scope };
}

let temporaryRoot: string | undefined;

beforeEach(() => {
  _resetPluginConfigChangeBus();
  temporaryRoot = mkdtempSync(join(tmpdir(), "host-api-listener-"));
});

afterEach(() => {
  _resetPluginConfigChangeBus();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("a config.onChange listener that throws, on the real host member", () => {
  it("is reported and contained rather than left for the process", async () => {
    const { api } = hostApiUnderTest(pluginDataDirIn(temporaryRoot!));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      api.config.onChange("apiKey", () => {
        // Use the out-of-process callback shape, which rejects values JSON cannot carry.
        throw new Error("value cannot cross the boundary");
      });
      emitPluginConfigChange(PLUGIN_ID, "apiKey", new Date());
      // Await a macrotask; unhandled rejections are reported after microtasks drain.
      await new Promise((settle) => setTimeout(settle, 20));
      expect(unhandled).toEqual([]);
      expect(
        warn.mock.calls.some((call) =>
          call.some((argument) =>
            typeof argument === "string" && argument.includes("host listener failed"),
          ),
        ),
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });

  it("keeps delivering to the listeners that did not throw", async () => {
    const { api } = hostApiUnderTest(pluginDataDirIn(temporaryRoot!));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const delivered: unknown[] = [];
    try {
      api.config.onChange("apiKey", () => {
        throw new Error("value cannot cross the boundary");
      });
      api.config.onChange("apiKey", (value) => { delivered.push(value); });
      emitPluginConfigChange(PLUGIN_ID, "apiKey", "plain-text");
      await new Promise((settle) => setTimeout(settle, 20));
      expect(delivered).toEqual(["plain-text"]);
    } finally {
      warn.mockRestore();
    }
  });
});
