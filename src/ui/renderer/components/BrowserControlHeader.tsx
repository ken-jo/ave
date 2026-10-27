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
  return <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden px-1">
    {unavailable && <span role="alert" title={t("agentBrowser.controlUnavailable")}
      className="min-w-0 truncate text-[11px] text-destructive">
      {t("agentBrowser.controlUnavailable")}
    </span>}
    {controls && tab && (tab.mode === "agent-active" || tab.mode === "human-paused") && <AgentControlBadge
      mode={tab.mode}
      onPause={() => controls.pause(tabId)}
      onResume={() => controls.resume(tabId)}
    />}
  </div>;
}
