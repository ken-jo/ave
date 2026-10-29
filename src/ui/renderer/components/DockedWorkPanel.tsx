/**
 * The work panel's docked column: how a pane's side panel opens beside its content, pushing it aside when the tile has
 * room (docked) or floating over it when it does not (overlay), with one slide-and-fade transition either way. Every pane
 * that has a work panel — a conversation or a terminal — draws it through this, so the panel is one surface everywhere.
 */
import { forwardRef, useEffect, useState, type ReactNode, type RefObject } from "react";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion.js";
import { useTranslation } from "../../../i18n/react.js";
import { SIDE_PANEL_DEFAULT_WIDTH } from "../../../shared/side-panel.js";
import { EdgeResizeBar } from "./EdgeResizeBar.js";

/** How long the open and close transition runs; a close without a transition end settles after it. */
const SIDE_PANEL_LAYOUT_TRANSITION_MS = 300;

export interface DockedPanelMotion {
  /** Mounted: from the first open until the close transition has finished. */
  present: boolean;
  /** At full width and interactive. Starts collapsed so the opening transition can run. */
  expanded: boolean;
  /** The close transition ended; the panel leaves the layout. */
  settleClosed: () => void;
}

export function useDockedPanelMotion(shouldOpen: boolean): DockedPanelMotion {
  const [present, setPresent] = useState(shouldOpen);
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (shouldOpen) {
      setPresent(true);
      if (reduceMotion) {
        setExpanded(true);
        return;
      }
      setExpanded(false);
      // Two animation frames ensure the collapsed state paints; one may coalesce with mount.
      let expansionFrame = 0;
      const mountFrame = window.requestAnimationFrame(() => {
        expansionFrame = window.requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        window.cancelAnimationFrame(mountFrame);
        if (expansionFrame) window.cancelAnimationFrame(expansionFrame);
      };
    }
    setExpanded(false);
    if (reduceMotion) {
      setPresent(false);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), SIDE_PANEL_LAYOUT_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [shouldOpen, reduceMotion]);
  return { present, expanded, settleClosed: () => setPresent(false) };
}

/** The column the panel card sits in. `keepMounted` keeps a closed panel's content alive, out of the layout. */
export const DockedPanelColumn = forwardRef<HTMLDivElement, {
  motion: DockedPanelMotion;
  shouldOpen: boolean;
  width: number;
  mode: "docked" | "overlay";
  resizing: boolean;
  id?: string;
  testId: string;
  children: ReactNode;
}>(function DockedPanelColumn({ motion, shouldOpen, width, mode, resizing, id, testId, children }, ref) {
  return (
    <div
      ref={ref}
      {...(id ? { id } : {})}
      data-testid={testId}
      data-panel-mode={mode}
      aria-hidden={!motion.expanded}
      inert={!motion.expanded}
      style={{
        order: 2,
        width: motion.expanded ? `${width}px` : "0px",
        maxWidth: shouldOpen ? width : 0,
        // Closed and settled, but kept for what it holds: out of the layout entirely, not a collapsed sliver of padding.
        ...(motion.present ? {} : { display: "none" }),
      }}
      className={[
        // Use the sidebar's pixel inset tokens for both floating-card edges and transcript reserve; font scaling must not change
        // the host's pixel reserve.
        "z-40 flex min-w-0 shrink-0 origin-right justify-end pt-(--shell-card-inset) pr-(--shell-card-inset) pb-(--shell-card-inset-bottom) pl-(--shell-card-inset) will-change-[width,opacity,transform]",
        mode === "overlay" ? "absolute inset-y-0 right-0" : "relative self-stretch",
        resizing
          ? "transition-none"
          : "transition-[width,opacity,transform] duration-[var(--motion-layout)] ease-[var(--motion-ease-out)] motion-reduce:transition-none",
        motion.expanded
          ? "pointer-events-auto translate-x-0 overflow-visible opacity-100"
          : "pointer-events-none translate-x-2 overflow-hidden opacity-0",
      ].join(" ")}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "width" && !shouldOpen) motion.settleClosed();
      }}
      onTransitionCancel={() => {
        if (!shouldOpen) motion.settleClosed();
      }}
    >
      {children}
    </div>
  );
});

/**
 * The panel itself: a raised card — the floating sidebar's own recipe — filling the box its column reserves for it (the
 * column carries the card's insets), so a docked panel and a floating one are one surface at two positions. Its leading
 * edge resizes the column.
 */
export function WorkPanelCard({
  testId, className, width, minWidth, maxWidth, onWidthChange, onWidthCommit, resizeElementRef, splitterTestId, children,
}: {
  testId: string;
  className?: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (px: number) => void;
  onWidthCommit: (px: number) => void;
  resizeElementRef?: RefObject<HTMLElement | null>;
  splitterTestId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <aside
      data-testid={testId}
      className={[
        "ave-surface-raised h-full w-full min-h-0 min-w-0 overflow-hidden rounded-2xl bg-card backdrop-blur",
        className,
      ].join(" ")}
    >
      <EdgeResizeBar
        width={width}
        edge="start"
        // The card clips its overflow, so its handle sits inside the edge.
        variant="inset"
        onWidthChange={onWidthChange}
        onWidthCommit={onWidthCommit}
        min={minWidth}
        max={Math.max(minWidth, maxWidth)}
        resetWidth={SIDE_PANEL_DEFAULT_WIDTH}
        {...(resizeElementRef ? { applyElementRef: resizeElementRef } : {})}
        ariaLabel={t("chatPreviewRail.resizePanel")}
        data-testid={splitterTestId}
      />
      {children}
    </aside>
  );
}
