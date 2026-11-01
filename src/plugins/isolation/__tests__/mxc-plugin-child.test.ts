import { win32 as winPath } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { createMxcExtensionRequest } from "../../../__tests__/support/mxc-supervisor.js";
import type { MxcConfinedChildSpec } from "../../../permissions/confined-child.js";
import type { OwnedMxcExtensionProcess } from "../../../permissions/mxc-extension-process.js";
import { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError } from "../../../permissions/mxc-extension-errors.js";
import { registerMxcHolderLifetime } from "../../../permissions/mxc-holder-lifetime.js";
import { aveHome } from "../../../shared/ave-home.js";
import { windowsCommandLine } from "../../../shared/windows-command-line.js";
import { PluginChildTerminationUnverifiedError } from "../plugin-child-transport.js";
import { attachMxcPluginChild, spawnMxcPluginChild } from "../mxc-plugin-child.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/confined-child.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/confined-child.js")>(),
  spawnMxcConfinedChild: spawn,
}));

const STAGING_ID = "0123456789abcdef0123456789abcdef";

/** The request row 2 would build: `windowsCommandLine(command, args)` and the cwd verbatim. */
function admittedRequest(spec: Pick<MxcConfinedChildSpec, "command" | "args" | "cwd">): ContainerRequest {
  return { ...createMxcExtensionRequest(), command: windowsCommandLine(spec.command, spec.args), workingDirectory: spec.cwd };
}

function fixture() {
  let resolve!: (result: { exitCode: number; timedOut: boolean }) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((yes, no) => { resolve = yes; reject = no; });
  const owned: OwnedMxcExtensionProcess = {
    id: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), completion,
    diagnostics: { nodeVersion: "", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" },
    dispose: vi.fn(async () => { resolve({ exitCode: 0, timedOut: false }); }),
  };
  const controller = new AbortController();
  const staging = winPath.join(aveHome(), "mxc-staging", STAGING_ID);
  const launch = {
    home: winPath.join(staging, "home"), temp: winPath.join(staging, "temp"),
    filesystemOwnership: { readRoots: [], writeRoots: [staging], hostStorageRoots: [] },
    probe: vi.fn(async () => ({ version: "0.0.80", ready: true }) as never),
    signal: controller.signal, assertCurrent: vi.fn(), release: vi.fn(),
  };
  const intent = {
    pluginId: "native-probe", command: "C:\\Ave\\runtime.exe", args: ["C:\\Ave\\app\\entry.js"], cwd: "C:\\Ave\\plugins\\Kit",
    envelope: { read: ["C:\\Ave\\plugins\\Kit"], write: ["C:\\Ave\\plugins\\Kit\\data"] },
    floorPierces: [], baseEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const holderRelease = vi.fn(async () => {});
  // Row 2 stand-in: probe the measured request, then hand back the owned process.
  spawn.mockReset().mockImplementation(async (spec: MxcConfinedChildSpec) => {
    try {
      await spec.probe(admittedRequest(spec), new AbortController().signal);
    } catch {
      throw new MxcCapabilityUnavailableError("Native admission readiness failed: request-rejected");
    }
    return { process: owned, confinement: "windows-mxc", release: holderRelease };
  });
  return { owned, launch, intent, controller, resolve, reject, holderRelease, staging };
}

describe("native plugin stream ownership", () => {
  it("uses native streams and the container identity without a relay or process facade", async () => {
    const { owned, launch, resolve } = fixture();
    const child = attachMxcPluginChild(owned, launch);
    expect(child.link.input).toBe(owned.stdout);
    expect(child.link.output).toBe(owned.stdin);
    expect(child.pid).toBe(42);
    resolve({ exitCode: 7, timedOut: false });
    await child.waitForExit();
    const gone = vi.fn(); child.link.onGone(gone);
    await vi.waitFor(() => expect(gone).toHaveBeenCalledWith("Plugin child exited code=7 timedOut=false"));
    expect(launch.release).toHaveBeenCalledOnce();
  });

  it("revokes the channel before disposal and releases only after confirmed death", async () => {
    const { owned, launch, controller, resolve } = fixture();
    let settleDisposal!: () => void;
    vi.mocked(owned.dispose).mockImplementation(() => new Promise<void>((yes) => { settleDisposal = yes; }));
    const child = attachMxcPluginChild(owned, launch);
    const fault = vi.fn(); const gone = vi.fn();
    child.link.onFault(fault); child.link.onGone(gone);
    controller.abort();
    expect(fault).toHaveBeenCalledWith("Plugin child admission was revoked");
    await Promise.resolve();
    expect(owned.dispose).toHaveBeenCalledOnce();
    expect(launch.release).not.toHaveBeenCalled(); expect(gone).not.toHaveBeenCalled();
    child.link.terminate("again");
    expect(owned.dispose).toHaveBeenCalledOnce();
    resolve({ exitCode: 1, timedOut: false }); settleDisposal();
    await child.waitForExit();
    expect(launch.release).toHaveBeenCalledOnce();
  });

  it("retains the lease and rejects replacement when cleanup is unverified", async () => {
    const { owned, launch, reject } = fixture();
    const error = new MxcProcessCleanupError("Termination unverified");
    vi.mocked(owned.dispose).mockRejectedValue(error);
    const child = attachMxcPluginChild(owned, launch);
    const gone = vi.fn(); child.link.onGone(gone);
    reject(error);
    await expect(child.waitForExit()).rejects.toBe(error);
    expect(launch.release).not.toHaveBeenCalled(); expect(gone).not.toHaveBeenCalled();
  });

  it("surfaces failed teardown without waiting for a missing completion receipt", async () => {
    const { owned, launch } = fixture();
    const error = new MxcProcessCleanupError("No terminal receipt");
    vi.mocked(owned.dispose).mockRejectedValue(error);
    const child = attachMxcPluginChild(owned, launch);
    const gone = vi.fn(); child.link.onGone(gone);
    child.link.terminate("revoke");
    await expect(child.waitForExit()).rejects.toBe(error);
    expect(launch.release).not.toHaveBeenCalled(); expect(gone).not.toHaveBeenCalled();
  });

  it("reports the start of termination once, synchronously, and replays it to late listeners", async () => {
    const { owned, launch } = fixture();
    const child = attachMxcPluginChild(owned, launch);
    const early = vi.fn();
    child.onTerminating(early);
    child.link.terminate("first"); child.link.terminate("second");
    expect(early).toHaveBeenCalledOnce();
    const late = vi.fn(); child.onTerminating(late);
    expect(late).toHaveBeenCalledOnce();
    await child.waitForExit();
  });

  it("remembers faults for listeners attached after process failure", async () => {
    const { owned, launch, reject } = fixture();
    const child = attachMxcPluginChild(owned, launch);
    reject(new Error("Supervisor lost"));
    await child.waitForExit();
    const fault = vi.fn(); child.link.onFault(fault);
    expect(fault).toHaveBeenCalledWith("Supervisor lost");
  });

  it("spawns through row-2 admission with the host's command, grants, staging and a fresh holder", async () => {
    const { launch, intent, staging, owned } = fixture();
    const child = await spawnMxcPluginChild(launch, intent);
    expect(child.pid).toBe(owned.id);
    expect(spawn).toHaveBeenCalledOnce();
    const spec = spawn.mock.calls[0]![0] as MxcConfinedChildSpec;
    expect(spec).toMatchObject({
      command: intent.command, args: intent.args, cwd: intent.cwd, home: launch.home, temp: launch.temp,
      filesystemOwnership: launch.filesystemOwnership, label: "plugin-child:native-probe",
      egressOwner: { kind: "worker", role: "plugin-child", pluginId: "native-probe" },
      allowRead: ["C:\\Ave\\plugins\\Kit", "C:\\Ave", "C:\\Ave\\app"],
      allowWrite: ["C:\\Ave\\plugins\\Kit\\data", staging],
      baseEnv: intent.baseEnv, signal: launch.signal,
    });
    expect(spec.holder).toEqual({});
    expect(launch.probe).toHaveBeenCalledOnce();
    // The registration recheck runs inside row 2 (and so in its beforeSpawn), and so does revocation.
    launch.assertCurrent.mockClear();
    spec.assertStillValid!();
    expect(launch.assertCurrent).toHaveBeenCalledOnce();
    await spawnMxcPluginChild(launch, intent);
    expect((spawn.mock.calls[1]![0] as MxcConfinedChildSpec).holder).not.toBe(spec.holder);
    child.link.terminate("done");
    await child.waitForExit();
  });

  it("revocation fails row 2's validity check", async () => {
    const { launch, intent, controller } = fixture();
    await spawnMxcPluginChild(launch, intent);
    const spec = spawn.mock.calls[0]![0] as MxcConfinedChildSpec;
    controller.abort();
    expect(() => spec.assertStillValid!()).toThrow("revoked");
  });

  it("releases row 2's holder before the planner's state, only after verified death", async () => {
    const { launch, intent, holderRelease, owned } = fixture();
    const order: string[] = [];
    holderRelease.mockImplementation(async () => { order.push("holder"); });
    launch.release.mockImplementation(() => { order.push("planner"); });
    const child = await spawnMxcPluginChild(launch, intent);
    child.link.terminate("stop");
    await child.waitForExit();
    expect(owned.dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(["holder", "planner"]);
  });

  it("treats row 2's completion-driven release and its own as one release on a normal exit", async () => {
    const { launch, intent, owned } = fixture();
    const cleanup = vi.fn(async () => {});
    const lifetime = registerMxcHolderLifetime("plugin-child:native-probe", cleanup);
    // As row 2 does: release on completion, registered before the adapter attaches.
    spawn.mockImplementation(async () => {
      void owned.completion.then(() => lifetime.release(), () => lifetime.release());
      return { process: owned, confinement: "windows-mxc", release: lifetime.release };
    });
    const child = await spawnMxcPluginChild(launch, intent);
    child.link.terminate("stop");
    await expect(child.waitForExit()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce(); expect(launch.release).toHaveBeenCalledOnce();
  });

  it("keeps the planner's state and rejects exit when row 2's release is unverified", async () => {
    const { launch, intent, holderRelease } = fixture();
    const cleanup = new MxcProcessCleanupError("Extension tree cleanup is unverified");
    holderRelease.mockRejectedValue(cleanup);
    const child = await spawnMxcPluginChild(launch, intent);
    child.link.terminate("stop");
    await expect(child.waitForExit()).rejects.toBe(cleanup);
    expect(launch.release).not.toHaveBeenCalled();
  });

  it.each([
    ["outside AVE_HOME", (l: { home: string; temp: string }) => { l.home = "C:\\Other\\mxc-staging\\0123456789abcdef0123456789abcdef\\home"; }],
    ["named after the plugin", (l: { home: string; temp: string }) => {
      l.home = winPath.join(aveHome(), "mxc-staging", "native-probe", "home"); l.temp = winPath.join(aveHome(), "mxc-staging", "native-probe", "temp");
    }],
    ["shared between HOME and temp", (l: { home: string; temp: string }) => { l.temp = l.home; }],
    ["in different staging directories", (l: { home: string; temp: string }) => {
      l.temp = winPath.join(aveHome(), "mxc-staging", "fedcba9876543210fedcba9876543210", "temp");
    }],
    ["nested below the staging directory", (l: { home: string; temp: string }) => { l.home = winPath.join(l.home, "deeper"); }],
  ])("refuses HOME/temp %s before admission", async (_label, mutate) => {
    const { launch, intent } = fixture();
    mutate(launch);
    await expect(spawnMxcPluginChild(launch, intent)).rejects.toThrow("mxc-staging");
    expect(spawn).not.toHaveBeenCalled(); expect(launch.release).toHaveBeenCalledOnce();
  });

  it("rechecks admission after spawn and never retries a revoked holder", async () => {
    const { owned, launch, intent } = fixture();
    launch.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("Grant changed"); });
    await expect(spawnMxcPluginChild(launch, intent)).rejects.toThrow("Grant changed");
    expect(spawn).toHaveBeenCalledOnce(); expect(owned.dispose).toHaveBeenCalledOnce();
    expect(launch.release).toHaveBeenCalledOnce();
  });

  it("refuses revoked admission before spawn", async () => {
    const { launch, intent, controller } = fixture();
    controller.abort();
    await expect(spawnMxcPluginChild(launch, intent)).rejects.toThrow("revoked");
    expect(spawn).not.toHaveBeenCalled(); expect(launch.release).toHaveBeenCalledOnce();
  });

  it("keeps startup cleanup failures quarantined without a fallback start", async () => {
    const { launch, intent } = fixture();
    const cleanup = new MxcProcessCleanupError("Cleanup unverified");
    spawn.mockReset().mockRejectedValue(cleanup);
    const failure = await spawnMxcPluginChild(launch, intent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginChildTerminationUnverifiedError);
    expect((failure as Error).cause).toBe(cleanup);
    expect(spawn).toHaveBeenCalledOnce(); expect(launch.release).not.toHaveBeenCalled();
  });

  it("keeps both the recheck failure and the cleanup failure when the post-spawn teardown is unverified", async () => {
    const { owned, launch, intent } = fixture();
    const cleanup = new MxcProcessCleanupError("Termination unverified");
    vi.mocked(owned.dispose).mockRejectedValue(cleanup);
    const changed = new Error("Grant changed");
    launch.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw changed; });
    const failure = await spawnMxcPluginChild(launch, intent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginChildTerminationUnverifiedError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual([changed, cleanup]);
    expect(launch.release).not.toHaveBeenCalled();
  });

  it.each([
    ["command", (request: ContainerRequest) => { request.command = "C:\\Other\\runtime.exe C:\\Ave\\app\\entry.js"; }],
    ["working directory", (request: ContainerRequest) => { request.workingDirectory = "C:\\Ave"; }],
    // Exact, not case-folded: a JavaScript fold disagrees with the NTFS upcase table (U+212A KELVIN SIGN).
    ["case-folded working directory", (request: ContainerRequest) => { request.workingDirectory = "c:\\ave\\plugins\\kit"; }],
    ["Kelvin-sign working directory", (request: ContainerRequest) => { request.workingDirectory = "C:\\Ave\\plugins\\Kit".replace("K", "\u212A"); }],
  ])("refuses a measured request whose %s differs from the derived intent, with the contract error", async (_label, mutate) => {
    const { launch, intent } = fixture();
    const base = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spec: MxcConfinedChildSpec) => base({ ...spec, probe: (request: ContainerRequest, signal: AbortSignal) => {
      mutate(request);
      return spec.probe(request, signal);
    } }));
    const failure = await spawnMxcPluginChild(launch, intent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MxcProcessContractError);
    expect((failure as Error).message).toMatch(/^Admitted plugin request does not/u);
    expect(launch.probe).not.toHaveBeenCalled(); expect(launch.release).toHaveBeenCalledOnce();
  });
});
