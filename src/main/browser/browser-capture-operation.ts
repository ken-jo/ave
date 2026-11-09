import { BrowserActionError, throwIfAborted } from "./browser-action-guard.js";

export interface BrowserCaptureOperation {
  readonly signal: AbortSignal;
  readonly deadline: number;
  wait<T>(pending: Promise<T>): Promise<T>;
}

/** Preparation, readback and cleanup share one cancellation signal and absolute deadline. */
export async function runBrowserCapture<T>(
  signal: AbortSignal, maxMs: number, run: (operation: BrowserCaptureOperation) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + maxMs;
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const cancel = () => {
    try { throwIfAborted(signal); } catch (error) { controller.abort(error); }
  };
  const expire = () => controller.abort(new BrowserActionError("screenshot-timeout", "the tab did not return an image within the capture deadline"));
  const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const operation: BrowserCaptureOperation = {
    signal: controller.signal, deadline,
    wait: (pending) => {
      if (Date.now() >= deadline) expire();
      return Promise.race([pending, interrupted]).then((value) => {
        if (Date.now() >= deadline) expire();
        controller.signal.throwIfAborted();
        return value;
      });
    },
  };
  try {
    return await operation.wait(Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(operation);
    }));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort(new BrowserActionError("cancelled", "the capture operation ended"));
  }
}
