import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export class HostProgramNotFoundError extends Error {
  readonly code = "HOST_PROGRAM_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "HostProgramNotFoundError";
  }
}

function isFullyQualified(entry: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(entry)
    : posix.isAbsolute(entry);
}

type ProgramFs = {
  statSync(path: string): { isFile(): boolean };
  lstatSync(path: string): { isSymbolicLink(): boolean };
  accessSync(path: string, mode: number): void;
};

const hostFs: ProgramFs = { statSync, lstatSync, accessSync };

function windowsVariable(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? "" : env[key] ?? "";
}

function searchPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return platform === "win32" ? windowsVariable(env, "PATH") : env.PATH ?? "";
}

// The one folder whose app execution aliases launch although their targets cannot be stat'ed.
function windowsAppsFolder(env: NodeJS.ProcessEnv): string | null {
  const local = windowsVariable(env, "LOCALAPPDATA");
  return isFullyQualified(local, "win32") ? win32.join(local, "Microsoft", "WindowsApps").toLowerCase() : null;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return searchPath(env, platform)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => (platform === "win32" ? entry.trim().replace(/^"(.*)"$/u, "$1") : entry))
    // Empty, "." and relative entries name the current directory; only fully qualified ones are searched.
    .filter((entry) => isFullyQualified(entry, platform));
}

function runnable(candidate: string, platform: NodeJS.Platform, aliases: string | null, fs: ProgramFs): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return platform === "win32" && aliases !== null && win32.dirname(candidate).toLowerCase() === aliases && isLink(candidate, fs);
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
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(program)) return program;
  if (/[\\/]/u.test(program) || (platform === "win32" && program.includes(":"))) return null;
  // Windows launches only .com and .exe images without a shell; an explicit extension is tried as written first.
  const names = platform === "win32"
    ? [...(win32.extname(program) ? [program] : []), `${program}.com`, `${program}.exe`]
    : [program];
  const aliases = platform === "win32" ? windowsAppsFolder(env) : null;
  for (const entry of pathEntries(env, platform)) {
    for (const name of names) {
      const candidate = paths.join(entry, name);
      if (runnable(candidate, platform, aliases, fs)) return candidate;
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
  throw new HostProgramNotFoundError(
    /[\\/]/u.test(program) || (platform === "win32" && program.includes(":"))
      ? `Program '${program}' is a relative path; use an absolute path or a program name on PATH`
      : `Program '${program}' was not found on PATH`,
  );
}
