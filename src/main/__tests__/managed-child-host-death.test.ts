import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const reaper = vi.hoisted(() => ({ retain: vi.fn(), release: vi.fn(), shutdown: vi.fn() }));
vi.mock("../process-group-reaper.js", () => ({ createProcessGroupReaper: () => reaper }));

import { __resetManagedChildProcessesForTest, getManagedChildProcessCount, spawnManaged } from "../managed-child-processes.js";

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

  it("leaves a child that shares the host's process group to the host", async () => {
    const child = spawnManaged("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" }, { label: "same-group-fixture" });
    await once(child, "exit");
    expect(reaper.retain).not.toHaveBeenCalled();
  });
});
