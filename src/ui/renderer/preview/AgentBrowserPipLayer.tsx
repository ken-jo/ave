import { Globe, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { clampBrowserPipPosition, type BrowserPipArea, type BrowserPipPoint } from "./browser-pip-position.js";
import { beginSurfaceDrag, endSurfaceDrag, getWebSurfaceSlot, subscribeWebSurfaceLayout,
  subscribeWebSurfaces, getWebSurfaces, webSurfaceFavicon } from "./web-surfaces.js";
import { useWebSurfaceOccluder } from "./use-web-surface-occluder.js";

const LAYOUT_POLL_MS = 250;

function availableArea(): BrowserPipArea {
  const bodies = [...document.querySelectorAll<HTMLElement>("[data-pip-region]")]
    .filter(isElementShown).map((element) => element.getBoundingClientRect())
    .sort((a, b) => b.right - a.right || b.bottom - a.bottom);
  const body = bodies[0];
  if (!body) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.max(0, body.left); const right = Math.min(window.innerWidth, body.right);
  const top = Math.max(0, body.top);
  let bottom = Math.min(window.innerHeight, body.bottom);
  const reserve = (element: HTMLElement) => {
    if (getComputedStyle(element).display === "contents") {
      for (const child of element.children) reserve(child as HTMLElement);
    } else if (isElementShown(element)) {
      const rect = element.getBoundingClientRect();
      if (rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom) bottom = Math.min(bottom, rect.top);
    }
  };
  // Input and pending decisions always keep their controls, even when a card was dragged there.
  for (const element of document.querySelectorAll<HTMLElement>(
    `[data-testid="${TEST_IDS.composer}"], [data-pip-reservation], [data-web-surface-occluder="settle"] > *`,
  )) reserve(element);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function AgentBrowserPipCard({ tab, child, onOpen, visible, area }: {
  tab: BrowserTabControlView & { rendererTabId: string }; child?: AgentSpawnEvent | undefined; onOpen: (tabId: string) => void;
  visible: boolean; area: BrowserPipArea;
}) {
  const { t } = useTranslation();
  const tabId = tab.rendererTabId;
  const event = useBrowserObservation(tabId);
  // The host issues one observation target for an acting turn, shared by its actions on this tab.
  const turnBinding = event ? JSON.stringify([event.sessionId, event.target.id]) : undefined;
  const [dismissed, setDismissed] = useState<string>();
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
  const shown = eligible && !visible && dismissed !== turnBinding;
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!shown || !card || !position) return;
    const clamp = () => {
      const clamped = clampBrowserPipPosition(position, card.getBoundingClientRect(), area);
      if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(card);
    return () => observer.disconnect();
  }, [area, position, shown]);
  const rendered = shown && area.height > 0 && area.width > 0;
  useEffect(() => { if (!rendered) finishDrag(); return finishDrag; }, [rendered, finishDrag]);
  if (!rendered) return null;
  const title = event.after.title || tab.title || event.after.url;
  const favicon = webSurfaceFavicon(tabId);
  const hide = () => setDismissed(turnBinding);
  return <div ref={setCard}
    data-testid="agent-browser-pip-card" data-tab-id={tabId} data-compact={compact}
    className="pointer-events-auto relative shrink-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-(--elevation-floating)"
    style={{ width: 240, maxWidth: "100%", height: compact ? 40 : undefined,
      ...(position ? { position: "fixed", left: position.x, top: position.y } : {}) }}>
    <div className="min-w-0">
      <button type="button" aria-label={t("agentBrowser.openPreview", { title })}
        className="flex w-full min-w-0 touch-none select-none flex-col text-left focus-visible:outline focus-visible:outline-ring"
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
        <span className="flex h-10 w-full items-center gap-2 pl-2 pr-8 text-xs">
          {favicon ? <img src={favicon} alt="" draggable={false} className="size-4 shrink-0" /> : <Globe className="size-4 shrink-0" />}
          <span className="min-w-0 truncate">{child?.title ? `${child.title} · ${title}` : title}</span>
        </span>
        {!compact ? <><div className="relative w-full shrink-0 overflow-hidden" style={{ aspectRatio: "16 / 9" }} data-testid="agent-browser-pip-picture"><div className="absolute inset-0">
          <BrowserObservationPreview tabId={tabId} sessionId={event.sessionId} observeHidden thumbnail>
            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("agentBrowser.observationPreviewUpdating")}</span>
          </BrowserObservationPreview>
        </div></div><div className="w-full overflow-hidden"><BrowserObservationLiveStrip tabId={tabId} sessionId={event.sessionId} /></div></> : null}
      </button>
      <button type="button" aria-label={t("agentBrowser.hidePreview", { title })} onClick={hide}
        className="absolute right-0 top-0 flex size-7 items-center justify-center rounded hover:bg-accent focus-visible:outline focus-visible:outline-ring">
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
      setArea((previous) => previous.width === next.width && previous.height === next.height
        && previous.left === next.left && previous.top === next.top ? previous : next);
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
  return <div data-testid="agent-browser-pip-layer"
    className="pointer-events-none fixed z-30 flex flex-col-reverse items-end gap-2 overflow-hidden p-8 pb-12"
    style={{ left: area.left, top: area.top, width: area.width, height: area.height }}>
    {!unavailable ? control.tabs.flatMap((tab) => {
      if (tab.kind !== "embedded" || tab.rendererTabId === null || !surfaces.some((surface) => surface.tabId === tab.rendererTabId)) return [];
      return <AgentBrowserPipCard key={tab.rendererTabId} tab={{ ...tab, rendererTabId: tab.rendererTabId }}
        child={children.get(tab.lease?.actor.sessionId ?? tab.owner?.sessionId ?? "")}
        visible={visibleTabs.includes(tab.rendererTabId)} area={area} onOpen={onOpen} />;
    }) : null}
  </div>;
}
