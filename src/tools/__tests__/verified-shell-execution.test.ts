import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { prepareVerifiedShellCommand, verifiedShellExecution, type VerifiedShellCommand } from "../../permissions/verified-shell-command.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as shellResolver from "../../lib/shell-resolver.js";
import * as sandboxHomeOwner from "../../permissions/sandbox-process-home.js";
import { PowerShellTool } from "../shell-tools.js";
import * as installation from "../../shared/verified-executable.js";
import {
  bindPreparedShellExecutableReadPaths, disposePreparedShellInvocation, matchesPreparedShellInvocation,
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
  writeFileSync(join(shadowDirectory, "bash"), "shadow image", { mode: 0o755 });
  vi.spyOn(childProcess, "execFileSync").mockImplementation(() => { throw new Error("Native probes are outside this controlled transport fixture"); });
  vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Native spawn is outside this controlled transport fixture"); });
  vi.spyOn(shellResolver, "resolveShell").mockReturnValue({ cmd: "controlled-shell", shellArgs: (command) => ["-c", command] });
  vi.spyOn(shellResolver, "shellEnvForChild").mockImplementation((_, environment) => ({ ...environment,
    LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader",
  }));
  vi.spyOn(shellResolver, "shellPathForHostPath").mockImplementation((_, path) => path);
  vi.spyOn(shellResolver, "getBashCapabilities").mockReturnValue({ unicodeEscapes: true, prefixAssignmentRhs: "incoming" });
  vi.spyOn(sandboxHomeOwner, "createSandboxProcessHome").mockImplementation(() => {
    const path = mkdtempSync(join(cwd, "owned-home-"));
    return { path, env: { HOME: path }, cleanup: () => rmSync(path, { recursive: true, force: true }) };
  });
  vi.stubEnv("PATH", `${shadowDirectory}${delimiter}${process.env.PATH ?? ""}`);
  vi.mocked(installation.resolveVerifiedExecutable).mockReturnValue({ executable });
  const command = "bash --noprofile --norc -p -c 'printf ready'";
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
  const parsed = { errors: [], redirections: [], unsupported: [], commands: [{ name: "bash", text: identity.command,
    arguments: ["bash", "--noprofile", "--norc", "-p", "-c", "printf ready"].map((value) => ({ kind: "literal", text: value, value })) }] };
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
  expect(received.join("")).toBe("bash --noprofile --norc -p -c 'printf ready'");
  expect(spawned).toHaveBeenCalledTimes(2);
  expect((spawned.mock.calls[1]![1] as string[]).at(-1)).toContain(`& '${executable}'`);
  expect(spawned.mock.calls[1]![2]?.env).not.toHaveProperty("LD_PRELOAD");
  expect(spawned.mock.calls[1]![2]?.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
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
