import type { PluginManifest } from "./types.js";

export function installedCapabilities(
  manifests: ReadonlyArray<Pick<PluginManifest, "capabilities">>,
): Set<string> {
  const caps = new Set<string>();
  for (const m of manifests) {
    if (Array.isArray(m.capabilities)) {
      for (const c of m.capabilities) {
        caps.add(c);
      }
    }
  }
  return caps;
}

/** Resolve declared required tags against installed, enabled manifests; return every missing tag. */
export function resolveDependencies(
  required: string[],
  installed: ReadonlyArray<Pick<PluginManifest, "capabilities">>,
): { ok: true } | { ok: false; missing: string[] } {
  if (required.length === 0) return { ok: true };
  const available = installedCapabilities(installed);
  const missing = required.filter((cap) => !available.has(cap));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}
