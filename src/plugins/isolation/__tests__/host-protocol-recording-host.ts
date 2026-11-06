/** Golden recordings share deterministic validation answers. */
import {
  createValidationHost,
  type ValidationHost,
  type ValidationHostOverrides,
} from "../../validate/validation-host.js";

export function createRecordingHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  return createValidationHost(overrides);
}
