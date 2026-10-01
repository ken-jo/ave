/**
 * The git every marketplace call runs (design §9.1, §9.3), as one object.
 *
 * The configured mode picks the executable. For it this builds the
 * generated global config (only the credential and TLS entries copied from
 * the user's system and global config), the Ave-owned empty directory, the
 * askpass broker that answers with stored tokens and, for a managed copy,
 * its environment. The runner is kept until `invalidate()`: a mode change or
 * a managed install calls it, and the next call detects again.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitRuntimeMode } from "../../shared/git-runtime-mode.js";
import { MarketplaceError } from "../errors.js";
import { AskpassBroker } from "./askpass.js";
import { detectGitRuntime, nodeGitDetectionDeps, type GitDetectionDeps, type GitExecutable, type ManagedGitInstall } from "./detect.js";
import { readCopiedCredentialConfig, writeGeneratedGlobalConfig, type CopiedConfigEntry } from "./global-config.js";
import { findManagedGit, managedRunnerOptions } from "./managed-git.js";
import { MANAGED_GIT, type ManagedGitPins } from "./managed-git-pins.js";
import { GitRunner, type GitCommands, type GitRemote, type GitRunnerOptions } from "./run-git.js";

export interface MarketplaceGitOptions {
  /** Holds the generated global config and the empty directory. */
  envRoot: string;
  /** `~/.ave/runtime/git`, where managed copies live. */
  runtimeRoot: string;
  mode: () => GitRuntimeMode;
  /** The token for a normalized host and source, read at each prompt (see AskpassBrokerOptions.getToken). */
  getToken: (host: string, sourceId: string) => string | null;
  /** Corporate roots added to a managed copy's CA bundle; null when there are none. */
  corporateRootsPem: () => Promise<string | null>;
  resolveProxy?: GitRunnerOptions["resolveProxy"];
  platform?: NodeJS.Platform;
  pins?: ManagedGitPins;
  detectionDeps?: (findManaged: () => Promise<ManagedGitInstall | null>) => GitDetectionDeps;
}

interface BuiltRunner {
  runner: GitRunner;
  copied: readonly CopiedConfigEntry[];
}

/** A copied entry that names a credential helper: `credential.helper` or `credential.<url>.helper`. */
function isHelperEntry(entry: CopiedConfigEntry): boolean {
  return entry.value !== "" && (entry.key === "credential.helper" || (entry.key.startsWith("credential.") && entry.key.endsWith(".helper")));
}

export class MarketplaceGit {
  private broker: Promise<AskpassBroker> | null = null;
  private built: Promise<BuiltRunner> | null = null;
  private closed = false;

  constructor(private readonly options: MarketplaceGitOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private askpass(): Promise<AskpassBroker> {
    this.broker ??= AskpassBroker.start({ getToken: this.options.getToken, parentDir: this.options.envRoot }).catch((error: unknown) => {
      this.broker = null;
      throw error;
    });
    return this.broker;
  }

  private async detect(): Promise<GitExecutable> {
    const pins = this.options.pins ?? MANAGED_GIT;
    const findManaged = () => findManagedGit(this.options.runtimeRoot, this.platform, pins);
    const detection = await detectGitRuntime(this.options.mode(), (this.options.detectionDeps ?? nodeGitDetectionDeps)(findManaged));
    if (detection.state === "too-old") {
      throw new MarketplaceError(
        "GIT_RUNTIME_TOO_OLD",
        `system git ${detection.systemTooOld.version} at ${detection.systemTooOld.path} is older than the minimum; switch to Auto or Managed`,
      );
    }
    if (detection.state === "missing") throw new MarketplaceError("GIT_RUNTIME_MISSING", "no usable git was found; install the managed git");
    return detection.git;
  }

  private async build(): Promise<BuiltRunner> {
    const git = await this.detect();
    await mkdir(this.options.envRoot, { recursive: true, mode: 0o700 });
    const emptyDir = join(this.options.envRoot, "empty");
    await mkdir(emptyDir, { recursive: true });
    const globalConfigPath = join(this.options.envRoot, "gitconfig");
    const copied = await readCopiedCredentialConfig(git.path);
    await writeGeneratedGlobalConfig(globalConfigPath, copied);
    const managed = git.kind === "managed"
      ? await managedRunnerOptions(
          { path: git.path, root: git.managedRoot!, version: git.version },
          this.platform,
          await this.options.corporateRootsPem(),
        )
      : {};
    const runner = new GitRunner({
      git,
      globalConfigPath,
      emptyDir,
      askpass: await this.askpass(),
      ...managed,
      ...(this.options.resolveProxy ? { resolveProxy: this.options.resolveProxy } : {}),
    });
    return { runner, copied };
  }

  private current(): Promise<BuiltRunner> {
    if (this.closed) return Promise.reject(new Error("the marketplace git runtime is closed"));
    this.built ??= this.build().catch((error: unknown) => {
      // Nothing is cached for a failed detection: installing git fixes it without a restart.
      this.built = null;
      throw error;
    });
    return this.built;
  }

  /** The runner for the detected git; GIT_RUNTIME_MISSING or GIT_RUNTIME_TOO_OLD when there is none. */
  async runner(): Promise<GitRunner> {
    return (await this.current()).runner;
  }

  /**
   * One object for the syncer and every repository: each command runs on the
   * runner detected at that moment, so installing git or changing the mode
   * needs no new syncer (whose per-source locks must outlive the switch).
   */
  readonly commands: GitCommands = {
    run: async (args, options) => (await this.runner()).run(args, options),
  };

  /** The address check of a remote, without a git command (see {@link GitRunner.preflight}). */
  async preflight(remote: GitRemote): Promise<void> {
    await (await this.runner()).preflight(remote);
  }

  /**
   * Whether an OS credential helper will answer for `host` (design §9.3,
   * §15.5): a copied `credential.helper`, or a `credential.<url>.helper`
   * whose URL names the host.
   */
  async credentialHelperFor(host: string): Promise<boolean> {
    const { copied } = await this.current();
    return copied.some((entry) => {
      if (!isHelperEntry(entry)) return false;
      if (entry.key === "credential.helper") return true;
      const url = entry.key.slice("credential.".length, -".helper".length);
      try {
        return new URL(url).hostname.toLowerCase() === host;
      } catch {
        return false;
      }
    });
  }

  /** Detect again on the next call (mode changed, managed git installed). */
  invalidate(): void {
    this.built = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.built = null;
    const broker = this.broker;
    this.broker = null;
    if (broker) await (await broker).close();
  }
}
