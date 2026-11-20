/** The browser keys that act on a tab while its page has the keyboard, as the user's bindings resolve them. */
import { canonicalAccelerator, resolveShortcut, type ShortcutId, type ShortcutPlatform, type ShortcutResolutionInput } from "../../../shared/shortcuts.js";
import { BROWSER_PAGE_SHORTCUT_ACTIONS, type BrowserPageShortcutAction, type BrowserPageShortcuts } from "../../../shared/browser-workspace.js";

const SHORTCUT_OF: Record<BrowserPageShortcutAction, ShortcutId> = {
  focusAddress: "browser.focusAddress", find: "browser.find", reload: "browser.reload", back: "browser.back", forward: "browser.forward",
};

export function resolveBrowserPageShortcuts(input: ShortcutResolutionInput, platform: ShortcutPlatform): BrowserPageShortcuts {
  const resolved = {} as Record<BrowserPageShortcutAction, string | null>;
  for (const action of BROWSER_PAGE_SHORTCUT_ACTIONS) {
    const accelerator = resolveShortcut(SHORTCUT_OF[action], input, platform);
    resolved[action] = accelerator === null ? null : canonicalAccelerator(accelerator);
  }
  return resolved;
}
