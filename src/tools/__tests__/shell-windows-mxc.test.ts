vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
const installationMock = vi.hoisted(() => ({ resolve: vi.fn() }));
const sandboxHomeMock = vi.hoisted(() => ({ onCleanup: vi.fn<(home: string) => void>() }));
vi.mock("../../shared/powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: installationMock.resolve }));
const mxcLaunchMock = vi.hoisted(() => ({
  prepare: vi.fn(),
  activate: vi.fn(),
  bindChild: vi.fn(),
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
        cleanup: () => {
          rmSync(home, { recursive: true, force: true });
          sandboxHomeMock.onCleanup(home);
        },
      };
    },
  };
});

import { BashTool, PowerShellTool } from "../shell-tools.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../agent-observation-context.js";
import { setAgentTerminalObservationSink } from "../agent-terminal-observation.js";
import { MAX_POWERSHELL_PARSER_RESPONSE_BYTES } from "../powershell-parser-response.js";
import type { ToolExecutionContext } from "../types.js";
import { MXC_BASH_UNAVAILABLE_MESSAGE, rankMxcFilesystem } from "../../permissions/mxc-windows.js";
import { permissionsFilePath } from "../../permissions/permissions-store.js";
import { userApprovalFilePath } from "../../permissions/user-approval-store.js";
import { egressGrantFilePath } from "../../permissions/egress-grants.js";
import * as egressHostListener from "../../permissions/egress-host-listener.js";
import { egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation } from "../../permissions/egress-invocations.js";
import * as mxcWindows from "../../permissions/mxc-windows.js";
import * as mxcPolicyPipe from "../../permissions/mxc-policy-pipe.js";
import * as asrtSandbox from "../../permissions/asrt-sandbox.js";
import * as chatOrigin from "../../shared/chat-origin.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setWindowsSandboxSubstrate,
  setWindowsShellLocalNetworkAccess,
} from "../../permissions/sandbox-capability.js";
import {
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
} from "../../boot/steps/windows-sandbox-plan.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { deferred } from "../../__tests__/support/deferred.js";
import type { PrepareMxcShellLaunchInput } from "../mxc-shell-launch.js";
import type { ContainedShellLifecycle } from "../contained-shell-lifecycle.js";
import * as powerShellLaunch from "../powershell-launch.js";
import { POWERSHELL_EGRESS_PROXY_PRELUDE } from "../powershell-launch.js";

const ORIGINAL_PLATFORM = process.platform;
const WXC_EXEC = String.raw`C:\Program Files\Ave\resources\mxc\x64\wxc-exec.exe`;
const FIXTURE_WORKSPACE = String.raw`C:\ave-fixture\workspace`;
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

function childWithSpawnError(error: Error): EventEmitter {
  // A failed spawn can emit an error with no pid or close event.
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: undefined, kill: vi.fn(() => false) });
  queueMicrotask(() => child.emit("error", error));
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
    shellRequested: true, shellLocalNetworkAccess: true,
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

function executePowerShell(toolContext: ToolExecutionContext, command = "Write-Output hi") {
  return new PowerShellTool().execute({ command, timeoutSeconds: 7 }, toolContext);
}

describe("builtin shell — Windows MXC containers", () => {
  it("never prepares an MXC parser or command with local-network access off", async () => {
    bootMxcShells();
    setWindowsShellLocalNetworkAccess(false);
    const result = await executePowerShell(context("local-network-off"));
    expect(result.isError).toBe(true);
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "plain", sandboxed: false, requiresExplicitUserApproval: true });
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
    expect(childProcessMock.spawn.mock.calls.some(([file]) => file === WXC_EXEC)).toBe(false);
  });

  it("refuses a prepared parser when consent is disabled before native spawn", async () => {
    bootMxcShells();
    const prepare = mxcLaunchMock.prepare.getMockImplementation();
    if (!prepare) throw new Error("Container preparation fixture is unavailable");
    mxcLaunchMock.prepare.mockImplementation(async (input, lifecycle) => {
      const launch = await prepare(input, lifecycle);
      setWindowsShellLocalNetworkAccess(false);
      return launch;
    });
    const result = await executePowerShell(context("local-network-disabled-during-parser"));
    expect(result.isError).toBe(true);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledOnce();
    expect(childProcessMock.spawn.mock.calls.some(([file]) => file === WXC_EXEC)).toBe(false);
    expect(mxcLaunchMock.release).toHaveBeenCalledOnce();
  });

  it("refuses the command when consent is disabled after its parser completed", async () => {
    bootMxcShells();
    const prepare = mxcLaunchMock.prepare.getMockImplementation();
    if (!prepare) throw new Error("Container preparation fixture is unavailable");
    mxcLaunchMock.prepare.mockImplementation(async (input, lifecycle) => {
      const launch = await prepare(input, lifecycle);
      if (!isParserLaunch(input)) setWindowsShellLocalNetworkAccess(false);
      return launch;
    });
    const result = await executePowerShell(context("local-network-disabled-before-command"));
    expect(result.isError).toBe(true);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(2);
    expect(childProcessMock.spawn.mock.calls.filter(([file]) => file === WXC_EXEC)).toHaveLength(1);
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
  });

  it("does not restore an old parser admission after consent is switched off and on", async () => {
    bootMxcShells();
    const prepare = mxcLaunchMock.prepare.getMockImplementation();
    if (!prepare) throw new Error("Container preparation fixture is unavailable");
    mxcLaunchMock.prepare.mockImplementation(async (input, lifecycle) => {
      const launch = await prepare(input, lifecycle);
      setWindowsShellLocalNetworkAccess(false);
      setWindowsShellLocalNetworkAccess(true);
      return launch;
    });
    const result = await executePowerShell(context("old-local-network-admission"));
    expect(result.isError).toBe(true);
    expect(childProcessMock.spawn.mock.calls.some(([file]) => file === WXC_EXEC)).toBe(false);
    expect(mxcLaunchMock.release).toHaveBeenCalledOnce();
  });

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
    mxcLaunchMock.prepare.mockImplementation(async (input: { commandLine: string }, lifecycle: ContainedShellLifecycle) => {
      lifecycle.defer(mxcLaunchMock.release);
      return {
        argv: [WXC_EXEC, "--config-base64", isParserLaunch(input) ? PARSER_REQUEST : "eyJ9"],
        proxyPort: 51234,
        activate: mxcLaunchMock.activate,
        bindChild: mxcLaunchMock.bindChild,
      };
    });
  });

  afterEach(() => {
    setAgentTerminalObservationSink(undefined);
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
    sandboxHomeMock.onCleanup.mockReset();
    installationMock.resolve.mockReset();
    vi.restoreAllMocks();
  });

  it("observes only the approved command container and excludes its internal parser", async () => {
    bootMxcShells();
    const write = vi.fn();
    const finish = vi.fn();
    const bindEgress = vi.fn();
    const start = vi.fn(() => ({ signal: new AbortController().signal, write, finish, bindEgress, releaseHeldOutput: vi.fn(), revoke: vi.fn() }));
    setAgentTerminalObservationSink({ start, egress: vi.fn(), releaseSessions: vi.fn() });
    const identity = { sessionId: "observed-shell", turnId: "observed-turn", toolUseId: "ps-observed" };
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-observed-")));
    try {
      const result = await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity,
        () => executePowerShell(
          { ...context(identity.toolUseId), cwd, metadata: { ...context(identity.toolUseId).metadata, sessionId: identity.sessionId } })));
      expect(result.isError).toBe(false);
      expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledExactlyOnceWith(identity, expect.objectContaining({ kind: "shell", command: "Write-Output hi", cwd,
        sandbox: { mode: "isolated", detail: "filesystem/process confinement" } }));
      expect(write.mock.calls.map((call) => call[0]).join("")).toBe(`${CONTAINER_OUTPUT}\n`);
      expect(finish).toHaveBeenCalledExactlyOnceWith(0, undefined);
      expect(bindEgress).toHaveBeenCalledExactlyOnceWith(mxcLaunchMock.prepare.mock.calls[1][0].egressToken);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("runs a PowerShell command through wxc-exec with this invocation's token and closes its listener after", async () => {
    bootMxcShells();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-workspace-")));
    const result = await executePowerShell({ ...context("ps-mxc-1"), cwd })
      .finally(() => rmSync(cwd, { recursive: true, force: true }));

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
      expect(script).toContain(POWERSHELL_EGRESS_PROXY_PRELUDE);
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
    const result = await executePowerShell(context("large-parser-response"), command);
    expect(result, result.output).toMatchObject({ isError: false, metadata: { returncode: 0, sandboxed: true } });
    expect(result.output).toBe(CONTAINER_OUTPUT);
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(2);
  });

  it("refuses an oversized internal response before launching caller text", async () => {
    bootMxcShells();
    childProcessMock.spawn.mockImplementation(() => fakeChild(" ".repeat(MAX_POWERSHELL_PARSER_RESPONSE_BYTES + 1), 0));
    const result = await executePowerShell(context("oversized-parser-response"), "Write-Output a;".repeat(100));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("PowerShell parser response exceeds the internal byte limit");
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(1);
  });

  it("refuses an internal response that is not JSON without echoing it", async () => {
    bootMxcShells();
    childProcessMock.spawn.mockImplementation(() => fakeChild("password=parser-secret-example", 0));
    const result = await executePowerShell(context("invalid-parser-response"), "Write-Output a");
    expect(result).toMatchObject({ isError: true, output: "PowerShell parser failed: PowerShell parser response is not valid JSON" });
    expect(mxcLaunchMock.prepare).toHaveBeenCalledTimes(1);
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(1);
  });

  it("refuses an untrusted image before preparing either parser or caller container", async () => {
    bootMxcShells();
    installationMock.resolve.mockReturnValue(null);
    const result = await executePowerShell(context("missing-trusted-image"));
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
      const result = await executePowerShell({ ...context("ps-mxc-floor"), cwd: workspace, extraAllowedDirectories: [workspace] });
      expect(result.isError).toBe(false);
      const [launch] = mxcLaunchMock.prepare.mock.calls[0] as [{ filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[]; denyRead: string[]; floorPierces?: string[] } }];
      const { filesystem } = launch;
      expect(filesystem.allowWrite).toContain(workspace);
      const pathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const writeDenyCovers = (path: string) => {
        const target = pathKey(path);
        return filesystem.denyWrite.some(entry => {
          if (/[*?\[\]]/.test(entry)) return false;
          const parent = pathKey(entry);
          return target === parent || target.startsWith(parent + "/");
        });
      };
      // Execution controls remain protected, including the whole settings directory.
      for (const entry of [join(".git", "hooks"), join(".git", "config"), ".vscode", ".husky", ".claude", ".envrc"]) {
        expect(writeDenyCovers(join(workspace, entry)), entry).toBe(true);
      }
      for (const store of [permissionsFilePath(), userApprovalFilePath(), egressGrantFilePath()]) {
        expect(writeDenyCovers(store), store).toBe(true);
      }
      // Windows keeps denied workspace controls read-only when present and denied when absent.
      if (process.platform === "win32" && ORIGINAL_PLATFORM === "win32") {
        const grants = rankMxcFilesystem({ ...filesystem, protectedFloor: [] }, existsSync);
        // Compare Windows paths case-insensitively, including canonical drive letters.
        const folded = (paths: readonly string[]) => paths.map(pathKey);
        expect(folded(grants.readwrite)).toContain(pathKey(workspace));
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
    const result = await executePowerShell(context("ps-mxc-2"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toContain("the sandbox proxy is not running");
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });

  it.each([false, true])("fails closed on policy delivery failure with headless=%s", async (headless) => {
    bootMxcShells();
    mxcLaunchMock.prepare.mockResolvedValueOnce({ argv: [WXC_EXEC, "--config-base64", PARSER_REQUEST], proxyPort: 51234, activate: mxcLaunchMock.activate, bindChild: mxcLaunchMock.bindChild });
    const message = "Windows sandbox policy is too large: 40324 characters, limit 24574";
    mxcLaunchMock.prepare.mockRejectedValueOnce(new Error(message));
    const result = await executePowerShell({ ...context("policy-delivery-failure"), headless });
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toBe(`PowerShell spawn failed: ${message}`);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn.mock.calls[0]![0]).toBe(WXC_EXEC);
    expect(childProcessMock.spawn.mock.calls[0]![1]).toContain(PARSER_REQUEST);
  });

  it("refuses a missing system root before preparing or spawning a container", async () => {
    bootMxcShells();
    const roots = ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"];
    const previous = roots.map(key => process.env[key]);
    try {
      for (const key of roots) vi.stubEnv(key, undefined);
      const result = await executePowerShell(context("missing-system-root"));
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
      return childWithSpawnError(Object.assign(new Error("spawn wxc-exec.exe ENOENT"), { code: "ENOENT" }));
    });
    const result = await executePowerShell(context("ps-mxc-enoent"));
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

  // Probes of the command container's lifecycle, egress and HOME, captured as its launch is prepared; `bindChild` binds only the command's child.
  function captureCommandLaunch(bindChild: (child: unknown) => void = mxcLaunchMock.bindChild) {
    let captured: { lifecycle: ContainedShellLifecycle; token: string; home: string | undefined } | undefined;
    mxcLaunchMock.prepare.mockImplementation(async (input: PrepareMxcShellLaunchInput, lifecycle: ContainedShellLifecycle) => {
      const parser = isParserLaunch(input);
      if (!parser) {
        captured = { lifecycle, token: input.egressToken, home: input.filesystem.allowWrite.find((path) => path.includes("ave-mxc-test-home-")) };
      }
      lifecycle.defer(mxcLaunchMock.release);
      return {
        argv: [WXC_EXEC, "--config-base64", parser ? PARSER_REQUEST : "eyJ9"],
        proxyPort: 51234,
        activate: mxcLaunchMock.activate,
        bindChild: parser ? mxcLaunchMock.bindChild : bindChild,
      };
    });
    return {
      revoked: () => captured?.lifecycle.signal.aborted === true,
      egressLive: () => captured !== undefined && egressInvocationOwner(captured.token) !== undefined,
      homeExists: () => captured?.home !== undefined && existsSync(captured.home),
    };
  }

  // The command's launcher runs until the test ends it. Each process-tree kill records what was still live when it began.
  function runningLauncher(kills: Array<{ revoked: boolean; egressLive: boolean; launchReleases: number; homeExists: boolean }>, command: ReturnType<typeof captureCommandLaunch>) {
    const launchers: Array<EventEmitter & { exitCode: number | null }> = [];
    const started = deferred<void>();
    const spawn = childProcessMock.spawn.getMockImplementation();
    if (spawn === undefined) throw new Error("Missing child spawn fixture");
    childProcessMock.spawn.mockImplementation((file: string, args: readonly string[], options: unknown) => {
      if (/taskkill\.exe$/iu.test(file) && args.includes("4242")) {
        kills.push({
          revoked: command.revoked(),
          egressLive: command.egressLive(),
          launchReleases: mxcLaunchMock.release.mock.calls.length,
          homeExists: command.homeExists(),
        });
      }
      if (file !== WXC_EXEC || args.includes(PARSER_REQUEST)) return spawn(file, args, options);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, pid: 4242, kill: vi.fn(() => true),
      });
      launchers.push(child);
      started.resolve();
      return child;
    });
    return {
      started: started.promise,
      exit(code: number): void {
        for (const launcher of launchers) {
          launcher.exitCode = code;
          launcher.emit("exit", code, null);
          launcher.emit("close", code, null);
        }
      },
    };
  }

  it.each(["cancellation", "timeout"] as const)("revokes the command's egress at %s before the kill, and releases its launch and HOME only after the job exits", async (ending) => {
    bootMxcShells();
    const command = captureCommandLaunch();
    const kills: Parameters<typeof runningLauncher>[0] = [];
    const launcher = runningLauncher(kills, command);
    const abort = new AbortController();
    if (ending === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const execution = new PowerShellTool().execute(
        { command: "Write-Output hi", timeoutSeconds: 1 },
        { ...context(`ps-mxc-${ending}-revokes`), abortSignal: abort.signal },
      );
      await launcher.started;
      expect(command.revoked()).toBe(false);
      if (ending === "cancellation") {
        abort.abort();
        // Synchronous: nothing the job started can reach the network once cancellation returns.
        expect(command.revoked()).toBe(true);
        expect(command.egressLive()).toBe(false);
      } else {
        await vi.advanceTimersByTimeAsync(999);
        expect(command.revoked()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.waitFor(() => expect(kills).toHaveLength(1));
      expect(kills).toEqual([{ revoked: true, egressLive: false, launchReleases: 1, homeExists: true }]);
      // The job has not exited: its launch and HOME are still held.
      expect(mxcLaunchMock.release).toHaveBeenCalledOnce();
      expect(command.homeExists()).toBe(true);
      launcher.exit(1);
      const result = await execution;
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(ending === "timeout" ? /timed out/u : /cancelled/u);
      // A result that settled once the kill finished does not wait for the release that follows the job's exit.
      await vi.waitFor(() => expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(command.homeExists()).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes and kills a launcher whose child binding throws, withholding details while its job is live", async () => {
    bootMxcShells();
    const failure = new Error("child binding failed");
    const command = captureCommandLaunch(() => { throw failure; });
    const kills: Parameters<typeof runningLauncher>[0] = [];
    const launcher = runningLauncher(kills, command);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await executePowerShell(context("ps-mxc-bind-child-throws"));
    expect(kills).toEqual([{ revoked: true, egressLive: false, launchReleases: 1, homeExists: true }]);
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toBe("PowerShell spawn failed: failure details unavailable");
    expect(log).toHaveBeenCalledWith("[shell-tasks] contained shell failed while its job was live",
      expect.objectContaining({ label: "tool:powershell:mxc", err: "child binding failed" }));
    expect(mxcLaunchMock.release).toHaveBeenCalledOnce();
    expect(command.homeExists()).toBe(true);
    launcher.exit(1);
    await vi.waitFor(() => expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(command.homeExists()).toBe(false));
  });

  it("revokes the command's egress at the job's exit and releases its launch while output finalization is pending", async () => {
    bootMxcShells();
    const command = captureCommandLaunch();
    const launchReleased = deferred<void>();
    mxcLaunchMock.release.mockImplementation(async () => {
      if (command.revoked()) launchReleased.resolve();
    });
    const spawn = childProcessMock.spawn.getMockImplementation();
    if (spawn === undefined) throw new Error("Missing child spawn fixture");
    childProcessMock.spawn.mockImplementation((file: string, args: readonly string[], options: unknown) =>
      file === WXC_EXEC && !args.includes(PARSER_REQUEST) ? fakeChild("x".repeat(13_000), 0) : spawn(file, args, options));
    const finalizing = deferred<void>();
    const published = deferred<{ version: 1; captureId: string; status: "complete" }>();
    const finish = vi.fn(() => { finalizing.resolve(); return published.promise; });
    const toolUseId = "ps-mxc-pending-finalizer";
    const execution = executePowerShell({ ...context(toolUseId), metadata: { toolUseId,
      toolOutputCaptureFactory: () => ({ captureId: "capture", append: () => true, waitForDrain: async () => {}, finish }) } });
    await finalizing.promise;
    // The job has exited: the command's authority ended with it, before its output is published.
    expect(command.revoked()).toBe(true);
    expect(command.egressLive()).toBe(false);
    await launchReleased.promise;
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
    published.resolve({ version: 1, captureId: "capture", status: "complete" });
    const result = await execution;
    expect(result.isError).toBe(false);
    expect(finish).toHaveBeenCalledOnce();
    expect(command.homeExists()).toBe(false);
  });

  it("settles and releases everything when the remote authority refresh rejects", async () => {
    bootMxcShells();
    const container = failCommandContainerRelease({});
    const failure = new Error("authority refresh failed");
    const refresh = chatOrigin.refreshRemoteControllerBoundToSession;
    // Only the refresh that follows the command's own preparation fails.
    vi.spyOn(chatOrigin, "refreshRemoteControllerBoundToSession").mockImplementation(async (...args) => {
      if (mxcLaunchMock.prepare.mock.calls.length === 2) throw failure;
      return refresh(...args);
    });
    const result = await executePowerShell(context("ps-mxc-refresh-rejects"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toBe("PowerShell spawn failed: authority refresh failed");
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
    expect(egressInvocationOwner(container.token())).toBeUndefined();
    expect(existsSync(container.home())).toBe(false);
    expect(childProcessMock.spawn.mock.calls.some(([, args]) => (args as readonly string[]).includes("eyJ9"))).toBe(false);
  });

  it.each(["launch environment", "read policy"] as const)("releases the isolated HOME when the %s cannot be built", async (stage) => {
    bootMxcShells();
    const failure = new Error(`${stage} failed`);
    if (stage === "launch environment") {
      vi.spyOn(powerShellLaunch, "preparePowerShellLaunch").mockImplementation(() => { throw failure; });
    } else {
      vi.spyOn(asrtSandbox, "getBuiltinShellReadPolicy").mockImplementation(() => { throw failure; });
    }
    const result = await executePowerShell(context(`ps-mxc-${stage.replace(" ", "-")}-throws`));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toBe(`PowerShell spawn failed: ${stage} failed`);
    expect(sandboxHomeMock.onCleanup.mock.calls.map(([home]) => existsSync(home))).toEqual([false]);
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
  });

  // The command's launcher has a pid, reports an error and keeps running until the test ends it.
  function runningLauncherWithError(): () => EventEmitter {
    const launchers: EventEmitter[] = [];
    const spawn = childProcessMock.spawn.getMockImplementation();
    if (spawn === undefined) throw new Error("Missing child spawn fixture");
    childProcessMock.spawn.mockImplementation((file: string, args: readonly string[], options: unknown) => {
      if (file !== WXC_EXEC || args.includes(PARSER_REQUEST)) return spawn(file, args, options);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, pid: 4242, kill: vi.fn(() => true),
      });
      child.once("exit", (code: number) => { child.exitCode = code; });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
      launchers.push(child);
      return child;
    });
    return () => {
      const [launcher] = launchers;
      if (launcher === undefined) throw new Error("The command's launcher was not started");
      return launcher;
    };
  }

  const releaseListenerCleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of releaseListenerCleanups.splice(0)) cleanup(); });

  // Fails only the caller's (second) container preparation or release; returns its token and HOME.
  function failCommandContainerRelease(
    failure: { egressThrows?: Error; launchRejects?: unknown; prepareRejects?: unknown },
  ): { token: () => string; home: () => string } {
    let token: string | undefined;
    let home: string | undefined;
    mxcLaunchMock.prepare.mockImplementation(async (
      input: { commandLine: string; egressToken: string; filesystem: { allowWrite: string[] } },
      lifecycle: ContainedShellLifecycle,
    ) => {
      const parser = isParserLaunch(input);
      if (!parser) {
        token = input.egressToken;
        home = input.filesystem.allowWrite.find((path) => path.includes("ave-mxc-test-home-"));
        if ("prepareRejects" in failure) throw failure.prepareRejects;
      }
      const rejects = parser ? undefined : failure.launchRejects;
      lifecycle.defer(rejects === undefined ? mxcLaunchMock.release : async () => { await mxcLaunchMock.release(); throw rejects; });
      return {
        argv: [WXC_EXEC, "--config-base64", parser ? PARSER_REQUEST : "eyJ9"],
        proxyPort: 51234,
        activate: mxcLaunchMock.activate,
        bindChild: mxcLaunchMock.bindChild,
      };
    });
    const thrown = failure.egressThrows;
    if (thrown !== undefined) releaseListenerCleanups.push(onEgressInvocationReleased((released) => { if (released === token) throw thrown; }));
    return { token: () => token!, home: () => home! };
  }

  it("settles with the error and still releases the launch and HOME when egress release throws", async () => {
    bootMxcShells();
    const container = failCommandContainerRelease({ egressThrows: new Error("listener close threw") });
    const result = await executePowerShell(context("ps-mxc-egress-throws"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxCleanupFailed: true, sandboxed: true } });
    expect(result.output).toContain(CONTAINER_OUTPUT);
    expect(result.output).toContain("listener close threw");
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
    expect(egressInvocationOwner(container.token())).toBeUndefined();
    expect(existsSync(container.home())).toBe(false);
  });

  it("settles with the error and still releases egress and HOME when the launch release rejects", async () => {
    bootMxcShells();
    const container = failCommandContainerRelease({ launchRejects: new Error("relay close rejected") });
    const result = await executePowerShell(context("ps-mxc-launch-rejects"));
    expect(result).toMatchObject({ isError: true, metadata: { sandboxCleanupFailed: true, sandboxed: true } });
    expect(result.output).toContain("relay close rejected");
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
    expect(egressInvocationOwner(container.token())).toBeUndefined();
    expect(existsSync(container.home())).toBe(false);
  });

  // The real preparation and transport wrapper; only the policy pipe beneath the wrapper is replaced.
  async function configureCommandLauncher(
    openPipe: typeof mxcPolicyPipe.openMxcPolicyPipe,
    observerError: Error,
  ) {
    const { prepareMxcShellLaunch } = await vi.importActual<typeof import("../mxc-shell-launch.js")>("../mxc-shell-launch.js");
    const prepareParser = mxcLaunchMock.prepare.getMockImplementation();
    if (prepareParser === undefined) throw new Error("Missing parser launch fixture");
    const closeRelay = vi.fn(async () => {});
    // As the runtime does, the relay hands its close to the admission as soon as it exists.
    vi.spyOn(egressHostListener, "openHostEgressListener").mockImplementation(async (_token, admission) => {
      admission?.adopt(closeRelay);
      return { port: 9, proxyAuthorization: "Basic eA==", registerPort: vi.fn(), recordRefusal: vi.fn(), close: closeRelay };
    });
    vi.spyOn(mxcWindows, "resolveHostWxcExecPath").mockResolvedValue(WXC_EXEC);
    vi.spyOn(mxcPolicyPipe, "openMxcPolicyPipe").mockImplementation(openPipe);
    mxcLaunchMock.prepare.mockImplementation((input: PrepareMxcShellLaunchInput, lifecycle: ContainedShellLifecycle) => {
      if (isParserLaunch(input)) return prepareParser(input, lifecycle);
      releaseListenerCleanups.push(onEgressInvocationReleased((token) => {
        if (token === input.egressToken) throw observerError;
      }));
      // Every host-derived field is fixed, so a POSIX run reaches the transport as a Windows one does.
      return prepareMxcShellLaunch({
        ...input,
        cwd: FIXTURE_WORKSPACE,
        filesystem: { allowWrite: [FIXTURE_WORKSPACE], allowRead: [], denyRead: [], denyWrite: [], floorPierces: [] },
        // Too large for the command line, so the request travels over the policy pipe.
        env: { SYSTEMROOT: String.raw`C:\Windows`, LOCALAPPDATA: String.raw`C:\ave-fixture\home\AppData\Local`, AVE_FIXTURE_PADDING: "x".repeat(25_000) },
        exists: (path) => path === WXC_EXEC || path === FIXTURE_WORKSPACE,
        list: () => [],
      }, lifecycle);
    });
    return closeRelay;
  }

  it.each(["consent revocation", "cancellation"] as const)("reports the transport open failure first after %s during preparation", async (trigger) => {
    bootMxcShells();
    const abort = new AbortController();
    const opening = deferred<void>();
    const transportFailure = deferred<Error>();
    const closeRelay = await configureCommandLauncher(async () => {
      opening.resolve();
      throw await transportFailure.promise;
    }, new Error("invocation release observer failed"));
    const execution = executePowerShell({ ...context("ps-mxc-open-error"), abortSignal: abort.signal });
    await Promise.race([opening.promise, execution.then(() => { throw new Error("shell settled before opening the transport"); })]);
    if (trigger === "consent revocation") setWindowsShellLocalNetworkAccess(false);
    else abort.abort();
    transportFailure.resolve(new Error("policy transport open failed"));
    const result = await execution;
    expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable" } });
    expect(result.output).toBe("PowerShell spawn failed: Windows sandbox policy pipe could not be opened: policy transport open failed\n"
      + "Shell resource release failed: invocation release observer failed");
    expect(mxcPolicyPipe.openMxcPolicyPipe).toHaveBeenCalledOnce();
    expect(closeRelay).toHaveBeenCalledOnce();
  });

  it.each(["result", "async log"] as const)("reports both container release failures with redaction in the %s", async (sink) => {
    bootMxcShells();
    const observerMessage = "invocation release observer failed";
    const transportMessage = "policy helper termination was not confirmed";
    const release = vi.fn(async () => {
      throw new Error(`${transportMessage} at /home/bob/policy with api_key=transport-secret-example`);
    });
    const closeRelay = await configureCommandLauncher(async () => ({ bindChild: vi.fn(), release }),
      new Error(String.raw`${observerMessage} at C:\Users\alice\observer with password=observer-secret-example`));
    let rendered: string;
    if (sink === "result") {
      const result = await executePowerShell(context("ps-mxc-both-release-failures"));
      expect(result).toMatchObject({ isError: true, metadata: { sandboxCleanupFailed: true, sandboxed: true } });
      rendered = result.output;
    } else {
      const logged = deferred<unknown>();
      vi.spyOn(console, "error").mockImplementation((message: unknown, details: unknown) => {
        if (message === "[shell-tasks] shell resource release failed after the result settled") logged.resolve(details);
      });
      const launcher = runningLauncherWithError();
      const result = await executePowerShell(context("ps-mxc-both-release-failures"));
      expect(result.output).toBe("PowerShell spawn failed: failure details unavailable");
      expect(release).not.toHaveBeenCalled();
      launcher().emit("exit", 1, null);
      launcher().emit("close", 1, null);
      const entry = await logged.promise;
      expect(entry).toMatchObject({ label: "tool:powershell:mxc", failures: expect.any(String) });
      rendered = JSON.stringify(entry);
    }
    expect(rendered).toContain(`${observerMessage} at [home]`);
    expect(rendered).toContain(`${transportMessage} at [home]`);
    expect(rendered).not.toMatch(/alice|bob|observer-secret-example|transport-secret-example/u);
    expect(mxcPolicyPipe.openMxcPolicyPipe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(closeRelay).toHaveBeenCalledOnce();
  });

  it("settles with the error and still releases the launch, HOME and egress when output finalization throws", async () => {
    bootMxcShells();
    const container = failCommandContainerRelease({});
    const progress = { write: () => {}, end: () => { throw new Error("progress sink closed"); } };
    const result = await executePowerShell({ ...context("ps-mxc-collector-throws"), metadata: { toolUseId: "ps-mxc-collector-throws", toolOutputProgress: progress } });
    expect(result).toMatchObject({ isError: true, metadata: { sandboxCleanupFailed: true, sandboxed: true } });
    expect(result.output).toContain("progress sink closed");
    expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
    expect(egressInvocationOwner(container.token())).toBeUndefined();
    expect(existsSync(container.home())).toBe(false);
  });

  it("reports an observation start failure with a HOME cleanup failure after releasing egress", async () => {
    bootMxcShells();
    const container = failCommandContainerRelease({});
    const setupError = new Error("could not start shell observation");
    const cleanupError = new Error("HOME cleanup failed");
    sandboxHomeMock.onCleanup.mockImplementation((home) => {
      if (home === container.home()) throw cleanupError;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    setAgentTerminalObservationSink({ start: () => { throw setupError; }, egress: vi.fn(), releaseSessions: vi.fn() });
    const identity = { sessionId: "observed-shell", turnId: "observed-turn", toolUseId: "ps-mxc-observation-start-fails" };
    try {
      const result = await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity,
        () => executePowerShell(context(identity.toolUseId))));
      expect(sandboxHomeMock.onCleanup).toHaveBeenCalledWith(container.home());
      expect(mxcLaunchMock.release).toHaveBeenCalledTimes(2);
      expect(egressInvocationOwner(container.token())).toBeUndefined();
      expect(result).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "unavailable", sandboxCleanupFailed: true } });
      expect(result.output).toBe("PowerShell spawn failed: could not start shell observation\nShell resource release failed: HOME cleanup failed");
    } finally {
      releaseEgressInvocation(container.token());
    }
  });

  const SIGNATURE = "4f9c1e7d2b8a6c3e5f0a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a";
  const CREDENTIAL_URL = "https://objects.example/policy.json?api_key=";
  const ERROR_MESSAGES = [
    { kind: "a throwing message getter", message: undefined, rendered: "failure details unavailable" },
    { kind: "a 1M-character message", message: "x".repeat(1_000_000), rendered: "failure message omitted (1000000 characters)" },
    {
      kind: "a URL credential and home path",
      message: `upload to ${CREDENTIAL_URL}${SIGNATURE} from C:\\Users\\alice\\observer failed`,
      rendered: `upload to ${CREDENTIAL_URL}[REDACTED:TOKEN] from [home]\\observer failed`,
    },
  ];

  describe.each(["spawn catch", "child error", "finalization"] as const)("MXC %s diagnostics", (stage) => {
    it.each(ERROR_MESSAGES)("settles with bounded, redacted details for $kind after releasing resources", async ({ message, rendered }) => {
      bootMxcShells();
      const container = failCommandContainerRelease({});
      const error = new Error();
      const releaseState = vi.fn(() => ({
        egressLive: egressInvocationOwner(container.token()) !== undefined,
        homeExists: existsSync(container.home()),
        launchReleases: mxcLaunchMock.release.mock.calls.length,
      }));
      Object.defineProperty(error, "message", { get: () => {
        releaseState();
        if (message === undefined) throw new Error("message read failed");
        return message;
      } });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const identity = { sessionId: "observed-shell", turnId: "observed-turn", toolUseId: "ps-mxc-error-diagnostics" };
      if (stage === "finalization") {
        setAgentTerminalObservationSink({
          start: () => ({ signal: new AbortController().signal, write: vi.fn(), finish: () => { throw error; },
            bindEgress: vi.fn(), releaseHeldOutput: vi.fn(), revoke: vi.fn() }),
          egress: vi.fn(),
          releaseSessions: vi.fn(),
        });
      } else {
        const spawn = childProcessMock.spawn.getMockImplementation();
        if (spawn === undefined) throw new Error("Missing child spawn fixture");
        childProcessMock.spawn.mockImplementation((file: string, args: readonly string[], options: unknown) => {
          if (file !== WXC_EXEC || args.includes(PARSER_REQUEST)) return spawn(file, args, options);
          if (stage === "spawn catch") throw error;
          return childWithSpawnError(error);
        });
      }

      const result = await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity,
        () => executePowerShell(context(identity.toolUseId))));
      expect(result.isError).toBe(true);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(500);
      if (stage === "finalization") expect(result.output.endsWith(`\nShell resource release failed: ${rendered}`)).toBe(true);
      else expect(result.output === `PowerShell spawn failed: ${rendered}`).toBe(true);
      expect(releaseState.mock.results.map(({ value }) => value)).toEqual([
        { egressLive: false, homeExists: false, launchReleases: 2 },
      ]);
      expect(log).not.toHaveBeenCalledWith("[shell-tasks] shell finalization failed", expect.anything());
    });
  });

  const FAILURE_STAGES = ["preparation", "launch release"] as const;
  const failAt = (stage: (typeof FAILURE_STAGES)[number], error: unknown) =>
    failCommandContainerRelease(stage === "preparation" ? { prepareRejects: error } : { launchRejects: error });
  const failureText = (output: string, stage: (typeof FAILURE_STAGES)[number]) =>
    stage === "preparation" ? output.replace(/^PowerShell spawn failed: /u, "") : output.split("\nShell resource release failed: ").at(-1);

  function deepAggregate(): Error {
    let error = new Error("leaf");
    for (let level = 0; level < 100_000; level++) error = new AggregateError([error], `level ${level}`);
    return error;
  }

  function unreadableAggregate(): Error {
    const aggregate = new AggregateError([], "unreadable");
    const members = new Proxy([new Error("hidden member")], {
      get: (target, key, receiver) => {
        if (key === "0") throw new Error("member read failed");
        return Reflect.get(target, key, receiver);
      },
    });
    Object.defineProperty(aggregate, "errors", { value: members });
    return aggregate;
  }

  // A cut at the redaction window would keep part of this password: the home before it shrinks to a few characters.
  const STRADDLING = `D:\\Users\\${"n".repeat(4060)} https://deploy:userinfo-secret-example@objects.example/a`;
  const BOUNDED_FAILURES: ReadonlyArray<readonly [string, () => unknown, string]> = [
    ["a 1M-character message", () => new Error("x".repeat(1_000_000)), "failure message omitted (1000000 characters)"],
    ["a credential across the redaction window", () => new Error(STRADDLING), `failure message omitted (${STRADDLING.length} characters)`],
    ["a 100,000-level aggregate", deepAggregate, "level 99997"],
    ["a 200,000-member aggregate", () => new AggregateError(new Array(200_000).fill(new Error("member failed")), "wide"),
      "member failed; member failed; member failed; member failed (+199996 more)"],
    ["an inner aggregate shared by two members", () => {
      const inner = new AggregateError([new Error("first"), new Error("second")], "inner");
      return new AggregateError([inner, inner], "outer");
    }, "first; second; first; second"],
    ["an aggregate that contains itself", () => {
      const loop = new AggregateError([new Error("before")], "loop");
      loop.errors.push(loop);
      return loop;
    }, "before; loop"],
    ["unreadable aggregate members", unreadableAggregate, "failure details unavailable"],
    ["an unreadable member after a readable one", () => {
      const aggregate = new AggregateError([], "partly unreadable");
      const members = new Proxy([new Error("first member failed"), new Error("hidden member")], {
        get: (target, key, receiver) => {
          if (key === "1") throw new Error("member read failed");
          return Reflect.get(target, key, receiver);
        },
      });
      Object.defineProperty(aggregate, "errors", { value: members });
      return aggregate;
    }, "first member failed; failure details unavailable"],
    // Not coerced: only a string or a verified Error's string message is read, and only after its length is bounded.
    ["a message that is not a string", () => {
      const error = new Error("placeholder");
      Object.defineProperty(error, "message", { value: { toString: () => "x".repeat(1_000_000) } });
      return error;
    }, "failure details unavailable"],
    ["a thrown string", () => "plain failure text", "plain failure text"],
    ["a thrown value that is not an error", () => ({ toString: () => "x".repeat(1_000_000) }), "failure details unavailable"],
    ["an error and the causes its text lacks", () => new Error("transport failed", { cause: new Error("pipe busy", { cause: new Error("transport failed") }) }),
      "transport failed: pipe busy"],
    ["an unreadable cause", () => {
      const error = new Error("transport failed");
      Object.defineProperty(error, "cause", { get: () => { throw new Error("cause read failed"); } });
      return error;
    }, "transport failed"],
  ];

  it.each(FAILURE_STAGES.flatMap((stage) => BOUNDED_FAILURES.map(([name, error, text]) => [stage, name, error, text] as const)))(
    "bounds a %s failure from %s and still releases egress and HOME",
    async (stage, _name, error, text) => {
      bootMxcShells();
      const container = failAt(stage, error());
      const result = await executePowerShell(context(`ps-mxc-bounded-${stage}`));
      expect(result.isError).toBe(true);
      expect(failureText(result.output, stage)).toBe(text);
      expect(egressInvocationOwner(container.token())).toBeUndefined();
      expect(existsSync(container.home())).toBe(false);
    },
  );

  it("keeps each failure list within 2 KB when a wide preparation failure meets a failing release", async () => {
    bootMxcShells();
    const wide = () => new AggregateError(new Array(10).fill(new Error("\u{1f600}".repeat(2_000))), "wide");
    const container = failCommandContainerRelease({ prepareRejects: wide(), egressThrows: wide() });
    const result = await executePowerShell(context("ps-mxc-bounded-worst-case"));
    const lines = result.output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^PowerShell spawn failed: .+ \(\+6 more\)$/u);
    expect(lines[1]).toMatch(/^Shell resource release failed: .+ \(\+6 more\)$/u);
    for (const line of lines) expect(Buffer.byteLength(line.slice(line.indexOf(": ") + 2))).toBeLessThanOrEqual(2048);
    expect(existsSync(container.home())).toBe(false);
  });

  it.each(FAILURE_STAGES)("formats a %s failure only after every release step ran", async (stage) => {
    bootMxcShells();
    let atFirstRead: { egressLive: boolean; homeExists: boolean } | undefined;
    const probe = new Error("probe");
    Object.defineProperty(probe, "message", {
      get: () => {
        atFirstRead ??= { egressLive: egressInvocationOwner(container.token()) !== undefined, homeExists: existsSync(container.home()) };
        throw new Error("message read failed");
      },
    });
    const container = failAt(stage, probe);
    const result = await executePowerShell(context(`ps-mxc-format-last-${stage}`));
    expect(atFirstRead).toEqual({ egressLive: false, homeExists: false });
    expect(failureText(result.output, stage)).toBe("failure details unavailable");
    expect(egressInvocationOwner(container.token())).toBeUndefined();
    expect(existsSync(container.home())).toBe(false);
  });

  it.each(FAILURE_STAGES)("redacts a URL credential and another account's home in a %s failure", async (stage) => {
    bootMxcShells();
    const signature = "4f9c1e7d2b8a6c3e5f0a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a";
    failAt(stage, new AggregateError([
      new Error(`upload to https://objects.example/policy.json?api_key=${signature} failed`),
      new Error("observer at C:\\Users\\bob\\observer failed"),
    ], "two failures"));
    const result = await executePowerShell(context(`ps-mxc-redacted-${stage}`));
    expect(failureText(result.output, stage)).toBe(
      "upload to https://objects.example/policy.json?api_key=[REDACTED:TOKEN] failed; observer at [home]\\observer failed");
    expect(result.output).not.toContain(signature);
    expect(result.output).not.toContain("bob");
  });

  it("refuses a sandboxed Bash command with the PowerShell guidance instead of running it", async () => {
    bootMxcShells();
    const result = await new BashTool().execute({ command: "echo hi", timeoutSeconds: 7 }, context("bash-mxc"));
    expect(result).toMatchObject({ isError: true, output: MXC_BASH_UNAVAILABLE_MESSAGE, metadata: { sandboxed: false } });
    expect(mxcLaunchMock.prepare).not.toHaveBeenCalled();
    expect(childProcessMock.spawn.mock.calls.some((call) => call[0] === WXC_EXEC)).toBe(false);
  });
});
