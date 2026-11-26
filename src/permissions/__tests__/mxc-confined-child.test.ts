import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { declaredHostDirectoryFloorPierces } from "../../plugins/sandbox-authority.js";
import * as aveHome from "../../shared/ave-home.js";
import { liveEgressInvocationCount } from "../egress-invocations.js";
import { MxcCapabilityUnavailableError, MxcNativeEntryRequiredError, MxcProcessCleanupError, WorkerTransportUnsupportedError } from "../mxc-extension-errors.js";
import { registerMxcReleaseGateEvidence } from "../mxc-extension-admission.js";
import { mxcRequestDigest, type MxcExtensionStartEvidence } from "../mxc-extension-protocol.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { drainMxcHolderLifetimes } from "../mxc-holder-lifetime.js";
import { planWindowsExtensionHolder } from "../mxc-extension-readiness.js";
import { mxcPolicyModel } from "../../__tests__/support/mxc-policy-rows.js";
import { t } from "../../i18n/index.js";

const state = vi.hoisted(() => ({
  plan: { selectedBackend: "mxc", readiness: "ready" },
  realPlan: false,
  executableStamp: 1n,
  executableMtime: 1n,
  // Synthetic junctions (lexical prefix -> target) and not-yet-created paths for canonical spelling.
  junctions: new Map<string, string>(),
  missing: new Set<string>(),
  spawn: vi.fn(), close: vi.fn(), admit: vi.fn(), validate: vi.fn(), allowed: vi.fn(), lease: vi.fn(),
  shellPlan: undefined as unknown, issued: new WeakSet<object>(),
  // The runtime root start-up proved, or the refusal of one that was not.
  startRoot: vi.fn((): string => "C:\\ave-cache\\mxc-runtime"),
  // Stands for the issued-HOME identity check (its own suite runs it on real directories): the launch's HOME itself.
  issuedHome: vi.fn((cwd: string, home: string | undefined): boolean => cwd === home),
  homeInPlace: vi.fn((_home: string | undefined): void => undefined),
  // Directory watches armed for a watched carrier child: a fake watcher, or a thrown arm failure.
}));
vi.mock("../mxc-runtime-root.js", async (original) => ({
  ...await original<typeof import("../mxc-runtime-root.js")>(), requireMxcContainerStartRoot: () => state.startRoot(),
}));
vi.mock("../sandbox-home-registry.js", async (original) => ({
  ...await original<typeof import("../sandbox-home-registry.js")>(),
  isIssuedContainerHome: (cwd: string, home: string | undefined) => state.issuedHome(cwd, home),
  assertIssuedContainerHomeInPlace: (home: string | undefined) => state.homeInPlace(home),
}));
vi.mock("../asrt-sandbox.js", () => ({
  assertExtensionStartAllowed: () => state.allowed(), admitMxcExtensionFilesystem: (...args: unknown[]) => state.admit(...args),
  runWithSandboxWritePreflight: async (_signal: AbortSignal | undefined, compose: () => unknown) => compose(),
  getDefaultSensitiveReadDenyPaths: () => ["C:\\private"], getDefaultSensitiveWriteDenyEntries: () => ["D:\\work\\.git"],
  appOwnedSandboxHomeRoot: () => "C:\\ave\\sandbox\\home", appOwnedSandboxTempRoot: () => "C:\\ave\\sandbox\\temp",
  appOwnedTerminalHandoffRoot: () => "C:\\ave\\sandbox\\handoff",
}));
vi.mock("../sandbox-capability.js", async (original) => {
  const actual = await original<typeof import("../sandbox-capability.js")>();
  return { ...actual, getWindowsExtensionBackendPlan: () => state.realPlan ? actual.getWindowsExtensionBackendPlan() : state.plan,
    // A host-issued shell plan of the live generation, for the user-hook shell-plan route.
    getHostShellExecutionPlan: () => state.shellPlan ?? actual.getHostShellExecutionPlan(),
    isIssuedHostShellExecutionPlan: (plan: object) => state.issued.has(plan),
    getIssuedHostShellExecutionPlanGeneration: (plan: object) => state.issued.has(plan) ? actual.getSandboxGeneration() : undefined,
  };
});
vi.mock("../egress-host-listener.js", () => ({ openMxcEgressLease: (...args: unknown[]) => state.lease(...args) }));
vi.mock("../mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: (...args: unknown[]) => state.spawn(...args) }));
vi.mock("../../main/managed-child-processes.js", () => ({ assertManagedChildProcessAdmissionOpen: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  // Synthetic Windows paths: canonical spelling is the lexical one, and the executable's file identity is a fixture stamp.
  const canonical = (path: string): string => {
    const key = path.toLowerCase();
    if ([...state.missing].some((missing) => key === missing.toLowerCase() || key.startsWith(`${missing.toLowerCase()}\\`))) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    for (const [link, target] of state.junctions) {
      if (key === link.toLowerCase() || key.startsWith(`${link.toLowerCase()}\\`)) return target + path.slice(link.length);
    }
    return path;
  };
  const realpathSync = Object.assign(canonical, { native: canonical });
  const lstatSync = (path: string) => {
    canonical(path);
    const directory = !path.endsWith(".exe");
    return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
      size: 8n, mtimeNs: state.executableMtime, birthtimeNs: 1n };
  };
  return { ...actual, existsSync: () => true, realpathSync, lstatSync };
});

vi.mock("../../shared/windows-path-facts.js", async original => {
  const actual = await original<typeof import("../../shared/windows-path-facts.js")>();
  const facts = (path: string): ReturnType<typeof actual.pinWindowsPaths>[number] => {
    const exists = ![...state.missing].some(parent => path.toLowerCase() === parent.toLowerCase()
      || path.toLowerCase().startsWith(`${parent.toLowerCase()}\\`));
    const volume = exists ? "0x0000000000000007" : null;
    const fileIndex = exists ? `0x${createHash("md5").update(path.toLowerCase()).digest("hex")}` : null;
    const directory = exists && !path.endsWith(".exe");
    return {
      exists, canonical: exists ? path : null, directory, attributes: directory ? 16 : 0,
      volumeSerial: volume, volumeSerialNumber: volume, fileId: fileIndex, fileIndex,
      changeTime: exists ? `0x${state.executableStamp.toString(16).padStart(16, "0")}` : null,
      fileSystemName: null, reparseTag: 0, reparseTarget: null, ancestors: [],
    };
  };
  const pinWindowsPaths: typeof actual.pinWindowsPaths = paths => paths.map(path => {
    const ancestors = [];
    for (let parent = win32.dirname(path); parent !== path; parent = win32.dirname(parent)) {
      ancestors.unshift(facts(parent));
      if (parent === win32.dirname(parent)) break;
    }
    return { ...facts(path), ancestors };
  });
  return { ...actual, pinWindowsPaths };
});

import { liveMxcHolderWritableRoots, spawnConfinedChild, spawnMxcConfinedChild, type MxcConfinedChildSpawn, type MxcConfinedChildSpec } from "../confined-child.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";
import { __resetWindowsSandboxSubstrateForTest, setWindowsSandboxSubstrate } from "../sandbox-capability.js";
import { mxcShellCapability, windowsSubstrateFor, type WindowsSandboxPlanInputs } from "../../boot/steps/windows-sandbox-plan.js";
import * as watchedRows from "../windows-watched-rows.js";
import { sweepWatchedRows, WatchedQuarantineError, watchedProtectedRows } from "../windows-watched-rows.js";

function spec(): MxcConfinedChildSpec {
  return { label: "worker:sample", command: "C:\\runtime\\runtime.exe", args: ["D:\\work\\entry.js"],
    cwd: "D:\\work", home: "D:\\work\\home", temp: "D:\\work\\temp",
    allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work"],
    egressOwner: { kind: "worker", role: "worker", pluginId: "sample", instanceId: "main" },
    workerTransport: "stdio-control-v1", baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\local" },
    filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work"], hostStorageRoots: [] }, holder: Object.freeze({ incarnation: "main" }),
  };
}
// Contract fields 1-5, as this start's ready frame reports them for the request it started.
const START: MxcExtensionStartEvidence = { installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
  uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true };
const started = (request: unknown, evidence: MxcExtensionStartEvidence = START) =>
  ({ requestDigest: mxcRequestDigest(request as Parameters<typeof mxcRequestDigest>[0]), evidence });
/** A native start whose ready frame carried `startEvidence` (or nothing). */
function startWith(startEvidence: (request: unknown) => unknown) {
  const dispose = vi.fn().mockResolvedValue(undefined);
  state.spawn.mockImplementationOnce(async (request, options) => {
    const child = { id: 46, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      completion: new Promise(() => {}), startEvidence: startEvidence(request), dispose };
    options.onOwned(child);
    options.beforeSpawn();
    return child;
  });
  return dispose;
}
let unregisterReleaseGate: (() => void) | undefined;

// A descendant laid out as a sibling of its parent's writable root, as rows 3-5 must do.
function siblingChild(parent: MxcConfinedChildSpawn, root = "D:\\child"): MxcConfinedChildSpec {
  return { ...spec(), parent, cwd: root, home: `${root}\\home`, temp: `${root}\\temp`, allowWrite: [root],
    filesystemOwnership: { readRoots: [], writeRoots: [root], hostStorageRoots: [] }, holder: Object.freeze({ incarnation: root }) };
}
function admitWrites(...allowWrite: string[]): void {
  state.admit.mockReturnValueOnce({ model: mxcPolicyModel({ allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite,
    denyRead: [], denyWrite: [], protectedFloor: [] }), assertStillValid: state.validate });
}
const ORIGINAL_PLATFORM = process.platform;
beforeEach(() => {
  setProcessPlatform("win32");
  vi.clearAllMocks();
  state.realPlan = false;
  state.executableStamp = 1n;
  state.executableMtime = 1n;
  state.junctions.clear();
  state.missing.clear();
  state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
    fallback: { version: "0.0.80", ready: false } });
  // Contract fields 8-13: the install's release-gate record, which no start gathers.
  unregisterReleaseGate = registerMxcReleaseGateEvidence({ ownProxySucceeded: true, otherListenerRefused: true,
    directEgressRefused: true, forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true });
  state.close.mockResolvedValue(undefined);
  state.lease.mockResolvedValue({ url: "http://127.0.0.1:43210", port: 43210, close: state.close });
  state.admit.mockReturnValue({ model: mxcPolicyModel({ allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work"],
    denyRead: [], denyWrite: [], protectedFloor: [] }), assertStillValid: state.validate });
  state.spawn.mockImplementation(async (_request, options) => {
    const child = { id: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      completion: new Promise(() => {}), startEvidence: started(_request), dispose: vi.fn().mockResolvedValue(undefined) };
    options.onOwned(child);
    options.beforeSpawn();
    return child;
  });
});
afterEach(async () => {
  // Release every holder a test left owned so its writable roots do not constrain the next test.
  await drainMxcHolderLifetimes();
  unregisterReleaseGate?.(); unregisterReleaseGate = undefined;
  vi.useRealTimers();
  __resetWindowsSandboxSubstrateForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

describe("native confined holder admission", () => {
  it("carries a reviewed plugin hostDirectory certs read through the admitted rank", async () => {
    const home = "C:\\ave";
    const homeSpy = vi.spyOn(aveHome, "aveHome").mockReturnValue(home);
    try {
      const floorPierces = declaredHostDirectoryFloorPierces({
        read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read approved certificate roots" }],
      });
      const certs = win32.join(home, "certs");
      const sessions = win32.join(home, "sessions");
      const nestedDeny = win32.join(certs, "private");
      const allowRead = [...spec().allowRead ?? [], ...floorPierces, sessions];
      state.admit.mockImplementationOnce((input) => ({
        model: mxcPolicyModel({ allowRead: input.allowRead, allowWrite: input.allowWrite, denyRead: [], denyWrite: [],
          protectedFloor: [home, certs, sessions, nestedDeny], floorPierces: [...input.floorPierces, sessions] }),
        assertStillValid: state.validate,
      }));
      const child = await spawnMxcConfinedChild({ ...spec(), allowRead, floorPierces });
      expect(state.admit.mock.calls[0]?.[0].floorPierces).toEqual(floorPierces);
      const filesystem = state.spawn.mock.calls[0]?.[0].filesystem;
      expect(filesystem.readonlyPaths).toContain(certs);
      expect(filesystem.readonlyPaths).not.toContain(sessions);
      expect(filesystem.deniedPaths).toContain(nestedDeny);
      await child.release();
    } finally {
      homeSpy.mockRestore();
    }
  });

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

  it("admits an output-only worker over the container pipes", async () => {
    const result = await spawnMxcConfinedChild({ ...spec(), workerTransport: "output-only-v1" });
    expect(state.spawn).toHaveBeenCalledTimes(1);
    await result.release();
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

  describe("per-start admission on the holder's own start", () => {
    it("refuses and stops a holder whose ready frame carried no start evidence", async () => {
      const before = liveEgressInvocationCount();
      const dispose = startWith(() => undefined);
      await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/no ready-frame evidence/);
      // Refused after native creation: stopped, endpoint released, and no second start on any backend.
      expect(dispose).toHaveBeenCalledOnce();
      expect(state.spawn).toHaveBeenCalledTimes(1);
      expect(state.close).toHaveBeenCalledOnce();
      expect(liveEgressInvocationCount()).toBe(before);
      expect(liveMxcHolderWritableRoots()).toEqual([]);
    });

    it("refuses and stops a holder that presents another holder's start evidence", async () => {
      const before = liveEgressInvocationCount();
      const other = await spawnMxcConfinedChild(spec());
      const borrowed = (await state.spawn.mock.results.at(0)?.value)?.startEvidence;
      expect(borrowed).toBeDefined();
      await other.release();
      admitWrites("D:\\child");
      const dispose = startWith(() => borrowed);
      await expect(spawnMxcConfinedChild({ ...siblingChild(other), parent: undefined })).rejects.toThrow(/another holder's start/);
      expect(dispose).toHaveBeenCalledOnce();
      expect(liveEgressInvocationCount()).toBe(before);
    });

    it.each([
      ["installedPayloadVerified", "native-validation-required"],
      ["baseContainerReady", "native-validation-required"],
      ["exactRequestAccepted", "native-validation-required"],
      ["uiEnabledRuntimeStarted", "runtime-start-failed"],
      ["ancestorQueriesSupported", "ancestor-policy-unsupported"],
    ] as const)("refuses and stops a holder whose start did not observe %s", async (field, reason) => {
      const before = liveEgressInvocationCount();
      const dispose = startWith((request) => started(request, { ...START, [field]: false }));
      const refusal: unknown = await spawnMxcConfinedChild(spec()).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(MxcCapabilityUnavailableError);
      expect(String(refusal)).toContain(`Native admission readiness failed: ${reason}`);
      expect(dispose).toHaveBeenCalledOnce();
      expect(state.spawn).toHaveBeenCalledTimes(1);
      expect(liveEgressInvocationCount()).toBe(before);
    });

    it("refuses at the readiness deadline, cancels its own start and leaves the backend plan as it was", async () => {
      vi.useFakeTimers();
      const before = liveEgressInvocationCount();
      const plan = state.plan;
      const dispose = vi.fn().mockResolvedValue(undefined);
      let startSignal: AbortSignal | undefined;
      state.spawn.mockImplementationOnce((_request, options) => new Promise((_resolve, reject) => {
        options.onOwned({ id: 47, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          completion: new Promise(() => {}), startEvidence: undefined, dispose });
        options.beforeSpawn();
        startSignal = options.signal;
        options.signal.addEventListener("abort", () => reject(new Error("start cancelled")), { once: true });
      }));
      const refusal = spawnMxcConfinedChild(spec()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs - 1);
      expect(startSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await refusal;
      expect(error).toBeInstanceOf(MxcCapabilityUnavailableError);
      expect(String(error)).toContain("readiness-deadline");
      expect(startSignal?.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(state.spawn).toHaveBeenCalledTimes(1);
      expect(state.plan).toBe(plan);
      expect(liveEgressInvocationCount()).toBe(before);
    });

    it("refuses before any listener or native start while no release-gate record is registered", async () => {
      const before = liveEgressInvocationCount();
      unregisterReleaseGate?.();
      await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/No release-gate evidence is registered/);
      expect(state.spawn).not.toHaveBeenCalled();
      expect(state.lease).not.toHaveBeenCalled();
      expect(state.admit).not.toHaveBeenCalled();
      expect(liveEgressInvocationCount()).toBe(before);
    });

    it("disposes the native process when the caller's signal aborts after admission", async () => {
      const before = liveEgressInvocationCount();
      const controller = new AbortController();
      const result = await spawnMxcConfinedChild({ ...spec(), signal: controller.signal });
      expect(result.process.dispose).not.toHaveBeenCalled();
      controller.abort();
      await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
      expect(result.process.dispose).toHaveBeenCalledOnce();
      expect(liveEgressInvocationCount()).toBe(before);
      expect(liveMxcHolderWritableRoots()).toEqual([]);
    });

    it("runs the adapter's request check on a snapshot before the start", async () => {
      const assertRequest = vi.fn((request: { command: string }) => { request.command = "mutated"; });
      const result = await spawnMxcConfinedChild({ ...spec(), assertRequest });
      expect(assertRequest).toHaveBeenCalledOnce();
      expect(state.spawn.mock.lastCall?.[0].command).toMatch(/runtime\.exe/u);
      await result.release();
      await expect(spawnMxcConfinedChild({ ...spec(), assertRequest: () => { throw new Error("not the planned launch"); } }))
        .rejects.toThrow("not the planned launch");
      expect(state.spawn).toHaveBeenCalledTimes(1);
    });
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
        completion: new Promise(() => {}), startEvidence: started(_request), dispose: vi.fn(() => death) };
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

describe("user-hook shell-plan route under a container extension backend", () => {
  const userHookOwner = { kind: "worker", role: "hook", pluginId: undefined, instanceId: "a1" } as MxcConfinedChildSpec["egressOwner"];
  const issuedPlan = (substrate: "asrt" | "mxc" = "asrt") => {
    const plan = { mode: "asrt", substrate, identity: `issued-${substrate}` };
    state.issued.add(plan);
    state.shellPlan = plan;
    return plan as never;
  };
  afterEach(() => { state.shellPlan = undefined; });

  it("lets a plugin-less user hook on its issued srt-win plan past the extension guard", async () => {
    const plan = issuedPlan();
    for (const readiness of ["ready", "rejected"] as const) {
      if (readiness === "rejected") state.plan = { selectedBackend: "none", readiness };
      const refusal = await spawnConfinedChild({ ...spec(), egressOwner: userHookOwner, grantMode: "deny-only", userHookShellPlan: plan })
        .catch((error: unknown) => error);
      // Past the guard the legacy wrap runs (unmocked here); neither the native-entry nor the readiness refusal fires.
      expect(refusal).not.toBeInstanceOf(MxcNativeEntryRequiredError);
      expect(refusal).not.toBeInstanceOf(MxcProcessContractError);
    }
  });

  it("never grants the exemption to a plugin hook, even carrying an issued plan", async () => {
    const plan = issuedPlan();
    const pluginHook = { kind: "worker", role: "hook", pluginId: "sample" } as MxcConfinedChildSpec["egressOwner"];
    await expect(spawnConfinedChild({ ...spec(), egressOwner: pluginHook, grantMode: "deny-only", userHookShellPlan: plan }))
      .rejects.toThrow("Only a plugin-less user hook");
    await expect(spawnConfinedChild({ ...spec(), egressOwner: pluginHook, grantMode: "deny-only" }))
      .rejects.toBeInstanceOf(MxcNativeEntryRequiredError);
    expect(state.lease).not.toHaveBeenCalled();
  });

  it("refuses a plan the host did not issue, a stale plan and a container-substrate plan", async () => {
    issuedPlan();
    const forged = { mode: "asrt", substrate: "asrt", identity: "issued-asrt" } as never;
    await expect(spawnConfinedChild({ ...spec(), egressOwner: userHookOwner, grantMode: "deny-only", userHookShellPlan: forged }))
      .rejects.toThrow("not the current issued srt-win plan");
    const stale = issuedPlan();
    issuedPlan("asrt");
    state.shellPlan = { mode: "asrt", substrate: "asrt", identity: "newer" };
    await expect(spawnConfinedChild({ ...spec(), egressOwner: userHookOwner, grantMode: "deny-only", userHookShellPlan: stale }))
      .rejects.toThrow("not the current issued srt-win plan");
    await expect(spawnConfinedChild({ ...spec(), egressOwner: userHookOwner, grantMode: "deny-only", userHookShellPlan: issuedPlan("mxc") }))
      .rejects.toThrow("not the current issued srt-win plan");
  });
});

describe("the container runtime root", () => {
  const RUNTIME_ROOT = String.raw`C:\ave-cache\mxc-runtime`;
  const STAGING = String.raw`C:\ave-cache\mxc-runtime\staging\0123456789abcdef0123456789abcdef`;
  const WORK = String.raw`D:\work`;
  // A holder laid out as its adapters lay it out: HOME and temp in its own staging directory under the root.
  function staged(cwd: string, writes = [WORK, STAGING]): MxcConfinedChildSpec {
    return { ...spec(), cwd, home: String.raw`${STAGING}\home`, temp: String.raw`${STAGING}\temp`, allowWrite: writes,
      filesystemOwnership: { readRoots: [], writeRoots: writes, hostStorageRoots: [] } };
  }

  it("refuses every start while the root is not proved, before admission, egress or the native spawn", async () => {
    const before = liveEgressInvocationCount();
    state.startRoot.mockImplementationOnce(() => { throw new Error("Container runtime root was not established when the sandbox started"); });
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/not established/u);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.lease).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(before);
  });

  it.each([
    ["the root itself", RUNTIME_ROOT],
    ["another holder's staging", String.raw`C:\ave-cache\mxc-runtime\staging\fedcba9876543210fedcba9876543210\home`],
    ["its own temp", String.raw`${STAGING}\temp`],
    ["the HOME parent spelled in another case", String.raw`C:\AVE-CACHE\MXC-RUNTIME\HOMES`],
    ["a junction into the root", String.raw`D:\work\link\homes`],
    ["the staging parent", String.raw`C:\ave-cache\mxc-runtime\staging`],
    ["a directory below its own HOME", String.raw`${STAGING}\home\work`],
  ])("refuses a working directory inside it: %s", async (_case, cwd) => {
    state.junctions.set(String.raw`D:\work\link`, RUNTIME_ROOT);
    const before = liveEgressInvocationCount();
    await expect(spawnMxcConfinedChild(staged(cwd))).rejects.toThrow(/working directory is inside the sandbox runtime root/u);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(before);
  });

  it.each([
    ["its own HOME, the default", String.raw`${STAGING}\home`],
    ["a sibling of the root", String.raw`C:\ave-cache\mxc-runtime-other`],
    ["the workspace", WORK],
  ])("admits a working directory outside it, or %s", async (_case, cwd) => {
    const writes = [...new Set([WORK, STAGING, ...cwd.startsWith(STAGING) ? [] : [cwd]])];
    admitWrites(...writes);
    const result = await spawnMxcConfinedChild(staged(cwd, writes));
    expect(state.spawn).toHaveBeenCalledOnce();
    expect(state.spawn.mock.calls[0]?.[0].workingDirectory).toBe(cwd);
    await result.release();
  });

  it("refuses its own HOME by name once it is no longer the directory issued, and asks with this launch's HOME", async () => {
    state.issuedHome.mockReturnValueOnce(false);
    const home = String.raw`${STAGING}\home`;
    await expect(spawnMxcConfinedChild(staged(home))).rejects.toThrow(/working directory is inside the sandbox runtime root/u);
    expect(state.issuedHome).toHaveBeenCalledWith(home, home);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("refuses with the named reason, before admission, egress or the native spawn, once its HOME or a parent of it was replaced", async () => {
    const { SandboxHomeUnavailableError } = await import("../sandbox-home-registry.js");
    state.homeInPlace.mockImplementationOnce(() => { throw new SandboxHomeUnavailableError(new Error("replaced")); });
    const before = liveEgressInvocationCount();
    const home = String.raw`${STAGING}\home`;
    await expect(spawnMxcConfinedChild(staged(WORK))).rejects.toMatchObject({ code: "sandbox-home-unavailable" });
    expect(state.homeInPlace).toHaveBeenCalledWith(home);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(before);
  });
});

describe("live holder writable roots for adapters", () => {
  it("lists an owned holder's writable roots until verified termination", async () => {
    const result = await spawnMxcConfinedChild(spec());
    expect(liveMxcHolderWritableRoots()).toContain("D:\\work");
    await result.release();
    expect(liveMxcHolderWritableRoots()).not.toContain("D:\\work");
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

  it("allows an equal pinned writable root shared with the parent when neither HOME nor temp lies inside it", async () => {
    // HOME/temp are never shareable, so the parent keeps them in its own staging root beside the shared one.
    admitWrites("D:\\work", "D:\\parent-stage");
    const parent = await spawnMxcConfinedChild({ ...spec(), home: "D:\\parent-stage\\home", temp: "D:\\parent-stage\\temp",
      allowWrite: ["D:\\work", "D:\\parent-stage"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\parent-stage"], hostStorageRoots: [] } });
    admitWrites("D:\\work", "D:\\child");
    const child = await spawnMxcConfinedChild({ ...siblingChild(parent), allowWrite: ["D:\\work", "D:\\child"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\child"], hostStorageRoots: [] } });
    expect(child.confinement).toBe("windows-mxc");
    await parent.release();
  });

  it("refuses an equal shared root once any deny lands inside it, so descendants use sibling roots in practice", async () => {
    admitWrites("D:\\work", "D:\\parent-stage");
    const parent = await spawnMxcConfinedChild({ ...spec(), home: "D:\\parent-stage\\home", temp: "D:\\parent-stage\\temp",
      allowWrite: ["D:\\work", "D:\\parent-stage"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\parent-stage"], hostStorageRoots: [] } });
    // Production ranking always places floor denies (e.g. the .git control) below a writable root; the parent could
    // swap that denied subpath, so sharing the parent's exact root is refused as soon as such a deny exists.
    state.admit.mockReturnValueOnce({ model: mxcPolicyModel({ allowRead: ["C:\\runtime", "C:\\Windows"], allowWrite: ["D:\\work", "D:\\child"],
      denyRead: [], denyWrite: ["D:\\work\\.git"], protectedFloor: [] }), assertStillValid: state.validate });
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), allowWrite: ["D:\\work", "D:\\child"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\child"], hostStorageRoots: [] } }))
      .rejects.toThrow(/Container path lies inside another live holder's writable root/);
    await parent.release();
  });

  it("refuses an unrelated holder nested in a live holder's roots and re-checks at the spawn boundary", async () => {
    const first = await spawnMxcConfinedChild(spec());
    admitWrites("D:\\child");
    await expect(spawnMxcConfinedChild({ ...siblingChild(first), parent: undefined, cwd: "D:\\work\\sub" }))
      .rejects.toThrow(/another live holder's writable root/);
    await first.release();
    // A holder still between admission and native creation is already registered: a holder whose root would contain
    // its paths is refused at admission, and the pending one still reaches native creation.
    let late: unknown;
    state.spawn.mockImplementationOnce(async (_request, options) => {
      const child = { id: 44, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), startEvidence: started(_request), dispose: vi.fn().mockResolvedValue(undefined) };
      options.onOwned(child);
      admitWrites("D:\\outer");
      late = await spawnMxcConfinedChild({ ...siblingChild(first, "D:\\outer"), parent: undefined }).catch((error: unknown) => error);
      options.beforeSpawn();
      return child;
    });
    admitWrites("D:\\outer\\inner");
    const pending = await spawnMxcConfinedChild({ ...siblingChild(first, "D:\\outer\\inner"), parent: undefined });
    expect(late).toBeInstanceOf(Error);
    expect(String(late)).toMatch(/another live holder's writable root|HOME or temp/);
    await pending.release();
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

  it.each(["native change time", "mtime only"] as const)("refuses a same-path executable rewrite changing %s", async (changed) => {
    state.spawn.mockImplementationOnce(async (_request, options) => {
      const child = { id: 45, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), startEvidence: started(_request), dispose: vi.fn().mockResolvedValue(undefined) };
      options.onOwned(child);
      if (changed === "native change time") state.executableStamp = 2n;
      else state.executableMtime = 2n;
      options.beforeSpawn();
      return child;
    });
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(/does not match/);
  });

  it.runIf(process.platform === "win32")("claims the watched names as the last check before native creation, and refuses the start, naming the path, when the parent appeared since ranking", async () => {
    const children = ["D:\\work\\.ave\\commands", "D:\\work\\.ave\\hooks"];
    const claimed = () => watchedProtectedRows().filter(path => children.includes(path));
    const admitWatched = () => {
      state.missing.add("D:\\work\\.ave");
      state.admit.mockReturnValueOnce({ model: mxcPolicyModel({ allowRead: ["C:\\runtime", "C:\\Windows"],
        allowWrite: ["D:\\work"], denyRead: [], denyWrite: children, requiredWriteDenies: children, protectedFloor: [] }), assertStillValid: state.validate });
    };
    const spawnAfter = (beforeCheck: () => void) => state.spawn.mockImplementationOnce(async (request, options) => {
      const child = { id: 47, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        completion: new Promise(() => {}), startEvidence: started(request), dispose: vi.fn().mockResolvedValue(undefined) };
      options.onOwned(child);
      beforeCheck();
      options.beforeSpawn();
      return child;
    });
    admitWatched();
    let claimedBeforeCheck: string[] | undefined;
    spawnAfter(() => { claimedBeforeCheck = claimed(); });
    const result = await spawnMxcConfinedChild(spec());
    // Nothing is registered until the final check, and the claim lasts until the holder's release.
    expect(claimedBeforeCheck).toEqual([]);
    expect(claimed()).toEqual(children);
    await result.release();
    expect(claimed()).toEqual([]);
    admitWatched();
    spawnAfter(() => { state.missing.delete("D:\\work\\.ave"); });
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow(t("sandboxPolicy.windowsProtectedWriteRefused", { path: children[0] }));
    expect(claimed()).toEqual([]);
    // A start that fails after the claim releases it.
    admitWatched();
    state.spawn.mockImplementationOnce(async (_request, options) => {
      options.beforeSpawn();
      throw new Error("[fixture] native creation failed");
    });
    await expect(spawnMxcConfinedChild(spec())).rejects.toThrow("[fixture] native creation failed");
    expect(claimed()).toEqual([]);
  });

  it.runIf(process.platform === "win32").each(["receipt", "failure"] as const)("hands a holder's quarantine %s to the next sandboxed command result", async (kind) => {
    const children = ["D:\\work\\.ave\\commands", "D:\\work\\.ave\\hooks"];
    state.missing.add("D:\\work\\.ave");
    state.admit.mockReturnValueOnce({ model: mxcPolicyModel({ allowRead: ["C:\\runtime", "C:\\Windows"],
      allowWrite: ["D:\\work"], denyRead: [], denyWrite: children, requiredWriteDenies: children, protectedFloor: [] }), assertStillValid: state.validate });
    // A holder has no command result of its own to carry what its release moved or could not move.
    const claim = vi.spyOn(watchedRows, "claimMxcWatchedRows").mockReturnValue({ start: vi.fn(), release: async () => {
      if (kind === "failure") throw new WatchedQuarantineError("[fixture] holder quarantine failed");
      return "[fixture] holder quarantine receipt";
    } });
    try {
      const result = await spawnMxcConfinedChild(spec());
      await result.release();
    } finally {
      claim.mockRestore();
    }
    await expect(sweepWatchedRows({ commandId: "next-command" })).resolves.toBe(`[fixture] holder quarantine ${kind === "failure" ? "failed" : "receipt"}`);
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

  it("canonicalizes a not-yet-created path through its longest existing ancestor", async () => {
    admitWrites("D:\\work", "D:\\parent-stage");
    const parent = await spawnMxcConfinedChild({ ...spec(), home: "D:\\parent-stage\\home", temp: "D:\\parent-stage\\temp",
      allowWrite: ["D:\\work", "D:\\parent-stage"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\parent-stage"], hostStorageRoots: [] } });
    // D:\\alias is a junction to the parent's writable D:\\work; the child's HOME below it does not exist yet, so only
    // canonicalizing its existing ancestor reveals that it would be created inside the parent's root.
    state.junctions.set("D:\\alias", "D:\\work");
    state.missing.add("D:\\alias\\child-home");
    admitWrites("D:\\child");
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), home: "D:\\alias\\child-home",
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\child", "D:\\alias\\child-home"], hostStorageRoots: [] } }))
      .rejects.toThrow(/HOME or temp lies at or inside another live holder's writable root/);
    await parent.release();
  });

  it("refuses in the reverse direction too, so the outcome does not depend on admission order", async () => {
    const parent = await spawnMxcConfinedChild(spec());
    admitWrites("D:\\outer\\inner");
    const inner = await spawnMxcConfinedChild(siblingChild(parent, "D:\\outer\\inner"));
    // A new holder whose writable root contains a live holder's paths is the same race seen from the other side.
    admitWrites("D:\\outer");
    await expect(spawnMxcConfinedChild({ ...siblingChild(inner, "D:\\outer"), parent: undefined }))
      .rejects.toThrow(/another live holder's writable root|HOME or temp/);
    await drainMxcHolderLifetimes();
  });

  it("never lets HOME or temp share an equal root with another live holder", async () => {
    const parent = await spawnMxcConfinedChild(spec());
    // Equal writable roots are otherwise allowed; HOME exactly at the parent's writable root is not.
    admitWrites("D:\\work", "D:\\child");
    await expect(spawnMxcConfinedChild({ ...siblingChild(parent), home: "D:\\work", allowWrite: ["D:\\work", "D:\\child"],
      filesystemOwnership: { readRoots: [], writeRoots: ["D:\\work", "D:\\child"], hostStorageRoots: [] } }))
      .rejects.toThrow(/HOME or temp lies at or inside another live holder's writable root/);
    await parent.release();
  });
});
