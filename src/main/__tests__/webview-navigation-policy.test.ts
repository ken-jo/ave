import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { shouldBlockGlobalWebviewNavigation } from "../webview-navigation-policy.js";

const distRoot = resolve("fixtures/Ave.app/Contents/Resources/app.asar/dist");
const distSrcRoot = resolve(distRoot, "src");
const distSrcUrl = pathToFileURL(`${distSrcRoot}/`).toString();
const fileUrlInDistSrc = (name: string) => new URL(name, distSrcUrl).toString();

function decision(overrides: Partial<Parameters<typeof shouldBlockGlobalWebviewNavigation>[0]>) {
  return shouldBlockGlobalWebviewNavigation({
    url: "https://example.com/",
    currentUrl: "about:blank",
    authOwned: false,
    linkOwned: false,
    ...overrides,
  });
}

describe("global webview navigation policy", () => {
  it("blocks unregistered http(s) webview navigations", () => {
    expect(decision({ url: "https://example.com/" })).toBe(true);
    expect(decision({ url: "http://example.com/" })).toBe(true);
  });

  it("delegates remote navigation only to explicitly owned auth/link webviews", () => {
    expect(decision({ url: "https://example.com/", authOwned: true })).toBe(false);
    expect(decision({ url: "https://example.com/", linkOwned: true })).toBe(false);
  });

  it("refuses local file navigation from an unowned preview", () => {
    expect(decision({
      currentUrl: fileUrlInDistSrc("preview.html"),
      url: fileUrlInDistSrc("entry.js"),
    })).toBe(true);
    expect(decision({
      currentUrl: fileUrlInDistSrc("preview.html"),
      url: "file:///etc/passwd",
    })).toBe(true);
  });

  it("refuses local file navigation regardless of the current document", () => {
    for (const currentUrl of [
      fileUrlInDistSrc("preview.html"),
      `${fileUrlInDistSrc("index.html")}?next=preview.html`,
      "https://untrusted.example/preview.html",
      fileUrlInDistSrc("other-preview.html"),
    ]) {
      expect(decision({ currentUrl, url: fileUrlInDistSrc("entry.js") })).toBe(true);
    }
  });

  it("keeps data and about navigations available for non-plugin preview frames", () => {
    expect(decision({ url: "data:text/html,ok" })).toBe(false);
    expect(decision({ url: "about:blank" })).toBe(false);
  });

  it("allows the host-owned ave-mcp-app:// sandbox-proxy scheme", () => {
    // Proxy-document reloads require this scheme; protocol.handle separately rejects invalid tokens and authority mismatches.
    expect(decision({ url: "ave-mcp-app://abc123/proxy.html?t=tok" })).toBe(false);
    // A look-alike that only starts with the string but isn't the scheme is still blocked.
    expect(decision({ url: "https://ave-mcp-app.evil.example/" })).toBe(true);
  });
});
