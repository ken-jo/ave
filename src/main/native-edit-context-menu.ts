import { getMainWindows, mainWindowForContents } from "./app-state.js";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, type Point, type View, type WebContents } from "electron";
import { browserTabRegistry } from "./browser/browser-tab-registry.js";
import { mainWindowUiOrigin } from "./main-window-host.js";
import { browserPageMenuItems } from "./browser/browser-workspace-desktop.js";

function contentsOrigin(view: View, contents: WebContents, origin: Point = { x: 0, y: 0 }): Point | null {
  if ("webContents" in view && view.webContents === contents) return origin;
  for (const child of view.children) {
    const bounds = child.getBounds();
    const found = contentsOrigin(child, contents, { x: origin.x + bounds.x, y: origin.y + bounds.y });
    if (found) return found;
  }
  return null;
}

// Install the OS-native editing menu for user editing in app, auxiliary and native page renderers. Domain-specific menus use the allow-listed UI IPC bridge instead; this
// listener deliberately reacts only to editable controls or selected text, except in the agent's own page view, which shows the browser's page menu.
export function installNativeEditContextMenu(contents: WebContents): void {
  contents.on("context-menu", (event, params) => {
    // A browser popup's menu is its own: the browser's page menu with the pause control.
    if (browserTabRegistry.isPopupGuest(contents.id)) return;
    const independent = browserTabRegistry.isIndependentGuest(contents.id);
    const hasSelection = params.selectionText.trim().length > 0;
    // The agent's own page view shows the browser's page menu (which carries these items too) anywhere on the page.
    if (!independent && !params.isEditable && !hasSelection) return;
    event.preventDefault();

    const mainWindow = mainWindowForContents(contents);
    let window = mainWindow ?? BrowserWindow.fromWebContents(contents);
    let x = params.x;
    let y = params.y;
    if (mainWindow) {
      const origin = mainWindowUiOrigin(mainWindow);
      x += origin.x;
      y += origin.y;
    }
    let windowId: number | null = null;
    if (independent) {
      if (!browserTabRegistry.allowsNativeContextMenu(contents.id)) return;
      windowId = browserTabRegistry.guestWindowId(contents.id);
      const owner = getMainWindows().find(candidate => candidate.id === windowId);
      if (!owner?.isFocused() || !owner.isVisible() || owner.isMinimized() || !contents.isFocused()) return;
      const origin = contentsOrigin(owner.contentView, contents);
      if (!origin) return;
      window = owner;
      x += origin.x;
      y += origin.y;
    }

    const template: MenuItemConstructorOptions[] = windowId !== null ? browserPageMenuItems(contents, windowId, params, true) : params.isEditable
      ? [
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        ]
      : [
          { role: "copy", enabled: params.editFlags.canCopy || hasSelection },
          { type: "separator" },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup(window
      ? { window, x, y }
      : { x, y });
  });
}
