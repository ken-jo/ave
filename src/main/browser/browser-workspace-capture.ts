import { clipboard, ClipboardItem, nativeImage, type WebContents } from "electron";
import { parseBrowserWorkspaceRequest, type BrowserCapture, type BrowserCaptureRequest } from "../../shared/browser-workspace.js";
import { BrowserActionError, type CdpSession } from "./browser-action-guard.js";
import { captureBrowserPage, captureBrowserViewport } from "./browser-capture.js";
import { browserCapturePixelRatio } from "./browser-capture-desktop.js";
import { captureContextGone, captureScrollParameters } from "./browser-capture-scroll.js";
import { runBrowserCapture } from "./browser-capture-operation.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

interface CaptureTarget { readonly guest: WebContents; readonly documentGeneration: number }
interface BrowserWorkspaceCaptureDeps {
  liveTab(windowId: number, tabId: string): CaptureTarget | null;
  isWindowVisible(windowId: number): boolean;
}

/** User captures use the existing native page session and never acquire agent control or approval authority. */
export class BrowserWorkspaceCapture {
  private readonly inFlight = new Map<number, { guestId: number; controller: AbortController }>();
  constructor(private readonly deps: BrowserWorkspaceCaptureDeps) {}

  invalidateWindow(windowId: number): void { this.inFlight.get(windowId)?.controller.abort(new Error("stale-document")); }
  invalidateGuest(guestId: number): void {
    for (const [windowId, entry] of this.inFlight) if (entry.guestId === guestId) this.invalidateWindow(windowId);
  }

  async capture(windowId: number, request: BrowserCaptureRequest, maxMs: number = TOOL_TIMEOUT_POLICY.browserCaptureMs): Promise<BrowserCapture> {
    if (!parseBrowserWorkspaceRequest("capture", request)) throw new Error("bad-request");
    const target = this.deps.liveTab(windowId, request.tabId);
    if (!target || target.guest.isDestroyed()) throw new Error("no-such-tab");
    if (target.documentGeneration !== request.documentGeneration) throw new Error("stale-document");
    if (!this.deps.isWindowVisible(windowId)) throw new Error("window-hidden");
    if (this.inFlight.has(windowId)) throw new Error("capture-busy");
    const guest = target.guest;
    const zoom = guest.getZoomFactor();
    const pixelRatio = browserCapturePixelRatio(guest);
    const controller = new AbortController();
    const entry = { guestId: guest.id, controller };
    this.inFlight.set(windowId, entry);
    const assertCurrent = () => {
      const live = this.deps.liveTab(windowId, request.tabId);
      if (controller.signal.aborted || live?.guest !== guest || guest.isDestroyed()
        || live.documentGeneration !== request.documentGeneration || guest.getZoomFactor() !== zoom
        || browserCapturePixelRatio(guest) !== pixelRatio) throw new Error("stale-document");
      if (!this.deps.isWindowVisible(windowId)) throw new Error("window-hidden");
    };
    try {
      return await runBrowserCapture(controller.signal, maxMs, async (operation) => {
        const pageDebugger = guest.debugger;
        if (!pageDebugger.isAttached()) pageDebugger.attach("1.3");
        const cdp: CdpSession = {
          captureKey: guest,
          fullPageTiling: true,
          restoreCaptureScroll: async (position) => {
            const live = this.deps.liveTab(windowId, request.tabId);
            if (guest.isDestroyed() || live?.guest !== guest || live.documentGeneration !== request.documentGeneration) return;
            try { await pageDebugger.sendCommand("Runtime.callFunctionOn", captureScrollParameters(position)); }
            catch (error) { if (!captureContextGone(error)) throw error; }
          },
          clearDeviceMetrics: async () => {
            if (!guest.isDestroyed()) await pageDebugger.sendCommand("Emulation.clearDeviceMetricsOverride");
          },
          send: async (method, params) => {
            operation.signal.throwIfAborted();
            assertCurrent();
            const result = await operation.wait(pageDebugger.sendCommand(method, params ?? {}));
            assertCurrent();
            return result;
          },
          onEvent: (listener) => {
            const handleMessage = (_event: unknown, method: string, params: Record<string, unknown>) => listener(method, params);
            pageDebugger.on("message", handleMessage);
            return () => { pageDebugger.removeListener("message", handleMessage); };
          },
        };
        let clip = request.clip;
        if (clip) {
          const metrics = await cdp.send("Page.getLayoutMetrics") as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
          const viewport = metrics.cssVisualViewport;
          if (!viewport || ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite)
            || clip.x + clip.width > viewport.clientWidth || clip.y + clip.height > viewport.clientHeight) throw new Error("bad-request");
          clip = { ...clip, x: viewport.pageX + clip.x, y: viewport.pageY + clip.y };
        }
        const result = await captureBrowserPage(cdp, operation.signal, {
          ...(request.fullPage === undefined ? {} : { fullPage: request.fullPage }),
          ...(clip === undefined ? {} : { clip }),
        }, pixelRatio, maxMs, () => captureBrowserViewport(guest, assertCurrent, pixelRatio, cdp), operation);
        assertCurrent();
        const bytes = Buffer.from(result.data, "base64");
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error("capture-unavailable");
        assertCurrent();
        await operation.wait(clipboard.write([new ClipboardItem({ "image/png": new Blob([Uint8Array.from(bytes)], { type: "image/png" }) })]));
        assertCurrent();
        const { data, mimeType: _mimeType, ...metadata } = result;
        return { tabId: request.tabId, documentGeneration: request.documentGeneration, ...metadata, dataUrl: `data:image/png;base64,${data}` };
      });
    } catch (error) {
      assertCurrent();
      if (error instanceof BrowserActionError) throw new Error("capture-unavailable");
      if (error instanceof Error && ["bad-request", "window-hidden", "capture-unavailable"].includes(error.message)) throw error;
      throw new Error("capture-unavailable");
    } finally { if (this.inFlight.get(windowId) === entry) this.inFlight.delete(windowId); }
  }
}
