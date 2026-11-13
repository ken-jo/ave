import type { BrowserCaptureScroll } from "../../shared/browser-capture.js";
import { BrowserActionError, type CdpSession } from "./browser-action-guard.js";

const CAPTURE_SCROLL = "function(x,y){window.scrollTo({left:x,top:y,behavior:'instant'});return {x:scrollX,y:scrollY};}";

export function captureContextGone(error: unknown): boolean {
  return error instanceof Error && /Cannot find context|Execution context was destroyed/iu.test(error.message);
}

/** The fixed isolated-world function accepts only coordinates; image readback owns rendering. */
export function captureScrollParameters(position: BrowserCaptureScroll): Record<string, unknown> {
  return { executionContextId: position.executionContextId, functionDeclaration: CAPTURE_SCROLL, returnByValue: true, awaitPromise: false,
    arguments: [{ value: position.x }, { value: position.y }] };
}

export async function captureScrollContext(cdp: CdpSession): Promise<number> {
  const tree = await cdp.send("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } };
  if (!tree.frameTree?.frame?.id) throw new BrowserActionError("screenshot-unavailable", "the page has no capture frame");
  const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "ave-browser-capture" }) as { executionContextId?: number };
  if (!Number.isSafeInteger(world.executionContextId)) throw new BrowserActionError("screenshot-unavailable", "the page has no capture context");
  return Number(world.executionContextId);
}

export async function scrollBrowserCapture(cdp: CdpSession, position: BrowserCaptureScroll): Promise<void> {
  const result = await cdp.send("Runtime.callFunctionOn", captureScrollParameters(position)) as { exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new BrowserActionError("screenshot-unavailable", "the page could not scroll for capture");
}
