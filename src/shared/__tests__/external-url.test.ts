import { describe, expect, it } from "vitest";
import { validateExternalUrl } from "../external-url.js";

describe("validateExternalUrl", () => {
  it("accepts https URLs and returns the canonical form", () => {
    const result = validateExternalUrl("https://ave.agent-connector.ai/login");
    expect(result).toEqual({ ok: true, url: "https://ave.agent-connector.ai/login" });
  });

  it("accepts plain http URLs", () => {
    const result = validateExternalUrl("http://localhost:8000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.startsWith("http://localhost:8000")).toBe(true);
  });

  it("rejects file:// URLs", () => {
    const result = validateExternalUrl("file:///etc/passwd");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "file:" });
  });

  it("rejects javascript: URLs", () => {
    const result = validateExternalUrl("javascript:alert(1)");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "javascript:" });
  });

  it("rejects data: URLs", () => {
    const result = validateExternalUrl("data:text/html,<script>alert(1)</script>");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "data:" });
  });

  it("rejects empty strings", () => {
    expect(validateExternalUrl("")).toEqual({ ok: false, error: "invalid-url" });
  });

  it("rejects non-string input", () => {
    expect(validateExternalUrl(undefined)).toEqual({ ok: false, error: "invalid-url" });
    expect(validateExternalUrl(null)).toEqual({ ok: false, error: "invalid-url" });
    expect(validateExternalUrl(42)).toEqual({ ok: false, error: "invalid-url" });
  });

  it("rejects malformed URLs", () => {
    expect(validateExternalUrl("not a url")).toEqual({ ok: false, error: "malformed-url" });
  });

  it("rejects miscellaneous handler schemes (positive-allowlist contract)", () => {
    // Allow-list schemes so future protocol handlers remain denied by default.
    expect(validateExternalUrl("vbscript:msgbox(1)")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "vbscript:",
    });
    expect(validateExternalUrl("chrome-extension://abc/page.html")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "chrome-extension:",
    });
    expect(validateExternalUrl("ms-windows-store://download")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "ms-windows-store:",
    });
  });

  it("accepts http URLs with path and query", () => {
    const result = validateExternalUrl("https://ave.agent-connector.ai/admin?tab=keys");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://ave.agent-connector.ai/admin?tab=keys");
  });

  it("rejects URLs with embedded credentials", () => {
    // Reject userinfo: a trusted-looking prefix can navigate to an attacker host.
    expect(validateExternalUrl("https://trusted.example@evil.tld/")).toEqual({
      ok: false,
      error: "embedded-credentials",
    });
    expect(validateExternalUrl("https://user:pass@evil.tld/")).toEqual({
      ok: false,
      error: "embedded-credentials",
    });
    expect(validateExternalUrl("http://:hunter2@evil.tld/pay")).toEqual({
      ok: false,
      error: "embedded-credentials",
    });
  });

  it("does not treat an @ elsewhere in the URL as credentials", () => {
    // Allow @ in paths and queries; only parsed username and password fields are credentials.
    const path = validateExternalUrl("https://example.com/users/@alice");
    expect(path.ok).toBe(true);
    const query = validateExternalUrl("https://example.com/s?to=a@b.com");
    expect(query.ok).toBe(true);
  });
});
