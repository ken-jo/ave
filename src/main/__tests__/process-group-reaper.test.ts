import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessGroupReaper,
  PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS,
  PROCESS_GROUP_REAPER_SCRIPT,
  PROCESS_GROUP_REAPER_SPAWN,
} from "../process-group-reaper.js";

const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const started: number[] = [];

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(() => {
  for (const pgid of started.splice(0)) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  }
});

// A fake host: starts the reaper exactly as the app does, starts two detached `sleep` groups, registers both, releases the second, then reports
// the group ids. Run detached itself, so the test can kill the host's whole process group.
const FAKE_HOST = `
  const { spawn } = require("node:child_process");
  const spec = JSON.parse(process.env.REAPER_SPAWN);
  const reaper = spawn(spec.command, spec.args, { ...spec.options, stdio: [...spec.options.stdio] });
  const kept = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  const released = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  reaper.stdin.write("+" + kept.pid + "\\n+" + released.pid + "\\n-" + released.pid + "\\n+not-a-pid\\n", () => {
    process.stdout.write(JSON.stringify({ kept: kept.pid, released: released.pid }) + "\\n");
  });
`;

async function startFakeHost(): Promise<{ host: ChildProcess; kept: number; released: number }> {
  const host = spawn(node, ["-e", FAKE_HOST], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REAPER_SPAWN: JSON.stringify(PROCESS_GROUP_REAPER_SPAWN) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  started.push(host.pid!);
  let output = "";
  host.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  await vi.waitFor(() => expect(output).toContain("\n"), { timeout: 5_000 });
  const { kept, released } = JSON.parse(output) as { kept: number; released: number };
  started.push(kept, released);
  expect(groupAlive(kept)).toBe(true);
  return { host, kept, released };
}

describe.skipIf(process.platform === "win32")("process group reaper", () => {
  // The case the reaper exists for: the host is SIGKILLed, so nothing in it runs; only the OS closing the pipe reaches the reaper.
  it("kills a registered detached group when its host is SIGKILLed, and leaves a released group alone", async () => {
    const { host, kept, released } = await startFakeHost();
    host.kill("SIGKILL");
    await once(host, "exit");
    await vi.waitFor(() => expect(groupAlive(kept)).toBe(false), { timeout: 3_000, interval: 50 });
    expect(groupAlive(released)).toBe(true);
  });

  // `kill -9 -<host pgid>` or a terminal's Ctrl-\ signals the host's whole group; the reaper must not be in it.
  it("survives a kill of the host's whole process group and still kills the registered group", async () => {
    const { host, kept, released } = await startFakeHost();
    const exited = once(host, "exit");
    process.kill(-host.pid!, "SIGKILL");
    await exited;
    await vi.waitFor(() => expect(groupAlive(kept)).toBe(false), { timeout: 3_000, interval: 50 });
    expect(groupAlive(released)).toBe(true);
  });

  // `kill -- -1` would signal every process the user owns. A stub `kill` records what the script would have signalled.
  it("never signals group 0 or 1, or a malformed id", () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-reaper-kill-"));
    try {
      const record = join(dir, "kills");
      execFileSync("/bin/sh", ["-c", `kill() { printf '%s\\n' "$*" >> ${JSON.stringify(record)}; }\n${PROCESS_GROUP_REAPER_SCRIPT}`], {
        input: "+1\n+0\n+01\n+-5\n+abc\n+\n+4242\n",
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(readFileSync(record, "utf8")).toBe("-s KILL -- -4242\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the registered groups when the host shuts the reaper down", async () => {
    const reaper = createProcessGroupReaper();
    const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
    started.push(child.pid!);
    reaper.retain(child.pid!);
    reaper.shutdown();
    await vi.waitFor(() => expect(groupAlive(child.pid!)).toBe(false), { timeout: 3_000, interval: 50 });
  });
});

class FakeReaper extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly lines: string[] = [];
  // Records each write as it is made, so assertions need no event-loop turn.
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.lines.push(...chunk.toString().split("\n").filter(Boolean));
      done();
    },
  });
  unref = vi.fn();
  die(): void {
    this.exitCode = 1;
    this.stdin.destroy();
    this.emit("exit", 1, null);
  }
}

function fakeReapers(): { fakes: FakeReaper[]; spawnReaper: () => ChildProcess } {
  const fakes: FakeReaper[] = [];
  return {
    fakes,
    spawnReaper: () => {
      const fake = new FakeReaper();
      fakes.push(fake);
      return fake as unknown as ChildProcess;
    },
  };
}

describe("process group reaper bookkeeping", () => {
  it("spawns one reaper lazily and counts registrations per group", () => {
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper);
    expect(fakes).toHaveLength(0);
    reaper.retain(4242);
    reaper.retain(4242);
    reaper.retain(4343);
    reaper.release(4242);
    reaper.release(4343);
    reaper.release(9999);
    expect(fakes).toHaveLength(1);
    expect(fakes[0].lines).toEqual(["+4242", "+4343", "-4343"]);
    expect(fakes[0].unref).toHaveBeenCalled();
  });

  it("replaces a reaper that ended while groups are registered, at most once per interval", () => {
    let clock = 10_000;
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper, { now: () => clock });
    reaper.retain(5001);
    fakes[0].die();
    expect(fakes).toHaveLength(2);
    expect(fakes[1].lines).toEqual(["+5001"]);

    // Ending again inside the interval trips the guard; the next registration brings a reaper back with every group.
    fakes[1].die();
    expect(fakes).toHaveLength(2);
    reaper.retain(5002);
    expect(fakes).toHaveLength(3);
    expect(fakes[2].lines).toEqual(["+5001", "+5002"]);

    clock += PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS;
    fakes[2].die();
    expect(fakes).toHaveLength(4);
    expect(fakes[3].lines).toEqual(["+5001", "+5002"]);
  });

  it("does not replace a reaper that ended with no group registered", () => {
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper);
    reaper.retain(6001);
    reaper.release(6001);
    fakes[0].die();
    expect(fakes).toHaveLength(1);
  });

  it("undoes a registration whose reaper could not be started", () => {
    const fakes: FakeReaper[] = [];
    let failNext = true;
    const reaper = createProcessGroupReaper(() => {
      if (failNext) {
        failNext = false;
        return new EventEmitter() as unknown as ChildProcess;
      }
      const fake = new FakeReaper();
      fakes.push(fake);
      return fake as unknown as ChildProcess;
    });
    expect(() => reaper.retain(7001)).toThrow(/without a stdin pipe/);
    reaper.retain(7002);
    expect(fakes[0].lines).toEqual(["+7002"]);
  });

  it("refuses a process group id that would signal the host's own group or every process", () => {
    const reaper = createProcessGroupReaper(() => new FakeReaper() as unknown as ChildProcess);
    expect(() => reaper.retain(0)).toThrow(/invalid process group id/);
    expect(() => reaper.retain(1)).toThrow(/invalid process group id/);
    expect(() => reaper.retain(-5)).toThrow(/invalid process group id/);
  });
});
