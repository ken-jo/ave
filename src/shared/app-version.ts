/** Resolve project metadata from the bundle; runtime version APIs can report the shell binary in development. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "unknown";

let cachedVersion: string | null = null;

function readVersionFromCandidates(): string {
  // Walk upward and check package identity so chunk relocation and nested packages cannot break version gates.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      const raw = readFileSync(resolve(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (
        typeof parsed.version === "string" &&
        parsed.version.length > 0 &&
        (typeof parsed.name !== "string" || parsed.name === "ave")
      ) {
        return parsed.version;
      }
    } catch {
      // No readable package.json at this level — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return FALLBACK_VERSION;
}

/** Returns the Ave app version (cached). Never throws. */
export function getAveAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readVersionFromCandidates();
  return cachedVersion;
}

export function __resetAveAppVersionCacheForTest(): void {
  cachedVersion = null;
}
