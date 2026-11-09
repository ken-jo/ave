import { vi } from "vitest";
import type { BrowserTabsApi, SessionTabBindingsState } from "../../shared/browser-surface.js";
import type { BrowserNativeSurfaceChanged, BrowserNativeSurfaceRequest, BrowserNativeSurfaceResult, BrowserNativeSurfaceState } from "../../shared/browser-native-surface.js";

export function nativeSurfaceFixture() {
  const states = new Map<string, BrowserNativeSurfaceState>();
  const initialNavigations = new Map<string, boolean>();
  const listeners = new Set<(event: BrowserNativeSurfaceChanged) => void>();
  const stateFor = (tabId: string) => {
    const state = states.get(tabId);
    if (!state) throw new Error("Native page fixture is missing");
    return state;
  };
  const publish = (tabId: string, patch: Partial<BrowserNativeSurfaceState>) => {
    if (patch.url !== undefined) initialNavigations.set(tabId, false);
    const previous = stateFor(tabId);
    const state = { ...previous, ...patch, revision: previous.revision + 1 };
    states.set(tabId, state);
    for (const listener of listeners) listener({ tabId, surface: state });
    return state;
  };
  const nativeSurface = vi.fn(async (request: BrowserNativeSurfaceRequest): Promise<BrowserNativeSurfaceResult> => {
    if (request.action === "create") {
      const existing = states.get(request.tabId);
      const state: BrowserNativeSurfaceState = existing ? { ...existing, epoch: existing.epoch + 1 } : {
        tabId: request.tabId, webContentsId: 42 + states.size, epoch: 1, revision: 1, url: "about:blank", title: "", favicon: null,
        loading: false, canGoBack: false, canGoForward: false, visible: false,
      };
      states.set(request.tabId, state);
      if (!existing) initialNavigations.set(request.tabId, true);
      return { ok: true, surface: state, initialNavigation: initialNavigations.get(request.tabId) === true };
    }
    if (request.action === "close") {
      states.delete(request.tabId);
      initialNavigations.delete(request.tabId);
      return { ok: true, surface: null };
    }
    if (!states.has(request.tabId)) return { ok: false, error: "stale-surface" };
    const surface = request.action === "present" ? publish(request.tabId, { visible: request.bounds !== null })
      : request.action === "navigate" ? publish(request.tabId, { url: request.url }) : stateFor(request.tabId);
    return { ok: true, surface };
  });
  const api = {
    nativeSurface,
    getSessionBindings: vi.fn(async (): Promise<SessionTabBindingsState> => ({ revision: 0, bindings: [], nativeBrowserTabIds: [] })),
    onSessionBindingsChanged: vi.fn(() => () => {}),
    onNativeSurfaceChanged: vi.fn((listener: (event: BrowserNativeSurfaceChanged) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  } as unknown as BrowserTabsApi;
  return { api, nativeSurface, states, publish };
}
