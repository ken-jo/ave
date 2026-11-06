

import type { SettingsService } from "../data/settings-store.js";
import { activeHostApiVendor } from "./steps/refresh-active-llm-wildcard.js";

/** Wildcard metadata excludes secrets and API identity during subscription generation; refresh must preserve this contract. */
export function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // Keys must pass getSecret’s hostSecrets.read allow-list, never wildcard config injection.
  const hostApiVendor = activeHostApiVendor(llm);
  if (hostApiVendor) {
    overrides["*"] = { hostApiVendor };
  }

  const pluginConfigs = settings.get("pluginConfigs");
  for (const [pluginId, config] of Object.entries(pluginConfigs)) {
    overrides[pluginId] = { ...(overrides[pluginId] ?? {}), ...config };
  }

  return overrides;
}

// Plugin registration flows through loopback discovery in boot/steps/plugin-runtime.ts.
