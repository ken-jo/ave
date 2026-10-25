import { useEffect, useState, type CSSProperties } from "react";
import { registerWebSurfaceOccluder } from "../preview/web-surfaces.js";
import { useEdgeResize, type UseEdgeResizeOptions } from "../hooks/use-edge-resize.js";

export interface EdgeResizeBarProps extends UseEdgeResizeOptions {
  ariaLabel: string;
  /** Width reset target for double-click / Enter. */
  resetWidth: number;
  "data-testid"?: string;
  /**
   * `"straddle"` (default) centers the 8px hit strip ON the panel boundary
   * (half outside) — use when the panel's container does NOT clip overflow.
   * `"inset"` keeps the whole hit strip inside the panel edge — use when the
   * container is `overflow-hidden` (a straddled strip would be half-clipped).
   */
  variant?: "straddle" | "inset";
  /** Passthrough style — e.g. Electron's WebkitAppRegion: "no-drag" when the bar overlays a window drag band. */
  style?: CSSProperties;
}

/** Share resize interaction through useEdgeResize; separator orientation describes the bar, and arrow keys follow the
 * visible edge. */
export function EdgeResizeBar({
  width,
  edge,
  axis = "x",
  onWidthChange,
  onWidthCommit,
  min,
  max,
  keyStep,
  applyElementRef,
  ariaLabel,
  resetWidth,
  "data-testid": testId,
  variant = "straddle",
  style,
}: EdgeResizeBarProps) {
  const { onPointerDown, onKeyDown, makeResetHandler, resolveMax } = useEdgeResize({
    width,
    edge,
    axis,
    onWidthChange,
    onWidthCommit,
    min,
    max,
    keyStep,
    applyElementRef,
  });

  // A bar can sit on a web page's edge (the side panel's inset handle lies inside the card, over the page's first pixels).
  // Pages are drawn above the app, so the bar is cut out of any page it overlaps — the pointer reaches it.
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  useEffect(() => (bar ? registerWebSurfaceOccluder(bar) : undefined), [bar]);

  const straddle = variant === "straddle";
  const placement = axis === "x"
    ? [
      "inset-y-0 w-2 cursor-col-resize items-center",
      edge === "end"
        ? `right-0 justify-end ${straddle ? "translate-x-1/2" : ""}`
        : `left-0 justify-start ${straddle ? "-translate-x-1/2" : ""}`,
    ]
    : [
      "inset-x-0 h-2 cursor-row-resize justify-center",
      edge === "end"
        ? `bottom-0 items-end ${straddle ? "translate-y-1/2" : ""}`
        : `top-0 items-start ${straddle ? "-translate-y-1/2" : ""}`,
    ];
  return (
    <div
      ref={setBar}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Math.round(resolveMax())}
      tabIndex={0}
      data-testid={testId}
      className={[
        "group absolute z-40 flex touch-none select-none outline-none",
        ...placement,
      ].join(" ")}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={makeResetHandler(resetWidth)}
    >
      <span
        className={[
          "rounded-full bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-primary",
          axis === "x" ? "h-full w-0.5" : "h-0.5 w-full",
        ].join(" ")}
      />
    </div>
  );
}
