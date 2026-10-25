import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { terminateChildProcess } from "../terminate-child-process.js";

function fakeChild(): {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
} {
  const kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>();
  const child = {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill,
  };
  child.kill.mockImplementation(() => {
    // Match Node: this flips when a signal is sent, not when the child exits.
    child.killed = true;
    return true;
  });
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminateChildProcess", () => {
  it("signals a detached process group and escalates while the process remains alive", () => {
    vi.useFakeTimers();
    const platform = process.platform;
    setProcessPlatform("linux");
    const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const child = { ...fakeChild(), pid: 4242 };
      terminateChildProcess(child, 25, { processGroup: true });
      expect(killGroup).toHaveBeenCalledWith(-4242, "SIGTERM");
      vi.advanceTimersByTime(25);
      expect(killGroup).toHaveBeenLastCalledWith(-4242, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    } finally { killGroup.mockRestore(); setProcessPlatform(platform); }
  });

  it("uses child signaling when the process group is already unavailable", () => {
    vi.useFakeTimers();
    const platform = process.platform;
    setProcessPlatform("linux");
    const killGroup = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("missing process group"); });
    try {
      const child = { ...fakeChild(), pid: 4242 };
      terminateChildProcess(child, 25, { processGroup: true });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(25);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally { killGroup.mockRestore(); setProcessPlatform(platform); }
  });

  it("does not signal a process group on the unsupported platform", () => {
    vi.useFakeTimers();
    const platform = process.platform;
    setProcessPlatform("win32");
    const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const child = { ...fakeChild(), pid: 4242 };
      terminateChildProcess(child, 25, { processGroup: true });
      expect(killGroup).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally { killGroup.mockRestore(); setProcessPlatform(platform); }
  });

  it("sends SIGKILL when SIGTERM was delivered but the child remains alive", () => {
    vi.useFakeTimers();
    const child = fakeChild();

    terminateChildProcess(child, 25);
    expect(child.killed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("does not force-kill a child that exited normally", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateChildProcess(child, 25);
    child.exitCode = 0;

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not force-kill a child that exited from SIGTERM", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateChildProcess(child, 25);
    child.signalCode = "SIGTERM";

    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("still attempts SIGKILL when sending SIGTERM throws", () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementationOnce(() => {
      throw new Error("signal delivery failed");
    });

    expect(() => terminateChildProcess(child, 25)).not.toThrow();
    vi.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it.skipIf(process.platform === "win32")("takes a detached child's own children down with it when asked to signal the group", async () => {
    // The shell starts a long sleep and prints its pid; only a group signal
    // reaches the sleep, because the shell does not forward SIGTERM.
    const child = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      child.once("error", reject);
    });
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    expect(alive(grandchild)).toBe(true);
    try {
      terminateChildProcess(child, 200, { processGroup: true });
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const deadline = Date.now() + 2_000;
      while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(alive(grandchild)).toBe(false);
    } finally {
      if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  });

  it("signals only the child when the group option is off", () => {
    const groupKill = vi.spyOn(process, "kill");
    try {
      const child = { ...fakeChild(), pid: 4242 };
      terminateChildProcess(child, 25);
      expect(groupKill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      groupKill.mockRestore();
    }
  });
});
