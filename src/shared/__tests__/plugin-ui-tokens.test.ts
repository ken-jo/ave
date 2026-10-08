import { describe, it, expect } from "vitest";
import { isAveThemeBundleId, AVE_THEME_BUNDLE_IDS, AVE_TOKEN_NAMES } from "../plugin-ui-tokens.js";

const DERIVED_TOKENS = [
  "--ave-primary-bg-subtle",
  "--ave-primary-bg-strong",
  "--ave-danger-bg-subtle",
  "--ave-warning-bg-subtle",
  "--ave-success-bg-subtle",
  "--ave-surface-hover",
  "--ave-focus-shadow",
] as const;

const CHAT_SEMANTIC_TOKENS = [
  "--ave-message-user-bg",
  "--ave-message-user-fg",
  "--ave-message-user-border",
  "--ave-message-user-muted",
  "--ave-message-user-action",
  "--ave-message-user-emphasis",
  "--ave-input-bar-bg",
  "--ave-input-bar-fg",
  "--ave-input-bar-placeholder",
  "--ave-input-bar-border",
  "--ave-input-bar-focus",
  "--ave-input-bar-subtle",
  "--ave-input-bar-action",
] as const;

const TYPOGRAPHY_AND_MOTION_TOKENS = [
  "--ave-text-micro",
  "--ave-text-caption",
  "--ave-text-body-sm",
  "--ave-text-body",
  "--ave-leading-micro",
  "--ave-leading-caption",
  "--ave-leading-body-sm",
  "--ave-leading-body",
  "--ave-tracking-micro",
  "--ave-tracking-caption",
  "--ave-tracking-body-sm",
  "--ave-tracking-body",
  "--ave-motion-slow",
  "--ave-motion-layout",
  "--ave-motion-ease-standard",
  "--ave-motion-ease-out",
  "--ave-motion-ease-in-out",
] as const;

describe("AVE_TOKEN_NAMES — complete public token contract", () => {
  it("includes all 7 new derived tokens", () => {
    for (const token of DERIVED_TOKENS) {
      expect(AVE_TOKEN_NAMES).toContain(token);
    }
  });

  it("includes chat semantic aliases", () => {
    for (const token of CHAT_SEMANTIC_TOKENS) {
      expect(AVE_TOKEN_NAMES).toContain(token);
    }
  });

  it("includes semantic typography and complete motion roles", () => {
    for (const token of TYPOGRAPHY_AND_MOTION_TOKENS) {
      expect(AVE_TOKEN_NAMES).toContain(token);
    }
  });

  it("has no duplicate token names", () => {
    const seen = new Set<string>();
    for (const name of AVE_TOKEN_NAMES) {
      expect(seen.has(name), `duplicate token: ${name}`).toBe(false);
      seen.add(name);
    }
  });
});

describe("isAveThemeBundleId", () => {
  it("lists the compiled bundles, and accepts each", () => {
    expect(AVE_THEME_BUNDLE_IDS).toEqual(["moonstone", "gallery"]);
    for (const id of AVE_THEME_BUNDLE_IDS) {
      expect(isAveThemeBundleId(id)).toBe(true);
    }
  });

  it("accepts a theme package name, and rejects strings that cannot be one", () => {
    expect(isAveThemeBundleId("tokyo-night")).toBe(true);
    expect(isAveThemeBundleId("Tokyo Night")).toBe(false);
    expect(isAveThemeBundleId("a")).toBe(false);
    expect(isAveThemeBundleId("")).toBe(false);
  });

  it("rejects non-strings (boundary safety)", () => {
    expect(isAveThemeBundleId(null)).toBe(false);
    expect(isAveThemeBundleId(undefined)).toBe(false);
    expect(isAveThemeBundleId(42)).toBe(false);
    expect(isAveThemeBundleId({})).toBe(false);
    expect(isAveThemeBundleId([])).toBe(false);
  });
});
