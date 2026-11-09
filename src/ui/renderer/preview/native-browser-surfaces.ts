import type { BrowserTabsApi } from "../../../shared/browser-surface.js";
import type { BrowserNativeSurfaceRequest, BrowserNativeSurfaceResult, BrowserNativeSurfaceState } from "../../../shared/browser-native-surface.js";
import {
  getWebSurfaces, nativeWebSurfaceState, setNativeWebSurfaceState, subscribeWebSurfaceRetirement,
} from "./web-surfaces.js";

interface NativeClientRegistration { api: BrowserTabsApi }
export interface NativeBrowserSurfaceAcquisition {
  surface: BrowserNativeSurfaceState;
  initialNavigation: boolean;
}
const clients = new Map<string, NativeClientRegistration>();
const connections = new WeakMap<BrowserTabsApi, object>();

/** Subscribe before native creation; main snapshots share the existing tab metadata stores. */
export function connectNativeBrowserSurfaces(api: BrowserTabsApi): () => void {
  const connection = {};
  connections.set(api, connection);
  const offChanged = api.onNativeSurfaceChanged(({ tabId, surface }) => {
    if (connections.get(api) === connection && clients.get(tabId)?.api === api) setNativeWebSurfaceState(tabId, surface);
  });
  const offRetired = subscribeWebSurfaceRetirement((tabId) => {
    if (connections.get(api) !== connection || clients.get(tabId)?.api !== api) return;
    const surface = nativeWebSurfaceState(tabId);
    clients.delete(tabId);
    if (surface) void requestNativeBrowserSurface(api, { action: "close", tabId, webContentsId: surface.webContentsId });
  });
  return () => {
    offChanged(); offRetired();
    if (connections.get(api) !== connection) return;
    connections.delete(api);
    for (const [tabId, registration] of clients) if (registration.api === api) clients.delete(tabId);
  };
}

/** Component remount reacquires presentation while main retains the physical page. */
export async function createNativeBrowserSurface(api: BrowserTabsApi, tabId: string, requestId?: string): Promise<NativeBrowserSurfaceAcquisition | null> {
  const registration = { api };
  clients.set(tabId, registration);
  let result: BrowserNativeSurfaceResult;
  try {
    result = await api.nativeSurface({ action: "create", tabId, ...(requestId === undefined ? {} : { requestId }) });
  } catch (error) {
    if (clients.get(tabId) === registration) clients.delete(tabId);
    throw error;
  }
  if (!result.ok || !result.surface) {
    if (clients.get(tabId) === registration) clients.delete(tabId);
    return null;
  }
  const surface = result.surface;
  const current = clients.get(tabId);
  const live = getWebSurfaces().some((entry) => entry.tabId === tabId && entry.host === "native");
  if (current !== registration || !live) {
    // A retired pending creation still needs disposal, but a newer registration owns the retained page.
    if (!live && (!current || current === registration)) {
      if (current === registration) clients.delete(tabId);
      await api.nativeSurface({ action: "close", tabId, webContentsId: surface.webContentsId });
    }
    return null;
  }
  setNativeWebSurfaceState(tabId, surface);
  return { surface, initialNavigation: result.initialNavigation === true };
}

export async function requestNativeBrowserSurface(api: BrowserTabsApi, request: BrowserNativeSurfaceRequest): Promise<boolean> {
  const registration = clients.get(request.tabId);
  try {
    const result = await api.nativeSurface(request);
    if (!result.ok) return false;
    if (clients.get(request.tabId) === registration && (!registration || registration.api === api)) {
      setNativeWebSurfaceState(request.tabId, result.surface);
    }
    return true;
  } catch (error) {
    console.warn("Native browser operation failed.", error);
    return false;
  }
}

export async function commandNativeBrowserSurface(tabId: string, action: "back" | "forward" | "reload" | "focus" | "devtools"): Promise<boolean> {
  const surface = nativeWebSurfaceState(tabId);
  const registration = clients.get(tabId);
  if (!surface || !registration) return false;
  return requestNativeBrowserSurface(registration.api, { action, tabId, webContentsId: surface.webContentsId });
}
