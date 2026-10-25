/** Keeps an isolated runner until invalidated by a runtime change or managed install. */
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
  envRoot: string;
  runtimeRoot: string;
  mode: () => GitRuntimeMode;
  getToken: (host: string, sourceId: string) => string | null;
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

  async runner(): Promise<GitRunner> {
    return (await this.current()).runner;
  }

  /** Resolve the current runner per command while retaining the syncer and its source locks. */
  readonly commands: GitCommands = {
    run: async (args, options) => (await this.runner()).run(args, options),
  };

  async preflight(remote: GitRemote): Promise<void> {
    await (await this.runner()).preflight(remote);
  }

  /** A generic helper or a matching per-host helper counts as available credentials. */
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
