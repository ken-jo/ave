import { useId, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { AveApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { BrowserWorkspacePanel } from "./BrowserWorkspacePanel.js";
import { BrowserControlHeader } from "./BrowserControlHeader.js";

/** Persistent tab controls share one toolbar; the library body mounts only while open. */
export function BrowserSurfaceTools({ api, tabId, onOpenUrl }: {
  api: AveApi;
  tabId: string;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <div className="shrink-0 border-b">
    <div className="flex h-7 min-w-0 items-center gap-1" data-testid="browser-control-toolbar">
    {api.browserWorkspace && api.browserTabs ? <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs"
      onClick={() => setOpen((shown) => !shown)} aria-expanded={open} aria-controls={panelId}
      data-testid="browser-workspace-toggle">
      <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden="true" />{t("agentBrowser.workspace")}
    </Button> : null}
    <BrowserControlHeader api={api} tabId={tabId} />
    </div>
    {open && api.browserWorkspace && api.browserTabs ? <div id={panelId} className="max-h-80 overflow-auto">
      <BrowserWorkspacePanel api={api.browserWorkspace} browserTabs={api.browserTabs}
        activeTabId={tabId} visible onOpenUrl={onOpenUrl} />
    </div> : null}
  </div>;
}
