import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { holdHostShellSpawnDirectory, HostShellDirectoryHoldError, type HostShellSpawnDirectoryHold } from "../host-shell-execution-permit.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";
import { resolveWindowsJobLauncher } from "../../main/windows-job-launcher.js";

const helpers = vi.hoisted(() => ({ spawned: [] as import("node:child_process").ChildProcess[], binary: undefined as string | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const helper = String(args[0]).endsWith("ave-path-kind.exe");
      if (helper && helpers.binary !== undefined) args[0] = helpers.binary;
      const child = actual.spawn(...args);
      if (helper) helpers.spawned.push(child);
      return child;
    },
  };
});

withSourceHostResources();

const refused = (action: () => void): string | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

describe.runIf(process.platform === "win32")("host shell spawn directory hold", () => {
  let root: string;
  let parent: string;
  let leaf: string;
  let hold: HostShellSpawnDirectoryHold | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-cwd-hold-")));
    parent = join(root, "parent");
    leaf = join(parent, "leaf");
    mkdirSync(leaf, { recursive: true });
    mkdirSync(join(root, "sibling"));
    hold = undefined;
    helpers.spawned = [];
  });
  afterEach(async () => {
    hold?.dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(parent, join(root, "released")))).toBeUndefined());
    await cleanupTmpDir(root);
  });

  const identityOf = (path: string) => {
    const identity = captureShellWorkingDirectoryIdentity(path);
    if (identity === undefined) throw new Error("directory identity unavailable");
    return identity;
  };
  const holdLeaf = async () => {
    const held = await holdHostShellSpawnDirectory({ cwdIdentity: identityOf(leaf) });
    hold = held;
    return held;
  };
  const killHelper = async () => {
    const [helper] = helpers.spawned;
    if (helper === undefined) throw new Error("no hold helper");
    helper.kill();
    await new Promise(resolve => helper.exitCode !== null || helper.signalCode !== null ? resolve(undefined) : helper.once("exit", resolve));
  };
  const longChild = (): ChildProcess => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
  const closed = (child: ChildProcess) => new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once("close", resolve));

  it("refuses rename and delete of the directory and its ancestors while held, and leaves a sibling alone", async () => {
    await holdLeaf();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => rmdirSync(leaf))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => renameSync(parent, join(root, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(existsSync(leaf)).toBe(true);
    expect(refused(() => renameSync(join(root, "sibling"), join(root, "sibling-moved")))).toBeUndefined();
  });

  it("releases on dispose when no child was bound", async () => {
    (await holdLeaf()).dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("keeps a bound hold past dispose until the child closes", async () => {
    const held = await holdLeaf();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore", windowsHide: true });
    held.bind(child);
    held.dispose();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    await new Promise(resolve => child.once("close", resolve));
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined(), { timeout: 3000 });
  });

  it("refuses a directory replaced at the approved path", async () => {
    const identity = identityOf(leaf);
    renameSync(leaf, join(parent, "original"));
    mkdirSync(leaf);
    await expect(holdHostShellSpawnDirectory({ cwdIdentity: identity })).rejects.toBeInstanceOf(HostShellDirectoryHoldError);
  });

  it("keeps the hold through an error from a started child until it closes", async () => {
    const held = await holdLeaf();
    const child = longChild();
    held.bind(child);
    child.emit("error", new Error("termination failed"));
    // A release would end the helper asynchronously; give it time to show.
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    child.kill();
    await closed(child);
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined(), { timeout: 3000 });
  });

  it("frees the hold when the child never started", async () => {
    const held = await holdLeaf();
    const child = spawn(join(root, "missing.exe"), [], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    held.bind(child);
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("refuses a launch once the helper has exited after its reply", async () => {
    const held = await holdLeaf();
    held.assertHeld();
    await killHelper();
    expect(() => held.assertHeld()).toThrow(HostShellDirectoryHoldError);
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined();
  });

  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  // The command starts a descendant that keeps the output pipe and prints its PID.
  const launchTree = (held: HostShellSpawnDirectoryHold) => {
    const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });" +
      "console.log(c.pid); setTimeout(() => {}, 20000);";
    const target = held.command(process.execPath, ["-e", script]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    held.bind(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    return { child, output: () => output };
  };

  it("lets the OS stop the command and its descendant when the helper exits", async () => {
    const held = await holdLeaf();
    const { child, output } = launchTree(held);
    await vi.waitFor(() => expect(output()).toMatch(/^\d+/u), { timeout: 5000 });
    const descendant = Number.parseInt(output(), 10);
    expect(alive(descendant)).toBe(true);
    const started = Date.now();
    await killHelper();
    await closed(child);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(child.exitCode).toBe(125);
    expect(output()).toContain("cwd-pin-lost");
    expect(alive(descendant)).toBe(false);
  });

  it("runs a command to completion and reports its own exit code once its job is empty", async () => {
    const held = await holdLeaf();
    const target = held.command(process.execPath, ["-e", "process.exitCode = 7"]);
    const child = spawn(target.executable, target.args, { stdio: "ignore", windowsHide: true });
    held.bind(child);
    await closed(child);
    expect(child.exitCode).toBe(7);
  });

  it("refuses to start a command after the helper has gone", async () => {
    const held = await holdLeaf();
    await killHelper();
    const target = held.command(process.execPath, ["-e", "require('fs').writeFileSync('ran', '')"]);
    const child = spawn(target.executable, target.args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    held.bind(child);
    await closed(child);
    expect(child.exitCode).toBe(125);
    expect(stderr).toContain("cwd-pin-lost");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  it("refuses a hold pipe whose server is not the named helper", async () => {
    const held = await holdLeaf();
    const target = held.command(process.execPath, ["-e", "require('fs').writeFileSync('ran', '')"]);
    const args = [...target.args];
    args[2] = String(process.pid);
    const child = spawn(target.executable, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await closed(child);
    expect(child.exitCode).toBe(125);
    expect(stderr).toContain("cwd-pin-lost");
    expect(existsSync(join(root, "ran"))).toBe(false);
    held.dispose();
  });

  // The command starts a descendant that holds no captured pipe and is outside Node's own kill-on-close job, prints its PID and exits.
  const descendantThenExit = (code: number) =>
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached: true }); c.unref(); console.log(c.pid); process.exitCode = ${code};`;
  const run = (held: HostShellSpawnDirectoryHold, script: string) => {
    const target = held.command(process.execPath, ["-e", script]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    held.bind(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    return { child, output: () => output };
  };

  it("reports a reaped hold for a plain exit, including a command's own exit 125", async () => {
    for (const code of [0, 125]) {
      const held = await holdLeaf();
      const { child, output } = run(held, `process.exitCode = ${code}`);
      await closed(child);
      expect(child.exitCode).toBe(code);
      expect(output()).not.toContain("cwd-pin-lost");
      await expect(held.outcome()).resolves.toEqual({ kind: "reaped", stopped: false });
      hold = undefined;
    }
  });

  it("stops a descendant without captured pipes before the command closes and says so", async () => {
    const held = await holdLeaf();
    const { child, output } = run(held, descendantThenExit(0));
    await closed(child);
    const descendant = Number.parseInt(output(), 10);
    expect(Number.isInteger(descendant)).toBe(true);
    expect(alive(descendant)).toBe(false);
    expect(child.exitCode).toBe(0);
    await expect(held.outcome()).resolves.toEqual({ kind: "reaped", stopped: true });
  });

  it("reports a lost hold when the helper dies during the command", async () => {
    const held = await holdLeaf();
    const { child, output } = launchTree(held);
    await vi.waitFor(() => expect(output()).toMatch(/^\d+/u), { timeout: 5000 });
    await killHelper();
    await closed(child);
    expect(child.exitCode).toBe(125);
    await expect(held.outcome()).resolves.toEqual({ kind: "lost" });
  });

  // A launcher stand-in: reads {pipe, mode} from stdin, starts its own child, sends the frame the mode names, prints every
  // reply and then "|closed". "reap" answers the helper's 'R' with 'K'; "stall" never answers it.
  const standInScript = [
    "const net = require('net'), cp = require('child_process');",
    "let config = '';",
    "process.stdin.on('data', (data) => { config += data; if (!config.includes('#')) return; process.stdin.pause();",
    "  const { pipe, mode } = JSON.parse(config.slice(0, config.indexOf('#')));",
    "  const life = mode === 'reap' || mode === 'stall' ? 1500 : 20000;",
    "  const child = mode === 'stranger' ? undefined : cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + life + ')'], { stdio: 'ignore', detached: true });",
    "  if (child) child.unref();",
    "  const frame = Buffer.alloc(mode === 'trailing' ? 9 : 8); frame.write('AVH1', 0, 'latin1'); frame.writeUInt32LE(child ? child.pid : process.ppid, 4);",
    "  let log = '';",
    "  const socket = net.connect(pipe);",
    "  socket.on('connect', () => { if (mode !== 'silent') socket.write(mode === 'short' ? frame.subarray(0, 4) : frame); });",
    "  socket.on('data', (chunk) => { const text = chunk.toString('latin1'); log += text; if (mode === 'reap' && text.includes('R')) socket.write('K'); });",
    "  socket.on('error', () => {});",
    "  socket.on('close', () => { if (child) { try { process.kill(child.pid); } catch {} } process.stdout.write(log + '|closed', () => process.exit(0)); });",
    "});",
  ].join("\n");
  const standIn = () => {
    const child = spawn(process.execPath, ["-e", standInScript], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => { log += chunk.toString("latin1"); });
    const finished = closed(child).then(() => log);
    const start = async (held: HostShellSpawnDirectoryHold, mode: string) => {
      const started = Date.now();
      child.stdin.write(`${JSON.stringify({ pipe: held.launcherArgs[1], mode })}#`);
      return { log: await finished, elapsed: Date.now() - started };
    };
    return { child, start };
  };
  const exchange = async (mode: string) => {
    const held = await holdLeaf();
    const launcher = standIn();
    held.bind(launcher.child);
    return { ...(await launcher.start(held, mode)), outcome: await held.outcome() };
  };

  it("completes the exchange with the named launcher once it confirms its own teardown", async () => {
    const { log, outcome } = await exchange("reap");
    expect(log).toBe("AR|closed");
    expect(outcome).toEqual({ kind: "reaped", stopped: false });
  }, 20000);
  it("closes the pipe and fails the run when a live launcher never answers the reap", async () => {
    const { log, elapsed, outcome } = await exchange("stall");
    expect(log).toBe("AR|closed");
    expect(elapsed).toBeLessThan(10000);
    expect(outcome).toEqual({ kind: "lost" });
  }, 30000);
  it.each([
    ["a short frame", "short", 3000],
    ["trailing bytes", "trailing", 3000],
    ["a process the launcher did not start", "stranger", 3000],
    ["a launcher that connects and never sends", "silent", 13000],
  ])("refuses %s promptly and closes the pipe", async (_name, mode, within) => {
    const { log, elapsed, outcome } = await exchange(mode);
    expect(["F|closed", "|closed"]).toContain(log);
    expect(elapsed).toBeLessThan(within);
    expect(outcome).toEqual({ kind: "lost" });
  }, 30000);
  it("refuses a client the host did not name", async () => {
    const held = await holdLeaf();
    const named = longChild();
    held.bind(named);
    const { log } = await standIn().start(held, "reap");
    named.kill();
    expect(["F|closed", "|closed"]).toContain(log);
    await expect(held.outcome()).resolves.toEqual({ kind: "lost" });
  }, 20000);
  it("refuses a named launcher that was started before the helper", async () => {
    const early = standIn();
    const held = await holdLeaf();
    held.bind(early.child);
    const { log } = await early.start(held, "reap");
    expect(log).not.toContain("A");
    await expect(held.outcome()).resolves.toEqual({ kind: "lost" });
  }, 20000);

  it("proves the tree gone before reporting when the launcher itself is killed mid-run", async () => {
    const held = await holdLeaf();
    const { child, output } = launchTree(held);
    await vi.waitFor(() => expect(output()).toMatch(/^\d+/u), { timeout: 5000 });
    const descendant = Number.parseInt(output(), 10);
    child.kill();
    const outcome = await held.outcome();
    expect(alive(descendant)).toBe(false);
    expect(outcome).toMatchObject({ kind: "reaped" });
  });

  it("fails a run whose helper cannot prove its job empty, and the launcher still stops the tree", async () => {
    const fixture = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    if (!existsSync(fixture)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    helpers.binary = fixture;
    process.env.AVE_TEST_HOLD_UNCONFIRMED = "1";
    const held = await holdLeaf().finally(() => { helpers.binary = undefined; delete process.env.AVE_TEST_HOLD_UNCONFIRMED; });
    const { child, output } = run(held, descendantThenExit(0));
    await closed(child);
    const descendant = Number.parseInt(output(), 10);
    expect(Number.isInteger(descendant)).toBe(true);
    expect(child.exitCode).toBe(125);
    expect(output()).toContain("cwd-pin-lost");
    await expect(held.outcome()).resolves.toEqual({ kind: "unconfirmed" });
    expect(alive(descendant)).toBe(false);
  });

  it("refuses a launcher the host did not name", async () => {
    const decoy = longChild();
    try {
      const held = await holdLeaf();
      held.bind(decoy);
      const target = held.command(process.execPath, ["-e", "require('fs').writeFileSync('ran', '')"]);
      const child = spawn(target.executable, target.args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      await closed(child);
      expect(child.exitCode).toBe(125);
      expect(stderr).toContain("cwd-pin-lost");
      expect(existsSync(join(root, "ran"))).toBe(false);
    } finally { decoy.kill(); }
  });

  // A pipe server in this process stands in for a helper that stalls, refuses or vanishes.
  const withStandIn = async (serve: (socket: Socket) => void, script: string) => {
    const pipe = `\\\\.\\pipe\\ave-hold-${randomUUID()}`;
    const server = createServer(serve);
    await new Promise<void>((ready) => server.listen(pipe, ready));
    try {
      const child = spawn(resolveWindowsJobLauncher(), ["--hold-pipe", pipe, String(process.pid), process.execPath, "-e", script],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const started = Date.now();
      await closed(child);
      return { code: child.exitCode, output, elapsed: Date.now() - started };
    } finally { server.close(); }
  };

  it("gives up on a helper that never answers the frame", async () => {
    const { code, output, elapsed } = await withStandIn(() => {}, "require('fs').writeFileSync('ran', '')");
    expect(code).toBe(125);
    expect(output).toContain("cwd-pin-lost");
    expect(elapsed).toBeLessThan(15000);
    expect(existsSync(join(root, "ran"))).toBe(false);
  }, 20000);

  it("never starts a command the helper refuses", async () => {
    const { code, output } = await withStandIn((socket) => socket.once("data", () => socket.write("F")), "require('fs').writeFileSync('ran', '')");
    expect(code).toBe(125);
    expect(output).toContain("cwd-pin-lost");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  it("stops the tree itself before reporting when the helper vanishes after admission", async () => {
    const { code, output } = await withStandIn((socket) => socket.once("data", () => { socket.write("A"); setTimeout(() => socket.destroy(), 1000); }), descendantThenExit(0));
    expect(code).toBe(125);
    expect(output).toContain("cwd-pin-lost");
    const descendant = Number.parseInt(output, 10);
    expect(Number.isInteger(descendant)).toBe(true);
    expect(alive(descendant)).toBe(false);
  });

  it("refuses a command's attempt to start a process outside the hold job", async () => {
    const fixture = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    if (!existsSync(fixture)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    const held = await holdLeaf();
    const target = held.command(fixture, ["--breakaway", process.execPath]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    held.bind(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await closed(child);
    expect(output).toMatch(/^breakaway refused \d+/u);
    expect(child.exitCode).toBe(0);
  });

  it("leaves a launch without a permit, and its background process, alone", async () => {
    const free = await holdHostShellSpawnDirectory(undefined);
    const target = free.command(process.execPath, ["-e", descendantThenExit(0)]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    free.bind(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await closed(child);
    const descendant = Number.parseInt(output, 10);
    try {
      expect(alive(descendant)).toBe(true);
      await expect(free.outcome()).resolves.toBeUndefined();
    } finally { process.kill(descendant); }
  });

  it("releases once however close, dispose and helper loss interleave", async () => {
    for (const order of ["close-first", "loss-first"] as const) {
      const held = await holdLeaf();
      const [helper] = helpers.spawned.slice(-1);
      if (helper === undefined) throw new Error("no hold helper");
      const kill = vi.spyOn(helper, "kill");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore", windowsHide: true });
      held.bind(child);
      if (order === "loss-first") {
        helper.kill();
        kill.mockClear();
        await new Promise(resolve => helper.once("exit", resolve));
      }
      await closed(child);
      await held.outcome();
      held.dispose();
      held.dispose();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(child.exitCode).toBe(0);
      hold = undefined;
    }
  });
});
