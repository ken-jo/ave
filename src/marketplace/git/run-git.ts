/**
 * `runGit` — every marketplace git call goes through here (design §9.3).
 *
 * The contract is the same for system and managed git:
 *
 *   - environment built from scratch: the safe baseline plus `SSH_AUTH_SOCK`,
 *     `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, the generated
 *     `GIT_CONFIG_GLOBAL`, `LC_ALL=C`, the askpass helper, ssh in batch mode,
 *     `GIT_ALLOW_PROTOCOL` (`https:ssh`, plus `http` only for policy-listed
 *     hosts) and `GIT_LFS_SKIP_SMUDGE=1`;
 *   - `-c` flags that turn off the file protocol, submodules, fsmonitor,
 *     hooks, redirects, LFS filters and automatic gc/maintenance (a pruned
 *     commit that an install still references could not be read again), and
 *     set the proxy the OS resolves for the remote;
 *   - a timeout, an abort signal and an output cap per call.
 *
 * A failure of a call that talks to a remote is classified into a
 * {@link MarketplaceError} code from git's (C-locale) stderr; any other
 * failure is a {@link GitCommandError} for the caller to interpret.
 */
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { proxyUrlFromPacEntry } from "../../shared/pac-proxy.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { terminateChildProcess } from "../../tools/terminate-child-process.js";
import { MarketplaceError, type MarketplaceErrorCode } from "../errors.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";
import type { AskpassBroker } from "./askpass.js";
import type { GitExecutable } from "./detect.js";

export const GIT_TIMEOUTS_MS = {
  lsRemote: 20_000,
  fetch: 120_000,
  export: 60_000,
  local: 30_000,
} as const;

const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitRemote {
  url: NormalizedSourceUrl;
  sourceId: string;
  /** Plain http is allowed for this host by `marketplaces.allowHttpHosts`. */
  allowHttp: boolean;
}

export interface RunGitOptions {
  cwd?: string;
  /** Set for calls that contact a remote; enables askpass, proxy and error classification. */
  remote?: GitRemote;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  /** Stream stdout here instead of buffering it (used by `git archive`). */
  onStdout?: (chunk: Buffer) => void;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
}

export interface GitRunnerOptions {
  git: GitExecutable;
  /** Generated file for `GIT_CONFIG_GLOBAL` (see global-config.ts). */
  globalConfigPath: string;
  /** An empty Ave-owned directory, used as `core.hooksPath` and `GIT_TEMPLATE_DIR`. */
  emptyDir: string;
  askpass: AskpassBroker;
  /** Managed copies: `GIT_EXEC_PATH`, CA bundle and similar (managed-git.ts). */
  managedEnv?: Record<string, string>;
  /** Managed copies: prepended to PATH so git finds its own helpers first. */
  managedPathPrefix?: string;
  /** Managed copies: settings the copy's own system config would carry (it is not read, §9.3). */
  managedConfig?: Readonly<Record<string, string>>;
  /** Chromium's PAC resolution for a URL (`session.resolveProxy`). */
  resolveProxy?: (url: string) => Promise<string>;
}

const REMOTE_FAILURES: ReadonlyArray<readonly [MarketplaceErrorCode, RegExp]> = [
  ["SOURCE_AUTH_REQUIRED", /authentication failed|could not read (username|password)|terminal prompts disabled|returned error: 40[13]|permission denied \(publickey|invalid username or password|http basic: access denied|access denied/u],
  ["SOURCE_SSH_HOST_UNKNOWN", /host key verification failed/u],
  ["SOURCE_REF_NOT_FOUND", /couldn't find remote ref|remote branch .* not found|no such ref was fetched/u],
];

const NOT_FOUND = /repository .* not found|returned error: 404|does not appear to be a git repository/u;

/**
 * Map a remote-call failure to its error code. A "repository not found"
 * after the broker offered a token means the token cannot see the
 * repository (hosts answer 404 rather than 403 to hide private
 * repositories), so it is an auth problem; without a credential it is a
 * wrong or unreachable URL.
 */
export function classifyRemoteFailure(stderr: string, credentialOffered: boolean): MarketplaceErrorCode {
  const text = stderr.toLowerCase();
  for (const [code, pattern] of REMOTE_FAILURES) {
    if (pattern.test(text)) return code;
  }
  if (NOT_FOUND.test(text)) return credentialOffered ? "SOURCE_AUTH_REQUIRED" : "SOURCE_UNREACHABLE";
  return "SOURCE_UNREACHABLE";
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export class GitRunner {
  constructor(private readonly options: GitRunnerOptions) {}

  get git(): GitExecutable {
    return this.options.git;
  }

  /** The `-c` flags every call carries, before the subcommand. */
  async configArgs(remote: GitRemote | undefined): Promise<string[]> {
    const proxy = await this.proxyFor(remote);
    return [
      "-c", "protocol.file.allow=never",
      "-c", "submodule.recurse=false",
      "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${this.options.emptyDir}`,
      "-c", "http.followRedirects=false",
      "-c", `http.proxy=${proxy}`,
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.process=",
      "-c", "filter.lfs.required=false",
      "-c", "gc.auto=0",
      "-c", "maintenance.auto=false",
      ...Object.entries(this.options.managedConfig ?? {}).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ];
  }

  /** The child environment for one call (without the askpass ticket). */
  environment(remote: GitRemote | undefined): Record<string, string> {
    const env = buildSafeChildEnv({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.options.globalConfigPath,
      LC_ALL: "C",
      GIT_ASKPASS: this.options.askpass.launcherPath,
      SSH_ASKPASS_REQUIRE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      GIT_ALLOW_PROTOCOL: remote?.allowHttp ? "https:ssh:http" : "https:ssh",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TEMPLATE_DIR: this.options.emptyDir,
    });
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    if (this.options.managedPathPrefix) {
      env.PATH = env.PATH ? `${this.options.managedPathPrefix}${delimiter}${env.PATH}` : this.options.managedPathPrefix;
    }
    return { ...env, ...this.options.managedEnv };
  }

  private async proxyFor(remote: GitRemote | undefined): Promise<string> {
    if (!remote || remote.url.scheme === "ssh" || !this.options.resolveProxy) return "";
    const pac = await this.options.resolveProxy(remote.url.url);
    return proxyUrlFromPacEntry(pac.split(";")[0] ?? "") ?? "";
  }

  async run(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    const remote = options.remote;
    const ticket = remote ? this.options.askpass.issueTicket({ host: remote.url.host, sourceId: remote.sourceId }) : null;
    try {
      const argv = [...(await this.configArgs(remote)), ...args];
      const env = { ...this.environment(remote), ...(ticket?.env ?? {}) };
      return await this.spawnGit(args[0] ?? "git", argv, env, options, () => ticket?.credentialOffered() ?? false);
    } finally {
      ticket?.revoke();
    }
  }

  private spawnGit(
    command: string,
    argv: string[],
    env: Record<string, string>,
    options: RunGitOptions,
    credentialOffered: () => boolean,
  ): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.options.git.path, argv, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let failure: Error | null = null;
      let settled = false;

      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        terminateChildProcess(child);
      };
      const timer = setTimeout(() => {
        stop(
          options.remote
            ? new MarketplaceError("SOURCE_UNREACHABLE", `git ${command} timed out after ${options.timeoutMs} ms`)
            : new GitCommandError(`git ${command} timed out after ${options.timeoutMs} ms`, null, stderr),
        );
      }, options.timeoutMs);
      const onAbort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (options.onStdout) {
          try {
            options.onStdout(chunk);
          } catch (error) {
            stop(error as Error);
          }
          return;
        }
        stdoutBytes += chunk.length;
        if (stdoutBytes > (options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES)) {
          stop(new GitCommandError(`git ${command} output exceeded the limit`, null, stderr));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });

      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        outcome();
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            error.code === "ENOENT"
              ? new MarketplaceError("GIT_RUNTIME_MISSING", `git executable not found: ${this.options.git.path}`, { cause: error })
              : error,
          ),
        );
      });
      child.on("close", (code) => {
        finish(() => {
          if (failure) {
            reject(failure);
            return;
          }
          if (code === 0) {
            resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
            return;
          }
          if (options.remote) {
            const errorCode = classifyRemoteFailure(stderr, credentialOffered());
            reject(new MarketplaceError(errorCode, `git ${command} failed: ${lastLine(stderr) || `exit ${code}`}`));
            return;
          }
          reject(new GitCommandError(`git ${command} failed: ${lastLine(stderr) || `exit ${code}`}`, code, stderr));
        });
      });
    });
  }
}
