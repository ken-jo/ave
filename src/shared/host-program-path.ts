import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export const HOST_PROGRAM_PATH_GUIDANCE = "Use an absolute path or a program name on PATH.";

export class HostProgramNotFoundError extends Error {
  readonly code = "HOST_PROGRAM_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "HostProgramNotFoundError";
  }
}

function isFullyQualified(entry: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(entry)
    : posix.isAbsolute(entry);
}

export function isRelativeHostProgram(program: string, platform: NodeJS.Platform = process.platform): boolean {
  return !isFullyQualified(program, platform) && (/[\\/]/u.test(program) || (platform === "win32" && program.includes(":")));
}

export function assertHostProgramNotRelative(program: string, platform: NodeJS.Platform = process.platform): void {
  if (isRelativeHostProgram(program, platform)) {
    throw new HostProgramNotFoundError(`Program '${program}' is a relative path. ${HOST_PROGRAM_PATH_GUIDANCE}`);
  }
}

interface WindowsDirectoryIdentity {
  readonly canonical: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

type ProgramFs = {
  statSync(path: string): { isFile(): boolean };
  lstatSync(path: string): { isSymbolicLink(): boolean };
  accessSync(path: string, mode: number): void;
  readonly windowsApps: WindowsDirectoryIdentity | null;
  pinWindowsDirectory(path: string): WindowsDirectoryIdentity | null;
};

function windowsVariable(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? "" : env[key] ?? "";
}

function searchPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return platform === "win32" ? windowsVariable(env, "PATH") : env.PATH ?? "";
}

function pinWindowsDirectory(path: string): WindowsDirectoryIdentity | null {
  try {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.ino === 0n) return null;
    // A junction or symlink anywhere in the supplied path can redirect the alias parent.
    for (let child = path, parent = win32.dirname(child); parent !== child; parent = win32.dirname(child)) {
      const ancestor = lstatSync(parent);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) return null;
      child = parent;
    }
    const canonical = realpathSync.native(path);
    const resolved = lstatSync(canonical, { bigint: true });
    if (!resolved.isDirectory() || resolved.isSymbolicLink() || entry.dev !== resolved.dev || entry.ino !== resolved.ino) return null;
    return { canonical, dev: entry.dev, ino: entry.ino };
  } catch {
    return null;
  }
}

function captureHostWindowsApps(): WindowsDirectoryIdentity | null {
  if (process.platform !== "win32") return null;
  const local = windowsVariable(process.env, "LOCALAPPDATA");
  return isFullyQualified(local, "win32") ? pinWindowsDirectory(win32.join(local, "Microsoft", "WindowsApps")) : null;
}

const hostFs: ProgramFs = { statSync, lstatSync, accessSync, pinWindowsDirectory, windowsApps: captureHostWindowsApps() };

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return searchPath(env, platform)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => (platform === "win32" ? entry.trim().replace(/^"(.*)"$/u, "$1") : entry))
    // Empty, "." and relative entries name the current directory; only fully qualified ones are searched.
    .filter((entry) => isFullyQualified(entry, platform));
}

function runnableProgramPath(candidate: string, platform: NodeJS.Platform, fs: ProgramFs): string | null {
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    if (platform !== "win32") fs.accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    const trusted = fs.windowsApps;
    if (platform !== "win32" || trusted === null || !isLink(candidate, fs)) return null;
    const parent = fs.pinWindowsDirectory(win32.dirname(candidate));
    // Use the startup account directory's canonical spelling, including when PATH uses an 8.3 name.
    return parent?.dev === trusted.dev && parent.ino === trusted.ino && parent.canonical.toLowerCase() === trusted.canonical.toLowerCase()
      ? win32.join(trusted.canonical, win32.basename(candidate)) : null;
  }
}

function isLink(candidate: string, fs: ProgramFs): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/** An absolute program stays as given; a bare name is looked up on PATH only, never in a current directory. */
export function findHostProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: ProgramFs = hostFs,
): string | null {
  if (program === "" || program.includes("\0")) return null;
  if (isFullyQualified(program, platform)) return program;
  if (isRelativeHostProgram(program, platform)) return null;
  const paths = platform === "win32" ? win32 : posix;
  // Windows launches only .com and .exe images without a shell; an explicit extension is tried as written first.
  const names = platform === "win32"
    ? [...(win32.extname(program) ? [program] : []), `${program}.com`, `${program}.exe`]
    : [program];
  for (const entry of pathEntries(env, platform)) {
    for (const name of names) {
      const candidate = runnableProgramPath(paths.join(entry, name), platform, fs);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

export function resolveHostProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const found = findHostProgram(program, env, platform);
  if (found !== null) return found;
  assertHostProgramNotRelative(program, platform);
  throw new HostProgramNotFoundError(`Program '${program}' was not found on PATH`);
}
