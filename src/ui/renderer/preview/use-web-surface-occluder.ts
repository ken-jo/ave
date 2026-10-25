import { useEffect, useState } from "react";
import { registerWebSurfaceOccluder, requestWebSurfaceLayout } from "./web-surfaces.js";

/**
 * Mark an element as something web pages must not cover. Pages are drawn by
 * the window-level surface layer, above the panes; an element registered here
 * is cut out of every page it overlaps, so it stays visible and clickable.
 * Use it for the window's own floating surfaces (a picture-in-picture card, a
 * fullscreen app, a drop indicator) that sit where a page may be.
 *
 * `moved` names anything that moves the element without resizing it (a
 * dragged position): the layer re-places pages when it changes, since a
 * resize observer does not see a move.
 */
export function useWebSurfaceOccluder(moved?: unknown): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => (element ? registerWebSurfaceOccluder(element) : undefined), [element]);
  useEffect(() => {
    if (element) requestWebSurfaceLayout();
  }, [element, moved]);
  return setElement;
}
