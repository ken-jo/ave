import { BrowserDocumentChangedError } from "./browser-tab-registry.js";
import { browserOrigin } from "../../shared/browser-tools.js";
import { browserDragData, type BrowserDragData } from "./browser-drag-data.js";
import { BROWSER_ACTION_WORLD, SELECT_NATIVE_OPTION } from "./browser-select-script.js";
import type { BrowserCaptureScroll, BrowserViewportImage } from "../../shared/browser-capture.js";

interface NativeDragReceipt { intercepted(): BrowserDragData | undefined }

export interface CdpSession {
  readonly captureKey?: object;
  readonly fullPageTiling?: boolean;
  clearDeviceMetrics?(): Promise<void>;
  restoreCaptureScroll?(position: BrowserCaptureScroll): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

export class BrowserActionError extends Error {
  constructor(readonly code: string, message: string, readonly effectCommitted = false) {
    super(message);
    this.name = "BrowserActionError";
  }
}

export interface ActionTarget {
  readonly tabId: string;
  url(): string;
  title(): string;
  readonly cdp: CdpSession;
  injectInput<T>(inject: () => Promise<T>): Promise<T>;
  // Run one press (pointer move, touch start, touch end) as the only touch sequence in the page's window, and fail unless it reached this page.
  press<T>(run: () => Promise<T>): Promise<T>;
  pointerInput<T>(run: () => Promise<T>): Promise<T>;
  wheelInput<T>(run: () => Promise<T>): Promise<T>;
  releaseFocus(restoreNativeFocus?: boolean): void | Promise<void>;
  focusPage(): Promise<void>;
  preparePageFocus?(): Promise<void>;
  mouseDrag?<T>(run: (receipt: NativeDragReceipt) => Promise<T>): Promise<T>;
  navigationOutcome?(): boolean;
  onDestroyed?(listener: () => void): () => void;
  readonly signal: AbortSignal;
  // Host frame metadata also includes children outside the protocol target.
  iframeOrigins?(): readonly string[];
  documentId?(): number;
  captureViewport?(): Promise<BrowserViewportImage>;
  // Revalidate host identity in the same turn that dispatches the command.
  assertCurrent?(keyboard: boolean): void;
}

export interface FrameTree {
  frame: { id: string; loaderId: string; url: string; securityOrigin?: string };
  childFrames?: FrameTree[];
}

interface DomNode {
  backendNodeId?: number;
  nodeName?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message.slice(0, 200) : "cancelled";
    throw new BrowserActionError(signal.reason instanceof BrowserDocumentChangedError ? "document-changed" : "cancelled", `nothing more was done: ${reason}`);
  }
}

function changed(): never {
  throw new BrowserActionError("document-changed", "the approved document changed; nothing more was done. Take a new snapshot and ask again");
}

function wrongTarget(): never {
  throw new BrowserActionError("wrong-input-target", "the input would reach another element or frame; nothing more was done. Take a new snapshot");
}

export async function frameTree(cdp: CdpSession): Promise<FrameTree> {
  const result = await cdp.send("Page.getFrameTree") as { frameTree?: FrameTree };
  if (!result.frameTree?.frame.id || !result.frameTree.frame.loaderId) changed();
  return result.frameTree;
}

export function mainDocumentContainsNode(node: DomNode | undefined, id: number): boolean {
  if (!node) return false;
  if (!node.nodeName || /^(?:IFRAME|FRAME)$/i.test(node.nodeName)) return false;
  if (node.backendNodeId === id) return true;
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].some((child) => mainDocumentContainsNode(child, id));
}

// One document lease, invalidated by navigation, checked at every CDP boundary.
export async function withGuardedAction(
  target: ActionTarget,
  work: (target: ActionTarget & {
    expectNode(id: number): void;
    finishWithInput<T>(dispatch: () => Promise<T>): Promise<T>;
  }) => Promise<void>,
): Promise<void> {
  throwIfAborted(target.signal);
  const origin = browserOrigin(target.url());
  if (!origin) changed();
  let invalidated = false;
  let finishingInput = false;
  let completedInput = false;
  let inputNode: number | undefined;
  let touchPoint: { x: number; y: number } | undefined;
  let selectionContextId: number | undefined;
  let selectionObjectId: string | undefined;
  const stop = target.cdp.onEvent((method) => {
    if (method === "Page.frameNavigated" || method === "Page.frameDetached" || method === "DOM.documentUpdated") invalidated = true;
  });
  const assertCurrent = (keyboard = false) => {
    throwIfAborted(target.signal);
    if (invalidated || browserOrigin(target.url()) !== origin) changed();
    target.assertCurrent?.(keyboard);
  };
  const read = async (method: string, params?: Record<string, unknown>) => {
    assertCurrent();
    const result = await target.cdp.send(method, params);
    assertCurrent();
    return result;
  };
  try {
    assertCurrent();
    const initial = await frameTree({ ...target.cdp, send: read });
    if (browserOrigin(initial.frame.url) !== origin) changed();
    const frameId = initial.frame.id;
    const loaderId = initial.frame.loaderId;
    assertCurrent();
    const guarded: Parameters<typeof work>[0] = {
      ...target,
      assertCurrent,
      expectNode: (id) => { inputNode = id; },
      // A navigation after this dispatch is a completed effect. Unwind the sequence without sending releases, verification or submit to a new page.
      finishWithInput: async (dispatch) => {
        finishingInput = true;
        try { return await dispatch(); } finally { finishingInput = false; }
      },
      cdp: {
        onEvent: (listener) => target.cdp.onEvent(listener),
        send: async (method, params) => {
          assertCurrent();
          const input = method.startsWith("Input.");
          const keyboard = method === "Input.dispatchKeyEvent" || method === "Input.insertText";
          const upload = method === "DOM.setFileInputFiles";
          const effect = input || upload || method === "DOM.focus" || method === "DOM.scrollIntoViewIfNeeded" || method === "Runtime.callFunctionOn";
          if (method === "Page.createIsolatedWorld" && (params?.frameId !== frameId || params.worldName !== BROWSER_ACTION_WORLD
            || Object.keys(params).some(key => key !== "frameId" && key !== "worldName"))) wrongTarget();
          if (method === "DOM.resolveNode") {
            if (inputNode === undefined || selectionContextId === undefined || params?.backendNodeId !== inputNode
              || params.executionContextId !== selectionContextId || Object.keys(params).some(key => key !== "backendNodeId" && key !== "executionContextId")) wrongTarget();
            const document = await read("DOM.getDocument", { depth: -1, pierce: true }) as { root?: DomNode };
            if (!mainDocumentContainsNode(document.root, inputNode)) wrongTarget();
          }
          if (method === "Runtime.callFunctionOn" && (selectionObjectId === undefined || params?.objectId !== selectionObjectId
            || params.functionDeclaration !== SELECT_NATIVE_OPTION || params.returnByValue !== true
            || !Array.isArray(params.arguments) || params.arguments.length !== 1 || typeof params.arguments[0]?.value !== "string"
            || Object.keys(params.arguments[0]).length !== 1
            || Object.keys(params).some(key => !["objectId", "functionDeclaration", "arguments", "returnByValue"].includes(key)))) wrongTarget();
          if (method === "Runtime.releaseObject" && (selectionObjectId === undefined || params?.objectId !== selectionObjectId
            || Object.keys(params).length !== 1)) wrongTarget();
          if (effect) {
            const current = await frameTree({ ...target.cdp, send: read });
            if (current.frame.id !== frameId || current.frame.loaderId !== loaderId
              || browserOrigin(current.frame.url) !== origin) changed();
            if (method === "Input.setInterceptDrags" && (!params || Object.keys(params).length !== 1 || typeof params.enabled !== "boolean")) wrongTarget();
            if (method === "Input.cancelDragging" && params && Object.keys(params).length !== 0) wrongTarget();
            if (method === "Input.dispatchDragEvent") {
              if (!params || !["dragEnter", "dragOver", "drop"].includes(String(params.type))
                || Object.keys(params).some((key) => !["type", "x", "y", "data"].includes(key))
                || !Number.isInteger(params.x) || !Number.isInteger(params.y)) wrongTarget();
              browserDragData(params.data, origin);
            }
            if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent" || method === "Input.dispatchDragEvent") {
              if (inputNode === undefined) wrongTarget();
              if (method === "Input.dispatchTouchEvent" && (params?.type === "touchStart" || params?.type === "touchMove")) {
                const point = (params.touchPoints as { x: number; y: number }[] | undefined)?.[0];
                if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) wrongTarget();
                touchPoint = { x: point.x, y: point.y };
              }
              const position = method === "Input.dispatchTouchEvent" ? touchPoint : params as { x: number; y: number } | undefined;
              if (!position) wrongTarget();
              // Input points are in the viewport; the hit test takes document points (measured: on a page scrolled sideways the viewport point found nothing). The
              // scroll offset turns one into the other. The offset is fractional on a scaled display, and CDP takes only whole pixels: the one holding the point.
              const metrics = await read("Page.getLayoutMetrics") as { cssVisualViewport?: { pageX?: unknown; pageY?: unknown; clientWidth?: number; clientHeight?: number } };
              if (metrics.cssVisualViewport?.clientWidth === 0 || metrics.cssVisualViewport?.clientHeight === 0) {
                throw new BrowserActionError("tab-not-laid-out", "the tab is not laid out; show the tab and retry");
              }
              const scrollX = metrics.cssVisualViewport?.pageX;
              const scrollY = metrics.cssVisualViewport?.pageY;
              if (typeof scrollX !== "number" || typeof scrollY !== "number") wrongTarget();
              const point = await read("DOM.getNodeForLocation", {
                x: Math.floor(position.x + scrollX), y: Math.floor(position.y + scrollY),
                includeUserAgentShadowDOM: true, ignorePointerEventsNone: false,
              }) as { backendNodeId?: number; frameId?: string };
              // A child frame is represented by a placeholder, never a ref. Unknown or out-of-process recipients therefore fail closed.
              if (point.frameId !== frameId || !point.backendNodeId) wrongTarget();
              const subtree = await read("DOM.describeNode", { backendNodeId: inputNode, depth: -1, pierce: true }) as { node?: DomNode };
              if (!mainDocumentContainsNode(subtree.node, point.backendNodeId)) wrongTarget();
            }
            if (upload) {
              if (inputNode === undefined || params?.backendNodeId !== inputNode || !Array.isArray(params.files)
                || params.files.length === 0 || !params.files.every((path) => typeof path === "string")
                || Object.keys(params).some((key) => key !== "backendNodeId" && key !== "files")) wrongTarget();
              const document = await read("DOM.getDocument", { depth: -1, pierce: true }) as { root?: DomNode };
              if (!mainDocumentContainsNode(document.root, inputNode)) wrongTarget();
              const described = await read("DOM.describeNode", { backendNodeId: inputNode }) as { node?: DomNode & { attributes?: string[] } };
              const attributes = described.node?.attributes ?? [];
              const typeIndex = attributes.findIndex((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === "type");
              if (described.node?.nodeName?.toUpperCase() !== "INPUT" || typeIndex < 0 || attributes[typeIndex + 1]?.toLowerCase() !== "file"
                || attributes.some((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === "disabled")
                || (params.files.length > 1 && !attributes.some((attribute, index) => index % 2 === 0 && attribute.toLowerCase() === "multiple"))) wrongTarget();
            }
            if (keyboard && inputNode !== undefined) {
              const tree = await read("Accessibility.getPartialAXTree", { backendNodeId: inputNode, fetchRelatives: false }) as {
                nodes?: { backendDOMNodeId?: number; properties?: { name: string; value?: { value?: unknown } }[] }[];
              };
              const focused = tree.nodes?.find((node) => node.backendDOMNodeId === inputNode);
              if (!focused?.properties?.some((property) => property.name === "focused" && property.value?.value === true)) wrongTarget();
            }
          }
          // No await separates this host identity/focus check from dispatch.
          assertCurrent(keyboard);
          if (effect) completedInput = input && finishingInput;
          const result = await target.cdp.send(method, params);
          if (method === "Page.createIsolatedWorld") {
            const context = result as { executionContextId?: number };
            if (!Number.isInteger(context.executionContextId)) wrongTarget();
            selectionContextId = context.executionContextId;
          }
          if (method === "DOM.resolveNode") {
            const resolved = result as { object?: { objectId?: string } };
            if (typeof resolved.object?.objectId !== "string") wrongTarget();
            selectionObjectId = resolved.object.objectId;
          }
          assertCurrent();
          return result;
        },
      },
    };
    return await work(guarded);
  } catch (err) {
    // Once an activating input has reached the approved document, a later document change is its outcome. No following step reaches that new page.
    const completedNavigation = completedInput && err instanceof BrowserActionError && err.code === "document-changed"
      && (!target.signal.aborted || (target.signal.reason instanceof BrowserDocumentChangedError && target.navigationOutcome?.() === true));
    if (!completedNavigation) {
      if (err instanceof BrowserActionError && err.effectCommitted) {
        const code = target.signal.aborted
          ? target.signal.reason instanceof BrowserDocumentChangedError ? "document-changed" : "cancelled" : err.code;
        throw new BrowserActionError(code, err.message, true);
      }
      throwIfAborted(target.signal); throw err;
    }
  } finally {
    stop();
  }
}
