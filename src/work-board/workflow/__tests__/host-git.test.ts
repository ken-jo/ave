import { type ChildProcess, execFileSync, type spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdSandboxGitWrites } from "../../../shared/host-git.js";
import { createHostGit, HostGitError } from "../host-git.js";
import { removeTree } from "./stage-fixtures.js";

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
afterEach(() => {
  spawned.fake = undefined;
  removeTree(base);
});

/** A repository under `base` whose own configuration ends with `text`. */
function repositoryWith(text: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env, stdio: "pipe" });
  appendFileSync(join(repo, ".git", "config"), text);
  return repo;
}

describe("host git", () => {
  it("a git process that does not finish in time is killed and the call rejects as a timeout", async () => {
    const hanging = hangingChild();
    spawned.fake = () => hanging.child;
    expect(await reasonOf(createHostGit({ env, timeoutMs: 20 }).run(base, ["status"]))).toBe("timeout");
    expect(hanging.killed()).toBe(1);
  });

  it("a git process that never reports its end still ends the call: stopped, or exited with its pipes held open", async () => {
    // Nothing the host does makes it close.
    const deaf = (): { child: ChildProcess; kills: () => number } => {
      let kills = 0;
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills += 1; return true; } });
      return { child: child as unknown as ChildProcess, kills: () => kills };
    };
    const stopped = deaf();
    spawned.fake = () => stopped.child;
    expect(await reasonOf(createHostGit({ env, timeoutMs: 20, teardownMs: 20 }).run(base, ["status"]))).toBe("timeout");
    expect(stopped.kills()).toBe(1);
    expect([stopped.child.stdin?.destroyed, stopped.child.stdout?.destroyed, stopped.child.stderr?.destroyed]).toEqual([true, true, true]);

    // It exits with a status, and something it started keeps the pipes: what was read is not known to be whole.
    const exited = deaf();
    spawned.fake = () => exited.child;
    const run = reasonOf(createHostGit({ env, teardownMs: 20 }).run(base, ["status"]));
    exited.child.stdout?.emit("data", Buffer.from("partial"));
    exited.child.emit("exit", 0);
    expect(await run).toBe("terminated");
    expect(exited.child.stdout?.destroyed).toBe(true);

    // One that closes in time after its exit is read as before.
    const closing = deaf();
    spawned.fake = () => closing.child;
    const whole = createHostGit({ env, teardownMs: 1_000 }).run(base, ["status"]);
    closing.child.stdout?.emit("data", Buffer.from("whole"));
    closing.child.emit("exit", 0);
    closing.child.emit("close", 0);
    expect(await whole).toMatchObject({ code: 0, stdout: "whole" });
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

  it("a git process that ends without an exit code rejects as terminated, whatever it wrote first", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    spawned.fake = () => {
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from("half an answer")); child.emit("close", null); });
      return child;
    };
    expect(await reasonOf(createHostGit({ env }).run(base, ["status"]))).toBe("terminated");
  });

  it("an isolated call reads no inherited git variable and no system or user configuration; any other call still does", async () => {
    writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n[fixture]\n\tfile = inherited\n");
    const git = createHostGit({ env: {
      ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "fixture.count", GIT_CONFIG_VALUE_0: "inherited", GIT_CONFIG_PARAMETERS: "'fixture.parameters=inherited'",
    } });
    const listed = async (isolated: boolean): Promise<string[]> => {
      const result = await git.run(base, ["config", "--show-origin", "--list"], { isolated });
      expect(result.code).toBe(0);
      return result.stdout.split("\n").filter(line => line !== "");
    };
    const inherited = await listed(false);
    for (const key of ["fixture.file=inherited", "fixture.count=inherited", "fixture.parameters=inherited"]) expect(inherited.some(line => line.endsWith(key)), key).toBe(true);
    const isolated = await listed(true);
    expect(isolated.length).toBeGreaterThan(0);
    // Only what the call itself carries is left.
    expect(isolated.filter(line => !line.startsWith("command line:"))).toEqual([]);
    expect(isolated.filter(line => line.includes("fixture."))).toEqual([]);
  });

  it("a filter is required where git reads its setting as true: with no value or a number, not with an empty value or a later false; a value that is no boolean refuses the call", async () => {
    const repo = repositoryWith('[filter "bare"]\n\trequired\n[filter "number"]\n\trequired = 2\n[filter "empty"]\n\trequired =\n[filter "later"]\n\trequired = true\n\trequired = false\n[filter "word"]\n\trequired = on\n');
    const git = createHostGit({ env });
    const drivers = await git.drivers(repo);
    expect([...drivers.requiredFilters].sort()).toEqual(["bare", "number", "word"]);
    for (const name of ["bare", "number", "empty", "later", "word"]) expect(drivers.config, name).toContain(`filter.${name}.required=false`);
    appendFileSync(join(repo, ".git", "config"), '[filter "unclear"]\n\trequired = maybe\n');
    expect(await reasonOf(git.drivers(repo))).toBe("unavailable");
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
