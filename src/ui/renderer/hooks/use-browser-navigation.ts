import { useEffect, useState, useSyncExternalStore } from "react";
import { getWebSurfaceElement, subscribeWebSurfaces } from "../preview/web-surfaces.js";

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

const NO_NAVIGATION: GuestNavigation = { url: null, title: null, canGoBack: false, canGoForward: false };

/** The live `<webview>` of a tab, once the layer has rendered it. */
export function useWebSurfaceGuest(tabId: string): GuestElement | null {
  return useSyncExternalStore(subscribeWebSurfaces, () => getWebSurfaceElement(tabId)) as GuestElement | null;
}

/**
 * Where the tab's page actually is — its live url and title, which a page
 * changes on its own (links, redirects, SPA routes) — read from the guest's
 * navigation events. Before the guest has attached there is nothing to read.
 */
export function useGuestNavigation(guest: GuestElement | null): GuestNavigation {
  const [state, setState] = useState<GuestNavigation>(NO_NAVIGATION);
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
  return state;
}
