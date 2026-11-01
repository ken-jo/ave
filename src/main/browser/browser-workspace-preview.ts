import type { NativeImage, WebContents } from "electron";
import { BROWSER_WORKSPACE_LIMITS, type BrowserPreview, type BrowserPreviewImage, type BrowserWorkspaceTarget } from "../../shared/browser-workspace.js";

interface BrowserPreviewTarget { readonly guest: Pick<WebContents, "id" | "isDestroyed" | "capturePage" | "getURL">; readonly documentGeneration: number }
export interface BrowserWorkspacePreviewDeps {
  liveTab(windowId: number, tabId: string): BrowserPreviewTarget | null;
  isWindowVisible(windowId: number): boolean;
  now?: () => number;
}
const CAPTURE_INTERVAL_MS = 1500;
const AGENT_CAPTURES_PER_WINDOW = 16;
// A live capture that cannot paint falls back to the agent's last capture of the same document.
const FALLBACK_ERRORS = new Set(["window-hidden", "capture-unavailable"]);

export function encodeBrowserPreview(image: NativeImage): BrowserPreviewImage | null {
  const size = image.getSize();
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) return null;
  const scale = Math.min(1, BROWSER_WORKSPACE_LIMITS.previewWidth / size.width, BROWSER_WORKSPACE_LIMITS.previewHeight / size.height);
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  const bytes = image.resize({ width, height, quality: "good" }).toJPEG(65);
  if (bytes.byteLength > BROWSER_WORKSPACE_LIMITS.previewBytes) return null;
  return { dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`, width, height };
}

export class BrowserWorkspacePreview {
  private readonly inFlight = new Map<number, number>();
  private readonly epochs = new Map<number, object>();
  private readonly lastCapture = new Map<number, number>();
  private readonly agentCaptures = new Map<number, Map<string, BrowserPreview>>();
  constructor(private readonly deps: BrowserWorkspacePreviewDeps) {}
  invalidateWindow(windowId: number): void {
    this.epochs.set(windowId, {});
  }
  invalidateGuest(guestId: number): void {
    for (const [windowId, activeGuestId] of this.inFlight) if (activeGuestId === guestId) this.invalidateWindow(windowId);
  }
  disposeWindow(windowId: number): void {
    this.invalidateWindow(windowId);
    this.epochs.delete(windowId);
    this.lastCapture.delete(windowId);
    this.agentCaptures.delete(windowId);
  }
  remember(windowId: number, preview: BrowserPreview): void {
    const captures = this.agentCaptures.get(windowId) ?? new Map<string, BrowserPreview>();
    captures.delete(preview.tabId);
    captures.set(preview.tabId, preview);
    while (captures.size > AGENT_CAPTURES_PER_WINDOW) captures.delete(captures.keys().next().value!);
    this.agentCaptures.set(windowId, captures);
  }
  async capture(windowId: number, request: BrowserWorkspaceTarget): Promise<BrowserPreview> {
    try { return await this.captureLive(windowId, request); }
    catch (error) {
      const captures = this.agentCaptures.get(windowId);
      const stored = captures?.get(request.tabId);
      if (stored && stored.documentGeneration !== this.deps.liveTab(windowId, request.tabId)?.documentGeneration) captures!.delete(request.tabId);
      else if (stored && stored.documentGeneration === request.documentGeneration && FALLBACK_ERRORS.has((error as Error).message)) return stored;
      throw error;
    }
  }
  private async captureLive(windowId: number, request: BrowserWorkspaceTarget): Promise<BrowserPreview> {
    const target = this.deps.liveTab(windowId, request.tabId);
    if (!target || target.guest.isDestroyed()) throw new Error("no-such-tab");
    if (target.documentGeneration !== request.documentGeneration) throw new Error("stale-document");
    if (!this.deps.isWindowVisible(windowId)) { this.invalidateWindow(windowId); throw new Error("window-hidden"); }
    if (!target.guest.getURL()) throw new Error("capture-unavailable");
    const now = (this.deps.now ?? Date.now)();
    if (this.inFlight.has(windowId)) throw new Error("capture-busy");
    if (now - (this.lastCapture.get(windowId) ?? -Infinity) < CAPTURE_INTERVAL_MS) throw new Error("capture-throttled");
    const epoch = this.epochs.get(windowId) ?? {};
    this.epochs.set(windowId, epoch);
    const valid = () => {
      const live = this.deps.liveTab(windowId, request.tabId);
      return this.deps.isWindowVisible(windowId) && this.epochs.get(windowId) === epoch && live?.guest === target.guest && !target.guest.isDestroyed() && live.documentGeneration === request.documentGeneration;
    };
    this.inFlight.set(windowId, target.guest.id);
    this.lastCapture.set(windowId, now);
    try {
      let image: NativeImage;
      try { image = await target.guest.capturePage(undefined, { stayHidden: true, stayAwake: false }); }
      catch { throw new Error("capture-unavailable"); }
      if (!valid()) throw new Error("stale-document");
      const encoded = encodeBrowserPreview(image);
      if (!encoded || !valid()) throw new Error("capture-unavailable");
      return { ...request, ...encoded };
    } finally { this.inFlight.delete(windowId); }
  }
}
