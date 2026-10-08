/**
 * Whether the marketplace tells the renderer about updates.
 *
 * `marketplace.updateCheckEnabled` (default ON) is the user's switch; a
 * deployment can still pin it off with AVE_MARKETPLACE_UPDATE_CHECK="0"/"false".
 * The updates themselves come from the installed sources' snapshots
 * (`MarketplaceService.updates`, design §7.3).
 */
import { resolveEnvBackedBoolean } from "../shared/env-backed-settings.js";

/** Registry key for the `AVE_MARKETPLACE_UPDATE_CHECK` / setting pair. */
const UPDATE_CHECK_SETTINGS_PATH = "marketplace.updateCheckEnabled";

/**
 * Combine the `marketplace.updateCheckEnabled` setting with the environment.
 *
 * This variable only ever forces the check OFF: an ON value changes nothing,
 * because the pre-existing host rule was `(setting ?? true) && env` and a
 * deployment that wanted the check on simply left the variable unset. Keeping
 * that asymmetry means turning the setting off is never quietly undone by a
 * launcher script that exports `=1`.
 */
export function resolveUpdateCheckEnabled(
  settingEnabled: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveEnvBackedBoolean(UPDATE_CHECK_SETTINGS_PATH, settingEnabled, env);
}
