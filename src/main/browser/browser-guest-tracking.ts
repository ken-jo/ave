// Only key presses, clicks, and wheel input pause agent actions; hover and pointer movement do not.
import type { WebContents } from "electron";
import { browserTabRegistry, isUserActionInputType } from "./browser-tab-registry.js";
import { subscribeBrowserGuestDestroyed } from "./browser-guest-lifecycle.js";

const trackedGuests = new Map<WebContents, number>();
const siteZoomFactors = new WeakMap<object, Map<string, number>>();

function siteFactors(contents: WebContents): Map<string, number> {
  let factors = siteZoomFactors.get(contents.session);
  if (!factors) {
    factors = new Map();
    siteZoomFactors.set(contents.session, factors);
  }
  return factors;
}

function siteKey(contents: WebContents): string {
  try { return new URL(contents.getURL()).hostname; } catch { return ""; }
}

export function setBrowserGuestZoomFactor(contents: WebContents, factor: number): void {
  siteFactors(contents).set(siteKey(contents), factor);
  contents.setZoomFactor(factor);
}

export function preserveBrowserGuestZoom(change: () => void): void {
  const guests = [...trackedGuests].filter(([contents]) => !contents.isDestroyed())
    .map(([contents]) => ({ contents, factor: contents.getZoomFactor() }));
  try {
    change();
  } finally {
    for (const { contents, factor } of guests) {
      if (!contents.isDestroyed()) setBrowserGuestZoomFactor(contents, factor);
    }
  }
}

export function trackBrowserGuest(contents: WebContents, windowId: number): void {
  if (trackedGuests.has(contents)) return;
  trackedGuests.set(contents, windowId);
  const restoreZoom = () => contents.setZoomFactor(siteFactors(contents).get(siteKey(contents)) ?? 1);
  restoreZoom();
  contents.on("did-navigate", restoreZoom);
  contents.on("did-finish-load", restoreZoom);
  const guestId = contents.id;
  browserTabRegistry.guestAttached(contents, windowId);
  contents.on("focus", () => browserTabRegistry.restoreParkedGuestFocus(guestId));
  contents.on("before-input-event", (event, input) => {
    if (browserTabRegistry.isParkedKeyboardInput(guestId, input)) {
      event.preventDefault();
      if (isUserActionInputType(input.type)) browserTabRegistry.userInput(guestId, input);
      browserTabRegistry.restoreParkedGuestFocus(guestId);
      return;
    }
    if (isUserActionInputType(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.on("input-event", (_event, input) => {
    // Observe each native mouse receipt once, instead of also consuming its earlier normalized copy as a second intervention.
    if (/^(?:touch|gesture)|^pointerDown$|^mouse(?:Down|Up|Wheel)$/.test(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.debugger.on("message", (_event, method) => {
    if (method === "DOM.documentUpdated") browserTabRegistry.documentChanged(guestId);
  });
  subscribeBrowserGuestDestroyed(contents, () => {
    trackedGuests.delete(contents);
    browserTabRegistry.guestDestroyed(guestId);
  });
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) browserTabRegistry.navigationStarted(guestId, url);
  });
  contents.on("did-navigate", () => browserTabRegistry.metadataChanged(guestId));
  contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) browserTabRegistry.metadataChanged(guestId);
  });
  contents.on("page-title-updated", () => browserTabRegistry.metadataChanged(guestId));
}
