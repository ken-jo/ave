import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ warn, info: vi.fn() }) }));
import {
  __resetManagedChildProcessesForTest,
  forceKillAndDrainManagedChildProcesses,
  forceKillManagedChildProcess,
  forceKillManagedChildProcesses,
  getManagedChildProcessCount,
  trackManagedChildProcess,
} from "../managed-child-processes.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let runners: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }>;

function makeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 4321, exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.useFakeTimers();
  runners = [];
  vi.mocked(spawn).mockImplementation(() => {
    const runner = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    runners.push(runner);
    return runner as unknown as ChildProcess;
  });
  vi.mocked(spawnSync).mockReturnValue({ status: 1, signal: null } as ReturnType<typeof spawnSync>);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetManagedChildProcessesForTest();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Windows managed process tree termination", () => {
  it("waits for a slow successful tree kill without blocking timers or killing the root first", async () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    const completion = forceKillManagedChildProcess(child, "cancelled");
    expect(spawn).toHaveBeenCalledWith(
      win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", "4321", "/T", "/F"],
      expect.objectContaining({ windowsHide: true, shell: false }),
    );
    expect(spawnSync).not.toHaveBeenCalled();
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(timerRan).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(runners[0]!.kill).not.toHaveBeenCalled();
    expect(getManagedChildProcessCount()).toBe(1);
    runners[0]!.emit("exit", 0, null);
    await completion;
    expect(child.kill).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["non-zero", "budget exceeded"])("retries the tree before the root when taskkill reports %s", async (failure) => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    expect(runners).toHaveLength(1);
    if (failure === "non-zero") {
      await vi.advanceTimersByTimeAsync(1_500);
      runners[0]!.emit("exit", 5, null);
    } else {
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      pid: 4321,
      exitCode: failure === "non-zero" ? 5 : null,
      signal: failure === "non-zero" ? null : "SIGKILL",
      elapsedMs: failure === "non-zero" ? 1_500 : TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs,
      budgetExceeded: failure !== "non-zero",
    }), expect.any(String));
    expect(runners).toHaveLength(2);
    expect(child.kill).not.toHaveBeenCalled();
    runners[1]!.emit("exit", 5, null);
    await completion;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("does not retry or warn when taskkill finds the root already gone", async () => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    runners[0]!.emit("exit", 128, null);
    await completion;
    expect(runners).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it.each(["exitCode", "signalCode"])("does not reuse a root pid after %s is set between tree passes", async (field) => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    Object.assign(child, { [field]: field === "exitCode" ? 1 : "SIGTERM" });
    runners[0]!.emit("exit", 5, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(runners).toHaveLength(1);
    await completion;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not directly kill a root that exits during the final tree pass", async () => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    runners[0]!.emit("exit", 5, null);
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(child, { exitCode: 1 });
    runners[1]!.emit("exit", 5, null);
    await completion;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("drains only after asynchronous tree termination finishes", async () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    let drained = false;
    const completion = forceKillAndDrainManagedChildProcesses("shutdown").then((result) => {
      drained = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(drained).toBe(false);
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);
    runners[0]!.emit("exit", 0, null);
    await expect(completion).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
  });

  it("keeps emergency cleanup synchronous with one bounded tree pass before the root", () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    expect(forceKillManagedChildProcesses("emergency")).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    // The sweep runs per child after the shutdown deadline, so it gets one pass.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("shares one emergency tree-kill budget and directly kills the remaining children", () => {
    const children = [makeChild(), makeChild(), makeChild()];
    children.forEach((child, index) => {
      Object.assign(child, { pid: 4321 + index });
      trackManagedChildProcess(child);
    });
    const timeouts: number[] = [];
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const timeout = options?.timeout ?? 0;
      timeouts.push(timeout);
      vi.setSystemTime(Date.now() + timeout);
      return { status: 1, signal: null } as ReturnType<typeof spawnSync>;
    });

    expect(forceKillManagedChildProcesses("emergency")).toBe(3);

    expect(timeouts).toEqual([TOOL_TIMEOUT_POLICY.windowsEmergencyProcessSweepMs]);
    expect(timeouts.reduce((total, timeout) => total + timeout, 0))
      .toBeLessThanOrEqual(TOOL_TIMEOUT_POLICY.windowsEmergencyProcessSweepMs);
    expect(children.every((child) => vi.mocked(child.kill).mock.calls.length === 1)).toBe(true);
    expect(getManagedChildProcessCount()).toBe(0);
    expect(warn.mock.calls.filter(([, message]) => message === "shutdown: managed child tree-kill budget exhausted"))
      .toEqual([[{ reason: "emergency", directChildCount: 2 }, "shutdown: managed child tree-kill budget exhausted"]]);
  });

  it("passes only the remaining emergency budget after earlier sweep work", () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(0).mockReturnValue(250);
    try {
      forceKillManagedChildProcesses("emergency");
      expect(spawnSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
        timeout: TOOL_TIMEOUT_POLICY.windowsEmergencyProcessSweepMs - 250,
      }));
    } finally {
      clock.mockRestore();
    }
  });

  it("does not directly kill a root that exits during the synchronous tree pass", () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    vi.mocked(spawnSync).mockImplementation(() => {
      Object.assign(child, { exitCode: 1 });
      return { status: 1, signal: null } as ReturnType<typeof spawnSync>;
    });
    expect(forceKillManagedChildProcesses("emergency")).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds both attempts even when neither runner emits exit", async () => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs * 2);
    await completion;
    expect(runners).toHaveLength(2);
    expect(runners.every((runner) => runner.kill.mock.calls.length === 1)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a successful second tree pass without a direct-child fallback", async () => {
    const child = makeChild();
    const completion = forceKillManagedChildProcess(child, "cancelled");
    runners[0]!.emit("exit", 5, null);
    await vi.advanceTimersByTimeAsync(0);
    runners[1]!.emit("exit", 0, null);
    await completion;
    expect(child.kill).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares an in-flight kill with repeated cancellation and shutdown after root exit", async () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    const completion = forceKillManagedChildProcess(child, "first cancellation");
    const repeated = forceKillManagedChildProcess(child, "second cancellation");
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);
    const drain = forceKillAndDrainManagedChildProcesses("shutdown");
    runners[0]!.emit("exit", 0, null);
    await completion;
    await repeated;
    await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("shares a drain-initiated kill with a later cancellation", async () => {
    const child = makeChild();
    trackManagedChildProcess(child);
    const drain = forceKillAndDrainManagedChildProcesses("shutdown");
    const cancellation = forceKillManagedChildProcess(child, "cancelled");
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);
    runners[0]!.emit("exit", 0, null);
    await cancellation;
    await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("handles spawn errors and a denied direct-child kill without rejection leaks", async () => {
    const child = makeChild();
    vi.mocked(child.kill).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    const completion = forceKillManagedChildProcess(child, "cancelled");
    runners[0]!.emit("error", new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    runners[1]!.emit("error", new Error("unavailable"));
    await expect(completion).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pid: 4321, code: "EPERM" }), "managed-child: force kill failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
