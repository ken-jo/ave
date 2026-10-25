/** The user update switch defaults on; deployment environment may disable it but never force it on. */
import { resolveEnvBackedBoolean } from "../shared/env-backed-settings.js";

const UPDATE_CHECK_SETTINGS_PATH = "marketplace.updateCheckEnabled";

/** An environment ON value cannot override a disabled profile setting. */
export function resolveUpdateCheckEnabled(
  settingEnabled: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveEnvBackedBoolean(UPDATE_CHECK_SETTINGS_PATH, settingEnabled, env);
}
