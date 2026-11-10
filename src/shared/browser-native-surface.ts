import { hasOnlyKeys, isRecord } from "./is-record.js";

export const BROWSER_NATIVE_FAVICON_MAX_LENGTH = 131072;

export interface BrowserNativeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserNativeSurfaceState {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly epoch: number;
  readonly revision: number;
  readonly url: string;
  readonly title: string;
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly visible: boolean;
}

export interface BrowserNativeSurfaceChanged {
  readonly tabId: string;
  readonly surface: BrowserNativeSurfaceState | null;
}

export type BrowserNativeSurfaceRequest =
  | { readonly action: "create"; readonly tabId: string; readonly requestId?: string }
  | {
    readonly action: "present";
    readonly tabId: string;
    readonly webContentsId: number;
    readonly epoch: number;
    readonly sequence: number;
    readonly bounds: BrowserNativeBounds | null;
    readonly clipBounds?: BrowserNativeBounds;
    readonly borderRadius?: number;
  }
  | { readonly action: "navigate"; readonly tabId: string; readonly webContentsId: number; readonly url: string }
  | { readonly action: "back" | "forward" | "reload" | "focus" | "close" | "devtools"; readonly tabId: string; readonly webContentsId: number };

export type BrowserNativeSurfaceResult =
  | { readonly ok: true; readonly surface: BrowserNativeSurfaceState | null; readonly initialNavigation?: boolean }
  | { readonly ok: false; readonly error: "bad-request" | "unauthorized-frame" | "native-surface-unavailable" | "stale-surface" };

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseBounds(value: unknown): BrowserNativeBounds | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y", "width", "height"])) return null;
  const { x, y, width, height } = value;
  if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1_000_000
    || typeof y !== "number" || !Number.isFinite(y) || Math.abs(y) > 1_000_000
    || typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 32768
    || typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > 32768) return null;
  return { x, y, width, height };
}

export function parseBrowserNativeSurfaceRequest(value: unknown): BrowserNativeSurfaceRequest | null {
  if (!isRecord(value) || !isId(value.tabId)) return null;
  const tabId = value.tabId;
  if (value.action === "create") {
    if (!hasOnlyKeys(value, ["action", "tabId", "requestId"]) || value.requestId !== undefined && !isId(value.requestId)) return null;
    return { action: "create", tabId, ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}) };
  }
  if (!isPositiveInteger(value.webContentsId)) return null;
  const webContentsId = value.webContentsId;
  if (value.action === "present") {
    if (!hasOnlyKeys(value, ["action", "tabId", "webContentsId", "epoch", "sequence", "bounds", "clipBounds", "borderRadius"])
      || !isPositiveInteger(value.epoch) || !isPositiveInteger(value.sequence)) return null;
    const bounds = value.bounds === null ? null : parseBounds(value.bounds);
    const clipBounds = value.clipBounds === undefined ? undefined : parseBounds(value.clipBounds);
    if (value.bounds !== null && bounds === null || clipBounds === null
      || value.borderRadius !== undefined && (typeof value.borderRadius !== "number"
        || !Number.isFinite(value.borderRadius) || value.borderRadius < 0 || value.borderRadius > 32768)) return null;
    return { action: "present", tabId, webContentsId, epoch: value.epoch, sequence: value.sequence, bounds,
      ...(clipBounds === undefined ? {} : { clipBounds }),
      ...(typeof value.borderRadius === "number" ? { borderRadius: value.borderRadius } : {}) };
  }
  if (value.action === "navigate") {
    if (!hasOnlyKeys(value, ["action", "tabId", "webContentsId", "url"]) || typeof value.url !== "string" || value.url.length > 32768) return null;
    return { action: "navigate", tabId, webContentsId, url: value.url };
  }
  if (["back", "forward", "reload", "focus", "close", "devtools"].includes(String(value.action))
    && hasOnlyKeys(value, ["action", "tabId", "webContentsId"])) {
    return { action: value.action as "back" | "forward" | "reload" | "focus" | "close" | "devtools", tabId, webContentsId };
  }
  return null;
}

function parseBrowserNativeSurfaceState(value: unknown): BrowserNativeSurfaceState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tabId", "webContentsId", "epoch", "revision", "url", "title", "favicon", "loading", "canGoBack", "canGoForward", "visible"])
    || !isId(value.tabId) || !isPositiveInteger(value.webContentsId) || !isPositiveInteger(value.epoch)
    || !isPositiveInteger(value.revision) || typeof value.url !== "string" || typeof value.title !== "string"
    || value.favicon !== null && (typeof value.favicon !== "string" || value.favicon.length > BROWSER_NATIVE_FAVICON_MAX_LENGTH)
    || typeof value.loading !== "boolean" || typeof value.canGoBack !== "boolean"
    || typeof value.canGoForward !== "boolean" || typeof value.visible !== "boolean") return null;
  return { tabId: value.tabId, webContentsId: value.webContentsId, epoch: value.epoch, revision: value.revision,
    url: value.url, title: value.title, favicon: value.favicon as string | null, loading: value.loading, canGoBack: value.canGoBack, canGoForward: value.canGoForward, visible: value.visible };
}

export function parseBrowserNativeSurfaceChanged(value: unknown): BrowserNativeSurfaceChanged | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tabId", "surface"]) || !isId(value.tabId)) return null;
  const surface = value.surface === null ? null : parseBrowserNativeSurfaceState(value.surface);
  if (value.surface !== null && surface === null || surface !== null && surface.tabId !== value.tabId) return null;
  return { tabId: value.tabId, surface };
}

export function parseBrowserNativeSurfaceResult(value: unknown): BrowserNativeSurfaceResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && hasOnlyKeys(value, ["ok", "surface", "initialNavigation"])) {
    const surface = value.surface === null ? null : parseBrowserNativeSurfaceState(value.surface);
    if (value.surface !== null && surface === null || value.initialNavigation !== undefined && (typeof value.initialNavigation !== "boolean" || surface === null)) return null;
    return { ok: true, surface, ...(value.initialNavigation === undefined ? {} : { initialNavigation: value.initialNavigation as boolean }) };
  }
  if (value.ok === false && hasOnlyKeys(value, ["ok", "error"])
    && ["bad-request", "unauthorized-frame", "native-surface-unavailable", "stale-surface"].includes(String(value.error))) {
    return { ok: false, error: value.error as Extract<BrowserNativeSurfaceResult, { ok: false }>["error"] };
  }
  return null;
}
