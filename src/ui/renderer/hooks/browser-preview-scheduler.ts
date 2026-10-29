import { parseBrowserWorkspacePreview, type BrowserPreview, type BrowserWorkspaceApi, type BrowserWorkspaceTarget } from "../../../shared/browser-workspace.js";

interface PreviewCard {
  readonly element: HTMLElement;
  readonly request: BrowserWorkspaceTarget;
  readonly onPreview: (preview: BrowserPreview) => void;
  nextAt: number;
}
interface PreviewRequest {
  readonly target: BrowserWorkspaceTarget;
  readonly at: number;
  readonly promise: Promise<BrowserPreview | null>;
  readonly resolve: (preview: BrowserPreview | null) => void;
}
const CAPTURE_INTERVAL_MS = 1600;
const REFRESH_INTERVAL_MS = 10_000;
const CACHE_LIMIT = 16;

/** One scheduler is shared by every card and panel using this window's API. */
export class BrowserPreviewScheduler {
  private readonly cards = new Set<PreviewCard>();
  private readonly requests = new Set<PreviewRequest>();
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
  /** A single display request shares scheduled captures and never consumes a separate capture lock. */
  request(target: BrowserWorkspaceTarget): Promise<BrowserPreview | null> {
    if (!this.visible()) return Promise.resolve(null);
    const cached = this.cached(target);
    if (cached) return Promise.resolve(cached.preview);
    const existing = [...this.requests].find((entry) => this.key(entry.target) === this.key(target));
    if (existing) return existing.promise;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    let resolve!: PreviewRequest["resolve"];
    const promise = new Promise<BrowserPreview | null>((done) => { resolve = done; });
    this.requests.add({ target, at: Date.now(), promise, resolve });
    while (this.requests.size > CACHE_LIMIT) {
      const oldest = this.requests.values().next().value!;
      this.requests.delete(oldest); oldest.resolve(null);
    }
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.schedule();
    return promise;
  }
  private cached(target: BrowserWorkspaceTarget): { readonly preview: BrowserPreview; readonly at: number } | undefined {
    const key = this.key(target);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.at < REFRESH_INTERVAL_MS) return entry;
    this.cache.delete(key);
    return undefined;
  }
  private settle(target: BrowserWorkspaceTarget, preview: BrowserPreview | null): void {
    for (const request of this.requests) {
      if (this.key(request.target) !== this.key(target)) continue;
      this.requests.delete(request); request.resolve(preview);
    }
  }
  private key(request: BrowserWorkspaceTarget): string { return JSON.stringify([request.tabId, request.documentGeneration]); }
  private eligible(card: PreviewCard): boolean { return this.visible() && this.cards.has(card) && card.element.isConnected; }
  private clearCache(): void {
    this.cache.clear(); this.visibilityEpoch = {};
    for (const request of this.requests) request.resolve(null);
    this.requests.clear();
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
  private readonly handleVisibilityChange = () => {
    if (!this.visible()) { this.clearCache(); for (const card of this.cards) card.nextAt = 0; }
    else this.schedule();
  };
  private unregister(card: PreviewCard): void {
    this.cards.delete(card);
    const key = this.key(card.request);
    if (![...this.cards].some((entry) => this.key(entry.request) === key)
      && ![...this.requests].some((entry) => this.key(entry.target) === key)) this.cache.delete(key);
    if (this.cards.size === 0 && this.requests.size === 0) { this.clearCache(); document.removeEventListener("visibilitychange", this.handleVisibilityChange); }
  }
  private deliverCached(card: PreviewCard): boolean {
    if (!this.eligible(card)) return false;
    const entry = this.cached(card.request);
    if (!entry) return false;
    card.nextAt = entry.at + REFRESH_INTERVAL_MS;
    card.onPreview(entry.preview);
    return true;
  }
  private schedule(): void {
    if (this.timer !== null || this.inFlight || !this.visible()) return;
    for (const card of this.cards) if (!card.element.isConnected) this.unregister(card);
    if (!this.cards.size && !this.requests.size) return;
    const earliest = this.requests.size ? 0 : Math.min(...[...this.cards].map((card) => card.nextAt));
    this.timer = setTimeout(() => { this.timer = null; void this.capture(); }, Math.max(0, earliest - Date.now(), this.nextCaptureAt - Date.now()));
  }
  private async capture(): Promise<void> {
    if (!this.visible()) return;
    const pending = this.requests.values().next().value as PreviewRequest | undefined;
    const dueCard = [...this.cards].filter((entry) => entry.element.isConnected && entry.nextAt <= Date.now()).sort((left, right) => left.nextAt - right.nextAt)[0];
    const card = dueCard && (!pending || dueCard.nextAt <= pending.at) ? dueCard : undefined;
    if (!card && !pending) { this.schedule(); return; }
    if (card && this.deliverCached(card)) { this.settle(card.request, this.cached(card.request)?.preview ?? null); this.schedule(); return; }
    const target = card?.request ?? pending!.target;
    const cached = this.cached(target);
    if (!card && cached) { this.settle(target, cached.preview); this.schedule(); return; }
    const epoch = this.visibilityEpoch;
    this.inFlight = true;
    this.nextCaptureAt = Date.now() + CAPTURE_INTERVAL_MS;
    if (card) card.nextAt = Date.now() + REFRESH_INTERVAL_MS;
    let admitted: BrowserPreview | null = null;
    try {
      const result = await this.api.preview(target);
      const requested = [...this.requests].some((entry) => this.key(entry.target) === this.key(target));
      if (epoch === this.visibilityEpoch && this.visible() && (requested || (card && this.eligible(card))) && result.ok && result.value.tabId === target.tabId && result.value.documentGeneration === target.documentGeneration) {
        const preview = parseBrowserWorkspacePreview(result.value);
        if (preview) {
          const at = Date.now();
          this.cache.set(this.key(target), { preview, at });
          while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
          admitted = preview;
          for (const entry of this.cards) {
            if (this.key(entry.request) !== this.key(target) || !this.eligible(entry)) continue;
            entry.nextAt = at + REFRESH_INTERVAL_MS; entry.onPreview(preview);
          }
        }
      }
    } catch {
      if (card) card.nextAt = Date.now() + REFRESH_INTERVAL_MS;
    } finally {
      this.settle(target, admitted);
      this.inFlight = false; this.schedule();
    }
  }
}
const schedulers = new WeakMap<BrowserWorkspaceApi, BrowserPreviewScheduler>();
export function browserPreviewScheduler(api: BrowserWorkspaceApi): BrowserPreviewScheduler {
  let scheduler = schedulers.get(api);
  if (!scheduler) { scheduler = new BrowserPreviewScheduler(api); schedulers.set(api, scheduler); }
  return scheduler;
}
