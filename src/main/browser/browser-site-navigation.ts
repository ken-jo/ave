import { frameTree, type FrameTree, type CdpSession } from "./browser-action-guard.js";
import { browserOrigin } from "../../shared/browser-tools.js";
import { validateExternalUrl } from "../../shared/external-url.js";

export interface BrowserNavigationPolicy {
  active(): boolean;
  userControlled?(): boolean;
  authorize(url: string, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

export interface BrowserSiteNavigationGate {
  (): void;
  waiting(): boolean;
  pausedMs(): number;
  assertAllowed(): void;
}

// Action adapters can be short-lived; request interception belongs to the shared page session.
const sessionGates = new WeakMap<CdpSession, () => void>();

export async function gateBrowserSiteNavigation(cdp: CdpSession, mainFrameId: string, policy: BrowserNavigationPolicy): Promise<BrowserSiteNavigationGate> {
  sessionGates.get(cdp)?.();
  const pending = new Set<string>();
  let pausedAt: number | undefined;
  let pausedMs = 0;
  let rootFrameId = mainFrameId;
  const containsFrame = (tree: FrameTree, id: unknown): boolean => tree.frame.id === id || (tree.childFrames?.some(child => containsFrame(child, id)) ?? false);
  let stopped = false;
  let failure: Error | undefined;
  const unwatch = cdp.onEvent((method, params) => {
    if (method !== "Fetch.requestPaused" || typeof params.requestId !== "string") return;
    const requestId = params.requestId;
    const request = params.request as { url?: unknown } | undefined;
    let topLevel = params.frameId === rootFrameId;
    if (pending.size === 0) pausedAt = Date.now();
    pending.add(requestId);
    void (async () => {
      try {
        if (stopped) throw new Error("Browser navigation gate closed");
        if (params.resourceType !== "Document") throw new Error("Unexpected browser request type");
        if (!policy.userControlled?.() && !topLevel) {
          const tree = await frameTree(cdp);
          rootFrameId = tree.frame.id;
          topLevel = params.frameId === rootFrameId;
          if (!containsFrame(tree, params.frameId)) throw new Error("Unknown browser navigation frame");
        }
        if (topLevel && !policy.userControlled?.()) {
          if (!policy.active() || typeof request?.url !== "string" || browserOrigin(request.url) === null || !validateExternalUrl(request.url).ok) throw new Error("Browser navigation denied");
          await new Promise<void>((resolve, reject) => {
            const signal = policy.signal;
            const aborted = () => reject(signal?.reason ?? new Error("Browser navigation cancelled"));
            signal?.addEventListener("abort", aborted, { once: true });
            if (signal?.aborted) { aborted(); return; }
            void policy.authorize(request.url as string, signal).then(resolve, reject).finally(() => signal?.removeEventListener("abort", aborted));
          });
          if (stopped || !policy.active()) throw new Error("Browser navigation authority changed");
        }
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Browser site approval denied");
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
      } finally {
        pending.delete(requestId);
        if (pending.size === 0 && pausedAt !== undefined) { pausedMs += Date.now() - pausedAt; pausedAt = undefined; }
      }
    })();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const requestId of pending) void cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
    pending.clear();
    unwatch();
    if (sessionGates.get(cdp) === stop) sessionGates.delete(cdp);
  };
  sessionGates.set(cdp, stop);
  try { await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }); }
  catch (error) { stop(); throw error; }
  return Object.assign(stop, { waiting: () => pending.size > 0, pausedMs: () => pausedMs + (pausedAt === undefined ? 0 : Date.now() - pausedAt), assertAllowed: () => { if (failure) throw failure; } });
}
