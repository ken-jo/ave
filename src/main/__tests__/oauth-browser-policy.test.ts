import { describe, expect, it } from "vitest";
import { SYSTEM_BROWSER_OAUTH_ENDPOINTS } from "../oauth-browser-policy.js";
import { isOAuthBrowserRefusal, requiresSystemBrowser } from "../oauth-login.js";

describe("authorization browser routing", () => {
  it("ships an empty secure-browser endpoint table", () => {
    expect(SYSTEM_BROWSER_OAUTH_ENDPOINTS).toEqual([]);
  });
  it("routes an injected endpoint entry as data", () => {
    SYSTEM_BROWSER_OAUTH_ENDPOINTS.push({ hostname: "client.example.test", pathPrefix: "/authorize" });
    try {
      expect(requiresSystemBrowser("https://client.example.test/authorize?state=private")).toBe(true);
      expect(requiresSystemBrowser("https://client.example.test.attacker.test/authorize")).toBe(false);
    } finally { SYSTEM_BROWSER_OAUTH_ENDPOINTS.pop(); }
  });
  it.each(["ZGlzYWxsb3dlZF91c2VyYWdlbnQ", "disallowed_useragent"])("recognizes refusal payload %s after a decode attempt", payload => {
    expect(isOAuthBrowserRefusal(`https://accounts.google.com/signin/oauth/error?authError=${payload}`)).toBe(true);
    expect(isOAuthBrowserRefusal(`https://accounts.google.com.attacker.test/signin/oauth/error?authError=${payload}`)).toBe(false);
  });
  it.each([
    "https://accounts.google.com/o/oauth2/v2/auth?state=private",
    "https://accounts.google.com/signin/oauth/identifier",
    "https://accounts.google.com/signin/oauth/error?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ",
    "https://accounts.google.com/signin/oauth/error?authError=disallowed_useragent",
  ])("keeps authorization in the default isolated browser for %s", url => {
    expect(requiresSystemBrowser(url)).toBe(false);
  });

  it.each([
    "https://auth.example.test/authorize",
    "https://accounts.google.com/other",
    "https://accounts.google.com/o/oauth2-attacker/auth",
    "https://accounts.google.com.attacker.test/o/oauth2/v2/auth",
    "https://accounts.google.com@auth.example.test/signin/oauth",
    "javascript:alert(1)",
  ])("keeps other URLs outside the secure-browser endpoint table: %s", url => {
    expect(requiresSystemBrowser(url)).toBe(false);
  });
});
