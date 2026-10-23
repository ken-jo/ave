import { homedir, userInfo } from "node:os";
import path, { posix, win32 } from "node:path";
import { canonicalizePathForMatch } from "../permissions/sensitive-paths.js";

/** An absolute, non-root home. Host paths also count, since tests simulate other platforms. */
function isHomeAnchor(home: string | undefined, platform: NodeJS.Platform): home is string {
  if (!home) return false;
  return [platform === "win32" ? win32 : posix, path].some((paths) => {
    const root = paths.parse(home).root;
    // A win32 root without a drive (`\x`) resolves against the current drive.
    return paths.isAbsolute(home) && paths.resolve(home) !== paths.resolve(root)
      && (paths !== win32 || root.length > 1);
  });
}

/** os.homedir() throws on win32 when USERPROFILE is empty; other anchors still apply. */
function osHome(): string | undefined {
  try { return homedir(); } catch { return undefined; }
}

function passwdHome(): string | undefined {
  try { return userInfo().homedir; } catch { return undefined; }
}

/** All independent home anchors used by deny floors and shell checks. */
export function policyHomeAnchors(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const os = osHome();
  // On win32 os.homedir() is USERPROFILE; the profile variables only stand in when it fails.
  const profile = platform !== "win32" || isHomeAnchor(os, platform) ? undefined
    : isHomeAnchor(environment.USERPROFILE, platform) ? environment.USERPROFILE
      : (environment.HOMEDRIVE ?? "") + (environment.HOMEPATH ?? "");
  const candidates = [os, environment.HOME, platform === "win32" ? profile : passwdHome()];
  const seen = new Set<string>();
  return candidates.filter((home): home is string => {
    if (!isHomeAnchor(home, platform)) return false;
    const canonical = canonicalizePathForMatch(home);
    const key = platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve policy roots without changing the environment passed to children. */
export function getPolicyHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isHomeAnchor(environment.HOME, platform)) return environment.HOME;
  if (platform === "win32") {
    if (isHomeAnchor(environment.USERPROFILE, platform)) return environment.USERPROFILE;
    const profile = (environment.HOMEDRIVE ?? "") + (environment.HOMEPATH ?? "");
    if (isHomeAnchor(profile, platform)) return profile;
  }
  let home = osHome() ?? "";
  if (!isHomeAnchor(home, platform) && platform !== "win32") home = passwdHome() ?? "";
  if (!isHomeAnchor(home, platform)) throw new Error("Cannot resolve home for path policy");
  return home;
}
