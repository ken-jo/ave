import { describe, expect, it } from "vitest";
import { UserOwnedSurfaceStore } from "../user-owned-surface-store.js";
import { issueUserOwnedBrowserScope, isIssuedUserOwnedBrowserScope, preserveUserOwnedBrowserScope } from "../user-owned-browser-scope.js";

it("isolates session choices by surface and never persists or inherits them", () => {
  const store = new UserOwnedSurfaceStore();
  expect(store.get("parent", "browser")).toBe("ask");
  store.set("parent", "browser", "allow");
  store.set("parent", "host-terminal", "auto");
  store.set("other", "browser", "auto");
  expect(store.get("parent", "browser")).toBe("allow");
  expect(store.get("parent", "host-terminal")).toBe("auto");
  expect(store.get("child", "browser")).toBe("ask");
  expect(new UserOwnedSurfaceStore().get("parent", "browser")).toBe("ask");
  store.clear("parent");
  expect(store.get("parent", "browser")).toBe("ask");
  expect(store.get("other", "browser")).toBe("auto");
});

it.each([["", "browser", "allow"], ["session", "unknown", "allow"], ["session", "browser", "unknown"]])("rejects invalid choice identity %j", (...input) => {
  expect(() => new UserOwnedSurfaceStore().set(...input as Parameters<UserOwnedSurfaceStore["set"]>)).toThrow("Invalid user-owned surface choice");
});

describe("issued browser target evidence", () => {
  it("keeps a live target callback private and refuses copied or altered evidence", () => {
    let current = true;
    const scope = issueUserOwnedBrowserScope({ kind: "browser-origin", origin: "https://example.test", tabOpener: "user", tabId: "tab", documentId: 1, controlGeneration: 1 }, () => current);
    expect(isIssuedUserOwnedBrowserScope(scope)).toBe(true);
    expect(JSON.stringify(scope)).not.toContain("isCurrent");
    expect(isIssuedUserOwnedBrowserScope({ ...scope })).toBe(false);
    const copy = Object.freeze({ ...scope });
    preserveUserOwnedBrowserScope(scope, copy);
    expect(isIssuedUserOwnedBrowserScope(copy)).toBe(true);
    const altered = Object.freeze({ ...scope, documentId: 2 });
    preserveUserOwnedBrowserScope(scope, altered);
    expect(isIssuedUserOwnedBrowserScope(altered)).toBe(false);
    current = false;
    expect(isIssuedUserOwnedBrowserScope(scope)).toBe(false);
    expect(isIssuedUserOwnedBrowserScope(copy)).toBe(false);
  });
});
