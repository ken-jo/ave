import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { posixProcessExists, spawnSacrificialHost, stopFixtureProcesses, stopSacrificialHost, waitForFixture, withFixtureCleanup } from "../../__tests__/support/sacrificial-host.js";
import {
  createProcessGroupReaper,
  PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS,
  PROCESS_GROUP_REAPER_SCRIPT,
  PROCESS_GROUP_REAPER_SPAWN,
} from "../process-group-reaper.js";

const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const started: number[] = [];

const groupAlive = (pgid: number): boolean => posixProcessExists(-pgid);

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

const GATED_HOST = String.raw`
  import { spawn } from "node:child_process";
  import { once } from "node:events";
  const [managedPath, reaperPath, target, marker] = process.argv.slice(1);
  const { _spawnGatedManagedProcessForTest } = await import(managedPath);
  const { createProcessGroupReaper, PROCESS_GROUP_REAPER_SPAWN } = await import(reaperPath);
  const reaper = createProcessGroupReaper(target === "registration-written" ? () => {
    const { command, args, options } = PROCESS_GROUP_REAPER_SPAWN;
    const waitBeforeAck = 'printf() { IFS= read -r unused <&3; command printf "$@"; }\n';
    return spawn(command, ["-c", waitBeforeAck + args[1]], { ...options, stdio: [...options.stdio, "pipe"] });
  } : undefined);
  if (target === "registration-written") {
    const running = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
    reaper.retain(running.pid);
    process.send({ companion: running.pid });
  }
  let running;
  await _spawnGatedManagedProcessForTest(
    "/bin/sh", ["-c", 'printf running > "$1"; printf running; exec /bin/sleep 60', "payload", marker],
    { stdio: ["ignore", "pipe", "ignore"] },
    {
      label: "gated-host-death-fixture",
      onSpawn(child) {
        process.send({ pgid: child.pid });
        running = once(child.stdout, "data");
      },
      assertStillValid() {},
    },
    {
      reaper,
      async onBoundary(boundary) {
        if (boundary !== target) return;
        if (boundary === "released") await running;
        process.send({ boundary });
        await new Promise(() => {});
      },
    },
  );
`;

describe.runIf(process.platform === "darwin" || process.platform === "linux")("process group launch handoff", () => {
  it.each(["before-registration", "registration-written", "acknowledged", "released"])(
    "leaves no live group when the host is killed at %s", async (boundary) => {
      const dir = mkdtempSync(join(tmpdir(), "ave-launch-gate-"));
      const marker = join(dir, "executed");
      let activeHost: ChildProcess | undefined;
      let pgid: number | undefined;
      let companion: number | undefined;
      await withFixtureCleanup(async (deadline) => {
        const host = spawnSacrificialHost(GATED_HOST, [
          new URL("../managed-child-processes.ts", import.meta.url).href,
          new URL("../process-group-reaper.ts", import.meta.url).href,
          boundary, marker,
        ]);
        activeHost = host;
        let reached: string | undefined;
        let hostError: Error | undefined;
        host.on("error", (error) => { hostError = error; });
        host.on("message", (message: { pgid?: number; companion?: number; boundary?: string }) => {
          if (message.pgid !== undefined) pgid = message.pgid;
          if (message.companion !== undefined) companion = message.companion;
          if (message.boundary !== undefined) reached = message.boundary;
        });
        await waitForFixture(boundary, () => {
          if (hostError) throw hostError;
          if (host.exitCode !== null || host.signalCode !== null) throw new Error("Sacrificial host exited before the launch boundary");
          return reached;
        }, deadline);
        expect(reached).toBe(boundary);
        if (pgid === undefined || pgid <= 1) throw new Error("No launch group reported");
        const group = pgid;
        expect(groupAlive(group)).toBe(true);
        expect(existsSync(marker)).toBe(boundary === "released");
        if (boundary === "registration-written") {
          if (companion === undefined || companion <= 1) throw new Error("No companion group reported");
          expect(groupAlive(companion)).toBe(true);
        }
        host.kill("SIGKILL");
        await waitForFixture("host SIGKILL", () => host.signalCode ?? undefined, deadline);
        expect(host.signalCode).toBe("SIGKILL");
        await waitForFixture("group reaping", () =>
          !groupAlive(group) && (companion === undefined || !groupAlive(companion)) ? true : undefined, deadline);
        expect(existsSync(marker)).toBe(boundary === "released");
        pgid = undefined;
        companion = undefined;
      }, [
        async (deadline) => { if (activeHost) await stopSacrificialHost(activeHost, deadline); },
        (deadline) => stopFixtureProcesses([pgid, companion].flatMap((group) => group !== undefined && group > 1 ? [-group] : []), deadline),
        () => rmSync(dir, { recursive: true, force: true }),
      ]);
    },
  );
});

class FakeReaper extends EventEmitter {
  pid = 4000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly lines: string[] = [];
  readonly stdout = new PassThrough();
  completeWrite?: () => void;
  // Records each write as it is made, so assertions need no event-loop turn.
  readonly stdin = new Writable({
    highWaterMark: 1,
    write: (chunk: Buffer, _encoding, done) => {
      this.lines.push(...chunk.toString().split("\n").filter(Boolean));
      if (chunk[0] === 64) this.completeWrite = done;
      else done();
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
  it("runs later cleanup steps and preserves the original fixture failure", async () => {
    const failure = new Error("Fixture assertion failed");
    const cleanupFailure = new Error("Fixture cleanup failed");
    const laterCleanup = vi.fn();
    await expect(withFixtureCleanup(async () => { throw failure; }, [
      () => { throw cleanupFailure; },
      laterCleanup,
    ])).rejects.toMatchObject({ errors: [failure, cleanupFailure] });
    expect(laterCleanup).toHaveBeenCalledOnce();
  });

  it("requires a complete matching ack and the queued write callback", async () => {
    const fake = new FakeReaper();
    const reaper = createProcessGroupReaper(() => fake as unknown as ChildProcess);
    const written = vi.fn();
    const accepted = vi.fn();
    reaper.retain(4242);
    const ack = reaper.acknowledge(4242, new AbortController().signal, written).then(accepted);
    expect(fake.stdin.writableNeedDrain).toBe(true);
    fake.stdout.write("@2\n@");
    fake.stdout.write("1");
    fake.completeWrite?.();
    await vi.waitFor(() => expect(written).toHaveBeenCalledOnce());
    expect(accepted).not.toHaveBeenCalled();
    fake.stdout.write("\n");
    await ack;
    expect(accepted).toHaveBeenCalledOnce();
    reaper.shutdown();
  });

  it("rejects a pending ack when the reaper is lost", async () => {
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper);
    reaper.retain(4242);
    const [first] = fakes;
    if (!first) throw new Error("Missing reaper");
    const ack = reaper.acknowledge(4242, new AbortController().signal);
    first.die();
    await expect(ack).rejects.toThrow(/reaper is unavailable/);
    reaper.shutdown();
  });

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

  it("replaces a reaper that dies twice within the interval without waiting for another registration", () => {
    vi.useFakeTimers();
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper);
    try {
      reaper.retain(5001);
      const [first] = fakes;
      if (!first) throw new Error("Missing initial reaper");
      first.die();
      expect(fakes).toHaveLength(2);
      const second = fakes[1];
      if (!second) throw new Error("Missing first replacement");
      expect(second.lines).toEqual(["+5001"]);
      vi.advanceTimersByTime(100);
      second.die();
      vi.advanceTimersByTime(PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS - 101);
      expect(fakes).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(fakes).toHaveLength(3);
      const third = fakes[2];
      if (!third) throw new Error("Missing second replacement");
      expect(third.lines).toEqual(["+5001"]);
    } finally {
      reaper.shutdown();
      vi.useRealTimers();
    }
  });

  it("does not replace a reaper that ended with no group registered", () => {
    const { fakes, spawnReaper } = fakeReapers();
    const reaper = createProcessGroupReaper(spawnReaper);
    reaper.retain(6001);
    reaper.release(6001);
    fakes[0].die();
    expect(fakes).toHaveLength(1);
  });

  it("refuses initial admission when spawning returns no pid, then recovers without new registrations", () => {
    vi.useFakeTimers();
    const failed = Object.assign(new FakeReaper(), { pid: undefined });
    const spawnReaper = vi.fn<() => ChildProcess>()
      .mockReturnValueOnce(failed as unknown as ChildProcess)
      .mockReturnValueOnce(new FakeReaper() as unknown as ChildProcess);
    const onUnavailable = vi.fn();
    const reaper = createProcessGroupReaper(spawnReaper, { onUnavailable });
    try {
      expect(() => reaper.assertAvailable()).toThrow(/reaper is unavailable/);
      expect(() => reaper.assertAvailable()).toThrow(/reaper is unavailable/);
      expect(spawnReaper).toHaveBeenCalledTimes(1);
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS);
      expect(spawnReaper).toHaveBeenCalledTimes(2);
      expect(() => reaper.assertAvailable()).not.toThrow();
    } finally {
      reaper.shutdown();
      vi.useRealTimers();
    }
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
