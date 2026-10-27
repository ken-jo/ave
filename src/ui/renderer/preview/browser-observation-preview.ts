import type {
  BrowserObservationPreviewMessage,
  BrowserObservationPreviewRequest,
} from "../../../shared/agent-observation.js";
import type { AvePreviewApi } from "../types.js";

export interface PreviewBinding { targetId: string; sessionId: string; tabId: string }
export interface PreviewFrameState {
  frame?: { frame: number; src: string; width: number; height: number; ts: number };
  /** The shown frame is real but no longer current (navigation commit, blank commit paint, hidden page). */
  updating: boolean;
  status: "live" | "stopped" | "error";
}

type PreviewApi = Pick<AvePreviewApi, "onObservationPreview" | "requestObservationPreview">;
const key = (binding: PreviewBinding) => `${binding.targetId}\u0000${binding.sessionId}\u0000${binding.tabId}`;

/**
 * Newest preview frame per requested binding. Nothing is kept for a binding that is not currently requested by a
 * visible preview element, and stopping a binding drops its frame at once.
 */
export class BrowserObservationPreviewStore {
  private readonly states = new Map<string, PreviewFrameState>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: PreviewApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(binding: PreviewBinding | undefined): PreviewFrameState | undefined {
    return binding ? this.states.get(key(binding)) : undefined;
  }

  start(binding: PreviewBinding): void {
    const id = key(binding);
    const previous = this.states.get(id);
    if (!previous || previous.status !== "live") this.states.set(id, { updating: true, status: "live" });
    this.notify();
    this.request({ action: "start", ...binding, frame: 0 }, (result) => {
      if (!result.ok && this.states.has(id)) { this.states.set(id, { updating: false, status: "stopped" }); this.notify(); }
    });
  }

  stop(binding: PreviewBinding): void {
    if (!this.states.delete(key(binding))) return;
    this.notify();
    this.request({ action: "stop", ...binding, frame: 0 });
  }

  /** The frame was decoded and painted; main may forward the next one. */
  rendered(binding: PreviewBinding, frame: number): void {
    const state = this.states.get(key(binding));
    if (state?.frame?.frame !== frame) return;
    this.request({ action: "rendered", ...binding, frame });
  }

  accept(message: BrowserObservationPreviewMessage): void {
    const id = key(message);
    const state = this.states.get(id);
    if (!state) return; // Not requested by a visible element: never retained.
    if (message.kind === "frame") {
      if (message.mimeType !== "image/jpeg" || (state.frame && message.frame <= state.frame.frame)) return;
      this.states.set(id, { status: "live", updating: false,
        frame: { frame: message.frame, src: `data:image/jpeg;base64,${message.data}`, width: message.width, height: message.height, ts: message.ts } });
    } else if (message.state === "updating") {
      this.states.set(id, { ...state, updating: true });
    } else {
      // A stopped or failed preview drops its picture; the slot returns to its ordinary notice.
      this.states.set(id, { updating: false, status: message.state });
    }
    this.notify();
  }

  dispose(): void {
    for (const id of [...this.states.keys()]) {
      const [targetId, sessionId, tabId] = id.split("\u0000") as [string, string, string];
      this.stop({ targetId, sessionId, tabId });
    }
    this.listeners.clear();
  }

  private request(request: BrowserObservationPreviewRequest, done?: (result: { ok: boolean }) => void): void {
    void this.api.requestObservationPreview(request).then((result) => done?.(result), (error: unknown) => {
      console.error("Browser preview request failed.", error);
      done?.({ ok: false });
    });
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}

/** Shown only when connected, laid out, inside the viewport and not hidden by any ancestor style. */
export function isElementShown(element: Element): boolean {
  if (!element.isConnected || element.ownerDocument.visibilityState !== "visible") return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0
    || rect.left >= view.innerWidth || rect.top >= view.innerHeight) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || Number.parseFloat(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
    if (node.hasAttribute("hidden")) return false;
  }
  return true;
}
