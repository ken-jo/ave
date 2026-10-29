/**
 * A host terminal in a conversation's work panel. Its 변경 파일 view takes the tab's whole body, the work panel being
 * this terminal's side panel: the badge or a warning's [view changes] switches to it, and a bar switches back. The
 * PTY outlives the switch, as it outlives any tab switch.
 */
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import type { AttachTextResult } from "../preview/composer-targets.js";
import { useTerminalFileReviewState } from "../preview/terminal-file-review.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { TerminalChangesView } from "./TerminalChangesView.js";

export function SidePanelTerminal({ api, tabId, tabLabel, visible, showChanges, onShowChanges, onAttachText }: {
  api: AveApi;
  tabId: string;
  tabLabel: string;
  visible: boolean;
  showChanges: boolean;
  onShowChanges: (show: boolean) => void;
  onAttachText?: (text: string) => AttachTextResult;
}) {
  const { t } = useTranslation();
  const revealToken = useTerminalFileReviewState(tabId)?.reveal?.token ?? null;
  // A request made before this tab was shown is not this mount's to act on; the badge passes its own request in.
  const handled = useRef(revealToken);
  useEffect(() => {
    if (revealToken === null || handled.current === revealToken) return;
    handled.current = revealToken;
    onShowChanges(true);
  }, [revealToken, onShowChanges]);
  if (showChanges) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <button type="button" className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-left text-xs text-primary"
          onClick={() => onShowChanges(false)} data-testid="terminal-changes-back">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{t("terminalFileReview.backToTerminal")}
        </button>
        <div className="min-h-0 flex-1"><TerminalChangesView api={api} tabId={tabId} visible={visible} /></div>
      </div>
    );
  }
  return <PtyTerminalView api={api} location="side-panel" tabId={tabId} tabLabel={tabLabel} {...(onAttachText ? { onAttachText } : {})} />;
}
