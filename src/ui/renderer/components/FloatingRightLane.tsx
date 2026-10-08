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

function hasVerticalScrollRange(element: Element): boolean {
  return element.scrollHeight > element.clientHeight;
}

// Some renderers round scrollTop to pixels; carry the unused wheel fraction.
const forwardedScroll = new WeakMap<HTMLElement, { actual: number; remainder: number }>();

function forwardWheel(transcript: HTMLElement, delta: number) {
  const actual = transcript.scrollTop;
  const previous = forwardedScroll.get(transcript);
  const pending = previous?.actual === actual ? previous.remainder : 0;
  const total = pending + delta;
  const whole = Math.sign(total) * Math.round(Math.abs(total));
  if (whole === 0) {
    forwardedScroll.set(transcript, { actual, remainder: total });
    return;
  }

  const limit = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
  transcript.scrollTop = Math.max(0, Math.min(limit, actual + whole));
  const moved = transcript.scrollTop - actual;
  const atBoundary = (transcript.scrollTop === 0 && total < 0)
    || (transcript.scrollTop === limit && total > 0);
  forwardedScroll.set(transcript, { actual: transcript.scrollTop, remainder: atBoundary ? 0 : total - moved });
}

function handleLaneWheel(event: WheelEvent<HTMLDivElement>) {
  if (event.deltaY === 0 || !Number.isFinite(event.deltaY)
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const lane = event.currentTarget;
  // A scrollable surface owns the gesture even after it reaches either end.
  let target = event.target instanceof Element ? event.target : null;
  while (target && target !== lane) {
    if (/^(auto|scroll)$/.test(getComputedStyle(target).overflowY)
      && hasVerticalScrollRange(target)) return;
    target = target.parentElement;
  }
  if (hasVerticalScrollRange(lane)) return;

  const transcript = lane.closest('[data-approval-scope]')
    ?.querySelector<HTMLElement>('.ave-chat-scroll [data-radix-scroll-area-viewport]');
  if (!transcript) return;
  const lineHeight = Number.parseFloat(getComputedStyle(transcript).lineHeight);
  const unit = event.deltaMode === 1 ? (Number.isFinite(lineHeight) ? lineHeight : 16)
    : event.deltaMode === 2 ? transcript.clientHeight : 1;
  forwardWheel(transcript, event.deltaY * unit);
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
