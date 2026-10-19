import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
const mxcLaunchMock = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: childProcessMock.spawn, execFileSync: childProcessMock.execFileSync };
});
vi.mock("../mxc-shell-launch.js", () => ({ prepareMxcShellLaunch: mxcLaunchMock.prepare }));

import { BashTool, PowerShellTool } from "../shell-tools.js";
import type { ToolExecutionContext } from "../types.js";
import { MXC_BASH_UNAVAILABLE_MESSAGE } from "../../permissions/mxc-windows.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";
import {
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
} from "../../boot/steps/windows-sandbox-plan.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;
const WXC_EXEC = String.raw`C:\Program Files\Ave\resources\mxc\x64\wxc-exec.exe`;
const CONTAINER_OUTPUT = "output relayed from the container";

function fakeChild(output: string, code: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin: new PassThrough(), exitCode: null, signalCode: null, pid: 4242, killed: false, kill: vi.fn(() => true) });
  queueMicrotask(() => {
    stdout.end(output);
    stderr.end();
    child["exitCode"] = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
  });
  return child;
}

const PARSED = JSON.stringify({
  errors: [], redirections: [], unsupported: [],
  commands: [{
    name: "Write-Output",
    arguments: [{ kind: "literal", text: "Write-Output", value: "Write-Output" }, { kind: "literal", text: "hi", value: "hi" }],
    text: "Write-Output hi",
  }],
});

function bootMxcShells(): void {
  setProcessPlatform("win32");
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability(windowsProxyOnlyCapability());
  const { substrate } = planWindowsSandbox({
    shellRequested: true,
    workerRequested: false,
    mxc: { state: "available" },
    windowsBuild: "10.0.26300.9711",
    srtWinReady: false,
  });
  setWindowsSandboxSubstrate(substrate, mxcShellCapability());
}

function context(toolUseId: string): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    hostShellExecutionPlan: getHostShellExecutionPlan(),
    metadata: { toolUseId },
  };
}

describe("builtin shell — Windows MXC containers", () => {
  beforeEach(() => {
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockImplementation((_file, args: readonly string[]) =>
      args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
    childProcessMock.spawn.mockImplementation((_command: string, _args: readonly string[], options?: { stdio?: unknown }) => {
      const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
      return parser ? fakeChild(PARSED, 0) : fakeChild(`${CONTAINER_OUTPUT}\n`, 0);
    });
    mxcLaunchMock.prepare.mockResolvedValue({
      argv: [WXC_EXEC, "--config-base64", "eyJ9"],
      proxyPort: 51234,
      release: mxcLaunchMock.release,
    });
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    __resetShellResolverCache();
    setProcessPlatform(ORIGINAL_PLATFORM);
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
    mxcLaunchMock.prepare.mockReset();
    mxcLaunchMock.release.mockClear();
  });

  it("runs a PowerShell command through wxc-exec with this invocation's token and closes its listener after", async () => {
    bootMxcShells();
    const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("ps-mxc-1"));

    expect(result).toMatchObject({ isError: false, metadata: { returncode: 0, sandboxed: true } });
    expect(result.output).toContain(CONTAINER_OUTPUT);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(1);
    const [launch] = mxcLaunchMock.prepare.mock.calls[0] as [Record<string, unknown>];
    expect(launch["egressToken"]).toEqual(expect.any(String));
    expect(launch["commandLine"]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe.* -EncodedCommand /);
    expect(launch["cwd"]).toBe(process.cwd());
    expect(launch["timeoutMs"]).toBe(7000);
    const filesystem = launch["filesystem"] as { allowWrite: string[]; denyWrite: string[] };
    expect(filesystem.allowWrite.length).toBeGreaterThanOrEqual(2);
    expect(filesystem.denyWrite.length).toBeGreaterThan(0);
    // The child's environment is secret-stripped and carries no proxy of its own.
    const env = launch["env"] as Record<string, string>;
    for (const key of Object.keys(env)) expect(key.toLowerCase()).not.toMatch(/_proxy$/);

    const containerSpawn = childProcessMock.spawn.mock.calls.find((call) => call[0] === WXC_EXEC);
    if (containerSpawn === undefined) throw new Error("wxc-exec was not spawned");
    expect(containerSpawn[1]).toEqual(["--config-base64", "eyJ9"]);
    expect(containerSpawn[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(1);
  });

  it("reports a launch that cannot be prepared as unsandboxed and spawns nothing", async () => {
    bootMxcShells();
    mxcLaunchMock.prepare.mockRejectedValueOnce(new Error("the sandbox proxy is not running"));
    const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("ps-mxc-2"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toContain("the sandbox proxy is not running");
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });

  it("refuses a sandboxed Bash command with the PowerShell guidance instead of running it", async () => {
    bootMxcShells();
    const result = await new BashTool().execute({ command: "echo hi", timeoutSeconds: 7 }, context("bash-mxc"));
    expect(result).toMatchObject({ isError: true, output: MXC_BASH_UNAVAILABLE_MESSAGE, metadata: { sandboxed: false } });
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });
});
