import type { BrowserActionTab } from "../../tools/browser-tools.js";
import { BrowserActionError, throwIfAborted } from "./browser-action-guard.js";
import { BrowserDocumentChangedError, type BrowserGuest } from "./browser-tab-registry.js";

/** Document transitions retain a live control lease; caller cancellation and loss of that exact guest or lease do not. */
export function browserControlLifecycle<G extends BrowserGuest>(
  live: BrowserActionTab<G>,
  guest: G,
  onDestroyed?: (listener: () => void) => () => void,
): { signal: AbortSignal; stop(): void; cancel(): void } {
  throwIfAborted(live.signal);
  const controller = new AbortController();
  let stopped = false;
  let unwatch = () => {};
  const valid = () => !guest.isDestroyed() && live.tab.guest === guest && live.tab.controlMode !== "human-paused"
    && live.leaseId !== undefined && live.tab.lease?.id === live.leaseId;
  if (!valid() || (live.approval && (live.approval.tabId !== live.tab.handle || live.approval.documentId !== live.tab.documentId
    || live.approval.controlGeneration !== live.tab.controlGeneration))) {
    throw new BrowserActionError("document-changed", "the navigation target or control lease changed before loading");
  }
  const cancelCaller = () => controller.abort(live.callerSignal?.reason ?? new Error("navigation cancelled"));
  const destroyed = () => controller.abort(new Error("the browser tab was closed"));
  const watch = (signal: AbortSignal) => {
    if (stopped || controller.signal.aborted) return;
    unwatch();
    const changed = () => {
      if (signal.reason instanceof BrowserDocumentChangedError && !live.callerSignal?.aborted && valid()) {
        // The registry replaces the document controller after aborting the old one. Follow it at the next microtask boundary.
        queueMicrotask(() => { if (!stopped) { if (valid()) watch(live.tab.actions.signal); else destroyed(); } });
      } else controller.abort(signal.reason);
    };
    signal.addEventListener("abort", changed, { once: true });
    unwatch = () => { signal.removeEventListener("abort", changed); };
    if (signal.aborted) changed();
  };
  live.callerSignal?.addEventListener("abort", cancelCaller, { once: true });
  if (live.callerSignal?.aborted) cancelCaller();
  const removeDestroyed = onDestroyed?.(destroyed);
  watch(live.signal);
  const stop = () => {
    stopped = true; unwatch(); live.callerSignal?.removeEventListener("abort", cancelCaller); removeDestroyed?.();
  };
  return { signal: controller.signal, stop, cancel: () => {
    controller.abort(new Error("browser control action ended"));
    stop();
  } };
}
