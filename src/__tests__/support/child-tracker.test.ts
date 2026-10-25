import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createChildTracker } from "./tmp-dir-teardown.js";

/** The child must ignore SIGTERM and stay alive to make forced reaping observable. */
function spawnUnkillableByTerm() {
  return spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {});'
        + ' setInterval(() => {}, 1000);'
        + ' process.stdout.write("armed");',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** Wait for the armed-handler signal before reaping; spawn completion alone races handler installation. */
function whenArmed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.stdout?.once("data", () => resolve()));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createChildTracker", () => {
  it("reaps a child the test never killed", async () => {
    const tracker = createChildTracker();
    const child = tracker.track(spawnUnkillableByTerm());
    const { pid } = child;
    expect(pid).toBeTypeOf("number");
    expect(isAlive(pid as number)).toBe(true);

    await tracker.reap();

    expect(child.killed).toBe(true);
    expect(isAlive(pid as number)).toBe(false);
  }, 20_000);

  // Windows kill terminates outright, so only POSIX can test signal escalation.
  it.runIf(process.platform !== "win32")(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      const tracker = createChildTracker();
      const child = tracker.track(spawnUnkillableByTerm());
      await whenArmed(child);
      await tracker.reap();
      expect(child.signalCode).toBe("SIGKILL");
    },
    20_000,
  );

  it("ends a child that installed a SIGTERM handler, on every platform", async () => {
    const tracker = createChildTracker();
    const child = tracker.track(spawnUnkillableByTerm());
    const { pid } = child;
    await whenArmed(child);

    await tracker.reap();

    expect(isAlive(pid as number)).toBe(false);
    expect(child.signalCode).not.toBeNull();
  }, 20_000);

  it("is safe to reap twice and reaps nothing the second time", async () => {
    const tracker = createChildTracker();
    tracker.track(spawnUnkillableByTerm());
    await tracker.reap();
    await expect(tracker.reap()).resolves.toBeUndefined();
  }, 20_000);

  it("does not reap another tracker's children", async () => {
    const mine = createChildTracker();
    const theirs = createChildTracker();
    const ours = mine.track(spawnUnkillableByTerm());
    const other = theirs.track(spawnUnkillableByTerm());

    await mine.reap();

    expect(isAlive(ours.pid as number)).toBe(false);
    expect(isAlive(other.pid as number)).toBe(true);
    await theirs.reap();
  }, 20_000);
});
