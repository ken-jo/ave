import type { BrowserTabControlState } from "../../../shared/browser-surface.js";
import type { BrowserWorkspaceTab } from "../../../shared/browser-workspace.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/** Explicit host ownership follows a tab across surfaces; control-only attribution stays local. */
export function selectSessionBrowserTabs(
  sessionId: string | null,
  workspaceTabs: readonly WorkspaceTab[],
  browserTabs: readonly BrowserWorkspaceTab[],
  control: BrowserTabControlState | null,
  agentControlledTabIds: ReadonlySet<string>,
): readonly BrowserWorkspaceTab[] {
  if (!sessionId) return [];
  const localIds = new Set(workspaceTabs.filter((tab) => tab.kind === "browser").map((tab) => tab.id));
  return browserTabs.filter((tab) => {
    const owner = control?.tabs.find((entry) => entry.rendererTabId === tab.tabId)?.owner;
    if (owner) return owner.sessionId === sessionId || owner.directParentSessionId === sessionId;
    return localIds.has(tab.tabId) && agentControlledTabIds.has(tab.tabId);
  });
}
