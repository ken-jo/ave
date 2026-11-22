import type { ChildProcess, spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdSandboxGitWrites } from "../../../shared/host-git.js";
import { createHostGit, HostGitError } from "../host-git.js";

const spawned = vi.hoisted(() => ({ fake: undefined as (() => unknown) | undefined, calls: 0 }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof spawnType>) => {
    spawned.calls += 1;
    return spawned.fake ? spawned.fake() : real.spawn(...args);
  }) as typeof spawnType;
  return { ...real, spawn };
});

let base: string;
let env: NodeJS.ProcessEnv;
const reasonOf = async (run: Promise<unknown>): Promise<string> => run.then(() => "finished", (error: unknown) => error instanceof HostGitError ? error.reason : `other: ${String(error)}`);

/** A git process that writes nothing and never ends until the host kills it. */
function hangingChild(): { child: ChildProcess; killed: () => number } {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills += 1; queueMicrotask(() => child.emit("close", null)); return true; },
  });
  return { child: child as unknown as ChildProcess, killed: () => kills };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hg-"));
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: base };
  spawned.fake = undefined;
  spawned.calls = 0;
});
afterEach(() => { spawned.fake = undefined; });

describe("host git", () => {
  it("a git process that does not finish in time is killed and the call rejects as a timeout", async () => {
    const hanging = hangingChild();
    spawned.fake = () => hanging.child;
    expect(await reasonOf(createHostGit({ env, timeoutMs: 20 }).run(base, ["status"]))).toBe("timeout");
    expect(hanging.killed()).toBe(1);
  });

  it("output past the bound kills the process and rejects; output within it is returned", async () => {
    const version = await createHostGit({ env }).run(base, ["--version"]);
    expect(version.code).toBe(0);
    const bytes = Buffer.byteLength(version.stdout) + Buffer.byteLength(version.stderr);
    expect(bytes).toBeGreaterThan(4);
    expect(await reasonOf(createHostGit({ env, maxOutputBytes: bytes - 1 }).run(base, ["--version"]))).toBe("output-limit");
    expect((await createHostGit({ env, maxOutputBytes: bytes }).run(base, ["--version"])).stdout).toBe(version.stdout);
    // Standard error counts toward the same bound.
    const failed = await createHostGit({ env }).run(base, ["no-such-command"]);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr.length).toBeGreaterThan(4);
    expect(await reasonOf(createHostGit({ env, maxOutputBytes: 4 }).run(base, ["no-such-command"]))).toBe("output-limit");
  });

  it("a workspace a sandboxed command holds is refused before git starts, and runs again once released", async () => {
    const held = join(base, "held");
    const sibling = join(base, "sibling");
    for (const folder of [held, sibling]) mkdirSync(folder);
    const git = createHostGit({ env });
    const release = holdSandboxGitWrites([held]);
    try {
      spawned.calls = 0;
      expect(await reasonOf(git.run(held, ["--version"]))).toBe("held");
      // The folder above a held one is held with it; a sibling is not.
      expect(await reasonOf(git.run(base, ["--version"]))).toBe("held");
      expect(spawned.calls).toBe(0);
      expect((await git.run(sibling, ["--version"])).code).toBe(0);
    } finally {
      release();
    }
    expect((await git.run(held, ["--version"])).code).toBe(0);
  });
});
