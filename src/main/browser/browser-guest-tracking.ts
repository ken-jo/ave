// Only key presses, clicks, and wheel input pause agent actions; hover and pointer movement do not.
import type { WebContents } from "electron";
import { browserTabRegistry, isUserActionInputType } from "./browser-tab-registry.js";

export function trackBrowserGuest(contents: WebContents, windowId: number): void {
  const guestId = contents.id;
  browserTabRegistry.guestAttached(contents, windowId);
  contents.on("before-input-event", (_event, input) => {
    if (isUserActionInputType(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.on("input-event", (_event, input) => {
    // Observe each native mouse receipt once, instead of also consuming its earlier normalized copy as a second intervention.
    if (/^(?:touch|gesture)|^pointerDown$|^mouse(?:Down|Up|Wheel)$/.test(input.type)) browserTabRegistry.userInput(guestId, input);
  });
  contents.debugger.on("message", (_event, method) => {
    if (method === "DOM.documentUpdated") browserTabRegistry.documentChanged(guestId);
  });
  contents.once("destroyed", () => browserTabRegistry.guestDestroyed(guestId));
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) browserTabRegistry.navigationStarted(guestId, url);
  });
}
