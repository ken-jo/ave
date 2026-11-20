/** What a browser tab is called in a tab strip: the page's title, else the host of its address, else `fallback`. */
import { guestFaviconSource } from "./favicon-source.js";
import { webSurfaceFavicon, webSurfaceLocation, webSurfaceTitle } from "./web-surfaces.js";

export function browserTabLabel(tabId: string, fallback: string, address?: string | null): string {
  const title = webSurfaceTitle(tabId)?.trim();
  if (title && title !== "about:blank") return title;
  const url = webSurfaceLocation(tabId) ?? address;
  if (!url || url === "about:blank") return fallback;
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}

/** The page's icon for a tab strip, or null when the page has none the host may show. */
export function browserTabFavicon(tabId: string): string | null {
  return guestFaviconSource(webSurfaceFavicon(tabId));
}
