/**
 * The git runtime as one service (design §9.1, §9.2, §15.7): what is detected
 * under the configured mode, and the managed install with its progress.
 */
import { join } from "node:path";
import type { GitRuntimeMode } from "../../shared/git-runtime-mode.js";
import type { GitRuntimeProgress, GitRuntimeStatus } from "../../shared/git-runtime.js";
import { isMarketplaceError } from "../errors.js";
import { detectGitRuntime, nodeGitDetectionDeps, type GitDetectionDeps, type ManagedGitInstall } from "./detect.js";
import { findManagedGit, installManagedGit } from "./managed-git.js";
import { MANAGED_GIT, type ManagedGitPins } from "./managed-git-pins.js";

export interface GitRuntimeServiceOptions {
  /** `~/.ave/runtime/git`. */
  runtimeRoot: string;
  mode: () => GitRuntimeMode;
  /** The gated, PAC-aware download (§7.4). */
  download: (url: string, signal?: AbortSignal) => Promise<Response>;
  onProgress: (progress: GitRuntimeProgress) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  pins?: ManagedGitPins;
  detectionDeps?: (findManaged: () => Promise<ManagedGitInstall | null>) => GitDetectionDeps;
}

export function gitRuntimeRoot(aveHomeDir: string): string {
  return join(aveHomeDir, "runtime", "git");
}

export class GitRuntimeService {
  private lastInstallError: GitRuntimeStatus["lastInstallError"] = null;

  constructor(private readonly options: GitRuntimeServiceOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get pins(): ManagedGitPins {
    return this.options.pins ?? MANAGED_GIT;
  }

  async status(): Promise<GitRuntimeStatus> {
    const findManaged = () => findManagedGit(this.options.runtimeRoot, this.platform, this.pins);
    const mode = this.options.mode();
    const detection = await detectGitRuntime(mode, (this.options.detectionDeps ?? nodeGitDetectionDeps)(findManaged));
    const managed = await findManaged();
    const asset: { size: number } | undefined = this.pins.assets[`${this.platform}-${this.options.arch ?? process.arch}`];
    return {
      mode,
      state: detection.state,
      active: detection.state === "ready"
        ? { kind: detection.git.kind, version: detection.git.version.text, path: detection.git.path }
        : null,
      systemTooOld: detection.systemTooOld ?? null,
      managed: {
        version: this.pins.version,
        installed: managed !== null,
        available: asset !== undefined,
        size: asset?.size ?? null,
      },
      lastInstallError: this.lastInstallError,
    };
  }

  /** Install (or repair) the managed copy, then report the status. A failure is part of the status. */
  async install(signal?: AbortSignal): Promise<GitRuntimeStatus> {
    try {
      await installManagedGit({
        runtimeRoot: this.options.runtimeRoot,
        download: this.options.download,
        platform: this.platform,
        ...(this.options.arch ? { arch: this.options.arch } : {}),
        pins: this.pins,
        onProgress: this.options.onProgress,
        ...(signal ? { signal } : {}),
      });
      this.lastInstallError = null;
    } catch (error) {
      if (!isMarketplaceError(error)) throw error;
      this.lastInstallError = { code: error.code, message: error.message };
    }
    return this.status();
  }
}
