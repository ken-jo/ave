/** Acceptance exempts the UI-resource capability check; rejection blocks reads, so both edges need coverage. */
import { describe, expect, it } from "vitest";
import { isMcpAppUiUri } from "../mcp-app-partition.js";

describe("isMcpAppUiUri", () => {
  it("accepts the card URIs MCP Apps actually publishes", () => {
    for (const uri of [
      "ui://app/panel.html",
      "ui://widget/main.html",
      "ui://acme-plugin/cards/detail.html?id=1",
      "ui://a",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(true);
    }
  });

  it("refuses every scheme that is not the Apps path", () => {
    // Main must reject non-UI schemes even if a compromised renderer asks with a resource capability.
    for (const uri of [
      "file:///etc/passwd",
      "file:///C:/Users/me/.ssh/id_rsa",
      "https://example.com/x",
      "doc:1",
      "resource://internal/secrets",
      "javascript:alert(1)",
      "",
      "not-a-uri",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(false);
    }
  });

  it("is case-SENSITIVE, because it decides what skips a capability check", () => {
    // Validate the literal scheme without normalizing; rejection uses ordinary resource policy.
    expect(isMcpAppUiUri("UI://app/panel.html")).toBe(false);
    expect(isMcpAppUiUri("Ui://app/panel.html")).toBe(false);
  });

  it("requires an authority the URL parser can actually name", () => {
    // Cover empty authorities and parser errors rather than guessing delimiter cases.
    for (const uri of [
      "ui://",
      "ui:///panel.html",
      "ui:////panel.html",
      "ui://?q=1",
      "ui://#frag",
      "ui://:80/x",
      "ui://[/x",
      "ui://]/x",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(false);
    }
    // The non-special scheme has an opaque, percent-encoded host; validation forwards the original URI.
    for (const uri of [
      "ui://app/panel.html?q=1#top",
      "ui://user@host/x",
      "ui://앱/카드.html",
    ]) {
      expect(isMcpAppUiUri(uri), uri).toBe(true);
    }
  });

  it("refuses a scheme that only starts like the Apps one", () => {
    expect(isMcpAppUiUri("ui:/panel.html")).toBe(false);
    expect(isMcpAppUiUri("ui:panel.html")).toBe(false);
    expect(isMcpAppUiUri("uix://app/panel.html")).toBe(false);
  });

  it("refuses control, whitespace and reordering characters", () => {
    // Identifier checks must reject whitespace that the prose-oriented invisible-character check permits.
    expect(isMcpAppUiUri("ui://app/pa nel.html")).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x0a)}.html`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x09)}.html`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/panel${String.fromCodePoint(0x00)}.html`)).toBe(false);
    // Check raw characters before URL parsing strips tabs and line breaks.
    expect(isMcpAppUiUri(`ui://ap${String.fromCodePoint(0x09)}p/x`)).toBe(false);
    expect(isMcpAppUiUri(`ui://app/pa${String.fromCodePoint(0x0d)}nel.html`)).toBe(false);
    // RFC-excluded characters can break interpolated provenance fences.
    for (const ch of ['"', "<", ">", "\\", "^", "`", "{", "}", "|"]) {
      expect(isMcpAppUiUri(`ui://app/pa${ch}nel.html`), ch).toBe(false);
    }
  });

  it("refuses the invisible class WITHOUT enumerating it here", () => {
    // Draw class probes independently of implementation ranges so a copied omission cannot pass.
    for (const code of [
      0x00ad, // Soft hyphen.
      0x034f, // Combining grapheme joiner.
      0x061c, // Arabic letter mark; a bidi control.
      0x115f, // Hangul choseong filler.
      0x180e, // Mongolian vowel separator.
      0x2060, // Word joiner.
      0x2064, // Invisible plus.
      0x200b, // Zero-width space.
      0x202e, // Right-to-left override.
      0xfe0f, // Variation selector-16.
      0xfeff, // Zero-width no-break space.
    ]) {
      const uri = `ui://app/pa${String.fromCodePoint(code)}nel.html`;
      expect(isMcpAppUiUri(uri), `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
        .toBe(false);
    }
  });

  it("bounds the length", () => {
    expect(isMcpAppUiUri(`ui://app/${"a".repeat(2039)}`)).toBe(true);
    expect(isMcpAppUiUri(`ui://app/${"a".repeat(2040)}`)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const value of [42, null, undefined, {}, ["ui://app/x"]]) {
      expect(isMcpAppUiUri(value), String(value)).toBe(false);
    }
  });
});
