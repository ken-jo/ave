import { getMainWindows, mainWindowForContents } from "./app-state.js";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, type Point, type View, type WebContents } from "electron";
import { browserTabRegistry } from "./browser/browser-tab-registry.js";

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
// listener deliberately reacts only to editable controls or selected text.
export function installNativeEditContextMenu(contents: WebContents): void {
  contents.on("context-menu", (event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    if (!params.isEditable && !hasSelection) return;
    event.preventDefault();

    let window = mainWindowForContents(contents) ?? BrowserWindow.fromWebContents(contents);
    let x = params.x;
    let y = params.y;
    if (browserTabRegistry.isIndependentGuest(contents.id)) {
      if (!browserTabRegistry.allowsNativeContextMenu(contents.id)) return;
      const windowId = browserTabRegistry.guestWindowId(contents.id);
      const owner = getMainWindows().find(candidate => candidate.id === windowId);
      if (!owner?.isFocused() || !owner.isVisible() || owner.isMinimized() || !contents.isFocused()) return;
      const origin = contentsOrigin(owner.contentView, contents);
      if (!origin) return;
      window = owner;
      x += origin.x;
      y += origin.y;
    }

    const template: MenuItemConstructorOptions[] = params.isEditable
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
