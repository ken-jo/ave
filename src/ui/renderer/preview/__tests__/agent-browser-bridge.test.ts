/**
 * Each tab operation from main is carried out by exactly one chat view's
 * store: the one holding the tab, or for a new tab the one showing the
 * conversation it is for.
 */
import { describe, expect, it, vi } from "vitest";
import { routeBrowserTabOp, type BrowserTabHost } from "../agent-browser-bridge.js";

function host(sessionId: string | null, tabs: string[]): BrowserTabHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sessionId: () => sessionId,
    hasTab: (tabId) => tabs.includes(tabId),
    openAgentTab: vi.fn((url, requestId) => calls.push(`new ${url} ${requestId}`)),
    selectTab: vi.fn((tabId) => calls.push(`select ${tabId}`)),
    closeTab: vi.fn((tabId) => calls.push(`close ${tabId}`)),
  };
}

describe("routeBrowserTabOp", () => {
  it("opens a new tab beside the conversation it is for, else in the first view", () => {
    const first = host("s1", []);
    const second = host("s2", []);
    routeBrowserTabOp({ requestId: "r1", op: "new", url: "https://a.example/", sessionId: "s2" }, [first, second]);
    routeBrowserTabOp({ requestId: "r2", op: "new", url: "https://b.example/", sessionId: "other" }, [first, second]);
    routeBrowserTabOp({ requestId: "r3", op: "new", url: "https://c.example/" }, [first, second]);
    expect(second.calls).toEqual(["new https://a.example/ r1"]);
    expect(first.calls).toEqual(["new https://b.example/ r2", "new https://c.example/ r3"]);
  });

  it("selects or closes in the view that holds the tab, and nowhere else", () => {
    const first = host("s1", ["browser:1"]);
    const second = host("s2", ["browser:2"]);
    routeBrowserTabOp({ requestId: "r1", op: "select", tabId: "browser:2" }, [first, second]);
    routeBrowserTabOp({ requestId: "r2", op: "close", tabId: "browser:1" }, [first, second]);
    routeBrowserTabOp({ requestId: "r3", op: "close", tabId: "browser:9" }, [first, second]);
    expect(first.calls).toEqual(["close browser:1"]);
    expect(second.calls).toEqual(["select browser:2"]);
  });
});
