/**
 * `runGit` — every marketplace git call goes through here (design §9.3).
 *
 * The contract is the same for system and managed git:
 *
 *   - environment built from scratch: the safe baseline plus `SSH_AUTH_SOCK`,
 *     `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, the generated
 *     `GIT_CONFIG_GLOBAL`, `LC_ALL=C`, the askpass helper, ssh in batch mode,
 *     `GIT_ALLOW_PROTOCOL` (`https:ssh`, plus `http` only for policy-listed
 *     hosts; none for a call without a remote), `GIT_LFS_SKIP_SMUDGE=1` and `GIT_NO_LAZY_FETCH=1` (a missing
 *     object is an error, never a fetch the gate did not see), and `GIT_DIR`
 *     for a call on a repository (discovery stopped otherwise);
 *   - `-c` flags that turn off the file protocol, submodules, fsmonitor,
 *     hooks, redirects, LFS filters and automatic gc/maintenance (a pruned
 *     commit that an install still references could not be read again), set
 *     the proxy the OS resolves for the remote, and clear the user's credential
 *     helpers on a call that answers with a stored token;
 *   - a timeout, an abort signal and an output cap per call.
 *
 * A failure of a call that talks to a remote is classified into a
 * {@link MarketplaceError} code from git's (C-locale) stderr; any other
 * failure is a {@link GitCommandError} for the caller to interpret.
 */
import type { ChildProcessByStdio } from "node:child_process";
import { delimiter, dirname } from "node:path";
import type { Readable } from "node:stream";
import { proxyUrlFromPacEntry } from "../../shared/pac-proxy.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { forceKillManagedChildProcess, spawnManaged } from "../../main/managed-child-processes.js";
import { MarketplaceError, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../errors.js";
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
/** How long git gets to remove its lock files after SIGTERM before its group is killed. */
const FORCE_KILL_AFTER_MS = 2_000;

/**
 * The repository a call works on (`gitDir`) is not one git can open, as a
 * half-removed copy leaves it: the local copy is damaged, whatever the
 * remote's state, so it is never read as a network failure. Not a
 * {@link GitCommandError}, so no caller reads it as an ordinary "no".
 */
export class LocalRepositoryDamagedError extends Error {
  constructor(
    message: string,
    readonly gitDir: string,
  ) {
    super(message);
    this.name = "LocalRepositoryDamagedError";
  }
}

/** git's refusal to open `GIT_DIR` (C locale). */
const LOCAL_REPOSITORY_BROKEN = /not a git repository/u;

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
  /**
   * The source declares token auth for this host. When a token is stored for
   * it, askpass answers with that token and the user's credential helpers are
   * switched off for the call, so git neither asks them first nor stores the
   * token in them. Without a stored token the helpers answer as usual.
   */
  useToken: boolean;
}

export interface RunGitOptions {
  /**
   * The repository the call works on, passed as `GIT_DIR` so git never
   * discovers another one by walking up from a directory. Without it the call
   * runs in the empty directory with discovery stopped there.
   */
  gitDir?: string;
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

/**
 * The host's "no repository here": GitHub over https ("repository '…' not
 * found") and ssh ("ERROR: Repository not found."), GitLab's "could not be
 * found or you don't have permission", a plain 404, and a path that is not a
 * repository. Hosts answer this way for a private repository the caller
 * cannot see as well, so it never says which of the two it is.
 */
const NOT_FOUND = /repository .* not found|repository not found|could not be found or you don't have permission|returned error: 404|does not appear to be a git repository/u;

/** OpenSSH's banner for a key that differs from the one in known_hosts, before "host key verification failed". */
const HOST_KEY_CHANGED = /remote host identification has changed|host key for .* has changed/u;

/**
 * Why git could not reach the remote, from curl's and ssh's (C-locale)
 * messages, in the order that keeps one cause from reading as another:
 * "network is unreachable" also follows "failed to connect", and a timeout
 * is reported on the same line as the address it was connecting to.
 */
const UNREACHABLE_REASONS: ReadonlyArray<readonly ["offline" | "dns" | "timeout" | "refused" | "tls", RegExp]> = [
  ["offline", /network is unreachable/u],
  ["dns", /could not resolve host|could not resolve hostname|name or service not known|nodename nor servname provided|temporary failure in name resolution|no such host is known/u],
  ["timeout", /timed out|timeout was reached/u],
  ["refused", /connection refused|couldn't connect to server|failed to connect to|connection reset by peer|no route to host/u],
  ["tls", /ssl certificate problem|server certificate verification failed|certificate verify failed|unable to get local issuer certificate|self[- ]signed certificate|sec_e_untrusted_root|ssl: no alternative certificate subject name/u],
];

const HTTP_STATUS = /returned error: (\d{3})/u;

/** `ssh://host` without a port is port 22, the one ssh and known_hosts use. */
function sshPort(url: NormalizedSourceUrl): number {
  return url.port ?? 22;
}

function unreachableDetail(text: string, host: string): MarketplaceErrorDetail<"SOURCE_UNREACHABLE"> | undefined {
  for (const [reason, pattern] of UNREACHABLE_REASONS) {
    if (!pattern.test(text)) continue;
    return reason === "offline" ? { reason } : { reason, host };
  }
  const status = HTTP_STATUS.exec(text);
  return status ? { reason: "http-status", host, status: Number(status[1]) } : undefined;
}

/**
 * Map a remote-call failure to its error, with the detail its sentence
 * needs when git's message says why (design §18.8). A "repository not found"
 * after the broker offered a token means the token may not reach the
 * repository (hosts answer 404 rather than 403 to hide private
 * repositories): `SOURCE_AUTH_REQUIRED` `token-no-access`. Without a token
 * from Ave it is `SOURCE_UNREACHABLE` `not-found` (`not-found-ssh` over
 * ssh), whose sentence names both a wrong address and a private repository,
 * since the answer is the same for both. A failure whose cause git does not
 * name carries no detail and reads as its code's reason-less sentence.
 */
export function classifyRemoteFailure(stderr: string, credentialOffered: boolean, url: NormalizedSourceUrl, message: string): MarketplaceError {
  const text = stderr.toLowerCase();
  const host = url.host;
  for (const [code, pattern] of REMOTE_FAILURES) {
    if (!pattern.test(text)) continue;
    switch (code) {
      case "SOURCE_AUTH_REQUIRED":
        return new MarketplaceError(code, message, { detail: { reason: url.scheme === "ssh" ? "ssh" : "token", host } });
      case "SOURCE_SSH_HOST_UNKNOWN":
        return new MarketplaceError(code, message, { detail: { reason: HOST_KEY_CHANGED.test(text) ? "changed" : "unknown", host, port: sshPort(url) } });
      default:
        return new MarketplaceError(code, message);
    }
  }
  if (NOT_FOUND.test(text)) {
    if (url.scheme === "ssh") return new MarketplaceError("SOURCE_UNREACHABLE", message, { detail: { reason: "not-found-ssh", host } });
    return credentialOffered
      ? new MarketplaceError("SOURCE_AUTH_REQUIRED", message, { detail: { reason: "token-no-access", host } })
      : new MarketplaceError("SOURCE_UNREACHABLE", message, { detail: { reason: "not-found", host } });
  }
  const detail = unreachableDetail(text, host);
  return new MarketplaceError("SOURCE_UNREACHABLE", message, detail ? { detail } : undefined);
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** What a repository needs from a runner: running one command. */
export type GitCommands = Pick<GitRunner, "run">;

export class GitRunner {
  constructor(private readonly options: GitRunnerOptions) {}

  get git(): GitExecutable {
    return this.options.git;
  }

  /** The `-c` flags every call carries, before the subcommand. */
  /** The call answers with the stored token (see {@link GitRemote.useToken}). */
  private offersToken(remote: GitRemote | undefined): remote is GitRemote {
    return remote !== undefined && remote.useToken && this.options.askpass.hasToken(remote.url.host, remote.sourceId);
  }

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
      // Read last, an empty value clears every helper configured before it.
      ...(this.offersToken(remote) ? ["-c", "credential.helper="] : []),
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
      // A call without a remote needs no transport; `none` names none, so even
      // a git that ignored GIT_NO_LAZY_FETCH could not fetch on its own.
      GIT_ALLOW_PROTOCOL: !remote ? "none" : remote.allowHttp ? "https:ssh:http" : "https:ssh",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_LAZY_FETCH: "1",
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
    const entry = (pac.split(";")[0] ?? "").trim();
    const [kind, endpoint] = entry.split(/\s+/u, 2);
    if (!kind || kind.toUpperCase() === "DIRECT") return "";
    // PAC's `SOCKS` is SOCKS4, which git's transport (curl) speaks; the shared
    // mapping leaves it out for subprocesses that do not.
    const kindUpper = kind.toUpperCase();
    const proxy = (kindUpper === "SOCKS" || kindUpper === "SOCKS4") && endpoint ? `socks4://${endpoint}` : proxyUrlFromPacEntry(entry);
    // Going direct would send the traffic where the configuration did not choose.
    if (!proxy) {
      throw new MarketplaceError("SOURCE_UNREACHABLE", `the system proxy for ${remote.url.host} (${entry}) is not one git can use`, {
        detail: { reason: "proxy", host: remote.url.host, proxy: entry },
      });
    }
    return proxy;
  }

  async run(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    const remote = options.remote;
    const ticket = this.offersToken(remote) ? this.options.askpass.issueTicket({ host: remote.url.host, sourceId: remote.sourceId }) : null;
    try {
      const argv = [...(await this.configArgs(remote)), ...args];
      const env = {
        ...this.environment(remote),
        ...(options.gitDir ? { GIT_DIR: options.gitDir } : { GIT_CEILING_DIRECTORIES: dirname(this.options.emptyDir) }),
        ...(ticket?.env ?? {}),
      };
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
      // git runs its transport in a child (git-remote-https) that holds the
      // output pipes, so a stop has to reach the whole tree or `close` never
      // comes. On POSIX git leads its own process group; the app's shutdown
      // sweep kills that group too.
      const child = spawnManaged(
        this.options.git.path,
        argv,
        {
          cwd: options.gitDir ?? this.options.emptyDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        },
        { label: "marketplace-git" },
      ) as ChildProcessByStdio<null, Readable, Readable>;
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let failure: Error | null = null;
      let settled = false;

      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          // The group is gone.
        }
      };
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        if (process.platform === "win32") {
          // TerminateProcess leaves no cleanup either way; taskkill /T takes the tree.
          forceKillManagedChildProcess(child, `marketplace git ${command} stopped`);
          return;
        }
        // SIGTERM first so git removes its lock files, then the whole group.
        signalGroup("SIGTERM");
        setTimeout(() => {
          if (!settled) signalGroup("SIGKILL");
        }, FORCE_KILL_AFTER_MS).unref();
      };
      const timer = setTimeout(() => {
        stop(
          options.remote
            ? new MarketplaceError("SOURCE_UNREACHABLE", `git ${command} timed out after ${options.timeoutMs} ms`, {
                detail: { reason: "timeout", host: options.remote.url.host },
              })
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
          // Checked before the remote's classification: a fetch into a broken repository is not a network failure.
          if (options.gitDir && LOCAL_REPOSITORY_BROKEN.test(stderr.toLowerCase())) {
            reject(new LocalRepositoryDamagedError(`git ${command} failed: ${lastLine(stderr) || `exit ${code}`}`, options.gitDir));
            return;
          }
          if (options.remote) {
            reject(classifyRemoteFailure(stderr, credentialOffered(), options.remote.url, `git ${command} failed: ${lastLine(stderr) || `exit ${code}`}`));
            return;
          }
          reject(new GitCommandError(`git ${command} failed: ${lastLine(stderr) || `exit ${code}`}`, code, stderr));
        });
      });
    });
  }
}
