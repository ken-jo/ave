/**
 * The validation host as the golden recordings were made against it.
 *
 * The production validation host answers a validated plugin's
 * `getInstalledPluginIds` with no neighbours, because the plugin is validated
 * alone. The recordings pin a neighbourhood — the installed-plugin snapshot in
 * every `construct` frame — so it is supplied here, through the host's own
 * `overrides`, and stays out of the production default.
 */
import {
  createValidationHost,
  type ValidationHost,
  type ValidationHostOverrides,
} from "../../validate/validation-host.js";

/** The installed-plugin snapshot every recorded transcript pins. */
const RECORDED_INSTALLED_PLUGIN_IDS: readonly string[] = [
  "orion-api",
  "local-indexer",
  "meeting",
  "lyra-mail",
  "vega-helper",
];

/** The validation host with the recorded neighbourhood, and `overrides` on top. */
export function createRecordingHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  return createValidationHost({
    getInstalledPluginIds: () => [...RECORDED_INSTALLED_PLUGIN_IDS],
    ...overrides,
  });
}
