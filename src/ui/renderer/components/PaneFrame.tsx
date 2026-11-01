import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import {
  Columns2, Download, Maximize2, Minimize2,
  Pin, Rows2, Upload, X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS, MAX_PANES } from "../../../contract/app-contract.js";
import { sameViewLocation, type ViewLocation } from "../utils/view-location.js";
import { PANE_MIN_WIDTH, SINGLE_TILE_ENTER_WIDTH, SINGLE_TILE_EXIT_WIDTH } from "../../../shared/shell-geometry.js";
import { useContainerNarrow } from "../hooks/use-container-narrow.js";
import { CHROME_GAP_TIGHT } from "../../../shared/shell-geometry.js";
import type { AveApi } from "../types.js";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import { useMeasuredSize } from "../hooks/use-edge-resize.js";
import {
  CHAT_SESSION_DRAG_TYPE,
  dropIndicatorStyle,
  dropTargetAt,
  type DropTarget,
} from "./pane-drop.js";
import { FloatingRightLane } from "./FloatingRightLane.js";
import { registerWebSurfaceOccluder } from "../preview/web-surfaces.js";
import { useWebSurfaceOccluder } from "../preview/use-web-surface-occluder.js";
import { SURFACE_DRAG_TYPE, decodeSurfaceDrag, encodeSurfaceDrag, type SurfaceDragPayload } from "../preview/surface-moves.js";
import { PendingAnswerDot } from "./PendingAnswerDot.js";
import { AXIS_OF,
  closeLeaf,
  countLeaves,
  layoutBoxes,
  layoutGutters,
  leaf,
  leafIds,
  resizeGutter,
  splitLeaf,
  type PaneBox,
  type PaneGutter,
  type PaneNode,
  type DropEdge,
  type SplitAxis,
} from "./pane-tree.js";

/** Use the shared 448px surface width floor; the 280px height floor retains a header, composer and one visible turn. */
export { PANE_MIN_WIDTH } from "../../../shared/shell-geometry.js";
export const PANE_MIN_HEIGHT = 280;

/** The 1px hairline the frame draws itself with, on each of its four sides. */
const PANE_FRAME_BORDER = 1;

/**
 * What a cell's frame loses to the air around it: the half-gutter it carries on
 * each side — two adjacent halves making the gap between tiles, which is why
 * the cell pads by `--chrome-gap-tight` rather than a full gap — plus its own
 * border. The tile floors above are on the frame's CONTENT, not on the cell, so
 * a split has to subtract this before comparing.
 */
export const PANE_CELL_INSET = 2 * CHROME_GAP_TIGHT + 2 * PANE_FRAME_BORDER;

/** Which way a tile is halved: `row` puts the new tile beside it, `column` under it. */
export type PaneSplitAxis = SplitAxis;
/** The drop edge a header split on an axis stands for: the new tile trails. */
const SPLIT_EDGE: Record<PaneSplitAxis, DropEdge> = { row: "right", column: "bottom" };

/** Pane borders identify focus among repeated work containers; conversation actions belong to their owning pane. See
 * DESIGN.md's workbench model. */
interface PaneAction {
  /** Stable id — also the `data-testid` suffix and the menu command key. */
  id: string;
  label: string;
  icon: ReactNode;
  /** Rendered pressed, for toggles that have an on state (pin). */
  active?: boolean;
  /** Shown but inert. A limit the CONTENT owns — the work board's item cap — reads in the control itself rather than arriving
   * as a rejection once the user has already clicked, the same rule the split control follows. */
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
  /** When present the control opens a menu of these instead of firing. */
  items?: Array<{ id: string; label: string; onSelect: () => void | Promise<void> }>;
}

/** Tree operations act on tiles regardless of content; views supply only leading header content, actions and body insets. */
interface PaneFrameProps {
  /** Leading edge of the header. */
  title: string;
  titleAccessory?: ReactNode;
  /** Keep plugin descriptions on the frame title tooltip rather than duplicating page chrome. */
  description?: string;
  /** Drawn ahead of the title: the same glyph the sidebar row uses for this content, so the pane and the row that opened it
   * read as one thing. */
  icon?: ReactNode;
  /** The content's own actions, after the contributed slot and before split. What the CALLER owns; a body can add its own
   * with `usePaneActions`, and those are drawn in the same row, after these. */
  actions?: PaneAction[];
  /** Extra controls at the head of the trailing cluster, before maximize and close — what THIS kind of pane owns as a tile
   * (the conversation's work panel toggle). */
  trailing?: ReactNode;
  /** Whether this pane currently has focus — drives the border, see above. */
  focused?: boolean;
  /** What the pane's content asked the user to look at and they have not yet seen (a terminal's notification). Drawn as a
   * ring around the tile, and as the header's tooltip, until the pane is seen. */
  attention?: string | null;
  /** A short fact about the content after the title — a terminal's directory. */
  meta?: { text: string; title: string } | null;
  /** Raised when anything inside the pane is interacted with, so the frame can take focus. */
  onFocus?: () => void;
  /**
   * Whether another tile still fits.
   *
   * At the ceiling every drop resolves to the centre, so the tile highlights
   * whole rather than by halves: the limit shows up in the gesture itself
   * instead of arriving as a rejection once the user has let go.
   */
  canSplit?: boolean;
  /** Split off another tile beside (`row`) or under (`column`) this one. */
  onSplit?: (axis: PaneSplitAxis) => void;
  /** Whether a split on that axis leaves both halves above the tile floors. */
  splitFits?: (axis: PaneSplitAxis) => boolean;
  /** Take a conversation dropped on this tile — any pane can receive one. */
  onSessionDrop?: (sessionId: string, target: DropTarget) => void;
  /** Take a terminal or web page dropped on this tile — a side-panel tab, or another pane's surface dragged by its header.
   * Centre shows it here; an edge opens it in a new pane on that side. */
  onSurfaceDrop?: (payload: SurfaceDragPayload, target: DropTarget) => void;
  /** The surface this pane shows, when it shows one: the header becomes its drag handle, so the pane can be dropped on
   * another pane or on a side panel's tabs. */
  dragSurface?: SurfaceDragPayload;
  /** Close this tile. Absent on the last one. */
  onClose?: () => void;
  /**
   * What closing this pane is called, when it is not "close the pane".
   *
   * A conversation pane's close control removes the pane. A ROUTED pane's puts
   * that pane back on its conversation, so the pane survives — labelling it
   * "Close pane" there would name something the click does not do. The routed
   * caller passes the view's own name instead; everything else takes the
   * default.
   */
  closeLabel?: string;
  /** Show only this tile, or give the others their space back. */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  /** A pane the tree hides behind this one holds a card the user must answer. Drawn as the attention dot on the restore
   * control: restoring is how the user gets to that card, and the dot says there is one to get to. */
  restoreAttention?: boolean;
  /**
   * How far the body stands in from the frame.
   *
   * `none`: the content draws to the hairline — a conversation lays out its own
   * transcript and composer. `page`: the inset a built-in view's `PageShell`
   * gives its content today (`padded`, `p-4`), so a view moved into a pane keeps
   * the margin it had. No pane takes `page` yet; the built-in views arrive in
   * their own change, and the recipe is settled here so they inherit rather
   * than each restate it.
   */
  bodyInset?: "none" | "page";
  /** Whether to publish the aside slot (`usePanePanelSlot`) beside the body, as tall as the tile. The conversation's work
   * panel portals into it. */
  asideSlot?: boolean;
  /** The frame owns the overlay lane so cards remain visible when a routed view hides the conversation. */
  lane?: ReactNode;
  /**
   * What must be settled before this pane's conversation takes its next
   * input, drawn while the pane shows something else: the conversation's
   * approval and question cards. Rendered at the bottom of the body, full
   * width, exactly where the same cards sit over the composer when the
   * conversation is what the pane draws — the card belongs to the pane, and
   * routing the pane to a view does not move it.
   */
  settle?: ReactNode;
  children: ReactNode;
}

/**
 * The recipe every control in the header band is drawn with.
 *
 * Exported because a pane's `trailing` control is built by whoever owns that
 * kind of pane, and it has to sit in the same row as the frame's own controls
 * without being a size or a colour apart from them.
 */
export const HEADER_BUTTON_CLASS =
  "h-(--chrome-icon-button) w-(--chrome-icon-button) aspect-square shrink-0 p-0 text-muted-foreground hover:text-foreground";

/**
 * The work panel is the frame's guest. It stands as tall as the tile —
 * beside the header, not under it — so the view portals it into a slot that
 * is the tile's own child. `tile` is the frame itself, the box the panel's
 * docked/overlay verdict is measured against: measuring the view would
 * measure something the panel's own width changes.
 */
export interface PanePanelSlot {
  panel: HTMLElement | null;
  tile: HTMLElement | null;
}

/**
 * `null` means no frame at all — the view is on its own and keeps the panel.
 * Inside a frame the slot is published from the first render, with `panel`
 * still null until the slot element commits; the view must tell the two
 * apart, because rendering the panel inline and then moving it into the
 * portal one render later would remount everything under it.
 */
const PanePanelSlotContext = createContext<PanePanelSlot | null>(null);

export function usePanePanelSlot(): PanePanelSlot | null {
  return useContext(PanePanelSlotContext);
}

/** Bodies register stateful actions into the frame header; their data stays local to the view. */
const PaneBodyActionsContext = createContext<((actions: PaneAction[]) => void) | null>(null);

/** Publish this pane body's own global actions into the frame's header. `actions` must be referentially stable while it has
 * not changed (`useMemo`) — a fresh array every render would republish on every render. */
export function usePaneActions(actions: PaneAction[]): void {
  const publish = useContext(PaneBodyActionsContext);
  useEffect(() => {
    if (!publish) return undefined;
    publish(actions);
    // A body that leaves takes its actions with it: the header must not keep drawing a control for content that is no longer
    // there.
    return () => publish([]);
  }, [publish, actions]);
}

/**
 * Content that must stay visible over a web page in this pane. A page is drawn
 * above the pane by the surface layer, so the settle cards (the conversation's
 * pending approvals and questions) are cut out of it rather than covered.
 * `display: contents` keeps the wrapper out of layout: the cards still position
 * themselves against the body.
 */
function WebSurfaceOccluder({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => (element ? registerWebSurfaceOccluder(element) : undefined), [element]);
  return <div ref={setElement} className="contents" data-web-surface-occluder="settle">{children}</div>;
}

/** The frame every pane is drawn in. The chrome lives here and only here. */
export function PaneFrame({
  title,
  description,
  icon,
  titleAccessory,
  actions = [],
  trailing,
  focused,
  attention = null,
  meta = null,
  onFocus,
  canSplit,
  onSplit,
  splitFits,
  onSessionDrop,
  onSurfaceDrop,
  dragSurface,
  onClose,
  closeLabel,
  maximized = false,
  onToggleMaximize,
  restoreAttention = false,
  bodyInset = "none",
  asideSlot: publishAsideSlot = false,
  lane,
  settle,
  children,
}: PaneFrameProps) {
  const { t } = useTranslation();
  const closeText = closeLabel ?? t("pane.close");
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const [tile, setTile] = useState<HTMLElement | null>(null);
  const [bodyActions, setBodyActions] = useState<PaneAction[]>([]);
  const panelSlots = useMemo<PanePanelSlot>(() => ({ panel: panelSlot, tile }), [panelSlot, tile]);
  // The caller's actions lead: what OWNS the pane comes before what the content it happens to be showing contributes.
  const headerActions = bodyActions.length === 0 ? actions : [...actions, ...bodyActions];
  // The split choice is settled when the popover OPENS, not on every render:
  // the verdict reads the canvas's live size, which is a layout read that
  // belongs in an event, and a verdict taken while the popover is open is
  // what the user is looking at.
  const [splitChoice, setSplitChoice] = useState<Record<PaneSplitAxis, boolean> | null>(null);
  // Choosing a direction hands focus to the NEW tile; the popover must not
  // return it to the trigger on close, or this tile would take focus back.
  const splitChosenRef = useRef(false);
  const openSplitChoice = (open: boolean) => {
    setSplitChoice(open
      ? { row: splitFits ? splitFits("row") : true, column: splitFits ? splitFits("column") : true }
      : null);
  };

  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // A web page in this pane is drawn above it; the indicator is cut out of the page so the user sees where the drop lands.
  const dropIndicatorRef = useWebSurfaceOccluder(dropTarget);
  const carriesSession = (event: React.DragEvent) =>
    onSessionDrop !== undefined && event.dataTransfer.types.includes(CHAT_SESSION_DRAG_TYPE);
  const carriesSurface = (event: React.DragEvent) =>
    onSurfaceDrop !== undefined && event.dataTransfer.types.includes(SURFACE_DRAG_TYPE);
  const acceptsDrops = onSessionDrop !== undefined || onSurfaceDrop !== undefined;

  const readTarget = (event: React.DragEvent<HTMLElement>): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect();
    const landed = dropTargetAt(rect, { x: event.clientX, y: event.clientY });
    if (!canSplit || landed === "center") return "center";
    // An edge whose halves would fall under the tile floors demotes to the centre — the drop affordance and the split control
    // state one rule.
    return splitFits && !splitFits(AXIS_OF[landed]) ? "center" : landed;
  };

  return (
    <section
      data-testid="pane"
      data-focused={focused ? "true" : undefined}
      data-attention={attention !== null ? "true" : undefined}
      data-drop-target={dropTarget ?? undefined}
      onDragOver={acceptsDrops ? (event) => {
        const surface = carriesSurface(event);
        if (!carriesSession(event) && !surface) return;
        // Without this the browser refuses the drop and the whole gesture ends in the default "no" cursor.
        event.preventDefault();
        event.dataTransfer.dropEffect = surface ? "move" : "copy";
        setDropTarget(readTarget(event));
      } : undefined}
      onDragLeave={acceptsDrops ? (event) => {
        // A drag crossing a child fires leave on the section too. Only a pointer that actually left the tile's box should clear
        // the hint.
        const rect = event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) setDropTarget(null);
      } : undefined}
      onDrop={acceptsDrops ? (event) => {
        if (carriesSurface(event)) {
          event.preventDefault();
          setDropTarget(null);
          const payload = decodeSurfaceDrag(event.dataTransfer.getData(SURFACE_DRAG_TYPE));
          if (payload) onSurfaceDrop!(payload, readTarget(event));
          return;
        }
        if (!carriesSession(event)) return;
        event.preventDefault();
        const sessionId = event.dataTransfer.getData(CHAT_SESSION_DRAG_TYPE);
        setDropTarget(null);
        if (sessionId) onSessionDrop!(sessionId, readTarget(event));
      } : undefined}
      // Focus follows interaction rather than a click on the frame itself: clicking into the composer IS choosing the group, and
      // requiring a second click on the chrome to say so would be a step with no purpose.
      onFocusCapture={onFocus}
      onMouseDownCapture={onFocus}
      ref={setTile}
      className={[
        // `relative` so the drop indicator can cover the half the new tile would take, in the tile's own coordinates. A row: the
        // conversation column, then the work panel's slot beside it, as tall as the tile.
        "relative flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden rounded-lg border bg-card",
        // Focus lives on the frame. `border-border` is the resting hairline;
        // the focused group swaps the whole border rather than adding a ring,
        // so a group never changes size when focus moves to it.
        // Attention rings OUTSIDE the border (a box shadow), so the tile keeps
        // its size; it outranks focus because it is what is not yet seen.
        attention !== null
          ? "border-primary ring-2 ring-primary/(--opacity-half)"
          : focused ? "border-primary/(--opacity-half)" : "border-border",
      ].join(" ")}
    >
      {/* One approval scope per pane: the column that holds this pane's
          header and body — its conversation's composer when the conversation
          is drawn, or no composer at all when a view is. The work panel's
          slot is a sibling, outside it, so a side chat's own scope is never
          inside a pane's. A card drawn here (over the composer, or in the
          settle slot) may affect this column and nothing beyond it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-approval-scope>
      <header
        data-testid="pane-header"
        className={[
          "flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap-tight) border-b border-border/(--opacity-half) px-(--chrome-gap)",
          dragSurface ? "cursor-grab active:cursor-grabbing" : "",
        ].join(" ")}
        {...(dragSurface ? {
          draggable: true,
          "data-drag-surface": dragSurface.tabId,
          onDragStart: (event: React.DragEvent<HTMLElement>) => {
            // The header's own controls are buttons; only the band itself drags.
            if ((event.target as HTMLElement).closest("button")) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData(SURFACE_DRAG_TYPE, encodeSurfaceDrag(dragSurface));
            event.dataTransfer.effectAllowed = "move";
          },
        } : {})}
      >
        {icon ? <span className="flex shrink-0 items-center text-muted-foreground">{icon}</span> : null}
        <h2
          className="min-w-0 flex-1 truncate text-caption font-medium text-foreground"
          title={attention ?? description}
        >
          {title}
          {meta ? (
            <span className="ml-(--chrome-gap-tight) font-mono font-normal text-muted-foreground" title={meta.title} data-testid="pane-header-meta">
              {meta.text}
            </span>
          ) : null}
        </h2>
        {titleAccessory}
        {headerActions.map((action) =>
          action.items ? (
            <DropdownMenu key={action.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={HEADER_BUTTON_CLASS}
                      disabled={action.disabled}
                      title={action.label}
                      aria-label={action.label}
                      data-testid={`pane-action-${action.id}`}
                    >
                      {action.icon}
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{action.label}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-[180px]">
                {action.items.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    data-testid={`pane-action-${action.id}-${item.id}`}
                    onClick={() => void item.onSelect()}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={HEADER_BUTTON_CLASS}
                  onClick={() => void action.onSelect()}
                  disabled={action.disabled}
                  title={action.label}
                  aria-label={action.label}
                  aria-pressed={action.active}
                  data-testid={`pane-action-${action.id}`}
                >
                  {action.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{action.label}</TooltipContent>
            </Tooltip>
          ),
        )}
        {onSplit ? (
          // Which way to halve is the user's call — beside the chat or under
          // it — so the control drops that choice instead of guessing from
          // the tile's shape. A direction the floors cannot afford is shown
          // disabled rather than hidden: the limit reads in the control.
          <Popover open={splitChoice !== null} onOpenChange={openSplitChoice}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={HEADER_BUTTON_CLASS}
                    title={t("pane.split")}
                    aria-label={t("pane.split")}
                    aria-expanded={splitChoice !== null}
                    data-testid="pane-split"
                  >
                    <Columns2 className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("pane.split")}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                if (!splitChosenRef.current) return;
                splitChosenRef.current = false;
                event.preventDefault();
              }}
              className="flex w-auto gap-1 p-1"
              aria-label={t("pane.split")}
              data-testid="pane-split-choice"
            >
              {splitChoice && !splitChoice.row && !splitChoice.column ? (
                <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="pane-split-no-room">
                  {t("pane.splitNoRoom")}
                </p>
              ) : (["row", "column"] as const).map((axis) => (
                <Button
                  key={axis}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-2 px-2 text-xs"
                  disabled={splitChoice ? !splitChoice[axis] : false}
                  data-testid={`pane-split-${axis}`}
                  onClick={() => {
                    splitChosenRef.current = true;
                    setSplitChoice(null);
                    onSplit(axis);
                  }}
                >
                  {axis === "row" ? <Columns2 className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
                  {axis === "row" ? t("pane.splitRow") : t("pane.splitColumn")}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        {/* Trailing cluster: the controls that act on this pane as a TILE —
            what its kind owns (`trailing`), its share of the area, its
            presence. A panel's own tabs live on the panel card, not here. */}
        <div className="flex h-full shrink-0 items-center gap-(--chrome-gap-tight)">
        {trailing}
        {onToggleMaximize ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`relative ${HEADER_BUTTON_CLASS}`}
                onClick={onToggleMaximize}
                title={maximized ? t("pane.restore") : t("pane.maximize")}
                aria-label={maximized ? t("pane.restore") : t("pane.maximize")}
                aria-pressed={maximized}
                data-testid="pane-maximize"
              >
                {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                {restoreAttention ? <PendingAnswerDot testId="pane-maximize-pending-answer" /> : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{maximized ? t("pane.restore") : t("pane.maximize")}</TooltipContent>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={HEADER_BUTTON_CLASS}
                onClick={onClose}
                title={closeText}
                aria-label={closeText}
                data-testid="pane-close"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{closeText}</TooltipContent>
          </Tooltip>
        ) : null}
        </div>
      </header>
      {/* The conversation list is the WINDOW's sidebar and only that. A second
          copy of it inside the frame said the same thing twice and cost the
          transcript the width to say it. */}
      <PanePanelSlotContext.Provider value={publishAsideSlot ? panelSlots : null}>
        <PaneBodyActionsContext.Provider value={setBodyActions}>
          <div
            // `relative`: the lane is anchored to the BODY, so a card floats over what the pane holds and never over its header band.
            className={bodyInset === "page"
              ? "relative flex min-h-0 min-w-0 flex-1 flex-col p-4"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col"}
            data-body-inset={bodyInset}
          >
            {children}
            {lane !== undefined ? <FloatingRightLane>{lane}</FloatingRightLane> : null}
            {/* The settle slot is the body's own bottom edge: its occupants
                position themselves against this `relative` body exactly as
                they do against the conversation column. */}
            {settle !== undefined ? <WebSurfaceOccluder>{settle}</WebSurfaceOccluder> : null}
          </div>
        </PaneBodyActionsContext.Provider>
      </PanePanelSlotContext.Provider>
      </div>
      {/* The work panel lands here: `contents` makes what the view portals
          in the tile's own flex item (a column beside the conversation) or,
          floating, a box positioned against the tile. */}
      {publishAsideSlot ? (
        <div ref={setPanelSlot} className="contents" data-testid="pane-panel-slot" />
      ) : null}
      {dropTarget ? (
        <div
          ref={dropIndicatorRef}
          aria-hidden={true}
          className="pointer-events-none absolute rounded-md border-2 border-primary bg-primary/(--opacity-subtle)"
          style={dropIndicatorStyle(dropTarget)}
          data-testid="pane-drop-indicator"
        />
      ) : null}
    </section>
  );
}

const groupApiCache = new WeakMap<AveApi, Map<string, AveApi>>();

/** Layer group-bound conversation channels over the full window API and memoize per group; absent group bindings may serve
 * only the primary conversation. */
export function chatGroupApi(api: AveApi, chatGroupId: string): AveApi {
  if (chatGroupId === MAIN_CHAT_GROUP_ID) return api;
  if (!api.chatGroup) throw new Error(`chat-group-unavailable:${chatGroupId}`);

  let perGroup = groupApiCache.get(api);
  if (!perGroup) {
    perGroup = new Map();
    groupApiCache.set(api, perGroup);
  }
  const cached = perGroup.get(chatGroupId);
  if (cached) return cached;

  const layered = { ...api, ...api.chatGroup(chatGroupId) } as AveApi;
  perGroup.set(chatGroupId, layered);
  return layered;
}

export interface ChatGroupState {
  id: string;
  /** The work panel, per pane — its own right-hand rail. */
  panelOpen: boolean;
  /** Session routine and browser thumbnails, independent of the work panel. */
  thumbnailOpen: boolean;
  /** Where this tile sits, in percentages of the main area. */
  box: PaneBox;
  /**
   * The view is not showing this group right now — a narrow canvas draws one, and
   * maximizing draws one. It stays MOUNTED: its conversation may be mid-turn,
   * and a turn's stream subscription, streaming flag and stop control all live
   * in the tile. Unmounting it would drop the frames on the floor, stop the
   * sidebar from saying that conversation is running, and fire a turn-end that
   * did not happen.
   */
  hidden: boolean;
}

/** A pane showing its own conversation — the default, and every pane's content today. Shared rather than rebuilt so
 * identity comparisons stay cheap; nothing mutates a location in place. */
export const PANE_HOME: ViewLocation = { view: "home" };

/**
 * A narrow canvas draws the focused tile while retaining the full tree and
 * the user's maximized choice for when the canvas widens.
 */
function visibleTreeFor(tree: PaneNode, isSingleTile: boolean, focusedId: string, maximizedId: string | null): PaneNode {
  const shownAlone = isSingleTile ? focusedId : maximizedId;
  return shownAlone === null ? tree : leaf(shownAlone);
}

/** Conversation-group and canvas-leaf ceilings count different resources; keep loop ownership separate from pane geometry
 * and displayed content. */
export function useChatGroups(canvasElement: HTMLElement | null) {
  const { isNarrow: isSingleTile } = useContainerNarrow(canvasElement, {
    enter: SINGLE_TILE_ENTER_WIDTH, exit: SINGLE_TILE_EXIT_WIDTH,
  });
  const [tree, setTree] = useState<PaneNode>(() => leaf(MAIN_CHAT_GROUP_ID));
  const [panelOpenIds, setPanelOpenIds] = useState<readonly string[]>([]);
  const [thumbnailOpenIds, setThumbnailOpenIds] = useState<readonly string[]>([]);
  const [focusedId, setFocusedId] = useState(MAIN_CHAT_GROUP_ID);
  // The one tile shown alone, if any. A view choice: the others keep their conversations and their places
  // until restored.
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  // Restoring a maximized pane also restores focus so window controls address the visible conversation.
  useEffect(() => {
    if (!isSingleTile && maximizedId !== null) setFocusedId(maximizedId);
  }, [isSingleTile, maximizedId]);
  // Monotonic, so a closed tile's id is never reused within this renderer.
  // Main-process loops are keyed by this id, and reusing one would hand a
  // new tile the previous tile's live history. (A reload starts the count
  // over — main lets every group go when the renderer navigates, so the
  // fresh count meets no stale loop.)
  const nextGroupIndex = useRef(2);
  /** Store content beside the geometry tree so splitting or resizing does not rewrite view state; home means that pane's
   * conversation. */
  const [contentById, setContentById] = useState<Record<string, ViewLocation>>(
    () => ({ [MAIN_CHAT_GROUP_ID]: PANE_HOME }),
  );
  /** Count mounted conversation owners, including hidden routed conversations, against the loop ceiling. */
  const [conversationIds, setConversationIds] = useState<ReadonlySet<string>>(
    () => new Set([MAIN_CHAT_GROUP_ID]),
  );

  const setPanelOpen = useCallback((id: string, open: boolean) => {
    setPanelOpenIds((current) => {
      const has = current.includes(id);
      if (has === open) return current;
      return open ? [...current, id] : current.filter((each) => each !== id);
    });
  }, []);

  const setThumbnailOpen = useCallback((id: string, open: boolean) => {
    setThumbnailOpenIds((current) => {
      const has = current.includes(id);
      if (has === open) return current;
      return open ? [...current, id] : current.filter((each) => each !== id);
    });
  }, []);

  /**
   * Drop a new conversation on `targetGroupId`'s `edge`.
   *
   * Returns the new group's id, or null when the ceiling is already reached —
   * the caller shows no edge affordance in that case, so the limit is visible
   * in the gesture rather than as a rejection after the fact.
   */
  const dropOnEdge = useCallback((targetGroupId: string, edge: DropEdge): string | null => {
    if (isSingleTile) return null;
    // Two ceilings, both binding: the drop opens a conversation (a loop) AND a
    // pane (a rectangle on the canvas). They are the same number today because
    // every pane holds a conversation, and they are asked separately so that
    // stops being an assumption the code relies on.
    if (conversationIds.size >= MAX_CHAT_GROUPS) return null;
    if (countLeaves(tree) >= MAX_PANES) return null;
    const id = `group-${nextGroupIndex.current}`;
    nextGroupIndex.current += 1;
    setTree((current) => splitLeaf(current, targetGroupId, edge, id));
    setContentById((current) => ({ ...current, [id]: PANE_HOME }));
    setConversationIds((current) => new Set(current).add(id));
    setFocusedId(id);
    // A tile added behind a maximized one would be a tile nobody can see.
    setMaximizedId(null);
    return id;
  }, [tree, conversationIds, isSingleTile]);

  /** The header's split: halve `groupId` on `axis`, the new tile trailing — beside it for `row`, under it for `column`. The
   * direction is the user's; the control offers only the ones {@link splitFits} allows. */
  const split = useCallback((groupId: string, axis: PaneSplitAxis) => {
    dropOnEdge(groupId, SPLIT_EDGE[axis]);
  }, [dropOnEdge]);

  /**
   * Whether halving `groupId` on `axis` leaves both halves at or above the
   * tile floors, given the canvas the percentages are laid out in. An
   * unmeasured canvas (no element yet) affords any split: nothing to check
   * against, and the gutter floors still hold once it is laid out.
   */
  const splitFits = useCallback((groupId: string, axis: PaneSplitAxis, canvasSize: { width: number; height: number } | undefined) => {
    if (!canvasSize) return true;
    const box = layoutBoxes(tree).find((each) => each.chatGroupId === groupId);
    if (!box) return false;
    const extent = axis === "row"
      ? (box.width / 100) * canvasSize.width
      : (box.height / 100) * canvasSize.height;
    const floor = axis === "row" ? PANE_MIN_WIDTH : PANE_MIN_HEIGHT;
    // Each half is a cell; the floor is on what the cell's frame gets to use.
    return extent / 2 - PANE_CELL_INSET >= floor;
  }, [tree]);

  /** Adoption respects the loop ceiling; at capacity release only an idle, non-focused group and disclose lost
   * draft/scroll state. `alone` is for a gesture that never asked for a split (picking a conversation in the sidebar): on a
   * canvas showing one tile, the new tile is maximized so the busy one keeps running out of view instead of opening a split. */
  const adopt = useCallback((
    besideGroupId: string,
    isIdle: (chatGroupId: string) => boolean,
    canvasSize: { width: number; height: number } | undefined,
    reveal: "beside" | "alone" = "beside",
  ): { chatGroupId: string; released: string | null } | null => {
    let released: string | null = null;
    // Either ceiling forces the swap — the newcomer needs both a loop and a tile, so whichever is full is the one that has to
    // give something back.
    if (conversationIds.size >= MAX_CHAT_GROUPS || countLeaves(tree) >= MAX_PANES) {
      // The primary is never the spare. Releasing it does more than drop a
      // loop: main points that loop at a fresh conversation and clears the
      // persisted window-active session, so the next launch would open blank
      // instead of where the user left off. Closing the primary is a gesture
      // the user makes deliberately; it is not something to do to them.
      released = leafIds(tree).find(
        (id) => id !== besideGroupId && id !== focusedId && id !== MAIN_CHAT_GROUP_ID
          && (!isSingleTile || id !== maximizedId) && isIdle(id),
      ) ?? null;
      if (released === null) return null;
    }
    const id = `group-${nextGroupIndex.current}`;
    nextGroupIndex.current += 1;
    const spare = released;
    setTree((current) => splitLeaf(
      spare === null ? current : closeLeaf(current, spare),
      besideGroupId,
      "right",
      id,
    ));
    setPanelOpenIds((current) => (spare === null ? current : current.filter((each) => each !== spare)));
    setThumbnailOpenIds((current) => (spare === null ? current : current.filter((each) => each !== spare)));
    setContentById((current) => {
      const next = { ...current, [id]: PANE_HOME };
      if (spare !== null) delete next[spare];
      return next;
    });
    setConversationIds((current) => {
      const next = new Set(current);
      if (spare !== null) next.delete(spare);
      next.add(id);
      return next;
    });
    setFocusedId(id);
    // Narrow adoption changes focus only; keep the user's wide-canvas maximized choice.
    const showsOneTile = countLeaves(tree) === 1 || maximizedId !== null;
    if (!isSingleTile) {
      setMaximizedId(reveal === "alone" && showsOneTile ? id : splitFits(besideGroupId, "row", canvasSize) ? null : id);
    }
    return { chatGroupId: id, released };
  }, [tree, focusedId, splitFits, isSingleTile, maximizedId, conversationIds]);

  // Any tile but the last can go, the primary included: once split, the
  // primary is one tile among the others to the user, and a close that works
  // on every tile but one reads as a bug on that one. Its loop stays — main
  // gives it a blank conversation on release rather than tearing it down.
  const close = useCallback((id: string) => {
    if (isSingleTile) return;
    const next = closeLeaf(tree, id);
    if (next === tree) return;
    const survivors = leafIds(next);
    setTree(next);
    setFocusedId((focused) => (survivors.includes(focused) ? focused : survivors[0]!));
    setMaximizedId((current) => (current === id ? null : current));
    setPanelOpenIds((current) => current.filter((each) => each !== id));
    setThumbnailOpenIds((current) => current.filter((each) => each !== id));
    setContentById((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setConversationIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, [tree, isSingleTile]);

  const toggleMaximize = useCallback((id: string) => {
    if (isSingleTile) return;
    setMaximizedId((current) => (current === id ? null : id));
    setFocusedId(id);
  }, [isSingleTile]);

  // Focusing a hidden tile must move the maximize target too, or focus-derived controls would address an unseen
  // conversation.
  const focus = useCallback((id: string) => {
    setFocusedId(id);
    if (!isSingleTile) setMaximizedId((current) => (current === null ? null : id));
  }, [isSingleTile]);

  /** Deduplicate locations over live panes only; home is exempt because each pane owns a distinct conversation. */
  const paneShowing = useCallback((location: ViewLocation): string | undefined => {
    if (location.view === "home") return undefined;
    return leafIds(tree).find(
      (paneId) => sameViewLocation(contentById[paneId] ?? PANE_HOME, location),
    );
  }, [tree, contentById]);

  /** A non-home location has one pane; focus its existing owner to avoid competing settings state or duplicate plugin guests. */
  const setPaneContent = useCallback((id: string, location: ViewLocation) => {
    const openElsewhere = paneShowing(location);
    if (openElsewhere !== undefined && openElsewhere !== id) {
      focus(openElsewhere);
      return;
    }
    setContentById((current) => ({ ...current, [id]: location }));
  }, [paneShowing, focus]);

  /**
   * Move what pane `from` shows into pane `to`, in ONE update, and focus `to`.
   *
   * What `to` showed goes back to `from` — a swap — so two panes trading a
   * terminal and a web page keep both. A pane on home gives `from` its own home
   * back. Built on the content map directly rather than on `setPaneContent`:
   * that setter refuses a location another pane already shows, which is
   * exactly the state a move starts in.
   */
  const movePaneContent = useCallback((from: string, to: string) => {
    if (from === to) return;
    setContentById((current) => ({
      ...current,
      [to]: current[from] ?? PANE_HOME,
      [from]: current[to] ?? PANE_HOME,
    }));
    focus(to);
  }, [focus]);

  /**
   * Open `location` in a NEW pane on `targetId`'s `edge` — the drop of a
   * surface on a pane's edge — and put `vacate` (the pane it came from, if
   * any) back on home, in one update. Null when either ceiling is reached; the
   * caller's drop affordance already degrades to the centre there.
   */
  const placeOnEdge = useCallback((
    targetId: string,
    edge: DropEdge,
    location: ViewLocation,
    vacate?: string,
  ): string | null => {
    const id = dropOnEdge(targetId, edge);
    if (id === null) return null;
    setContentById((current) => {
      const next = { ...current, [id]: location };
      if (vacate !== undefined && vacate !== id) next[vacate] = PANE_HOME;
      return next;
    });
    return id;
  }, [dropOnEdge]);

  /** The drawn pane beside `id` in `direction`: the one sharing the most of `id`'s edge on that side. Undefined at the canvas
   * edge. */
  const paneNeighbor = useCallback((id: string, direction: "left" | "right" | "up" | "down"): string | undefined => {
    const boxes = layoutBoxes(visibleTreeFor(tree, isSingleTile, focusedId, maximizedId));
    const from = boxes.find((box) => box.chatGroupId === id);
    if (!from) return undefined;
    const EPS = 0.01;
    let best: { id: string; overlap: number } | undefined;
    for (const box of boxes) {
      if (box.chatGroupId === id) continue;
      const touches =
        direction === "left" ? Math.abs(box.left + box.width - from.left) < EPS
        : direction === "right" ? Math.abs(from.left + from.width - box.left) < EPS
        : direction === "up" ? Math.abs(box.top + box.height - from.top) < EPS
        : Math.abs(from.top + from.height - box.top) < EPS;
      if (!touches) continue;
      const overlap = direction === "left" || direction === "right"
        ? Math.min(from.top + from.height, box.top + box.height) - Math.max(from.top, box.top)
        : Math.min(from.left + from.width, box.left + box.width) - Math.max(from.left, box.left);
      if (overlap > EPS && (!best || overlap > best.overlap)) best = { id: box.chatGroupId, overlap };
    }
    return best?.id;
  }, [tree, isSingleTile, focusedId, maximizedId]);

  /** Conversation-scoped controls use the focused conversation or the last one focus left; update the ref from render so all
   * focus-changing paths agree. */
  const lastFocusedConversationRef = useRef(MAIN_CHAT_GROUP_ID);
  if (conversationIds.has(focusedId)) lastFocusedConversationRef.current = focusedId;
  const focusedConversationId = conversationIds.has(focusedId)
    ? focusedId
    // The remembered pane can itself have been closed, so it is checked rather than trusted; the primary is the last answer
    // because its loop outlives its pane — main keeps it and hands it a blank conversation on release.
    : conversationIds.has(lastFocusedConversationRef.current)
      ? lastFocusedConversationRef.current
      : leafIds(tree).find((id) => conversationIds.has(id)) ?? MAIN_CHAT_GROUP_ID;

  // Folding hides other groups without closing them or losing their layout.
  const visibleTree: PaneNode = visibleTreeFor(tree, isSingleTile, focusedId, maximizedId);
  const groups = useMemo<ChatGroupState[]>(
    () => {
      const drawn = new Map(layoutBoxes(visibleTree).map((box) => [box.chatGroupId, box]));
      // EVERY leaf, not just the drawn ones. What the view shows is a display question; which conversations are alive is the
      // tree's answer, and a live conversation keeps its tile so its turn keeps its subscription.
      return leafIds(tree).map((id) => {
        const box = drawn.get(id);
        return {
          id,
          panelOpen: panelOpenIds.includes(id),
          thumbnailOpen: thumbnailOpenIds.includes(id),
          // A hidden tile keeps the whole canvas as its box: it is not laid out against its neighbours, and a zero-size one would
          // have its own layout effects measure nonsense on the way back into view.
          box: box ?? { chatGroupId: id, left: 0, top: 0, width: 100, height: 100 },
          hidden: box === undefined,
        };
      });
    },
    // `visibleTree` is rebuilt while folded; depend on its inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, isSingleTile, focusedId, maximizedId, panelOpenIds, thumbnailOpenIds],
  );

  // Once split, every tile can be closed and any one can be shown alone —
  // even while one is: the tree, not the view, says how many there are. Not
  // on a folded canvas, though: it shows one tile and nothing of the others, so a
  // close there would swap in a conversation the user has no way to expect.
  // `adopt` releases a group there instead, and only an idle one.
  const closable = !isSingleTile && countLeaves(tree) > 1;
  const canMaximize = !isSingleTile && countLeaves(tree) > 1;

  // Offer split only while both the conversation and pane ceilings have room.
  const canSplit = !isSingleTile
    && countLeaves(tree) < MAX_PANES
    && conversationIds.size < MAX_CHAT_GROUPS;

  /** New-pane navigation uses the same ceiling and size-floor checks as header split; callers must report refusal. */
  const openPane = useCallback((
    besideGroupId: string,
    canvasSize: { width: number; height: number } | undefined,
  ): string | null => {
    if (!canSplit) return null;
    if (!splitFits(besideGroupId, "row", canvasSize)) return null;
    return dropOnEdge(besideGroupId, SPLIT_EDGE.row);
  }, [canSplit, splitFits, dropOnEdge]);

  /**
   * Put back a saved layout at launch: its tree, its focus, which panes had
   * their side panel open, and what the listed panes show. Every pane holds a
   * conversation (a fresh one — conversations are not part of a layout).
   * A pane whose content something already set (the restored `activeView`
   * may land first) keeps it unless the layout names a surface for it. Group
   * numbering moves past the restored ids, so a later split cannot reuse one.
   */
  const restore = useCallback((layout: {
    tree: PaneNode;
    focusedId: string;
    panelOpenIds: readonly string[];
    thumbnailOpenIds: readonly string[];
    content: Readonly<Record<string, ViewLocation>>;
  }) => {
    const ids = leafIds(layout.tree);
    for (const id of ids) {
      const n = /^group-(\d+)$/.exec(id);
      if (n && Number(n[1]) >= nextGroupIndex.current) nextGroupIndex.current = Number(n[1]) + 1;
    }
    setTree(layout.tree);
    setFocusedId(layout.focusedId);
    setMaximizedId(null);
    setPanelOpenIds([...layout.panelOpenIds]);
    setThumbnailOpenIds([...layout.thumbnailOpenIds]);
    setConversationIds(new Set(ids));
    setContentById((current) => Object.fromEntries(ids.map((id) => [id, layout.content[id] ?? current[id] ?? PANE_HOME])));
  }, []);

  // A folded canvas has one visible leaf and no boundaries.
  const gutters = useMemo(
    () => layoutGutters(visibleTree),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, isSingleTile, focusedId, maximizedId],
  );

  const resize = useCallback((gutter: Pick<PaneGutter, "path" | "index">, leadingShare: number) => {
    setTree((current) => resizeGutter(current, gutter, leadingShare));
  }, []);

  /** Where everything WOULD be with the gutter at `leadingShare`, without committing it — what a drag paints frame by frame.
   * The tree is committed once, at the end, so a drag does not re-render four conversations per pointer move. */
  const previewResize = useCallback(
    (gutter: Pick<PaneGutter, "path" | "index">, leadingShare: number) => {
      const next = resizeGutter(tree, gutter, leadingShare);
      return { boxes: layoutBoxes(next), gutters: layoutGutters(next) };
    },
    [tree],
  );

  return {
    isSingleTile,
    groups,
    gutters,
    tree,
    focusedId,
    focus,
    contentById,
    setPaneContent,
    movePaneContent,
    placeOnEdge,
    paneNeighbor,
    paneShowing,
    conversationIds,
    focusedConversationId,
    setPanelOpen,
    setThumbnailOpen,
    canSplit,
    split,
    splitFits,
    openPane,
    dropOnEdge,
    adopt,
    resize,
    previewResize,
    close,
    closable,
    canMaximize,
    maximizedId,
    toggleMaximize,
    panelOpenIds,
    thumbnailOpenIds,
    restore,
  };
}

/** Percent geometry → the inline style a cell or gutter is positioned with. */
export function areaStyle(box: { left: number; top: number; width: number; height: number }) {
  return {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  };
}

export interface PaneGutterProps {
  gutter: PaneGutter;
  /** The tile area, for turning percentages into the pixels the floors are in. */
  canvasRef: RefObject<HTMLElement | null>;
  previewResize: (gutter: PaneGutter, leadingShare: number) => {
    boxes: PaneBox[];
    gutters: PaneGutter[];
  };
  onResize: (gutter: PaneGutter, leadingShare: number) => void;
}

/** Convert pixel floors to tree shares; write drag geometry directly and commit the tree on release to avoid rerendering
 * every conversation per move. */
export function PaneGutter({ gutter, canvasRef, previewResize, onResize }: PaneGutterProps) {
  const { t } = useTranslation();
  const canvas = useMeasuredSize(canvasRef);
  const along = gutter.axis === "row" ? canvas.width : canvas.height;
  const pairPx = (along * (gutter.leading + gutter.trailing)) / 100;
  const floor = gutter.axis === "row" ? PANE_MIN_WIDTH : PANE_MIN_HEIGHT;
  const leadingPx = (along * gutter.leading) / 100;

  const paint = useCallback((leadingShare: number) => {
    const root = canvasRef.current;
    if (!root) return;
    const next = previewResize(gutter, leadingShare);
    for (const box of next.boxes) {
      const cell = root.querySelector<HTMLElement>(`[data-testid="pane-cell:${box.chatGroupId}"]`);
      if (cell) Object.assign(cell.style, areaStyle(box));
    }
    for (const each of next.gutters) {
      const bar = root.querySelector<HTMLElement>(`[data-testid="pane-gutter:${each.key}"]`);
      if (bar) Object.assign(bar.style, areaStyle(each));
    }
  }, [canvasRef, gutter, previewResize]);

  // A pair that cannot fit two floors has nothing to give. No bar, rather than a bar that snaps back on every drag.
  if (pairPx < floor * 2) return null;

  return (
    <div
      className="absolute"
      style={areaStyle(gutter)}
      data-testid={`pane-gutter:${gutter.key}`}
    >
      <EdgeResizeBar
        width={leadingPx}
        edge="end"
        axis={gutter.axis === "row" ? "x" : "y"}
        min={floor}
        max={pairPx - floor}
        resetWidth={pairPx / 2}
        onWidthChange={(px) => paint(px / pairPx)}
        onWidthCommit={(px) => onResize(gutter, px / pairPx)}
        ariaLabel={t("pane.resize")}
        data-testid={`pane-gutter-bar:${gutter.key}`}
      />
    </div>
  );
}

/** Headers and sidebar menus share conversation action descriptors and command ids so available actions cannot diverge. */
export function buildChatGroupActions({
  t,
  pinned,
  onTogglePin,
  onExport,
  onImport,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  pinned: boolean;
  onTogglePin: () => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onImport: () => void | Promise<void>;
}): PaneAction[] {
  return [
    {
      // The label states what the click DOES, which flips with state. A fixed
      // "Pin" would be wrong half the time for a screen reader, and that costs
      // more than a tooltip whose text changes under the cursor — the tooltip
      // is already gone by the time the state has changed.
      id: pinned ? "conversation.unpin" : "conversation.pin",
      label: pinned ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar"),
      active: pinned,
      icon: (
        <Pin
          // Keyed so React remounts on toggle: the fill animation is a mount animation, and without the key it would never replay.
          key={pinned ? "on" : "off"}
          className={`h-4 w-4 ${pinned ? "fill-emphasis text-emphasis ave-anim-star" : ""}`}
        />
      ),
      onSelect: onTogglePin,
    },
    {
      id: "conversation.export",
      label: t("mainToolbar.export"),
      icon: <Download className="h-4 w-4" />,
      // Two formats, so this opens a menu rather than firing. The frame reads `items` to decide that — the caller does not pick
      // the control type.
      items: [
        { id: "markdown", label: t("sidebar.exportMarkdown"), onSelect: () => onExport("markdown") },
        { id: "json", label: t("sidebar.exportJson"), onSelect: () => onExport("json") },
      ],
      onSelect: () => {},
    },
    {
      id: "conversation.import",
      label: t("mainToolbar.import"),
      icon: <Upload className="h-4 w-4" />,
      onSelect: onImport,
    },
  ];
}
