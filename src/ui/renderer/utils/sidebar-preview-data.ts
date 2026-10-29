import { browserPreviewScheduler } from "../hooks/browser-preview-scheduler.js";
import type { SidebarSurface } from "../hooks/use-sidebar-items.js";
import type { SidebarPreviewData } from "../components/SidebarPreview.js";

/** Read display data only after a card opens; never create or navigate a surface. */
export async function loadSidebarSurfacePreview(surface: SidebarSurface, title: string): Promise<SidebarPreviewData> {
  if (surface.kind === "terminal") {
    const result = await window.aveApi?.terminal?.preview(surface.tabId);
    return { kind: "terminal", title, ...(result?.ok && result.command ? { command: result.command } : {}) };
  }
  const base = { kind: "browser" as const, title, ...(surface.url ? { url: surface.url } : {}) };
  const api = window.aveApi?.browserWorkspace;
  if (!api) return base;
  const state = await api.getState();
  const tab = state.ok ? state.value.tabs.find((entry) => entry.tabId === surface.tabId) : undefined;
  if (!tab) return base;
  const preview = await browserPreviewScheduler(api).request({ tabId: tab.tabId, documentGeneration: tab.documentGeneration });
  return { ...base, title: tab.title || title, url: tab.url, ...(preview ? { imageDataUrl: preview.dataUrl } : {}) };
}
