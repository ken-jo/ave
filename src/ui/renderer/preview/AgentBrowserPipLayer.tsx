import { Globe, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "../../../i18n/react.js";
import type { BrowserObservationEvent } from "../../../shared/agent-observation.js";
import type { AgentSpawnEvent } from "../../../shared/subagent-events.js";
import { TEST_IDS } from "../../../shared/test-ids.js";
import type { AveApi } from "../types.js";
import { agentDrivesBrowserTab, useBrowserControlState, useBrowserControlUnavailable } from "./agent-browser-bridge.js";
import { useBrowserObservations } from "./browser-observation-bridge.js";
import { BrowserObservationLiveStrip } from "./BrowserObservationLiveStrip.js";
import { BrowserObservationPreview } from "./BrowserObservationPreview.js";
import { isElementShown } from "./browser-observation-preview.js";
import { clampBrowserPipPosition, type BrowserPipArea, type BrowserPipPoint } from "./browser-pip-position.js";
import { beginSurfaceDrag, endSurfaceDrag, getWebSurfaceSlot, subscribeWebSurfaceLayout,
  subscribeWebSurfaces, getWebSurfaces, webSurfaceFavicon } from "./web-surfaces.js";
import { useWebSurfaceOccluder } from "./use-web-surface-occluder.js";
import { planBrowserPipStack, type BrowserPipPresentation } from "./browser-pip-layout.js";

const LAYOUT_POLL_MS = 250;
const CARD_CLASS = "pointer-events-auto relative shrink-0 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-(--elevation-floating)";
const HEADER_CLASS = "flex h-10 w-full items-center gap-2 pl-2 pr-8 text-xs";
type BrowserPipEvent = BrowserObservationEvent & { kind: "action" };
interface PipMeasurements { width: number; previewHeight: number; chipHeight: number; gap: number; bounds: BrowserPipArea }
function turnBindingOf(event: BrowserPipEvent): string { return JSON.stringify([event.sessionId, event.target.id]); }
function cssNumber(value: string): number { return Number.parseFloat(value) || 0; }

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

function AgentBrowserPipCard({ tabId, event, child, onOpen, onHide, mode, measurements }: {
  tabId: string; event: BrowserPipEvent; child?: AgentSpawnEvent | undefined; onOpen: (tabId: string) => void;
  onHide: (tabId: string, binding: string) => void; mode: BrowserPipPresentation; measurements: PipMeasurements;
}) {
  const { t } = useTranslation();
  const { bounds, width } = measurements;
  const [position, setPosition] = useState<BrowserPipPoint | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; start: BrowserPipPoint; origin: BrowserPipPoint; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const setOccluder = useWebSurfaceOccluder(position);
  const setCard = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element;
    setOccluder(element);
  }, [setOccluder]);
  const compact = mode === "chip";
  const rendered = mode !== "hidden";
  const finishDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    endSurfaceDrag();
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!rendered || !card || !position) return;
    const clamp = () => {
      const clamped = clampBrowserPipPosition(position, card.getBoundingClientRect(), bounds);
      if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(card);
    return () => observer.disconnect();
  }, [bounds, position, rendered]);
  useEffect(() => { if (!rendered) finishDrag(); return finishDrag; }, [rendered, finishDrag]);
  if (!rendered) return null;
  const title = event.after.title || event.after.url;
  const favicon = webSurfaceFavicon(tabId);
  const hide = () => onHide(tabId, turnBindingOf(event));
  return <div className="shrink-0" style={{ width, height: compact ? measurements.chipHeight : measurements.previewHeight }}>
    <div ref={setCard}
    data-testid="agent-browser-pip-card" data-tab-id={tabId} data-compact={compact}
    className={CARD_CLASS}
    style={{ width, maxWidth: "100%",
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
            cardRef.current.getBoundingClientRect(), bounds));
        }}
        onLostPointerCapture={finishDrag}
        onPointerUp={(e) => { finishDrag(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={(e) => { suppressClick.current = false; finishDrag(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}>
        <span className={HEADER_CLASS}>
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
    </div>
  </div>;
}

/** One transient window layer; pictures use the existing observation subscription and guest. */
export function AgentBrowserPipLayer({ api, onOpen }: { api: AveApi; onOpen: (tabId: string) => void }) {
  const { t } = useTranslation();
  const control = useBrowserControlState();
  const unavailable = useBrowserControlUnavailable();
  const observations = useBrowserObservations();
  const surfaces = useSyncExternalStore(subscribeWebSurfaces, getWebSurfaces);
  const [children, setChildren] = useState<ReadonlyMap<string, AgentSpawnEvent>>(new Map());
  const [area, setArea] = useState(availableArea);
  const [visibleTabs, setVisibleTabs] = useState<readonly string[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, string>>(new Map());
  const [measurements, setMeasurements] = useState<PipMeasurements | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const handleHide = useCallback((tabId: string, binding: string) => {
    setDismissed((previous) => new Map(previous).set(tabId, binding));
  }, []);
  useLayoutEffect(() => {
    const live = new Set(control.tabs.map((tab) => tab.rendererTabId));
    setDismissed((previous) => {
      const next = new Map([...previous].filter(([id]) => live.has(id) && !visibleTabs.includes(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [control.tabs, visibleTabs]);
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
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-hidden"] });
    const timer = window.setInterval(check, LAYOUT_POLL_MS);
    window.addEventListener("resize", check);
    return () => { off(); observer.disconnect(); window.clearInterval(timer); window.removeEventListener("resize", check); };
  }, []);
  useLayoutEffect(() => {
    const layer = layerRef.current; const probe = measureRef.current;
    if (!layer || !probe) return;
    const measure = () => {
      const rect = layer.getBoundingClientRect(); const style = getComputedStyle(layer);
      const left = cssNumber(style.paddingLeft); const right = cssNumber(style.paddingRight);
      const top = cssNumber(style.paddingTop); const bottom = cssNumber(style.paddingBottom);
      const width = Math.min(240, Math.max(0, rect.width - left - right));
      if (probe.style.width !== `${width}px`) probe.style.width = `${width}px`;
      const header = probe.firstElementChild;
      if (!header) return;
      const box = probe.getBoundingClientRect(); const border = getComputedStyle(probe);
      const borderHeight = cssNumber(border.borderTopWidth) + cssNumber(border.borderBottomWidth);
      const innerWidth = Math.max(0, box.width - cssNumber(border.borderLeftWidth) - cssNumber(border.borderRightWidth));
      const next: PipMeasurements = { width, chipHeight: header.getBoundingClientRect().height + borderHeight,
        previewHeight: box.height + innerWidth * 9 / 16, gap: cssNumber(style.rowGap),
        bounds: { left: rect.left + left, top: rect.top + top, width: Math.max(0, rect.width - left - right),
          height: Math.max(0, Math.min(rect.height, area.height) - top - bottom) } };
      setMeasurements((previous) => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(layer); observer.observe(probe);
    return () => observer.disconnect();
  }, [area]);
  const candidates = unavailable ? [] : observations.flatMap((event) => {
    if (event.kind !== "action" || event.after.action === "tab-close") return [];
    const tabId = event.after.rendererTabId;
    if (!tabId || visibleTabs.includes(tabId) || dismissed.get(tabId) === turnBindingOf(event)
      || !surfaces.some((surface) => surface.tabId === tabId)) return [];
    const tab = control.tabs.find((entry) => entry.kind === "embedded" && entry.rendererTabId === tabId && entry.tabId === event.after.tabId);
    if (!tab || !agentDrivesBrowserTab(tab, event.sessionId)) return [];
    const child = children.get(event.sessionId);
    if (child?.type === "done" || child?.type === "error") return [];
    return [{ tabId, event, child }];
  }).sort((a, b) => b.event.ts - a.event.ts || b.event.seq - a.event.seq || a.tabId.localeCompare(b.tabId));
  const plan = measurements ? planBrowserPipStack(candidates.length, window.innerWidth < 480,
    { ...measurements, height: measurements.bounds.height }) : { previewCount: 0, chipCount: 0, summaryCount: 0 };
  const shownCount = plan.previewCount + plan.chipCount;
  const overflow = plan.summaryCount > 0 ? candidates[shownCount] : undefined;
  return <div ref={layerRef} data-testid="agent-browser-pip-layer"
    className="pointer-events-none fixed z-30 flex flex-col-reverse items-end gap-2 overflow-hidden p-8 pb-12"
    style={{ left: area.left, top: area.top, width: area.width, height: area.height }}>
    {/* Measure the same header and reserved h-7 activity chrome without subscribing to frames. */}
    <div ref={measureRef} aria-hidden="true" inert data-pip-measure
      className={CARD_CLASS} style={{ position: "absolute", visibility: "hidden", pointerEvents: "none" }}>
      <span className={HEADER_CLASS} data-pip-measure-header />
      <div className="h-7" />
    </div>
    {measurements ? candidates.map((candidate, index) => <AgentBrowserPipCard key={candidate.tabId} {...candidate}
      onOpen={onOpen} onHide={handleHide} measurements={measurements}
      mode={index < plan.previewCount ? "preview" : index < shownCount ? "chip" : "hidden"} />) : null}
    {overflow && measurements ? <button type="button" data-testid="agent-browser-pip-overflow"
      className={CARD_CLASS} style={{ width: measurements.width }}
      aria-label={t("agentBrowser.openHiddenPreviews", { count: plan.summaryCount })} onClick={() => onOpen(overflow.tabId)}>
      <span className={HEADER_CLASS}>+{plan.summaryCount}</span>
    </button> : null}
  </div>;
}
