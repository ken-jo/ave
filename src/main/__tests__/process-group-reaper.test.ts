import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessGroupReaper, PROCESS_GROUP_REAPER_SCRIPT } from "../process-group-reaper.js";

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

describe.skipIf(process.platform === "win32")("process group reaper", () => {
  // The case the reaper exists for: the host is SIGKILLed, so nothing in it runs; only the OS closing the pipe reaches the reaper.
  it("kills a registered detached group when its host is SIGKILLed, and leaves a released group alone", async () => {
    const host = spawn(node, ["-e", `
      const { spawn } = require("node:child_process");
      const reaper = spawn("/bin/sh", ["-c", process.env.REAPER_SCRIPT], { stdio: ["pipe", "ignore", "ignore"] });
      const kept = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
      const released = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
      reaper.stdin.write("+" + kept.pid + "\\n+" + released.pid + "\\n-" + released.pid + "\\n+not-a-pid\\n", () => {
        process.stdout.write(JSON.stringify({ kept: kept.pid, released: released.pid }) + "\\n");
      });
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REAPER_SCRIPT: PROCESS_GROUP_REAPER_SCRIPT }, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    host.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await vi.waitFor(() => expect(output).toContain("\n"), { timeout: 5_000 });
    const { kept, released } = JSON.parse(output) as { kept: number; released: number };
    started.push(kept, released);
    expect(groupAlive(kept)).toBe(true);

    host.kill("SIGKILL");
    await once(host, "exit");

    await vi.waitFor(() => expect(groupAlive(kept)).toBe(false), { timeout: 3_000, interval: 50 });
    expect(groupAlive(released)).toBe(true);
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
  readonly stdin = new PassThrough();
  readonly lines: string[] = [];
  unref = vi.fn();
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.lines.push(...chunk.toString().split("\n").filter(Boolean)));
  }
  die(): void {
    this.exitCode = 1;
    this.stdin.destroy();
    this.emit("exit", 1, null);
  }
}

describe("process group reaper bookkeeping", () => {
  it("spawns one reaper lazily and counts registrations per group", async () => {
    const fakes: FakeReaper[] = [];
    const reaper = createProcessGroupReaper(() => {
      const fake = new FakeReaper();
      fakes.push(fake);
      return fake as unknown as ChildProcess;
    });
    expect(fakes).toHaveLength(0);
    reaper.retain(4242);
    reaper.retain(4242);
    reaper.retain(4343);
    reaper.release(4242);
    reaper.release(4343);
    reaper.release(9999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakes).toHaveLength(1);
    expect(fakes[0].lines).toEqual(["+4242", "+4343", "-4343"]);
    expect(fakes[0].unref).toHaveBeenCalled();
  });

  it("respawns a reaper that ended and replays every registered group", async () => {
    const fakes: FakeReaper[] = [];
    const reaper = createProcessGroupReaper(() => {
      const fake = new FakeReaper();
      fakes.push(fake);
      return fake as unknown as ChildProcess;
    });
    reaper.retain(5001);
    fakes[0].die();
    reaper.retain(5002);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakes).toHaveLength(2);
    expect(fakes[1].lines).toEqual(["+5001", "+5002"]);
  });

  it("refuses a process group id that would signal the host's own group or every process", () => {
    const reaper = createProcessGroupReaper(() => new FakeReaper() as unknown as ChildProcess);
    expect(() => reaper.retain(0)).toThrow(/invalid process group id/);
    expect(() => reaper.retain(1)).toThrow(/invalid process group id/);
    expect(() => reaper.retain(-5)).toThrow(/invalid process group id/);
  });
});
