import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { liveEgressInvocationCount } from "../egress-invocations.js";
import { MxcNativeEntryRequiredError, MxcProcessCleanupError, WorkerTransportUnsupportedError } from "../mxc-extension-errors.js";
import { drainMxcHolderLifetimes } from "../mxc-holder-lifetime.js";
import { planWindowsExtensionHolder } from "../mxc-extension-readiness.js";

const state = vi.hoisted(() => ({
  plan: { selectedBackend: "mxc", readiness: "ready" },
  realPlan: false,
  executableStamp: 1n,
  spawn: vi.fn(), close: vi.fn(), admit: vi.fn(), validate: vi.fn(), allowed: vi.fn(), lease: vi.fn(),
}));
vi.mock("../asrt-sandbox.js", () => ({
  assertExtensionStartAllowed: () => state.allowed(), admitMxcExtensionFilesystem: (...args: unknown[]) => state.admit(...args),
  getDefaultSensitiveReadDenyPaths: () => ["C:\\private"], getDefaultSensitiveWriteDenyPaths: () => ["D:\\work\\.git"],
  appOwnedSandboxHomeRoot: () => "C:\\ave\\sandbox\\home", appOwnedSandboxTempRoot: () => "C:\\ave\\sandbox\\temp",
  appOwnedTerminalHandoffRoot: () => "C:\\ave\\sandbox\\handoff",
}));
vi.mock("../sandbox-capability.js", async (original) => {
  const actual = await original<typeof import("../sandbox-capability.js")>();
  return { ...actual, getWindowsExtensionBackendPlan: () => state.realPlan ? actual.getWindowsExtensionBackendPlan() : state.plan };
});
vi.mock("../egress-host-listener.js", () => ({ openMxcEgressLease: (...args: unknown[]) => state.lease(...args) }));
vi.mock("../mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: (...args: unknown[]) => state.spawn(...args) }));
vi.mock("../../main/managed-child-processes.js", () => ({ assertManagedChildProcessAdmissionOpen: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  // Synthetic Windows paths: canonical spelling is the lexical one, and the executable's file identity is a fixture stamp.
  const realpathSync = Object.assign((path: string) => path, { native: (path: string) => path });
  const statSync = (_path: string) => ({ isFile: () => true, dev: 7n, ino: 11n, size: 4096n,
    mtimeNs: state.executableStamp, ctimeNs: state.executableStamp, birthtimeNs: 1n });
  return { ...actual, existsSync: () => true, realpathSync, statSync };
});

import { spawnConfinedChild, spawnMxcConfinedChild, type MxcConfinedChildSpawn, type MxcConfinedChildSpec } from "../confined-child.js";
import { __resetWindowsSandboxSubstrateForTest, setWindowsSandboxSubstrate } from "../sandbox-capability.js";
import { mxcShellCapability, windowsSubstrateFor, type WindowsSandboxPlanInputs } from "../../boot/steps/windows-sandbox-plan.js";

function spec(): MxcConfinedChildSpec {
  return { label: "worker:sample", command: "C:\\runtime\\runtime.exe", args: ["D:\\work\\entry.js"],
    cwd: "D:\\work", home: "D:\\work\\home", temp: "D:\\work\\temp",
    allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work"],
    egressOwner: { kind: "worker", role: "worker", pluginId: "sample", instanceId: "main" },
    workerTransport: "stdio-control-v1", baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\local" },
    filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work"], hostStorageRoots: [] }, holder: Object.freeze({ incarnation: "main" }),
    probe: async () => ({ installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
      uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true,
      cleanTermination: true, ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
      forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true }),
  };
}

// A descendant laid out as a sibling of its parent's writable root, as rows 3-5 must do.
function siblingChild(parent: MxcConfinedChildSpawn, root = "D:\\child"): MxcConfinedChildSpec {
  return { ...spec(), parent, cwd: root, home: `${root}\\home`, temp: `${root}\\temp`, allowWrite: [root],
    filesystemOwnership: { readRoots: [], writeRoots: [root], hostStorageRoots: [] }, holder: Object.freeze({ incarnation: root }) };
}
function admitWrites(...allowWrite: string[]): void {
  state.admit.mockReturnValueOnce({ policy: { allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite,
    denyRead: [], denyWrite: [], protectedFloor: [] }, assertStillValid: state.validate });
}
const ORIGINAL_PLATFORM = process.platform;
beforeEach(() => {
  setProcessPlatform("win32");
  vi.clearAllMocks();
  state.realPlan = false;
  state.executableStamp = 1n;
  state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
    fallback: { version: "0.0.80", ready: false } });
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
afterEach(async () => {
  // Release every holder a test left owned so its writable roots do not constrain the next test.
  await drainMxcHolderLifetimes();
  __resetWindowsSandboxSubstrateForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

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
    admitWrites("D:\\child");
    const child = await spawnMxcConfinedChild(siblingChild(parent));
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
    admitWrites("D:\\child");
    const pendingChild = spawnMxcConfinedChild(siblingChild(parent)).then(() => null, (error: unknown) => error);
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

  it("refuses a legacy plugin-child adapter with the holder-neutral native-entry error", async () => {
    const pluginOwner = { kind: "plugin", role: "child", pluginId: "sample", instanceId: "main" } as unknown as MxcConfinedChildSpec["egressOwner"];
    await expect(spawnConfinedChild({ ...spec(), egressOwner: pluginOwner, grantMode: "deny-only" }))
      .rejects.toBeInstanceOf(MxcNativeEntryRequiredError);
    expect(state.lease).not.toHaveBeenCalled();
  });
});

describe("plan identity across substrate republication", () => {
  const inputs: WindowsSandboxPlanInputs = { shellRequested: true, workerRequested: true, mxc: { state: "checking" },
    extensionMxc: { state: "available" }, windowsBuild: "26100", srtWinReady: false };

  it.each(["available", "unavailable"] as const)("lets a live MXC parent admit children after the shell probe settles %s", async (settledState) => {
    state.realPlan = true;
    const first = windowsSubstrateFor(inputs, "proxy-only");
    setWindowsSandboxSubstrate(first);
    const parent = await spawnMxcConfinedChild(spec());
    const settled = windowsSubstrateFor({ ...inputs, mxc: settledState === "available" ? { state: "available" } : { state: "unavailable", reason: "probe-failed" } }, "proxy-only");
    setWindowsSandboxSubstrate(settled, settled.shells === "mxc" ? mxcShellCapability() : undefined);
    admitWrites("D:\\child");
    const child = await spawnMxcConfinedChild(siblingChild(parent));
    expect(child.confinement).toBe("windows-mxc");
    await parent.release();
  });

  it("still refuses a child once the plan content actually changes", async () => {
    state.realPlan = true;
    setWindowsSandboxSubstrate(windowsSubstrateFor(inputs, "proxy-only"));
    const parent = await spawnMxcConfinedChild(spec());
    // A content change is a new selection: the old tree may not grow under it.
    setWindowsSandboxSubstrate(windowsSubstrateFor({ ...inputs, extensionMxc: { state: "unavailable", reason: "runtime-start-failed" } }, "proxy-only"));
    await expect(spawnMxcConfinedChild(siblingChild(parent))).rejects.toThrow(/not ready|has not admitted|no longer admitted/);
    await parent.release();
  });
});

describe("co-holder nesting and executable identity", () => {
  it("refuses a descendant whose paths lie strictly inside the parent's writable root", async () => {
    const parent = await spawnMxcConfinedChild(spec());
    // Junction-swap scenario: the parent can rewrite D:\work\models between the final check and the SDK open.
    admitWrites("D:\\work\\models");
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), allowWrite: ["D:\\work\\models"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work\\models", "D:\\child"], hostStorageRoots: [] } }))
      .rejects.toThrow(/another live holder's writable root/);
    expect(state.spawn).toHaveBeenCalledTimes(1);
    await parent.release();
  });

  it("allows an equal pinned writable root shared with the parent", async () => {
    const parent = await spawnMxcConfinedChild(spec());
    admitWrites("D:\\work", "D:\\child");
    const child = await spawnMxcConfinedChild({ ...siblingChild(parent), allowWrite: ["D:\\work", "D:\\child"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\child"], hostStorageRoots: [] } });
    expect(child.confinement).toBe("windows-mxc");
    await parent.release();
  });

  it("refuses an equal shared root once any deny lands inside it, so descendants use sibling roots in practice", async () => {
    const parent = await spawnMxcConfinedChild(spec());
    // Production ranking always places floor denies (e.g. the .git control) below a writable root; the parent could
    // swap that denied subpath, so sharing the parent's exact root is refused as soon as such a deny exists.
    state.admit.mockReturnValueOnce({ policy: { allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work", "D:\\child"],
      denyRead: [], denyWrite: ["D:\\work\\.git"], protectedFloor: [] }, assertStillValid: state.validate });
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), allowWrite: ["D:\\work", "D:\\child"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\child"], hostStorageRoots: [] } }))
      .rejects.toThrow(/another live holder's writable root/);
    await parent.release();
  });

  it("refuses an unrelated holder nested in a live holder's roots and re-checks at the spawn boundary", async () => {
    const first = await spawnMxcConfinedChild(spec());
    admitWrites("D:\\child");
    await expect(spawnMxcConfinedChild({ ...siblingChild(first), parent: undefined, cwd: "D:\\work\\sub" }))
      .rejects.toThrow(/another live holder's writable root/);
    await first.release();
    // A holder that becomes live while another is between admission and native creation is caught in beforeSpawn.
    let late: Promise<MxcConfinedChildSpawn> | undefined;
    state.spawn.mockImplementationOnce(async (_request, options) => {
      const child = { id: 44, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), dispose: vi.fn().mockResolvedValue(undefined) };
      options.onOwned(child);
      admitWrites("D:\\outer");
      late = spawnMxcConfinedChild({ ...siblingChild(first, "D:\\outer"), parent: undefined });
      await late;
      options.beforeSpawn();
      return child;
    });
    admitWrites("D:\\outer\\inner");
    await expect(spawnMxcConfinedChild({ ...siblingChild(first, "D:\\outer\\inner"), parent: undefined }))
      .rejects.toThrow(/another live holder's writable root/);
    await (await late!).release();
  });

  it("refuses an executable inside any live writable root, the holder's own included", async () => {
    await expect(spawnMxcConfinedChild({ ...spec(), command: "D:\\work\\bin\\tool.exe" }))
      .rejects.toThrow(/executable lies inside a holder's writable root/);
    const parent = await spawnMxcConfinedChild(spec());
    admitWrites("D:\\child");
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), command: "D:\\work\\tool.exe" }))
      .rejects.toThrow(/executable lies inside a holder's writable root/);
    await parent.release();
  });

  it("re-measures the admitted executable synchronously before native creation", async () => {
    state.spawn.mockImplementationOnce(async (_request, options) => {
      const child = { id: 45, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), dispose: vi.fn().mockResolvedValue(undefined) };
      options.onOwned(child);
      state.executableStamp = 2n;
      options.beforeSpawn();
      return child;
    });
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/does not match/);
  });

  it("binds ranked write grants, HOME and temp to the captured write roots and the staging layout", async () => {
    admitWrites("D:\\work", "D:\\stray");
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/outside this holder's captured write roots/);
    await expect(spawnMxcConfinedChild({ ...spec(), home: "D:\\elsewhere\\home" })).rejects.toThrow(/captured write roots/);
    await expect(spawnMxcConfinedChild({ ...spec(), home: "C:\\ave\\sandbox\\home\\holder-a",
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "C:\\ave\\sandbox\\home\\holder-a"], hostStorageRoots: [] } }))
      .rejects.toThrow(/dedicated staging tree/);
    expect(state.lease).not.toHaveBeenCalled();
  });
});
