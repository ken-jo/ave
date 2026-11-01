import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMxcExtensionRequest } from "../../../__tests__/support/mxc-supervisor.js";
import type { OwnedMxcExtensionProcess } from "../../../permissions/mxc-extension-process.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../../../permissions/mxc-extension-errors.js";
import { PluginChildTerminationUnverifiedError } from "../plugin-child-transport.js";
import { attachMxcPluginChild, spawnMxcPluginChild } from "../mxc-plugin-child.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/mxc-extension-process.js", () => ({ spawnMxcExtensionProcess: spawn }));

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
  const launch = { request: createMxcExtensionRequest(), signal: controller.signal, assertCurrent: vi.fn(), release: vi.fn() };
  const intent = { pluginId: "native-probe", command: "C:\\Ave\\runtime.exe", args: ["C:\\Ave\\staging\\entry.js"], cwd: "C:\\Ave\\staging" };
  launch.request.command = "C:\\Ave\\runtime.exe C:\\Ave\\staging\\entry.js";
  return { owned, launch, intent, controller, resolve, reject };
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

  it("does not equate a Kelvin sign with K in the working directory", async () => {
    const { launch, intent } = fixture();
    const kit = { ...intent, cwd: "C:\\Ave\\Kit" };
    launch.request.workingDirectory = "C:\\Ave\\\u212Ait";
    expect(launch.request.workingDirectory.toLowerCase()).toBe(kit.cwd.toLowerCase());
    spawn.mockReset();
    await expect(spawnMxcPluginChild(launch, kit)).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(spawn).not.toHaveBeenCalled();
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

  it("rechecks admission after spawn and never retries a revoked holder", async () => {
    const { owned, launch, intent } = fixture();
    spawn.mockReset().mockResolvedValue(owned);
    launch.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("Grant changed"); });
    await expect(spawnMxcPluginChild(launch, intent)).rejects.toThrow("Grant changed");
    expect(spawn).toHaveBeenCalledOnce(); expect(owned.dispose).toHaveBeenCalledOnce();
    expect(launch.release).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![0]).not.toBe(launch.request);
    expect(spawn.mock.calls[0]![0]).toEqual(launch.request);
  });

  it("refuses revoked admission before spawn", async () => {
    const { launch, intent, controller } = fixture();
    spawn.mockReset(); controller.abort();
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
    spawn.mockReset().mockResolvedValue(owned);
    const changed = new Error("Grant changed");
    launch.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw changed; });
    const failure = await spawnMxcPluginChild(launch, intent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginChildTerminationUnverifiedError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual([changed, cleanup]);
    expect(launch.release).not.toHaveBeenCalled();
  });

  it.each([
    ["command", (request: { command: string }) => { request.command = "C:\\Other\\runtime.exe C:\\Ave\\staging\\entry.js"; }],
    ["working directory", (request: { workingDirectory?: string }) => { request.workingDirectory = "C:\\Ave"; }],
    // Exact, not case-folded: a JavaScript fold disagrees with the NTFS upcase table (U+212A KELVIN SIGN).
    ["case-folded working directory", (request: { workingDirectory?: string }) => { request.workingDirectory = "c:\\ave\\staging"; }],
  ])("refuses an admitted request whose %s differs from the derived intent", async (_label, mutate) => {
    const { launch, intent } = fixture();
    mutate(launch.request as never);
    spawn.mockReset();
    await expect(spawnMxcPluginChild(launch, intent)).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(spawn).not.toHaveBeenCalled(); expect(launch.release).toHaveBeenCalledOnce();
  });
});
