import { frameTree, type FrameTree, type CdpSession } from "./browser-action-guard.js";
import { browserOrigin } from "../../shared/browser-tools.js";
import { validateExternalUrl } from "../../shared/external-url.js";

export interface BrowserNavigationPolicy {
  active(): boolean;
  userControlled?(): boolean;
  authorize(url: string): Promise<void>;
}

export async function gateBrowserSiteNavigation(cdp: CdpSession, mainFrameId: string, policy: BrowserNavigationPolicy): Promise<() => void> {
  const pending = new Set<string>();
  let rootFrameId = mainFrameId;
  const containsFrame = (tree: FrameTree, id: unknown): boolean => tree.frame.id === id || (tree.childFrames?.some(child => containsFrame(child, id)) ?? false);
  let stopped = false;
  const unwatch = cdp.onEvent((method, params) => {
    if (method !== "Fetch.requestPaused" || typeof params.requestId !== "string") return;
    const requestId = params.requestId;
    const request = params.request as { url?: unknown } | undefined;
    let topLevel = params.frameId === rootFrameId;
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
          await policy.authorize(request.url);
          if (stopped || !policy.active()) throw new Error("Browser navigation authority changed");
        }
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch {
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
      } finally { pending.delete(requestId); }
    })();
  });
  try { await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }); }
  catch (error) { stopped = true; unwatch(); throw error; }
  return () => {
    stopped = true;
    for (const requestId of pending) void cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
    pending.clear();
    unwatch();
  };
}
