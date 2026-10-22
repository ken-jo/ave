import { useEffect, useRef, useState } from "react";
import type { BrowserPreview, BrowserWorkspaceApi, BrowserWorkspaceTab } from "../../../shared/browser-workspace.js";
import { browserPreviewScheduler } from "../hooks/browser-preview-scheduler.js";

export function BrowserWorkspaceCard({ api, tab, visible, mode }: { api: BrowserWorkspaceApi; tab: BrowserWorkspaceTab; visible: boolean; mode: string }) {
  const ref = useRef<HTMLLIElement>(null);
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
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
  return <li ref={ref} className="min-w-0 rounded border p-2" data-tab-id={tab.tabId}>
    {preview && <img src={preview.dataUrl} width={preview.width} height={preview.height} alt="" className="mb-1 max-w-full rounded" />}
    <div className="truncate font-medium" title={tab.url}>{tab.title || tab.url}</div>
    <div className="truncate text-muted-foreground">{tab.url}</div>
    <span className="text-muted-foreground">{mode}</span>
  </li>;
}
