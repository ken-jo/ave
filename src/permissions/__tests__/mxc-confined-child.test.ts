import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { liveEgressInvocationCount } from "../egress-invocations.js";
import { MxcProcessCleanupError, WorkerTransportUnsupportedError } from "../mxc-extension-errors.js";
import { drainMxcHolderLifetimes } from "../mxc-holder-lifetime.js";
import { planWindowsExtensionHolder } from "../mxc-extension-readiness.js";

const state = vi.hoisted(() => ({
  plan: { selectedBackend: "mxc", readiness: "ready" },
  spawn: vi.fn(), close: vi.fn(), admit: vi.fn(), validate: vi.fn(), allowed: vi.fn(), lease: vi.fn(),
}));
vi.mock("../asrt-sandbox.js", () => ({
  assertExtensionStartAllowed: () => state.allowed(), admitMxcExtensionFilesystem: (...args: unknown[]) => state.admit(...args),
  getDefaultSensitiveReadDenyPaths: () => ["C:\\private"], getDefaultSensitiveWriteDenyPaths: () => ["D:\\work\\.git"],
}));
vi.mock("../sandbox-capability.js", () => ({ getWindowsExtensionBackendPlan: () => state.plan }));
vi.mock("../egress-host-listener.js", () => ({ openMxcEgressLease: (...args: unknown[]) => state.lease(...args) }));
vi.mock("../mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: (...args: unknown[]) => state.spawn(...args) }));
vi.mock("../../main/managed-child-processes.js", () => ({ assertManagedChildProcessAdmissionOpen: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => true }));

import { spawnConfinedChild, spawnMxcConfinedChild, type MxcConfinedChildSpec } from "../confined-child.js";

function spec(): MxcConfinedChildSpec {
  return { label: "worker:sample", command: "C:\\runtime\\runtime.exe", args: ["D:\\work\\entry.js"],
    cwd: "D:\\work", home: "D:\\work\\home", temp: "D:\\work\\temp",
    allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work"],
    egressOwner: { kind: "worker", role: "worker", pluginId: "sample", instanceId: "main" },
    workerTransport: "stdio-control-v1", baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\local" },
    filesystemOwnership: { readRoots: [], writeRoots: [], hostStorageRoots: [] }, holder: Object.freeze({ incarnation: "main" }),
    probe: async () => ({ installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
      uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true,
      cleanTermination: true, ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
      forgedLabelsAttributed: true, noWorkerPort: true }),
  };
}
const ORIGINAL_PLATFORM = process.platform;
beforeEach(() => {
  setProcessPlatform("win32");
  vi.clearAllMocks();
  state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
    fallback: { version: "0.0.80", ready: false }, holderOrAncestorAdmitted: false });
  state.close.mockResolvedValue(undefined);
  state.lease.mockResolvedValue({ url: "http://127.0.0.1:43210", port: 43210, close: state.close });
  state.admit.mockReturnValue({ policy: { allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work"],
    denyRead: [], denyWrite: [], protectedFloor: [] }, assertStillValid: state.validate });
  state.spawn.mockImplementation(async (_request, options) => {
    const child = { id: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      completion: new Promise(() => {}), dispose: vi.fn().mockResolvedValue(undefined) };
    options.onOwned(child);
    options.beforeSpawn();
    return child;
  });
});
afterEach(() => setProcessPlatform(ORIGINAL_PLATFORM));

describe("native confined holder admission", () => {
  it("binds exactly one egress lease and releases only after owned termination", async () => {
    const before = liveEgressInvocationCount();
    const result = await spawnMxcConfinedChild(spec());
    expect(result.confinement).toBe("windows-mxc");
    expect(state.lease).toHaveBeenCalledTimes(1);
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(state.validate).toHaveBeenCalledTimes(3);
    expect(state.close).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(before + 1);
    await result.release();
    await result.release();
    expect(result.process.dispose).toHaveBeenCalledTimes(1);
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(liveEgressInvocationCount()).toBe(before);
    const [request] = state.spawn.mock.calls[0]!;
    expect(request.network.runtimeConfig).toEqual({ networkProxy: "http://127.0.0.1:43210" });
  });

  it("refuses unmigrated workers before any listener or native spawn", async () => {
    await expect(spawnMxcConfinedChild({ ...spec(), workerTransport: undefined })).rejects.toMatchObject({ code: "worker-transport-unsupported" });
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.lease).not.toHaveBeenCalled();
    expect(state.plan.selectedBackend).toBe("mxc");
  });

  it("refuses a legacy child adapter beneath an admitted container backend", async () => {
    await expect(spawnConfinedChild({ ...spec(), grantMode: "deny-only" })).rejects.toBeInstanceOf(WorkerTransportUnsupportedError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.lease).not.toHaveBeenCalled();
  });

  it.each(["checking", "rejected"])("refuses legacy starts while readiness is %s", async (readiness) => {
    state.plan = { selectedBackend: "none", readiness };
    await expect(spawnConfinedChild({ ...spec(), grantMode: "deny-only" })).rejects.toThrow("readiness");
    expect(state.lease).not.toHaveBeenCalled();
  });

  it("releases failed starts and never retries a selected backend", async () => {
    const before = liveEgressInvocationCount();
    state.spawn.mockRejectedValueOnce(new Error("native start failed"));
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow("native start failed");
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(state.close).toHaveBeenCalledOnce();
    expect(liveEgressInvocationCount()).toBe(before);
    expect(state.plan.selectedBackend).toBe("mxc");
  });

  it("stops a native process invalidated while startup was pending", async () => {
    const before = liveEgressInvocationCount();
    const validate = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error("holder revoked"); });
    await expect(spawnMxcConfinedChild({ ...spec(), assertStillValid: validate })).rejects.toThrow("holder revoked");
    const child = await state.spawn.mock.results[0]!.value;
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
    expect(liveEgressInvocationCount()).toBe(before);
  });

  it("retains a quarantined endpoint while native cleanup remains unverified", async () => {
    const before = liveEgressInvocationCount();
    const result = await spawnMxcConfinedChild(spec());
    vi.mocked(result.process.dispose).mockRejectedValue(new MxcProcessCleanupError("death unverified"));
    await expect(result.release()).rejects.toThrow("unverified");
    expect(state.close).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(before + 1);
    await expect(drainMxcHolderLifetimes()).rejects.toThrow("unverified");
    expect(state.close).not.toHaveBeenCalled();
    // Fixture teardown only: the real native primitive retains its cached failure.
    vi.mocked(result.process.dispose).mockResolvedValue(undefined);
    await drainMxcHolderLifetimes();
    expect(state.close).toHaveBeenCalledOnce();
    expect(liveEgressInvocationCount()).toBe(before);
  });

  it("binds descendants to a live parent and stops the tree before releasing its endpoint", async () => {
    const before = liveEgressInvocationCount();
    const parent = await spawnMxcConfinedChild(spec());
    const child = await spawnMxcConfinedChild({ ...spec(), parent });
    await parent.release();
    expect(parent.process.dispose).toHaveBeenCalledOnce();
    expect(child.process.dispose).toHaveBeenCalledOnce();
    expect(liveEgressInvocationCount()).toBe(before);
    await expect(spawnMxcConfinedChild({ ...spec(), parent })).rejects.toThrow("parent backend");
  });

  it("refuses an unrecognized parent even when the global backend is ready", async () => {
    const parent = { confinement: "windows-mxc", release: vi.fn() } as unknown as Awaited<ReturnType<typeof spawnMxcConfinedChild>>;
    await expect(spawnMxcConfinedChild({ ...spec(), parent })).rejects.toThrow("parent backend");
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("awaits an authorized but unpublished descendant before reporting parent termination", async () => {
    const before = liveEgressInvocationCount();
    const parent = await spawnMxcConfinedChild(spec());
    let authorized!: () => void, returnNative!: () => void, establishDeath!: () => void;
    const authorization = new Promise<void>((resolve) => { authorized = resolve; });
    const nativeReturned = new Promise<void>((resolve) => { returnNative = resolve; });
    const death = new Promise<void>((resolve) => { establishDeath = resolve; });
    state.spawn.mockImplementationOnce(async (_request, options) => {
      const child = { id: 43, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), dispose: vi.fn(() => death) };
      options.onOwned(child); options.beforeSpawn(); authorized();
      await nativeReturned;
      return child;
    });
    const pendingChild = spawnMxcConfinedChild({ ...spec(), parent }).then(() => null, (error: unknown) => error);
    await authorization;
    let parentReleased = false;
    const release = parent.release().then(() => { parentReleased = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(parentReleased).toBe(false);
    returnNative();
    await Promise.resolve(); await Promise.resolve();
    expect(parentReleased).toBe(false);
    establishDeath();
    expect(await pendingChild).toBeInstanceOf(Error);
    await release;
    expect(liveEgressInvocationCount()).toBe(before);
  });
});
