import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepStaleWindowsSandboxHomes } from "../steps/sandbox-init.js";
import type { ProcessRunState, ProcessRunStateProbe } from "../../permissions/windows-process-start-time.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-home-sweep-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function home(name: string, marker?: string | { pid: number; startTime: string }): string {
  const path = join(root, name);
  mkdirSync(join(path, "AppData"), { recursive: true });
  writeFileSync(join(path, "AppData", "state"), "x");
  if (marker !== undefined) {
    writeFileSync(join(path, ".ave-sandbox-owner"), typeof marker === "string" ? marker : JSON.stringify(marker));
  }
  return path;
}

function probeOf(states: Record<number, ProcessRunState>): ProcessRunStateProbe & { calls: number[][] } {
  const calls: number[][] = [];
  const probe = async (pids: readonly number[]) => {
    calls.push([...pids]);
    return new Map(Object.entries(states).map(([pid, state]) => [Number(pid), state]));
  };
  return Object.assign(probe, { calls });
}

describe("sweepStaleWindowsSandboxHomes", () => {
  it("removes a HOME whose owner process is gone", async () => {
    const dead = home("ave-sandbox-home-dead", { pid: 4101, startTime: "100" });
    const result = await sweepStaleWindowsSandboxHomes(root, new Set(), probeOf({ 4101: { running: false } }));
    expect(existsSync(dead)).toBe(false);
    expect(result).toEqual({ removed: 1, failed: 0 });
  });

  it("keeps a HOME whose owner is still running", async () => {
    const live = home("ave-sandbox-home-live", { pid: 4102, startTime: "200" });
    const result = await sweepStaleWindowsSandboxHomes(root, new Set(),
      probeOf({ 4102: { running: true, startTime: "200" } }));
    expect(existsSync(join(live, "AppData", "state"))).toBe(true);
    expect(result).toEqual({ removed: 0, failed: 0 });
  });

  it("keeps a HOME with no marker and does not probe for it", async () => {
    const unmarked = home("ave-sandbox-home-unmarked");
    const probe = probeOf({});
    await sweepStaleWindowsSandboxHomes(root, new Set(), probe);
    expect(existsSync(join(unmarked, "AppData", "state"))).toBe(true);
    expect(probe.calls).toEqual([]);
  });

  it("removes a HOME whose pid now belongs to a process with another start time", async () => {
    const reused = home("ave-sandbox-home-reused", { pid: 4103, startTime: "300" });
    await sweepStaleWindowsSandboxHomes(root, new Set(), probeOf({ 4103: { running: true, startTime: "301" } }));
    expect(existsSync(reused)).toBe(false);
  });

  it("keeps HOMEs whose marker is malformed or whose owner cannot be determined", async () => {
    const kept = [
      home("ave-sandbox-home-garbage", "not json"),
      home("ave-sandbox-home-badpid", { pid: -1, startTime: "1" }),
      home("ave-sandbox-home-oversized", JSON.stringify({ pid: 4104, startTime: "1", pad: "x".repeat(200) })),
      home("ave-sandbox-home-unprobed", { pid: 4105, startTime: "1" }),
      home("ave-sandbox-home-unknown-start", { pid: 4106, startTime: "1" }),
    ];
    mkdirSync(join(root, "ave-sandbox-home-dir-marker", ".ave-sandbox-owner"), { recursive: true });
    await sweepStaleWindowsSandboxHomes(root, new Set(), probeOf({
      4104: { running: false },
      4106: { running: true, startTime: null },
    }));
    for (const path of kept) expect(existsSync(join(path, "AppData", "state")), path).toBe(true);
    expect(existsSync(join(root, "ave-sandbox-home-dir-marker"))).toBe(true);
  });

  it("removes only prefixed directories directly under the root and none this process uses", async () => {
    const owner = { pid: 4107, startTime: "1" };
    const foreign = home("other-home-dead", owner);
    const inUse = home("ave-sandbox-home-in-use", owner);
    const nested = join(root, "nest");
    mkdirSync(nested);
    const deeper = join(nested, "ave-sandbox-home-deep");
    mkdirSync(deeper);
    writeFileSync(join(deeper, ".ave-sandbox-owner"), JSON.stringify(owner));
    await sweepStaleWindowsSandboxHomes(root, new Set([inUse]), probeOf({ 4107: { running: false } }));
    expect(existsSync(join(foreign, "AppData", "state"))).toBe(true);
    expect(existsSync(join(inUse, "AppData", "state"))).toBe(true);
    expect(existsSync(join(deeper, ".ave-sandbox-owner"))).toBe(true);
  });

  it("does not follow a directory link that carries the prefix", async () => {
    const target = mkdtempSync(join(tmpdir(), "ave-home-sweep-target-"));
    try {
      writeFileSync(join(target, ".ave-sandbox-owner"), JSON.stringify({ pid: 4108, startTime: "1" }));
      writeFileSync(join(target, "keep"), "x");
      symlinkSync(target, join(root, "ave-sandbox-home-link"), process.platform === "win32" ? "junction" : "dir");
      await sweepStaleWindowsSandboxHomes(root, new Set(), probeOf({ 4108: { running: false } }));
      expect(existsSync(join(target, "keep"))).toBe(true);
    } finally {
      const link = join(root, "ave-sandbox-home-link");
      if (existsSync(link)) (process.platform === "win32" ? rmdirSync : unlinkSync)(link);
      rmSync(target, { recursive: true, force: true });
    }
  });
});
