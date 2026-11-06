/** Golden recordings override only the installed-plugin neighbourhood; production validation keeps its empty default. */
import {
  createValidationHost,
  type ValidationHost,
  type ValidationHostOverrides,
} from "../../../__tests__/support/plugin-validation/validation-host.js";

const RECORDED_INSTALLED_PLUGIN_IDS: readonly string[] = [
  "sampleportal",
  "local-indexer",
  "meeting",
  "samplemail",
  "sampleassistant",
];

export function createRecordingHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  return createValidationHost({
    getInstalledPluginIds: () => [...RECORDED_INSTALLED_PLUGIN_IDS],
    ...overrides,
  });
}
