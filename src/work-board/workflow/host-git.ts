import { spawn } from "node:child_process";
import { forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { buildHostGitArgs, isHostGitWorkspaceAvailable } from "../../shared/host-git.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** How long a process that was stopped, or that has exited, may keep its pipes open before the call is refused without it. */
const GIT_TEARDOWN_MS = 5_000;

/** On top of the host floor: no credential, prompt, signing, external diff, transport, submodule recursion or background maintenance. */
const HARDENED_CONFIG = [
  "credential.helper=", "core.askPass=", "commit.gpgSign=false", "tag.gpgSign=false", "diff.external=", "protocol.allow=never",
  "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false", "user.useConfigOnly=true",
] as const;
/** Inherited variables git is never given, whatever their case. A call names its repository by its folder alone, and what it reads and
 * writes there is that repository's own. */
const DROPPED_ENV = new RegExp(`^(${[
  // Where the repository, its work tree and its index are.
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  // Where objects are read from or written to, and which ones stand in for others or end the history.
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
  // Where refs are kept and under which names.
  "GIT_NAMESPACE", "GIT_REFERENCE_BACKEND",
  // The attributes read for a path, and how the paths a call names are matched.
  "GIT_ATTR_SOURCE", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
  // Gives the configuration command alone another file to read: the drivers it lists would not be the ones a checkout runs.
  "GIT_CONFIG",
  // Git's input and its answer, taken from the pipes of the call.
  "GIT_REDIRECT_STDIN", "GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR",
  // Answers a prompt, supplies an identity or starts a program.
  "GIT_ASKPASS", "SSH_ASKPASS", "GIT_ASK_YESNO", "GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)",
  // Allows a transport the call forbids, and the switches of git's own test suite.
  "GIT_ALLOW_PROTOCOL", "GIT_TEST_[^=]*",
].join("|")})$`, "iu");

interface HostGitResult { code: number; stdout: string; stderr: string }
/** `worktree`: the registration and the folder git works on, given to it outright; it then reads no `.git` file to find them. */
interface HostGitCall { stdin?: string; drivers?: readonly string[]; isolated?: boolean; worktree?: { gitDir: string; workTree: string } }
export class HostGitError extends Error {
  constructor(readonly reason: "unavailable" | "held" | "timeout" | "output-limit" | "terminated" | "driver-name", message: string) { super(message); }
}

export interface HostGit {
  /** Runs one hardened git process. A non-zero exit is returned, never thrown; only a process that could not run or finish throws: one
   * that ended without an exit code, or whose pipes stayed open after it ended, is `terminated`. `isolated` runs it on no configuration but the repository's own and the call's. */
  run(cwd: string, args: readonly string[], options?: HostGitCall): Promise<HostGitResult>;
  /** `-c` entries that switch off every filter and merge driver the repository's configuration names, and the filter drivers it marks
   * required. With `worktree`, the configuration is read as a call given that worktree reads it: a file included for that
   * registration or its branch, and the worktree's own, name drivers that git in the project root never sees. */
  drivers(cwd: string, worktree?: HostGitCall["worktree"]): Promise<{ config: string[]; requiredFilters: string[] }>;
}

function gitEnv(base: NodeJS.ProcessEnv, dropped = DROPPED_ENV): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!dropped.test(key)) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** No inherited git variable at all, and neither the system's nor the user's configuration file. */
function isolatedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...gitEnv(base, /^GIT_/iu), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

/** Every git call of a stage workspace goes through here: an argument vector with no shell, a timeout and a bounded output. */
export function createHostGit(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number; teardownMs?: number } = {}): HostGit {
  const env = gitEnv(options.env ?? process.env);
  const isolated = isolatedEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;
  const teardownMs = options.teardownMs ?? GIT_TEARDOWN_MS;

  function run(cwd: string, args: readonly string[], call: HostGitCall = {}): Promise<HostGitResult> {
    if (!isHostGitWorkspaceAvailable(cwd)) return Promise.reject(new HostGitError("held", "the workspace is held by a sandboxed command"));
    const configArgs = [...HARDENED_CONFIG.flatMap(entry => ["-c", entry]), ...(call.drivers ?? [])];
    return new Promise((resolve, reject) => {
      const child = spawn("git", buildHostGitArgs(call.worktree === undefined ? args : [`--git-dir=${call.worktree.gitDir}`, `--work-tree=${call.worktree.workTree}`, ...args], { configArgs }), { cwd, env: call.isolated === true ? isolated : env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
      child.on("error", (error) => settle(() => reject(new HostGitError("unavailable", error.message))));
      child.on("exit", abandon);
      child.on("close", (code) => settle(() => {
        if (failure) reject(failure);
        // Ended by something other than the host: what it wrote is not a whole answer.
        else if (code === null) reject(new HostGitError("terminated", "git ended without an exit code"));
        else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(call.stdin ?? "");
    });
  }

  async function drivers(cwd: string, worktree?: HostGitCall["worktree"]): Promise<{ config: string[]; requiredFilters: string[] }> {
    const unread = (): HostGitError => new HostGitError("unavailable", "git configuration could not be read");
    // An answer is taken only in the form the command writes it: each entry ended by NUL, its key first and, after a line break, its
    // value, or the key alone where the configuration gives it none. Nothing configured is exit 1 with nothing written at all. Any
    // other failure is a configuration git itself does not take, and any other form is no answer.
    const listed = async (...args: string[]): Promise<[key: string, value: string | undefined][]> => {
      const read = await run(cwd, ["config", "--null", ...args], worktree === undefined ? {} : { worktree });
      if (read.code === 1 && read.stdout === "" && read.stderr === "") return [];
      if (read.code !== 0 || !read.stdout.endsWith("\0")) throw unread();
      return read.stdout.slice(0, -1).split("\0").map((entry) => {
        const at = entry.indexOf("\n");
        return at < 0 ? [entry, undefined] : [entry.slice(0, at), entry.slice(at + 1)];
      });
    };
    const nameOf = (key: string): string => key.slice(key.indexOf(".") + 1, key.lastIndexOf("."));
    const filters = new Set<string>();
    const merges = new Set<string>();
    const named = await listed("--get-regexp", "^(filter|merge)\\..*\\.(clean|smudge|process|required|driver)$");
    for (const [key] of named) {
      if (!/^(filter|merge)\..*\.(clean|smudge|process|required|driver)$/isu.test(key)) throw unread();
      const name = nameOf(key);
      // A name `-c` cannot carry would stay active.
      if (name === "" || /[=\n\r\0]/u.test(name)) throw new HostGitError("driver-name", "a configured driver name cannot be switched off");
      (key.slice(0, key.indexOf(".")).toLowerCase() === "merge" ? merges : filters).add(name);
    }
    // Asked of git as the boolean it reads there: a key with no value and a number other than 0 are true, an empty value is false, the
    // last one given decides, and a value that is neither fails the call. It answers for the very keys the first listing named, in
    // their order, each with `true` or `false`: an answer that differs is of another configuration, or is none.
    const requiredFilters = new Set<string>();
    const required = await listed("--type=bool", "--get-regexp", "^filter\\..*\\.required$");
    const asked = named.map(([key]) => key).filter(key => /^filter\..*\.required$/isu.test(key));
    if (required.length !== asked.length || required.some(([key, value], index) => key !== asked[index] || (value !== "true" && value !== "false"))) throw unread();
    for (const [key, value] of required) {
      if (value === "true") requiredFilters.add(nameOf(key));
      else requiredFilters.delete(nameOf(key));
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

  return { run, drivers };
}
