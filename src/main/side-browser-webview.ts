import type { MainWindow } from "./main-window-host.js";
import { isBackgroundE2eRuntime } from "./e2e-window-presentation.js";
import { handleAgentBrowserPopup } from "./browser/browser-popup-navigation.js";
import {
  app,
  BrowserWindow,
  dialog,
  session,
  type BrowserWindowConstructorOptions,
  type Event as ElectronEvent,
  type WebContents,
} from "electron";
import { basename, join } from "node:path";
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
  registerBrowserDownloadAllowance,
  registerBrowserWorkspacePopup,
  reportBrowserWorkspaceBlockedDownload,
} from "./browser/browser-workspace-desktop.js";
import { hardenRemoteWebPreferences } from "./remote-browser-preferences.js";
import {
  BrowserDownloadStagingError,
  prepareBrowserDownloadStaging,
  stageBrowserDownload,
  sweepBrowserDownloadStaging,
  type BrowserDownloadStagingRoot,
  type ObservedDownload,
  type StageableDownloadItem,
  type StagedBrowserDownload,
} from "./browser/browser-download-staging.js";

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

/** Install the side browser session's identity, permission and download policies; `resourcePath` is the host resources folder. */
export async function installSideBrowserPartitionPolicy(resourcePath: string): Promise<void> {
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
  // A staging folder that cannot be verified, or a file helper that is missing or broken, refuses every download with a notice; nothing is
  // swept. Any other error still fails the install, but only once the session below refuses every download.
  let stagingRoot: BrowserDownloadStagingRoot | null = null;
  let unexpected: { error: unknown } | null = null;
  try {
    stagingRoot = prepareBrowserDownloadStaging(resourcePath);
    const swept = await sweepBrowserDownloadStaging(stagingRoot);
    if (swept > 0) log.info({ swept }, "removed browser downloads a previous run left staged");
  } catch (error) {
    if (error instanceof BrowserDownloadStagingError) log.warn({ error: error.message }, "browser downloads are refused: their staging folder or its file helper cannot be verified");
    else unexpected = { error };
    stagingRoot = null;
  }
  const downloadPolicy = createSideBrowserDownloadPolicy({
    onBlocked: (contents, item, reason) => reportBrowserWorkspaceBlockedDownload(contents.id, item.getFilename(), item.getURLChain(), reason),
    stage: (item, contents, turn, onOverLimit) => {
      if (stagingRoot === null) throw new BrowserDownloadStagingError("the download staging folder is unavailable");
      return stageBrowserDownload(item, { root: stagingRoot, askSavePath: (name) => askSavePath(contents, name), onOverLimit }, turn);
    },
  });
  registerBrowserDownloadAllowance(downloadPolicy.allowOrigin);
  sideBrowserSession.on("will-download", (event, item, contents) => {
    const download = downloadPolicy(event, item, contents);
    if (download) observeBrowserWorkspaceDownload(contents, download);
  });
  if (unexpected !== null) throw new SideBrowserPolicyInstallError(unexpected.error);
}

/** A staging setup error after the session's download-refusal handler was successfully registered. */
export class SideBrowserPolicyInstallError extends Error {
  constructor(cause: unknown) {
    super("browser download staging setup failed after the refusal policy was installed", { cause });
  }
}

// The system Save dialog, over the window that shows the page. Its folder is only where the dialog opens; the user picks the path.
async function askSavePath(contents: WebContents, name: string): Promise<string | null> {
  const host = contents.isDestroyed() ? null : contents.hostWebContents ?? contents;
  const window = host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null;
  const options = { defaultPath: join(app.getPath("downloads"), basename(name)) };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

// Download prompts one page origin may raise within {@link DOWNLOAD_RATE_WINDOW_MS}.
export const DOWNLOAD_PROMPTS_PER_ORIGIN = 3;
export const DOWNLOAD_RATE_WINDOW_MS = 60_000;
// Downloads, across all pages, that may wait for the user to answer their Save dialog. Each is paused while it waits, so together they
// hold at most this many times {@link UNANSWERED_DOWNLOAD_BYTES} in staging.
export const UNANSWERED_DOWNLOADS = 4;

export type SideBrowserDownloadPolicy = ((event: Pick<ElectronEvent, "preventDefault">, item: StageableDownloadItem, contents: WebContents) => ObservedDownload | null)
  & { /** The user asked for this site's downloads again: its cancelled prompts no longer count. */ allowOrigin(origin: string): void };
type DownloadPolicyContents = Pick<WebContents, "id" | "getURL">;
type DownloadRefusal = "rate" | "queue" | "size" | "staging";

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

// Downloads always ask with the system Save dialog and never launch a file; Ave never picks the final path. Each download is staged
// privately and paused, and the page's Save dialogs show one at a time, so a download that starts while one is open waits its turn
// instead of being lost. At most {@link UNANSWERED_DOWNLOADS} wait at once; Save dialogs the user did not save from are limited per
// origin, to prevent attention flooding, and a download the user saved is not held against the site. Every refusal is reported through
// `onBlocked`, and refusing one download never touches another.
export function createSideBrowserDownloadPolicy(options: {
  stage: (item: StageableDownloadItem, contents: WebContents, turn: Promise<void>, onOverLimit: () => void) => StagedBrowserDownload;
  now?: () => number;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  onBlocked?: (contents: DownloadPolicyContents, item: Pick<StageableDownloadItem, "getFilename" | "getURLChain">, reason: DownloadRefusal) => void;
}): SideBrowserDownloadPolicy {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((fields, message) => log.warn(fields, message));
  // Per page, the dialog the next download waits for.
  const dialogTurns = new Map<number, Promise<void>>();
  const promptsByOrigin = new Map<string, number[]>();
  let unanswered = 0;

  const policy = (event: Pick<ElectronEvent, "preventDefault">, item: StageableDownloadItem, contents: WebContents) => {
    const origin = originOf(contents.getURL());
    const refuse = (reason: DownloadRefusal, message: string) => {
      event.preventDefault();
      warn({ origin, url: item.getURL() }, `side browser download cancelled: ${message}`);
      options.onBlocked?.(contents, item, reason);
      return null;
    };
    const at = now();
    const recent = (promptsByOrigin.get(origin) ?? []).filter((t) => at - t < DOWNLOAD_RATE_WINDOW_MS);
    if (recent.length >= DOWNLOAD_PROMPTS_PER_ORIGIN) {
      promptsByOrigin.set(origin, recent);
      return refuse("rate", "too many download prompts from this origin");
    }
    if (unanswered >= UNANSWERED_DOWNLOADS) return refuse("queue", "too many downloads are waiting for a Save dialog");
    let staged: StagedBrowserDownload;
    try {
      staged = options.stage(item, contents, dialogTurns.get(contents.id) ?? Promise.resolve(), () => options.onBlocked?.(contents, item, "size"));
    } catch (error) {
      if (!(error instanceof BrowserDownloadStagingError)) throw error;
      return refuse("staging", error.message);
    }
    recent.push(at);
    promptsByOrigin.set(origin, recent);
    unanswered += 1;
    const turn = staged.answered.then((saved) => {
      unanswered -= 1;
      // The user chose where to save: this prompt was wanted, so it is not counted against the site.
      if (!saved) return;
      const counted = promptsByOrigin.get(origin);
      const index = counted?.indexOf(at) ?? -1;
      if (counted && index >= 0) counted.splice(index, 1);
    });
    dialogTurns.set(contents.id, turn);
    void turn.then(() => { if (dialogTurns.get(contents.id) === turn) dialogTurns.delete(contents.id); });
    return staged.download;
  };
  return Object.assign(policy, { allowOrigin: (origin: string) => { promptsByOrigin.delete(origin); } });
}

export function isSideBrowserContents(contents: WebContents): boolean {
  return contents.session === session.fromPartition(AVE_SIDE_BROWSER_PARTITION);
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
  // A web page that sets no background is drawn on white. An embedded guest is see-through unless told otherwise, which
  // put such a page on the app's own background and made its captured thumbnail black.
  input.webPreferences.transparent = false;
  return "accepted";
}

// Admit concrete HTTP(S) popup URLs only: a script can execute through about:blank without cancellable navigation; guest bootstraps use attach policy.
export function isSideBrowserPopupUrlAllowed(url: string): boolean {
  return isHttpUrl(url);
}

function sideBrowserPopupOptions(owner: MainWindow): BrowserWindowConstructorOptions {
  const webPreferences: Record<string, unknown> = {};
  hardenRemoteWebPreferences(webPreferences);
  return {
    show: !isBackgroundE2eRuntime(),
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
export function attachSideBrowserWebview(contents: WebContents, owner: MainWindow): void {
  markAsLinkOwned(contents);
  observeBrowserWorkspaceGuest(contents, owner);
  contents.setWindowOpenHandler(({ url, postBody, disposition }) => {
    if (handleAgentBrowserPopup(contents, url, postBody !== undefined)) return { action: "deny" };
    if (!isSideBrowserPopupUrlAllowed(url)) return { action: "deny" };
    if (owner.isDestroyed()) return { action: "deny" };
    // A link that asks for a new tab opens as a tab in the panel, with an address row and the panel's controls. Only a
    // page that asks for a window of its own (a sign-in popup with a size) still gets one; so does a form submission,
    // whose body a new tab could not carry.
    if ((disposition === "foreground-tab" || disposition === "background-tab") && postBody === undefined
      && getBrowserWorkspaceService().openLinkTab(owner.id, contents.id, url, disposition === "foreground-tab")) return { action: "deny" };
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
    if (isBackgroundE2eRuntime()) child.showInactive();
  });
  contents.on("will-navigate", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!isHttpUrl(details.url)) details.preventDefault();
  });
}
