import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const reaper = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn(), shutdown: vi.fn() }));
vi.mock("../process-group-reaper.js", () => ({ createProcessGroupReaper: () => reaper }));

import { spawn } from "node:child_process";
import { __resetManagedChildProcessesForTest, getManagedChildProcessCount, spawnManaged, trackManagedChildProcess } from "../managed-child-processes.js";

afterEach(() => {
  __resetManagedChildProcessesForTest();
  reaper.retain.mockClear();
  reaper.release.mockClear();
});

describe.skipIf(process.platform === "win32")("managed child groups outlive a killed host only through the reaper", () => {
  it("hands a detached group to the reaper and takes it back once the group is gone", async () => {
    const before = getManagedChildProcessCount();
    const child = spawnManaged("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" }, { label: "host-death-fixture" });
    const pgid = child.pid!;
    const exited = once(child, "exit");
    try {
      expect(reaper.retain).toHaveBeenCalledWith(pgid);
      expect(reaper.release).not.toHaveBeenCalled();
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
    await exited;
    await vi.waitFor(() => expect(getManagedChildProcessCount()).toBe(before), { timeout: 5_000, interval: 50 });
    expect(reaper.release).toHaveBeenCalledTimes(1);
    expect(reaper.release).toHaveBeenCalledWith(pgid);
  });

  it("undoes the whole registration when the reaper refuses the group", async () => {
    const before = getManagedChildProcessCount();
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    const listeners = () => ["exit", "close", "error"].map((event) => child.listenerCount(event));
    const exited = once(child, "exit");
    const listenersBefore = listeners();
    reaper.retain.mockImplementationOnce(() => { throw new Error("[process-group-reaper] reaper was spawned without a stdin pipe"); });
    try {
      expect(() => trackManagedChildProcess(child, { killProcessGroup: true, label: "refused-fixture" })).toThrow(/without a stdin pipe/);
      expect(getManagedChildProcessCount()).toBe(before);
      expect(listeners()).toEqual(listenersBefore);
      // No owner is left to end it, so the refused child is killed rather than orphaned.
      const [, signal] = await exited;
      expect(signal).toBe("SIGKILL");
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("leaves a child that shares the host's process group to the host", async () => {
    const child = spawnManaged("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" }, { label: "same-group-fixture" });
    await once(child, "exit");
    expect(reaper.retain).not.toHaveBeenCalled();
  });
});
