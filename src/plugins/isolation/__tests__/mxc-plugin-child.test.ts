import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMxcExtensionRequest } from "../../../__tests__/support/mxc-supervisor.js";
import type { OwnedMxcExtensionProcess } from "../../../permissions/mxc-extension-process.js";
import { MxcProcessCleanupError } from "../../../permissions/mxc-extension-errors.js";
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
  return { owned, launch, controller, resolve, reject };
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
    let confirm!: () => void;
    vi.mocked(owned.dispose).mockImplementation(() => new Promise<void>((yes) => { confirm = yes; }));
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
    resolve({ exitCode: 1, timedOut: false }); confirm();
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

  it("remembers faults for listeners attached after process failure", async () => {
    const { owned, launch, reject } = fixture();
    const child = attachMxcPluginChild(owned, launch);
    reject(new Error("Supervisor lost"));
    await child.waitForExit();
    const fault = vi.fn(); child.link.onFault(fault);
    expect(fault).toHaveBeenCalledWith("Supervisor lost");
  });

  it("rechecks admission after spawn and never retries a revoked holder", async () => {
    const { owned, launch } = fixture();
    spawn.mockReset().mockResolvedValue(owned);
    launch.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("Grant changed"); });
    await expect(spawnMxcPluginChild(launch)).rejects.toThrow("Grant changed");
    expect(spawn).toHaveBeenCalledOnce(); expect(owned.dispose).toHaveBeenCalledOnce();
    expect(launch.release).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![0]).not.toBe(launch.request);
    expect(spawn.mock.calls[0]![0]).toEqual(launch.request);
  });

  it("refuses revoked admission before spawn", async () => {
    const { launch, controller } = fixture();
    spawn.mockReset(); controller.abort();
    await expect(spawnMxcPluginChild(launch)).rejects.toThrow("revoked");
    expect(spawn).not.toHaveBeenCalled(); expect(launch.release).toHaveBeenCalledOnce();
  });

  it("keeps startup cleanup failures quarantined without a fallback start", async () => {
    const { launch } = fixture();
    spawn.mockReset().mockRejectedValue(new MxcProcessCleanupError("Cleanup unverified"));
    await expect(spawnMxcPluginChild(launch)).rejects.toThrow("Cleanup unverified");
    expect(spawn).toHaveBeenCalledOnce(); expect(launch.release).not.toHaveBeenCalled();
  });
});
