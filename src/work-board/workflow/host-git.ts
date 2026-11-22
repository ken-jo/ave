import { spawn } from "node:child_process";
import { buildHostGitArgs, isHostGitWorkspaceAvailable } from "../../shared/host-git.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** On top of the host floor: no credential, prompt, signing, external diff, transport, submodule recursion or background maintenance. */
const HARDENED_CONFIG = [
  "credential.helper=", "core.askPass=", "commit.gpgSign=false", "tag.gpgSign=false", "diff.external=", "protocol.allow=never",
  "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false", "user.useConfigOnly=true",
] as const;
/** Variables that would redirect the repository, answer a prompt, supply an identity or start a program. */
const DROPPED_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_SSH|GIT_SSH_COMMAND|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))$/iu;

export interface HostGitResult { code: number; stdout: string; stderr: string }
export class HostGitError extends Error {
  constructor(readonly reason: "unavailable" | "held" | "timeout" | "output-limit" | "driver-name", message: string) { super(message); }
}

export interface HostGit {
  /** Runs one hardened git process. A non-zero exit is returned, never thrown; only a process that could not run or finish throws. */
  run(cwd: string, args: readonly string[], options?: { stdin?: string; drivers?: readonly string[] }): Promise<HostGitResult>;
  /** `-c` entries that switch off every filter and merge driver the repository's configuration names, and the filter drivers it marks required. */
  drivers(cwd: string): Promise<{ config: string[]; requiredFilters: string[] }>;
}

function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!DROPPED_ENV.test(key)) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** Every git call of a stage workspace goes through here: an argument vector with no shell, a timeout and a bounded output. */
export function createHostGit(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): HostGit {
  const env = gitEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

  function run(cwd: string, args: readonly string[], call: { stdin?: string; drivers?: readonly string[] } = {}): Promise<HostGitResult> {
    if (!isHostGitWorkspaceAvailable(cwd)) return Promise.reject(new HostGitError("held", "the workspace is held by a sandboxed command"));
    const configArgs = [...HARDENED_CONFIG.flatMap(entry => ["-c", entry]), ...(call.drivers ?? [])];
    return new Promise((resolve, reject) => {
      const child = spawn("git", buildHostGitArgs(args, { configArgs }), { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let failure: HostGitError | undefined;
      const stop = (error: HostGitError): void => { failure ??= error; child.kill(); };
      const timer = setTimeout(() => stop(new HostGitError("timeout", "git did not finish in time")), timeoutMs);
      const collect = (into: Buffer[]) => (chunk: Buffer): void => {
        size += chunk.length;
        if (size > GIT_MAX_OUTPUT_BYTES) stop(new HostGitError("output-limit", "git wrote more than the host reads"));
        else into.push(chunk);
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.on("error", (error) => { clearTimeout(timer); reject(new HostGitError("unavailable", error.message)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(call.stdin ?? "");
    });
  }

  async function drivers(cwd: string): Promise<{ config: string[]; requiredFilters: string[] }> {
    const listed = await run(cwd, ["config", "--null", "--get-regexp", "^(filter|merge)\\..*\\.(clean|smudge|process|required|driver)$"]);
    // Exit 1 with no output: nothing is configured.
    if (listed.code !== 0 && !(listed.code === 1 && listed.stdout === "")) throw new HostGitError("unavailable", "git configuration could not be read");
    const filters = new Set<string>();
    const merges = new Set<string>();
    const requiredFilters = new Set<string>();
    for (const entry of listed.stdout.split("\0")) {
      if (entry === "") continue;
      const [key = "", value = ""] = entry.split("\n", 2);
      const kind = key.slice(0, key.indexOf("."));
      const name = key.slice(kind.length + 1, key.lastIndexOf("."));
      const field = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
      // A name `-c` cannot carry would stay active.
      if (name === "" || /[=\n\r\0]/u.test(name)) throw new HostGitError("driver-name", "a configured driver name cannot be switched off");
      if (kind.toLowerCase() === "merge") merges.add(name);
      else {
        filters.add(name);
        if (field === "required" && /^(true|yes|on|1)$/iu.test(value.trim())) requiredFilters.add(name);
      }
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
