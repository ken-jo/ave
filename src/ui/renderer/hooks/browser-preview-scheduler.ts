import { parseBrowserWorkspacePreview, type BrowserPreview, type BrowserWorkspaceApi, type BrowserWorkspaceTarget } from "../../../shared/browser-workspace.js";

interface PreviewCard {
  readonly element: HTMLElement;
  readonly request: BrowserWorkspaceTarget;
  readonly onPreview: (preview: BrowserPreview) => void;
  nextAt: number;
}
const CAPTURE_INTERVAL_MS = 1600;
const REFRESH_INTERVAL_MS = 10_000;
const CACHE_LIMIT = 16;

/** One scheduler is shared by every card and panel using this window's API. */
export class BrowserPreviewScheduler {
  private readonly cards = new Set<PreviewCard>();
  private readonly cache = new Map<string, { readonly preview: BrowserPreview; readonly at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private nextCaptureAt = 0;
  private visibilityEpoch: object = {};
  constructor(private readonly api: Pick<BrowserWorkspaceApi, "preview">, private readonly visible: () => boolean = () => document.visibilityState === "visible") {}
  register(element: HTMLElement, request: BrowserWorkspaceTarget, onPreview: (preview: BrowserPreview) => void): () => void {
    const card: PreviewCard = { element, request, onPreview, nextAt: 0 };
    if (this.cards.size === 0) document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.cards.add(card);
    try { this.deliverCached(card); this.schedule(); }
    catch (error) { this.unregister(card); throw error; }
    return () => this.unregister(card);
  }
  private key(request: BrowserWorkspaceTarget): string { return JSON.stringify([request.tabId, request.documentGeneration]); }
  private eligible(card: PreviewCard): boolean { return this.visible() && this.cards.has(card) && card.element.isConnected; }
  private clearCache(): void {
    this.cache.clear(); this.visibilityEpoch = {};
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
  private readonly handleVisibilityChange = () => {
    if (!this.visible()) { this.clearCache(); for (const card of this.cards) card.nextAt = 0; }
    else this.schedule();
  };
  private unregister(card: PreviewCard): void {
    this.cards.delete(card);
    const key = this.key(card.request);
    if (![...this.cards].some((entry) => this.key(entry.request) === key)) this.cache.delete(key);
    if (this.cards.size === 0) { this.clearCache(); document.removeEventListener("visibilitychange", this.handleVisibilityChange); }
  }
  private deliverCached(card: PreviewCard): boolean {
    if (!this.eligible(card)) return false;
    const key = this.key(card.request);
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.at >= REFRESH_INTERVAL_MS) { this.cache.delete(key); return false; }
    card.nextAt = entry.at + REFRESH_INTERVAL_MS;
    card.onPreview(entry.preview);
    return true;
  }
  private schedule(): void {
    if (this.timer !== null || this.inFlight || !this.visible()) return;
    for (const card of this.cards) if (!card.element.isConnected) this.unregister(card);
    if (!this.cards.size) return;
    const earliest = Math.min(...[...this.cards].map((card) => card.nextAt));
    this.timer = setTimeout(() => { this.timer = null; void this.capture(); }, Math.max(0, earliest - Date.now(), this.nextCaptureAt - Date.now()));
  }
  private async capture(): Promise<void> {
    if (!this.visible()) return;
    const card = [...this.cards].filter((entry) => entry.element.isConnected && entry.nextAt <= Date.now()).sort((left, right) => left.nextAt - right.nextAt)[0];
    if (!card) { this.schedule(); return; }
    if (this.deliverCached(card)) { this.schedule(); return; }
    const epoch = this.visibilityEpoch;
    this.inFlight = true;
    this.nextCaptureAt = Date.now() + CAPTURE_INTERVAL_MS;
    card.nextAt = Date.now() + REFRESH_INTERVAL_MS;
    try {
      const result = await this.api.preview(card.request);
      if (epoch === this.visibilityEpoch && this.eligible(card) && result.ok && result.value.tabId === card.request.tabId && result.value.documentGeneration === card.request.documentGeneration) {
        const preview = parseBrowserWorkspacePreview(result.value);
        if (preview) {
          const at = Date.now();
          this.cache.set(this.key(card.request), { preview, at });
          while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
          card.nextAt = at + REFRESH_INTERVAL_MS;
          card.onPreview(preview);
        }
      }
    } catch {
      card.nextAt = Date.now() + REFRESH_INTERVAL_MS;
    } finally { this.inFlight = false; this.schedule(); }
  }
}
const schedulers = new WeakMap<BrowserWorkspaceApi, BrowserPreviewScheduler>();
export function browserPreviewScheduler(api: BrowserWorkspaceApi): BrowserPreviewScheduler {
  let scheduler = schedulers.get(api);
  if (!scheduler) { scheduler = new BrowserPreviewScheduler(api); schedulers.set(api, scheduler); }
  return scheduler;
}
