import type { ElectronApplication, Page } from "playwright";
import { withPageWindow } from "./renderer-events.js";

/** Read native content and document bounds independently of renderer layout tokens. */
export async function readWindowGeometry(app: ElectronApplication, page: Page) {
  return withPageWindow(app, page, window => {
    const content = window.getContentBounds();
    const view = window.contentView.children.find(child => "webContents" in child && child.webContents === window.webContents);
    const ui = view?.getBounds() ?? { x: 0, y: 0, width: content.width, height: content.height };
    return { content, ui, zoom: window.webContents.getZoomFactor() };
  });
}
