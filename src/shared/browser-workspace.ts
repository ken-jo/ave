import { validateExternalUrl } from "./external-url.js";
import { isRecord } from "./is-record.js";

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
export interface BrowserWorkspaceState {
  readonly revision: number; readonly bookmarks: readonly BrowserLibraryEntry[]; readonly history: readonly BrowserLibraryEntry[];
  readonly sitePermissions: readonly BrowserSiteRule[]; readonly downloads: readonly BrowserDownload[];
  readonly tabs: readonly BrowserWorkspaceTab[]; readonly storageStatus: "ready" | "corrupt";
  readonly capabilities: { readonly fullscreen: boolean };
}
export interface BrowserWorkspaceTarget { readonly tabId: string; readonly documentGeneration: number }
export interface BrowserBookmarkRequest { readonly url: string; readonly title: string; readonly bookmarked: boolean }
export interface BrowserSitePermissionRequest extends BrowserWorkspaceTarget {
  readonly origin: string; readonly permission: BrowserSitePermission; readonly decision: BrowserSiteDecision;
}
export interface BrowserFindRequest extends BrowserWorkspaceTarget { readonly text: string; readonly forward: boolean; readonly findNext: boolean }
export interface BrowserZoomRequest extends BrowserWorkspaceTarget { readonly factor: number }
export interface BrowserPreviewImage { readonly dataUrl: string; readonly width: number; readonly height: number }
export interface BrowserPreview extends BrowserWorkspaceTarget, BrowserPreviewImage {}
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
  onChanged(handler: (state: BrowserWorkspaceState) => void): () => void;
}
export interface BrowserWorkspaceRequests {
  getState: undefined; setBookmark: BrowserBookmarkRequest; clearHistory: undefined; setSitePermission: BrowserSitePermissionRequest;
  find: BrowserFindRequest; stopFind: BrowserWorkspaceTarget; zoom: BrowserZoomRequest; preview: BrowserWorkspaceTarget;
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
export function parseBrowserWorkspaceRequest<K extends keyof BrowserWorkspaceRequests>(operation: K, value: unknown): BrowserWorkspaceRequests[K] | null {
  if (operation === "getState" || operation === "clearHistory") return value === undefined ? undefined as BrowserWorkspaceRequests[K] : null;
  const record = value;
  if (!isRecord(record)) return null;
  if (operation === "setBookmark") {
    const url = browserWorkspaceUrl(record.url);
    if (!keys(record, ["url", "title", "bookmarked"]) || !url || typeof record.title !== "string" || record.title.length > BROWSER_WORKSPACE_LIMITS.titleLength || typeof record.bookmarked !== "boolean") return null;
    return { ...record, url } as unknown as BrowserWorkspaceRequests[K];
  }
  if (!target(record)) return null;
  if (operation === "setSitePermission") {
    if (!keys(record, ["tabId", "documentGeneration", "origin", "permission", "decision"]) || !browserWorkspaceOrigin(record.origin)
      || !BROWSER_SITE_PERMISSIONS.includes(record.permission as BrowserSitePermission) || !BROWSER_SITE_DECISIONS.includes(record.decision as BrowserSiteDecision)) return null;
  } else if (operation === "find") {
    if (!keys(record, ["tabId", "documentGeneration", "text", "forward", "findNext"]) || typeof record.text !== "string" || !record.text.trim() || record.text.length > BROWSER_WORKSPACE_LIMITS.findLength || typeof record.forward !== "boolean" || typeof record.findNext !== "boolean") return null;
  } else if (operation === "zoom") {
    if (!keys(record, ["tabId", "documentGeneration", "factor"]) || typeof record.factor !== "number" || !Number.isFinite(record.factor) || record.factor < 0.5 || record.factor > 3) return null;
  } else if (!keys(record, ["tabId", "documentGeneration"])) return null;
  return record as unknown as BrowserWorkspaceRequests[K];
}

/** Persisted collections and host snapshots share this record validator. */
export function parseBrowserWorkspaceState(value: unknown): BrowserWorkspaceState | null {
  const record = value;
  if (!isRecord(record) || !keys(record, ["revision", "bookmarks", "history", "sitePermissions", "downloads", "tabs", "storageStatus", "capabilities"]) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 || typeof record.storageStatus !== "string" || !["ready", "corrupt"].includes(record.storageStatus)) return null;
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
  if (!Array.isArray(record.downloads) || record.downloads.length > BROWSER_WORKSPACE_LIMITS.downloads || !record.downloads.every((item) => {
    const download = item;
    return isRecord(download) && keys(download, ["id", "name", "receivedBytes", "totalBytes", "state", "at"]) && typeof download.id === "string" && download.id.length > 0 && download.id.length <= 200 && typeof download.name === "string" && download.name.length <= 300 && typeof download.state === "string" && ["progressing", "completed", "cancelled", "interrupted"].includes(download.state) && [download.receivedBytes, download.totalBytes, download.at].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0);
  })) return null;
  const unique = (items: readonly unknown[], identity: (entry: Record<string, unknown>) => string) => new Set(items.map((entry) => identity(entry as Record<string, unknown>))).size === items.length;
  if (!unique(record.bookmarks as unknown[], (entry) => String(entry.url)) || !unique(record.history as unknown[], (entry) => String(entry.url)) || !unique(record.sitePermissions, (entry) => `${entry.origin}:${entry.permission}`) || !unique(record.tabs, (entry) => String(entry.tabId)) || !unique(record.downloads, (entry) => String(entry.id))) return null;
  return record as unknown as BrowserWorkspaceState;
}

export function parseBrowserWorkspacePreview(value: unknown): BrowserPreview | null {
  const record = value;
  if (!isRecord(record) || !keys(record, ["tabId", "documentGeneration", "dataUrl", "width", "height"]) || !target(record)) return null;
  return validPreviewImage(record) ? record as unknown as BrowserPreview : null;
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
