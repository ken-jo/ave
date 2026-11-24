import { type ChildProcess, execFileSync, type spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { HOOK_EVENTS, holdSandboxGitWrites } from "../../../shared/host-git.js";
import { discoverHostGitAsync, executableIdentitySync } from "../../../shared/host-git-executable.js";
import { createHostGit, HostGitError } from "../host-git.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";
import { removeTree } from "./stage-fixtures.js";

/** `env` and `program`: the environment and the program the last git process was started with. A fake is given the arguments git would have been. */
const spawned = vi.hoisted(() => ({ fake: undefined as ((args: readonly string[]) => unknown) | undefined, calls: 0, env: undefined as NodeJS.ProcessEnv | undefined, program: undefined as string | undefined }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof spawnType>) => {
    spawned.calls += 1;
    spawned.env = (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    spawned.program = String(args[0]);
    return spawned.fake ? spawned.fake(args[1] as readonly string[]) : real.spawn(...args);
  }) as typeof spawnType;
  return { ...real, spawn };
});
/** `failures`: how many more times the floor probe's scratch folder refuses to be taken away, as a folder a process holds does. */
const removal = vi.hoisted(() => ({ failures: 0, scratch: undefined as string | undefined }));
const workspaceStat = vi.hoisted(() => ({ before: undefined as ((path: unknown) => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const rmSync = ((path: Parameters<typeof real.rmSync>[0], options?: Parameters<typeof real.rmSync>[1]) => {
    if (removal.failures > 0 && options?.recursive === true && String(path).includes("ave-git-floor-")) {
      removal.failures -= 1;
      removal.scratch = String(path);
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(path)}'`), { code: "EBUSY" });
    }
    real.rmSync(path, options);
  }) as typeof real.rmSync;
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    workspaceStat.before?.(args[0]);
    return real.statSync(...args);
  }) as typeof real.statSync;
  return { ...real, rmSync, statSync, default: { ...real, rmSync } };
});
const warned = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: (line: string) => { warned.lines.push(line); }, info: quiet, debug: quiet, error: quiet }) };
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

// The host's discovery asks the installed git once, before any fake process stands in for git; a call then starts the program it found.
beforeAll(async () => {
  expect((await discoverHostGitAsync(null)).git).not.toBeNull();
});
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hg-"));
  writeFileSync(join(base, "gitconfig"), "[core]\n\tautocrlf = false\n");
  env = { ...process.env, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
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

  it("uses the time left on the caller's deadline for the child", async () => {
    const { git } = await discoverHostGitAsync(null);
    if (git === null) throw new Error("expected fixture git");
    const hanging = hangingChild();
    spawned.fake = () => hanging.child;
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      const host = createHostGit({ env, timeoutMs: 1_000, resolve: use => use(git) });
      const result = reasonOf(host.run(base, ["status"], { deadline: performance.now() + 20 }));
      await vi.advanceTimersByTimeAsync(20);
      const killedAtDeadline = hanging.killed();
      await vi.advanceTimersByTimeAsync(980);
      expect(await result).toBe("timeout");
      expect(killedAtDeadline).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no child when validating the working directory consumes the deadline", async () => {
    const { git } = await discoverHostGitAsync(null);
    if (git === null) throw new Error("expected fixture git");
    spawned.fake = () => {
      const { child } = hangingChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    vi.useFakeTimers({ toFake: ["performance"] });
    let elapsed = 0;
    workspaceStat.before = path => {
      if (path !== base) return;
      elapsed += 10;
      vi.advanceTimersByTime(10);
    };
    try {
      const host = createHostGit({ env, resolve: use => use(git) });
      const reason = await reasonOf(host.run(base, ["--version"], { deadline: performance.now() + 10 }));
      expect([elapsed, reason, spawned.calls]).toEqual([10, "timeout", 0]);
    } finally {
      workspaceStat.before = undefined;
      vi.useRealTimers();
    }
  });

  it.each(["executable resolution", "an uncached hook floor"])("enforces the deadline during %s and prevents a later launch", async (phase) => {
    const resolving = phase === "executable resolution";
    const path = join(base, "floor-probe");
    writeFileSync(path, "", { mode: 0o700 });
    const identity = executableIdentitySync(path);
    if (identity === null) throw new Error("expected fixture executable identity");
    const released = deferred<void>();
    const first = hangingChild();
    spawned.fake = () => {
      if (!resolving && spawned.calls === 1) return first.child;
      const later = hangingChild().child;
      queueMicrotask(() => later.emit("close", 1));
      return later;
    };
    const host = createHostGit({ env, resolve: async use => {
      if (resolving) await released.promise;
      return use({ path, identity });
    } });
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      let verdict: string | undefined;
      const result = reasonOf(host.run(base, ["status"], { deadline: performance.now() + 20, requiresFloor: true }))
        .then(reason => { verdict = reason; });
      await vi.advanceTimersByTimeAsync(20);
      const verdictAtDeadline = verdict;
      const killsAtDeadline = first.killed();
      released.resolve();
      first.child.stdout?.emit("data", Buffer.from("git version 2.54.0\n"));
      first.child.emit("close", 0);
      await vi.advanceTimersByTimeAsync(0);
      await result;
      const floorProbeCount = resolving ? 0 : 1;
      expect([verdictAtDeadline, killsAtDeadline, spawned.calls]).toEqual(["timeout", floorProbeCount, floorProbeCount]);
    } finally {
      released.resolve();
      vi.useRealTimers();
    }
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
    // Each process reports only once the host, which listens as it starts it, has started it.
    const exited = deaf();
    spawned.fake = () => {
      queueMicrotask(() => {
        exited.child.stdout?.emit("data", Buffer.from("partial"));
        exited.child.emit("exit", 0);
      });
      return exited.child;
    };
    spawned.calls = 0;
    expect(await reasonOf(createHostGit({ env, teardownMs: 20 }).run(base, ["status"]))).toBe("terminated");
    expect(spawned.calls).toBe(1);
    expect(exited.child.stdout?.destroyed).toBe(true);

    // One that closes in time after its exit is read as before.
    const closing = deaf();
    spawned.fake = () => {
      queueMicrotask(() => {
        closing.child.stdout?.emit("data", Buffer.from("whole"));
        closing.child.emit("exit", 0);
        closing.child.emit("close", 0);
      });
      return closing.child;
    };
    spawned.calls = 0;
    expect(await createHostGit({ env, teardownMs: 1_000 }).run(base, ["status"])).toMatchObject({ code: 0, stdout: "whole" });
    expect(spawned.calls).toBe(1);
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

  it("an isolated call reads no system or user configuration; any other call reads the user's configuration files, and neither reads settings an inherited variable gives", async () => {
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
    expect(inherited.some(line => line.endsWith("fixture.file=inherited"))).toBe(true);
    expect(inherited.filter(line => /fixture\.(count|parameters)/u.test(line))).toEqual([]);
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
    // As git itself writes them, from a file whose section and variable are in mixed case and one whose name is no text, for a host
    // in a UTF-8 locale: there git's own pattern `.*` matches no name that is no text.
    spawned.fake = undefined;
    const utf8 = { ...env, LC_ALL: "C.UTF-8" };
    const repo = repositoryWith('[Filter "Mixed"]\n\tClean = cat\n\tReQuired\n[MERGE "Up"]\n\tDriver = true\n');
    expect.soft(await createHostGit({ env: utf8 }).drivers(repo)).toEqual({ config: expect.arrayContaining(["filter.Mixed.clean=", "merge.Up.driver=exit 1"]), requiredFilters: ["Mixed"] });
    appendFileSync(join(repo, ".git", "config"), Buffer.concat([Buffer.from('[filter "x'), Buffer.from([0xff]), Buffer.from('y"]\n\tclean = cat\n')]));
    expect(await reasonOf(createHostGit({ env: utf8 }).drivers(repo))).toBe("driver-name");
  });

  it("an answer asked for as text is given only when it is text, as it stands; asked for otherwise, a byte that is none is replaced", async () => {
    const answer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a.txt\0b"), Buffer.from([0xff]), Buffer.from(".txt\0")]);
    replying({ code: 0, stdout: answer });
    expect.soft(await reasonOf(createHostGit({ env }).run(base, ["ls-files", "-z"], { exact: true }))).toBe("not-text");
    replying({ code: 0, stdout: answer });
    expect.soft((await createHostGit({ env }).run(base, ["ls-files", "-z"])).stdout).toContain("\uFFFD.txt");
    replying({ code: 0, stdout: answer.subarray(0, 9) });
    expect((await createHostGit({ env }).run(base, ["ls-files", "-z"], { exact: true })).stdout).toBe("\uFEFFa.txt\0");
  });

  it("a driver name the call cannot carry is still told as that, whatever character makes it so", async () => {
    for (const name of ["a\rb", "a=b"]) {
      replying({ code: 0, stdout: `filter.${name}.clean\ncat\0` }, { code: 1 });
      expect(await reasonOf(createHostGit({ env }).drivers(base)), JSON.stringify(name)).toBe("driver-name");
    }
  });

  it("drivers are read from the configuration every git command reads: a file an inherited variable names for the configuration command alone hides none, and one inherited variables name reaches no call", async () => {
    const repo = repositoryWith('[filter "own"]\n\tclean = cat\n\trequired = true\n');
    writeFileSync(join(base, "other.cfg"), "");
    const git = createHostGit({ env: {
      ...env, GIT_CONFIG: join(base, "other.cfg"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.counted.clean", GIT_CONFIG_VALUE_0: "cat", GIT_CONFIG_PARAMETERS: "'filter.given.clean=cat'",
    } });
    const drivers = await git.drivers(repo);
    expect(drivers.requiredFilters).toEqual(["own"]);
    expect(drivers.config).toContain("filter.own.clean=");
    // What the call carries is read last: the driver git would run is none.
    expect(await git.run(repo, ["config", "--get", "filter.own.clean"], { drivers: drivers.config })).toMatchObject({ code: 0, stdout: "\n" });
    for (const name of ["counted", "given"]) expect(await git.run(repo, ["config", "--get", `filter.${name}.clean`]), name).toMatchObject({ code: 1, stdout: "" });
  });

  it("an inherited variable that names another source of attributes, or another object store, is not passed on", async () => {
    const repo = repositoryWith("");
    const plain = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
    plain("-c", "user.name=Alice Example", "-c", "user.email=alice@example.com", "commit", "-q", "--allow-empty", "-m", "first");
    // Not in the commit: only the work tree gives the file its filter.
    writeFileSync(join(repo, ".gitattributes"), "a.txt filter=own\n");
    const attributes = await createHostGit({ env: { ...env, GIT_ATTR_SOURCE: "HEAD" } }).run(repo, ["check-attr", "-z", "--stdin", "filter"], { stdin: "a.txt\0" });
    expect.soft(attributes).toMatchObject({ code: 0, stdout: "a.txt\0filter\0own\0" });
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

  it.each([
    [":.:./bin:bin:/usr/local/bin::/usr/bin:", "/usr/local/bin:/usr/bin"],
    [":.:./bin:bin:", "/dev/null"],
    ["", "/dev/null"],
  ])("gives git an absolute POSIX search path for PATH=%j", async (path, expected) => {
    const platform = process.platform;
    const program = join(base, "git");
    writeFileSync(program, "", { mode: 0o755 });
    const identity = executableIdentitySync(program);
    if (identity === null) throw new Error("Missing fixture executable");
    replying({ code: 0 });
    setProcessPlatform("linux");
    try {
      await createHostGit({ env: { PATH: path }, resolve: use => use({ path: program, identity }) }).run(base, ["--version"]);
    } finally {
      setProcessPlatform(platform);
    }
    expect(spawned.env?.PATH).toBe(expected);
  });

  it("git is given of the host's environment only what starts it and finds the user's configuration files, whatever a name's case, and the host's own git variables", async () => {
    // On Windows a name is one variable however it is spelled.
    const started = [...process.platform === "win32" ? ["Path", "SystemRoot", "userprofile"] : ["PATH", "USERPROFILE"], "HOME", "XDG_CONFIG_HOME", "TEMP", "LANG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];
    // Each a program, a transport, a repository or a configuration git would otherwise take from the host.
    const others = [
      "GIT_DIR", "git_work_tree", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REFERENCE_BACKEND", "GIT_NAMESPACE",
      "GIT_EXEC_PATH", "Git_Exec_Path", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_ALLOW_PROTOCOL", "GIT_NO_LAZY_FETCH", "GIT_PROTOCOL_FROM_USER", "GIT_SSH_COMMAND", "GIT_TRACE",
      "GIT_TRACE2_EVENT", "GIT_LITERAL_PATHSPECS", "GIT_ATTR_SOURCE", "GIT_TEMPLATE_DIR", "GIT_TERMINAL_PROMPT", "EDITOR", "VISUAL", "PAGER", "EMAIL",
      "SSH_AUTH_SOCK", "HTTPS_PROXY", "NODE_OPTIONS", "AVE_HOME",
    ];
    // A POSIX search path keeps only its absolute entries.
    const value = (name: string): string => name === "PATH" ? "/usr/bin" : "inherited";
    const inherited = Object.fromEntries([...started, ...others].map(name => [name, value(name)]));
    const own = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" };
    replying({ code: 0 });
    await createHostGit({ env: inherited }).run(base, ["--version"]);
    expect(spawned.env).toEqual({ ...Object.fromEntries(started.map(name => [name, value(name)])), ...own });
    replying({ code: 0 });
    await createHostGit({ env: inherited }).run(base, ["--version"], { isolated: true });
    expect(spawned.env).toEqual({
      ...Object.fromEntries(started.filter(name => !name.startsWith("GIT_")).map(name => [name, value(name)])), ...own,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    });
  });

  it("every process the work board starts is started here, only as git through the host floor and the host's one start of git", () => {
    const board = fileURLToPath(new URL("../../", import.meta.url));
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? entry.name === "__tests__" ? [] : sources(join(dir, entry.name))
      : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
    const starting = sources(board).filter(file => /child_process/u.test(readFileSync(file, "utf8")));
    expect(starting.map(file => relative(board, file).split(sep).join("/"))).toEqual(["workflow/host-git.ts"]);
    const text = readFileSync(join(board, "workflow", "host-git.ts"), "utf8");
    expect(text.match(/\bspawn\(/gu)).toBeNull();
    expect(text.match(/\bspawnHostGitIfWorkspaceFree\(/gu)).toHaveLength(1);
    // The program is the one the host resolved, never a name looked up where the call runs.
    expect(text).toMatch(/\bspawnHostGitIfWorkspaceFree\(cwd, git\.path, args, /u);
  });

  it("a path reaches git only as a literal pathspec the call gives apart: an argument list that carries one is refused before git starts", async () => {
    const repo = repositoryWith("");
    for (const name of ["b[1].txt", "b1.txt"]) writeFileSync(join(repo, name), `${name}\n`);
    const git = createHostGit({ env });
    expect((await git.run(repo, ["add", "-A"])).code).toBe(0);
    spawned.calls = 0;
    expect(await reasonOf(git.run(repo, ["diff", "--cached", "--name-only", "--", "b[1].txt"]))).not.toBe("finished");
    expect(spawned.calls).toBe(0);
    expect(await git.run(repo, ["diff", "--cached", "--name-only"], { paths: ["b[1].txt"] })).toMatchObject({ code: 0, stdout: "b[1].txt\n" });
  });
});

/** Whether the git in use runs a hook its configuration names, and leaves it off once its event is switched off: asked of git alone, in
 * a repository of its own. */
function configHooksSwitchable(): { version: string; switchable: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "hg-probe-"));
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "none") }, stdio: "pipe" }); };
  const marker = join(dir, "ran");
  const hooked = (...switches: string[]): boolean => {
    try { git("-c", "hook.probe.event=post-commit", "-c", `hook.probe.command=echo ran >> '${marker.split(sep).join("/")}'`, ...switches, "hook", "run", "--ignore-missing", "post-commit"); } catch { return false; }
    const ran = existsSync(marker);
    rmSync(marker, { force: true });
    return ran;
  };
  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    git("init", "-q");
    return { version, switchable: hooked() && !hooked("-c", "hook.post-commit.enabled=false") };
  } catch {
    return { version: "unknown", switchable: false };
  } finally {
    removeTree(dir);
  }
}

describe("host git on the installed git", () => {
  const plain = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const identity = "[user]\n\tname = Alice Example\n\temail = alice@example.com\n";

  it.runIf(process.platform === "win32")("a git program planted in the folder a call runs in never runs, even with the host's lookup switch off; the resolved git answers", async () => {
    const switchName = "NoDefaultCurrentDirectoryInExePath";
    const saved = process.env[switchName];
    delete process.env[switchName];
    try {
      const folder = join(base, "planted");
      mkdirSync(folder);
      // Any program that is no git: its answer is not git's.
      for (const name of ["git.com", "git.exe"]) copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), join(folder, name));
      const callEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== switchName.toUpperCase()));
      const answer = await createHostGit({ env: callEnv }).run(folder, ["--version"]);
      expect(answer).toMatchObject({ code: 0, stdout: expect.stringMatching(/^git version /u) });
      expect(isAbsolute(spawned.program ?? "")).toBe(true);
      expect(dirname(spawned.program ?? "").toLowerCase()).not.toBe(folder.toLowerCase());
    } finally {
      if (saved !== undefined) process.env[switchName] = saved;
    }
  });

  const hookSwitch = configHooksSwitchable();
  it(`no hook runs for any host call, whether the repository, the user's file or a file it includes configures it; git without the floor runs them (${hookSwitch.version}: ${hookSwitch.switchable ? "an event's hooks switch off, the floor holds" : "no event switch, the floor is refused"})`, async () => {
    // Without an event switch the floor cannot be proven, so the host refuses that git; the hooks directory is still never read.
    expect(await createHostGit({ env }).floorHolds()).toBe(hookSwitch.switchable);
    const marker = join(base, "fired.txt");
    const hooks = join(base, "hooks");
    mkdirSync(hooks);
    const configured = (prefix: string): string => HOOK_EVENTS.map(event => `[hook "${prefix}-${event}"]\n\tcommand = echo ${prefix}-${event} >> '${marker.split(sep).join("/")}'\n\tevent = ${event}\n\tenabled = true\n`).join("");
    for (const event of HOOK_EVENTS) writeFileSync(join(hooks, event), `#!/bin/sh\necho dir-${event} >> '${marker.split(sep).join("/")}'\n`, { mode: 0o755 });
    const repo = repositoryWith(`${identity}${configured("repo")}[core]\n\thooksPath = ${hooks.split(sep).join("/")}\n`);
    writeFileSync(join(base, "included.cfg"), configured("included"));
    appendFileSync(join(base, "gitconfig"), `[include]\n\tpath = ${join(base, "included.cfg").split(sep).join("/")}\n${configured("user")}`);
    const git = createHostGit({ env });
    const ok = async (cwd: string, args: string[], call?: Parameters<ReturnType<typeof createHostGit>["run"]>[2]): Promise<void> => {
      expect.soft(await git.run(cwd, args, call), args.join(" ")).toMatchObject({ code: 0 });
    };
    writeFileSync(join(repo, "a.txt"), "one\n");
    await ok(repo, ["add", "-A"]);
    await ok(repo, ["commit", "-q", "--no-verify", "-m", "first"]);
    await ok(repo, ["update-ref", "refs/heads/side", "HEAD"]);
    const side = join(base, "side");
    await ok(repo, ["worktree", "add", "--no-checkout", side, "side"]);
    const worktree = { gitDir: join(repo, ".git", "worktrees", "side"), workTree: side };
    await ok(side, ["reset", "--hard", "-q"], { worktree });
    writeFileSync(join(side, "a.txt"), "side\n");
    await ok(side, ["add", "-A"], { worktree });
    await ok(side, ["commit", "-q", "--no-verify", "-m", "side"], { worktree });
    writeFileSync(join(repo, "b.txt"), "main\n");
    await ok(repo, ["add", "-A"]);
    await ok(repo, ["commit", "-q", "--no-verify", "-m", "main"]);
    await ok(repo, ["merge", "--no-edit", "--no-verify", "-m", "both", "side"]);
    writeFileSync(join(side, "a.txt"), "side again\n");
    await ok(side, ["commit", "-q", "--no-verify", "-a", "-m", "side again"], { worktree });
    writeFileSync(join(repo, "a.txt"), "main again\n");
    await ok(repo, ["commit", "-q", "--no-verify", "-a", "-m", "main again"]);
    expect.soft((await git.run(repo, ["merge", "--no-edit", "--no-verify", "side"])).code).toBe(1);
    await ok(repo, ["merge", "--abort"]);
    const fromHost = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (hookSwitch.switchable) expect(fromHost).toBe("");
    else expect(fromHost.split("\n").filter(line => line.startsWith("dir-"))).toEqual([]);
    // The same hooks are live: git without the floor runs each kind it knows.
    writeFileSync(join(repo, "c.txt"), "control\n");
    plain(repo, "add", "-A");
    plain(repo, "commit", "-q", "--no-verify", "-m", "control");
    const fired = readFileSync(marker, "utf8").slice(fromHost.length);
    const configKinds = ["repo-post-commit", "user-post-commit", "included-post-commit", "repo-prepare-commit-msg", "repo-reference-transaction"];
    for (const kind of ["dir-post-commit", ...hookSwitch.switchable ? configKinds : []]) expect.soft(fired, kind).toContain(kind);
  });

  it("an exec path the host inherited is not where git starts its own programs", async () => {
    const { GIT_EXEC_PATH: _, ...clean } = env;
    const installed = execFileSync("git", ["--exec-path"], { env: clean, encoding: "utf8" }).trim();
    expect((await createHostGit({ env: { ...clean, GIT_EXEC_PATH: base } }).run(base, ["--exec-path"])).stdout.trim()).toBe(installed);
  });

  it("a partial clone's missing object is not fetched, whatever a configuration file allows a protocol, nor is a transport a call asks for started; what the clone holds is read", async () => {
    const source = repositoryWith(`${identity}[uploadpack]\n\tallowFilter = true\n\tallowAnySHA1InWant = true\n`);
    writeFileSync(join(source, "far.txt"), "far\n");
    plain(source, "add", "far.txt");
    plain(source, "commit", "-q", "-m", "first");
    const blob = plain(source, "rev-parse", "HEAD:far.txt");
    const clone = join(base, "clone");
    plain(base, "clone", "-q", "--filter=blob:none", "--no-checkout", pathToFileURL(source).href, clone);
    writeFileSync(join(base, "allowing.cfg"), "[protocol \"file\"]\n\tallow = always\n[protocol]\n\tallow = always\n");
    appendFileSync(join(base, "gitconfig"), `[include]\n\tpath = ${join(base, "allowing.cfg").split(sep).join("/")}\n`);
    const git = createHostGit({ env });
    expect((await git.run(clone, ["cat-file", "-t", "HEAD"])).stdout).toBe("commit\n");
    expect((await git.run(clone, ["cat-file", "-p", `${blob}`])).code).not.toBe(0);
    expect((await git.run(base, ["clone", "-q", pathToFileURL(source).href, join(base, "again")])).code).not.toBe(0);
    expect(existsSync(join(base, "again"))).toBe(false);
    // The same clone does fetch it on demand for git without the host's policy.
    expect(plain(clone, "cat-file", "-p", blob)).toBe("far");
  });

  it("a ceiling the host inherited hides no repository from git's discovery", async () => {
    const repo = repositoryWith("");
    mkdirSync(join(repo, "sub"));
    const top = await createHostGit({ env: { ...env, GIT_CEILING_DIRECTORIES: repo } }).run(join(repo, "sub"), ["rev-parse", "--show-toplevel"], { exact: true });
    expect(top.code).toBe(0);
    expect(realpathSync.native(top.stdout.trim())).toBe(realpathSync.native(repo));
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

  it("a call in a folder that does not exist starts nothing, and the git the host resolved stays resolved", async () => {
    const before = (await discoverHostGitAsync(null)).git?.path;
    spawned.calls = 0;
    expect(await reasonOf(createHostGit({ env }).run(join(base, "missing"), ["--version"]))).toBe("unavailable");
    // Not a program that failed to start: no new discovery probes another one.
    expect(spawned.calls).toBe(0);
    expect((await discoverHostGitAsync(null)).git?.path).toBe(before);
    expect(spawned.calls).toBe(0);
  });

  it("a hold a sandboxed command takes while the host resolves git still refuses the call, and git never starts", async () => {
    const held = join(base, "held");
    mkdirSync(held);
    const program = (await discoverHostGitAsync(null)).git;
    if (program === null) throw new Error("Missing fixture executable");
    const git = createHostGit({ env, resolve: async (use) => {
      const release = holdSandboxGitWrites([held]);
      try { return await use(program); } finally { release(); }
    } });
    spawned.calls = 0;
    expect(await reasonOf(git.run(held, ["--version"]))).toBe("held");
    expect(spawned.calls).toBe(0);
  });
});

describe("the hook floor's probe", () => {
  type Reply = { code: number; stdout?: string; ran?: boolean } | "hang";
  const listedFrom = "git version 2.56.0\n";
  /** A git that knows the event switch: the probe hook runs for its own event alone. */
  const holding = (args: readonly string[]): Reply => args.includes("--version") ? { code: 0, stdout: listedFrom }
    : args.includes("--allow-unknown-hook-name") ? { code: 0, ran: true } : { code: 0 };
  /** Git processes that answer as `answer` says; one whose hook ran appends to the file its command names. */
  function fakeGit(answer: (args: readonly string[]) => Reply): void {
    spawned.fake = (args) => {
      const reply = answer(args);
      if (reply === "hang") return hangingChild().child;
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      queueMicrotask(() => {
        const command = args.find(arg => arg.startsWith("hook.ave-floor-probe.command="));
        const marker = command === undefined ? undefined : /'([^']*)'/u.exec(command)?.[1];
        if (reply.ran === true && marker !== undefined) appendFileSync(marker, "ran\n");
        if (reply.stdout !== undefined) child.stdout.emit("data", Buffer.from(reply.stdout));
        child.emit("close", reply.code);
      });
      return child;
    };
  }
  /** The probe as a process starting afresh, nothing asked yet and nothing told yet, on the git `program` names as the host resolved it. */
  async function freshProbe(): Promise<(program: string | null, probeEnv?: NodeJS.ProcessEnv) => Promise<boolean>> {
    vi.resetModules();
    const fresh = await import("../host-git.js");
    return (program, probeEnv = env) => fresh.createHostGit({ env: probeEnv, resolve: use => {
      const identity = program === null ? null : executableIdentitySync(program);
      return use(program === null || identity === null ? null : { path: program, identity });
    } }).floorHolds();
  }
  /** A program file at `dir`, named as git. */
  function planted(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const program = join(dir, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(program, "", { mode: 0o755 });
    return program;
  }

  it("holds only when the probe hook runs for an event the floor leaves alone and for no listed one; any other answer refuses git", async () => {
    const program = planted(join(base, "first"));
    const outcomes: Record<string, boolean> = {};
    const cases: Record<string, (args: readonly string[]) => Reply> = {
      "switch known": holding,
      "listed hook ran": args => args.at(-1) === "post-commit" ? { code: 0, ran: true } : holding(args),
      "listed hook failed": args => args.at(-1) === "p4-pre-submit" ? { code: 3 } : holding(args),
      "no configured hook runs": args => args.includes("--allow-unknown-hook-name") ? { code: 0 } : holding(args),
      "no such switch": args => args.includes("--allow-unknown-hook-name") ? { code: 129 } : holding(args),
      "no scratch repository": args => args.includes("init") ? { code: 128 } : holding(args),
    };
    for (const [name, answer] of Object.entries(cases)) {
      fakeGit(answer);
      outcomes[name] = await (await freshProbe())(program);
      // The program probed is the program a call starts.
      expect.soft(spawned.program, name).toBe(program);
    }
    expect(outcomes).toEqual({ "switch known": true, "listed hook ran": false, "listed hook failed": false, "no configured hook runs": false, "no such switch": false, "no scratch repository": false });
  });

  it("a probe call that does not finish in time refuses git", async () => {
    const program = planted(join(base, "first"));
    fakeGit(args => args.at(-1) === "update" ? "hang" : holding(args));
    const probe = await freshProbe();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer: boolean | undefined;
      void probe(program).then(holds => { answer = holds; });
      while (answer === undefined) await vi.advanceTimersByTimeAsync(10_000);
      expect(answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // The probe did not finish: it is asked again.
    fakeGit(holding);
    expect(await probe(program)).toBe(true);
  });

  it("a probe whose scratch folder a sandboxed command holds refuses git and is asked again once released", async () => {
    const program = planted(join(base, "first"));
    fakeGit(holding);
    const probe = await freshProbe();
    // The hold of the very module instance the fresh probe asks.
    const { holdSandboxGitWrites: hold } = await import("../../../shared/host-git.js");
    const release = hold([tmpdir()]);
    try {
      expect(await probe(program)).toBe(false);
      expect(spawned.calls).toBe(0);
    } finally {
      release();
    }
    expect(await probe(program)).toBe(true);
  });

  it("is asked once per program until the program changes, and a git newer than the release the events were listed from is told of once", async () => {
    fakeGit(args => args.includes("--version") ? { code: 0, stdout: "git version 2.99.1\n" } : holding(args));
    const probe = await freshProbe();
    const first = planted(join(base, "first"));
    warned.lines = [];
    expect(await probe(first)).toBe(true);
    const asked = spawned.calls;
    expect(await probe(first)).toBe(true);
    expect(spawned.calls).toBe(asked);
    utimesSync(first, new Date(), new Date(Date.now() + 60_000));
    expect(await probe(first)).toBe(true);
    expect(spawned.calls).toBe(asked * 2);
    expect(await probe(planted(join(base, "second")))).toBe(true);
    expect(warned.lines.filter(line => line.includes("newer"))).toHaveLength(1);
    // No program resolved, or one that is not an absolute path, gives nothing to vouch for, and nothing is started.
    spawned.calls = 0;
    expect(await probe(null)).toBe(false);
    expect(await probe(join("relative", "git"))).toBe(false);
    expect(await probe(join(base, "none", "git"))).toBe(false);
    expect(spawned.calls).toBe(0);
  });

  it("a scratch folder that cannot be taken away yet keeps the probe's answer, and is taken away later", async () => {
    const program = planted(join(base, "first"));
    fakeGit(holding);
    const probe = await freshProbe();
    removal.failures = 1;
    removal.scratch = undefined;
    warned.lines = [];
    // The later removal waits on a timer the test moves on itself.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(await probe(program)).toBe(true);
      const asked = spawned.calls;
      expect(await probe(program)).toBe(true);
      expect(spawned.calls).toBe(asked);
      expect(removal.failures).toBe(0);
      expect(warned.lines.filter(line => line.includes("scratch"))).toHaveLength(1);
      const scratch = removal.scratch as string | undefined;
      expect(scratch).toBeDefined();
      expect(existsSync(scratch as string)).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(existsSync(scratch as string)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
