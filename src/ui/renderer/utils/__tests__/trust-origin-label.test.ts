// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
/**
 * The transcript's provenance chip.
 *
 * The staged half is resolved through the staged-origin registry, so registering
 * an origin labels it. Before that, this was a hand-written switch with
 * `default: return origin` — a registered origin nobody remembered to add here
 * rendered its raw kebab-case string at the user, in every locale.
 */
import { describe, expect, it } from "vitest";
import { loadLocaleMessages, messages } from "../../../../i18n/messages/index.js";
import { STAGED_ORIGIN_KINDS } from "../../../../shared/staged-origins.js";
import { isNonUserTrustOrigin, trustOriginLabel } from "../trust-origin-label.js";

describe("trustOriginLabel", () => {
  it("labels every registered staged origin through the table in both compiled locales", async () => {
    const korean = await loadLocaleMessages("ko");
    for (const kind of STAGED_ORIGIN_KINDS) {
      expect(messages.en[kind.labelKey], `missing English i18n key ${kind.labelKey}`).toBeTypeOf("string");
      expect(korean[kind.labelKey], `missing Korean i18n key ${kind.labelKey}`).toBeTypeOf("string");
      const label = trustOriginLabel(kind.inputOrigin);
      expect(label.length).toBeGreaterThan(0);
      // The failure this guards: the raw origin string reaching the UI.
      expect(label).not.toBe(kind.inputOrigin);
    }
  });

  it("labels the non-staged origins the table does not own", () => {
    for (const origin of ["user-keyboard", "llm-tool-arg", "file-content", "surface-user", "tailnet-surface", "platform-bridge"]) {
      const label = trustOriginLabel(origin);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(origin);
    }
    // A missing provenance must stay visibly unknown; never silently inherit a
    // newly added external-surface label.
    expect(trustOriginLabel(undefined)).not.toBe(trustOriginLabel("surface-user"));
    expect(trustOriginLabel(undefined)).not.toBe("surface-user");
    expect(trustOriginLabel("tailnet-surface")).not.toBe(trustOriginLabel("surface-user"));
    expect(trustOriginLabel("platform-bridge")).not.toBe(trustOriginLabel("surface-user"));
  });

  it("shows an unknown origin verbatim rather than blank", () => {
    // Deliberate: an origin that reaches the UI unlabeled should be visible.
    expect(trustOriginLabel("something-new")).toBe("something-new");
  });

  it("treats every origin except the keyboard as non-user", () => {
    expect(isNonUserTrustOrigin("user-keyboard")).toBe(false);
    for (const kind of STAGED_ORIGIN_KINDS) {
      expect(isNonUserTrustOrigin(kind.inputOrigin)).toBe(true);
    }
    expect(isNonUserTrustOrigin(undefined)).toBe(true);
    expect(isNonUserTrustOrigin("surface-user")).toBe(true);
    expect(isNonUserTrustOrigin("tailnet-surface")).toBe(true);
  });
});
