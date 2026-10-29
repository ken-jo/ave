import { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../../i18n/react.js";
import { formatRelativeSessionTime } from "../../../shared/format-time.js";

export type SidebarPreviewData =
  | { kind: "browser"; title: string; url?: string; imageDataUrl?: string }
  | { kind: "conversation"; title: string; message?: string; modifiedAt: string | number; running?: boolean }
  | { kind: "terminal"; title: string; command?: string };

interface PreviewRequest {
  id: string;
  data: SidebarPreviewData;
  anchor: HTMLElement;
  loadPreview?: () => Promise<SidebarPreviewData>;
}
interface PreviewContextValue {
  activeId: string | undefined;
  show: (request: PreviewRequest, immediate: boolean) => void;
  hide: (leaving?: boolean, id?: string) => void;
}
const PreviewContext = createContext<PreviewContextValue | null>(null);

/** One window-local display channel; preview text is never added to conversation state. */
export function SidebarPreviewProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<PreviewRequest | null>(null);
  const activeRef = useRef<PreviewRequest | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warmUntil = useRef(0);
  const revision = useRef(0);
  const requestedId = useRef<string | undefined>(undefined);
  const hide = useCallback((leaving = false, id?: string) => {
    if (id && requestedId.current !== id) return;
    requestedId.current = undefined;
    clearTimeout(timer.current);
    revision.current += 1;
    if (leaving && activeRef.current) warmUntil.current = Date.now() + 100;
    else if (!leaving) warmUntil.current = 0;
    activeRef.current = null;
    setActive(null);
  }, []);
  const show = useCallback((request: PreviewRequest, immediate: boolean) => {
    requestedId.current = request.id;
    clearTimeout(timer.current);
    const currentRevision = ++revision.current;
    const reveal = () => {
      activeRef.current = request;
      setActive(request);
      if (request.loadPreview) {
        void request.loadPreview().then((data) => {
          if (revision.current !== currentRevision) return;
          const resolved = { ...request, data };
          activeRef.current = resolved;
          setActive(resolved);
        }).catch((error: unknown) => console.error("Sidebar preview unavailable", error));
      }
    };
    if (immediate || activeRef.current || Date.now() < warmUntil.current) reveal();
    else timer.current = setTimeout(reveal, 500);
  }, []);
  useEffect(() => {
    const dismiss = () => hide();
    const handleScroll = (event: Event) => {
      const boundary = activeRef.current?.anchor.closest("[data-sidebar-preview-boundary]");
      if (event.target === window || event.target === document || (event.target instanceof Node && boundary?.contains(event.target))) hide();
    };
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("resize", dismiss);
    return () => {
      clearTimeout(timer.current);
      revision.current += 1;
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", dismiss);
    };
  }, [hide]);
  const rect = active?.anchor.getBoundingClientRect();
  const sidebarRect = active?.anchor.closest("[data-sidebar-preview-boundary]")?.getBoundingClientRect();
  return <PreviewContext.Provider value={{ activeId: active?.id, show, hide }}>
    {children}
    {active && rect && createPortal(<div
      className="pointer-events-none fixed z-50 w-[300px] max-w-[calc(100vw-16px)]"
      style={{ left: Math.min((sidebarRect?.right ?? rect.right) + 10, Math.max(8, window.innerWidth - 308)), top: Math.max(8, Math.min(rect.top, window.innerHeight - (active.data.kind === "browser" && active.data.imageDataUrl ? 250 : 140))) }}
    ><SidebarPreviewCard id={active.id} preview={active.data} /></div>, document.body)}
  </PreviewContext.Provider>;
}

/** The direct child must forward standard DOM event and ARIA attributes to its entry. */
export function SidebarPreviewTrigger({ preview, loadPreview, children }: {
  preview: SidebarPreviewData;
  loadPreview?: () => Promise<SidebarPreviewData>;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const context = useContext(PreviewContext);
  const id = useId();
  if (!context) return children;
  const original = children.props;
  const show = (anchor: HTMLElement, immediate: boolean) => context.show({ id, data: preview, anchor, loadPreview }, immediate);
  return cloneElement(children, {
    "aria-describedby": context.activeId === id ? [original["aria-describedby"], id].filter(Boolean).join(" ") : original["aria-describedby"],
    onPointerEnter: (event) => { original.onPointerEnter?.(event); show(event.currentTarget, false); },
    onPointerLeave: (event) => { original.onPointerLeave?.(event); context.hide(true, id); },
    onFocus: (event) => { original.onFocus?.(event); show(event.currentTarget, true); },
    onBlur: (event) => { original.onBlur?.(event); context.hide(false, id); },
    onClick: (event) => { original.onClick?.(event); context.hide(); },
  });
}

export function SidebarPreviewCard({ id, preview }: { id: string; preview: SidebarPreviewData }) {
  const { t } = useTranslation();
  let domain = "";
  if (preview.kind === "browser" && preview.url) {
    const url = new URL(preview.url);
    domain = url?.protocol === "file:" ? t("sidebarPreview.localFile") : url?.hostname ?? "";
  }
  return <div id={id} role="tooltip" data-testid="sidebar-preview" className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl text-[13px] motion-reduce:transition-none">
    {preview.kind === "browser" && preview.imageDataUrl && <img className="h-[150px] w-full object-cover object-top border-b border-border" src={preview.imageDataUrl} alt="" />}
    {preview.kind === "terminal" && preview.command && <div className="px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap" style={{ background: "hsl(var(--p-code-dark-bg))", color: "hsl(var(--p-code-dark-fg))" }}>❯ {preview.command}</div>}
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="font-semibold break-words">{preview.title}</div>
      {preview.kind === "browser" && domain && <div className="text-xs text-muted-foreground">{domain}</div>}
      {preview.kind === "conversation" && <>
        {preview.message && <div className="line-clamp-2 break-words">{preview.message}</div>}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{formatRelativeSessionTime(preview.modifiedAt, t)}</span>
          {preview.running && <span className="rounded-full border border-border px-1.5 text-[11px]">{t("sidebarPreview.running")}</span>}
        </div>
      </>}
    </div>
  </div>;
}
