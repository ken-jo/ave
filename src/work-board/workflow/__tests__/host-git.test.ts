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

/** `env`: the environment the last git process was started with. */
const spawned = vi.hoisted(() => ({ fake: undefined as (() => unknown) | undefined, calls: 0, env: undefined as NodeJS.ProcessEnv | undefined }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof spawnType>) => {
    spawned.calls += 1;
    spawned.env = (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
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

  /** Git processes that write what each reply holds, in turn, and end with its code. */
  function replying(...replies: { code: number; stdout?: string | Buffer; stderr?: string }[]): void {
    spawned.fake = () => {
      const reply = replies.shift() ?? { code: 1 };
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      queueMicrotask(() => {
        if (reply.stdout !== undefined) child.stdout.emit("data", Buffer.from(reply.stdout));
        if (reply.stderr !== undefined) child.stderr.emit("data", Buffer.from(reply.stderr));
        child.emit("close", reply.code);
      });
      return child;
    };
  }
  const named = { code: 0, stdout: "filter.a.clean\ncat\0filter.a.required\0filter.b.required\nfalse\0" };

  it("the configuration command's answers are taken as it writes them: entries ended by NUL, a required filter as true or false", async () => {
    replying(named, { code: 0, stdout: "filter.a.required\ntrue\0filter.b.required\nfalse\0" });
    const drivers = await createHostGit({ env }).drivers(base);
    expect(drivers.requiredFilters).toEqual(["a"]);
    for (const name of ["a", "b"]) expect(drivers.config, name).toContain(`filter.${name}.required=false`);
    // Nothing configured: exit 1 with nothing written, twice.
    replying({ code: 1 }, { code: 1 });
    expect(await createHostGit({ env }).drivers(base)).toEqual({ config: [], requiredFilters: [] });
  });

  it.each<[string, { code: number; stdout?: string; stderr?: string }[]]>([
    ["finds nothing and writes a diagnostic", [{ code: 1, stderr: "warning: fixture\n" }]],
    ["succeeds and writes nothing", [{ code: 0 }]],
    ["leaves its last entry open", [{ code: 0, stdout: "filter.a.clean\ncat" }]],
    ["names a key that was not asked for", [{ code: 0, stdout: "core.editor\nvi\0" }, { code: 1 }]],
    ["gives a required filter a value that is neither true nor false", [named, { code: 0, stdout: "filter.a.required\nyes\0filter.b.required\nfalse\0" }]],
    ["gives a required filter no value where it was asked for a boolean", [named, { code: 0, stdout: "filter.a.required\0filter.b.required\nfalse\0" }]],
    ["finds no required filter after it listed two", [named, { code: 1 }]],
    ["lists the required filters in another order than before", [named, { code: 0, stdout: "filter.b.required\nfalse\0filter.a.required\ntrue\0" }]],
    ["names a required filter it had not listed", [{ code: 0, stdout: "filter.a.clean\ncat\0" }, { code: 0, stdout: "filter.a.required\ntrue\0" }]],
    ["finds no required filter and writes a diagnostic", [{ code: 0, stdout: "filter.a.clean\ncat\0" }, { code: 1, stderr: "warning: fixture\n" }]],
  ])("a configuration command that %s gave no answer: the drivers are not known", async (_what, replies) => {
    replying(...replies);
    expect(await reasonOf(createHostGit({ env }).drivers(base))).toBe("unavailable");
  });

  it.each(["Filter.a.clean", "filter.a.Clean", "FILTER.a.required", "Merge.a.driver", "merge.a.DRIVER"])("a key in a spelling the configuration command never writes (%s) is no answer: a section and a variable are told in lower case alone", async (key) => {
    replying({ code: 0, stdout: `${key}\ncat\0` }, { code: 1 });
    expect(await reasonOf(createHostGit({ env }).drivers(base))).toBe("unavailable");
  });

  it("a driver's name is taken as the bytes git wrote: one that is no text is not switched off under another name, and a value's bytes are of no account", async () => {
    const key = (...name: number[]): Buffer => Buffer.concat([Buffer.from("filter."), Buffer.from(name), Buffer.from(".clean\n"), Buffer.from([0xff, 0]), Buffer.from("merge.Up.driver\ntrue\0")]);
    // A byte no text holds, a sequence cut short, and one that spells a character the long way.
    for (const name of [[0x78, 0xff, 0x79], [0xed, 0x95], [0xc0, 0xaf]]) {
      replying({ code: 0, stdout: key(...name) }, { code: 1 });
      expect.soft(await reasonOf(createHostGit({ env }).drivers(base)), String(name)).toBe("driver-name");
    }
    // Text, in mixed case, and text that begins with a byte order mark: each is the name, whole.
    for (const text of [[0x4d, 0xed, 0x95, 0x9c], [0xef, 0xbb, 0xbf, 0x61]]) {
      replying({ code: 0, stdout: key(...text) }, { code: 1 });
      const config = (await createHostGit({ env }).drivers(base)).config;
      expect.soft(config.map(entry => Buffer.from(entry).toString("hex")), String(text)).toContain(Buffer.concat([Buffer.from("filter."), Buffer.from(text), Buffer.from(".clean=")]).toString("hex"));
      expect.soft(config).toContain("merge.Up.driver=exit 1");
    }
    // As git itself writes them, from a file whose section and variable are in mixed case and one whose name is no text.
    spawned.fake = undefined;
    const repo = repositoryWith('[Filter "Mixed"]\n\tClean = cat\n\tReQuired\n[MERGE "Up"]\n\tDriver = true\n');
    expect.soft(await createHostGit({ env }).drivers(repo)).toEqual({ config: expect.arrayContaining(["filter.Mixed.clean=", "merge.Up.driver=exit 1"]), requiredFilters: ["Mixed"] });
    appendFileSync(join(repo, ".git", "config"), Buffer.concat([Buffer.from('[filter "x'), Buffer.from([0xff]), Buffer.from('y"]\n\tclean = cat\n')]));
    expect(await reasonOf(createHostGit({ env }).drivers(repo))).toBe("driver-name");
  });

  it("a driver name the call cannot carry is still told as that, whatever character makes it so", async () => {
    for (const name of ["a\rb", "a=b"]) {
      replying({ code: 0, stdout: `filter.${name}.clean\ncat\0` }, { code: 1 });
      expect(await reasonOf(createHostGit({ env }).drivers(base)), JSON.stringify(name)).toBe("driver-name");
    }
  });

  it("drivers are read from the configuration every git command reads: a file an inherited variable names for the configuration command alone hides none, and one named through inherited variables is switched off too", async () => {
    const repo = repositoryWith('[filter "own"]\n\tclean = cat\n\trequired = true\n');
    writeFileSync(join(base, "other.cfg"), "");
    const git = createHostGit({ env: {
      ...env, GIT_CONFIG: join(base, "other.cfg"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.counted.clean", GIT_CONFIG_VALUE_0: "cat", GIT_CONFIG_PARAMETERS: "'filter.given.clean=cat'",
    } });
    const drivers = await git.drivers(repo);
    expect(drivers.requiredFilters).toEqual(["own"]);
    for (const name of ["own", "counted", "given"]) {
      expect(drivers.config, name).toContain(`filter.${name}.clean=`);
      // What the call carries is read last: the driver git would run is none.
      expect(await git.run(repo, ["config", "--get", `filter.${name}.clean`], { drivers: drivers.config }), name).toMatchObject({ code: 0, stdout: "\n" });
    }
  });

  it("an inherited variable that names another source of attributes, or another object store, is not passed on", async () => {
    const repo = repositoryWith("");
    const plain = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
    plain("-c", "user.name=Alice Example", "-c", "user.email=alice@example.com", "commit", "-q", "--allow-empty", "-m", "first");
    // Not in the commit: only the work tree gives the file its filter.
    writeFileSync(join(repo, ".gitattributes"), "a.txt filter=own\n");
    const attributes = await createHostGit({ env: { ...env, GIT_ATTR_SOURCE: "HEAD" } }).run(repo, ["check-attr", "filter", "--", "a.txt"]);
    expect.soft(attributes).toMatchObject({ code: 0, stdout: "a.txt: filter: own\n" });
    mkdirSync(join(base, "objects"));
    const written = await createHostGit({ env: { ...env, GIT_OBJECT_DIRECTORY: join(base, "objects") } }).run(repo, ["hash-object", "-w", "--stdin"], { stdin: "kept\n" });
    expect.soft(written.code).toBe(0);
    // The repository's own store holds it, as git with no such variable finds.
    expect.soft(plain("cat-file", "-t", written.stdout.trim())).toBe("blob");
  });

  it("an object an inherited variable offers from another store is not the repository's: it is not found there, and a commit of the same content holds it", async () => {
    const repo = repositoryWith('[user]\n\tname = Alice Example\n\temail = alice@example.com\n');
    const other = join(base, "other");
    mkdirSync(other);
    const plain = (cwd: string, args: string[], input?: string): string => execFileSync("git", args, { cwd, env, input, encoding: "utf8", stdio: "pipe" }).trim();
    plain(other, ["init", "-q"]);
    const blob = plain(other, ["hash-object", "-w", "--stdin"], "shared\n");
    const git = createHostGit({ env: { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, ".git", "objects") } });
    expect.soft((await git.run(repo, ["cat-file", "-e", blob])).code).not.toBe(0);
    writeFileSync(join(repo, "a.txt"), "shared\n");
    for (const args of [["add", "a.txt"], ["commit", "-q", "-m", "first"]]) expect.soft(await git.run(repo, args), args[0]).toMatchObject({ code: 0 });
    // As git with no such variable reads the commit.
    expect.soft(() => plain(repo, ["cat-file", "-p", "HEAD:a.txt"])).not.toThrow();
  });

  it("no inherited variable that names where the repository, its objects or its refs are kept, how a path is matched, or where git puts its answer, reaches git; what only configures it does", async () => {
    const dropped = [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_IMPLICIT_WORK_TREE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
      "GIT_REFERENCE_BACKEND", "GIT_ATTR_SOURCE", "GIT_CONFIG", "GIT_REDIRECT_STDIN", "GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR",
      "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
      "GIT_ASK_YESNO", "GIT_PROXY_COMMAND", "GIT_ALLOW_PROTOCOL", "GIT_TEST_DEFAULT_REF_FORMAT",
    ];
    const kept = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CEILING_DIRECTORIES", "GIT_EXEC_PATH", "GIT_TRACE"];
    // A name is one variable however it is spelled.
    const inherited = Object.fromEntries([...dropped.map((name, index) => index % 2 === 0 ? name : name.toLowerCase()), ...kept].map(name => [name, "inherited"]));
    replying({ code: 0 });
    await createHostGit({ env: inherited }).run(base, ["--version"]);
    const passed = Object.keys(spawned.env ?? {}).map(name => name.toUpperCase());
    expect.soft(dropped.filter(name => passed.includes(name))).toEqual([]);
    expect.soft(kept.filter(name => !passed.includes(name))).toEqual([]);
    replying({ code: 0 });
    await createHostGit({ env: inherited }).run(base, ["--version"], { isolated: true });
    expect(Object.entries(spawned.env ?? {}).sort()).toEqual([
      ["GIT_CONFIG_GLOBAL", process.platform === "win32" ? "NUL" : "/dev/null"], ["GIT_CONFIG_NOSYSTEM", "1"], ["GIT_OPTIONAL_LOCKS", "0"], ["GIT_TERMINAL_PROMPT", "0"],
    ]);
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
