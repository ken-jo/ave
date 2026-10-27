import { useTranslation } from "../../../i18n/react.js";
import type { ReactNode } from "react";
import type { BrowserObservationAction } from "../../../shared/agent-observation.js";
import { useBrowserObservation } from "./browser-observation-bridge.js";
import { PreviewDocumentLiveStrip } from "./preview-document-chrome.js";

const ACTION_KEYS: Record<BrowserObservationAction, string> = {
  navigate: "agentBrowser.observationNavigate",
  click: "agentBrowser.observationClick",
  type: "agentBrowser.observationType",
  "tab-open": "agentBrowser.observationTabOpen",
  "tab-close": "agentBrowser.observationTabClose",
  "tab-switch": "agentBrowser.observationTabSwitch",
  download: "agentBrowser.observationDownload",
  hover: "agentBrowser.observationHover",
  drag: "agentBrowser.observationDrag",
  select: "agentBrowser.observationSelect",
  scroll: "agentBrowser.observationScroll",
  upload: "agentBrowser.observationUpload",
  "press-key": "agentBrowser.observationPressKey",
};
const DOWNLOAD_STATE_KEYS = {
  started: "agentBrowser.observationDownloadStarted",
  completed: "agentBrowser.observationDownloadCompleted",
  cancelled: "agentBrowser.observationDownloadCancelled",
  interrupted: "agentBrowser.observationDownloadInterrupted",
} as const;

/** Reserved chrome keeps native input coordinates stable; only agent events fill it. */
export function BrowserObservationLiveStrip({ tabId, sessionId }: { tabId: string; sessionId?: string }) {
  const { t } = useTranslation();
  const event = useBrowserObservation(tabId, sessionId);
  const idle = !event || (event.kind === "status" && event.after.code === "session-cleared");
  const slot = (content: ReactNode = null) => <div data-testid="browser-observation-slot"
    aria-hidden={idle ? true : undefined} className="h-7 shrink-0">{content}</div>;
  if (!event) return slot();
  if (event.kind === "status") {
    const code = event.after.code;
    if (code === "session-cleared") return slot();
    return slot(<PreviewDocumentLiveStrip source="browser" status={code}
      error={t(code === "resync-required" ? "agentBrowser.observationResync" : "agentBrowser.observationError")} />);
  }
  const { action, url, title, element, download } = event.after;
  const address = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const target = element ? element.redacted ? t("agentBrowser.observationCredential") : element.name || element.role || element.ref
    : action === "navigate" || action === "tab-open" || action === "tab-switch" ? title : "";
  const detail = download ? t(DOWNLOAD_STATE_KEYS[download.state])
    : target ? `‘${target}’` : "";
  const summary = `${address} · ${t(ACTION_KEYS[action])}${detail ? `: ${detail}` : ""}`;
  return slot(<PreviewDocumentLiveStrip source="browser" status="live" label={t("agentBrowser.observationBrowsing")}
    summary={summary} ts={event.ts} />);
}
