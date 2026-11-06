/** Golden recordings share deterministic validation answers. */
import {
  createValidationHost,
  type ValidationHost,
  type ValidationHostOverrides,
} from "../../../__tests__/support/plugin-validation/validation-host.js";

export function createRecordingHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  return createValidationHost(overrides);
}
