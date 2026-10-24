import { useBrowserWorkspace, type BrowserWorkspaceTabsClient } from "../hooks/use-browser-workspace.js";
import type { BrowserWorkspaceApi } from "../../../shared/browser-workspace.js";
import { useAgentControlledTabIds } from "../preview/agent-browser-bridge.js";
import { selectSessionBrowserTabs } from "../preview/session-browser-tabs.js";
import type { WorkspaceTabsStore } from "../preview/workspace-tabs.js";
import type { AveApi } from "../types.js";
import { routineThumbnailOwner, useOverlayContext, useRoutineThumbnailOwner } from "../context/OverlayContext.js";
import { useTranslation } from "../../../i18n/react.js";
import { BrowserWorkspaceCard } from "./BrowserWorkspaceCard.js";
import { OverlayCard } from "./OverlayCard.js";

export interface ChatThumbnailColumnProps {
  api: AveApi;
  sessionId: string | null;
  workspaceTabs: WorkspaceTabsStore;
  visible: boolean;
  onOpenTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

function SessionBrowserCards({ browserWorkspace, browserTabs, sessionId, workspaceTabs, visible, onOpenTab, onCloseTab }: Omit<ChatThumbnailColumnProps, "api"> & {
  browserWorkspace: BrowserWorkspaceApi;
  browserTabs: BrowserWorkspaceTabsClient;
}) {
  const { t } = useTranslation();
  const { state, control, failed } = useBrowserWorkspace(browserWorkspace, browserTabs);
  const controlled = useAgentControlledTabIds();
  const tabs = selectSessionBrowserTabs(sessionId, workspaceTabs.tabs, state?.tabs ?? [], control, controlled);
  return <>
    {failed && <p role="alert" className="text-destructive">{t("browserWorkspace.failed")}</p>}
    <ul className="space-y-2">
      {tabs.map((tab) => <BrowserWorkspaceCard key={`${tab.tabId}:${tab.documentGeneration}`} api={browserWorkspace} tab={tab} visible={visible}
        mode={t(`browserWorkspace.mode.${control?.tabs.find((entry) => entry.rendererTabId === tab.tabId)?.mode ?? "human"}`)}
        active={workspaceTabs.activeTabId === tab.tabId} onOpen={() => onOpenTab(tab.tabId)} onClose={() => onCloseTab(tab.tabId)} />)}
    </ul>
  </>;
}

export function ChatThumbnailColumn(props: ChatThumbnailColumnProps) {
  const { api, sessionId, visible } = props;
  const { t } = useTranslation();
  const { queue, dismiss, openSession, expandedCardIds, setCardExpanded, thumbnailSessions } = useOverlayContext();
  const owner = useRoutineThumbnailOwner(sessionId, visible);
  if (!visible) return null;
  const routines = queue.filter((item) => routineThumbnailOwner(item, thumbnailSessions) === owner);
  return <section aria-label={t("chatThumbnails.title")} data-testid="chat-thumbnail-content" className="h-full w-full min-h-0 overflow-y-auto p-2 text-xs">
    <div className="space-y-2">
      {routines.map((item) => {
        if (item.source.kind !== "routine") return null;
        const { routineId, firedAt } = item.source;
        const acknowledge = () => { void api.acknowledgeRoutineResult(routineId, firedAt).catch((error: unknown) => console.warn("[ave] Routine result acknowledgement failed", error)); };
        return <OverlayCard key={item.id} title={item.title} summary={item.summary} firedAt={firedAt} running={item.running}
          queueIndex={1} queueTotal={1} onPrev={() => {}} onNext={() => {}}
          onDismiss={() => { if (!item.running) acknowledge(); dismiss(item.id); }}
          expanded={expandedCardIds.has(item.id)} onExpandedChange={(expanded) => setCardExpanded(item.id, expanded)}
          onPrimaryAction={item.routineSessionId ? () => {
            void openSession(item.routineSessionId!).then((opened) => { if (opened) { acknowledge(); dismiss(item.id); } })
              .catch((error: unknown) => console.warn("[ave] Routine session open failed", error));
          } : undefined}
          primaryActionLabel={t("overlayCardRegion.viewResult")} kind="routine" />;
      })}
      {api.browserWorkspace && api.browserTabs && <SessionBrowserCards {...props} browserWorkspace={api.browserWorkspace} browserTabs={api.browserTabs} />}
    </div>
  </section>;
}
