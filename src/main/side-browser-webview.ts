import { session, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from "electron";
import { AVE_SIDE_BROWSER_PARTITION } from "../shared/side-browser.js";
import { validateExternalUrl } from "../shared/external-url.js";
import { markAsLinkOwned } from "./link-window-registry.js";
import { buildPersistentBrowserUserAgent } from "./browser-user-agent.js";

export type SideBrowserAttachResult = "ignored" | "accepted" | "blocked";

/**
 * Protocol + embedded-credential rule, delegated to the shared authority
 * (src/shared/external-url.ts) rather than re-implemented here.
 */
function isHttpUrl(value: string): boolean {
  return validateExternalUrl(value).ok;
}

/**
 * The only permissions a side-browser page is granted. The browser is meant to
 * work like a normal one for reading, signing in and downloading, but there is
 * no per-site prompt UI yet, so anything that reaches a device or the user's
 * attention (camera, microphone, location, notifications, MIDI, HID...) stays
 * denied. `fullscreen` is denied too: the app shows no exit hint for an
 * element going fullscreen, so a page could cover the whole app window and
 * draw a convincing copy of the approval UI. Request and check handlers read
 * the same set so they always agree.
 */
const SIDE_BROWSER_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
]);

function isSideBrowserPermissionAllowed(permission: string): boolean {
  return SIDE_BROWSER_ALLOWED_PERMISSIONS.has(permission);
}

export function installSideBrowserPartitionPolicy(): void {
  const sideBrowserSession = session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
  // Sign-in pages (Google, Microsoft) refuse UAs that carry `Electron/` as an
  // embedded browser; present the same vanilla Chromium/Edge UA as the link
  // viewer so logins in the in-app browser work and persist.
  sideBrowserSession.setUserAgent(buildPersistentBrowserUserAgent());
  sideBrowserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isSideBrowserPermissionAllowed(permission));
  });
  sideBrowserSession.setPermissionCheckHandler((_webContents, permission) =>
    isSideBrowserPermissionAllowed(permission));
  // Downloads are allowed. No `setSavePath` is called, so Electron shows the
  // native Save dialog and the user picks (or cancels) the destination — the
  // page can never write a file the user did not see.
}

export function isSideBrowserContents(contents: WebContents): boolean {
  return contents.session === session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
}

export function takePendingSideBrowserSrc(pendingSrcs: string[], attachedUrl: string): string | null {
  const index = pendingSrcs.indexOf(attachedUrl);
  if (index < 0) return null;
  return pendingSrcs.splice(index, 1)[0] ?? null;
}

/**
 * Preferences forced on every remote-content surface of the side browser: the
 * `<webview>` guest at attach time and every popup window it opens. Remote
 * pages never get a preload, Node, or a nested `<webview>`.
 */
function hardenRemoteWebPreferences(prefs: Record<string, unknown>): void {
  delete prefs.preload;
  delete prefs.preloadURL;
  delete prefs.additionalArguments;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.webSecurity = true;
  prefs.sandbox = true;
  prefs.javascript = true;
  prefs.webviewTag = false;
}

export function configureSideBrowserWebviewAttach(input: {
  event: { preventDefault: () => void };
  webPreferences: Record<string, unknown>;
  params: Record<string, string>;
  enqueueAllowedSrc: (src: string) => void;
}): SideBrowserAttachResult {
  if (input.params.partition !== AVE_SIDE_BROWSER_PARTITION) return "ignored";

  const src = input.params.src ?? "";
  if (!isHttpUrl(src)) {
    input.event.preventDefault();
    return "blocked";
  }

  hardenRemoteWebPreferences(input.webPreferences);
  input.webPreferences.partition = AVE_SIDE_BROWSER_PARTITION;

  input.enqueueAllowedSrc(src);
  return "accepted";
}

/**
 * Whether a side-browser page may open `url` as a new window. http(s) covers
 * `target=_blank` links and OAuth popups; `about:blank` is how many OAuth
 * libraries (and `window.open('')`) bootstrap a popup before navigating it,
 * and the blank document is then held to the same navigation guard.
 */
export function isSideBrowserPopupUrlAllowed(url: string): boolean {
  return url === "about:blank" || isHttpUrl(url);
}

function sideBrowserPopupOptions(owner: BrowserWindow): BrowserWindowConstructorOptions {
  const webPreferences: Record<string, unknown> = {};
  hardenRemoteWebPreferences(webPreferences);
  return {
    width: 520,
    height: 720,
    autoHideMenuBar: true,
    // A child of the main window whose side panel opened it, so it closes
    // with that window instead of outliving it as a stray top-level window.
    parent: owner,
    // Native frame on purpose: the app's hidden-titlebar chrome relies on an
    // in-page titlebar that a remote page does not have.
    webPreferences: webPreferences as BrowserWindowConstructorOptions["webPreferences"],
  };
}

/**
 * Install the side-browser guards on a remote-content `WebContents` — the
 * `<webview>` guest, and recursively every popup it (or a popup) opens.
 *
 * Popups are top-level `BrowserWindow`s (type `"window"`), so the global
 * webview guard in `main.ts` never sees them; these listeners are their only
 * gate. The popup's session is inherited from its opener (that is what keeps
 * `window.opener` working for OAuth `postMessage`); a child that somehow lands
 * on any other session is closed instead of trusted.
 *
 * `owner` is the main window whose side panel hosts the guest. Every popup in
 * the chain is parented to it, so closing that window closes them; once it is
 * gone, no further popup opens.
 */
export function attachSideBrowserWebview(contents: WebContents, owner: BrowserWindow): void {
  markAsLinkOwned(contents);
  contents.setWindowOpenHandler(({ url }) => {
    if (!isSideBrowserPopupUrlAllowed(url)) return { action: "deny" };
    if (owner.isDestroyed()) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: sideBrowserPopupOptions(owner) };
  });
  contents.on("did-create-window", (child) => {
    if (!isSideBrowserContents(child.webContents)) {
      child.destroy();
      return;
    }
    attachSideBrowserWebview(child.webContents, owner);
  });
  contents.on("will-navigate", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
}
