import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { spawnManaged } from "../managed-child-processes.js";
import { spawnCodexNative } from "../codex-native-spawn.js";

vi.mock("../managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));

const HOST = process.platform;
const HOST_EXEC_PATH = process.execPath;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-spawn-")));
  roots.push(root);
  return root;
}

function spawnPlan(command: string, args: readonly string[] = [], options: SpawnOptions = {}): {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
} {
  vi.mocked(spawnManaged).mockReturnValue({} as ChildProcess);
  spawnCodexNative(command, args, options, "native-runtime");
  const [spawnCommand, spawnArgs, spawnOptions] = vi.mocked(spawnManaged).mock.calls.at(-1)!;
  return { command: spawnCommand, args: spawnArgs, options: spawnOptions };
}

function runPlan(plan: ReturnType<typeof spawnPlan>, input?: string) {
  return spawnSync(plan.command, [...plan.args], {
    ...plan.options,
    encoding: "utf8",
    input,
    timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
    maxBuffer: 256 * 1024,
  });
}

describe("native spawn boundary", () => {
  it.runIf(HOST !== "win32")("uses the running host in a group-writable system application directory", () => {
    const applications = join(tempRoot(), "Applications");
    const hostDirectory = join(applications, "Ave.app", "Contents", "MacOS");
    mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
    chmodSync(applications, 0o775);
    const execPath = join(hostDirectory, "Ave");
    symlinkSync(HOST_EXEC_PATH, execPath);
    vi.stubGlobal("process", { ...process, platform: "darwin", execPath });
    expect(statSync(applications).mode & 0o777).toBe(0o775);
    expect(spawnPlan("/runtime/native", [], { env: {} }).command).toBe(execPath);
  });

  it.each(["linux", "darwin"] as const)("replaces the trusted host process on %s", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const options: SpawnOptions = {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      shell: true,
      env: { ONLY_RUNTIME: "value" },
    };
    const plan = spawnPlan("/private/runtime/native", ["app-server", "--stdio"], options);
    expect(plan.command).toBe(HOST_EXEC_PATH);
    expect(plan.args.slice(0, 2)).toEqual(["--no-warnings", "--eval"]);
    expect(plan.args.slice(3)).toEqual([
      "--", "/private/runtime/native", JSON.stringify(options.env), "app-server", "--stdio",
    ]);
    expect(plan.args[2]).toContain("process.execve(command, [command, ...args], env)");
    expect(plan.options).toEqual({
      ...options,
      shell: false,
      env: { ONLY_RUNTIME: "value", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(options.env).toEqual({ ONLY_RUNTIME: "value" });
    expect(spawnManaged).toHaveBeenLastCalledWith(plan.command, plan.args, plan.options, { label: "native-runtime" });
  });

  it("keeps the target and arguments outside static bootstrap code", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const command = "/runtime/'; process.exit(0); //";
    const args = ["$(printf injected)", "`unexpected`", "--require", "argument with spaces"];
    const first = spawnPlan(command, args, { env: { TOKEN: "data'; code" } });
    const second = spawnPlan("/another/native", [], { env: {} });
    expect(first.args[2]).toBe(second.args[2]);
    expect(first.args[2]).not.toContain(command);
    for (const arg of args) expect(first.args[2]).not.toContain(arg);
    expect(first.args.slice(4)).toEqual([command, JSON.stringify({ TOKEN: "data'; code" }), ...args]);
  });

  it("does not inherit ambient runtime options or environment", () => {
    vi.stubEnv("NODE_OPTIONS", "--require /untrusted/loader.js");
    vi.stubEnv("NODE_PATH", "/untrusted/modules");
    vi.stubEnv("AMBIENT_SECRET", "unrelated");
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const plan = spawnPlan("/runtime/native");
    expect(plan.options.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(plan.args[5]).toBe("{}");
  });

  it("returns the managed child unchanged", () => {
    const child = {} as ChildProcess;
    vi.mocked(spawnManaged).mockReturnValue(child);
    expect(spawnCodexNative("/runtime/native", [], { env: {} }, "native-runtime")).toBe(child);
  });

  it("uses the native process boundary directly on the native platform", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const options: SpawnOptions = { env: { ONLY_RUNTIME: "value" }, stdio: "pipe", cwd: tmpdir(), windowsHide: true, shell: true };
    const plan = spawnPlan(String.raw`C:\private\runtime\native.exe`, ["app-server"], options);
    expect(plan).toEqual({ command: String.raw`C:\private\runtime\native.exe`, args: ["app-server"], options: { ...options, shell: false } });
    expect(plan.options.env).toBe(options.env);
  });

  it("exits 126 when the trusted runtime cannot replace itself", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const plan = spawnPlan("/unused/native", [], { env: {} });
    const args = [...plan.args];
    args[2] = `process.execve = undefined;\n${args[2]}`;
    const result = runPlan({ ...plan, args });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(126);
  });

  it("exits 126 for a catchable replacement error", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const plan = spawnPlan("/unused/native", [], { env: {} });
    const args = [...plan.args];
    args[2] = `process.execve = () => { throw new Error('Rejected'); };\n${args[2]}`;
    const result = runPlan({ ...plan, args });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(126);
  });
});

describe.skipIf(HOST === "win32" || typeof process.execve !== "function")("native replacement execution", () => {
  it("executes a successful native program in the actual trusted host runtime", () => {
    const result = runPlan(spawnPlan("/usr/bin/true", [], { env: {} }));
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("passes exactly the supplied environment to the native program", () => {
    const env = { ONLY_RUNTIME: "a value with spaces", EMPTY_VALUE: "", PATH: "/private/runtime" };
    const result = runPlan(spawnPlan("/usr/bin/env", [], { env }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n").sort()).toEqual(Object.entries(env).map(([key, value]) => `${key}=${value}`).sort());
  });

  it("preserves argument boundaries through native replacement", () => {
    const args = ["argument with spaces", "'; $(printf not-code)", "--leading-option"];
    const result = runPlan(spawnPlan("/usr/bin/printf", ["%s\n", ...args], { env: {} }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${args.join("\n")}\n`);
  });

  it("preserves standard input and output through native replacement", () => {
    const input = "request body\nnext line\n";
    const result = runPlan(spawnPlan("/bin/cat", [], { env: {}, stdio: ["pipe", "pipe", "pipe"] }), input);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input);
  });

  it("preserves the requested working directory", () => {
    const root = tempRoot();
    const result = runPlan(spawnPlan("/bin/pwd", [], { env: {}, cwd: root }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });

  it.each(["plain text", "native-prefixed text"])("never interprets a rejected %s file", (kind) => {
    const root = tempRoot();
    const candidate = join(root, "candidate");
    const marker = join(root, "marker");
    const prefix = kind === "native-prefixed text" ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x0a]) : Buffer.alloc(0);
    const payload = Buffer.from('printf interpreted > "$AVE_NATIVE_MARKER"\n');
    writeFileSync(candidate, Buffer.concat([prefix, payload]), { mode: 0o700 });
    const result = runPlan(spawnPlan(candidate, [], { env: { AVE_NATIVE_MARKER: marker } }));
    expect(result.error).toBeUndefined();
    expect(result.status === 126 || result.signal === "SIGABRT" || (result.status !== null && result.status !== 0)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
