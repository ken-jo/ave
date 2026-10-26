import type { BrowserControlMode, BrowserTabControlState } from "../../shared/browser-surface.js";

export const BROWSER_FAVICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAj0lEQVQImQGEAHv/AAD/AGQH+AP/DvEG/xXqCWQc4wz/I9wP/yrVEmQxzhX/ADjHGP8/wBtkRrke/02yIf9UqyRkW6Qn/2KdKv9pli1kAHCPMP93iDP/foE2ZIV6Of+Mczz/k2w/ZJplQv+hXkX/AKhXSGSvUEv/tklO/71CUWTEO1T/yzRX/9ItWmTZJl3/nHk+6OBfgRAAAAAASUVORK5CYII=";

export function browserControlFixture(rendererIds: readonly string[], mode: BrowserControlMode = "agent-active", revision = 1): BrowserTabControlState {
  const owner = { sessionId: "fixture-session" };
  return { revision, tabs: rendererIds.map((rendererTabId) => ({
    tabId: `handle-${rendererTabId}`, rendererTabId, url: "https://a.example/", title: "Fixture page",
    mode, owner, lease: { id: `lease-${rendererTabId}`, actor: owner, lifetime: "owned" },
    generation: revision, kind: "embedded", openerTabId: null,
  })) };
}
