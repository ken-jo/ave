vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
const installationMock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../shared/powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: installationMock.resolve }));
const mxcLaunchMock = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: childProcessMock.spawn,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => String(args[0]).endsWith("ave-path-kind.exe")
      ? Reflect.apply(actual.execFileSync, undefined, args) : Reflect.apply(childProcessMock.execFileSync, undefined, args),
  };
});
vi.mock("../mxc-shell-launch.js", () => ({ prepareMxcShellLaunch: mxcLaunchMock.prepare }));
// Mock Windows profile creation on POSIX so backslash paths cannot become entries in the working tree.
vi.mock("../../permissions/sandbox-process-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../permissions/sandbox-process-home.js")>();
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    ...actual,
    createSandboxProcessHome: () => {
      const home = mkdtempSync(join(tmpdir(), "ave-mxc-test-home-"));
      return {
        path: home,
        env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), TEMP: join(home, "tmp"), TMP: join(home, "tmp") },
        cleanup: () => rmSync(home, { recursive: true, force: true }),
      };
    },
  };
});

import { BashTool, PowerShellTool } from "../shell-tools.js";
import { MAX_POWERSHELL_PARSER_RESPONSE_BYTES } from "../powershell-parser-response.js";
import type { ToolExecutionContext } from "../types.js";
import { MXC_BASH_UNAVAILABLE_MESSAGE, rankMxcFilesystem } from "../../permissions/mxc-windows.js";
import { permissionsFilePath } from "../../permissions/permissions-store.js";
import { userApprovalFilePath } from "../../permissions/user-approval-store.js";
import { egressGrantFilePath } from "../../permissions/egress-grants.js";
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
const PARSER_REQUEST = "eyJwYXJzZXIiOnRydWV9";

function isParserLaunch(input: { commandLine: string }): boolean {
  const encoded = input.commandLine.split(" ").at(-1)!;
  return Buffer.from(encoded, "base64").toString("utf16le")
    .includes("[System.Management.Automation.Language.Parser]::ParseInput");
}

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
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    installationMock.resolve.mockReturnValue({ executable: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, kind: "windows-powershell" });
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockImplementation((_file, args: readonly string[]) =>
      args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
    childProcessMock.spawn.mockImplementation((_command: string, args: readonly string[], options?: { stdio?: unknown }) => {
      const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
      return parser || args.includes(PARSER_REQUEST) ? fakeChild(PARSED, 0) : fakeChild(`${CONTAINER_OUTPUT}\n`, 0);
    });
    mxcLaunchMock.prepare.mockImplementation(async (input: { commandLine: string }) => ({
      argv: [WXC_EXEC, "--config-base64", isParserLaunch(input) ? PARSER_REQUEST : "eyJ9"],
      proxyPort: 51234,
      release: mxcLaunchMock.release,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    __resetShellResolverCache();
    setProcessPlatform(ORIGINAL_PLATFORM);
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
    mxcLaunchMock.prepare.mockReset();
    mxcLaunchMock.release.mockClear();
    installationMock.resolve.mockReset();
  });

  it("runs a PowerShell command through wxc-exec with this invocation's token and closes its listener after", async () => {
    bootMxcShells();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-workspace-")));
    const result = await new PowerShellTool().execute(
      { command: "Write-Output hi", timeoutSeconds: 7 }, { ...context("ps-mxc-1"), cwd },
    ).finally(() => rmSync(cwd, { recursive: true, force: true }));

    expect(result).toMatchObject({ isError: false, metadata: { returncode: 0, sandboxed: true } });
    expect(result.output).toContain(CONTAINER_OUTPUT);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(2);
    const [parserLaunch] = mxcLaunchMock.prepare.mock.calls[0] as [{ commandLine: string }];
    expect(isParserLaunch(parserLaunch)).toBe(true);
    const [launch] = mxcLaunchMock.prepare.mock.calls[1] as [Record<string, unknown>];
    for (const [prepared] of mxcLaunchMock.prepare.mock.calls as [{ commandLine: string; env: Record<string, string> }][]) {
      const script = Buffer.from(prepared.commandLine.split(" ").at(-1)!, "base64").toString("utf16le");
      expect(prepared.commandLine).toContain("-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -EncodedCommand");
      expect(script).toContain("$PSModuleAutoLoadingPreference = 'None'");
      expect(script).toContain("[System.IO.Path]::Combine($PSHOME, 'Modules')");
      expect(script).toContain("Microsoft.PowerShell.Core\\Import-Module -Name");
      expect(prepared.env.PSModulePath).toBe("");
    }
    expect(launch["egressToken"]).toEqual(expect.any(String));
    expect(launch["commandLine"]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe.* -EncodedCommand /);
    expect(launch["cwd"]).toBe(cwd);
    expect(launch["timeoutMs"]).toBe(7000);
    const filesystem = launch["filesystem"] as { allowWrite: string[]; denyWrite: string[] };
    expect(filesystem.allowWrite.length).toBeGreaterThanOrEqual(2);
    expect(filesystem.denyWrite.length).toBeGreaterThan(0);
    // The child's environment is secret-stripped and carries no proxy of its own.
    const env = launch["env"] as Record<string, string>;
    for (const key of Object.keys(env)) expect(key.toLowerCase()).not.toMatch(/_proxy$/);

    expect(childProcessMock.spawn.mock.calls.every((call) => call[0] === WXC_EXEC)).toBe(true);
    const containerSpawn = childProcessMock.spawn.mock.calls.find((call) => call[0] === WXC_EXEC && (call[1] as string[]).at(-1) === "eyJ9");
    if (containerSpawn === undefined) throw new Error("wxc-exec was not spawned");
    expect(containerSpawn[1]).toEqual(["--config-base64", "eyJ9"]);
    expect(containerSpawn[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // The launcher runs from its own directory; the container cwd is in the request.
    expect((containerSpawn[2] as { cwd?: string }).cwd).toBe(String.raw`C:\Program Files\Ave\resources\mxc\x64`);
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
  });

  it("keeps a large parser protocol response independent of the display preview", async () => {
    bootMxcShells();
    const command = "Write-Output a;".repeat(100);
    const parsedCommand = {
      name: "Write-Output", text: "Write-Output a",
      arguments: [{ kind: "literal", text: "Write-Output", value: "Write-Output" }, { kind: "literal", text: "a", value: "a" }],
    };
    const response = JSON.stringify({ commands: Array.from({ length: 100 }, () => parsedCommand), errors: [], redirections: [], unsupported: [] });
    expect(response.length).toBe(16_861);
    childProcessMock.spawn.mockImplementation((_command: string, args: readonly string[]) =>
      fakeChild(args.includes(PARSER_REQUEST) ? response : CONTAINER_OUTPUT, 0));
    const result = await new PowerShellTool().execute({ command, timeoutSeconds: 7 }, context("large-parser-response"));
    expect(result, result.output).toMatchObject({ isError: false, metadata: { returncode: 0, sandboxed: true } });
    expect(result.output).toBe(CONTAINER_OUTPUT);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(2);
  });

  it("refuses an oversized internal response before launching caller text", async () => {
    bootMxcShells();
    childProcessMock.spawn.mockImplementation(() => fakeChild(" ".repeat(MAX_POWERSHELL_PARSER_RESPONSE_BYTES + 1), 0));
    const result = await new PowerShellTool().execute({ command: "Write-Output a;".repeat(100), timeoutSeconds: 7 }, context("oversized-parser-response"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("PowerShell parser response exceeds the internal byte limit");
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(1);
  });

  it("refuses an untrusted image before preparing either parser or caller container", async () => {
    bootMxcShells();
    installationMock.resolve.mockReturnValue(null);
    const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("missing-trusted-image"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("trusted system installation is unavailable");
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it("gives the container the mandatory write floor: workspace control files and Ave's stores stay unwritable", async () => {
    const { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-floor-")));
    try {
      mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
      writeFileSync(join(workspace, ".git", "config"), "[core]\n");
      mkdirSync(join(workspace, ".vscode"));
      bootMxcShells();
      const result = await new PowerShellTool().execute(
        { command: "Write-Output hi", timeoutSeconds: 7 },
        { ...context("ps-mxc-floor"), cwd: workspace, extraAllowedDirectories: [workspace] },
      );
      expect(result.isError).toBe(false);
      const [launch] = mxcLaunchMock.prepare.mock.calls[0] as [{ filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[]; denyRead: string[]; floorPierces?: string[] } }];
      const { filesystem } = launch;
      expect(filesystem.allowWrite).toContain(workspace);
      // Git metadata remains writable; execution controls do not.
      for (const entry of [join(".git", "hooks"), join(".git", "config"), ".vscode", ".husky", join(".claude", "settings.json"), ".envrc"]) {
        expect(filesystem.denyWrite, entry).toContain(join(workspace, entry));
      }
      for (const store of [permissionsFilePath(), userApprovalFilePath(), egressGrantFilePath()]) {
        expect(filesystem.denyWrite, store).toContain(store);
      }
      // Windows keeps denied workspace controls read-only when present and denied when absent.
      if (process.platform === "win32" && ORIGINAL_PLATFORM === "win32") {
        const grants = rankMxcFilesystem({ ...filesystem, protectedFloor: [] }, existsSync);
        // Compare Windows paths case-insensitively, including canonical drive letters.
        const folded = (paths: readonly string[]) => paths.map((path) => path.toLowerCase());
        expect(folded(grants.readwrite)).toContain(workspace.toLowerCase());
        expect(folded(grants.readonly)).toEqual(expect.arrayContaining(folded([join(workspace, ".git", "hooks"), join(workspace, ".vscode")])));
        expect(folded(grants.denied)).toEqual(expect.arrayContaining(folded([join(workspace, ".husky"), join(workspace, ".envrc")])));
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports a launch that cannot be prepared as unsandboxed and spawns nothing", async () => {
    bootMxcShells();
    mxcLaunchMock.prepare.mockRejectedValueOnce(new Error("the sandbox proxy is not running"));
    const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("ps-mxc-2"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toContain("the sandbox proxy is not running");
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });

  it("refuses a missing system root before preparing or spawning a container", async () => {
    bootMxcShells();
    const roots = ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"];
    const previous = roots.map(key => process.env[key]);
    try {
      for (const key of roots) vi.stubEnv(key, undefined);
      const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("missing-system-root"));
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/system root/i);
      expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
      expect(childProcessMock.spawn.mock.calls.some(call => call[0] === WXC_EXEC)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      roots.forEach((key, index) => { if (previous[index] !== undefined) process.env[key] = previous[index]; });
    }
  });

  it("releases the listener when the launcher fails to spawn and never closes", async () => {
    bootMxcShells();
    childProcessMock.spawn.mockImplementation((command: string, args: readonly string[], options?: { stdio?: unknown }) => {
      if (args.includes(PARSER_REQUEST)) return fakeChild(PARSED, 0);
      if (command !== WXC_EXEC) {
        const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
        return fakeChild(parser ? PARSED : "", 0);
      }
      // ENOENT-style failure: no pid, an "error" and no "close".
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: undefined, kill: vi.fn(() => false) });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn wxc-exec.exe ENOENT"), { code: "ENOENT" })));
      return child;
    });
    const result = await new PowerShellTool().execute({ command: "Write-Output hi", timeoutSeconds: 7 }, context("ps-mxc-enoent"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toContain("ENOENT");
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
  });

  it("keeps a running launcher's abort watch after an error and releases only on close", async () => {
    bootMxcShells();
    let launcher: (EventEmitter & Record<string, unknown>) | undefined;
    childProcessMock.spawn.mockImplementation((command: string, args: readonly string[], options?: { stdio?: unknown }) => {
      if (args.includes(PARSER_REQUEST)) return fakeChild(PARSED, 0);
      if (command !== WXC_EXEC) {
        const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
        return fakeChild(parser ? PARSED : "", 0);
      }
      // A running child (it has a pid) that reports an error and keeps running.
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 4242, kill: vi.fn(() => true) });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
      launcher = child;
      return child;
    });
    const abort = new AbortController();
    const result = await new PowerShellTool().execute(
      { command: "Write-Output hi", timeoutSeconds: 30 },
      { ...context("ps-mxc-running-error"), abortSignal: abort.signal },
    );
    expect(result.isError).toBe(true);
    // A still-running errored child must retain its resources and abort watch.
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(1);
    abort.abort();
    expect((launcher!["stdout"] as PassThrough).destroyed).toBe(true);
    launcher!["exitCode"] = 1;
    launcher!.emit("exit", 1, null);
    launcher!.emit("close", 1, null);
    await vi.waitFor(() => expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2));
  });

  it("refuses a sandboxed Bash command with the PowerShell guidance instead of running it", async () => {
    bootMxcShells();
    const result = await new BashTool().execute({ command: "echo hi", timeoutSeconds: 7 }, context("bash-mxc"));
    expect(result).toMatchObject({ isError: true, output: MXC_BASH_UNAVAILABLE_MESSAGE, metadata: { sandboxed: false } });
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });
});
