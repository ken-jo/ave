import { screen, type WebContents } from "electron";
import { browserGuestOwnerWindow } from "./browser-guest-owner.js";

/** Protocol clips already normalize guest zoom; only display pixel density affects output resolution. */
export function browserCapturePixelRatio(guest: WebContents): number {
  const window = browserGuestOwnerWindow(guest);
  const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  return display.scaleFactor;
}
