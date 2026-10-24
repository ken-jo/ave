import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { BrowserFavicon } from "./BrowserFavicon.js";
import type { BrowserPreview, BrowserWorkspaceApi, BrowserWorkspaceTab } from "../../../shared/browser-workspace.js";
import { browserPreviewScheduler } from "../hooks/browser-preview-scheduler.js";
import { useTranslation } from "../../../i18n/react.js";
import { subscribeWebSurfaces, webSurfaceFavicon } from "../preview/web-surfaces.js";

export function BrowserWorkspaceCard({ api, tab, visible, mode, active = false, onOpen, onClose }: {
  api: BrowserWorkspaceApi;
  tab: BrowserWorkspaceTab;
  visible: boolean;
  mode: string;
  active?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const favicon = useSyncExternalStore(subscribeWebSurfaces, () => webSurfaceFavicon(tab.tabId), () => null);
  useEffect(() => {
    const element = ref.current;
    setPreview(null);
    if (!element || !visible) return;
    let intersecting = false;
    let unregister: (() => void) | null = null;
    const synchronize = () => {
      unregister?.(); unregister = null;
      if (intersecting && element.isConnected && document.visibilityState === "visible") unregister = browserPreviewScheduler(api).register(element, { tabId: tab.tabId, documentGeneration: tab.documentGeneration }, setPreview);
      else setPreview(null);
    };
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.target === element && entry.isIntersecting && entry.intersectionRatio > 0);
      synchronize();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", synchronize);
    return () => { unregister?.(); observer.disconnect(); document.removeEventListener("visibilitychange", synchronize); };
  }, [api, tab.tabId, tab.documentGeneration, visible]);
  const title = tab.title || tab.url;
  const content = <>
    <span className={`mb-1 flex min-w-0 items-center gap-1.5 ${onClose ? "pr-6" : ""}`}>
      <BrowserFavicon source={favicon} />
      <span className="min-w-0 flex-1 truncate font-medium" title={tab.url}>{title}</span>
    </span>
    {preview && <img src={preview.dataUrl} width={preview.width} height={preview.height} alt="" className="mb-1 max-w-full rounded" />}
    <span className="block truncate text-muted-foreground">{tab.url}</span>
    <span className="block text-muted-foreground">{mode}</span>
  </>;
  return <li ref={ref} className={`relative min-w-0 rounded border ${active ? "border-primary bg-accent" : ""}`} data-tab-id={tab.tabId} data-active={active}>
    {onOpen ? <button type="button" className="block w-full min-w-0 p-2 text-left" aria-label={title} aria-pressed={active} onClick={onOpen}>{content}</button>
      : <div className="p-2">{content}</div>}
    {onClose && <button type="button" className="absolute right-1 top-1 rounded p-1 hover:bg-accent" aria-label={t("chatPreviewRail.closeTab")} title={t("chatPreviewRail.closeTab")} onClick={onClose}><X aria-hidden="true" className="size-3.5" /></button>}
  </li>;
}
