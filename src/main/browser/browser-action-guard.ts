import { browserOrigin } from "../../shared/browser-tools.js";

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

export class BrowserActionError extends Error {
  constructor(readonly code: string, message: string) {
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
  releaseFocus(): void;
  readonly signal: AbortSignal;
  /** Host frame metadata also includes children outside the protocol target. */
  iframeOrigins?(): readonly string[];
  documentId?(): number;
  /** Revalidate host identity in the same turn that dispatches the command. */
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
    throw new BrowserActionError("cancelled", `nothing more was done: ${reason}`);
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

function containsNode(node: DomNode | undefined, id: number): boolean {
  if (!node) return false;
  if (!node.nodeName || /^(?:IFRAME|FRAME)$/i.test(node.nodeName)) return false;
  if (node.backendNodeId === id) return true;
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].some((child) => containsNode(child, id));
}

/** One document lease, invalidated by navigation, checked at every CDP boundary. */
export async function withGuardedAction<T>(
  target: ActionTarget,
  work: (target: ActionTarget & { expectNode(id: number): void }) => Promise<T>,
): Promise<T> {
  throwIfAborted(target.signal);
  const origin = browserOrigin(target.url());
  if (!origin) changed();
  let invalidated = false;
  let inputNode: number | undefined;
  let touchPoint: { x: number; y: number } | undefined;
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
    const guarded: ActionTarget & { expectNode(id: number): void } = {
      ...target,
      expectNode: (id) => { inputNode = id; },
      cdp: {
        onEvent: (listener) => target.cdp.onEvent(listener),
        send: async (method, params) => {
          assertCurrent();
          const input = method.startsWith("Input.");
          const keyboard = method === "Input.dispatchKeyEvent" || method === "Input.insertText";
          const effect = input || method === "DOM.focus" || method === "DOM.scrollIntoViewIfNeeded";
          if (effect) {
            const current = await frameTree({ ...target.cdp, send: read });
            if (current.frame.id !== frameId || current.frame.loaderId !== loaderId
              || browserOrigin(current.frame.url) !== origin) changed();
            if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent") {
              if (inputNode === undefined) wrongTarget();
              if (method === "Input.dispatchTouchEvent" && params?.type === "touchStart") {
                const point = (params.touchPoints as { x: number; y: number }[] | undefined)?.[0];
                if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) wrongTarget();
                touchPoint = { x: point.x, y: point.y };
              }
              const position = method === "Input.dispatchTouchEvent" ? touchPoint : params as { x: number; y: number } | undefined;
              if (!position) wrongTarget();
              const point = await read("DOM.getNodeForLocation", {
                x: position.x, y: position.y,
                includeUserAgentShadowDOM: true, ignorePointerEventsNone: false,
              }) as { backendNodeId?: number; frameId?: string };
              // A child frame is represented by a placeholder, never a ref.
              // Unknown or out-of-process recipients therefore fail closed.
              if (point.frameId !== frameId || !point.backendNodeId) wrongTarget();
              const subtree = await read("DOM.describeNode", { backendNodeId: inputNode, depth: -1, pierce: true }) as { node?: DomNode };
              if (!containsNode(subtree.node, point.backendNodeId)) wrongTarget();
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
          const result = await target.cdp.send(method, params);
          assertCurrent();
          return result;
        },
      },
    };
    return await work(guarded);
  } finally {
    stop();
  }
}
