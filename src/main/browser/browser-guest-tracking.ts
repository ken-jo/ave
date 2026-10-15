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

export function trackBrowserGuest(contents: WebContents, windowId: number): void {
  const guestId = contents.id;
  browserTabRegistry.guestAttached(contents, windowId);
  contents.on("before-input-event", (_event, input) => {
    if (isUserActionInputType(input.type)) browserTabRegistry.userInput(guestId);
  });
  contents.on("before-mouse-event", (_event, mouse) => {
    if (isUserActionInputType(mouse.type)) browserTabRegistry.userInput(guestId);
  });
  contents.once("destroyed", () => browserTabRegistry.guestDestroyed(guestId));
}
