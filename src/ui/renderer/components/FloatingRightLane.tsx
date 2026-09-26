// FloatingRightLane anchors chat overlays within the pane's horizontal inset.
// Occupants share the lane's width constraint and stack without covering each
// other's controls. The action panel now lives in the chat group header.
import type { ReactNode, WheelEvent } from "react";

/**
 * Width shared by every occupant of the lane, so two surfaces sitting one above
 * the other line up instead of stepping in and out by a few pixels. The lane
 * supplies the pane's horizontal inset. Each occupant fills its available
 * width in a narrow pane and keeps its intended width in a wide one.
 */
export const FLOATING_LANE_ITEM_WIDTH = "w-[23rem] max-w-full";

function canScrollVertically(element: Element, deltaY: number): boolean {
  const remaining = element.scrollHeight - element.clientHeight;
  return deltaY > 0 ? element.scrollTop < remaining - 1 : element.scrollTop > 1;
}

function handleLaneWheel(event: WheelEvent<HTMLDivElement>) {
  if (event.deltaY === 0) return;
  const lane = event.currentTarget;
  let target = event.target instanceof Element ? event.target : null;
  while (target && target !== lane) {
    if (/^(auto|scroll)$/.test(getComputedStyle(target).overflowY)
      && canScrollVertically(target, event.deltaY)) return;
    target = target.parentElement;
  }
  if (canScrollVertically(lane, event.deltaY)) return;

  const transcript = lane.closest('[data-approval-scope]')
    ?.querySelector<HTMLElement>('.ave-chat-scroll [data-radix-scroll-area-viewport]');
  if (!transcript) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.clientHeight : 1;
  event.preventDefault();
  transcript.scrollTop += event.deltaY * unit;
}

export function FloatingRightLane({ children }: { children: ReactNode }) {
  return (
    <div
      // `pointer-events-none` on the lane and `-auto` on each occupant: the lane
      // spans dead space between and beside its children, and chat has to stay
      // clickable through it.
      className="@container pointer-events-none absolute inset-x-4 top-2 bottom-4 z-50 flex touch-pan-y flex-col items-end gap-2 overflow-y-auto overscroll-contain [&>*]:shrink-0"
      data-testid="floating-right-lane"
      onWheel={handleLaneWheel}
    >
      {children}
    </div>
  );
}
