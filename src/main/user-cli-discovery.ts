// Desktop launches may omit provider install directories from PATH; list fully qualified PATH entries and standard install locations.
import { posix, win32 } from "node:path";

const MAX_PATH_LENGTH = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface CliDiscoveryEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

export function cliPathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

// Reject device namespaces and drive-relative Windows paths; candidates must not depend on cwd.
export function fullyQualifiedCliPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(value);
  if (/^[\\/]{2}[?.][\\/]/.test(value)) return false;
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
}

// A directory value from the environment, or null when it cannot be trusted as one.
export function usableCliDirectory(value: string | undefined, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string") return null;
  const trimmed = platform === "win32" ? value.trim().replace(/^"(.*)"$/, "$1") : value;
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(trimmed)) return null;
  return fullyQualifiedCliPath(trimmed, platform) ? trimmed : null;
}

// Windows environment names are case-insensitive.
export function cliEnvironmentValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// Candidates, most specific first: each PATH entry joined with each file name the CLI goes by on this platform, then `installLocations` in the order
// given. Relative PATH entries are skipped, and a path listed twice is tried once.
export function cliExecutableCandidates(
  discovery: CliDiscoveryEnvironment,
  names: readonly string[],
  installLocations: readonly string[],
): string[] {
  const { platform, env } = discovery;
  const paths = cliPathApi(platform);
  const candidates: string[] = [];
  const pathValue = cliEnvironmentValue(env, "PATH", platform) ?? "";
  for (const entry of pathValue.split(platform === "win32" ? ";" : ":")) {
    const directory = usableCliDirectory(entry, platform);
    if (!directory) continue;
    for (const name of names) candidates.push(paths.join(directory, name));
  }
  candidates.push(...installLocations);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
