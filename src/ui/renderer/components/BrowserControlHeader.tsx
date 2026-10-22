import type { AveApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { useBrowserControlState, useBrowserControlUnavailable } from "../preview/agent-browser-bridge.js";
import { AgentControlBadge } from "./AgentControlBadge.js";

/** Host control follows the tab across pane placement and UI remounts. */
export function BrowserControlHeader({ api, tabId }: { api: AveApi; tabId: string }) {
  const { t } = useTranslation();
  const state = useBrowserControlState();
  const unavailable = useBrowserControlUnavailable();
  const tab = state.tabs.find((candidate) => candidate.rendererTabId === tabId);
  const controls = api.browserTabs;
  return <>
    {unavailable && <div role="alert" className="shrink-0 border-b px-3 py-1.5 text-xs text-destructive">
      {t("agentBrowser.controlUnavailable")}
    </div>}
    {controls && tab && (tab.mode === "agent-active" || tab.mode === "human-paused") && <AgentControlBadge
      mode={tab.mode}
      onPause={() => controls.pause(tabId)}
      onResume={() => controls.resume(tabId)}
    />}
  </>;
}
