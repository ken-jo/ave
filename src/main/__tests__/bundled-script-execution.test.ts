import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), wrap: vi.fn(), runtimeReads: vi.fn(), plan: vi.fn(), cleanup: vi.fn(),
  homeCleanup: vi.fn(), home: vi.fn(), kill: vi.fn(), track: vi.fn(), admission: vi.fn(),
  releaseMxc: vi.fn(), prepareMxc: vi.fn(), active: vi.fn(), actionRelease: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: mocks.wrap, cleanupAsrtSandboxAfterCommand: mocks.cleanup,
  isShellSandboxActive: mocks.active,
  getDefaultSensitiveReadDenyPaths: () => ["/protected/secrets", "/private/homes"],
  getProtectedReadDenyFloor: () => ["/protected/secrets", "/custom/private"],
  protectedReadDenyCovering: () => undefined,
  getOwnedSandboxActionWriteDenyPaths: () => ["/protected/scripts", "/protected/runtime"],
  sandboxTempEnvLaunch: (dir: string, command: string, args: string[]) => ({ command: "/usr/bin/env", args: [`TMPDIR=${dir}`, `TMP=${dir}`, `TEMP=${dir}`, command, ...args] }),
}));
vi.mock("../../permissions/sandbox-capability.js", () => ({ getHostShellExecutionPlan: mocks.plan, getSandboxGeneration: () => "generation" }));
vi.mock("../../permissions/sandbox-process-home.js", () => ({ createSandboxProcessHome: mocks.home }));
vi.mock("../../permissions/sandbox-action-directory.js", () => ({ isSandboxActionDirectory: () => true, releaseSandboxActionDirectory: mocks.actionRelease }));
vi.mock("../../permissions/sandbox-write-policy.js", () => ({
  buildMandatorySandboxWritePolicy: (paths: string[]) => ({ allowWrite: paths, denyWrite: [{ path: "/mandatory/control", literal: true }] }),
}));
vi.mock("../managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: mocks.admission, trackManagedChildProcess: mocks.track, forceKillManagedChildProcess: mocks.kill,
}));
vi.mock("../host-script-runtime.js", () => ({
  hostScriptRuntimePaths: () => ({ javascriptRuntime: "/host/runtime", bundledScriptsDirectory: "/protected/scripts" }),
  hostScriptInvocationReadPaths: mocks.runtimeReads,
}));
vi.mock("../../lib/shell-resolver.js", () => ({ resolveShell: () => ({ cmd: "/bin/bash" }), shellQuote: (s: string) => `'${s.replaceAll("'", "'\\''")}'` }));
vi.mock("../../tools/mxc-shell-launch.js", () => ({ prepareMxcShellLaunch: mocks.prepareMxc }));

import { egressInvocationOwner, liveEgressInvocationCount } from "../../permissions/egress-invocations.js";
import { runWorkbookScript } from "../bundled-script-execution.js";

class DocumentChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  finish(code = 0): void { this.exitCode = code; this.emit("close", code, null); }
}

let directory: string;
let homePath: string;
let child: DocumentChild;
beforeEach(() => {
  vi.clearAllMocks();
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-workbook-runner-")));
  homePath = realpathSync(mkdtempSync(join(tmpdir(), "ave-workbook-home-")));
  writeFileSync(join(directory, "workbook.xlsx"), "workbook");
  writeFileSync(join(directory, "request.json"), "{}");
  child = new DocumentChild();
  mocks.spawn.mockReturnValue(child);
  mocks.active.mockReturnValue(true);
  mocks.runtimeReads.mockReturnValue(["/host/runtime", "/host", "/protected/scripts/edit-xlsx.cjs"]);
  mocks.plan.mockReturnValue({ mode: "asrt", sandboxed: true, substrate: "asrt", identity: "plan",
    capability: { confidence: "verified", confines: { filesystem: true, process: true, network: true } } });
  mocks.home.mockReturnValue({ path: homePath, env: { HOME: homePath }, cleanup: mocks.homeCleanup });
  mocks.wrap.mockResolvedValue({ argv: ["/native/wrapper", "wrapped"], env: { MALICIOUS_SECRET: "never-forward" } });
  mocks.kill.mockResolvedValue(undefined);
  mocks.prepareMxc.mockResolvedValue({ argv: ["C:\\host\\launcher.exe", "request"], release: mocks.releaseMxc });
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(homePath, { recursive: true, force: true });
  expect(liveEgressInvocationCount()).toBe(0);
});

async function started(): Promise<void> {
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
}

describe("bundled document execution", () => {
  it("uses fixed host argv, private write roots, all floors and a user action owner", async () => {
    const running = runWorkbookScript(directory, "inspect");
    await started();
    const [command, options] = mocks.wrap.mock.calls[0]!;
    expect(command).toContain("'/host/runtime' '/protected/scripts/edit-xlsx.cjs' '--inspect'");
    expect(command).toContain(`'${join(directory, "workbook.xlsx")}' '${join(directory, "request.json")}'`);
    expect(command).toContain(`'TMPDIR=${join(homePath, "tmp")}'`);
    expect(options.filesystem).toEqual({
      allowWrite: [directory, homePath], allowRead: [directory, homePath, "/host/runtime", "/host", "/protected/scripts/edit-xlsx.cjs"],
      denyRead: ["/protected/secrets", "/private/homes", "/custom/private"],
      denyWrite: ["/protected/scripts", "/protected/runtime", "/mandatory/control"], floorPierces: [], pinWriteRoots: true,
    });
    expect(egressInvocationOwner(options.commandId)).toEqual({ kind: "user-document", action: "workbook" });
    const spawnOptions = mocks.spawn.mock.calls[0]![2];
    expect(spawnOptions).toMatchObject({ shell: false, cwd: directory,
      env: { ELECTRON_RUN_AS_NODE: "1", HOME: homePath } });
    expect(spawnOptions.env.MALICIOUS_SECRET).toBeUndefined();
    expect(mocks.homeCleanup).not.toHaveBeenCalled();
    child.stdout.emit("data", Buffer.from('{"value":12,"formula":false}'));
    child.finish();
    await expect(running).resolves.toEqual({ stdout: '{"value":12,"formula":false}' });
    expect(mocks.kill).toHaveBeenCalled();
    expect(mocks.homeCleanup).toHaveBeenCalledOnce();
  });

  it.each(["plain", "blocked"])("fails closed on the %s route", async mode => {
    mocks.plan.mockReturnValue({ mode, sandboxed: false });
    await expect(runWorkbookScript(directory, "edit")).rejects.toThrow("confinement is unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.home).not.toHaveBeenCalled();
  });

  it("refuses an unverified bundle without spawning", async () => {
    mocks.runtimeReads.mockReturnValue([]);
    await expect(runWorkbookScript(directory, "edit")).rejects.toThrow("integrity failed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses stale capability state when the native runtime is inactive", async () => {
    mocks.active.mockReturnValue(false);
    await expect(runWorkbookScript(directory, "edit")).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not fall back when native wrapping fails", async () => {
    mocks.wrap.mockRejectedValue(new Error("native policy rejected"));
    await expect(runWorkbookScript(directory, "edit")).rejects.toThrow("native policy rejected");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.homeCleanup).toHaveBeenCalledOnce();
  });

  it("terminates a child when process registration fails and waits for close", async () => {
    mocks.track.mockImplementationOnce(() => { throw new Error("registration failed"); });
    const running = runWorkbookScript(directory, "edit");
    const result = expect(running).rejects.toThrow("registration failed");
    await started();
    expect(mocks.kill).toHaveBeenCalled();
    expect(mocks.homeCleanup).not.toHaveBeenCalled();
    child.finish(1);
    await result;
    expect(mocks.homeCleanup).toHaveBeenCalledOnce();
  });

  it("retains resources for an uncertain descendant group and releases them only after absence", async () => {
    Object.defineProperty(child, "pid", { value: 43210 });
    let groupPresent = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid !== -43210) throw new Error("Unexpected process probe");
      if (groupPresent) return true;
      throw Object.assign(new Error("group is gone"), { code: "ESRCH" });
    });
    try {
      const running = runWorkbookScript(directory, "edit");
      const result = expect(running).rejects.toMatchObject({ code: "execution", cleanupUnproven: true });
      await started();
      vi.useFakeTimers();
      child.finish();
      await vi.advanceTimersByTimeAsync(1500);
      await result;
      expect(mocks.homeCleanup).not.toHaveBeenCalled();
      expect(mocks.actionRelease).not.toHaveBeenCalled();
      expect(liveEgressInvocationCount()).toBe(1);
      groupPresent = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.homeCleanup).toHaveBeenCalledOnce();
      expect(mocks.actionRelease).toHaveBeenCalledWith(directory);
      expect(liveEgressInvocationCount()).toBe(0);
    } finally { vi.useRealTimers(); kill.mockRestore(); }
  });

  it("kills cancellation and retains resources until close and drain", async () => {
    const controller = new AbortController();
    const running = runWorkbookScript(directory, "edit", controller.signal);
    const result = expect(running).rejects.toThrow("cancelled");
    await started();
    controller.abort();
    expect(mocks.kill).toHaveBeenCalled();
    expect(mocks.homeCleanup).not.toHaveBeenCalled();
    expect(liveEgressInvocationCount()).toBe(1);
    child.finish(1);
    await result;
    expect(mocks.homeCleanup).toHaveBeenCalledOnce();
  });

  it("bounds cancellation when the child never closes and retains authority until eventual closure", async () => {
    const controller = new AbortController();
    const running = runWorkbookScript(directory, "edit", controller.signal);
    const result = expect(running).rejects.toMatchObject({
      code: "execution", cleanupUnproven: true, message: "Document process closure is unproven",
    });
    await started();
    vi.useFakeTimers();
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(1500);
      await result;
      expect(mocks.kill).toHaveBeenCalled();
      expect(mocks.homeCleanup).not.toHaveBeenCalled();
      expect(mocks.actionRelease).not.toHaveBeenCalled();
      expect(liveEgressInvocationCount()).toBe(1);
      child.finish(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.homeCleanup).toHaveBeenCalledOnce();
      expect(mocks.actionRelease).toHaveBeenCalledWith(directory);
      expect(liveEgressInvocationCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects bounded output overflow and waits for exit", async () => {
    const running = runWorkbookScript(directory, "edit");
    const result = expect(running).rejects.toThrow("output limit exceeded");
    await started();
    child.stderr.emit("data", Buffer.alloc(256 * 1024));
    expect(mocks.homeCleanup).not.toHaveBeenCalled();
    child.finish(1);
    await result;
  });

  it("preserves split UTF-8 and accepts the largest escaped cell descriptor", async () => {
    const running = runWorkbookScript(directory, "inspect");
    await started();
    const bytes = Buffer.from(JSON.stringify({ value: "한" + "\u0001".repeat(32766), formula: false }));
    child.stdout.emit("data", bytes.subarray(0, 11));
    child.stdout.emit("data", bytes.subarray(11));
    child.finish();
    expect(JSON.parse((await running).stdout)).toEqual({ value: "한" + "\u0001".repeat(32766), formula: false });
  });

  it("uses only the native container launcher on an eligible Windows route", async () => {
    const previousPlatform = process.platform;
    setProcessPlatform("win32");
    mocks.plan.mockReturnValue({ mode: "asrt", sandboxed: true, substrate: "mxc", identity: "plan",
      capability: { confidence: "verified", confines: { filesystem: true, process: true, network: true } } });
    try {
      const running = runWorkbookScript(directory, "inspect");
      await started();
      expect(mocks.wrap).not.toHaveBeenCalled();
      expect(mocks.prepareMxc.mock.calls[0]![0].commandLine).toContain('"/host/runtime" "/protected/scripts/edit-xlsx.cjs" "--inspect"');
      expect(mocks.spawn.mock.calls[0]![0]).toBe("C:\\host\\launcher.exe");
      expect(mocks.releaseMxc).not.toHaveBeenCalled();
      child.finish();
      await running;
      expect(mocks.releaseMxc).toHaveBeenCalledOnce();
    } finally { setProcessPlatform(previousPlatform); }
  });

  it("rejects a nonzero child without exposing its diagnostics", async () => {
    const running = runWorkbookScript(directory, "edit");
    const result = expect(running).rejects.toThrow("Bundled workbook command failed");
    await started();
    child.stderr.emit("data", Buffer.from("private failure details"));
    child.finish(2);
    await result;
  });
});
