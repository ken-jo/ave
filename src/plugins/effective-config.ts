import { applyConfigDefaults } from "./config-schema.js";
import type { PluginManifest } from "./types.js";

/** Schema defaults < manifest config < host wildcard < saved plugin values. */
export function effectivePluginConfig(
  manifest: Pick<PluginManifest, "configSchema" | "config">,
  wildcard: Record<string, unknown>,
  saved: Record<string, unknown>,
): Record<string, unknown> {
  return applyConfigDefaults(manifest.configSchema, {
    ...manifest.config,
    ...wildcard,
    ...saved,
  });
}
