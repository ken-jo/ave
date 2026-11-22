/** Keeps an isolated runner until invalidated by a runtime change. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverHostGitAsync, type GitDiscovery, withHostGitRecovery } from "../../shared/host-git-executable.js";
import { MarketplaceError } from "../errors.js";
import { AskpassBroker } from "./askpass.js";
import { installerRunnerOptions } from "./installer-git.js";
import { classifyGitDiscovery, type GitExecutable } from "./detect.js";
import { readCopiedCredentialConfig, writeGeneratedGlobalConfig, type CopiedConfigEntry } from "./global-config.js";
import { GitRunner, type GitCommands, type GitRemote, type GitRunnerOptions } from "./run-git.js";

export interface MarketplaceGitOptions {
  envRoot: string;
  /** {@link installerGitRoot}; null where no installer provides git. */
  installerRoot: string | null;
  getToken: (host: string, sourceId: string) => Promise<string | null>;
  resolveProxy?: GitRunnerOptions["resolveProxy"];
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
  private built: { git: NonNullable<GitDiscovery["git"]>; result: Promise<BuiltRunner> } | null = null;
  private closed = false;

  constructor(private readonly options: MarketplaceGitOptions) {}

  private askpass(): Promise<AskpassBroker> {
    this.broker ??= AskpassBroker.start({ getToken: this.options.getToken, parentDir: this.options.envRoot }).catch((error: unknown) => {
      this.broker = null;
      throw error;
    });
    return this.broker;
  }

  private requireGit(discovery: GitDiscovery): GitExecutable {
    const detection = classifyGitDiscovery(discovery);
    if (detection.state === "ready") return detection.git;
    if (detection.systemTooOld) {
      throw new MarketplaceError(
        "GIT_RUNTIME_TOO_OLD",
        `system git ${detection.systemTooOld.version} at ${detection.systemTooOld.path} is older than the minimum, and no installer git is usable`,
      );
    }
    throw new MarketplaceError("GIT_RUNTIME_MISSING", "no usable git was found: no installer git is usable and no system git is installed");
  }

  private async build(git: GitExecutable): Promise<BuiltRunner> {
    await mkdir(this.options.envRoot, { recursive: true, mode: 0o700 });
    const emptyDir = join(this.options.envRoot, "empty");
    await mkdir(emptyDir, { recursive: true });
    const globalConfigPath = join(this.options.envRoot, "gitconfig");
    const installed = git.kind === "installer" ? installerRunnerOptions(git.installer) : {};
    const copied = await readCopiedCredentialConfig(git.path, installed.installerEnv);
    await writeGeneratedGlobalConfig(globalConfigPath, copied);
    const runner = new GitRunner({
      git,
      globalConfigPath,
      emptyDir,
      askpass: await this.askpass(),
      ...installed,
      ...(this.options.resolveProxy ? { resolveProxy: this.options.resolveProxy } : {}),
    });
    return { runner, copied };
  }

  private async current(discovery: GitDiscovery): Promise<BuiltRunner> {
    if (this.closed) throw new Error("the marketplace git runtime is closed");
    const previous = this.built;
    if (previous && previous.git === discovery.git) return previous.result;
    this.built = null;
    const git = this.requireGit(discovery);
    const result = Promise.resolve(previous?.result).catch(() => undefined).then(() => this.build(git));
    const built = { git: discovery.git!, result };
    this.built = built;
    try {
      return await result;
    } catch (error) {
      if (this.built === built) this.built = null;
      throw error;
    }
  }

  async runner(): Promise<GitRunner> {
    return (await this.current(await discoverHostGitAsync(this.options.installerRoot))).runner;
  }

  /** Resolve the current runner per command while retaining the syncer and its source locks. */
  readonly commands: GitCommands = {
    run: (args, options) => withHostGitRecovery(this.options.installerRoot, async (discovery) =>
      (await this.current(discovery)).runner.run(args, options)),
  };

  async preflight(remote: GitRemote): Promise<void> {
    await (await this.runner()).preflight(remote);
  }

  /** A generic helper or a matching per-host helper counts as available credentials. */
  async credentialHelperFor(host: string): Promise<boolean> {
    const { copied } = await this.current(await discoverHostGitAsync(this.options.installerRoot));
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
