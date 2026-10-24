import { describe, expect, it } from "vitest";
import type { BrowserTabControlView } from "../../../../shared/browser-surface.js";
import type { BrowserWorkspaceTab } from "../../../../shared/browser-workspace.js";
import type { WorkspaceTab } from "../workspace-tabs.js";
import { selectSessionBrowserTabs } from "../session-browser-tabs.js";

const IDS = ["browser:own", "browser:child", "browser:other", "browser:controlled", "browser:human", "browser:remote"];
const tabs: BrowserWorkspaceTab[] = IDS.map((tabId) => ({ tabId, documentGeneration: 1, url: "https://example.com/", title: tabId, zoomFactor: 1 }));
const local: WorkspaceTab[] = IDS.filter((id) => id !== "browser:remote").map((id) => ({ id, kind: "browser", ordinal: 0, mode: "pinned", content: null }));
function owned(rendererTabId: string, sessionId: string, directParentSessionId?: string): BrowserTabControlView {
  return { tabId: rendererTabId, rendererTabId, owner: { sessionId, ...(directParentSessionId ? { directParentSessionId } : {}) }, lease: null,
    mode: "human-paused", title: rendererTabId, url: "https://example.com/", generation: 1, kind: "embedded", openerTabId: null };
}

describe("session browser tabs", () => {
  it("selects owned and direct-child tabs across surfaces and keeps control-only attribution local", () => {
    const control = { revision: 1, tabs: [owned(IDS[0]!, "session"), owned(IDS[1]!, "child", "session"), owned(IDS[2]!, "other"), owned(IDS[5]!, "session")] };
    const selected = selectSessionBrowserTabs("session", local, tabs, control, new Set([IDS[2]!, IDS[3]!]));
    expect(selected.map((tab) => tab.tabId)).toEqual([IDS[0], IDS[1], IDS[3], IDS[5]]);
  });
  it("does not attribute tabs to a session that has not been established", () => {
    expect(selectSessionBrowserTabs(null, local, tabs, null, new Set(IDS))).toEqual([]);
    expect(selectSessionBrowserTabs("session", local, tabs, null, new Set())).toEqual([]);
  });
  it("does not confuse a parent session's ownership with its child's", () => {
    expect(selectSessionBrowserTabs("child", local, tabs, { revision: 1, tabs: [owned(IDS[0]!, "parent")] }, new Set([IDS[0]!]))).toEqual([]);
  });
});
