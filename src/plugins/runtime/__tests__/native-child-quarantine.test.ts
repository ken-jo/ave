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
import { MxcProcessContractError } from "../../../permissions/mxc-extension-errors.js";
import { pluginFactoryDeadlineMs, pluginStopBudgetMs } from "../../isolation/out-of-process-plugin.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import type { PluginRuntime } from "../../runtime.js";

const spawnNativeChild = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: spawnNativeChild }));

const PLUGIN_ID = "nativequarantine";

/** One owned native process served by the real child runtime. Disposal settles when the test says, or,
 * with `disposeAfterMs`, verifies termination after that long. */
function ownedChild(disposeAfterMs?: number) {
  const hostToChild = new PassThrough(), childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  let failCompletion!: (error: Error) => void, finish!: (result: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => { finish = resolve; failCompletion = reject; });
  let rejectDisposal!: (error: Error) => void, resolveDisposal!: () => void;
  const disposal = new Promise<void>((resolve, reject) => { resolveDisposal = resolve; rejectDisposal = reject; });
  void disposal.catch(() => undefined);
  const dispose = vi.fn(() => {
    service.hostGone();
    if (disposeAfterMs !== undefined) setTimeout(resolveDisposal, disposeAfterMs);
    return disposal;
  });
  return {
    owned: { id: 4242, stdin: hostToChild, stdout: childToHost, stderr: new PassThrough(), completion, dispose,
      diagnostics: { nodeVersion: "", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" } },
    dispose, failCompletion, finish,
    failCleanup: () => rejectDisposal(new MxcProcessCleanupError("Termination unverified")),
  };
}

/** Route every lifecycle factory through the native arm, after the runtime's own admission checks. */
function routeNative(runtime: PluginRuntime, release: () => void, admitted: () => Promise<void> = async () => {}): void {
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
        prepareMxcChild: async (intent) => (await admitted(), {
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

  const PONG = `export default async function createPlugin() {
  return { handlers: { native_quarantine_ping: async () => "pong" } };
}`;

  it("restarts a healthy native child: verified exit releases its record and the next restart starts", async () => {
    await installPlugin(PONG);
    const children = [ownedChild(0), ownedChild(0), ownedChild(0)];
    spawnNativeChild.mockReset().mockImplementation(async () => children[spawnNativeChild.mock.calls.length - 1]!.owned);
    const release = vi.fn();
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release);
    await runtime.startAll();
    await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("started");
    // onTerminating → disposal resolves → onClosed → the incumbent's registration is released exactly once.
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(children[0]!.dispose).toHaveBeenCalledOnce();
    expect(spawnNativeChild).toHaveBeenCalledTimes(2);
    // Its record is gone, so a second restart is neither pending nor quarantined.
    await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("started");
    expect(spawnNativeChild).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    await expect(runtime.call("native_quarantine_ping")).resolves.toBe("pong");
  });

  it("does not quarantine a native stop whose disposal takes five seconds", async () => {
    await installPlugin(PONG);
    const children = [ownedChild(5_000), ownedChild(0), ownedChild(0)];
    spawnNativeChild.mockReset().mockImplementation(async () => children[spawnNativeChild.mock.calls.length - 1]!.owned);
    const release = vi.fn();
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release);
    await runtime.startAll();
    await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("started");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce(), { timeout: 15_000 });
    await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("started");
  }, 30_000);

  it("refuses to spawn when the incumbent faults after the replacement registered", async () => {
    await installPlugin(PONG);
    const incumbent = ownedChild();
    spawnNativeChild.mockReset().mockResolvedValue(incumbent.owned);
    const release = vi.fn();
    let admissions = 0;
    let admit!: () => void;
    const held = new Promise<void>((resolve) => { admit = resolve; });
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release, async () => { if (++admissions > 1) await held; });
    await runtime.startAll();
    const restarting = runtime.restartPlugin(PLUGIN_ID);
    // The replacement registered beside a healthy incumbent and is awaiting admission.
    await vi.waitFor(() => expect(admissions).toBe(2));
    incumbent.failCompletion(new Error("Supervisor stream fault"));
    await vi.waitFor(() => expect(incumbent.dispose).toHaveBeenCalledOnce());
    admit();
    // The synchronous pre-spawn recheck sees the terminating incumbent and refuses.
    await expect(restarting).resolves.toBe("failed");
    expect(spawnNativeChild).toHaveBeenCalledOnce();
    incumbent.failCleanup();
    await vi.waitFor(async () => {
      await expect(runtime.restartPlugin(PLUGIN_ID)).rejects.toMatchObject({ code: "plugin-lifecycle-quarantined" });
    });
    expect(spawnNativeChild).toHaveBeenCalledOnce();
    // Only the replacement's never-used launch lease is released; the incumbent's stays with its quarantine.
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses to publish a replacement once the incumbent is quarantined mid-construct, and reports failure", async () => {
    // The in-process child runtime shares this realm, so the replacement's construct can be held at a known point.
    const hook = globalThis as { __nativeConstructHook?: () => Promise<void> };
    await installPlugin(`export default async function createPlugin() {
  await globalThis.__nativeConstructHook?.();
  return { handlers: { native_quarantine_ping: async () => "pong" } };
}`);
    const incumbent = ownedChild(), replacement = ownedChild(0);
    spawnNativeChild.mockReset().mockResolvedValueOnce(incumbent.owned).mockResolvedValueOnce(replacement.owned);
    const release = vi.fn();
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime, release);
    await runtime.startAll();
    try {
      // Past both spawn rechecks: the incumbent faults and its disposal fails while the replacement constructs.
      hook.__nativeConstructHook = async () => {
        incumbent.failCompletion(new Error("Supervisor stream fault"));
        await vi.waitFor(() => expect(incumbent.dispose).toHaveBeenCalledOnce());
        incumbent.failCleanup();
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      await expect(runtime.restartPlugin(PLUGIN_ID)).resolves.toBe("failed");
      expect(spawnNativeChild).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(replacement.dispose).toHaveBeenCalledOnce());
      const card = runtime.listPluginCards().find((entry) => entry.id === PLUGIN_ID);
      expect(card?.loadStatus).toBe("failed");
      await expect(runtime.restartPlugin(PLUGIN_ID)).rejects.toMatchObject({ code: "plugin-lifecycle-quarantined" });
    } finally {
      delete hook.__nativeConstructHook;
    }
  });

  it("refuses a native launch that has no envelope registration to quarantine", () => {
    expect(() => createOutOfProcessPluginFactory({
      manifest: { id: PLUGIN_ID, name: "n", version: "1.0.0", entry: "entry.mjs", description: "d", tools: [] } as PluginManifest,
      launch: { kind: "entry", entryPath: join(testDir, "entry.mjs") },
      prepareMxcChild: async () => { throw new Error("never admitted"); },
    })).toThrow(MxcProcessContractError);
  });

  it("budgets a native factory and stop from the same policy as the owned process's deadlines", () => {
    const native = createOutOfProcessPluginFactory({
      manifest: { id: PLUGIN_ID, name: "n", version: "1.0.0", entry: "entry.mjs", description: "d", tools: [] } as PluginManifest,
      launch: { kind: "entry", entryPath: join(testDir, "entry.mjs") },
      registerSandboxEnvelope: () => ({ assertCurrent() {}, dispose() {}, quarantine() {}, terminating() {} }),
      prepareMxcChild: async () => { throw new Error("never admitted"); },
    });
    const legacy = createOutOfProcessPluginFactory({
      manifest: { id: PLUGIN_ID, name: "n", version: "1.0.0", entry: "entry.mjs", description: "d", tools: [] } as PluginManifest,
      launch: { kind: "entry", entryPath: join(testDir, "entry.mjs") },
    });
    const policy = TOOL_TIMEOUT_POLICY;
    // Startup, the construct request, then a refused bring-up's disposal all fit inside the factory deadline.
    expect(pluginFactoryDeadlineMs(native, policy.pluginFactoryMs)).toBeGreaterThanOrEqual(
      policy.windowsAclHostStartupMs + policy.pluginImportMs + policy.pluginFactoryMs + policy.windowsProcessTreeKillMs);
    expect(pluginFactoryDeadlineMs(legacy, policy.pluginFactoryMs)).toBe(policy.pluginFactoryMs);
    expect(pluginStopBudgetMs({ handlers: {} }, 2_000)).toBe(2_000);
  });
});
