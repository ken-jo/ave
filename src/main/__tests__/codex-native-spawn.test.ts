vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { spawnManaged } from "../managed-child-processes.js";
import { spawnCodexNative } from "../codex-native-spawn.js";

vi.mock("../managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));

const HOST = process.platform;
const HOST_EXEC_PATH = process.execPath;
// Node pipe stdio uses socket pairs; Linux reopening /dev/stderr can fail with ENXIO, so write the inherited descriptor.
const BOTH_STREAMS = { command: "/usr/bin/sed", args: ["-n", "-e", "p", "-e", "w /dev/stderr"] } as const;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(spawnManaged).mockReset();
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

function runChild(launch: () => ChildProcess, input?: string, onSpawn?: (child: ChildProcess) => void | Promise<void>) {
  // Keep the test loop available to service cancellation and child handshakes.
  let child: ChildProcess;
  try {
    child = launch();
  } catch (error) {
    return Promise.resolve({ error: error as Error, status: null, signal: null, stdout: "", stderr: "" });
  }
  let failure: Error | undefined;
  child.once("error", (error) => { failure ??= error; });
  const handleInputError = (error: NodeJS.ErrnoException): void => {
    if (input || (error.code !== "EPIPE" && error.code !== "ENOTCONN")) {
      failure ??= error;
      child.kill("SIGKILL");
    }
  };
  child.stdin?.on("error", handleInputError);
  const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });

  const capture = async (stream: Readable | null): Promise<string> => {
    if (!stream) return "";
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > 256 * 1024) {
        child.kill("SIGKILL");
        throw new Error("Native process output exceeded its limit");
      }
      chunks.push(data);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const inputDelivered = new Promise<void>((resolve) => {
    if (!child.stdin) { resolve(); return; }
    child.stdin.end(input ?? "", (error?: Error | null) => {
      if (error) handleInputError(error);
      resolve();
    });
  });
  const setupCompleted = Promise.resolve().then(() => onSpawn?.(child));
  return Promise.all([closed, capture(child.stdout), capture(child.stderr), inputDelivered, setupCompleted])
    .then(([exit, stdout, stderr]) => ({ ...exit, error: failure, stdout, stderr }));
}

function runPlan(plan: ReturnType<typeof spawnPlan>, input?: string, onSpawn?: (child: ChildProcess) => void | Promise<void>) {
  return runChild(() => spawn(plan.command, [...plan.args], {
    ...plan.options,
    timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
    killSignal: "SIGKILL",
  }), input, onSpawn);
}

describe("native spawn boundary", () => {
  it.runIf(HOST !== "win32")("starts the native program without reopening a group-writable host installation", () => {
    const applications = join(tempRoot(), "Applications");
    const hostDirectory = join(applications, "Ave.app", "Contents", "MacOS");
    mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
    chmodSync(applications, 0o775);
    const execPath = join(hostDirectory, "Ave");
    symlinkSync(HOST_EXEC_PATH, execPath);
    vi.stubGlobal("process", { ...process, platform: "darwin", execPath });
    expect(statSync(applications).mode & 0o777).toBe(0o775);
    expect(spawnPlan("/runtime/native", [], { env: {} }).command).toBe("/runtime/native");
  });

  it("replaces the trusted host process on the fork-based platform", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
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

  it.each(["darwin", "win32"] as const)("uses the native process boundary directly on %s", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const options: SpawnOptions = { env: { ONLY_RUNTIME: "value" }, stdio: "pipe", cwd: tmpdir(), windowsHide: true, shell: true };
    const command = platform === "win32" ? String.raw`C:\private\runtime\native.exe` : "/private/runtime/native";
    const plan = spawnPlan(command, ["app-server"], options);
    expect(plan).toEqual({ command, args: ["app-server"], options: { ...options, shell: false } });
    expect(plan.options.env).toBe(options.env);
  });

  it.each(["darwin", "win32"] as const)("uses an empty environment for an omitted native %s environment", (platform) => {
    vi.stubEnv("NODE_OPTIONS", "--require /untrusted/loader.js");
    vi.stubGlobal("process", { ...process, platform });
    const command = platform === "win32" ? String.raw`C:\private\runtime\native.exe` : "/private/runtime/native";
    expect(spawnPlan(command).options.env).toEqual({});
  });

  it.each([{ uid: 0 }, { gid: 0 }, { detached: true }])("rejects options that can select a fork-based launch: %j", (options) => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(() => spawnCodexNative("/runtime/native", [], options, "native-runtime")).toThrow("current account session");
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("rejects native path lookup on the direct POSIX boundary", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(() => spawnCodexNative("native", [], {}, "native-runtime")).toThrow("absolute path");
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("exits 126 when the trusted runtime cannot replace itself", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const plan = spawnPlan("/unused/native", [], { env: {} });
    const args = [...plan.args];
    args[2] = `process.execve = undefined;\n${args[2]}`;
    const result = await runPlan({ ...plan, args });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(126);
  });

  it("exits 126 for a catchable replacement error", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const plan = spawnPlan("/unused/native", [], { env: {} });
    const args = [...plan.args];
    args[2] = `process.execve = () => { throw new Error('Rejected'); };\n${args[2]}`;
    const result = await runPlan({ ...plan, args });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(126);
  });
});

describe.skipIf(HOST === "win32" || (HOST !== "darwin" && typeof process.execve !== "function"))("native program execution", () => {
  it("executes a successful native program through the platform boundary", async () => {
    const result = await runPlan(spawnPlan("/usr/bin/true", [], { env: {} }));
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("passes exactly the supplied environment to the native program", async () => {
    const env = { ONLY_RUNTIME: "a value with spaces", EMPTY_VALUE: "", PATH: "/private/runtime" };
    const result = await runPlan(spawnPlan("/usr/bin/env", [], { env }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n").sort()).toEqual(Object.entries(env).map(([key, value]) => `${key}=${value}`).sort());
  });

  it("keeps the parent loop responsive while a bootstrap awaits its grant pipe", async () => {
    const script = [
      'const grant = new (require("node:net").Socket)({ fd: 3, readable: true, writable: false });',
      "grant.resume();",
      'grant.once("end", () => process.stdout.write("granted\\n"));',
    ].join("\n");
    const result = await runPlan({ command: HOST_EXEC_PATH, args: ["--eval", script], options: {
      env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe", "pipe"],
    } }, undefined, (child) => new Promise<void>((resolve, reject) => {
      const grant = child.stdio[3] as Writable;
      grant.once("error", reject);
      setImmediate(() => grant.end("granted", (error?: Error | null) => error ? reject(error) : resolve()));
    }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("granted\n");
  });

  it("closes standard input when no input is supplied", async () => {
    const result = await runPlan(spawnPlan("/bin/cat", [], { env: {} }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("drains both output streams while delivering a large input", async () => {
    const input = "request body\n".repeat(12_000);
    const result = await runPlan(spawnPlan(BOTH_STREAMS.command, BOTH_STREAMS.args, { env: {} }), input);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toBe(input);
  });

  it("tracks native I/O and cancellation through the process manager", async () => {
    const managed = await vi.importActual<typeof import("../managed-child-processes.js")>("../managed-child-processes.js");
    vi.mocked(spawnManaged).mockImplementation(managed.spawnManaged);
    const initialCount = managed.getManagedChildProcessCount();
    const options: SpawnOptions = {
      cwd: tempRoot(), env: {}, stdio: ["pipe", "pipe", "pipe"],
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, killSignal: "SIGKILL",
    };
    const input = "request body\n".repeat(12_000);
    const delivered = await runChild(() => spawnCodexNative(BOTH_STREAMS.command, BOTH_STREAMS.args, options, "native-io"), input);
    expect(delivered.error).toBeUndefined();
    expect(delivered.status).toBe(0);
    expect(delivered.stdout).toBe(input);
    expect(delivered.stderr).toBe(input);
    expect(managed.getManagedChildProcessCount()).toBe(initialCount);

    const controller = new AbortController();
    const cancelled = await runChild(() => {
      const child = spawnCodexNative("/bin/sleep", [String(TOOL_TIMEOUT_POLICY.globalCeilingMs / 1_000)], {
        ...options, signal: controller.signal,
      }, "native-cancellation");
      expect(managed.getManagedChildProcessCount()).toBe(initialCount + 1);
      return child;
    }, undefined, () => controller.abort());
    expect(cancelled.error).toMatchObject({ code: "ABORT_ERR" });
    expect(cancelled.status).toBeNull();
    expect(cancelled.signal).toBe("SIGKILL");
    expect(managed.getManagedChildProcessCount()).toBe(initialCount);
  });

  it("waits for a cancelled native plan to close", async () => {
    const controller = new AbortController();
    const result = await runPlan(spawnPlan("/bin/sleep", [String(TOOL_TIMEOUT_POLICY.globalCeilingMs / 1_000)], {
      env: {}, signal: controller.signal,
    }), undefined, () => {
      controller.abort();
    });
    expect(result.error).toMatchObject({ code: "ABORT_ERR" });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });

  it("reports a write failure when a native program closes a nonempty input early", async () => {
    const result = await runPlan(spawnPlan("/usr/bin/true", [], { env: {} }), "input\n".repeat(1024 * 1024));
    expect(result.error).toMatchObject({ code: expect.stringMatching(/^(EPIPE|ENOTCONN)$/) });
  });

  it("preserves argument boundaries through native replacement", async () => {
    const args = ["argument with spaces", "'; $(printf not-code)", "--leading-option"];
    const result = await runPlan(spawnPlan("/usr/bin/printf", ["%s\n", ...args], { env: {} }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${args.join("\n")}\n`);
  });

  it("preserves standard input and output through native replacement", async () => {
    const input = "request body\nnext line\n";
    const result = await runPlan(spawnPlan("/bin/cat", [], { env: {}, stdio: ["pipe", "pipe", "pipe"] }), input);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input);
  });

  // The flag is a property of the open file description, so the program reads what the bootstrap left: Electron 45 opens stderr while it starts, which
  // sets O_NONBLOCK, and execve keeps it. Linux reports it in fdinfo (octal).
  it.runIf(HOST === "linux")("hands the native program blocking standard output and error", async () => {
    const O_NONBLOCK = 0o4000;
    const result = await runPlan(spawnPlan("/bin/sh", ["-c", "for fd in 1 2; do grep '^flags:' /proc/self/fdinfo/$fd; done"], {
      env: {}, stdio: ["pipe", "pipe", "pipe"],
    }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const flags = result.stdout.trim().split("\n").map((line) => Number.parseInt(line.replace(/^flags:\s*/u, ""), 8));
    expect(flags).toHaveLength(2);
    expect(flags.map((value) => (value & O_NONBLOCK) === 0)).toEqual([true, true]);
  });

  it("preserves the requested working directory", async () => {
    const root = tempRoot();
    const result = await runPlan(spawnPlan("/bin/pwd", [], { env: {}, cwd: root }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });

  it.each(["plain text", "native-prefixed text"])("never interprets a rejected %s file", async (kind) => {
    const root = tempRoot();
    const candidate = join(root, "candidate");
    const marker = join(root, "marker");
    const prefix = kind === "native-prefixed text" ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x0a]) : Buffer.alloc(0);
    const payload = Buffer.from('printf interpreted > "$AVE_NATIVE_MARKER"\n');
    writeFileSync(candidate, Buffer.concat([prefix, payload]), { mode: 0o700 });
    const managed = await vi.importActual<typeof import("../managed-child-processes.js")>("../managed-child-processes.js");
    vi.mocked(spawnManaged).mockImplementation(managed.spawnManaged);
    const initialCount = managed.getManagedChildProcessCount();
    const result = await runChild(() => spawnCodexNative(candidate, [], {
      cwd: root, env: { AVE_NATIVE_MARKER: marker },
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, killSignal: "SIGKILL",
    }, "native-rejection"));
    if (HOST === "darwin") expect(result.error).toMatchObject({ code: "ENOEXEC" });
    else {
      expect(result.error).toBeUndefined();
      expect(result.status === 126 || result.signal === "SIGABRT" || (result.status !== null && result.status !== 0)).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
    expect(managed.getManagedChildProcessCount()).toBe(initialCount);
  });
});
