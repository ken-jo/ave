import { once } from "node:events";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forceKillManagedChildProcess, spawnManaged } from "../managed-child-processes.js";

const treeKill = vi.hoisted(() => ({ delayed: false, exercised: false, status: undefined as number | null | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}) => {
      if (command !== "taskkill" || !treeKill.delayed) return actual.spawnSync(command, args, options);
      treeKill.exercised = true;
      const pid = args[1];
      if (!pid || !/^\d+$/u.test(pid)) throw new Error("Expected an owned process id");
      const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const result = actual.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
        Start-Sleep -Milliseconds 1500
        & (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID ${pid} /T /F
        exit $LASTEXITCODE
      `], options);
      treeKill.status = result.status;
      return result;
    }),
  };
});

afterEach(() => {
  treeKill.delayed = false;
  treeKill.exercised = false;
  treeKill.status = undefined;
});

describe.skipIf(process.platform !== "win32")("managed child tree termination", () => {
  it("finishes a delayed tree kill before falling back to the root", async () => {
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    const child = spawnManaged(node, ["-e", `
      const { spawn } = require("node:child_process");
      const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
        stdio: "ignore", windowsHide: true,
      });
      worker.once("spawn", () => process.stdout.write(String(worker.pid)));
      setTimeout(() => {}, 15000);
    `], { stdio: ["ignore", "pipe", "ignore"] }, { label: "tree-termination-fixture" });
    const closed = once(child, "close");
    let output = "";
    let workerPid: number | undefined;
    let workerGone = false;
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await vi.waitFor(() => {
        workerPid = Number(output);
        expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
      }, { timeout: 5_000 });
      expect(process.kill(workerPid!, 0)).toBe(true);
      treeKill.delayed = true;

      forceKillManagedChildProcess(child, "cancel-tree-fixture");

      expect(treeKill.exercised).toBe(true);
      await vi.waitFor(() => {
        expect(() => process.kill(workerPid!, 0)).toThrow();
        workerGone = true;
      }, { timeout: 3_000 });
      await closed;
      expect(treeKill.status).toBe(0);
    } finally {
      treeKill.delayed = false;
      // Only the fixture's still-owned process ids are eligible for cleanup.
      if (!workerGone && workerPid !== undefined && workerPid > 0) {
        spawnSync("taskkill", ["/PID", String(workerPid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true, timeout: 10_000,
        });
      }
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true, timeout: 10_000,
        });
      }
      await closed;
    }
  }, 30_000);
});
