import type { BrowserCaptureScroll } from "../../shared/browser-capture.js";
import { BrowserActionError, type CdpSession } from "./browser-action-guard.js";

const CAPTURE_SCROLL = "function(x,y,paint){window.scrollTo({left:x,top:y,behavior:'instant'});const position=()=>({x:scrollX,y:scrollY});return paint?new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(position())))):position();}";

export function captureContextGone(error: unknown): boolean {
  return error instanceof Error && /Cannot find context|Execution context was destroyed/iu.test(error.message);
}

/** The host supplies only coordinates and one frame-wait flag to a fixed isolated-world function. */
export function captureScrollParameters(position: BrowserCaptureScroll, paint: boolean): Record<string, unknown> {
  return { executionContextId: position.executionContextId, functionDeclaration: CAPTURE_SCROLL, returnByValue: true, awaitPromise: paint,
    arguments: [{ value: position.x }, { value: position.y }, { value: paint }] };
}

export async function captureScrollContext(cdp: CdpSession): Promise<number> {
  const tree = await cdp.send("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } };
  if (!tree.frameTree?.frame?.id) throw new BrowserActionError("screenshot-unavailable", "the page has no capture frame");
  const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "ave-browser-capture" }) as { executionContextId?: number };
  if (!Number.isSafeInteger(world.executionContextId)) throw new BrowserActionError("screenshot-unavailable", "the page has no capture context");
  return Number(world.executionContextId);
}

export async function scrollBrowserCapture(cdp: CdpSession, position: BrowserCaptureScroll): Promise<void> {
  const result = await cdp.send("Runtime.callFunctionOn", captureScrollParameters(position, true)) as { exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new BrowserActionError("screenshot-unavailable", "the page could not scroll for capture");
}
