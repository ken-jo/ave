// A contained worker under a real row-2 plugin child parent: the plugin child adapter, the worker route, the holder
// adapter and row 2 run for real; only admission ranking input, the egress lease and the native process are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const state = vi.hoisted(() => ({ plan: undefined as unknown, holdCompletion: false, denyWrite: [] as string[],
  natives: [] as Array<{ label: string; dispose: ReturnType<typeof vi.fn> }> }));
// A real staging parent of this suite's own: the runtime root's is shared by every suite of a run.
vi.mock("../mxc-runtime-root.js", async (original) => ({
  ...await original<typeof import("../mxc-runtime-root.js")>(),
  mxcStagingParent: (await import("../../__tests__/support/mxc-staging-parent.js")).suiteMxcStagingParent,
}));
vi.mock("../asrt-sandbox.js", async (original) => {
  const { mxcPolicyModel } = await import("../../__tests__/support/mxc-policy-rows.js");
  return {
  ...await original<typeof import("../asrt-sandbox.js")>(),
  assertExtensionStartAllowed: () => {},
  runWithSandboxWritePreflight: async (_signal: AbortSignal | undefined, compose: () => unknown) => compose(),
  getDefaultSensitiveReadDenyPaths: () => [], getDefaultSensitiveWriteDenyEntries: () => [],
  admitMxcExtensionFilesystem: (request: { allowRead: string[]; allowWrite: string[] }) => ({
    model: mxcPolicyModel({ allowRead: request.allowRead, allowWrite: request.allowWrite, denyRead: [], denyWrite: state.denyWrite, protectedFloor: [] }),
    assertStillValid: () => {},
  }),
  };
});
vi.mock("../sandbox-capability.js", async (original) => ({
  ...await original<typeof import("../sandbox-capability.js")>(),
  getWindowsExtensionBackendPlan: () => state.plan,
}));
vi.mock("../workspace-authorized-roots.js", () => ({ listAuthorizedWorkspaceRoots: () => [] }));
vi.mock("../egress-host-listener.js", () => ({
  openMxcEgressLease: async () => ({ url: "http://127.0.0.1:43210", port: 43210, close: async () => {} }),
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: () => {},
  trackManagedChildProcess: () => () => {},
}));
vi.mock("../mxc-extension-process.js", () => ({
  spawnMxcExtensionProcess: async (request: { command: string }, options: { onOwned(owned: unknown): void; beforeSpawn(): void }) => {
    let finish!: (result: { exitCode: number; timedOut: boolean }) => void;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const native = {
      id: 4000 + state.natives.length, stdin: new PassThrough(), stdout, stderr,
      completion: new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => { finish = resolve; }),
      diagnostics: { nodeVersion: "v0", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "owner" },
      dispose: vi.fn(async () => {
        if (state.holdCompletion) return;
        stdout.end(); stderr.end(); finish({ exitCode: 0, timedOut: false });
      }),
    };
    state.natives.push({ label: request.command, dispose: native.dispose });
    options.onOwned(native);
    options.beforeSpawn();
    return native;
  },
}));

const { planWindowsExtensionHolder } = await import("../mxc-extension-readiness.js");
const { drainMxcHolderLifetimes, liveMxcPluginChildHolder } = await import("../mxc-holder-lifetime.js");
const { registerMxcHolderReadinessProbe } = await import("../../sandbox/wrap-bundled-command.js");
const { prepareMxcPluginChildLaunch } = await import("../../plugins/isolation/mxc-plugin-child-launch.js");
const { spawnMxcPluginChild } = await import("../../plugins/isolation/mxc-plugin-child.js");
const { resolvePluginPaths } = await import("../../plugins/plugin-paths.js");
const { aveHome } = await import("../../shared/ave-home.js");
const { suiteMxcStagingParent } = await import("../../__tests__/support/mxc-staging-parent.js");
const { buildSafeChildEnv } = await import("../../tools/safe-env.js");
const { __resetActiveWrappedWorkersForTest, spawnWorker } = await import("../worker-spawn.js");

const PLUGIN = "example-plugin";
const EVIDENCE = { installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
  uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true,
  cleanTermination: true, ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true };

describe.skipIf(process.platform !== "win32")("contained worker under a real plugin child parent", () => {
  let unregisterProbe: () => void = () => {};
  const pluginRoot = (): string => join(resolvePluginPaths().pluginsRoot, PLUGIN);
  const dataDir = (): string => join(pluginRoot(), "data");
  const work = (): string => join(aveHome(), "..", "native-parent-work");
  const stagingEntries = (): string[] => {
    return readdirSync(suiteMxcStagingParent());
  };

  beforeEach(() => {
    state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: { version: "0.0.80", ready: false } });
    state.natives.length = 0;
    state.holdCompletion = false;
    state.denyWrite = [];
    __resetActiveWrappedWorkersForTest();
    unregisterProbe = registerMxcHolderReadinessProbe(async () => EVIDENCE as never);
    for (const dir of [join(pluginRoot(), "gen"), join(dataDir(), "cache"), join(dataDir(), "models"), join(pluginRoot(), "socket"), work()]) {
      mkdirSync(dir, { recursive: true });
    }
  });
  afterEach(async () => {
    await drainMxcHolderLifetimes();
    unregisterProbe();
    rmSync(work(), { recursive: true, force: true });
  });

  const startPluginChild = async () => {
    const gen = join(pluginRoot(), "gen");
    const intent = { pluginId: PLUGIN, command: process.execPath, args: [join(gen, "entry.js")], cwd: gen, pluginDataDir: dataDir(),
      baseEnv: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      envelope: { read: [gen, dataDir(), join(pluginRoot(), "socket")], write: [dataDir(), join(pluginRoot(), "socket")] } };
    const launch = await prepareMxcPluginChildLaunch(intent);
    return spawnMxcPluginChild(launch, { ...intent, floorPierces: [] });
  };
  const startWorker = (grants: { read?: string[]; write?: string[]; stateDirectory?: boolean } = {}) => spawnWorker({
    pluginId: PLUGIN, workerId: "indexer", command: process.execPath, control: "output-only-v1",
    allowReadPaths: grants.read ?? [work()], allowWritePaths: grants.write ?? [work()],
    ...(grants.stateDirectory === true ? { stateDirectory: true } : {}),
  });

  it("refuses a worker whose declared grants nest with its parent's writable roots, before anything is created", async () => {
    const child = await startPluginChild();
    const staged = stagingEntries();
    for (const grants of [{ write: [join(dataDir(), "cache")] }, { read: [join(dataDir(), "models")] }, { write: [pluginRoot()] }]) {
      await expect(startWorker(grants)).rejects.toThrow("refusing a container grant that nests with its plugin's container process");
    }
    expect(state.natives).toHaveLength(1);
    expect(stagingEntries()).toEqual(staged);
    child.link.terminate("stop");
    await child.waitForExit();
  });

  it("refuses a worker once its parent is gone, binds a later one to the replacement, and ends it with that parent", async () => {
    const first = await startPluginChild();
    first.link.terminate("stop");
    await first.waitForExit();
    await expect(startWorker()).rejects.toThrow("refusing a container worker whose plugin has no live container process");
    expect(state.natives).toHaveLength(1);

    const replacement = await startPluginChild();
    const worker = await startWorker();
    const exited = new Promise<unknown>((resolve) => { worker.onExit(resolve); });
    expect(state.natives).toHaveLength(3);
    const workerNative = state.natives[2];
    if (workerNative === undefined) throw new Error("the worker reached no native process");
    expect(workerNative.dispose).not.toHaveBeenCalled();
    replacement.link.terminate("stop");
    await replacement.waitForExit();
    expect(workerNative.dispose).toHaveBeenCalled();
    await exited;
  });


  it("refuses a delegated worker widened to its parent's data root once a floor deny lies under it, before its state dir exists", async () => {
    // Production floor denies under a writable root reach the parent's footprint through row 2's denied grants.
    state.denyWrite = [join(dataDir(), ".git")];
    const child = await startPluginChild();
    const stateDir = join(pluginRoot(), "workers", "indexer");
    await expect(startWorker({ read: [dataDir()], write: [dataDir()], stateDirectory: true }))
      .rejects.toThrow("refusing a container grant that nests with its plugin's container process");
    expect(existsSync(stateDir)).toBe(false);
    expect(state.natives).toHaveLength(1);
    child.link.terminate("stop");
    await child.waitForExit();

    // Control: the same equal-root grant is admitted when no deny lies under the parent's root.
    state.denyWrite = [];
    const replacement = await startPluginChild();
    const worker = await startWorker({ read: [dataDir()], write: [dataDir()], stateDirectory: true });
    const exited = new Promise<unknown>((resolve) => { worker.onExit(resolve); });
    expect(state.natives).toHaveLength(3);
    replacement.link.terminate("stop");
    await replacement.waitForExit();
    await exited;
  });
  it("treats a parent row 2 has released as gone, though its adapter never reported termination", async () => {
    await startPluginChild();
    const parent = liveMxcPluginChildHolder(PLUGIN);
    if (parent === undefined) throw new Error("the plugin child published no parent");
    // Release reported by row 2 alone: no exit reaches the adapter, so its withdrawal never runs.
    state.holdCompletion = true;
    await parent.release();
    await expect(startWorker()).rejects.toThrow("refusing a container worker whose plugin has no live container process");
    expect(liveMxcPluginChildHolder(PLUGIN)).toBeUndefined();
    expect(state.natives).toHaveLength(1);
  });
});
