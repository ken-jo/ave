import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { holdHostShellSpawnDirectory, HostShellDirectoryHoldError, type HostShellSpawnDirectoryHold } from "../host-shell-execution-permit.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";
import { resolveWindowsJobLauncher } from "../../main/windows-job-launcher.js";
import { __resetTerminalsForTest, hostTerminalSession, killTerminal, setManualShellPreference, spawnTerminal, writeTerminal } from "../../main/terminal/pty-manager.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { HeldWindowsRun } from "../../shared/windows-path-facts.js";
import type { ToolExecutionContext } from "../../tools/base.js";
import { backgroundShellManager, createBashKillTool } from "../../tools/shell-tools.js";

const helpers = vi.hoisted(() => ({
  spawned: [] as import("node:child_process").ChildProcess[], binary: undefined as string | undefined, env: undefined as Record<string, string> | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const helper = String(args[0]).endsWith("ave-path-kind.exe");
      if (helper && helpers.binary !== undefined) {
        args[0] = helpers.binary;
        args[2] = { ...(args[2] as object), env: { ...process.env, ...helpers.env } };
      }
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
const FIXTURE = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
const UNQUERYABLE_LAUNCHER = resolve("resources", "windows-job", process.arch, "ave-job-query-failure.exe");
const UNCONFIRMED = { kind: "unconfirmed" } as const;

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
    helpers.binary = undefined;
    helpers.env = undefined;
  });
  afterEach(async () => {
    hold?.dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(parent, join(root, "released")))).toBeUndefined(), { timeout: 5000 });
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
  const holdLeafWithFixture = async (env: Record<string, string>) => {
    if (!existsSync(FIXTURE)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    helpers.binary = FIXTURE;
    helpers.env = env;
    return await holdLeaf().finally(() => { helpers.binary = undefined; helpers.env = undefined; });
  };
  const killHelper = async () => {
    const [helper] = helpers.spawned.slice(-1);
    if (helper === undefined) throw new Error("no hold helper");
    helper.kill();
    await new Promise(resolve => helper.exitCode !== null || helper.signalCode !== null ? resolve(undefined) : helper.once("exit", resolve));
  };
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const leafHeld = () => /^(EBUSY|EPERM|EACCES)$/u.test(refused(() => renameSync(leaf, join(parent, "moved"))) ?? "");

  /** Start `executable` under the hold the way every shell route does: the hold's command, its standard handles, then bind. */
  const start = (held: HostShellSpawnDirectoryHold, executable: string, args: string[], launcher?: string) => {
    const target = held.command(executable, args);
    const child = spawn(launcher ?? target.executable, target.args, { cwd: root, stdio: held.stdio, windowsHide: true });
    const run = held.bind(child);
    if (run === undefined) throw new Error("no held run");
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    return { child, run, output: () => output };
  };
  const launch = (held: HostShellSpawnDirectoryHold, script: string, launcher?: string) => start(held, process.execPath, ["-e", script], launcher);
  // The command starts a descendant that keeps the output pipe and prints its PID, then stays.
  const TREE = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });" +
    "console.log(c.pid); setTimeout(() => {}, 20000);";
  // The command starts a descendant that holds no captured pipe and is outside Node's own kill-on-close job, prints its PID and exits.
  const descendantThenExit = (code: number) =>
    `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', detached: true }); c.unref(); console.log(c.pid); process.exitCode = ${code};`;
  const runningTree = async (held: HostShellSpawnDirectoryHold) => {
    const tree = launch(held, TREE);
    await vi.waitFor(() => expect(tree.output()).toMatch(/^\d+/u), { timeout: 5000 });
    const descendant = Number.parseInt(tree.output(), 10);
    expect(alive(descendant)).toBe(true);
    return { ...tree, descendant };
  };

  it("refuses rename and delete of the directory and its ancestors while held, and leaves a sibling alone", async () => {
    await holdLeaf();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => rmdirSync(leaf))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => renameSync(parent, join(root, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(existsSync(leaf)).toBe(true);
    expect(refused(() => renameSync(join(root, "sibling"), join(root, "sibling-moved")))).toBeUndefined();
  });

  it("releases on dispose when no launcher was bound", async () => {
    (await holdLeaf()).dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("refuses a directory replaced at the approved path", async () => {
    const identity = identityOf(leaf);
    renameSync(leaf, join(parent, "original"));
    mkdirSync(leaf);
    await expect(holdHostShellSpawnDirectory({ cwdIdentity: identity })).rejects.toBeInstanceOf(HostShellDirectoryHoldError);
  });

  it("refuses a launch once the helper has exited after its reply", async () => {
    const held = await holdLeaf();
    held.assertHeld();
    await killHelper();
    expect(() => held.assertHeld()).toThrow(HostShellDirectoryHoldError);
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined();
  });

  describe("the launcher's verdict", () => {
    it("is the command's own exit code once its job is empty, including a command's own exit 125", async () => {
      for (const code of [0, 7, 125]) {
        const held = await holdLeaf();
        const { child, run, output } = launch(held, `process.exitCode = ${code}`);
        expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
        expect(child.exitCode).toBe(code);
        expect(output()).toBe("");
        hold = undefined;
      }
    });

    it("keeps the hold past dispose until the verdict, and releases it there", async () => {
      const held = await holdLeaf();
      const { run } = launch(held, "setTimeout(() => {}, 400)");
      held.dispose();
      expect(leafHeld()).toBe(true);
      expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
      await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined(), { timeout: 3000 });
    });

    it("stops a descendant without captured pipes before the verdict and says so", async () => {
      const held = await holdLeaf();
      const { child, run, output } = launch(held, descendantThenExit(0));
      expect(await run.verdict).toEqual({ kind: "ok", stopped: true });
      const descendant = Number.parseInt(output(), 10);
      expect(Number.isInteger(descendant)).toBe(true);
      expect(alive(descendant)).toBe(false);
      expect(child.exitCode).toBe(0);
    });

    it("answers a stop request with the stopped run's verdict and an emptied tree", async () => {
      const held = await holdLeaf();
      const { child, run, descendant } = await runningTree(held);
      const started = Date.now();
      expect(await run.stop()).toEqual({ kind: "ok", stopped: false });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(child.exitCode).toBe(130);
      expect(alive(descendant)).toBe(false);
    });

    it("is unconfirmed, never ok, when the helper dies during the command, and the tree is gone", async () => {
      const held = await holdLeaf();
      const { run, descendant } = await runningTree(held);
      const started = Date.now();
      await killHelper();
      expect(await run.verdict).toEqual(UNCONFIRMED);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(alive(descendant)).toBe(false);
    });

    it("is unconfirmed, never ok, when the launcher itself is killed mid-run, and the tree is gone", async () => {
      const held = await holdLeaf();
      const { child, run, descendant } = await runningTree(held);
      child.kill();
      expect(await run.verdict).toEqual(UNCONFIRMED);
      await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 3000 });
    });

    it("is unconfirmed when the launcher cannot prove its job empty, and the tree is still gone", async () => {
      if (!existsSync(UNQUERYABLE_LAUNCHER)) throw new Error("Build the launcher fixture: bun run build:windows-job -- -QueryFailureFixture");
      const held = await holdLeaf();
      const { child, run, output } = launch(held, descendantThenExit(0), UNQUERYABLE_LAUNCHER);
      expect(await run.verdict).toEqual(UNCONFIRMED);
      expect(child.exitCode).toBe(125);
      const descendant = Number.parseInt(output(), 10);
      expect(Number.isInteger(descendant)).toBe(true);
      await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 3000 });
    });

    it("is lost when the held directory no longer stands at the end of the run", async () => {
      const held = await holdLeafWithFixture({ AVE_TEST_HOLD_RECHECK: "lost" });
      const { child, run } = launch(held, "process.exitCode = 0");
      expect(await run.verdict).toEqual({ kind: "lost" });
      expect(child.exitCode).toBe(125);
    });

    it("is unconfirmed when the helper never answers the final check", async () => {
      const held = await holdLeafWithFixture({ AVE_TEST_HOLD_RECHECK: "stall" });
      const { child, run } = launch(held, "process.exitCode = 0");
      const started = Date.now();
      expect(await run.verdict).toEqual(UNCONFIRMED);
      expect(Date.now() - started).toBeLessThan(14000);
      expect(child.exitCode).toBe(125);
    }, 30000);

    it("is unconfirmed for a launcher that never started, and frees the hold", async () => {
      const held = await holdLeaf();
      const child = spawn(join(root, "missing.exe"), [], { stdio: held.stdio, windowsHide: true });
      expect(await held.bind(child)?.verdict).toEqual(UNCONFIRMED);
      await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
    });

    it("treats an error from a started launcher as a stop request and holds until its verdict", async () => {
      const held = await holdLeaf();
      const { child, run, descendant } = await runningTree(held);
      child.emit("error", new Error("termination failed"));
      expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
      expect(child.exitCode).toBe(130);
      expect(alive(descendant)).toBe(false);
    });

    it("answers a launcher that never exits at the stop deadline and releases the hold, which stops it", async () => {
      const held = await holdLeaf();
      // A stand-in that joins nothing, ignores the stop request and writes no record.
      const stalled = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: held.stdio, windowsHide: true });
      try {
        const run = held.bind(stalled);
        const started = Date.now();
        expect(await run?.stop()).toEqual(UNCONFIRMED);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(TOOL_TIMEOUT_POLICY.windowsHoldStopMs - 50);
        expect(elapsed).toBeLessThan(TOOL_TIMEOUT_POLICY.windowsHoldStopMs + 3000);
        await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined(), { timeout: 3000 });
      } finally { stalled.kill(); }
    }, 40000);

    it("releases once however the verdict, dispose and helper loss interleave", async () => {
      for (const order of ["verdict-first", "loss-first"] as const) {
        const held = await holdLeaf();
        const [helper] = helpers.spawned.slice(-1);
        if (helper === undefined) throw new Error("no hold helper");
        const kill = vi.spyOn(helper, "kill");
        const { run } = launch(held, "setTimeout(() => {}, 200)");
        if (order === "loss-first") {
          helper.kill();
          kill.mockClear();
          await new Promise(resolve => helper.once("exit", resolve));
        }
        // A helper lost around admission refuses the launch; one lost later leaves the run unconfirmed. Neither is ok.
        const verdict = await run.verdict;
        if (order === "loss-first") expect(verdict.kind).not.toBe("ok");
        else expect(verdict).toEqual({ kind: "ok", stopped: false });
        held.dispose();
        held.dispose();
        expect(kill).toHaveBeenCalledTimes(1);
        hold = undefined;
      }
    });
  });

  describe("admission to the hold job", () => {
    const ran = () => existsSync(join(root, "ran"));
    const RAN = "require('fs').writeFileSync('ran', '')";

    it("never starts a command after the helper has gone", async () => {
      const held = await holdLeaf();
      await killHelper();
      const { child, run } = launch(held, RAN);
      expect(await run.verdict).toEqual({ kind: "lost" });
      expect(child.exitCode).toBe(125);
      expect(ran()).toBe(false);
    });

    // The launcher on its own, with this test in the helper's place on the channel.
    const launcherAlone = async (answer: (channel: Duplex) => void) => {
      const child = spawn(resolveWindowsJobLauncher(), ["--hold", process.execPath, "-e", RAN], { cwd: root, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], windowsHide: true });
      const channel = child.stdio[3] as Duplex;
      let record = "";
      (child.stdio[4] as Duplex).on("data", (chunk: Buffer) => { record += chunk.toString(); });
      channel.once("data", () => answer(channel));
      const started = Date.now();
      await new Promise(resolve => child.once("close", resolve));
      return { code: child.exitCode, record, elapsed: Date.now() - started };
    };

    it("never starts a command the helper refuses", async () => {
      const { code, record } = await launcherAlone((channel) => channel.write(Buffer.from("F\0\0\0\0\0\0\0\0", "latin1")));
      expect({ code, record }).toEqual({ code: 125, record: "AVJ1 lost\n" });
      expect(ran()).toBe(false);
    });

    it("never starts a command on an admission it did not earn", async () => {
      // 'A' without the challenge is not the exchange.
      const { code, record } = await launcherAlone((channel) => channel.write(Buffer.from("A\0\0\0\0\0\0\0\0", "latin1")));
      expect({ code, record }).toEqual({ code: 125, record: "AVJ1 lost\n" });
      expect(ran()).toBe(false);
    });

    it("gives up on a helper that never answers", async () => {
      const { code, record, elapsed } = await launcherAlone(() => {});
      expect({ code, record }).toEqual({ code: 125, record: "AVJ1 lost\n" });
      expect(elapsed).toBeLessThan(14000);
      expect(ran()).toBe(false);
    }, 30000);

    it("refuses to run without the hold and verdict handles", async () => {
      const child = spawn(resolveWindowsJobLauncher(), ["--hold", process.execPath, "-e", RAN], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      await new Promise(resolve => child.once("close", resolve));
      expect(child.exitCode).toBe(125);
      expect(ran()).toBe(false);
    });

    // A process on the launcher's end of the channel that speaks the frames itself: `kind` and the process id it names.
    // It prints each reply's kind ('E' once the channel has closed), reads on only after a challenge, and exits when asked to stop.
    const speaker = (held: HostShellSpawnDirectoryHold, kind: number, named: number) => {
      const script = "const fs = require('fs'); const frame = Buffer.alloc(8); frame.writeUInt32LE(Number(process.argv[1]), 0); frame.writeUInt32LE(Number(process.argv[2]), 4);" +
        "fs.writeSync(3, frame); const reply = Buffer.alloc(9);" +
        "for (;;) { let read = 0; try { read = fs.readSync(3, reply, 0, 9); } catch {} const answer = read === 9 ? String.fromCharCode(reply[0]) : 'E'; fs.writeSync(1, answer); if (answer !== 'C') break; }" +
        "process.stdin.on('data', () => {}); process.stdin.on('close', () => process.exit(0));";
      const child = spawn(process.execPath, ["-e", script, String(kind), String(named)], { stdio: held.stdio, windowsHide: true });
      const run = held.bind(child);
      if (run === undefined) throw new Error("no held run");
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      return { child, run, output: () => output };
    };
    const HELLO = 0x32485641;
    const RECHECK = 0x51485641;

    it("admits only the process at the launcher's end of the channel, whatever process id it names", async () => {
      const held = await holdLeaf();
      const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
      try {
        if (decoy.pid === undefined) throw new Error("no decoy");
        // The helper challenges the named process; the speaker cannot answer for it, so nothing is admitted.
        const { run, output } = speaker(held, HELLO, decoy.pid);
        await vi.waitFor(() => expect(output()).toBe("C"), { timeout: 5000 });
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(output()).toBe("C");
        // The named process is not in the hold job: the helper's exit, which stops every member, leaves it running.
        await killHelper();
        expect(await run.verdict).toEqual(UNCONFIRMED);
        expect(output()).toBe("CE");
        expect(alive(decoy.pid)).toBe(true);
      } finally { decoy.kill(); }
    });

    it.each([
      ["a frame that is not the admission request", RECHECK, process.pid],
      ["a process id that names no process", HELLO, 0xfffffff0],
    ])("refuses %s", async (_name, kind, named) => {
      const held = await holdLeaf();
      const { run, output } = speaker(held, kind, named);
      await vi.waitFor(() => expect(output()).toBe("F"), { timeout: 5000 });
      expect(await run.stop()).toEqual(UNCONFIRMED);
    });

    it("refuses a command's attempt to start a process outside the hold job", async () => {
      if (!existsSync(FIXTURE)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
      const held = await holdLeaf();
      const { child, run, output } = start(held, FIXTURE, ["--breakaway", process.execPath]);
      expect(await run.verdict).toEqual({ kind: "ok", stopped: false });
      expect(output()).toMatch(/^breakaway refused \d+/u);
      expect(child.exitCode).toBe(0);
    });
  });

  it("reports a stopped held background run with its verdict and an emptied tree", async () => {
    const held = await holdLeaf();
    const { child, run, descendant } = await runningTree(held);
    const shellId = backgroundShellManager.register({ child, sessionId: "hold-kill", command: "tree", startedAt: "t", held: run });
    try {
      const result = await createBashKillTool().execute({ shellId }, { metadata: { sessionId: "hold-kill" } } as ToolExecutionContext);
      expect(alive(descendant)).toBe(false);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.output)).toMatchObject({ status: "killed", exitCode: 130 });
      await expect(run.verdict).resolves.toEqual({ kind: "ok", stopped: false });
    } finally { backgroundShellManager._resetForTest(); }
  });

  it("leaves a host terminal and its background process in the held directory running when a pinned command is reaped", async () => {
    const held = await holdLeaf();
    const tabId = "terminal:0000c0de-7";
    const ownerWindowId = 7;
    // The terminal runs a program that starts a background process in the held directory and records both ids.
    const marker = join(root, "terminal-processes");
    const program = join(root, "terminal-program.cjs");
    writeFileSync(program, `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true }); c.unref();` +
      ` require('fs').writeFileSync(${JSON.stringify(marker)}, process.pid + ' ' + c.pid); setTimeout(() => {}, 30000);`);
    let pids: number[] = [];
    __resetTerminalsForTest();
    setManualShellPreference(() => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"));
    try {
      const terminal = await spawnTerminal({ tabId, lane: "manual", purpose: "workspace", ownerWindowId, cwd: leaf });
      if (!terminal.ok) throw new Error(`terminal spawn failed: ${terminal.reason}`);
      expect(writeTerminal(terminal.session, `"${process.execPath}" "${program}"\r`)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 15000 });
      pids = readFileSync(marker, "utf8").split(" ").map(Number);
      const { run, output } = launch(held, descendantThenExit(0));
      expect(await run.verdict).toEqual({ kind: "ok", stopped: true });
      expect(alive(Number.parseInt(output(), 10))).toBe(false);
      expect(pids.map(alive)).toEqual([true, true]);
      expect(hostTerminalSession(tabId, ownerWindowId)?.terminalSessionId).toBe(terminal.session.terminalSessionId);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid);
      killTerminal(tabId);
      // The terminal's shell keeps its working directory open until it has gone.
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 10000 });
      await vi.waitFor(() => expect(leafHeld()).toBe(false), { timeout: 15000, interval: 250 });
      __resetTerminalsForTest();
    }
  }, 40000);

  it("leaves a launch without a permit, and its background process, alone", async () => {
    const free = await holdHostShellSpawnDirectory(undefined);
    expect(free.stdio).toBeUndefined();
    const target = free.command(process.execPath, ["-e", descendantThenExit(0)]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const run: HeldWindowsRun | undefined = free.bind(child);
    expect(run).toBeUndefined();
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise(resolve => child.once("close", resolve));
    const descendant = Number.parseInt(output, 10);
    try {
      expect(alive(descendant)).toBe(true);
    } finally { process.kill(descendant); }
  });
});
