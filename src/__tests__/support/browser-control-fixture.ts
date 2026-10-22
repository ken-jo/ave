import type { BrowserControlMode, BrowserTabControlState } from "../../shared/browser-surface.js";

export function browserControlFixture(rendererIds: readonly string[], mode: BrowserControlMode = "agent-active", revision = 1): BrowserTabControlState {
  const owner = { sessionId: "fixture-session" };
  return { revision, tabs: rendererIds.map((rendererTabId) => ({
    tabId: `handle-${rendererTabId}`, rendererTabId, url: "https://a.example/", title: "Fixture page",
    mode, owner, lease: { id: `lease-${rendererTabId}`, actor: owner, lifetime: "owned" },
    generation: revision, kind: "embedded", openerTabId: null,
  })) };
}
