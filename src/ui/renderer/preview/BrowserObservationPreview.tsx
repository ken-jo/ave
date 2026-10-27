import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { useBrowserObservation, useBrowserObservationPreviewStore } from "./browser-observation-bridge.js";
import { isElementShown, type PreviewBinding } from "./browser-observation-preview.js";

const VISIBILITY_POLL_MS = 250;
const noSubscription = () => () => {};

/**
 * Tracks whether an element is actually painted for the user. Being mounted is not enough: a panel kept mounted under
 * `display: none`, `visibility: hidden`, zero opacity, zero size or outside the viewport, and a hidden document, all
 * count as not shown. The poll catches ancestor style changes that no observer reports.
 */
function useElementShown(element: Element | null, probe: (element: Element) => boolean = isElementShown): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!element) { setShown(false); return undefined; }
    const check = (): void => setShown(probe(element));
    check();
    const timer = setInterval(check, VISIBILITY_POLL_MS);
    const view = element.ownerDocument.defaultView;
    element.ownerDocument.addEventListener("visibilitychange", check);
    view?.addEventListener("resize", check);
    const intersection = typeof IntersectionObserver === "function" ? new IntersectionObserver(check) : undefined;
    intersection?.observe(element);
    return () => {
      clearInterval(timer);
      element.ownerDocument.removeEventListener("visibilitychange", check);
      view?.removeEventListener("resize", check);
      intersection?.disconnect();
    };
  }, [element, probe]);
  return shown;
}

/**
 * A live picture of the agent's tab where that tab is open in another panel. It binds to the exact main-issued tab
 * handle and observation target of the latest agent action for this renderer tab, runs only while shown, and keeps
 * no frame after it stops. Without an agent binding it renders `children` unchanged.
 */
export function BrowserObservationPreview({ tabId, sessionId, children, probe }: {
  tabId: string;
  sessionId?: string;
  children?: ReactNode;
  probe?: (element: Element) => boolean;
}) {
  const { t } = useTranslation();
  const event = useBrowserObservation(tabId, sessionId);
  const store = useBrowserObservationPreviewStore();
  const agentAction = event?.kind === "action" && event.after.rendererTabId === tabId && event.after.action !== "tab-close";
  const targetId = agentAction ? event.target.id : "";
  const actingSession = agentAction ? event.sessionId : "";
  const handle = agentAction ? event.after.tabId : "";
  const seq = agentAction ? event.seq : 0;
  const binding = useMemo<PreviewBinding | undefined>(() => targetId ? { targetId, sessionId: actingSession, tabId: handle } : undefined,
    [targetId, actingSession, handle]);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const shown = useElementShown(binding && store ? element : null, probe);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.get(binding), () => undefined);

  // Stop when hidden, unmounted, rebound or disconnected; the store drops the frame with the request.
  useEffect(() => {
    if (!store || !binding || !shown) return undefined;
    return () => store.stop(binding);
  }, [store, binding, shown]);
  // Each new agent action may resume a preview the host parked after idling.
  useEffect(() => {
    if (store && binding && shown) store.start(binding);
  }, [store, binding, shown, seq]);

  if (!binding || !store) return <>{children}</>;
  const frame = state?.frame;
  return <div ref={setElement} data-testid="browser-observation-preview" className="relative h-full min-h-0 w-full"
    data-preview-state={frame ? state?.updating ? "updating" : "live" : state?.status ?? "idle"}>
    {frame ? <img src={frame.src} alt={t("agentBrowser.observationPreview")} draggable={false}
      className="pointer-events-none h-full w-full select-none object-contain"
      onLoad={() => store.rendered(binding, frame.frame)} onError={() => store.rendered(binding, frame.frame)} /> : children}
    {frame && state?.updating ? <span data-testid="browser-observation-preview-updating"
      className="absolute right-2 top-2 rounded bg-background/(--opacity-emphatic) px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {t("agentBrowser.observationPreviewUpdating")}
    </span> : null}
  </div>;
}
