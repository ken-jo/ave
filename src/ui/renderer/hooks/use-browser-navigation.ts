import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BrowserNativeSurfaceState } from "../../../shared/browser-native-surface.js";
import { getWebSurfaceElement, nativeWebSurfaceState, subscribeWebSurfaces } from "../preview/web-surfaces.js";
import { commandNativeBrowserSurface } from "../preview/native-browser-surfaces.js";

/** The subset of a `<webview>` a panel's chrome drives. */
export interface GuestElement extends HTMLElement {
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

export interface GuestNavigation {
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type BrowserSurface =
  | { kind: "webview"; element: GuestElement }
  | { kind: "native"; state: BrowserNativeSurfaceState };

const NO_NAVIGATION: GuestNavigation = { url: null, title: null, canGoBack: false, canGoForward: false };

/** The actual page host, with native state distinct from a retained user webview. */
export function useBrowserSurface(tabId: string): BrowserSurface | null {
  const native = useSyncExternalStore(subscribeWebSurfaces, () => nativeWebSurfaceState(tabId));
  const element = useSyncExternalStore(subscribeWebSurfaces, () => getWebSurfaceElement(tabId)) as GuestElement | null;
  return useMemo(() => native ? { kind: "native", state: native } : element ? { kind: "webview", element } : null, [native, element]);
}

export function navigateBrowserSurface(surface: BrowserSurface | null, action: "back" | "forward" | "reload"): void {
  if (!surface) return;
  if (surface.kind === "native") {
    void commandNativeBrowserSurface(surface.state.tabId, action);
    return;
  }
  if (action === "back") surface.element.goBack();
  else if (action === "forward") surface.element.goForward();
  else surface.element.reload();
}

/** Where the tab's page actually is — its live url and title, which a page changes on its own (links, redirects, SPA
 * routes) — read from the guest's navigation events. Before the guest has attached there is nothing to read. */
export function useGuestNavigation(surface: BrowserSurface | null): GuestNavigation {
  const [state, setState] = useState<GuestNavigation>(NO_NAVIGATION);
  const guest = surface?.kind === "webview" ? surface.element : null;
  useEffect(() => {
    if (!guest) {
      setState(NO_NAVIGATION);
      return undefined;
    }
    const read = () => {
      try {
        setState({
          url: guest.getURL() || null,
          title: guest.getTitle() || null,
          canGoBack: guest.canGoBack(),
          canGoForward: guest.canGoForward(),
        });
      } catch {
        // `getURL` throws until the guest has attached; its dom-ready reads again.
      }
    };
    const events = ["dom-ready", "did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading"];
    for (const name of events) guest.addEventListener(name, read);
    read();
    return () => {
      for (const name of events) guest.removeEventListener(name, read);
    };
  }, [guest]);
  return surface?.kind === "native" ? {
    url: surface.state.url || null, title: surface.state.title || null,
    canGoBack: surface.state.canGoBack, canGoForward: surface.state.canGoForward,
  } : state;
}
