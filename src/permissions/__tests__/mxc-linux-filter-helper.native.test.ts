import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer as createUnixServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { collectStream as collect } from "../../__tests__/support/collect-stream.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBubblewrapShellRequest, LINUX_SHELL_ENVIRONMENT_FAILED_CODE, LINUX_SHELL_READY_FD, linuxShellExtraDescriptors, writeLinuxShellEnvironment,
} from "../mxc-linux.js";
import { posixPolicyLookups } from "../mxc-posix.js";

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const HELPER = resolve("resources", "linux-shell-seccomp", process.arch, "apply-seccomp");


describe.runIf(NATIVE)("native Linux filter helper options", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ave-filter-helper-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // Descriptors 3 to 7: 3 a file, 4 the ready pipe, 5 a pipe, 6 and 7 files.
  async function run(args: readonly string[]) {
    const files = [openSync(join(root, "a"), "w"), openSync(join(root, "b"), "w"), openSync(join(root, "c"), "w")];
    try {
      const child = spawn(HELPER, args, { stdio: ["ignore", "pipe", "pipe", files[0], "pipe", "pipe", files[1], files[2]] });
      const [stdout, stderr, ready, code] = await Promise.all([
        collect(child.stdout), collect(child.stderr), collect(child.stdio[4] as Readable),
        new Promise<number | null>(done => child.once("close", done)),
      ]);
      return { stdout, stderr, ready, code };
    } finally {
      for (const fd of files) closeSync(fd);
    }
  }

  it("leaves the command only 0, 1, 2 and the kept descriptor", async () => {
    const result = await run(["--close-other-fds", "--keep-fd", "7", "--", "/bin/sh", "-c", "ls -1 /proc/$$/fd"]);
    expect(result).toMatchObject({ code: 0, ready: "" });
    expect(result.stdout.trim().split("\n").map(Number).toSorted((a, b) => a - b)).toEqual([0, 1, 2, 7]);
    // Control: without the option, the inherited descriptors reach the command.
    const control = await run(["--", "/bin/sh", "-c", "ls -1 /proc/$$/fd"]);
    expect(control.stdout.trim().split("\n").map(Number)).toEqual(expect.arrayContaining([3, 4, 5, 6, 7]));
  });

  it("writes one ready byte on the named descriptor once the filter is on, then closes it before the command", async () => {
    const result = await run(["--ready-fd", "4", "--close-other-fds", "--",
      "/bin/sh", "-c", "if (printf x >&4) 2>/dev/null; then echo open; else echo closed; fi; ls -1 /proc/$$/fd"]);
    expect(result).toMatchObject({ code: 0, ready: "\n" });
    expect(result.stdout.split("\n")[0]).toBe("closed");
    expect(result.stdout.trim().split("\n").slice(1).map(Number).toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
    // The filter is on when the byte arrives: the command cannot create a Unix socket.
    const filtered = await run(["--ready-fd", "4", "--", HELPER, "--check-unix-socket", join(root, "s")]);
    expect(filtered).toMatchObject({ code: 0, ready: "\n" });
  });

  it("sets each --env variable for the command, keeping later equals signs in the value", async () => {
    const result = await run(["--env", "AVE_ONE=a=b", "--env", "AVE_TWO=", "--", "/bin/sh", "-c", `printf "%s|%s|%s" "$AVE_ONE" "\${AVE_TWO-unset}" "\${AVE_THREE-unset}"`]);
    expect(result).toMatchObject({ code: 0, stdout: "a=b||unset" });
  });

  it("refuses an unknown option, options without --, a closed or low descriptor and an --env without a name", async () => {
    for (const args of [
      ["--unknown", "--", "/bin/true"], ["--close-other-fds", "/bin/true"], ["--ready-fd", "9", "--", "/bin/true"],
      ["--ready-fd", "2", "--", "/bin/true"], ["--keep-fd", "x", "--", "/bin/true"], ["--env", "=x", "--", "/bin/true"],
      ["--env", "NOEQUALS", "--", "/bin/true"], ["--ready-fd", "4", "--ready-fd", "5", "--", "/bin/true"],
    ]) {
      const result = await run(args);
      expect({ args, code: result.code, ready: result.ready }).toEqual({ args, code: 126, ready: "" });
      expect(result.stderr).toContain("Cannot establish the shell filter");
    }
  });

  it("keeps the option-free form: the first word is the command", async () => {
    await expect(run(["/bin/echo", "--close-other-fds"])).resolves.toMatchObject({ code: 0, stdout: "--close-other-fds\n" });
  });
});

// The Linux shell's bootstrap, as the request carries it, under the filter, under dash and under bash started as `sh`
// (some distributions link /bin/sh to bash, whose POSIX mode ends the shell on a failed special builtin).
describe.runIf(NATIVE)("native Linux shell bootstrap under each POSIX sh", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ave-shell-bootstrap-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const shells = [["dash", "/bin/sh"], ["bash as sh", "bash"]] as const;

  async function run(shell: string, script: string) {
    const { request } = buildBubblewrapShellRequest({
      grants: { readwrite: ["/work"], readonly: ["/usr"], denied: [], chainFolders: [], ungrantedDenies: [] },
      lookups: { ...posixPolicyLookups("/home/example", false), exists: () => true, canonical: (path: string) => path },
      cwd: "/work", commandLine: 'printf "ran %s\\n" "$AVE_MARKER"', timeoutMs: 3000, env: {},
      proxyUrl: "http://127.0.0.1:12345", helper: HELPER,
    });
    let commandLine: string = request.process.commandLine;
    if (shell === "bash") {
      // bash takes POSIX mode from the name it was started under.
      const link = join(root, "sh");
      symlinkSync("/bin/bash", link);
      commandLine = commandLine.replace(" -- /bin/sh -c ", ` -- ${link} -c `);
      expect(commandLine).toContain(link);
    }
    const child = spawn("/bin/sh", ["-c", commandLine], { stdio: ["ignore", "pipe", "pipe", ...linuxShellExtraDescriptors(), "pipe"] });
    writeLinuxShellEnvironment(child, Buffer.from(script));
    const [stdout, stderr, ready, code] = await Promise.all([
      collect(child.stdout), collect(child.stderr), collect(child.stdio[LINUX_SHELL_READY_FD] as Readable),
      new Promise<number | null>(done => child.once("close", done)),
    ]);
    return { stdout, stderr, ready, code };
  }

  it.each(shells)("loads the environment, signals ready and runs the command under %s", async (_name, shell) => {
    const result = await run(shell, "export AVE_MARKER='present\n'\n");
    expect(result, result.stderr).toMatchObject({ code: 0, ready: "\n", stdout: "ran present\n\n" });
  });

  it.each(shells)("exits %s's bootstrap with the load-failure status and no ready byte when an export fails", async (_name, shell) => {
    const result = await run(shell, "readonly AVE_MARKER=fixed\nexport AVE_MARKER=changed\n");
    expect(result).toMatchObject({ code: LINUX_SHELL_ENVIRONMENT_FAILED_CODE, ready: "", stdout: "" });
  });
});

// The proxy bridge: the helper binds a loopback port in the command's network namespace, forks, and forwards each
// connection to a Unix socket from the unfiltered parent. bwrap gives each case its own network and pid namespace.
describe.runIf(NATIVE)("native Linux proxy bridge", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ave-proxy-bridge-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const PORT = 3128;

  async function contained(helper: string, args: readonly string[], options: { readonly ready?: boolean } = {}) {
    const child = spawn("/usr/bin/bwrap", [
      "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc", "--", helper, ...args,
    ], { stdio: ["ignore", "pipe", "pipe", "ignore", options.ready === false ? "ignore" : "pipe"] });
    const [stdout, stderr, ready, code] = await Promise.all([
      collect(child.stdout), collect(child.stderr), options.ready === false ? Promise.resolve("") : collect(child.stdio[4] as Readable),
      new Promise<number | null>(done => child.once("close", done)),
    ]);
    return { stdout, stderr, ready, code };
  }

  it.each([
    [["--proxy-bridge", "0", "/run/proxy.sock"], "a port from 1 to 65535"],
    [["--proxy-bridge", "65536", "/run/proxy.sock"], "a port from 1 to 65535"],
    [["--proxy-bridge", "port", "/run/proxy.sock"], "a port from 1 to 65535"],
    [["--proxy-bridge", "3128", "relative.sock"], "absolute socket path"],
    [["--proxy-bridge", "3128", `/${"s".repeat(107)}`], "at most 107 bytes"],
    [["--proxy-bridge", "3128", "/a.sock", "--proxy-bridge", "3129", "/b.sock"], "unknown option --proxy-bridge"],
  ] as const)("refuses %j and runs nothing", async (options, message) => {
    const result = await contained(HELPER, [...options, "--", "/bin/sh", "-c", "echo ran"], { ready: false });
    expect(result).toMatchObject({ code: 126, stdout: "" });
    expect(result.stderr).toContain(message);
  });

  it("accepts a socket path of exactly 107 bytes", async () => {
    const path = `/${"s".repeat(106)}`;
    expect(Buffer.byteLength(path)).toBe(107);
    expect(await contained(HELPER, ["--proxy-bridge", String(PORT), path, "--", "/bin/sh", "-c", "exit 0"], { ready: false }))
      .toMatchObject({ code: 0 });
  });

  it.each([[0], [7], [143]])("exits with the command's status %s", async (status) => {
    const result = await contained(HELPER, ["--proxy-bridge", String(PORT), join(root, "proxy.sock"), "--ready-fd", "4", "--",
      "/bin/sh", "-c", `exit ${status}`]);
    expect(result).toMatchObject({ code: status, ready: "\n" });
  });

  it("reports a command ended by a signal as 128 plus the signal", async () => {
    const result = await contained(HELPER, ["--proxy-bridge", String(PORT), join(root, "proxy.sock"), "--", "/bin/sh", "-c", "kill -KILL $$"], { ready: false });
    expect(result.code).toBe(128 + 9);
  });

  it("forwards the command's loopback connection to the socket outside its filter, both ways", async () => {
    const socket = join(root, "proxy.sock");
    const server = createUnixServer((connection) => {
      connection.once("data", (data) => { connection.end(`echo:${data.toString()}`); });
    });
    await new Promise<void>(done => server.listen(socket, done));
    try {
      const result = await contained(HELPER, ["--close-other-fds", "--proxy-bridge", String(PORT), socket, "--", "/usr/bin/python3", "-c", [
        "import socket",
        `s = socket.create_connection(("127.0.0.1", ${PORT}))`,
        's.sendall(b"ping"); s.shutdown(socket.SHUT_WR)',
        "print(s.makefile().read())",
        // The command's own Unix socket stays refused by its filter.
        "try:",
        `    socket.socket(socket.AF_UNIX).connect(${JSON.stringify(socket)})`,
        "    print('unix connected')",
        "except PermissionError:",
        "    print('unix refused')",
      ].join("\n")], { ready: false });
      expect(result, result.stderr).toMatchObject({ code: 0, stdout: "echo:ping\nunix refused\n" });
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  });

  // N19: the command attacks its bridge (its parent), then kills it.
  const ATTACK = [
    "import ctypes, os, signal, time",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "bridge = os.getppid()",
    "def call(result):",
    "    return 'ok' if result >= 0 else os.strerror(ctypes.get_errno())",
    "out = {}",
    "out['attach'] = call(libc.ptrace(16, bridge, None, None))",
    "out['seize'] = call(libc.ptrace(0x4206, bridge, None, None))",
    "class iovec(ctypes.Structure):",
    "    _fields_ = [('base', ctypes.c_void_p), ('len', ctypes.c_size_t)]",
    "buffer = ctypes.create_string_buffer(8)",
    "local = iovec(ctypes.cast(buffer, ctypes.c_void_p), 8)",
    // An unmapped address: a permitted read fails with EFAULT, a refused one with EPERM first.
    "remote = iovec(ctypes.c_void_p(0x10), 8)",
    "libc.process_vm_readv.restype = ctypes.c_ssize_t",
    "out['vm_readv'] = call(libc.process_vm_readv(bridge, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0))",
    "def attempt(name, action):",
    "    try:",
    "        action(); out[name] = 'ok'",
    "    except OSError as error:",
    "        out[name] = os.strerror(error.errno)",
    "attempt('mem', lambda: open(f'/proc/{bridge}/mem', 'rb').close())",
    "attempt('fd', lambda: os.listdir(f'/proc/{bridge}/fd'))",
    "attempt('environ', lambda: open(f'/proc/{bridge}/environ', 'rb').read())",
    "attempt('root', lambda: os.listdir(f'/proc/{bridge}/root'))",
    "print(';'.join(f'{key}={value}' for key, value in out.items()), flush=True)",
    "os.kill(bridge, signal.SIGKILL)",
    "time.sleep(30)",
    "print('outlived', flush=True)",
  ].join("\n");

  function attack(helper: string) {
    return contained(helper, ["--close-other-fds", "--proxy-bridge", String(PORT), join(root, "proxy.sock"), "--", "/usr/bin/python3", "-c", ATTACK],
      { ready: false });
  }

  function verdicts(stdout: string): Record<string, string> {
    return Object.fromEntries((stdout.split("\n")[0] ?? "").split(";").map(pair => pair.split("=") as [string, string]));
  }

  it("refuses the command every route into its bridge, at this host's ptrace scope, and ends with it", async () => {
    const scope = readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
    const started = Date.now();
    const result = await attack(HELPER);
    expect(result.stdout, `ptrace_scope ${scope}`).not.toContain("outlived");
    expect(Date.now() - started).toBeLessThan(10_000);
    // bwrap ends when the bridge, its only child, is killed; the command does not outlive the namespace.
    expect(result.code).toBe(128 + 9);
    expect(verdicts(result.stdout), `ptrace_scope ${scope}`).toEqual({
      attach: "Operation not permitted", seize: "Operation not permitted", vm_readv: "Operation not permitted",
      mem: "Permission denied", fd: "Permission denied", environ: "Permission denied", root: "Permission denied",
    });
  }, 20_000);

  it("is the non-dumpable step that closes /proc: a bridge built without it exposes fd and environ", async () => {
    const target = join(root, "control-target");
    execFileSync("cargo", ["build", "--manifest-path", "native/linux-shell-seccomp/Cargo.toml", "--locked", "--offline", "--release",
      "--features", "dumpable-bridge-control", "--target-dir", target], { stdio: "ignore", timeout: 300_000 });
    const result = await attack(join(target, "release", "apply-seccomp"));
    expect(verdicts(result.stdout)).toMatchObject({ fd: "ok", environ: "ok", root: "ok" });
    // At ptrace_scope 0 (CI's scope-zero step) Yama no longer stands in: the control's attach succeeds, so the scope
    // mattered and the refusals above at scope 0 are the non-dumpable step's alone. (Its seize then meets a tracee
    // already attached, so only the attach is the measure.)
    if (readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim() === "0") {
      expect(verdicts(result.stdout)).toMatchObject({ attach: "ok" });
    }
  }, 320_000);
});
