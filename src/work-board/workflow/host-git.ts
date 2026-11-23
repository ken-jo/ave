import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getIsPackaged, isConfigured, isPackagedElectronProcess } from "../../boot/dev-flags.js";
import { createLogger } from "../../lib/logger.js";
import { forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { buildHostGitArgs, HOOK_EVENTS, HOOK_EVENTS_VALIDATED, isHostGitWorkspaceAvailable } from "../../shared/host-git.js";
import { parseGitVersion } from "../../shared/git-version.js";
import { installerGitRoot, withHostGitRecovery } from "../../shared/host-git-executable.js";

const log = createLogger("work-board-host-git");

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** How long a process that was stopped, or that has exited, may keep its pipes open before the call is refused without it. */
const GIT_TEARDOWN_MS = 5_000;

/** On top of the host floor: no credential, prompt, signing or signature check, external diff, transport, submodule recursion or
 * background maintenance. */
const HARDENED_CONFIG = [
  "credential.helper=", "core.askPass=", "commit.gpgSign=false", "tag.gpgSign=false", "merge.verifySignatures=false", "diff.external=",
  "protocol.allow=never", "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false", "user.useConfigOnly=true",
] as const;
/**
 * What git is given of the host's environment, the name taken in upper case on Windows where case does not tell variables apart: what
 * starts a process here and how a program is looked up, where the user's own configuration files are, the temporary folder, the language and the time zone. Every other
 * variable would choose for git a program, a transport, a repository, a way of matching paths or settings of the host's, and the git
 * variables a call carries besides are the host's own: no transport at all, no object fetched on demand, no prompt.
 *
 * The user's configuration files, and the files they include, are read as the user's own policy, `safe.directory` too: what the host
 * relies on it sets itself, on the command line, which git reads after every file, and a hook of any event is switched off as a whole.
 * Settings an inherited variable gives at the command line's level are not taken.
 */
const INHERITED_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROGRAMDATA", "NODEFAULTCURRENTDIRECTORYINEXEPATH",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
  "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
]);
const OWN_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" } as const;

interface HostGitResult { code: number; stdout: string; stderr: string }
/** `worktree`: the registration and the folder git works on, given to it outright; it then reads no `.git` file to find them.
 * `exact`: the answer holds names the caller compares, looks up on disk or hands back to git, so it must be text as it stands: one
 * that is not would be read as other names, and is refused as `not-text`. `paths`: the paths the call is about, each given to git as
 * that one path and never as a pattern; an argument list carries none. */
interface HostGitCall { stdin?: string; drivers?: readonly string[]; isolated?: boolean; exact?: boolean; worktree?: { gitDir: string; workTree: string }; paths?: readonly string[] }
/** Bytes as the text they are and nothing else: no byte replaced, no leading mark dropped. Throws for bytes that are no text. */
const STRICT_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export class HostGitError extends Error {
  constructor(readonly reason: "unavailable" | "held" | "timeout" | "output-limit" | "terminated" | "driver-name" | "not-text", message: string, options?: ErrorOptions) { super(message, options); }
}

/** The git a host call starts: an absolute program and, for the installation the app bundles, the search path and system folder its
 * discovery probed it with. */
export interface HostGitProgram { path: string; bundled?: { searchPath: string; systemRoot: string } }
/** Runs `use` with the git the host resolved, or null when it resolved none; a program that could not be started is resolved again. */
export type HostGitResolver = <T>(use: (git: HostGitProgram | null) => Promise<T>) => Promise<T>;

/** The host's own discovery: never a name looked up from the folder a call runs in. */
const discoveredGit: HostGitResolver = (use) => {
  const packaged = isConfigured() ? getIsPackaged() : isPackagedElectronProcess();
  return withHostGitRecovery(installerGitRoot(packaged), ({ git }) => use(git === null ? null : {
    path: git.path,
    ...git.installer === undefined ? {} : { bundled: { searchPath: git.options.env.PATH ?? "", systemRoot: git.installer.systemRoot } },
  }));
};

export interface HostGit {
  /** Runs one hardened git process. A non-zero exit is returned, never thrown; only a process that could not run or finish throws: one
   * that ended without an exit code, or whose pipes stayed open after it ended, is `terminated`. `isolated` runs it on no configuration but the repository's own and the call's.
   * What it wrote is given as text, a byte that is none replaced; with `exact` such an answer is refused instead. */
  run(cwd: string, args: readonly string[], options?: HostGitCall): Promise<HostGitResult>;
  /** `-c` entries that switch off every filter and merge driver the repository's configuration names, and the filter drivers it marks
   * required. With `worktree`, the configuration is read as a call given that worktree reads it: a file included for that
   * registration or its branch, and the worktree's own, name drivers that git in the project root never sees. */
  drivers(cwd: string, worktree?: HostGitCall["worktree"]): Promise<{ config: string[]; requiredFilters: string[] }>;
  /** Whether the host floor holds on the very program these calls start (`floorHoldsOn`); no program resolved is no. */
  floorHolds(): Promise<boolean>;
}

function gitEnv(base: NodeJS.ProcessEnv, kept: (name: string) => boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (kept(process.platform === "win32" ? key.toUpperCase() : key)) env[key] = value;
  return { ...env, ...OWN_ENV };
}

/** Neither the system's nor the user's configuration file. */
function isolatedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...gitEnv(base, name => INHERITED_ENV.has(name) && !name.startsWith("GIT_")), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

/** A bundled installation runs on the search path and system folder it was probed with, the rest of the environment as for any git. */
function programEnv(env: NodeJS.ProcessEnv, git: HostGitProgram): NodeJS.ProcessEnv {
  if (git.bundled === undefined) return env;
  const own = new Set(["PATH", "SYSTEMROOT", "WINDIR"]);
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !own.has(key.toUpperCase())));
  return { ...kept, PATH: git.bundled.searchPath, SystemRoot: git.bundled.systemRoot, WINDIR: git.bundled.systemRoot };
}

/** Every git call of a stage workspace goes through here: the absolute program `resolve` gives, an argument vector with no shell, a
 * timeout and a bounded output. No program resolved refuses the call as `unavailable`. */
export function createHostGit(options: { env?: NodeJS.ProcessEnv; resolve?: HostGitResolver; timeoutMs?: number; maxOutputBytes?: number; teardownMs?: number } = {}): HostGit {
  const base = options.env ?? process.env;
  const resolve = options.resolve ?? discoveredGit;
  const env = gitEnv(base, name => INHERITED_ENV.has(name));
  const isolated = isolatedEnv(base);
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;
  const teardownMs = options.teardownMs ?? GIT_TEARDOWN_MS;

  /** What git wrote, as the bytes it wrote. */
  function raw(cwd: string, args: readonly string[], call: HostGitCall = {}): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    if (args.includes("--")) return Promise.reject(new Error("a path reaches git only as one of the call's paths"));
    if (!isHostGitWorkspaceAvailable(cwd)) return Promise.reject(new HostGitError("held", "the workspace is held by a sandboxed command"));
    const configArgs = [...HARDENED_CONFIG.flatMap(entry => ["-c", entry]), ...(call.drivers ?? [])];
    const full = [
      ...call.worktree === undefined ? [] : [`--git-dir=${call.worktree.gitDir}`, `--work-tree=${call.worktree.workTree}`],
      ...args,
      ...call.paths === undefined ? [] : ["--", ...call.paths.map(path => `:(literal)${path}`)],
    ];
    return resolve(git => start(git, cwd, buildHostGitArgs(full, { configArgs }), call));
  }

  function start(git: HostGitProgram | null, cwd: string, args: string[], call: HostGitCall): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    if (git === null || !isAbsolute(git.path)) return Promise.reject(new HostGitError("unavailable", "no git installation was found"));
    const program = git.path;
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env: programEnv(call.isolated === true ? isolated : env, git), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let failure: HostGitError | undefined;
      let settled = false;
      let abandoning: NodeJS.Timeout | undefined;
      const settle = (how: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(abandoning);
        how();
      };
      // The call ends here even when the process never reports its end: a descendant that holds a pipe, or a process the kill did not
      // reach, would otherwise hold the caller, and with it the run's queue, for good.
      const abandon = (): void => {
        abandoning ??= setTimeout(() => {
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
          settle(() => reject(failure ?? new HostGitError("terminated", "git ended and left its pipes open")));
        }, teardownMs);
      };
      const stop = (error: HostGitError): void => {
        if (failure) return;
        failure = error;
        // The whole tree, within the bound that kill has of its own; then the wait for the pipes begins.
        void Promise.resolve().then(() => forceKillManagedChildProcess(child, `host git ${error.reason}`)).then(abandon, abandon);
      };
      const timer = setTimeout(() => stop(new HostGitError("timeout", "git did not finish in time")), timeoutMs);
      const collect = (into: Buffer[]) => (chunk: Buffer): void => {
        size += chunk.length;
        if (size > maxOutputBytes) stop(new HostGitError("output-limit", "git wrote more than the host reads"));
        else into.push(chunk);
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.on("error", (error) => settle(() => reject(new HostGitError("unavailable", error.message, { cause: error }))));
      child.on("exit", abandon);
      child.on("close", (code) => settle(() => {
        if (failure) reject(failure);
        // Ended by something other than the host: what it wrote is not a whole answer.
        else if (code === null) reject(new HostGitError("terminated", "git ended without an exit code"));
        else resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(call.stdin ?? "");
    });
  }

  async function run(cwd: string, args: readonly string[], call: HostGitCall = {}): Promise<HostGitResult> {
    const { code, stdout, stderr } = await raw(cwd, args, call);
    if (call.exact !== true) return { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
    try { return { code, stdout: STRICT_TEXT.decode(stdout), stderr: stderr.toString("utf8") }; } catch { throw new HostGitError("not-text", "git's answer holds a name that is no text"); }
  }

  async function drivers(cwd: string, worktree?: HostGitCall["worktree"]): Promise<{ config: string[]; requiredFilters: string[] }> {
    const unread = (): HostGitError => new HostGitError("unavailable", "git configuration could not be read");
    // An answer is taken only in the form the command writes it: each entry ended by NUL, its key first and, after a line break, its
    // value, or the key alone where the configuration gives it none. Nothing configured is exit 1 with nothing written at all. Any
    // other failure is a configuration git itself does not take, and any other form is no answer. It is read byte for byte, each
    // byte one character here: a name is a file's bytes, and read as text first, one that is no text would come out as another.
    const listed = async (...args: string[]): Promise<[key: string, value: string | undefined][]> => {
      const read = await raw(cwd, ["config", "--null", ...args], worktree === undefined ? {} : { worktree });
      if (read.code === 1 && read.stdout.length === 0 && read.stderr.length === 0) return [];
      const bytes = read.stdout.toString("latin1");
      if (read.code !== 0 || !bytes.endsWith("\0")) throw unread();
      return bytes.slice(0, -1).split("\0").map((entry) => {
        const at = entry.indexOf("\n");
        return at < 0 ? [entry, undefined] : [entry.slice(0, at), entry.slice(at + 1)];
      });
    };
    // The name a key holds, as the text a `-c` entry carries; undefined for bytes that are no text. A leading byte order mark is
    // part of the name.
    const nameOf = (key: string): string | undefined => {
      try { return STRICT_TEXT.decode(Buffer.from(key.slice(key.indexOf(".") + 1, key.lastIndexOf(".")), "latin1")); } catch { return undefined; }
    };
    const filters = new Set<string>();
    const merges = new Set<string>();
    const names = new Map<string, string>();
    const named = await listed("--get-regexp", "^(filter|merge)\\..*\\.(clean|smudge|process|required|driver)$");
    for (const [key] of named) {
      // Git writes a section and a variable in lower case, and a name between them as the configuration spells it.
      if (!/^(filter|merge)\..*\.(clean|smudge|process|required|driver)$/su.test(key)) throw unread();
      const name = nameOf(key);
      // A name `-c` cannot carry would stay active.
      if (name === undefined || name === "" || /[=\n\r\0]/u.test(name)) throw new HostGitError("driver-name", "a configured driver name cannot be switched off");
      (key.startsWith("merge.") ? merges : filters).add(name);
      names.set(key, name);
    }
    // Asked of git as the boolean it reads there: a key with no value and a number other than 0 are true, an empty value is false, the
    // last one given decides, and a value that is neither fails the call. It answers for the very keys the first listing named, in
    // their order, each with `true` or `false`: an answer that differs is of another configuration, or is none.
    const requiredFilters = new Set<string>();
    const required = await listed("--type=bool", "--get-regexp", "^filter\\..*\\.required$");
    const asked = named.map(([key]) => key).filter(key => /^filter\..*\.required$/su.test(key));
    if (required.length !== asked.length || required.some(([key, value], index) => key !== asked[index] || (value !== "true" && value !== "false"))) throw unread();
    for (const [key, value] of required) {
      const name = names.get(key) as string;
      if (value === "true") requiredFilters.add(name);
      else requiredFilters.delete(name);
    }
    return {
      config: [
        ...[...filters].flatMap(name => ["clean=", "smudge=", "process=", "required=false"].flatMap(field => ["-c", `filter.${name}.${field}`])),
        // A custom merge driver never runs: its replacement reports a conflict, which the join gate shows.
        ...[...merges].flatMap(name => ["-c", `merge.${name}.driver=exit 1`]),
      ],
      requiredFilters: [...requiredFilters],
    };
  }

  return { run, drivers, floorHolds: () => resolve(git => git === null || !isAbsolute(git.path) ? Promise.resolve(false) : floorHoldsOn(git, base)).catch(() => false) };
}

const floorProbes = new Map<string, Promise<boolean>>();
let unprovenLogged = false;

/**
 * Whether the host floor keeps every event `HOOK_EVENTS` lists from running a configured hook on `git`, the program a call starts, asked
 * once per program and its modification time. In a scratch repository, through the same calls every host git process makes, a hook is
 * configured ahead of the floor and run: one for an event the floor leaves alone must run, or nothing tells whether one ran at all,
 * and none for a listed event may. Anything else, a failed call or a timeout among them, is no. Only that answer is kept: a scratch
 * folder that cannot be made or taken away decides nothing.
 */
function floorHoldsOn(git: HostGitProgram, env: NodeJS.ProcessEnv): Promise<boolean> {
  let key: string;
  try { key = `${git.path}\0${statSync(git.path).mtimeMs}`; } catch { return Promise.resolve(false); }
  const known = floorProbes.get(key);
  if (known !== undefined) return known;
  let scratch: string;
  try { scratch = mkdtempSync(join(tmpdir(), "ave-git-floor-")); } catch { return Promise.resolve(false); }
  const verdict = probeFloor(createHostGit({ env, resolve: use => use(git) }), scratch).catch(() => false);
  floorProbes.set(key, verdict);
  void verdict.then(() => removeScratch(scratch));
  return verdict;
}

async function probeFloor(git: HostGit, scratch: string): Promise<boolean> {
  const version = await git.run(scratch, ["--version"], { isolated: true });
  if (version.code !== 0 || (await git.run(scratch, ["init", "-q"], { isolated: true })).code !== 0) return false;
  const marker = join(scratch, "ran");
  const quoted = `'${marker.split("\\").join("/").split("'").join("'\\''")}'`;
  const hooked = async (event: string, exit: number, unlisted: string[] = []): Promise<number> => (await git.run(scratch, ["hook", "run", ...unlisted, "--ignore-missing", event], {
    isolated: true, drivers: ["-c", `hook.ave-floor-probe.event=${event}`, "-c", `hook.ave-floor-probe.command=echo ran >> ${quoted}; exit ${exit}`],
  })).code;
  if (await hooked("ave-floor-probe", 0, ["--allow-unknown-hook-name"]) !== 0 || !existsSync(marker)) return false;
  rmSync(marker);
  for (const event of HOOK_EVENTS) if (await hooked(event, 3) !== 0 || existsSync(marker)) return false;
  const { major = 0, minor = 0 } = parseGitVersion(version.stdout) ?? {};
  if (!unprovenLogged && (major > HOOK_EVENTS_VALIDATED[0] || (major === HOOK_EVENTS_VALIDATED[0] && minor > HOOK_EVENTS_VALIDATED[1]))) {
    unprovenLogged = true;
    log.warn("git %s is newer than %s, the release the hook events were listed from: an event added since is not switched off", version.stdout.trim(), HOOK_EVENTS_VALIDATED.join("."));
  }
  return true;
}

const SCRATCH_RETRIES = 3;
const SCRATCH_RETRY_MS = 2_000;

/** Takes the probe's scratch folder away, again later while a process still holds it. */
function removeScratch(scratch: string, attempt = 0): void {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    if (attempt === 0) log.warn("the git floor probe's scratch folder could not be removed yet: %s", String(error));
    if (attempt < SCRATCH_RETRIES) setTimeout(() => removeScratch(scratch, attempt + 1), SCRATCH_RETRY_MS * (attempt + 1)).unref();
  }
}
