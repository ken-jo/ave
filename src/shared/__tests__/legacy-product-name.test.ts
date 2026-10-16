/**
 * Pins the legacy literals by value. Production code and the rejection tests
 * both read these constants, so a test built only from them would pass even if
 * a constant drifted to a value no old artifact ever carried; this file states
 * the exact old spellings once, independently.
 */
import { describe, expect, it } from "vitest";
import { RENAMED_EXTENSION_NAMESPACE } from "../../plugins/public-contract.js";
import {
  LEGACY_AGENTS_DOCUMENT,
  LEGACY_ENV_PREFIX,
  LEGACY_EXTENSION_NAMESPACE,
  LEGACY_I18N_SENTINEL,
  LEGACY_META_PREFIX,
} from "../legacy-product-name.js";

describe("legacy product name literals", () => {
  it("keep the exact spellings old artifacts carry", () => {
    expect(LEGACY_EXTENSION_NAMESPACE).toBe("xyz.retiredname-namespace");
    expect(RENAMED_EXTENSION_NAMESPACE).toBe("xyz.retiredname-namespace");
    expect(LEGACY_META_PREFIX).toBe("xyz.retiredname/");
    expect(LEGACY_ENV_PREFIX).toBe("RETIREDNAME_");
    expect(LEGACY_AGENTS_DOCUMENT).toBe("RETIREDNAME.md");
    expect(LEGACY_I18N_SENTINEL).toBe("RETIREDNAMEKEEP");
  });
});
