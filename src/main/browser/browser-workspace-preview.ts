import type { NativeImage, WebContents } from "electron";
import { BROWSER_WORKSPACE_LIMITS, type BrowserPreview, type BrowserWorkspaceTarget } from "../../shared/browser-workspace.js";

export interface BrowserPreviewTarget { readonly guest: Pick<WebContents, "id" | "isDestroyed" | "capturePage">; readonly documentGeneration: number }
export interface BrowserWorkspacePreviewDeps {
  liveTab(windowId: number, tabId: string): BrowserPreviewTarget | null;
  isWindowVisible(windowId: number): boolean;
  now?: () => number;
}
const CAPTURE_INTERVAL_MS = 1500;
const CACHE_TTL_MS = 10_000;
const CACHE_LIMIT = 16;

export class BrowserWorkspacePreview {
  private readonly inFlight = new Set<number>();
  private readonly epochs = new Map<number, object>();
  private readonly lastCapture = new Map<number, number>();
  private readonly cache = new Map<string, { preview: BrowserPreview; guestId: number; at: number; windowId: number }>();
  constructor(private readonly deps: BrowserWorkspacePreviewDeps) {}
  invalidateWindow(windowId: number): void {
    this.epochs.set(windowId, {});
    for (const [key, entry] of this.cache) if (entry.windowId === windowId) this.cache.delete(key);
  }
  invalidateGuest(guestId: number): void {
    for (const [key, entry] of this.cache) if (entry.guestId === guestId) this.cache.delete(key);
  }
  disposeWindow(windowId: number): void {
    this.invalidateWindow(windowId);
    this.epochs.delete(windowId);
    this.lastCapture.delete(windowId);
  }
  async capture(windowId: number, request: BrowserWorkspaceTarget): Promise<BrowserPreview> {
    const target = this.deps.liveTab(windowId, request.tabId);
    if (!target || target.guest.isDestroyed()) throw new Error("no-such-tab");
    if (target.documentGeneration !== request.documentGeneration) throw new Error("stale-document");
    if (!this.deps.isWindowVisible(windowId)) { this.invalidateWindow(windowId); throw new Error("window-hidden"); }
    const now = (this.deps.now ?? Date.now)();
    const key = `${windowId}:${request.tabId}:${request.documentGeneration}`;
    const cached = this.cache.get(key);
    if (cached && cached.guestId === target.guest.id && now - cached.at < CACHE_TTL_MS) return cached.preview;
    if (this.inFlight.has(windowId)) throw new Error("capture-busy");
    if (now - (this.lastCapture.get(windowId) ?? -Infinity) < CAPTURE_INTERVAL_MS) throw new Error("capture-throttled");
    const epoch = this.epochs.get(windowId) ?? {};
    this.epochs.set(windowId, epoch);
    const valid = () => {
      const live = this.deps.liveTab(windowId, request.tabId);
      return this.deps.isWindowVisible(windowId) && this.epochs.get(windowId) === epoch && live?.guest === target.guest && !target.guest.isDestroyed() && live.documentGeneration === request.documentGeneration;
    };
    this.inFlight.add(windowId);
    this.lastCapture.set(windowId, now);
    try {
      let image: NativeImage;
      try { image = await target.guest.capturePage(undefined, { stayHidden: true, stayAwake: false }); }
      catch { throw new Error("capture-unavailable"); }
      if (!valid()) throw new Error("stale-document");
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new Error("capture-unavailable");
      const scale = Math.min(1, BROWSER_WORKSPACE_LIMITS.previewWidth / size.width, BROWSER_WORKSPACE_LIMITS.previewHeight / size.height);
      const width = Math.max(1, Math.floor(size.width * scale));
      const height = Math.max(1, Math.floor(size.height * scale));
      const bytes = image.resize({ width, height, quality: "good" }).toJPEG(65);
      if (bytes.byteLength > BROWSER_WORKSPACE_LIMITS.previewBytes || !valid()) throw new Error("capture-unavailable");
      const preview: BrowserPreview = { ...request, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`, width, height };
      this.cache.set(key, { preview, guestId: target.guest.id, at: now, windowId });
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return preview;
    } finally { this.inFlight.delete(windowId); }
  }
}
