import type { BrowserPreview, BrowserWorkspaceApi, BrowserWorkspaceTarget } from "../../../shared/browser-workspace.js";

interface PreviewCard {
  readonly element: HTMLElement;
  readonly request: BrowserWorkspaceTarget;
  readonly onPreview: (preview: BrowserPreview) => void;
  nextAt: number;
}
const CAPTURE_INTERVAL_MS = 1600;
const REFRESH_INTERVAL_MS = 10_000;

/** One scheduler is shared by every card and panel using this window's API. */
export class BrowserPreviewScheduler {
  private readonly cards = new Set<PreviewCard>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private nextCaptureAt = 0;
  constructor(private readonly api: Pick<BrowserWorkspaceApi, "preview">, private readonly visible: () => boolean = () => document.visibilityState === "visible") {}
  register(element: HTMLElement, request: BrowserWorkspaceTarget, onPreview: (preview: BrowserPreview) => void): () => void {
    const card: PreviewCard = { element, request, onPreview, nextAt: 0 };
    this.cards.add(card);
    this.schedule();
    return () => { this.cards.delete(card); if (!this.cards.size && this.timer !== null) { clearTimeout(this.timer); this.timer = null; } };
  }
  private schedule(): void {
    if (this.timer !== null || this.inFlight || !this.visible()) return;
    for (const card of this.cards) if (!card.element.isConnected) this.cards.delete(card);
    if (!this.cards.size) return;
    const earliest = Math.min(...[...this.cards].map((card) => card.nextAt));
    this.timer = setTimeout(() => { this.timer = null; void this.capture(); }, Math.max(0, earliest - Date.now(), this.nextCaptureAt - Date.now()));
  }
  private async capture(): Promise<void> {
    if (!this.visible()) return;
    const card = [...this.cards].filter((entry) => entry.element.isConnected && entry.nextAt <= Date.now()).sort((left, right) => left.nextAt - right.nextAt)[0];
    if (!card) { this.schedule(); return; }
    this.inFlight = true;
    this.nextCaptureAt = Date.now() + CAPTURE_INTERVAL_MS;
    card.nextAt = Date.now() + REFRESH_INTERVAL_MS;
    try {
      const result = await this.api.preview(card.request);
      if (this.visible() && this.cards.has(card) && card.element.isConnected && result.ok && result.value.tabId === card.request.tabId && result.value.documentGeneration === card.request.documentGeneration) card.onPreview(result.value);
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
