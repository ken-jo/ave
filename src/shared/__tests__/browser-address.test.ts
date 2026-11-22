import { describe, expect, it } from "vitest";
import { ADDRESS_SEARCH_ENGINE_IDS, ADDRESS_SEARCH_ENGINES, isAddressSearchEngine, resolveAddressBarInput } from "../browser-address.js";

describe("resolveAddressBarInput", () => {
  it.each([
    ["example.com/a", "https://example.com/a"],
    ["  https://example.com/docs  ", "https://example.com/docs"],
    ["http://example.com/", "http://example.com/"],
    ["sub.example.co.kr?x=1", "https://sub.example.co.kr/?x=1"],
  ])("opens %s as the address %s", (input, url) => {
    expect(resolveAddressBarInput(input, "google")).toEqual({ kind: "url", url });
  });

  it.each([
    ["localhost:3000", "http://localhost:3000/"],
    ["localhost", "http://localhost/"],
    ["LOCALHOST:8080/path", "http://localhost:8080/path"],
    ["app.localhost:5173/x", "http://app.localhost:5173/x"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["192.168.0.10/admin", "http://192.168.0.10/admin"],
    ["[::1]:3000", "http://[::1]:3000/"],
  ])("opens the local or literal host %s over http as %s", (input, url) => {
    expect(resolveAddressBarInput(input, "google")).toEqual({ kind: "url", url });
  });

  it("keeps an explicit https scheme on a local host", () => {
    expect(resolveAddressBarInput("https://localhost:8443/", "google")).toEqual({ kind: "url", url: "https://localhost:8443/" });
  });

  it.each(["hello world", "hello", "what is 1.5?", "a..b", "notlocalhost", "site:example.com cats", "javascript: what is it"])("sends %s to the search engine", (input) => {
    expect(resolveAddressBarInput(input, "duckduckgo")).toEqual({
      kind: "search", query: input, url: `https://duckduckgo.com/?q=${encodeURIComponent(input)}`,
    });
  });

  it("encodes the query so it cannot add parameters or leave the search path", () => {
    const target = resolveAddressBarInput("a&b=c #d /../x", "google");
    expect(target?.url).toBe("https://www.google.com/search?q=a%26b%3Dc%20%23d%20%2F..%2Fx");
  });

  it.each(["https://hello world/", "ftp://example.com/", "file:///etc/passwd", "https://user:pass@example.com/", "javascript:alert(1)", "data:text/html,x", "file:/etc/passwd", "about:blank"])(
    "refuses the scheme-bearing text %s instead of searching for it", (input) => {
      expect(resolveAddressBarInput(input, "google")).toBeNull();
    });

  it("returns nothing for empty text", () => {
    expect(resolveAddressBarInput("   ", "google")).toBeNull();
  });

  it("offers only https search templates with one query slot", () => {
    for (const id of ADDRESS_SEARCH_ENGINE_IDS) {
      expect(ADDRESS_SEARCH_ENGINES[id]).toMatch(/^https:\/\/[a-z.]+\/[^%]*%s$/);
      expect(isAddressSearchEngine(id)).toBe(true);
    }
    expect(isAddressSearchEngine("toString")).toBe(false);
  });
});
