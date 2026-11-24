import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { stopOrphanedManagedProcesses } from "../managed-child-processes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("orphaned managed processes", () => {
  it("uses one orphan poll timer capped to the remaining deadline", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0 && Date.now() === started) {
        vi.setSystemTime(started + TOOL_TIMEOUT_POLICY.orphanProcessCleanupMs - 1);
      }
      return true;
    });
    const settled = vi.fn();
    const sweep = stopOrphanedManagedProcesses([12345]).then(settled);
    expect(vi.getTimerCount()).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(false);
    expect(kill).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    await sweep;
  });

  it("allocates no orphan poll timer when the process is already gone", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Process exited"), { code: "ESRCH" });
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    await expect(stopOrphanedManagedProcesses([12345])).resolves.toBe(true);
    expect(timer).not.toHaveBeenCalled();
  });
});
