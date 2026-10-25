import { useEffect, useState } from "react";
import { registerWebSurfaceOccluder, requestWebSurfaceLayout } from "./web-surfaces.js";

/** Cut registered floating surfaces out of overlapping web guests; signal position-only moves explicitly because
 * ResizeObserver misses them. */
export function useWebSurfaceOccluder(moved?: unknown): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => (element ? registerWebSurfaceOccluder(element) : undefined), [element]);
  useEffect(() => {
    if (element) requestWebSurfaceLayout();
  }, [element, moved]);
  return setElement;
}
