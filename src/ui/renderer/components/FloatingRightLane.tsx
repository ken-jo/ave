// FloatingRightLane anchors chat overlays within the pane's horizontal inset.
// Occupants share the lane's width constraint and stack without covering each
// other's controls. The action panel now lives in the chat group header.
import type { ReactNode } from "react";

/**
 * Width shared by every occupant of the lane, so two surfaces sitting one above
 * the other line up instead of stepping in and out by a few pixels. The lane
 * supplies the pane's horizontal inset. Each occupant fills its available
 * width in a narrow pane and keeps its intended width in a wide one.
 */
export const FLOATING_LANE_ITEM_WIDTH = "w-[23rem] max-w-full";

export function FloatingRightLane({ children }: { children: ReactNode }) {
  return (
    <div
      // `pointer-events-none` on the lane and `-auto` on each occupant: the lane
      // spans dead space between and beside its children, and chat has to stay
      // clickable through it.
      className="pointer-events-none absolute inset-x-4 top-2 z-50 flex flex-col items-end gap-2"
      data-testid="floating-right-lane"
    >
      {children}
    </div>
  );
}
