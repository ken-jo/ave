// Type declarations for scripts/prepare-windows-job.mjs (plain JS: it runs at test:prepare and pre-push).
export type WindowsJobLauncherState =
  | { state: "skip" | "missing" | "fresh"; launcher: string }
  | { state: "stale"; launcher: string; newer: string };
/** The launcher path the app resolves, relative to the repository root. */
export function windowsJobLauncherPath(arch?: string): string;
/** The build script and every file under native/windows-job/, relative to `root`. */
export function windowsJobSources(root: string): string[];
/** Whether the launcher under `root` is missing, older than a source, or fresh; `skip` off Windows. */
export function windowsJobLauncherState(
  root: string,
  options?: { platform?: NodeJS.Platform; arch?: string },
): WindowsJobLauncherState;
/** Whether vswhere reports an installation with the MSVC x86/x64 tools. */
export function hasCppBuildTools(options?: {
  programFilesX86?: string;
  exists?: (path: string) => boolean;
  runSync?: (command: string, args: string[], options: object) => { status: number | null; stdout?: unknown };
}): boolean;
export function missingBuildToolsMessage(launcher: string): string;
/** Build each native helper when missing or stale; return the original job launcher state. */
export function prepareWindowsJob(options?: {
  root?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  findBuildTools?: () => boolean;
  runSync?: (command: string, args: string[], options: object) => { status: number | null; error?: Error };
  log?: (line: string) => void;
}): WindowsJobLauncherState;
