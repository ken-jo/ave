import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** APPDATA inside an overridden Windows profile (created here), so `app.getPath("appData")` resolves inside the isolated profile, never the real one.
 * Empty off Windows or when the spec keeps the parent profile. */
export function windowsProfileEnv(profile: string | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "win32" || profile === undefined) return {};
  const appData = join(profile, "AppData", "Roaming");
  mkdirSync(appData, { recursive: true });
  return { APPDATA: appData };
}

/** The env a launch passes on: the defined entries of `env`, never LOCALAPPDATA on Windows. srt-win keeps its state DB under it and refuses to start
 * without it; started, it would stamp the real account profile (policyHomeAnchors includes accountHome). */
export function launchBaseEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !(platform === "win32" && key.toUpperCase() === "LOCALAPPDATA")) base[key] = value;
  }
  return base;
}
