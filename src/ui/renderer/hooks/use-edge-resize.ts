import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { beginSurfaceDrag, endSurfaceDrag } from "../preview/web-surfaces.js";

/** Coalesce pointer moves into direct DOM updates and commit on release. Edge controls delta sign; unitsPerPixel converts
 * stored shares while snapping remains in whole pixels. */
export interface UseEdgeResizeOptions {
  /** Current width (px) — the source of truth the drag starts from. */
  width: number;
  /** Which side of the panel the bar sits on. See class doc above. */
  edge: "start" | "end";
  /** Which pointer coordinate the extent follows. Default "x" (a width). */
  axis?: "x" | "y";
  /** What one pointer pixel is worth in the extent's unit. Default 1 (px). */
  unitsPerPixel?: number;
  /** Per-move update (state only, no persist). Called every rAF tick during drag and on keyboard steps. */
  onWidthChange: (px: number) => void;
  /** Drag-end / keyboard-step / reset commit (persist). */
  onWidthCommit: (px: number) => void;
  /** Inclusive width bounds. May be a function so the max can depend on live viewport size (e.g. side panel's `100vw - margin`). */
  min: number;
  max: number | (() => number);
  /** Keyboard arrow-key step size (px). Default 16. */
  keyStep?: number;
  /** Optional element the drag applies the live extent to directly (bypassing React) for a jank-free drag — `width` on the x axis, `height` on y. Written as px, so only meaningful at the default `unitsPerPixel`. Omit to update only via onWidthChange. */
  applyElementRef?: { current: HTMLElement | null };
}

export interface UseEdgeResizeResult {
  onPointerDown: (event: React.PointerEvent) => void;
  /** Wire directly to the resize bar's onKeyDown (Arrow keys + Home/End). */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Wire directly to the resize bar's onDoubleClick — resets to `resetWidth`. */
  makeResetHandler: (resetWidth: number) => (event: React.MouseEvent) => void;
  /** Current resolved max (evaluates the `max` option if it is a function). */
  resolveMax: () => number;
}

export function useEdgeResize({
  width,
  edge,
  axis = "x",
  unitsPerPixel = 1,
  onWidthChange,
  onWidthCommit,
  min,
  max,
  keyStep = 16,
  applyElementRef,
}: UseEdgeResizeOptions): UseEdgeResizeResult {
  const cleanupRef = useRef<(() => void) | null>(null);
  // Latest drag-live width, read by the drag-end closure (non-reactive) so the committed value is exact even if React state
  // lags a frame.
  const liveRef = useRef(width);
  useEffect(() => {
    liveRef.current = width;
  }, [width]);
  // Release any in-flight pointer capture on unmount so a drag crossing an unmount boundary (panel closes / tab switch
  // mid-drag) leaks no listeners.
  useEffect(() => () => cleanupRef.current?.(), []);

  const resolveMax = useCallback(() => (typeof max === "function" ? max() : max), [max]);
  const clamp = useCallback(
    (value: number) => {
      // Snap in pixel space: a whole px is the finest thing a pointer can say, and rounding a percent to a whole percent would
      // step the drag.
      const snapped = Math.round(value / unitsPerPixel) * unitsPerPixel;
      return Math.min(resolveMax(), Math.max(min, snapped));
    },
    [min, resolveMax, unitsPerPixel],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      cleanupRef.current?.();
      // A web page under the pointer would take the drag's moves and its release; the surface layer stands aside until the drag
      // ends.
      beginSurfaceDrag();
      const along = (point: { clientX: number; clientY: number }) =>
        axis === "x" ? point.clientX : point.clientY;
      const start = along(event);
      const startWidth = width;
      const sign = edge === "end" ? 1 : -1;
      let raf = 0;
      const apply = (position: number) => {
        const next = clamp(startWidth + sign * (position - start) * unitsPerPixel);
        liveRef.current = next;
        onWidthChange(next);
        const el = applyElementRef?.current;
        if (!el) return;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          el.style[axis === "x" ? "width" : "height"] = `${liveRef.current}px`;
        });
      };
      const onMove = (moveEvent: PointerEvent) => apply(along(moveEvent));
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        if (raf) cancelAnimationFrame(raf);
        cleanupRef.current = null;
        endSurfaceDrag();
        onWidthCommit(liveRef.current);
      };
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [applyElementRef, axis, clamp, edge, onWidthChange, onWidthCommit, unitsPerPixel, width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Arrow-key direction always matches the visual edge regardless of
      // sign convention: the arrows shrink/grow as if dragging the bar
      // itself, so ArrowRight always widens a right-side ("end") bar and
      // narrows a left-side ("start") bar, and vice versa. On the y axis the
      // same holds for ArrowDown/ArrowUp.
      const [forward, back] = axis === "x"
        ? ["ArrowRight", "ArrowLeft"]
        : ["ArrowDown", "ArrowUp"];
      const growKey = edge === "end" ? forward : back;
      const shrinkKey = edge === "end" ? back : forward;
      if (event.key === growKey) {
        event.preventDefault();
        onWidthCommit(clamp(width + keyStep));
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        onWidthCommit(clamp(width - keyStep));
      } else if (event.key === "Home") {
        event.preventDefault();
        onWidthCommit(min);
      } else if (event.key === "End") {
        event.preventDefault();
        onWidthCommit(resolveMax());
      }
    },
    [axis, clamp, edge, keyStep, min, onWidthCommit, resolveMax, width],
  );

  const makeResetHandler = useCallback(
    (resetWidth: number) => (event: React.MouseEvent) => {
      event.preventDefault();
      onWidthCommit(clamp(resetWidth));
    },
    [clamp, onWidthCommit],
  );

  return { onPointerDown, onKeyDown, makeResetHandler, resolveMax };
}

/** Measure in an effect because window resize alone does not refresh render-time refs; zero means dragging is unavailable
 * and must never be a divisor. */
export function useMeasuredSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((prev) => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      return prev.width === next.width && prev.height === next.height ? prev : next;
    });
    measure();
    const Observer = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (typeof Observer !== "function") return;
    const observer = new Observer(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
