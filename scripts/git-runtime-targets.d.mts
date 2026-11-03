// Type declarations for scripts/git-runtime-targets.mjs.
// Hand-written because source scripts consume the module before TS compile.

export interface GitRuntimeAsset {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface GitRuntimeLayout {
  readonly executable: string;
  /** `GIT_EXEC_PATH`. */
  readonly execPath: string;
  readonly httpsHelper: string;
  /** Prepended to PATH so the copy finds its own helpers first. */
  readonly pathPrefix: readonly string[];
  /** Linux: the roots the copy ships; the other platforms use the OS store. */
  readonly shippedCaBundle: string | null;
  /** Settings the copy's own system config would carry; that file is not read. */
  readonly config: Readonly<Record<string, string>>;
}

export const GIT_RUNTIME_VERSION: string;
export const GIT_RUNTIME_TARGETS: Readonly<Record<string, GitRuntimeAsset>>;
export const GIT_RUNTIME_MARKER: string;
export const GIT_RUNTIME_RESOURCE_DIR: string;

export function gitRuntimeTargetKey(platform: string, arch: string): string | null;
export function gitRuntimeLayout(root: string, platform: string): GitRuntimeLayout;
