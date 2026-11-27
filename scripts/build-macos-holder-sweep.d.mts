export interface MacosHolderSweepBuild {
  readonly binarySha256: string;
  readonly imageSha256: string;
  readonly helper: string;
}
export declare const MACOS_HOLDER_SWEEP_EXECUTABLE: string;
export declare const MACOS_HOLDER_SWEEP_NEVER_SIGNALS: string;
export declare function macosHolderSweepOutput(root: string, arch: string, executable?: string): string;
export declare function macosHolderSweepToolchain(root: string): string;
export declare function macosHolderSweepCargoArgs(manifest: string, targetDir: string, features?: readonly string[]): string[];
export declare function buildMacosHolderSweep(options?: {
  root?: string; arch?: string; ifStale?: boolean; testBuilds?: boolean; platform?: NodeJS.Platform;
  log?: (line: string) => void; spawn?: typeof import("node:child_process").spawnSync; env?: NodeJS.ProcessEnv;
}): MacosHolderSweepBuild | null;
