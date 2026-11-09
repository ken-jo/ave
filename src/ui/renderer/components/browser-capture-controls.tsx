import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Camera } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BrowserCaptureRequest, BrowserWorkspaceApi, BrowserWorkspaceTab } from "../../../shared/browser-workspace.js";
import { attachImageToComposer } from "../preview/composer-targets.js";
import { getWebSurfaceElement } from "../preview/web-surfaces.js";

interface AreaSelection {
  tab: BrowserWorkspaceTab;
  bounds: { x: number; y: number; width: number; height: number };
}
interface Point { x: number; y: number }

function CaptureAreaOverlay({ selection, onCancel, onSelect }: {
  selection: AreaSelection;
  onCancel: () => void;
  onSelect: (clip: NonNullable<BrowserCaptureRequest["clip"]>) => void;
}) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  useEffect(() => {
    overlayRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    const handleOutsidePointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !overlayRef.current?.contains(event.target)) onCancel();
    };
    document.addEventListener("keydown", handleKey, true);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("resize", onCancel);
    window.addEventListener("blur", onCancel);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("resize", onCancel);
      window.removeEventListener("blur", onCancel);
    };
  }, [onCancel]);
  const point = (event: PointerEvent): Point => ({
    x: Math.max(0, Math.min(selection.bounds.width, event.clientX - selection.bounds.x)),
    y: Math.max(0, Math.min(selection.bounds.height, event.clientY - selection.bounds.y)),
  });
  const rectangle = start && end ? {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  } : null;
  return createPortal(<div ref={overlayRef} role="dialog" aria-label={t("browserCapture.area")} tabIndex={-1}
    data-testid="browser-capture-overlay" className="fixed z-50 cursor-crosshair touch-none select-none bg-background/(--opacity-light) outline-none"
    style={{ left: selection.bounds.x, top: selection.bounds.y, width: selection.bounds.width, height: selection.bounds.height }}
    onPointerDown={(event) => {
      if (event.button !== 0 || pointerIdRef.current !== null) return;
      event.preventDefault();
      pointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      const current = point(event);
      setStart(current); setEnd(current);
    }}
    onPointerMove={(event) => { if (start && pointerIdRef.current === event.pointerId) setEnd(point(event)); }}
    onPointerCancel={(event) => {
      if (pointerIdRef.current !== event.pointerId) return;
      pointerIdRef.current = null;
      onCancel();
    }}
    onPointerUp={(event) => {
      if (!start || pointerIdRef.current !== event.pointerId) return;
      pointerIdRef.current = null;
      const bounds = getWebSurfaceElement(selection.tab.tabId)?.getBoundingClientRect();
      if (!bounds || bounds.x !== selection.bounds.x || bounds.y !== selection.bounds.y
        || bounds.width !== selection.bounds.width || bounds.height !== selection.bounds.height) { onCancel(); return; }
      const current = point(event);
      const width = Math.abs(current.x - start.x), height = Math.abs(current.y - start.y);
      if (width < 1 || height < 1) { setStart(null); setEnd(null); return; }
      const zoom = selection.tab.zoomFactor;
      onSelect({ x: Math.min(current.x, start.x) / zoom, y: Math.min(current.y, start.y) / zoom, width: width / zoom, height: height / zoom });
    }}>
    <span className="pointer-events-none absolute left-2 top-2 rounded bg-popover px-2 py-1 text-xs text-popover-foreground shadow-e2">{t("browserCapture.areaHint")}</span>
    {rectangle ? <div data-testid="browser-capture-rectangle" className="pointer-events-none absolute border-2 border-primary bg-primary/(--opacity-subtle)"
      style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }} /> : null}
  </div>, document.body);
}

/** Captures are explicit user gestures and attach through the conversation's ordinary image slots. */
export function BrowserCaptureControls({ api, tabId, composerGroupId }: {
  api: BrowserWorkspaceApi;
  tabId: string;
  composerGroupId?: string | undefined;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<AreaSelection | null>(null);
  const cancelSelection = useCallback(() => setSelection(null), []);

  const capture = async (tab: BrowserWorkspaceTab, options: Pick<BrowserCaptureRequest, "fullPage" | "clip">) => {
    setSelection(null); setBusy(true); setFailed(false);
    try {
      if (options.clip) {
        const state = await api.getState();
        const current = state.ok ? state.value.tabs.find((entry) => entry.tabId === tab.tabId) : undefined;
        if (!current || current.documentGeneration !== tab.documentGeneration || current.zoomFactor !== tab.zoomFactor) {
          setFailed(true); return;
        }
      }
      const result = await api.capture({ tabId: tab.tabId, documentGeneration: tab.documentGeneration, ...options });
      if (!result.ok) { setFailed(true); return; }
      const base64 = result.value.dataUrl.split(",")[1];
      if (!base64) { setFailed(true); return; }
      const attached = await attachImageToComposer(base64, composerGroupId);
      if (attached !== true) setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const startCapture = async (mode: "viewport" | "full-page" | "area") => {
    setFailed(false); setBusy(true);
    try {
      const state = await api.getState();
      const tab = state.ok ? state.value.tabs.find((entry) => entry.tabId === tabId) : undefined;
      if (!tab) { setFailed(true); return; }
      if (mode !== "area") { await capture(tab, mode === "full-page" ? { fullPage: true } : {}); return; }
      const guest = getWebSurfaceElement(tabId);
      const rect = guest?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) { setFailed(true); return; }
      setSelection({ tab, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={busy}
          data-testid="browser-capture-menu"><Camera className="h-3.5 w-3.5" aria-hidden="true" />{t("browserCapture.capture")}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem data-testid="browser-capture-viewport" onSelect={() => void startCapture("viewport")}>{t("browserCapture.viewport")}</DropdownMenuItem>
        <DropdownMenuItem data-testid="browser-capture-full-page" onSelect={() => void startCapture("full-page")}>{t("browserCapture.fullPage")}</DropdownMenuItem>
        <DropdownMenuItem data-testid="browser-capture-area" onSelect={() => void startCapture("area")}>{t("browserCapture.area")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {failed ? <span role="alert" className="min-w-0 truncate text-dense text-destructive" title={t("browserCapture.failed")}>{t("browserCapture.failed")}</span> : null}
    {selection ? <CaptureAreaOverlay selection={selection} onCancel={cancelSelection} onSelect={(clip) => void capture(selection.tab, { clip })} /> : null}
  </>;
}
