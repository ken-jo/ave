import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { prepareVerifiedShellCommand, verifiedShellExecution, type VerifiedShellCommand } from "../../permissions/verified-shell-command.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as shellResolver from "../../lib/shell-resolver.js";
import * as sandboxHomeOwner from "../../permissions/sandbox-process-home.js";
import { PowerShellTool } from "../shell-tools.js";
import * as installation from "../../shared/verified-executable.js";
import {
  bindPreparedShellExecutableReadPaths, claimPreparedShellInvocation, disposePreparedShellInvocation, matchesPreparedShellInvocation,
  prepareShellInvocation, preparedSandboxBootstrap, preparedSandboxEnvironment, preparedShellCommand,
  preparedShellCwdProbe, preparedShellExecutableReadPaths, type PreparedShellInvocation,
} from "../prepared-shell-invocation.js";

vi.mock("node:child_process", { spy: true });
vi.mock("../../shared/powershell-executable.js", () => ({ resolveTrustedPowerShellExecutable: () => ({ executable: "/protected-fixture/pwsh", kind: "pwsh" }) }));
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true }));

const ORIGINAL_PLATFORM = process.platform;
const roots: string[] = [];
const handles: PreparedShellInvocation[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) disposePreparedShellInvocation(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  __resetSandboxRequestedAtBootForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

// Supported-host transport simulation: no native command or installation proof runs in these fixtures.
function fixture(sandboxed = false) {
  setProcessPlatform("linux");
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "verified-shell-execution-")));
  roots.push(cwd);
  const executable = join(cwd, "proved-image");
  const shadowDirectory = join(cwd, "shadow");
  mkdirSync(shadowDirectory);
  writeFileSync(executable, "controlled image", { mode: 0o755 });
  writeFileSync(join(shadowDirectory, "git"), "shadow image", { mode: 0o755 });
  vi.spyOn(childProcess, "execFileSync").mockReturnValue("git version 2.45.0\n");
  vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Native spawn is outside this controlled transport fixture"); });
  vi.spyOn(shellResolver, "resolveShell").mockReturnValue({ cmd: "controlled-shell", shellArgs: (command) => ["-c", command] });
  vi.spyOn(shellResolver, "shellEnvForChild").mockImplementation((_, environment) => environment);
  vi.spyOn(shellResolver, "shellPathForHostPath").mockImplementation((_, path) => path);
  vi.spyOn(shellResolver, "getBashCapabilities").mockReturnValue({ unicodeEscapes: true, prefixAssignmentRhs: "incoming" });
  vi.spyOn(sandboxHomeOwner, "createSandboxProcessHome").mockImplementation(() => {
    const path = mkdtempSync(join(cwd, "owned-home-"));
    return { path, env: { HOME: path }, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  });
  vi.stubEnv("PATH", `${shadowDirectory}${delimiter}${process.env.PATH ?? ""}`);
  vi.mocked(installation.resolveVerifiedExecutable).mockReturnValue({ executable });
  const command = "git rev-parse --verify HEAD";
  const verifiedShellCommand = prepareVerifiedShellCommand({ command, dialect: "bash", cwd });
  expect(verifiedShellCommand).toBeDefined();
  const plan = buildHostShellExecutionPlan({ platform: process.platform, requestedSandbox: sandboxed,
    activeCapability: sandboxed
      ? { kind: "asrt", confidence: "verified", platform: process.platform, reason: "Controlled sandbox fixture", confines: { filesystem: true, process: true, network: true } }
      : { kind: "none", confidence: "verified", platform: process.platform, reason: "Controlled plain fixture", confines: { filesystem: false, process: false, network: false } },
  });
  const identity = { command, executionCwd: cwd, resolvedCwd: cwd, plan, toolUseId: "verified-native-call", verifiedShellCommand };
  const handle = prepareShellInvocation(identity);
  handles.push(handle);
  return { cwd, executable, shadowDirectory, identity, handle };
}

it("retains raw authority identity while binding absolute image argv despite a shadow search path", () => {
  const { executable, shadowDirectory, identity, handle } = fixture();
  const prepared = preparedShellCommand(handle);
  expect(identity.command).toBe("git rev-parse --verify HEAD");
  expect(matchesPreparedShellInvocation(handle, identity)).toBe(true);
  expect(prepared.argv.at(-1)).toContain(`'${executable}'`);
  expect(matchesPreparedShellInvocation(handle, { ...identity, command: prepared.argv.at(-1)! })).toBe(false);
  expect(matchesPreparedShellInvocation(handle, { ...identity, verifiedShellCommand: undefined })).toBe(false);
  expect(prepared.argv[0]).toBe("-c");
  expect(prepared.environment).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  bindPreparedShellExecutableReadPaths(handle);
  expect(preparedShellExecutableReadPaths(handle)).toContain(executable);
  expect(preparedShellExecutableReadPaths(handle)).not.toContain(join(shadowDirectory, "git"));
  expect(preparedShellExecutableReadPaths(handle)).not.toContain(shadowDirectory);
});

it("uses the compiled command when rebuilding foreground argv with a host prelude", () => {
  const { executable, handle } = fixture();
  const { argv } = preparedShellCwdProbe(handle, "printf 'prelude|'; ");
  expect(argv.at(-1)).toContain(`'${executable}'`);
  expect(argv[0]).toBe("-c");
  expect(argv.at(-1)).toMatch(/^printf 'prelude\|'; /);
  expect(argv.at(-1)).not.toContain("; git rev-parse");
});

it("refuses a supplied proof for a changed command, directory, dialect or unissued handle", () => {
  const { identity } = fixture();
  expect(() => prepareShellInvocation({ ...identity, command: "git branch --list" })).toThrow(/does not match/);
  expect(() => prepareShellInvocation({ ...identity, resolvedCwd: join(identity.resolvedCwd, "other") })).toThrow(/does not match/);
  const wrongDialect = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  expect(wrongDialect).toBeDefined();
  expect(() => prepareShellInvocation({ ...identity, verifiedShellCommand: wrongDialect })).toThrow(/does not match/);
  expect(() => prepareShellInvocation({ ...identity, verifiedShellCommand: Object.freeze({}) as VerifiedShellCommand })).toThrow(/does not match/);
});

it("reapplies owned configuration after wrapper overlay and preserves the compiled sandbox bootstrap", () => {
  const { executable, handle } = fixture(true);
  const environment = preparedSandboxEnvironment(handle, { ...process.env,
    GIT_SSH_COMMAND: "untrusted-transport", GIT_CONFIG_PARAMETERS: "untrusted-config", GIT_SSL_CAINFO: "/untrusted-certificate",
    HTTPS_PROXY: "http://localhost:60080", LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader",
  });
  expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(environment.GIT_NO_LAZY_FETCH).toBe("1");
  expect(environment).not.toHaveProperty("GIT_SSH_COMMAND");
  expect(environment).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
  expect(environment).not.toHaveProperty("GIT_SSL_CAINFO");
  expect(environment).not.toHaveProperty("LD_PRELOAD");
  expect(environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
  expect(environment.HTTPS_PROXY).toBe("http://localhost:60080");
  const bootstrap = preparedSandboxBootstrap(handle, { cwdProbe: true });
  expect(bootstrap).toContain(executable);
  expect(bootstrap).toContain("exec 'controlled-shell' '-c'");
  expect(bootstrap).not.toContain("untrusted-transport");
  expect(bootstrap).not.toContain("untrusted-config");
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
  expect(verifiedShellExecution(verified, { command: "git branch --list", dialect: "powershell", cwd: identity.resolvedCwd })).toBeUndefined();
  expect(identity.command).toBe("git rev-parse --verify HEAD");
});

function completedChild(output: string) {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, pid: undefined, killed: false, kill: vi.fn(() => true) });
  queueMicrotask(() => {
    stdout.end(output); stderr.end();
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null); child.emit("close", 0, null);
  });
  return child as ReturnType<typeof childProcess.spawn>;
}

it("keeps raw source at the second shell parser gate and binds its workload command and final environment", async () => {
  const { executable, identity } = fixture();
  const verifiedShellCommand = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd: identity.resolvedCwd });
  expect(verifiedShellCommand).toBeDefined();
  const parsed = { errors: [], redirections: [], unsupported: [], commands: [{ name: "git", text: identity.command,
    arguments: ["git", "rev-parse", "--verify", "HEAD"].map((value) => ({ kind: "literal", text: value, value })) }] };
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
  expect(received.join("")).toBe("git rev-parse --verify HEAD");
  expect(spawned).toHaveBeenCalledTimes(2);
  expect((spawned.mock.calls[1]![1] as string[]).at(-1)).toContain(`& '${executable}'`);
  expect(spawned.mock.calls[1]![2]?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
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
  for (const command of ["git rev-parse --verify HEAD", "bash --noprofile --norc -p -c 'printf ready'"]) {
    for (const dialect of ["bash", "powershell"] as const) {
      expect(prepareVerifiedShellCommand({ command, dialect, cwd: tmpdir() })).toBeUndefined();
    }
  }
  expect(installation.resolveVerifiedExecutable).not.toHaveBeenCalled();
  expect(versionProbe).not.toHaveBeenCalled();
});

it("refuses claiming a prepared image after another invocation holds the workspace", () => {
  const { cwd, handle } = fixture(true);
  const release = holdSandboxGitWrites([cwd]);
  try {
    expect(() => claimPreparedShellInvocation(handle)).toThrow("Verified shell command is no longer available for this invocation");
    expect(preparedSandboxEnvironment(handle, { ...process.env, GIT_SSH_COMMAND: "untrusted-transport" })).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  } finally { release(); }
  const releaseClaim = claimPreparedShellInvocation(handle);
  releaseClaim();
});

it("refuses the workload when another invocation holds the workspace while its parser is pending", async () => {
  const { cwd, identity } = fixture();
  const verifiedShellCommand = prepareVerifiedShellCommand({ command: identity.command, dialect: "powershell", cwd });
  expect(verifiedShellCommand).toBeDefined();
  const parsed = { errors: [], redirections: [], unsupported: [], commands: [{ name: "git", text: identity.command,
    arguments: ["git", "rev-parse", "--verify", "HEAD"].map((value) => ({ kind: "literal", text: value, value })) }] };
  let finishParser!: () => void;
  let noteStarted!: () => void;
  const started = new Promise<void>((resolve) => { noteStarted = resolve; });
  const spawned = vi.spyOn(childProcess, "spawn");
  spawned.mockImplementationOnce(() => {
    const parser = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(parser, { stdin, stdout, stderr, exitCode: null, signalCode: null, pid: undefined, killed: false, kill: vi.fn(() => true) });
    finishParser = () => {
      stdout.end(JSON.stringify(parsed)); stderr.end();
      Object.assign(parser, { exitCode: 0 });
      parser.emit("exit", 0, null); parser.emit("close", 0, null);
    };
    stdin.once("finish", noteStarted);
    return parser as ReturnType<typeof childProcess.spawn>;
  });
  setShellSandboxRequestedAtBoot(false);
  const pending = new PowerShellTool().execute({ command: identity.command, timeoutSeconds: 5 }, {
    cwd, extraAllowedDirectories: [], metadata: {}, hostShellExecutionPlan: getHostShellExecutionPlan(), verifiedShellCommand,
  });
  await started;
  const release = holdSandboxGitWrites([cwd]);
  try {
    finishParser();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.output).toBe("PowerShell spawn failed: verified shell command is no longer available for this invocation.");
    expect(spawned).toHaveBeenCalledTimes(1);
  } finally { release(); }
});
