import { canonicalAccelerator } from "./shortcuts.js";
import { validateExternalUrl } from "./external-url.js";
import { isRecord } from "./is-record.js";
import { BROWSER_CAPTURE_LIMITS, parseBrowserCaptureClip, type BrowserCaptureClip, type BrowserScreenshot } from "./browser-capture.js";

export const BROWSER_WORKSPACE_LIMITS = {
  bookmarks: 500, history: 1000, sitePermissions: 500, downloads: 100,
  urlLength: 8192, titleLength: 300, findLength: 256,
  previewBytes: 256_000, previewWidth: 320, previewHeight: 200,
} as const;

export type BrowserSitePermission = "camera" | "microphone" | "geolocation" | "notifications" | "fullscreen";
export type BrowserSiteDecision = "ask" | "allow" | "block";
export interface BrowserLibraryEntry { readonly url: string; readonly title: string; readonly at: number }
/** Who was acting on the page when it was visited. The agent's visits are kept apart from the user's own history. */
export const BROWSER_VISITORS = ["user", "agent"] as const;
export type BrowserVisitor = typeof BROWSER_VISITORS[number];
export interface BrowserHistoryEntry extends BrowserLibraryEntry { readonly by: BrowserVisitor }
export interface BrowserHistoryTarget { readonly url: string; readonly by: BrowserVisitor }
export interface BrowserSiteRule { readonly origin: string; readonly permission: BrowserSitePermission; readonly decision: BrowserSiteDecision }
export interface BrowserDownload {
  readonly id: string; readonly name: string; readonly receivedBytes: number; readonly totalBytes: number;
  /** `blocked`: the download was refused before it started (another Save dialog was open, or too many were cancelled). */
  readonly state: "progressing" | "completed" | "cancelled" | "interrupted" | "blocked"; readonly at: number;
  /** Why an interrupted download was not saved, when the user can act on it by choosing another folder. */
  readonly notice?: BrowserDownloadNotice;
}
/** `unsupported-volume`: the chosen folder's volume cannot replace a file safely. `volume-unknown`: its volume could not be checked. */
const BROWSER_DOWNLOAD_NOTICES = ["unsupported-volume", "volume-unknown"] as const;
export type BrowserDownloadNotice = typeof BROWSER_DOWNLOAD_NOTICES[number];
export interface BrowserWorkspaceTab {
  readonly tabId: string; readonly documentGeneration: number; readonly url: string; readonly title: string; readonly zoomFactor: number;
}
const BROWSER_LOAD_FAILURE_REASONS = ["dns", "connection", "offline", "certificate", "secure-connection", "blocked", "redirects", "crashed", "failed"] as const;
/** Why a tab's main frame is not showing a page: host-classified, with the network stack's own code kept as detail. */
export interface BrowserLoadError {
  readonly reason: typeof BROWSER_LOAD_FAILURE_REASONS[number];
  readonly code: number;
  /** The network stack's name for the failure, or the process exit reason. Diagnostic text, never page content. */
  readonly detail: string;
  /** The address that failed; empty when the failed navigation named none the browser may open. */
  readonly url: string;
}
/** Pending prompts one tab may hold; a page that raises more is answered as dismissed. */
export const BROWSER_PAGE_PROMPT_LIMIT = 8;
export const BROWSER_EXTERNAL_TARGET_LIMIT = 200;
export const BROWSER_REALM_LIMIT = 100;
/** `busy`: a Save dialog of the same page was still open. `rate`: the user cancelled several Save dialogs from this site in a row. */
const BROWSER_DOWNLOAD_BLOCK_REASONS = ["rate", "queue", "size", "staging"] as const;
export type BrowserDownloadBlockReason = typeof BROWSER_DOWNLOAD_BLOCK_REASONS[number];
export interface BrowserDownloadTarget { readonly id: string }
export interface BrowserAgentSiteGrant { readonly grant: "this-site" | "any-site" | null }
export function parseBrowserAgentSiteGrant(value: unknown): BrowserAgentSiteGrant | null {
  return isRecord(value) && keys(value, ["grant"]) && (value.grant === null || value.grant === "this-site" || value.grant === "any-site") ? { grant: value.grant } : null;
}
/** What to clear from the browser profile every tab shares. `siteData` is cookies and each site's stored data. */
export interface BrowserClearDataRequest { readonly history: boolean; readonly siteData: boolean; readonly cache: boolean }
/** Clear the cookies and stored data of the site the tab shows; `origin` proves which site the user was looking at. */
export interface BrowserClearSiteDataRequest extends BrowserWorkspaceTarget { readonly origin: string }
const BROWSER_DIALOG_TEXT_LIMIT = 2_000;
/** Dialogs one document may show before the rest end unanswered. */
export const BROWSER_DIALOG_DOCUMENT_LIMIT = 20;
/** The page dialogs the runtime delivers. It refuses a page's text-input dialog inside the page, so that one never arrives. */
export const BROWSER_PAGE_DIALOG_TYPES = ["alert", "confirm"] as const;
export type BrowserPageDialogType = typeof BROWSER_PAGE_DIALOG_TYPES[number];
/** A page dialog's text as the host shows it: line breaks kept, every other control character removed, bounded. */
export function browserDialogText(text: string): string {
  return Array.from(text.replaceAll("\r\n", "\n")).filter((character) => { const code = character.codePointAt(0) ?? 0; return character === "\n" || (code > 0x1f && code !== 0x7f); }).join("").slice(0, BROWSER_DIALOG_TEXT_LIMIT);
}
export const BROWSER_CREDENTIAL_LIMIT = 256;
/** Text with every control character removed, for a page-supplied string the host shows on one line. */
export function browserPlainText(text: string): string {
  return Array.from(text).filter((character) => { const code = character.codePointAt(0) ?? 0; return code > 0x1f && code !== 0x7f; }).join("");
}
/** Link schemes a page may ask to hand to the system's own app, each only after the user agrees in the tab. */
export const BROWSER_EXTERNAL_SCHEMES: readonly string[] = ["mailto", "tel"];
export type BrowserPermissionChoice = "allow-once" | "block" | "always-block";
/**
 * Something a page asked for that needs the user's answer, drawn by the host inside the tab's own panel and titled with the
 * host-computed origin. Text fields that come from the page are bounded and rendered as plain text.
 */
export type BrowserPagePrompt =
  | { readonly id: string; readonly kind: "permission"; readonly origin: string; readonly permissions: readonly BrowserSitePermission[] }
  /** The page asked to confirm before a navigation it started itself unloads it. */
  | { readonly id: string; readonly kind: "leave"; readonly origin: string }
  /** The page followed a link that is not a web page. `openable` links can be handed to the system's own app for them. */
  | { readonly id: string; readonly kind: "external"; readonly origin: string; readonly scheme: string; readonly target: string; readonly openable: boolean }
  /** The page called alert or confirm and waits for the answer. `message` is the page's text, shown as plain text. */
  | { readonly id: string; readonly kind: "dialog"; readonly origin: string; readonly dialog: BrowserPageDialogType; readonly message: string; readonly canBlock: boolean }
  /** A download from this page was refused before it started. `allow` lifts the site's limit so the user can try again. */
  | { readonly id: string; readonly kind: "downloadBlocked"; readonly origin: string; readonly name: string; readonly reason: BrowserDownloadBlockReason }
  /** The server asked for a user name and password (HTTP authentication). `realm` is the server's own label, as plain text. */
  | { readonly id: string; readonly kind: "signIn"; readonly origin: string; readonly realm: string };
export type BrowserPromptAnswer =
  | { readonly kind: "permission"; readonly choice: BrowserPermissionChoice }
  | { readonly kind: "leave"; readonly leave: boolean }
  | { readonly kind: "external"; readonly open: boolean }
  /** `block` also ends every later dialog of the same document unanswered. */
  | { readonly kind: "dialog"; readonly accept: boolean; readonly block: boolean }
  | { readonly kind: "downloadBlocked"; readonly allow: boolean }
  /** Null cancels the request. The credentials are passed to the one request that asked and are stored nowhere. */
  | { readonly kind: "signIn"; readonly credentials: { readonly username: string; readonly password: string } | null };
export interface BrowserPromptAnswerRequest { readonly tabId: string; readonly promptId: string; readonly answer: BrowserPromptAnswer }
/** What the host knows about one tab's page beyond its address. One entry per listed tab. */
export interface BrowserPageStatus {
  readonly tabId: string;
  /** The main frame is fetching or rendering a navigation. */
  readonly loading: boolean;
  readonly loadError: BrowserLoadError | null;
  /** Oldest first. The tab shows the first one. */
  readonly prompts: readonly BrowserPagePrompt[];
}
export interface BrowserWorkspaceState {
  readonly revision: number; readonly bookmarks: readonly BrowserLibraryEntry[]; readonly history: readonly BrowserHistoryEntry[];
  readonly sitePermissions: readonly BrowserSiteRule[]; readonly downloads: readonly BrowserDownload[];
  readonly tabs: readonly BrowserWorkspaceTab[]; readonly pages: readonly BrowserPageStatus[]; readonly storageStatus: "ready" | "corrupt";
  readonly capabilities: { readonly fullscreen: boolean };
}
export interface BrowserWorkspaceTarget { readonly tabId: string; readonly documentGeneration: number }
export interface BrowserBookmarkRequest { readonly url: string; readonly title: string; readonly bookmarked: boolean }
export interface BrowserSitePermissionRequest extends BrowserWorkspaceTarget {
  readonly origin: string; readonly permission: BrowserSitePermission; readonly decision: BrowserSiteDecision;
}
export interface BrowserFindRequest extends BrowserWorkspaceTarget { readonly text: string; readonly forward: boolean; readonly findNext: boolean }
export interface BrowserZoomRequest extends BrowserWorkspaceTarget { readonly factor: number }
export interface BrowserLoadRequest extends BrowserWorkspaceTarget { readonly url: string }
export interface BrowserPreviewImage { readonly dataUrl: string; readonly width: number; readonly height: number }
export interface BrowserPreview extends BrowserWorkspaceTarget, BrowserPreviewImage {}
/** User selection geometry is relative to the visible viewport, in page CSS pixels. */
export interface BrowserCaptureRequest extends BrowserWorkspaceTarget {
  readonly fullPage?: boolean;
  readonly clip?: BrowserCaptureClip;
}
export interface BrowserCapture extends BrowserWorkspaceTarget, Omit<BrowserScreenshot, "data" | "mimeType"> {
  readonly dataUrl: string;
}
export const BROWSER_WORKSPACE_ERRORS = ["bad-request", "unauthorized-frame", "no-such-tab", "stale-document", "origin-mismatch", "window-hidden", "capture-busy", "capture-throttled", "capture-unavailable", "storage-unavailable", "operation-failed"] as const;
export type BrowserWorkspaceError = typeof BROWSER_WORKSPACE_ERRORS[number];
export type BrowserWorkspaceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BrowserWorkspaceError };
export interface BrowserWorkspaceApi {
  getState(): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  setBookmark(request: BrowserBookmarkRequest): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  clearHistory(): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  setSitePermission(request: BrowserSitePermissionRequest): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  find(request: BrowserFindRequest): Promise<BrowserWorkspaceResult<{ readonly requestId: number }>>;
  stopFind(request: BrowserWorkspaceTarget): Promise<BrowserWorkspaceResult<null>>;
  zoom(request: BrowserZoomRequest): Promise<BrowserWorkspaceResult<{ readonly factor: number }>>;
  preview(request: BrowserWorkspaceTarget): Promise<BrowserWorkspaceResult<BrowserPreview>>;
  capture(request: BrowserCaptureRequest): Promise<BrowserWorkspaceResult<BrowserCapture>>;
  /** Load again the address whose load failed in this tab, or restart its crashed page. */
  retryLoad(request: BrowserWorkspaceTarget): Promise<BrowserWorkspaceResult<null>>;
  /** Load `url` in the tab's existing page, even when the tab is already pointed at it. */
  load(request: BrowserLoadRequest): Promise<BrowserWorkspaceResult<null>>;
  /** The user is about to navigate this tab from the app's own controls: the page may not hold that navigation back. */
  userNavigation(request: BrowserWorkspaceTarget): Promise<BrowserWorkspaceResult<null>>;
  /** Answer one pending page prompt of a tab. */
  answerPrompt(request: BrowserPromptAnswerRequest): Promise<BrowserWorkspaceResult<null>>;
  /** Stop the tab's load in progress. */
  stopLoad(request: BrowserWorkspaceTarget): Promise<BrowserWorkspaceResult<null>>;
  /** What the agent of the conversation that owns this tab may open: this site, any site, or nothing. Memory of this session only. */
  agentSiteGrant(request: BrowserClearSiteDataRequest): Promise<BrowserWorkspaceResult<BrowserAgentSiteGrant>>;
  /** Take that access back. The agent's next request for the site asks the user again. */
  revokeAgentSiteGrant(request: BrowserClearSiteDataRequest): Promise<BrowserWorkspaceResult<null>>;
  /** Remove one visit from the history: the user's own, or one of the agent's. */
  deleteHistory(request: BrowserHistoryTarget): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  clearData(request: BrowserClearDataRequest): Promise<BrowserWorkspaceResult<BrowserWorkspaceState>>;
  clearSiteData(request: BrowserClearSiteDataRequest): Promise<BrowserWorkspaceResult<null>>;
  /** Reveal a finished download in the system's file manager. The path never leaves main. */
  showDownload(request: BrowserDownloadTarget): Promise<BrowserWorkspaceResult<null>>;
  cancelDownload(request: BrowserDownloadTarget): Promise<BrowserWorkspaceResult<null>>;
  onChanged(handler: (state: BrowserWorkspaceState) => void): () => void;
  /** Main refused a page guest before it attached; `src` is the address the refused element carried. */
  onAttachBlocked(handler: (blocked: BrowserAttachBlocked) => void): () => void;
  onOpenTab(handler: (request: BrowserOpenTab) => void): () => void;
  /** Tell the host which keys act on a page while that page has the keyboard. */
  setPageShortcuts(request: BrowserPageShortcuts): Promise<BrowserWorkspaceResult<null>>;
  /** One of those keys was pressed in a tab's page. */
  onPageShortcut(handler: (shortcut: BrowserPageShortcut) => void): () => void;
  /** The final count of each find, named by the request id `find` returned. */
  onFindResult(handler: (result: BrowserFindResult) => void): () => void;
}
export interface BrowserAttachBlocked { readonly src: string }
/** A page asked for a link in a new tab: the tab opens beside the tab that asked. `active` is false for a background tab. */
export interface BrowserOpenTab { readonly openerTabId: string; readonly url: string; readonly active: boolean }
/** What a key pressed while a tab's page has the keyboard asks of that tab. */
export const BROWSER_PAGE_SHORTCUT_ACTIONS = ["focusAddress", "find", "reload", "back", "forward"] as const;
export type BrowserPageShortcutAction = typeof BROWSER_PAGE_SHORTCUT_ACTIONS[number];
/** The key each action answers to right now, as the window resolved it from the user's bindings; null when it has none. */
export type BrowserPageShortcuts = Readonly<Record<BrowserPageShortcutAction, string | null>>;
export interface BrowserPageShortcut { readonly tabId: string; readonly action: BrowserPageShortcutAction }
export function parseBrowserPageShortcut(value: unknown): BrowserPageShortcut | null {
  if (!isRecord(value) || !keys(value, ["tabId", "action"]) || typeof value.tabId !== "string" || value.tabId.length === 0 || value.tabId.length > 512) return null;
  const action = BROWSER_PAGE_SHORTCUT_ACTIONS.find((candidate) => candidate === value.action);
  return action ? { tabId: value.tabId, action } : null;
}
/** How a find in a tab's page ended: how many matches the page has and which one is selected (0 when there are none). */
export interface BrowserFindResult { readonly tabId: string; readonly requestId: number; readonly matches: number; readonly activeMatch: number }
export function parseBrowserFindResult(value: unknown): BrowserFindResult | null {
  if (!isRecord(value) || !keys(value, ["tabId", "requestId", "matches", "activeMatch"]) || typeof value.tabId !== "string" || value.tabId.length === 0 || value.tabId.length > 512) return null;
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && Number(item) >= 0;
  if (!count(value.requestId) || !count(value.matches) || !count(value.activeMatch) || value.activeMatch > value.matches) return null;
  return { tabId: value.tabId, requestId: value.requestId, matches: value.matches, activeMatch: value.activeMatch };
}
export function parseBrowserOpenTab(value: unknown): BrowserOpenTab | null {
  if (!isRecord(value) || !keys(value, ["openerTabId", "url", "active"]) || typeof value.active !== "boolean") return null;
  if (typeof value.openerTabId !== "string" || value.openerTabId.length === 0 || value.openerTabId.length > 512) return null;
  if (typeof value.url !== "string" || browserWorkspaceUrl(value.url) !== value.url) return null;
  return { openerTabId: value.openerTabId, url: value.url, active: value.active };
}
export function parseBrowserAttachBlocked(value: unknown): BrowserAttachBlocked | null {
  return isRecord(value) && keys(value, ["src"]) && typeof value.src === "string" && value.src.length <= BROWSER_WORKSPACE_LIMITS.urlLength
    ? { src: value.src } : null;
}
export interface BrowserWorkspaceRequests {
  getState: undefined; setBookmark: BrowserBookmarkRequest; clearHistory: undefined; setSitePermission: BrowserSitePermissionRequest;
  find: BrowserFindRequest; stopFind: BrowserWorkspaceTarget; zoom: BrowserZoomRequest; preview: BrowserWorkspaceTarget;
  capture: BrowserCaptureRequest; retryLoad: BrowserWorkspaceTarget; stopLoad: BrowserWorkspaceTarget; load: BrowserLoadRequest; showDownload: BrowserDownloadTarget; cancelDownload: BrowserDownloadTarget; clearData: BrowserClearDataRequest; deleteHistory: BrowserHistoryTarget; setPageShortcuts: BrowserPageShortcuts; agentSiteGrant: BrowserClearSiteDataRequest; revokeAgentSiteGrant: BrowserClearSiteDataRequest; clearSiteData: BrowserClearSiteDataRequest;
  answerPrompt: BrowserPromptAnswerRequest; userNavigation: BrowserWorkspaceTarget;
}
export const BROWSER_SITE_PERMISSIONS: readonly BrowserSitePermission[] = ["camera", "microphone", "geolocation", "notifications", "fullscreen"];
export const BROWSER_SITE_DECISIONS: readonly BrowserSiteDecision[] = ["ask", "allow", "block"];

function keys(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(record).length === fields.length && fields.every((key) => Object.hasOwn(record, key));
}
export function browserWorkspaceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > BROWSER_WORKSPACE_LIMITS.urlLength) return null;
  const result = validateExternalUrl(value);
  return result.ok && result.url.length <= BROWSER_WORKSPACE_LIMITS.urlLength ? result.url : null;
}
export function browserWorkspaceOrigin(value: unknown): string | null {
  const url = browserWorkspaceUrl(value);
  if (url === null || typeof value !== "string") return null;
  const origin = new URL(url).origin;
  return value === origin ? origin : null;
}
function target(record: Record<string, unknown>): boolean {
  return typeof record.tabId === "string" && record.tabId.length > 0 && record.tabId.length <= 200
    && Number.isSafeInteger(record.documentGeneration) && Number(record.documentGeneration) >= 1;
}
const PERMISSION_CHOICES: readonly string[] = ["allow-once", "block", "always-block"];
function validPromptAnswer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "permission") return keys(value, ["kind", "choice"]) && PERMISSION_CHOICES.includes(value.choice as string);
  if (value.kind === "leave") return keys(value, ["kind", "leave"]) && typeof value.leave === "boolean";
  if (value.kind === "external") return keys(value, ["kind", "open"]) && typeof value.open === "boolean";
  if (value.kind === "dialog") {
    return keys(value, ["kind", "accept", "block"]) && typeof value.accept === "boolean" && typeof value.block === "boolean";
  }
  if (value.kind === "downloadBlocked") return keys(value, ["kind", "allow"]) && typeof value.allow === "boolean";
  if (value.kind === "signIn") {
    if (!keys(value, ["kind", "credentials"])) return false;
    const credentials = value.credentials;
    return credentials === null || (isRecord(credentials) && keys(credentials, ["username", "password"])
      && [credentials.username, credentials.password].every((item) => typeof item === "string" && item.length <= BROWSER_CREDENTIAL_LIMIT));
  }
  return false;
}
function validPrompt(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64 || !browserWorkspaceOrigin(value.origin)) return false;
  if (value.kind === "permission") {
    return keys(value, ["id", "kind", "origin", "permissions"]) && Array.isArray(value.permissions) && value.permissions.length > 0
      && value.permissions.length <= BROWSER_SITE_PERMISSIONS.length && value.permissions.every((item) => BROWSER_SITE_PERMISSIONS.includes(item as BrowserSitePermission));
  }
  if (value.kind === "leave") return keys(value, ["id", "kind", "origin"]);
  if (value.kind === "dialog") {
    return keys(value, ["id", "kind", "origin", "dialog", "message", "canBlock"]) && BROWSER_PAGE_DIALOG_TYPES.includes(value.dialog as BrowserPageDialogType)
      && typeof value.canBlock === "boolean" && typeof value.message === "string" && value.message === browserDialogText(value.message);
  }
  if (value.kind === "downloadBlocked") {
    return keys(value, ["id", "kind", "origin", "name", "reason"]) && BROWSER_DOWNLOAD_BLOCK_REASONS.includes(value.reason as BrowserDownloadBlockReason)
      && typeof value.name === "string" && value.name.length <= 300 && value.name === browserPlainText(value.name);
  }
  if (value.kind === "signIn") {
    return keys(value, ["id", "kind", "origin", "realm"]) && typeof value.realm === "string" && value.realm.length <= BROWSER_REALM_LIMIT && value.realm === browserPlainText(value.realm);
  }
  if (value.kind === "external") {
    return keys(value, ["id", "kind", "origin", "scheme", "target", "openable"]) && typeof value.openable === "boolean"
      && typeof value.scheme === "string" && /^[a-z][a-z0-9+.-]{0,31}$/.test(value.scheme)
      && typeof value.target === "string" && value.target.length <= BROWSER_EXTERNAL_TARGET_LIMIT && value.target === browserPlainText(value.target);
  }
  return false;
}
export function parseBrowserWorkspaceRequest<K extends keyof BrowserWorkspaceRequests>(operation: K, value: unknown): BrowserWorkspaceRequests[K] | null {
  if (operation === "getState" || operation === "clearHistory") return value === undefined ? undefined as BrowserWorkspaceRequests[K] : null;
  const record = value;
  if (!isRecord(record)) return null;
  if (operation === "showDownload" || operation === "cancelDownload") {
    return isRecord(value) && keys(value, ["id"]) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200 ? { id: value.id } as BrowserWorkspaceRequests[K] : null;
  }
  if (operation === "setPageShortcuts") {
    if (!isRecord(value) || !keys(value, [...BROWSER_PAGE_SHORTCUT_ACTIONS])) return null;
    // Each key is the registry's own canonical spelling, so the host matches exactly what the window shows.
    for (const action of BROWSER_PAGE_SHORTCUT_ACTIONS) if (value[action] !== null && (typeof value[action] !== "string" || canonicalAccelerator(value[action]) !== value[action])) return null;
    return { ...value } as BrowserWorkspaceRequests[K];
  }
  if (operation === "deleteHistory") {
    if (!isRecord(value) || !keys(value, ["url", "by"]) || browserWorkspaceUrl(value.url) !== value.url || !BROWSER_VISITORS.includes(value.by as BrowserVisitor)) return null;
    return { url: value.url, by: value.by } as BrowserWorkspaceRequests[K];
  }
  if (operation === "clearData") {
    if (!isRecord(value) || !keys(value, ["history", "siteData", "cache"])) return null;
    const { history, siteData, cache } = value;
    if (typeof history !== "boolean" || typeof siteData !== "boolean" || typeof cache !== "boolean" || !(history || siteData || cache)) return null;
    return { history, siteData, cache } as BrowserWorkspaceRequests[K];
  }
  if (operation === "clearSiteData" || operation === "agentSiteGrant" || operation === "revokeAgentSiteGrant") {
    if (!isRecord(value) || !keys(value, ["tabId", "documentGeneration", "origin"]) || !target(value) || !browserWorkspaceOrigin(value.origin)) return null;
    return { tabId: value.tabId, documentGeneration: value.documentGeneration, origin: value.origin } as BrowserWorkspaceRequests[K];
  }
  if (operation === "answerPrompt") {
    return keys(record, ["tabId", "promptId", "answer"]) && typeof record.tabId === "string" && record.tabId.length > 0 && record.tabId.length <= 200
      && typeof record.promptId === "string" && record.promptId.length > 0 && record.promptId.length <= 64 && validPromptAnswer(record.answer)
      ? record as unknown as BrowserWorkspaceRequests[K] : null;
  }
  if (operation === "setBookmark") {
    const url = browserWorkspaceUrl(record.url);
    if (!keys(record, ["url", "title", "bookmarked"]) || !url || typeof record.title !== "string" || record.title.length > BROWSER_WORKSPACE_LIMITS.titleLength || typeof record.bookmarked !== "boolean") return null;
    return { ...record, url } as unknown as BrowserWorkspaceRequests[K];
  }
  if (!target(record)) return null;
  if (operation === "capture") {
    if (Object.keys(record).some((key) => !["tabId", "documentGeneration", "fullPage", "clip"].includes(key))) return null;
    if (Object.hasOwn(record, "fullPage") && typeof record.fullPage !== "boolean") return null;
    if (Object.hasOwn(record, "clip") && !parseBrowserCaptureClip(record.clip)) return null;
    if (record.fullPage === true && Object.hasOwn(record, "clip")) return null;
  } else if (operation === "setSitePermission") {
    if (!keys(record, ["tabId", "documentGeneration", "origin", "permission", "decision"]) || !browserWorkspaceOrigin(record.origin)
      || !BROWSER_SITE_PERMISSIONS.includes(record.permission as BrowserSitePermission) || !BROWSER_SITE_DECISIONS.includes(record.decision as BrowserSiteDecision)) return null;
  } else if (operation === "find") {
    if (!keys(record, ["tabId", "documentGeneration", "text", "forward", "findNext"]) || typeof record.text !== "string" || !record.text.trim() || record.text.length > BROWSER_WORKSPACE_LIMITS.findLength || typeof record.forward !== "boolean" || typeof record.findNext !== "boolean") return null;
  } else if (operation === "load") {
    const url = browserWorkspaceUrl(record.url);
    if (!keys(record, ["tabId", "documentGeneration", "url"]) || !url) return null;
    return { ...record, url } as unknown as BrowserWorkspaceRequests[K];
  } else if (operation === "zoom") {
    if (!keys(record, ["tabId", "documentGeneration", "factor"]) || typeof record.factor !== "number" || !Number.isFinite(record.factor) || record.factor < 0.5 || record.factor > 3) return null;
  } else if (!keys(record, ["tabId", "documentGeneration"])) return null;
  return record as unknown as BrowserWorkspaceRequests[K];
}

/** The latest moment a date can hold. A stored time beyond it, or one that is not a whole millisecond, is corrupt. */
const BROWSER_LAST_TIME = 8.64e15;
function browserTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= BROWSER_LAST_TIME;
}

/** Persisted collections and host snapshots share this record validator. */
export function parseBrowserWorkspaceState(value: unknown): BrowserWorkspaceState | null {
  const record = value;
  if (!isRecord(record) || !keys(record, ["revision", "bookmarks", "history", "sitePermissions", "downloads", "tabs", "pages", "storageStatus", "capabilities"]) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 || typeof record.storageStatus !== "string" || !["ready", "corrupt"].includes(record.storageStatus)) return null;
  const capabilities = record.capabilities;
  if (!isRecord(capabilities) || !keys(capabilities, ["fullscreen"]) || typeof capabilities.fullscreen !== "boolean") return null;
  const library = (items: unknown, limit: number, visited = false): boolean => Array.isArray(items) && items.length <= limit && items.every((item) => {
    const entry = item;
    return isRecord(entry) && keys(entry, visited ? ["url", "title", "at", "by"] : ["url", "title", "at"]) && (!visited || BROWSER_VISITORS.includes(entry.by as BrowserVisitor)) && browserWorkspaceUrl(entry.url) === entry.url && typeof entry.title === "string" && entry.title.length <= BROWSER_WORKSPACE_LIMITS.titleLength && browserTimestamp(entry.at);
  });
  if (!library(record.bookmarks, BROWSER_WORKSPACE_LIMITS.bookmarks) || !library(record.history, BROWSER_WORKSPACE_LIMITS.history, true)) return null;
  if (!Array.isArray(record.sitePermissions) || record.sitePermissions.length > BROWSER_WORKSPACE_LIMITS.sitePermissions || !record.sitePermissions.every((item) => {
    const rule = item;
    return isRecord(rule) && keys(rule, ["origin", "permission", "decision"]) && browserWorkspaceOrigin(rule.origin) && BROWSER_SITE_PERMISSIONS.includes(rule.permission as BrowserSitePermission) && BROWSER_SITE_DECISIONS.includes(rule.decision as BrowserSiteDecision);
  })) return null;
  if (!Array.isArray(record.tabs) || record.tabs.length > 1000 || !record.tabs.every((item) => {
    const tab = item;
    return isRecord(tab) && keys(tab, ["tabId", "documentGeneration", "url", "title", "zoomFactor"]) && target(tab) && (tab.url === "about:blank" || browserWorkspaceUrl(tab.url) === tab.url) && typeof tab.title === "string" && tab.title.length <= BROWSER_WORKSPACE_LIMITS.titleLength && typeof tab.zoomFactor === "number" && Number.isFinite(tab.zoomFactor) && tab.zoomFactor > 0;
  })) return null;
  if (!Array.isArray(record.pages) || record.pages.length > record.tabs.length || !record.pages.every((item) => {
    const page = item;
    return isRecord(page) && keys(page, ["tabId", "loading", "loadError", "prompts"]) && typeof page.tabId === "string" && typeof page.loading === "boolean"
      && Array.isArray(page.prompts) && page.prompts.length <= BROWSER_PAGE_PROMPT_LIMIT && page.prompts.every(validPrompt)
      && new Set(page.prompts.map((prompt) => (prompt as { id: string }).id)).size === page.prompts.length
      && (record.tabs as readonly Record<string, unknown>[]).some((tab) => tab.tabId === page.tabId)
      && (page.loadError === null || validLoadError(page.loadError));
  })) return null;
  if (!Array.isArray(record.downloads) || record.downloads.length > BROWSER_WORKSPACE_LIMITS.downloads || !record.downloads.every((item) => {
    const download = item;
    const noticed = isRecord(download) && Object.hasOwn(download, "notice");
    return isRecord(download) && keys(download, ["id", "name", "receivedBytes", "totalBytes", "state", "at", ...(noticed ? ["notice"] : [])])
      && (!noticed || (download.state === "interrupted" && BROWSER_DOWNLOAD_NOTICES.includes(download.notice as BrowserDownloadNotice))) && typeof download.id === "string" && download.id.length > 0 && download.id.length <= 200 && typeof download.name === "string" && download.name.length <= 300 && typeof download.state === "string" && ["progressing", "completed", "cancelled", "interrupted", "blocked"].includes(download.state) && [download.receivedBytes, download.totalBytes, download.at].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0);
  })) return null;
  const unique = (items: readonly unknown[], identity: (entry: Record<string, unknown>) => string) => new Set(items.map((entry) => identity(entry as Record<string, unknown>))).size === items.length;
  if (!unique(record.bookmarks as unknown[], (entry) => String(entry.url)) || !unique(record.history as unknown[], (entry) => `${String(entry.by)}:${String(entry.url)}`) || !unique(record.sitePermissions, (entry) => `${entry.origin}:${entry.permission}`) || !unique(record.tabs, (entry) => String(entry.tabId)) || !unique(record.pages, (entry) => String(entry.tabId)) || !unique(record.downloads, (entry) => String(entry.id))) return null;
  return record as unknown as BrowserWorkspaceState;
}

export function parseBrowserWorkspacePreview(value: unknown): BrowserPreview | null {
  const record = value;
  if (!isRecord(record) || !keys(record, ["tabId", "documentGeneration", "dataUrl", "width", "height"]) || !target(record)) return null;
  return validPreviewImage(record) ? record as unknown as BrowserPreview : null;
}

/** Capture bytes remain page-derived image data even when they originate in host browser chrome. */
export function parseBrowserWorkspaceCapture(value: unknown): BrowserCapture | null {
  if (!isRecord(value)) return null;
  const captureMetadataFields = Object.hasOwn(value, "captureMethod") || Object.hasOwn(value, "stickyHeadersDeduplicated")
    ? ["captureMethod", "stickyHeadersDeduplicated"] : [];
  if (!keys(value, ["tabId", "documentGeneration", "dataUrl", "width", "height", "bytes", "originalWidth", "originalHeight", "scale", "truncated", ...captureMetadataFields]) || !target(value)) return null;
  if (captureMetadataFields.length > 0 && (value.captureMethod !== "scroll-and-stitch" || value.stickyHeadersDeduplicated !== false)) return null;
  if (typeof value.dataUrl !== "string" || value.dataUrl.length > Math.ceil(BROWSER_CAPTURE_LIMITS.bytes * 4 / 3) + 22
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl)) return null;
  const dimensions = [value.width, value.height, value.originalWidth, value.originalHeight];
  if (!dimensions.every((dimension) => Number.isSafeInteger(dimension) && Number(dimension) >= 1)
    || Number(value.width) * Number(value.height) > BROWSER_CAPTURE_LIMITS.pixels
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > BROWSER_CAPTURE_LIMITS.bytes
    || typeof value.scale !== "number" || !Number.isFinite(value.scale) || value.scale <= 0 || value.scale > 1
    || typeof value.truncated !== "boolean") return null;
  return value as unknown as BrowserCapture;
}
function validLoadError(value: unknown): boolean {
  return isRecord(value) && keys(value, ["reason", "code", "detail", "url"])
    && (BROWSER_LOAD_FAILURE_REASONS as readonly unknown[]).includes(value.reason)
    && Number.isSafeInteger(value.code) && typeof value.detail === "string" && value.detail.length <= 100
    && (value.url === "" || browserWorkspaceUrl(value.url) === value.url);
}
function validPreviewImage(record: Record<string, unknown>): boolean {
  if (typeof record.dataUrl !== "string" || record.dataUrl.length > Math.ceil(BROWSER_WORKSPACE_LIMITS.previewBytes * 4 / 3) + 23 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(record.dataUrl)) return false;
  return Number.isSafeInteger(record.width) && Number(record.width) >= 1 && Number(record.width) <= BROWSER_WORKSPACE_LIMITS.previewWidth && Number.isSafeInteger(record.height) && Number(record.height) >= 1 && Number(record.height) <= BROWSER_WORKSPACE_LIMITS.previewHeight;
}
/** A page thumbnail is untrusted page content: only a bounded JPEG data URL is ever rendered. */
export function parseBrowserPreviewImage(value: unknown): BrowserPreviewImage | null {
  if (!isRecord(value) || !validPreviewImage(value)) return null;
  return { dataUrl: value.dataUrl as string, width: value.width as number, height: value.height as number };
}
