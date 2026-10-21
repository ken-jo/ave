import { useId, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { AveApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { BrowserWorkspacePanel } from "./BrowserWorkspacePanel.js";

/** The browser library is mounted only while its trusted chrome is open. */
export function BrowserSurfaceTools({ api, tabId, onOpenUrl }: {
  api: AveApi;
  tabId: string;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!api.browserWorkspace || !api.browserTabs) return null;
  return <div className="shrink-0 border-b">
    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
      onClick={() => setOpen((shown) => !shown)} aria-expanded={open} aria-controls={panelId}
      data-testid="browser-workspace-toggle">
      <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden="true" />{t("agentBrowser.workspace")}
    </Button>
    {open && <div id={panelId} className="max-h-80 overflow-auto">
      <BrowserWorkspacePanel api={api.browserWorkspace} browserTabs={api.browserTabs}
        activeTabId={tabId} visible onOpenUrl={onOpenUrl} />
    </div>}
  </div>;
}
