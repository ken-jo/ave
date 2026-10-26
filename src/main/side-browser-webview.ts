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
import { applyBrowserSessionIdentity } from "./browser-user-agent.js";
import { createLogger } from "../lib/logger.js";
import { browserWorkspaceOrigin, browserWorkspaceUrl } from "../shared/browser-workspace.js";
import type { BrowserPermissionDetails } from "./browser/browser-site-permissions.js";
import {
  browserWorkspaceGuestWindowId,
  getBrowserWorkspaceService,
  observeBrowserWorkspaceDownload,
  observeBrowserWorkspaceGuest,
  registerBrowserWorkspacePopup,
} from "./browser/browser-workspace-desktop.js";

const log = createLogger("ave");

export type SideBrowserAttachResult = "ignored" | "accepted" | "blocked";

// Protocol + embedded-credential rule, delegated to the shared authority (src/shared/external-url.ts) rather than re-implemented here.
function isHttpUrl(value: string): boolean {
  return validateExternalUrl(value).ok;
}

function permissionDetails(contents: WebContents | null, permission: string, details: unknown, requestingOrigin?: string): BrowserPermissionDetails | null {
  if (!contents || contents.isDestroyed() || !isSideBrowserContents(contents) || browserWorkspaceGuestWindowId(contents) === null) return null;
  // Sanitized writes have no device/read capability and remain safe for frames.
  if (permission === "clipboard-sanitized-write") return details && typeof details === "object" ? details as BrowserPermissionDetails : {};
  if (details === null || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record.isMainFrame !== true) return null;
  const current = browserWorkspaceUrl(contents.getURL());
  const requesting = browserWorkspaceUrl(record.requestingUrl);
  if (!current || current !== requesting || record.embeddingOrigin !== undefined) return null;
  const origin = new URL(current).origin;
  if (requestingOrigin !== undefined && browserWorkspaceOrigin(requestingOrigin) !== origin) return null;
  if (record.securityOrigin !== undefined && browserWorkspaceOrigin(record.securityOrigin) !== origin) return null;
  if (record.mediaTypes !== undefined && (!Array.isArray(record.mediaTypes) || record.mediaTypes.some((value) => typeof value !== "string"))) return null;
  if (record.mediaType !== undefined && typeof record.mediaType !== "string") return null;
  return details as BrowserPermissionDetails;
}

export function installSideBrowserPartitionPolicy(): void {
  const sideBrowserSession = session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
  applyBrowserSessionIdentity(sideBrowserSession);
  sideBrowserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const verified = permissionDetails(contents, permission, details);
    if (verified === null) { callback(false); return; }
    void getBrowserWorkspaceService().requestPermission(contents.id, permission, verified).then(callback, (error) => {
      log.warn({ error, permission }, "browser permission request failed");
      callback(false);
    });
  });
  sideBrowserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const verified = permissionDetails(contents, permission, details, requestingOrigin);
    return verified !== null && getBrowserWorkspaceService().checkPermission(contents!.id, permission, verified);
  });
  const downloadPolicy = createSideBrowserDownloadPolicy();
  sideBrowserSession.on("will-download", (event, item, contents) => {
    if (downloadPolicy(event, item, contents)) observeBrowserWorkspaceDownload(contents, item);
  });
}

// Download prompts one page origin may raise within {@link DOWNLOAD_RATE_WINDOW_MS}.
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

// Downloads always use native Save with no automatic path or launch.
// Permit one pending dialog per guest/popup and rate-limit prompts per origin to prevent attention flooding.
export function createSideBrowserDownloadPolicy(options: {
  now?: () => number;
  warn?: (fields: Record<string, unknown>, message: string) => void;
} = {}): (event: Pick<ElectronEvent, "preventDefault">, item: DownloadPolicyItem, contents: DownloadPolicyContents | null | undefined) => boolean {
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
      return false;
    }
    const at = now();
    const recent = (promptsByOrigin.get(origin) ?? []).filter((t) => at - t < DOWNLOAD_RATE_WINDOW_MS);
    if (recent.length >= DOWNLOAD_PROMPTS_PER_ORIGIN) {
      promptsByOrigin.set(origin, recent);
      event.preventDefault();
      warn({ origin, url: item.getURL() }, "side browser download cancelled: too many download prompts from this origin");
      return false;
    }
    recent.push(at);
    promptsByOrigin.set(origin, recent);
    pendingPrompt.add(contentsId);
    const settle = () => pendingPrompt.delete(contentsId);
    item.on("updated", () => {
      if (item.getSavePath()) settle();
    });
    item.on("done", settle);
    return true;
  };
}

export function isSideBrowserContents(contents: WebContents): boolean {
  return contents.session === session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
}

// Preferences forced on every remote-content surface of the side browser: the `<webview>` guest at attach time and every popup window it opens. Remote
// pages never get a preload, Node, or a nested `<webview>`.
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

// Admit concrete HTTP(S) popup URLs only: a script can execute through about:blank without cancellable navigation; guest bootstraps use attach policy.
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
    // A child of the main window whose side panel opened it, so it closes with that window instead of outliving it as a stray top-level window.
    parent: owner,
    // Native frame on purpose: the app's hidden-titlebar chrome relies on an in-page titlebar that a remote page does not have.
    webPreferences: webPreferences as BrowserWindowConstructorOptions["webPreferences"],
  };
}

// Guard guests and every popup recursively; global webview guards do not cover top-level popup windows.
// Require inherited session identity and parent popups to the owning main window; close foreign-session children.
export function attachSideBrowserWebview(contents: WebContents, owner: BrowserWindow): void {
  markAsLinkOwned(contents);
  observeBrowserWorkspaceGuest(contents, owner);
  contents.setWindowOpenHandler(({ url }) => {
    if (!isSideBrowserPopupUrlAllowed(url)) return { action: "deny" };
    if (owner.isDestroyed()) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: sideBrowserPopupOptions(owner) };
  });
  contents.on("did-create-window", (child) => {
    if (owner.isDestroyed() || !isSideBrowserContents(child.webContents)) {
      child.destroy();
      return;
    }
    if (registerBrowserWorkspacePopup(contents.id, child, owner) === null) {
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
