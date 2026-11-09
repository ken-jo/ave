import { BrowserWindow, screen, type WebContents } from "electron";

/** Protocol clips already normalize guest zoom; only display pixel density affects output resolution. */
export function browserCapturePixelRatio(guest: WebContents): number {
  const window = BrowserWindow.fromWebContents(guest.hostWebContents ?? guest);
  const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  return display.scaleFactor;
}
