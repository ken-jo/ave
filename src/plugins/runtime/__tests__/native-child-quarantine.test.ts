/** End to end through the runtime, the real out-of-process factory and the real envelope registration:
 * a native plugin child whose termination is unverified quarantines before any second spawn or replacement. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { makeTestPluginRuntime, servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";
import { createMxcExtensionRequest } from "../../../__tests__/support/mxc-supervisor.js";
import { MxcProcessCleanupError } from "../../../permissions/mxc-extension-errors.js";
import { createOutOfProcessPluginFactory } from "../../isolation/out-of-process-plugin.js";
import { servePluginChild } from "../../isolation/plugin-child-main.js";
import { windowsCommandLine } from "../../../shared/windows-command-line.js";
import type { PluginManifest } from "../../types.js";
import type { PluginRuntime } from "../../runtime.js";

const spawnNativeChild = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: spawnNativeChild }));

const PLUGIN_ID = "nativequarantine";

/** One owned native process served by the real child runtime, with disposal the test settles. */
function ownedChild() {
  const hostToChild = new PassThrough(), childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  let failCompletion!: (error: Error) => void, finish!: (result: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => { finish = resolve; failCompletion = reject; });
  let rejectDisposal!: (error: Error) => void;
  const disposal = new Promise<void>((_resolve, reject) => { rejectDisposal = reject; });
  void disposal.catch(() => undefined);
  const dispose = vi.fn(() => { service.hostGone(); return disposal; });
  return {
    owned: { id: 4242, stdin: hostToChild, stdout: childToHost, stderr: new PassThrough(), completion, dispose,
      diagnostics: { nodeVersion: "", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" } },
    dispose, failCompletion, finish,
    failCleanup: () => rejectDisposal(new MxcProcessCleanupError("Termination unverified")),
  };
}

/** Route every lifecycle factory through the native arm, after the runtime's own admission checks. */
function routeNative(runtime: PluginRuntime, release: () => void): void {
  const routing = runtime as unknown as {
    importPluginFactoryForLifecycle(...args: unknown[]): Promise<{ createPlugin: unknown; arm: string }>;
    registerSandboxEnvelope(pluginId: string, paths: readonly string[], pluginRoot: string, pluginDataDir: string): never;
  };
  const original = routing.importPluginFactoryForLifecycle.bind(routing);
  vi.spyOn(routing, "importPluginFactoryForLifecycle").mockImplementation(async (...args: unknown[]) => {
    await original(...args);
    const [, source, manifest] = args as [string, { resolvedEntryPath: string }, PluginManifest];
    return {
      arm: "child",
      createPlugin: createOutOfProcessPluginFactory({
        manifest,
        launch: { kind: "entry", entryPath: source.resolvedEntryPath },
        registerSandboxEnvelope: (paths, pluginRoot, pluginDataDir) =>
          routing.registerSandboxEnvelope(manifest.id, paths, pluginRoot, pluginDataDir),
        prepareMxcChild: async (intent) => ({
          request: { ...createMxcExtensionRequest(), command: windowsCommandLine(intent.command, intent.args), workingDirectory: intent.cwd },
          signal: new AbortController().signal, assertCurrent() {}, release,
        }),
      }),
    };
  });
}

describe("native plugin child quarantine through the runtime", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-native-quarantine-"));
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  async function installPlugin(entry: string): Promise<void> {
    const pluginDir = join(installedDir, PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), entry, "utf-8");
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedAgentPluginsDocument({
      id: PLUGIN_ID, name: "Native Quarantine", version: "1.0.0", entry: "entry.mjs",
      tools: [{ name: "native_quarantine_ping", description: "Native quarantine ping tool", inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "Native quarantine regression.",
    })), "utf-8");
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{ id: PLUGIN_ID, manifestPath, enabled: true }] }), "utf-8");
  }

  it("holds a bring-up failure until termination is known, then refuses a second spawn", async () => {
    await installPlugin(`export default async function createPlugin() { throw new Error("construct refused"); }`);
    const child = ownedChild();
    spawnNativeChild.mockReset().mockResolvedValue(child.owned);
    const release = vi.fn();
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release);
    let settled = false;
    const starting = runtime.startAll().then(() => { settled = true; });
    await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce());
    // The construct refusal has arrived, but the runtime is not told until termination is established.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    child.failCleanup();
    await starting;
    expect(runtime.listPluginIds()).not.toContain(PLUGIN_ID);
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toMatchObject({ code: "plugin-lifecycle-quarantined" });
    expect(spawnNativeChild).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("refuses a make-before-break replacement while a faulted incumbent is terminating, then quarantines", async () => {
    await installPlugin(`export default async function createPlugin() {
  return { handlers: { native_quarantine_ping: async () => "pong" } };
}`);
    const child = ownedChild();
    spawnNativeChild.mockReset().mockResolvedValue(child.owned);
    const release = vi.fn();
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release);
    await runtime.startAll();
    await expect(runtime.call("native_quarantine_ping")).resolves.toBe("pong");
    // A runtime fault: the supervisor stream fails. Disposal starts but never reaches the session's onClosed.
    child.failCompletion(new Error("Supervisor stream fault"));
    await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce());
    // Within the disposal window the incumbent's termination is pending: no replacement spawns beside it.
    await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("failed");
    expect(spawnNativeChild).toHaveBeenCalledOnce();
    child.failCleanup();
    // The rejected exit quarantines at once, without any stop or onClosed.
    await vi.waitFor(async () => {
      await expect(runtime.restartPlugin(PLUGIN_ID)).rejects.toMatchObject({ code: "plugin-lifecycle-quarantined" });
    });
    expect(spawnNativeChild).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });
});
