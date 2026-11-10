import { BrowserWindow, type BaseWindow, type WebContents } from "electron";
import { getMainWindows, mainWindowForContents } from "../app-state.js";
import { browserTabRegistry } from "./browser-tab-registry.js";

/** Native page ownership survives view detachment and determines window-scoped policy and display density. */
export function browserGuestOwnerWindow(guest: WebContents): BaseWindow | null {
  if (browserTabRegistry.isIndependentGuest(guest.id)) {
    const windowId = browserTabRegistry.guestWindowId(guest.id);
    return getMainWindows().find(window => window.id === windowId) ?? null;
  }
  const host = guest.hostWebContents ?? guest;
  return mainWindowForContents(host) ?? BrowserWindow.fromWebContents(host);
}
