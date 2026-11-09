import { BrowserWindow, type WebContents } from "electron";
import { browserTabRegistry } from "./browser-tab-registry.js";

/** Native page ownership survives view detachment and determines window-scoped policy and display density. */
export function browserGuestOwnerWindow(guest: WebContents): BrowserWindow | null {
  const windowId = browserTabRegistry.guestWindowId(guest.id);
  if (windowId !== null) return BrowserWindow.fromId(windowId);
  return BrowserWindow.fromWebContents(guest.hostWebContents ?? guest);
}
