import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { readWindowsProcessRunStates } from "../windows-process-start-time.js";

describe.runIf(process.platform === "win32")("readWindowsProcessRunStates", () => {
  it("reports a running process with a stable start time and an exited one as gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "exit");
    const first = await readWindowsProcessRunStates([process.pid, pid, 0]);
    const second = await readWindowsProcessRunStates([process.pid]);
    const own = first.get(process.pid);
    expect(own).toEqual({ running: true, startTime: expect.stringMatching(/^[0-9]+$/) });
    expect(second.get(process.pid)).toEqual(own);
    expect(first.get(pid)).toEqual({ running: false });
    expect(first.has(0)).toBe(false);
  }, 60_000);
});
