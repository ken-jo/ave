// Type declarations for scripts/build-macos-dir-ops.mjs (plain JS: it runs at build, test:prepare, pre-push and beforePack).
export const MACOS_DIR_OPS_EXECUTABLE: string;
/** The test-only variants and the preprocessor definitions that select each one's write fault. */
export const MACOS_DIR_OPS_TEST_BUILDS: ReadonlyArray<{ readonly executable: string; readonly defines: readonly string[] }>;
/** Where the arm64 executable is built under the repository root. */
export function macosDirOpsOutput(root: string, arch: "arm64", executable?: string): string;
/** Build the helper (and with `testBuilds` its variants); with `ifStale`, only missing or stale ones, and nothing off macOS. Returns what was built. */
export function buildMacosDirOps(options?: {
  root?: string;
  /** Rejects any value other than arm64 on macOS. */
  arch?: string;
  ifStale?: boolean;
  testBuilds?: boolean;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  spawn?: (command: string, args: string[], options: object) => { status: number | null; error?: Error };
}): string[];
