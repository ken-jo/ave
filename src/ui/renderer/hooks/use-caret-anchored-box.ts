/** Anchor portal menus to the textarea box with fixed coordinates to escape composer overflow clipping. */
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

export interface CaretAnchoredBox {
  left: number;
  width: number;
  /** Distance from the viewport BOTTOM, so the menu grows upward. */
  bottom: number;
}

export function useCaretAnchoredBox({
  open,
  anchorRef,
  listRef,
  activeIndex,
  itemCount,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  activeIndex: number;
  itemCount: number;
}): CaretAnchoredBox | null {
  const [anchor, setAnchor] = useState<CaretAnchoredBox | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const textarea = anchorRef.current;
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      width: rect.width,
      bottom: window.innerHeight - rect.top + 4,
    });
    // `itemCount` and `activeIndex` are dependencies because the textarea grows as the user types: re-measuring only on open
    // would leave the menu overlapping it.
  }, [open, anchorRef, itemCount, activeIndex]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listRef]);

  return anchor;
}
