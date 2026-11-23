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

function searchPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : env[key] ?? "";
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return searchPath(env, platform)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => (platform === "win32" ? entry.trim().replace(/^"(.*)"$/u, "$1") : entry))
    // Empty, "." and relative entries name the current directory; only fully qualified ones are searched.
    .filter((entry) => isFullyQualified(entry, platform));
}

function runnable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // Windows app execution aliases are links whose targets this account cannot stat, yet they launch.
    return platform === "win32" && lstatExists(candidate);
  }
}

function lstatExists(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/** An absolute program stays as given; a bare name is looked up on PATH only, never in a current directory. */
export function findHostProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (program === "" || program.includes("\0")) return null;
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(program)) return program;
  if (/[\\/]/u.test(program) || (platform === "win32" && program.includes(":"))) return null;
  // Windows launches only .com and .exe images without a shell; an explicit extension is tried as written first.
  const names = platform === "win32"
    ? [...(win32.extname(program) ? [program] : []), `${program}.com`, `${program}.exe`]
    : [program];
  for (const entry of pathEntries(env, platform)) {
    for (const name of names) {
      const candidate = paths.join(entry, name);
      if (runnable(candidate, platform)) return candidate;
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
      ? `Program '${program}' must be a bare name or an absolute path`
      : `Program '${program}' was not found on PATH`,
  );
}
