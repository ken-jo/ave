import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { prepareVerifiedShellCommand, verifiedShellExecution, type VerifiedShellCommand } from "../../permissions/verified-shell-command.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as shellResolver from "../../lib/shell-resolver.js";
import * as sandboxHomeOwner from "../../permissions/sandbox-process-home.js";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import { BashTool, listShellTasks, PowerShellTool } from "../shell-tools.js";
import { setAgentTerminalObservationSink } from "../agent-terminal-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../agent-observation-context.js";
import { ObservationDaemon } from "../../observation/daemon.js";
import { TerminalObservationAdapter } from "../../observation/terminal-adapter.js";
import type { TerminalObservationEvent } from "../../shared/agent-observation.js";
import { inspectGitRepository } from "../../permissions/rules/git-repository-inputs.js";
import { readOnlyGitArguments, gitReadOnlyEnvironment } from "../../permissions/rules/git-readonly-argv.js";
import * as installation from "../../shared/verified-executable.js";
import {
  bindPreparedShellExecutableReadPaths, disposePreparedShellInvocation, matchesPreparedShellInvocation,
  prepareShellInvocation, preparedSandboxBootstrap, preparedSandboxEnvironment, preparedShellCommand,
  preparedShellCwdProbe, preparedShellExecutableReadPaths, type PreparedShellInvocation,
} from "../prepared-shell-invocation.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });
vi.mock("../../permissions/rules/git-repository-inputs.js", { spy: true });
vi.mock("../../shared/powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: () => ({ executable: "/protected-fixture/pwsh", kind: "pwsh" }) }));
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true }));

const ORIGINAL_PLATFORM = process.platform;
const nativeChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const nativeSearchPath = process.env.PATH;
const roots: string[] = [];
const handles: PreparedShellInvocation[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) disposePreparedShellInvocation(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  __resetSandboxRequestedAtBootForTest();
  __resetActiveSandboxCapabilityForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

// Supported-host transport simulation: no native command or installation proof runs in these fixtures.
function fixture(sandboxed = false, command = "bash --noprofile --norc -p -c 'printf ready'") {
  setProcessPlatform("linux");
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "verified-shell-execution-")));
  roots.push(cwd);
  stabilizeFixtureAncestorStats(cwd);
  const profileRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "verified-shell-profiles-")));
  roots.push(profileRoot);
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  const executable = join(cwd, "proved-image");
  const shadowDirectory = join(cwd, "shadow");
  mkdirSync(shadowDirectory);
  writeFileSync(executable, "controlled image", { mode: 0o755 });
  writeFileSync(join(shadowDirectory, "bash"), "shadow image", { mode: 0o755 });
  writeFileSync(join(shadowDirectory, "git"), "shadow image", { mode: 0o755 });
  vi.spyOn(childProcess, "execFileSync").mockImplementation((image, args) => {
    if (image === executable && args?.includes("--version")) return "git version 2.54.0\n";
    throw new Error("Unexpected native probe in controlled transport fixture");
  });
  vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Native spawn is outside this controlled transport fixture"); });
  vi.spyOn(shellResolver, "resolveShell").mockReturnValue({ cmd: "controlled-shell", shellArgs: (command) => ["-c", command] });
  vi.spyOn(shellResolver, "shellEnvForChild").mockImplementation((_, environment) => ({ ...environment,
    LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader",
    Git_Config_Count: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "untrusted-helper",
    GIT_EXEC_PATH: "/untrusted-exec", GIT_TRACE: "/untrusted-trace", GIT_PROXY_COMMAND: "untrusted-transport",
  }));
  vi.spyOn(shellResolver, "shellPathForHostPath").mockImplementation((_, path) => path);
  vi.spyOn(shellResolver, "getBashCapabilities").mockReturnValue({ unicodeEscapes: true, prefixAssignmentRhs: "incoming" });
  vi.spyOn(sandboxHomeOwner, "createSandboxProcessHome").mockImplementation(() => {
    const path = mkdtempSync(join(profileRoot, "owned-home-"));
    return { path, env: { HOME: path }, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  });
  vi.stubEnv("PATH", `${shadowDirectory}${delimiter}${process.env.PATH ?? ""}`);
  vi.mocked(installation.resolveVerifiedExecutable).mockReturnValue({ executable });
  const verifiedShellCommand = prepareVerifiedShellCommand({ command, dialect: "bash", cwd });
  expect(verifiedShellCommand).toBeDefined();
  setShellSandboxRequestedAtBoot(sandboxed);
  __resetActiveSandboxCapabilityForTest();
  if (sandboxed) setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
    reason: "Controlled sandbox fixture", confines: { filesystem: true, process: true, network: true } });
  const plan = getHostShellExecutionPlan();
  const identity = { command, executionCwd: cwd, resolvedCwd: cwd, plan, toolUseId: "verified-native-call", verifiedShellCommand };
  const handle = prepareShellInvocation(identity);
  handles.push(handle);
  return { cwd, executable, shadowDirectory, identity, handle };
}

it("retains raw authority identity while binding absolute image argv despite a shadow search path", () => {
  const { executable, shadowDirectory, identity, handle } = fixture();
  const prepared = preparedShellCommand(handle);
  expect(identity.command).toBe("bash --noprofile --norc -p -c 'printf ready'");
  expect(matchesPreparedShellInvocation(handle, identity)).toBe(true);
  expect(prepared.argv.at(-1)).toContain(`'${executable}'`);
  expect(matchesPreparedShellInvocation(handle, { ...identity, command: prepared.argv.at(-1)! })).toBe(false);
  expect(matchesPreparedShellInvocation(handle, { ...identity, verifiedShellCommand: undefined })).toBe(false);
  expect(prepared.argv[0]).toBe("-c");
  expect(prepared.argv.at(-1)).toContain("'--noprofile' '--norc' '-p' '-c' 'printf ready'");
  expect(prepared.environment).not.toHaveProperty("LD_PRELOAD");
  expect(prepared.environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
  bindPreparedShellExecutableReadPaths(handle);
  expect(preparedShellExecutableReadPaths(handle)).toContain(executable);
  expect(preparedShellExecutableReadPaths(handle)).not.toContain(join(shadowDirectory, "bash"));
  expect(preparedShellExecutableReadPaths(handle)).not.toContain(shadowDirectory);
});

it("uses the compiled command when rebuilding foreground argv with a host prelude", () => {
  const { executable, handle } = fixture();
  const { argv } = preparedShellCwdProbe(handle, "printf 'prelude|'; ");
  expect(argv.at(-1)).toContain(`'${executable}'`);
  expect(argv[0]).toBe("-c");
  expect(argv.at(-1)).toMatch(/^printf 'prelude\|'; /);
  expect(argv.at(-1)).not.toContain("; bash --noprofile");
});

it("binds checked repository roots and reapplies transport controls after a sandbox overlay", () => {
  const { cwd, executable, shadowDirectory, identity, handle } = fixture(true, "git log 'HEAD'");
  const prepared = preparedShellCommand(handle);
  expect(identity.command).toBe("git log 'HEAD'");
  expect(matchesPreparedShellInvocation(handle, identity)).toBe(true);
  expect(() => prepareShellInvocation({ ...identity, command: "git log HEAD" })).toThrow(/does not match/);
  expect(() => prepareShellInvocation({ ...identity, verifiedShellCommand: Object.freeze({}) as VerifiedShellCommand })).toThrow(/does not match/);
  expect(prepared.argv.at(-1)).toContain(`'${executable}'`);
  expect(prepared.argv.at(-1)).toContain(`'--git-dir=${join(cwd, ".git")}'`);
  expect(prepared.argv.at(-1)).toContain(`'--work-tree=${cwd}'`);
  expect(prepared.argv.at(-1)).toContain("'--no-lazy-fetch'");
  expect(prepared.argv.at(-1)).toContain("'log'");
  expect(prepared.argv.at(-1)).toContain("'HEAD'");
  const overlaid = preparedSandboxEnvironment(handle, {
    ...process.env, GIT_DIR: "/untrusted-repository", GIT_WORK_TREE: "/untrusted-worktree",
    Git_Config_Count: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "untrusted-helper",
    GIT_EXEC_PATH: "/untrusted-exec", GIT_TRACE: "/untrusted-trace", GIT_PROXY_COMMAND: "untrusted-transport",
    LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader",
  });
  expect(overlaid).toMatchObject({ GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd,
    GIT_REFERENCE_BACKEND: "files", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "0" });
  for (const key of ["Git_Config_Count", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
    expect(overlaid).not.toHaveProperty(key);
    expect(prepared.environment).not.toHaveProperty(key);
  }
  bindPreparedShellExecutableReadPaths(handle);
  expect(preparedShellExecutableReadPaths(handle)).toContain(executable);
  expect(preparedShellExecutableReadPaths(handle)).not.toContain(join(shadowDirectory, "git"));
  expect(preparedSandboxBootstrap(handle)).toContain(executable);
});

it("refuses a supplied proof for a changed command, directory, dialect or unissued handle", () => {
  const { identity } = fixture();
  expect(() => prepareShellInvocation({ ...identity, command: "bash --noprofile --norc -p -c 'printf changed'" })).toThrow(/does not match/);
  expect(() => prepareShellInvocation({ ...identity, resolvedCwd: join(identity.resolvedCwd, "other") })).toThrow(/does not match/);
  const wrongDialect = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  expect(wrongDialect).toBeDefined();
  expect(() => prepareShellInvocation({ ...identity, verifiedShellCommand: wrongDialect })).toThrow(/does not match/);
  expect(() => prepareShellInvocation({ ...identity, verifiedShellCommand: Object.freeze({}) as VerifiedShellCommand })).toThrow(/does not match/);
});

it("reapplies owned configuration after wrapper overlay and preserves the compiled sandbox bootstrap", () => {
  const { executable, handle } = fixture(true);
  const environment = preparedSandboxEnvironment(handle, { ...process.env,
    HTTPS_PROXY: "http://localhost:60080", LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader",
  });
  expect(environment).not.toHaveProperty("LD_PRELOAD");
  expect(environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
  expect(environment.HTTPS_PROXY).toBe("http://localhost:60080");
  const bootstrap = preparedSandboxBootstrap(handle, { cwdProbe: true });
  expect(bootstrap).toContain(executable);
  expect(bootstrap).toContain("exec 'controlled-shell' '-c'");
  expect(bootstrap).not.toContain("untrusted-loader");
});

it("preserves the original shell command when no native proof was supplied", () => {
  const { identity } = fixture();
  const command = "printf original-command";
  const handle = prepareShellInvocation({ ...identity, command, verifiedShellCommand: undefined });
  handles.push(handle);
  const prepared = preparedShellCommand(handle);
  expect(prepared.argv.at(-1)).toBe(command);
  expect(prepared.argv).toEqual(["-c", "printf original-command"]);
});

it("renders the sealed native image for the second shell dialect without changing its raw key", () => {
  const { executable, identity } = fixture();
  const verified = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  const execution = verifiedShellExecution(verified, { command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  expect(execution?.command).toContain(`& '${executable}'`);
  expect(verifiedShellExecution(verified, { command: "bash --noprofile --norc -p -c 'printf changed'", dialect: "powershell", cwd: identity.resolvedCwd })).toBeUndefined();
  expect(identity.command).toBe("bash --noprofile --norc -p -c 'printf ready'");
});

function controlledChild() {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, pid: undefined, killed: false, kill: vi.fn(() => true) });
  return { child, stdin, stdout, stderr };
}

function completedChild(output: string, beforeClose?: () => void, errorOutput = "") {
  const { child, stdout, stderr } = controlledChild();
  queueMicrotask(() => {
    stdout.end(output); stderr.end(errorOutput);
    beforeClose?.();
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null); child.emit("close", 0, null);
  });
  return child as ReturnType<typeof childProcess.spawn>;
}

function parsedCommandResponse(command: string, argv: string[]) {
  return { errors: [], redirections: [], unsupported: [], commands: [{ name: argv[0], text: command,
    arguments: argv.map((value) => ({ kind: "literal", text: value, value })) }] };
}

function sandboxTransport() {
  vi.spyOn(sandbox, "wrapToolCommand").mockResolvedValue({ argv: ["controlled-wrapper"], env: {} });
  vi.spyOn(sandbox, "cleanupAsrtSandboxAfterCommand").mockResolvedValue(undefined);
  vi.spyOn(sandbox, "annotateWithSandboxViolations").mockImplementation(async (_id, text) => text);
}

it.each(["bash --noprofile --norc -p -c 'printf ready'", "git log 'HEAD'"])("keeps raw %s at the second shell parser gate and binds its final workload", async (command) => {
  const { cwd, executable, identity } = fixture(false, command);
  const verifiedShellCommand = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  expect(verifiedShellCommand).toBeDefined();
  const argv = command.startsWith("git ") ? ["git", "log", "HEAD"] : ["bash", "--noprofile", "--norc", "-p", "-c", "printf ready"];
  const parsed = parsedCommandResponse(identity.command, argv);
  const received: string[] = [];
  const spawned = vi.spyOn(childProcess, "spawn");
  spawned.mockImplementationOnce(() => {
    const parser = completedChild(JSON.stringify(parsed));
    parser.stdin!.on("data", (chunk: Buffer) => received.push(chunk.toString()));
    return parser;
  }).mockImplementationOnce(() => completedChild("bound workload"));
  setShellSandboxRequestedAtBoot(false);
  const result = await new PowerShellTool().execute({ command: identity.command, timeoutSeconds: 5 }, {
    cwd: identity.resolvedCwd, extraAllowedDirectories: [], metadata: {}, hostShellExecutionPlan: getHostShellExecutionPlan(), verifiedShellCommand,
  });
  expect(result.isError, result.output).toBe(false);
  expect(result.output).toBe("bound workload");
  expect(received.join("")).toBe(command);
  expect(spawned).toHaveBeenCalledTimes(2);
  expect((spawned.mock.calls[1]![1] as string[]).at(-1)).toContain(`& '${executable}'`);
  expect(spawned.mock.calls[1]![2]?.env).not.toHaveProperty("LD_PRELOAD");
  expect(spawned.mock.calls[1]![2]?.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
  if (command.startsWith("git ")) {
    expect((spawned.mock.calls[1]![1] as string[]).at(-1)).toContain(`'--git-dir=${join(cwd, ".git")}'`);
    expect(spawned.mock.calls[1]![2]?.env).toMatchObject({ GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd,
      GIT_REFERENCE_BACKEND: "files", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "0" });
    for (const key of ["Git_Config_Count", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND"]) {
      expect(spawned.mock.calls[1]![2]?.env).not.toHaveProperty(key);
    }
  }
});

it("rejects a mismatched supplied proof before starting the second shell parser", async () => {
  const { identity } = fixture();
  const spawned = vi.spyOn(childProcess, "spawn");
  spawned.mockClear();
  setShellSandboxRequestedAtBoot(false);
  const result = await new PowerShellTool().execute({ command: identity.command, timeoutSeconds: 5 }, {
    cwd: identity.resolvedCwd, extraAllowedDirectories: [], metadata: {}, hostShellExecutionPlan: getHostShellExecutionPlan(), verifiedShellCommand: identity.verifiedShellCommand,
  });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("does not match");
  expect(spawned).not.toHaveBeenCalled();
});

it("refuses native records on an unsupported host before consulting an approving installation resolver", () => {
  setProcessPlatform("win32");
  vi.mocked(installation.resolveVerifiedExecutable).mockReturnValue({ executable: "C:\\protected\\image.exe" });
  const versionProbe = vi.spyOn(childProcess, "execFileSync");
  for (const command of ["git log", "bash --noprofile --norc -p -c 'printf ready'"]) {
    for (const dialect of ["bash", "powershell"] as const) {
      expect(prepareVerifiedShellCommand({ command, dialect, cwd: tmpdir() })).toBeUndefined();
    }
  }
  expect(installation.resolveVerifiedExecutable).not.toHaveBeenCalled();
  expect(versionProbe).not.toHaveBeenCalled();
});

it.each((["bash", "powershell"] as const).flatMap((dialect) => [false, true].flatMap((background) =>
  [false, true].flatMap((sandboxed) => [40, 64].map((width) => ({ dialect, background, sandboxed, width }))))))(
  "discards native $width-hex symlinked-ref output from $dialect with background=$background sandboxed=$sandboxed before delivery", async ({ dialect, background, sandboxed, width }) => {
  const command = "git rev-parse --verify HEAD";
  const { cwd, identity: preparedIdentity } = fixture(sandboxed, command);
  const ref = join(cwd, ".git", "refs", "heads", "main");
  writeFileSync(ref, "1".repeat(40) + "\n");
  const token = "7a".repeat(width / 2);
  const outside = join(cwd, "outside-ref-shaped-secret");
  writeFileSync(outside, token + "\n");
  const identity = { command, dialect, cwd };
  const verifiedShellCommand = prepareVerifiedShellCommand(identity);
  expect(verifiedShellCommand).toBeDefined();
  const repository = inspectGitRepository(cwd)!;
  const args = readOnlyGitArguments(["git", "rev-parse", "--verify", "HEAD"])!;
  const progress = { write: vi.fn(), end: vi.fn() };
  const capture = vi.fn(() => ({ captureId: "quarantined-output", append: () => true, waitForDrain: async () => {},
    finish: async () => ({ version: 1 as const, captureId: "quarantined-output", status: "complete" as const,
      capturedBytes: 0, observedBytes: 0, capturedChars: 0 }), abandon: () => {} }));
  const sessionId = "quarantined-ref-result";
  const previews: string[] = [];
  let workloadStarted = false;
  sandboxTransport();
  const spawned = vi.spyOn(childProcess, "spawn").mockImplementation((_image, invocation) => {
    if (dialect === "powershell" && !workloadStarted && (invocation as string[]).at(-1)?.includes("Parser")) {
      return completedChild(JSON.stringify(parsedCommandResponse(command, ["git", "rev-parse", "--verify", "HEAD"])));
    }
    workloadStarted = true;
    if (width === 64) writeFileSync(join(cwd, ".git", "config"),
      "[core]\n repositoryformatversion = 1\n bare = false\n[extensions]\n objectFormat = sha256\n");
    rmSync(ref);
    symlinkSync(outside, ref, "file");
    // Native positive control: the owned argv/environment alone prints the token.
    const native = nativeChildProcess.spawnSync("git", [`--git-dir=${repository.gitDirectory}`, `--work-tree=${cwd}`, ...args], {
      cwd, encoding: "utf8", env: gitReadOnlyEnvironment({ PATH: nativeSearchPath ?? "", LANG: "C" }, repository, join(cwd, "absent-index")), timeout: 10_000,
    });
    expect(native.error).toBeUndefined();
    expect(native.status, native.stderr).toBe(0);
    expect(native.stdout.trim()).toBe(token);
    return completedChild(native.stdout + "x".repeat(13_000), () => {
      previews.push(JSON.stringify(listShellTasks(sessionId)));
    }, token + "\n");
  });
  setShellSandboxRequestedAtBoot(false);
  const tool = dialect === "bash" ? new BashTool() : new PowerShellTool();
  const result = await tool.execute({ command, timeoutSeconds: 5, run_in_background: background }, {
    cwd, extraAllowedDirectories: [], metadata: { sessionId, toolOutputProgress: progress, toolOutputCaptureFactory: capture },
    hostShellExecutionPlan: preparedIdentity.plan, verifiedShellCommand,
  });
  expect(workloadStarted, result.output).toBe(true);
  expect(spawned).toHaveBeenCalledTimes(dialect === "bash" ? 1 : 2);
  expect(result).toEqual({ output: "Read-only Git output discarded: repository metadata changed during execution.", isError: true, metadata: {} });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(progress.write).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(previews.join("")).not.toContain(token);
});

it.each((["bash", "powershell"] as const).flatMap((dialect) => ["abort", "error"].flatMap((event) =>
  [false, true].map((sandboxed) => ({ dialect, event, sandboxed })))))(
  "holds $dialect output through $event until child close with sandboxed=$sandboxed", async ({ dialect, event, sandboxed }) => {
  const command = "git log HEAD";
  const { cwd, identity } = fixture(sandboxed, command);
  const verifiedShellCommand = prepareVerifiedShellCommand({ command, dialect, cwd });
  expect(verifiedShellCommand).toBeDefined();
  const controller = new AbortController();
  const { child, stdout, stderr } = controlledChild();
  let started = false;
  sandboxTransport();
  vi.spyOn(childProcess, "spawn").mockImplementation((_image, invocation) => {
    if (dialect === "powershell" && !started && (invocation as string[]).at(-1)?.includes("Parser")) {
      return completedChild(JSON.stringify(parsedCommandResponse(command, ["git", "log", "HEAD"])));
    }
    started = true;
    return child as ReturnType<typeof childProcess.spawn>;
  });
  const progress = { write: vi.fn(), end: vi.fn() };
  const capture = vi.fn();
  let settled = false;
  const tool = dialect === "bash" ? new BashTool() : new PowerShellTool();
  const pending = tool.execute({ command, timeoutSeconds: 5 }, {
    cwd, extraAllowedDirectories: [], metadata: { toolOutputProgress: progress, toolOutputCaptureFactory: capture },
    hostShellExecutionPlan: identity.plan, verifiedShellCommand, abortSignal: controller.signal,
  }).then((result) => { settled = true; return result; });
  await vi.waitFor(() => expect(started).toBe(true));
  stdout.write("private output before close");
  if (event === "abort") controller.abort();
  else child.emit("error", new Error("synthetic live child error"));
  // Drain the stopped/error result microtasks without supplying terminal evidence.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(progress.write).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  // A mutation after the stop/error must still be included in the final check.
  writeFileSync(join(cwd, ".git", "config"), "[core]\n bare = true\n");
  Object.assign(child, { exitCode: 1 });
  stdout.end(); stderr.end();
  child.emit("exit", 1, null); child.emit("close", 1, null);
  expect(await pending).toEqual({ output: "Read-only Git output discarded: repository metadata changed during execution.", isError: true, metadata: {} });
});

it.each((["bash", "powershell"] as const).flatMap((dialect) => [false, true].flatMap((sandboxed) =>
  [false, true].map((changed) => ({ dialect, sandboxed, changed })))))(
  "reinspects $dialect after synchronous spawn failure with sandboxed=$sandboxed and changed=$changed", async ({ dialect, sandboxed, changed }) => {
  const command = "git log HEAD";
  const { cwd, identity } = fixture(sandboxed, command);
  const verifiedShellCommand = prepareVerifiedShellCommand({ command, dialect, cwd });
  expect(verifiedShellCommand).toBeDefined();
  sandboxTransport();
  let inspectionsAtSpawn: number | undefined;
  vi.spyOn(childProcess, "spawn").mockImplementation((_image, invocation) => {
    if (dialect === "powershell" && (invocation as string[]).at(-1)?.includes("Parser")) {
      return completedChild(JSON.stringify(parsedCommandResponse(command, ["git", "log", "HEAD"])));
    }
    inspectionsAtSpawn = vi.mocked(inspectGitRepository).mock.calls.length;
    if (changed) {
      const moved = cwd + "-moved";
      renameSync(cwd, moved);
      roots.push(moved);
      writeFileSync(cwd, "not a directory");
    }
    throw Object.assign(new Error("spawn ENOTDIR"), { code: "ENOTDIR" });
  });
  const progress = { write: vi.fn(), end: vi.fn() };
  const capture = vi.fn();
  const tool = dialect === "bash" ? new BashTool() : new PowerShellTool();
  const result = await tool.execute({ command, timeoutSeconds: 5 }, {
    cwd, extraAllowedDirectories: [], metadata: { toolOutputProgress: progress, toolOutputCaptureFactory: capture },
    hostShellExecutionPlan: identity.plan, verifiedShellCommand,
  });
  expect(inspectionsAtSpawn).toBeDefined();
  expect(vi.mocked(inspectGitRepository).mock.calls.length).toBe(inspectionsAtSpawn! + 1);
  expect(inspectGitRepository).toHaveBeenLastCalledWith(cwd);
  if (changed) {
    expect(result).toEqual({ output: "Read-only Git output discarded: repository metadata changed during execution.", isError: true, metadata: {} });
  } else {
    expect(result).toMatchObject({ output: `${dialect === "powershell" ? "PowerShell " : ""}spawn failed: spawn ENOTDIR`, isError: true });
  }
  expect(progress.write).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
});

it.each((["bash", "powershell"] as const).flatMap((dialect) => [false, true].flatMap((sandboxed) =>
  [false, true].map((changed) => ({ dialect, sandboxed, changed })))))(
  "quarantines agent observation of checked $dialect output with sandboxed=$sandboxed and changed=$changed", async ({ dialect, sandboxed, changed }) => {
  const command = "git log HEAD";
  const { cwd, identity } = fixture(sandboxed, command);
  const verifiedShellCommand = prepareVerifiedShellCommand({ command, dialect, cwd });
  expect(verifiedShellCommand).toBeDefined();
  sandboxTransport();
  const daemon = new ObservationDaemon();
  const adapter = new TerminalObservationAdapter(daemon);
  const delivered: TerminalObservationEvent[] = [];
  adapter.registerView("view", "checked-observation", () => true, (batch) => { delivered.push(...batch); adapter.acknowledge("view", batch.at(-1)!.seq); });
  setAgentTerminalObservationSink({ start: (owner, input) => adapter.start(owner, input),
    egress: (token, decision) => adapter.recordEgress(token, decision), releaseSessions: (ended) => adapter.releaseSessions(ended) });
  const snapshotsAtClose: string[] = [];
  let started = false;
  vi.spyOn(childProcess, "spawn").mockImplementation((_image, invocation) => {
    if (dialect === "powershell" && !started && (invocation as string[]).at(-1)?.includes("Parser")) {
      return completedChild(JSON.stringify(parsedCommandResponse(command, ["git", "log", "HEAD"])));
    }
    started = true;
    return completedChild("checked private log\n", () => {
      if (changed) writeFileSync(join(cwd, ".git", "config"), "[core]\n bare = true\n");
      snapshotsAtClose.push(JSON.stringify(delivered));
    });
  });
  const owner = { sessionId: "checked-observation", turnId: "checked-turn", toolUseId: "checked-tool" };
  const tool = dialect === "bash" ? new BashTool() : new PowerShellTool();
  try {
    const result = await runWithAgentObservationTurn(owner, () => runWithAgentObservationInvocation(owner, () => tool.execute({ command, timeoutSeconds: 5 }, {
      cwd, extraAllowedDirectories: [], metadata: {}, hostShellExecutionPlan: identity.plan, verifiedShellCommand,
    })));
    await vi.waitFor(() => {
      const last = delivered.findLast((event) => event.kind === "snapshot");
      expect(last?.kind === "snapshot" ? last.after.commands[0]?.status : undefined).toBe("completed");
    });
    // Nothing reached any snapshot while the result was pending revalidation.
    expect(snapshotsAtClose.join("")).not.toContain("checked private log");
    const last = delivered.findLast((event) => event.kind === "snapshot");
    const observed = last?.kind === "snapshot" ? last.after.commands[0] : undefined;
    expect(observed).toMatchObject({ command, outputAvailability: "on-completion" });
    if (changed) {
      expect(result).toEqual({ output: "Read-only Git output discarded: repository metadata changed during execution.", isError: true, metadata: {} });
      expect(JSON.stringify(delivered)).not.toContain("checked private log");
    } else {
      expect(result.output).toContain("checked private log");
      await vi.waitFor(() => {
        const latest = delivered.findLast((event) => event.kind === "snapshot");
        expect(latest?.kind === "snapshot" ? latest.after.commands[0]?.outputTail : undefined).toBe("checked private log\n");
      });
    }
  } finally {
    setAgentTerminalObservationSink(undefined);
    daemon.dispose();
  }
});
