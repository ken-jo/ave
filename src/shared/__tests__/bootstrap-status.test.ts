/** Check computed message keys explicitly; literal translation-key scans cannot see table lookups. */
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SKIP_MESSAGE_KEY,
  type BootstrapSkipReason,
} from "../bootstrap-status.js";
import { SUPPORTED_LOCALES } from "../../i18n/locale.js";
import { loadAllLocaleMessages } from "../../i18n/messages/index.js";

const REASONS: BootstrapSkipReason[] = ["e2e-isolated"];

describe("BOOTSTRAP_SKIP_MESSAGE_KEY", () => {
  it("names a distinct key for every code", () => {
    const keys = REASONS.map((reason) => BOOTSTRAP_SKIP_MESSAGE_KEY[reason]);
    expect(keys.filter(Boolean)).toHaveLength(REASONS.length);
    expect(new Set(keys).size).toBe(REASONS.length);
  });

  it("names keys that resolve in every supported locale", async () => {
    const catalogs = await loadAllLocaleMessages();
    const missing: string[] = [];
    for (const reason of REASONS) {
      const key = BOOTSTRAP_SKIP_MESSAGE_KEY[reason];
      for (const locale of SUPPORTED_LOCALES) {
        if (!Object.hasOwn(catalogs[locale], key)) missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
