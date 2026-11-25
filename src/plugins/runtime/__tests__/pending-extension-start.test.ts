vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** A plugin child that nothing confines waits in the pending list; a yes re-adds the plugin with that one consent. */
import { afterEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({ specs: [] as Array<{ takeExtensionStart?: () => unknown }> }));

vi.mock("../../isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isolation/out-of-process-plugin.js")>();
  return {
    ...actual,
    createOutOfProcessPluginFactory: (spec: Parameters<typeof actual.createOutOfProcessPluginFactory>[0]) => {
      factory.specs.push(spec);
      return async () => ({ handlers: {} });
    },
  };
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime, createNoopHostApiForTests } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, ExtensionStartConsentRequiredError, listPendingExtensionStarts,
  pluginChildStartKey, setExtensionStartAsker, settlePendingExtensionStarts,
} from "../../../permissions/extension-start-consent.js";

const PLUGIN_ID = "pendingstartfixture";
const KEY = pluginChildStartKey(PLUGIN_ID);
const MANIFEST: PluginManifest = {
  id: PLUGIN_ID, name: "Pending Start Fixture", version: "1.0.0", entry: "plugin.mjs",
  description: "a plugin whose child start waits for a person", requires: { hostProtocol: "5" }, tools: [],
};
const ATTENDED = { sessionId: "s1", attended: true };

interface RuntimeInternals {
  importPluginFactoryForLifecycle(pluginId: string, source: { kind: "entry"; resolvedEntryPath: string }, manifest: PluginManifest, verified: undefined): Promise<unknown>;
  reportAttemptFactoryFailure(manifest: PluginManifest, error: unknown, attempt: object): void;
  recordAttemptRefusal(manifest: PluginManifest, error: unknown, attempt: string): boolean;
}

function runtime(): PluginRuntime {
  return new PluginRuntime({
    encryption: unavailableSecretEncryption,
    childEntryPath: pluginChildEntryPath(),
    hostRoot: "/tmp/ave-pending-extension-start",
    manifestPaths: [],
    createHostApi: createNoopHostApiForTests,
  });
}

afterEach(() => {
  __resetExtensionStartsForTest();
  factory.specs.length = 0;
});

describe("a plugin child start that nothing confines", () => {
  it("queues the failed load and re-adds the plugin after a yes", async () => {
    const subject = runtime();
    const addPlugin = vi.spyOn(subject, "addPlugin").mockResolvedValue("started");
    (subject as unknown as RuntimeInternals).reportAttemptFactoryFailure(MANIFEST, new ExtensionStartConsentRequiredError("no-backend"), {});
    expect(listPendingExtensionStarts()).toMatchObject([{ key: KEY, kind: "plugin-child", label: "Pending Start Fixture", cause: "no-backend", state: "pending" }]);
    expect(addPlugin).not.toHaveBeenCalled();

    setExtensionStartAsker({ ask: async () => "yes", notify: vi.fn() });
    await settlePendingExtensionStarts(ATTENDED);
    expect(addPlugin).toHaveBeenCalledExactlyOnceWith(PLUGIN_ID);
  });

  it("queues a refused replacement too, and keeps it a failure of that attempt", () => {
    const subject = runtime();
    expect((subject as unknown as RuntimeInternals).recordAttemptRefusal(MANIFEST, new ExtensionStartConsentRequiredError("home-privacy-unverified"), "restart")).toBe(false);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: KEY, cause: "home-privacy-unverified" }]);
  });

  it("queues nothing for any other factory failure", () => {
    (runtime() as unknown as RuntimeInternals).reportAttemptFactoryFailure(MANIFEST, new Error("child crashed"), {});
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("hands the child factory the consent waiting for this plugin, once", async () => {
    await (runtime() as unknown as RuntimeInternals).importPluginFactoryForLifecycle(
      PLUGIN_ID, { kind: "entry", resolvedEntryPath: join(tmpdir(), "no-such-plugin-entry.mjs") }, MANIFEST, undefined);
    const take = factory.specs[0]?.takeExtensionStart ?? (() => "no factory spec");
    expect(take()).toBeUndefined();
    const taken: unknown[] = [];
    deferExtensionStart({ key: KEY, kind: "plugin-child", label: PLUGIN_ID, cause: "no-backend", retry: async () => { taken.push(take(), take()); } });
    setExtensionStartAsker({ ask: async () => "yes", notify: vi.fn() });
    await settlePendingExtensionStarts(ATTENDED);
    expect(taken).toEqual([expect.objectContaining({ key: KEY }), undefined]);
  });
});
