import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return Object.assign(Object.create(logger) as typeof logger, { warn: (...args: unknown[]) => void warn(...args), info: (...args: unknown[]) => void info(...args) });
    },
  };
});
vi.mock("../../shared/tool-timeout-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/tool-timeout-policy.js")>();
  return { ...actual, TOOL_TIMEOUT_POLICY: { ...actual.TOOL_TIMEOUT_POLICY, windowsProcessTreeKillMs: 2_000 } };
});

import { forceKillManagedChildProcess, trackManagedChildProcess, __resetManagedChildProcessesForTest } from "../managed-child-processes.js";
import { blockMainThread } from "../../__tests__/support/block-main-thread.js";

describe.runIf(process.platform === "win32")("Windows tree kill under a blocked main thread", () => {
  afterEach(() => {
    warn.mockReset();
    info.mockReset();
    __resetManagedChildProcessesForTest();
  });

  it("does not report a taskkill that already exited as failed because its watchdog fired late", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    trackManagedChildProcess(child, { label: "starved-watchdog-sleeper" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const termination = forceKillManagedChildProcess(child, "starved watchdog");
    // taskkill (a separate process) runs and exits while the host cannot run callbacks; the 2 s watchdog expires meanwhile.
    blockMainThread(10_000);
    await termination;
    await exited;

    const failed = warn.mock.calls.filter((call) => call.includes("managed-child: taskkill /T /F failed"));
    expect(failed).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ targetPid: child.pid, elapsedMs: expect.any(Number) }), "managed-child: taskkill watchdog expired after the target exited");
    const success = info.mock.calls.find((call) => call.includes("managed-child: taskkill watchdog expired after the target exited"));
    expect(success?.[0].elapsedMs).toBeGreaterThanOrEqual(9_900);
  }, 20_000);
});
