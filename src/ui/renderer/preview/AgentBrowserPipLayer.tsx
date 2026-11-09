import { Globe, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../../i18n/react.js";
import type { BrowserTabControlView } from "../../../shared/browser-surface.js";
import type { AgentSpawnEvent } from "../../../shared/subagent-events.js";
import { TEST_IDS } from "../../../shared/test-ids.js";
import type { AveApi } from "../types.js";
import { agentDrivesBrowserTab, useBrowserControlState, useBrowserControlUnavailable } from "./agent-browser-bridge.js";
import { useBrowserObservation } from "./browser-observation-bridge.js";
import { BrowserObservationLiveStrip } from "./BrowserObservationLiveStrip.js";
import { BrowserObservationPreview } from "./BrowserObservationPreview.js";
import { isElementShown } from "./browser-observation-preview.js";
import { clampBrowserPipPosition, type BrowserPipPoint } from "./browser-pip-position.js";
import { beginSurfaceDrag, endSurfaceDrag, getWebSurfaceSlot, subscribeWebSurfaceLayout,
  subscribeWebSurfaces, getWebSurfaces, webSurfaceFavicon } from "./web-surfaces.js";
import { useWebSurfaceOccluder } from "./use-web-surface-occluder.js";

const EDGE = 12;
const LAYOUT_POLL_MS = 250;
interface PipArea { width: number; height: number }

function availableArea() {
  let bottom = window.innerHeight - EDGE;
  const reserve = (element: HTMLElement) => {
    if (getComputedStyle(element).display === "contents") {
      for (const child of element.children) reserve(child as HTMLElement);
    } else if (isElementShown(element)) bottom = Math.min(bottom, element.getBoundingClientRect().top - EDGE);
  };
  // Input and pending decisions always keep their controls, even when a card was dragged there.
  for (const element of document.querySelectorAll<HTMLElement>(
    `[data-testid="${TEST_IDS.composer}"], [data-web-surface-occluder="settle"] > *`,
  )) reserve(element);
  return { width: window.innerWidth, height: Math.max(0, bottom) };
}

function AgentBrowserPipCard({ tab, child, onOpen, visible, area }: {
  tab: BrowserTabControlView & { rendererTabId: string }; child?: AgentSpawnEvent | undefined; onOpen: (tabId: string) => void;
  visible: boolean; area: PipArea;
}) {
  const { t } = useTranslation();
  const tabId = tab.rendererTabId;
  const event = useBrowserObservation(tabId);
  const [dismissed, setDismissed] = useState<typeof event>();
  const [position, setPosition] = useState<BrowserPipPoint | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; start: BrowserPipPoint; origin: BrowserPipPoint; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const setOccluder = useWebSurfaceOccluder(position);
  const setCard = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element;
    setOccluder(element);
  }, [setOccluder]);
  const compact = area.width < 480;
  const finishDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    endSurfaceDrag();
  }, []);

  useEffect(() => { if (visible) setDismissed(undefined); }, [visible]);
  const eligible = event?.kind === "action" && event.after.action !== "tab-close" && event.after.tabId === tab.tabId
    && agentDrivesBrowserTab(tab, event.sessionId) && child?.type !== "done" && child?.type !== "error";
  const shown = eligible && !visible && dismissed !== event;
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!shown || !card || !position) return;
    const clamped = clampBrowserPipPosition(position, card.getBoundingClientRect(), area);
    if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
  }, [area, position, shown]);
  const rendered = shown && area.height >= (compact ? 40 : 150);
  useEffect(() => { if (!rendered) finishDrag(); return finishDrag; }, [rendered, finishDrag]);
  if (!rendered) return null;
  const title = event.after.title || tab.title || event.after.url;
  const favicon = webSurfaceFavicon(tabId);
  const hide = () => setDismissed(event);
  return <div ref={setCard}
    data-testid="agent-browser-pip-card" data-tab-id={tabId} data-compact={compact}
    className="pointer-events-auto shrink-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-(--elevation-floating)"
    style={{ width: Math.min(240, Math.max(0, area.width - EDGE * 2)), height: compact ? 40 : 150,
      ...(position ? { position: "fixed", left: position.x, top: position.y } : {}) }}>
    <div className="flex h-full min-w-0">
      <button type="button" aria-label={t("agentBrowser.openPreview", { title })}
        className="flex min-w-0 flex-1 touch-none select-none flex-col text-left focus-visible:outline focus-visible:outline-ring"
        onKeyDown={(e) => { if (e.key === "Delete") { e.preventDefault(); hide(); } }}
        onClick={(e) => { if (e.detail === 0 || !suppressClick.current) onOpen(tabId); suppressClick.current = false; }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary || !cardRef.current) return;
          const rect = cardRef.current.getBoundingClientRect();
          suppressClick.current = false;
          drag.current = { pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY },
            origin: { x: rect.left, y: rect.top }, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          beginSurfaceDrag();
        }}
        onPointerMove={(e) => {
          const current = drag.current;
          if (!current || current.pointerId !== e.pointerId || !cardRef.current) return;
          const dx = e.clientX - current.start.x; const dy = e.clientY - current.start.y;
          if (!current.moved && Math.hypot(dx, dy) < 4) return;
          current.moved = true;
          suppressClick.current = true;
          setPosition(clampBrowserPipPosition({ x: current.origin.x + dx, y: current.origin.y + dy },
            cardRef.current.getBoundingClientRect(), availableArea()));
        }}
        onLostPointerCapture={finishDrag}
        onPointerUp={(e) => { finishDrag(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={(e) => { suppressClick.current = false; finishDrag(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}>
        <span className="flex min-h-10 w-full items-center gap-2 px-2 text-xs">
          {favicon ? <img src={favicon} alt="" draggable={false} className="size-4 shrink-0" /> : <Globe className="size-4 shrink-0" />}
          <span className="min-w-0 truncate">{child?.title ? `${child.title} · ${title}` : title}</span>
        </span>
        {!compact ? <><div className="min-h-0 w-full flex-1">
          <BrowserObservationPreview tabId={tabId} sessionId={event.sessionId} observeHidden>
            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("agentBrowser.observationPreviewUpdating")}</span>
          </BrowserObservationPreview>
        </div><div className="w-full overflow-hidden"><BrowserObservationLiveStrip tabId={tabId} sessionId={event.sessionId} /></div></> : null}
      </button>
      <button type="button" aria-label={t("agentBrowser.hidePreview", { title })} onClick={hide}
        className="flex size-7 shrink-0 items-center justify-center self-start rounded hover:bg-accent focus-visible:outline focus-visible:outline-ring">
        <X className="size-3.5" />
      </button>
    </div>
  </div>;
}

/** One transient window layer; pictures use the existing observation subscription and guest. */
export function AgentBrowserPipLayer({ api, onOpen }: { api: AveApi; onOpen: (tabId: string) => void }) {
  const control = useBrowserControlState();
  const unavailable = useBrowserControlUnavailable();
  const surfaces = useSyncExternalStore(subscribeWebSurfaces, getWebSurfaces);
  const [children, setChildren] = useState<ReadonlyMap<string, AgentSpawnEvent>>(new Map());
  const [area, setArea] = useState(availableArea);
  const [visibleTabs, setVisibleTabs] = useState<readonly string[]>([]);
  useEffect(() => api.onAgentSpawnEvent((event) => {
    const childSessionId = event.childSessionId;
    if (childSessionId) setChildren((previous) => new Map(previous).set(childSessionId,
      { ...previous.get(childSessionId), ...event }));
  }), [api]);
  useEffect(() => {
    const check = () => {
      const next = availableArea();
      setArea((previous) => previous.width === next.width && previous.height === next.height ? previous : next);
      const visible = getWebSurfaces().filter(({ tabId }) => {
        const slot = getWebSurfaceSlot(tabId);
        return slot !== null && isElementShown(slot);
      }).map(({ tabId }) => tabId);
      setVisibleTabs((previous) => previous.length === visible.length && previous.every((id, index) => id === visible[index]) ? previous : visible);
    };
    check();
    const off = subscribeWebSurfaceLayout(check);
    // Panel visibility commits after slot registration. Catch even a brief activation between polling ticks.
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-hidden"] });
    const timer = window.setInterval(check, LAYOUT_POLL_MS);
    window.addEventListener("resize", check);
    return () => { off(); observer.disconnect(); window.clearInterval(timer); window.removeEventListener("resize", check); };
  }, []);
  return createPortal(<div data-testid="agent-browser-pip-layer"
    className="pointer-events-none fixed right-3 top-3 z-40 flex max-w-full flex-col-reverse items-end gap-2 overflow-y-auto"
    style={{ height: Math.max(0, area.height - EDGE) }}>
    {!unavailable ? control.tabs.flatMap((tab) => {
      if (tab.kind !== "embedded" || tab.rendererTabId === null || !surfaces.some((surface) => surface.tabId === tab.rendererTabId)) return [];
      return <AgentBrowserPipCard key={tab.rendererTabId} tab={{ ...tab, rendererTabId: tab.rendererTabId }}
        child={children.get(tab.lease?.actor.sessionId ?? tab.owner?.sessionId ?? "")}
        visible={visibleTabs.includes(tab.rendererTabId)} area={area} onOpen={onOpen} />;
    }) : null}
  </div>, document.body);
}
