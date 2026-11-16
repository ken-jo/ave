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
export interface BrowserSiteRule { readonly origin: string; readonly permission: BrowserSitePermission; readonly decision: BrowserSiteDecision }
export interface BrowserDownload {
  readonly id: string; readonly name: string; readonly receivedBytes: number; readonly totalBytes: number;
  readonly state: "progressing" | "completed" | "cancelled" | "interrupted"; readonly at: number;
}
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
  | { readonly id: string; readonly kind: "external"; readonly origin: string; readonly scheme: string; readonly target: string; readonly openable: boolean };
export type BrowserPromptAnswer =
  | { readonly kind: "permission"; readonly choice: BrowserPermissionChoice }
  | { readonly kind: "leave"; readonly leave: boolean }
  | { readonly kind: "external"; readonly open: boolean };
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
  readonly revision: number; readonly bookmarks: readonly BrowserLibraryEntry[]; readonly history: readonly BrowserLibraryEntry[];
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
  onChanged(handler: (state: BrowserWorkspaceState) => void): () => void;
  /** Main refused a page guest before it attached; `src` is the address the refused element carried. */
  onAttachBlocked(handler: (blocked: BrowserAttachBlocked) => void): () => void;
}
export interface BrowserAttachBlocked { readonly src: string }
export function parseBrowserAttachBlocked(value: unknown): BrowserAttachBlocked | null {
  return isRecord(value) && keys(value, ["src"]) && typeof value.src === "string" && value.src.length <= BROWSER_WORKSPACE_LIMITS.urlLength
    ? { src: value.src } : null;
}
export interface BrowserWorkspaceRequests {
  getState: undefined; setBookmark: BrowserBookmarkRequest; clearHistory: undefined; setSitePermission: BrowserSitePermissionRequest;
  find: BrowserFindRequest; stopFind: BrowserWorkspaceTarget; zoom: BrowserZoomRequest; preview: BrowserWorkspaceTarget;
  capture: BrowserCaptureRequest; retryLoad: BrowserWorkspaceTarget; stopLoad: BrowserWorkspaceTarget; load: BrowserLoadRequest;
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
  return false;
}
function validPrompt(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64 || !browserWorkspaceOrigin(value.origin)) return false;
  if (value.kind === "permission") {
    return keys(value, ["id", "kind", "origin", "permissions"]) && Array.isArray(value.permissions) && value.permissions.length > 0
      && value.permissions.length <= BROWSER_SITE_PERMISSIONS.length && value.permissions.every((item) => BROWSER_SITE_PERMISSIONS.includes(item as BrowserSitePermission));
  }
  if (value.kind === "leave") return keys(value, ["id", "kind", "origin"]);
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

/** Persisted collections and host snapshots share this record validator. */
export function parseBrowserWorkspaceState(value: unknown): BrowserWorkspaceState | null {
  const record = value;
  if (!isRecord(record) || !keys(record, ["revision", "bookmarks", "history", "sitePermissions", "downloads", "tabs", "pages", "storageStatus", "capabilities"]) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 || typeof record.storageStatus !== "string" || !["ready", "corrupt"].includes(record.storageStatus)) return null;
  const capabilities = record.capabilities;
  if (!isRecord(capabilities) || !keys(capabilities, ["fullscreen"]) || typeof capabilities.fullscreen !== "boolean") return null;
  const library = (items: unknown, limit: number): boolean => Array.isArray(items) && items.length <= limit && items.every((item) => {
    const entry = item;
    return isRecord(entry) && keys(entry, ["url", "title", "at"]) && browserWorkspaceUrl(entry.url) === entry.url && typeof entry.title === "string" && entry.title.length <= BROWSER_WORKSPACE_LIMITS.titleLength && typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at >= 0;
  });
  if (!library(record.bookmarks, BROWSER_WORKSPACE_LIMITS.bookmarks) || !library(record.history, BROWSER_WORKSPACE_LIMITS.history)) return null;
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
    return isRecord(download) && keys(download, ["id", "name", "receivedBytes", "totalBytes", "state", "at"]) && typeof download.id === "string" && download.id.length > 0 && download.id.length <= 200 && typeof download.name === "string" && download.name.length <= 300 && typeof download.state === "string" && ["progressing", "completed", "cancelled", "interrupted"].includes(download.state) && [download.receivedBytes, download.totalBytes, download.at].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0);
  })) return null;
  const unique = (items: readonly unknown[], identity: (entry: Record<string, unknown>) => string) => new Set(items.map((entry) => identity(entry as Record<string, unknown>))).size === items.length;
  if (!unique(record.bookmarks as unknown[], (entry) => String(entry.url)) || !unique(record.history as unknown[], (entry) => String(entry.url)) || !unique(record.sitePermissions, (entry) => `${entry.origin}:${entry.permission}`) || !unique(record.tabs, (entry) => String(entry.tabId)) || !unique(record.pages, (entry) => String(entry.tabId)) || !unique(record.downloads, (entry) => String(entry.id))) return null;
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
