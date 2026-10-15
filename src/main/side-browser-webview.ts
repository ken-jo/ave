import {
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type Event as ElectronEvent,
  type WebContents,
} from "electron";
import { AVE_SIDE_BROWSER_PARTITION } from "../shared/side-browser.js";
import { validateExternalUrl } from "../shared/external-url.js";
import { markAsLinkOwned } from "./link-window-registry.js";
import { buildPersistentBrowserUserAgent } from "./browser-user-agent.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("ave");

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
  sideBrowserSession.on("will-download", createSideBrowserDownloadPolicy());
}

/** Download prompts one page origin may raise within {@link DOWNLOAD_RATE_WINDOW_MS}. */
export const DOWNLOAD_PROMPTS_PER_ORIGIN = 3;
export const DOWNLOAD_RATE_WINDOW_MS = 60_000;

type DownloadPolicyItem = Pick<DownloadItem, "getSavePath" | "getURL" | "on">;
type DownloadPolicyContents = Pick<WebContents, "id" | "getURL">;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/**
 * The side browser's `will-download` policy. Downloads work as in a normal
 * browser, through the native Save dialog, with three limits so a page cannot
 * use them to badger the user or write files unseen:
 *
 * - No `setSavePath` is ever called, so Electron always shows the Save dialog
 *   and the user picks (or cancels) the destination. Nothing opens the file
 *   once it is saved.
 * - One pending Save dialog per side browser (per guest or popup
 *   `WebContents`): a download requested while that browser's dialog is still
 *   open is cancelled.
 * - At most {@link DOWNLOAD_PROMPTS_PER_ORIGIN} prompts per page origin within
 *   {@link DOWNLOAD_RATE_WINDOW_MS}; further requests are cancelled and logged.
 *
 * A prompt stops being pending once the user picked a path (the item reports
 * a save path) or the item finished (saved, cancelled or interrupted).
 */
export function createSideBrowserDownloadPolicy(options: {
  now?: () => number;
  warn?: (fields: Record<string, unknown>, message: string) => void;
} = {}): (event: Pick<ElectronEvent, "preventDefault">, item: DownloadPolicyItem, contents: DownloadPolicyContents | null | undefined) => void {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((fields, message) => log.warn(fields, message));
  const pendingPrompt = new Set<number>();
  const promptsByOrigin = new Map<string, number[]>();

  return (event, item, contents) => {
    const origin = originOf(contents?.getURL() ?? "");
    const contentsId = contents?.id ?? -1;
    if (pendingPrompt.has(contentsId)) {
      event.preventDefault();
      warn({ origin, url: item.getURL() }, "side browser download cancelled: a Save dialog is already open");
      return;
    }
    const at = now();
    const recent = (promptsByOrigin.get(origin) ?? []).filter((t) => at - t < DOWNLOAD_RATE_WINDOW_MS);
    if (recent.length >= DOWNLOAD_PROMPTS_PER_ORIGIN) {
      promptsByOrigin.set(origin, recent);
      event.preventDefault();
      warn({ origin, url: item.getURL() }, "side browser download cancelled: too many download prompts from this origin");
      return;
    }
    recent.push(at);
    promptsByOrigin.set(origin, recent);
    pendingPrompt.add(contentsId);
    const settle = () => pendingPrompt.delete(contentsId);
    item.on("updated", () => {
      if (item.getSavePath()) settle();
    });
    item.on("done", settle);
  };
}

export function isSideBrowserContents(contents: WebContents): boolean {
  return contents.session === session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
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
}): SideBrowserAttachResult {
  if (input.params.partition !== AVE_SIDE_BROWSER_PARTITION) return "ignored";

  const src = input.params.src ?? "";
  if (src !== "about:blank" && !isHttpUrl(src)) {
    input.event.preventDefault();
    return "blocked";
  }

  hardenRemoteWebPreferences(input.webPreferences);
  input.webPreferences.partition = AVE_SIDE_BROWSER_PARTITION;
  return "accepted";
}

/**
 * Whether a side-browser page may open `url` as a new window. Blank popup
 * requests are ambiguous: a script URL can arrive as `about:blank` and execute
 * without a cancellable navigation event. Only concrete http(s) URLs are safe
 * to admit here. Blank guest bootstraps use the separate attach policy.
 */
export function isSideBrowserPopupUrlAllowed(url: string): boolean {
  return isHttpUrl(url);
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
