import { describe, expect, it } from "vitest";
import { BROWSER_ADDRESS_SUGGESTION_LIMIT, browserAddressSuggestions } from "../browser-address-suggestions.js";

const STATE = {
  bookmarks: [{ url: "https://docs.example/guide", title: "Guide", at: 1 }],
  history: [
    { url: "https://www.shop.example/cart", title: "Cart", at: 5, by: "user" as const },
    { url: "https://docs.example/guide", title: "Guide", at: 4, by: "user" as const },
    { url: "https://news.example/docs-today", title: "Today", at: 3, by: "user" as const },
    { url: "https://secret.example/docs", title: "Agent page", at: 2, by: "agent" as const },
    { url: "https://blog.example/post", title: "Docs roundup", at: 1, by: "user" as const },
  ],
};

describe("address suggestions", () => {
  it("offers nothing for empty text or before the library is known", () => {
    expect(browserAddressSuggestions(STATE, "   ")).toEqual([]);
    expect(browserAddressSuggestions(null, "docs")).toEqual([]);
  });
  it("ranks an address that begins with the text before one that contains it, and that before a title match, once per address", () => {
    expect(browserAddressSuggestions(STATE, "Docs")).toEqual([
      { url: "https://docs.example/guide", title: "Guide", source: "bookmark" },
      { url: "https://news.example/docs-today", title: "Today", source: "history" },
      { url: "https://blog.example/post", title: "Docs roundup", source: "history" },
    ]);
  });
  it("matches what a person types: without the scheme or a leading www", () => {
    expect(browserAddressSuggestions(STATE, "shop.ex").map((entry) => entry.url)).toEqual(["https://www.shop.example/cart"]);
    expect(browserAddressSuggestions(STATE, "https://www.shop").map((entry) => entry.url)).toEqual(["https://www.shop.example/cart"]);
  });
  it("never offers a page only the agent visited", () => {
    expect(browserAddressSuggestions(STATE, "secret")).toEqual([]);
    expect(browserAddressSuggestions(STATE, "agent page")).toEqual([]);
  });
  it("offers at most the limit", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ url: `https://many.example/${index}`, title: "Many", at: index, by: "user" as const }));
    expect(browserAddressSuggestions({ bookmarks: [], history }, "many")).toHaveLength(BROWSER_ADDRESS_SUGGESTION_LIMIT);
  });
});
