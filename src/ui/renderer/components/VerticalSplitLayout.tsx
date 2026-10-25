import { useRef, type ReactNode } from "react";
import {
  SIDE_PANEL_SPLIT_MAX_PERCENT,
  SIDE_PANEL_SPLIT_MIN_PERCENT,
} from "../../../shared/side-panel.js";
import { useEdgeResize, useMeasuredSize } from "../hooks/use-edge-resize.js";

/** Keyboard nudge step (percent) for the split separator. */
const SPLIT_KEY_STEP = 5;

/** Caller-owned percentages survive unmount; drag updates avoid persistence until commit, and pixel conversion waits for a
 * measured layout. */
export function VerticalSplitLayout({
  topPercent,
  onDragChange,
  onCommit,
  top,
  bottom,
  ariaLabel,
  testId,
  separatorTestId,
}: {
  topPercent: number;
  /** Per-move update (state only, no persist). */
  onDragChange: (percent: number) => void;
  /** Drag-end / keyboard commit (persist). */
  onCommit: (percent: number) => void;
  top: ReactNode;
  bottom: ReactNode;
  ariaLabel: string;
  testId?: string;
  separatorTestId?: string;
}) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const { height } = useMeasuredSize(layoutRef);
  const measured = height > 0;

  const { onPointerDown, onKeyDown } = useEdgeResize({
    width: topPercent,
    edge: "end",
    axis: "y",
    ...(measured ? { unitsPerPixel: 100 / height } : {}),
    min: SIDE_PANEL_SPLIT_MIN_PERCENT,
    max: SIDE_PANEL_SPLIT_MAX_PERCENT,
    keyStep: SPLIT_KEY_STEP,
    onWidthChange: onDragChange,
    // A keyboard step is both the move and the commit; the hook reports it once, as a commit, so the move is replayed here for
    // the caller.
    onWidthCommit: (percent) => {
      onDragChange(percent);
      onCommit(percent);
    },
  });

  return (
    // Keep the pointer hit area at least 20px at smaller font scales. The rem track can grow with larger text while the
    // centered visual line stays thin.
    <div
      ref={layoutRef}
      className="grid min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      data-testid={testId}
      style={{ gridTemplateRows: `${topPercent}% minmax(20px, 1.25rem) minmax(0, 1fr)` }}
    >
      <div className="min-h-0 overflow-auto">{top}</div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        aria-valuenow={Math.round(topPercent)}
        aria-valuemin={SIDE_PANEL_SPLIT_MIN_PERCENT}
        aria-valuemax={SIDE_PANEL_SPLIT_MAX_PERCENT}
        tabIndex={0}
        data-testid={separatorTestId}
        className="group flex cursor-row-resize touch-none select-none items-center px-2 outline-none"
        onPointerDown={measured ? onPointerDown : undefined}
        onKeyDown={onKeyDown}
      >
        <span className="h-0.5 w-full rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className="min-h-0 overflow-auto">{bottom}</div>
    </div>
  );
}
