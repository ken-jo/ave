/**
 * Feed one attached browser guest into the tab registry: record it with its
 * window, forget it when it is destroyed, and report the user's own keyboard
 * and mouse input so an agent-controlled tab's pending actions are cancelled.
 *
 * Hover and mouse moves are not input: only key presses, clicks and wheel
 * scrolls count as the user acting on the page.
 */
import type { WebContents } from "electron";
import { browserTabRegistry, isUserActionInputType } from "./browser-tab-registry.js";
import { getServices } from "../app-state.js";
import { loadBrowserFavicon } from "./browser-favicon.js";
import { validateExternalUrl } from "../../shared/external-url.js";

export function trackBrowserGuest(contents: WebContents, windowId: number): void {
  const guestId = contents.id;
  browserTabRegistry.guestAttached(contents, windowId);
  let faviconRequest: AbortController | undefined;
  let faviconSource: string | undefined;
  const cancelFavicon = () => {
    faviconRequest?.abort();
    faviconRequest = undefined;
    faviconSource = undefined;
  };
  const faviconUpdated = (_event: unknown, urls: string[]) => {
    const url = urls.find((candidate) => validateExternalUrl(candidate).ok || /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(candidate));
    if (url && url === faviconSource) return;
    cancelFavicon();
    browserTabRegistry.guestFaviconChanged(guestId, null);
    const fetchImpl = getServices()?.singleHopNetworkFetch;
    if (!url || !fetchImpl) return;
    const request = new AbortController();
    faviconRequest = request;
    faviconSource = url;
    void loadBrowserFavicon(url, fetchImpl, request.signal).then((dataUrl) => {
      if (faviconRequest === request && !request.signal.aborted && !contents.isDestroyed()) {
        if (dataUrl === null) faviconSource = undefined;
        browserTabRegistry.guestFaviconChanged(guestId, dataUrl);
      }
    });
  };
  contents.on("page-favicon-updated", faviconUpdated);
  contents.on("before-input-event", (_event, input) => {
    if (isUserActionInputType(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.on("input-event", (_event, input) => {
    // Observe each native mouse receipt once, instead of also consuming its
    // earlier normalized copy as a second intervention.
    if (/^(?:touch|gesture)|^pointerDown$|^mouse(?:Down|Up|Wheel)$/.test(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.debugger.on("message", (_event, method) => {
    if (method === "DOM.documentUpdated") { cancelFavicon(); browserTabRegistry.documentChanged(guestId); }
  });
  contents.once("destroyed", () => {
    cancelFavicon();
    contents.removeListener("page-favicon-updated", faviconUpdated);
    browserTabRegistry.guestDestroyed(guestId);
  });
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { cancelFavicon(); browserTabRegistry.navigationStarted(guestId, url); }
  });
}
