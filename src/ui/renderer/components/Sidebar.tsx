import { SidebarPreviewProvider, SidebarPreviewTrigger, type SidebarPreviewData } from "./SidebarPreview.js";
import { loadSidebarSurfacePreview } from "../utils/sidebar-preview-data.js";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import { PendingAnswerDot } from "./PendingAnswerDot.js";
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  Folder,
  House,
  MessageSquarePlus,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PowerOff,
  Plus,
  Search,
  Wrench,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { toPluginDoctorViewKey, toPluginSettingsViewKey } from "../utils/plugin-doctor-view.js";
import { pluginIconFor } from "../utils/plugin-icon.js";
import { BUILTIN_LABEL_KEYS, BUILTIN_VIEW_ICONS } from "../utils/view-location.js";
import { sortWithPinnedFirst } from "../utils/pinned-sort.js";
import { useSidebarItems, type SidebarSurface } from "../hooks/use-sidebar-items.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import type { BrowserTabsApi } from "../../../shared/browser-surface.js";
import type { SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";
import {
  useAddProjectFolder,
  type AddProjectFolderOutcome,
  type ProjectErrorReporter,
} from "../hooks/use-add-project-folder.js";
import { RAIL_CONTROL_SIZE_CLASS, SHELL_GUTTER } from "../../../shared/shell-geometry.js";
import { Rail, RailButton } from "./sidebar/Rail.js";
import { ProjectMark, ProjectMenu, type ProjectMenuModel } from "./sidebar/ProjectMenu.js";
import { ProjectPicker } from "./sidebar/ProjectPicker.js";
import { projectTestId } from "./sidebar/ProjectCombobox.js";
import type { InlineViewKey } from "../../../shared/view-key.js";
import type { PluginCardSummary, PluginUiExtension } from "../types.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { SessionFamily } from "../../../shared/session-lookup.js";
import { tabIcon } from "./ChatSidePanelPreview.js";
import { useActiveSurface } from "../preview/active-surface.js";
import type { ProjectIdentity, ProjectSelection } from "../../../shared/project-identity.js";
import { projectRootEquals, workspaceRootsToProjects } from "../../../shared/project-identity.js";
import { CHAT_SESSION_DRAG_TYPE } from "./pane-drop.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../../shared/side-panel.js";
import { formatRelativeSessionTime } from "../../../shared/format-time.js";
import { isSuggestionsSession } from "../../../shared/suggestions-session.js";
import { resolveConversationTitle } from "../../../shared/conversation-title.js";

// A nav row draws the same glyph the pane header draws for the view it opens — one map, so a row and the header it
// produces cannot disagree.
const WorkBoardIcon = BUILTIN_VIEW_ICONS["work-board"];
const RoutinesIcon = BUILTIN_VIEW_ICONS.routines;
const InsightsIcon = BUILTIN_VIEW_ICONS.insights;
const SettingsIcon = BUILTIN_VIEW_ICONS.settings;
const MemoryIcon = BUILTIN_VIEW_ICONS.memory;
const TerminalViewIcon = BUILTIN_VIEW_ICONS.terminal;
const WebViewIcon = BUILTIN_VIEW_ICONS.web;

/** What assistive tech reads for each family's glyph. */
const SESSION_FAMILY_LABEL_KEYS: Record<SessionFamily, string> = {
  main: "sidebar.mainConversation",
  routine: "sidebar.routineConversation",
  "work-board": "sidebar.workBoardConversation",
  "side-chat": "sidebar.sideChatConversation",
};

/** The sidebar's one add-project flow, run from the project menu and the list's right-click. */
interface SidebarAddFlow {
  pendingWarning: ReturnType<typeof useAddProjectFolder>["pendingWarning"];
  addProject: () => Promise<void>;
  confirmAddProject: () => Promise<void>;
  cancelPendingFolder: () => void;
}

/** What the rail's launchers open. */
export type SidebarLaunchKind = "chat" | "web" | "terminal";

export interface SidebarProps {
  activeView: InlineViewKey;
  /** Called with the selected key — same contract as handleViewSelect, which also accepts the `plugin-doctor:<id>` pseudo-key
   * that is intercepted before it can become a location. Hence `string`, not `ViewKey`. */
  onSelect: (viewKey: string) => void;
  /** Hide new-pane gestures on a narrow canvas; report capacity refusals when invoked. */
  onSelectInNewPane?: (viewKey: string) => void;
  /** Plugin views from usePluginMarketplace — same list passed to the main content region. */
  pluginViews: PluginUiExtension[];
  /** Installed plugins that failed to load and therefore need Settings → Plugin Doctor. */
  failedPluginCards?: PluginCardSummary[];
  /**
   * Installed plugins the user has switched off that reserve a sidebar slot.
   * They are shown here — greyed, badged "off", no repair affordance — because
   * an inactive plugin that renders nowhere is indistinguishable from one the
   * app dropped, which is the exact confusion this list exists to end.
   */
  inactivePluginCards?: PluginCardSummary[];
  /** Auth-status map: pluginId → { kind: "authed" | "unauthed" | ... }. */
  pluginAuthStatuses?: ReadonlyMap<string, { kind: string }>;
  /** Whether the user has an API key configured — drives the settings warning. */
  hasApiKey: boolean | null;
  /** Canonical subscription readiness policy; legacy booleans are fallback-only. */
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  /** Selected subscription runtime needs sign-in or verification. */
  subscriptionUnavailable?: boolean;
  /** Selected subscription runtime is still checking whether chat is available. */
  subscriptionPending?: boolean;
  /**
   * Whether a chat model is configured at all — a subscription runtime is
   * selected, or the API vendor names a model. `null` until the shell's
   * settings snapshot has landed. The Settings entry carries a red badge
   * while this is known-false; the composer status row no longer shows it.
   */
  modelConfigured?: boolean | null;
  onOpenSettings: () => void;
  /** The window's project selection (plan D1); undefined until it and the project list have loaded. */
  projectSelection?: ProjectSelection;
  /** The selected project; undefined in the all-projects view. */
  selectedProject?: ProjectIdentity;
  /** Most recent first. */
  recentProjectRoots?: readonly string[];
  /** The name a project shows everywhere: its label, 기본 프로젝트, or its folder name. */
  projectName: (project: ProjectIdentity) => string;
  onSelectProjectRoot: (projectRoot: string) => void;
  onSelectAllProjects: () => void;
  /** A folder was added as a project (or was one already): the shell switches to it (case 08–09). */
  onProjectAdded: (projectRoot: string, alreadyOpen: boolean) => void;
  /** Open a new chat, web page or terminal in `project` (case 11–13). The rail asks which project in the all-projects view;
   * before the selection has loaded, `project` is undefined and the window's project applies. */
  onLaunch: (kind: SidebarLaunchKind, project: ProjectIdentity | undefined) => void;
  /**
   * The list beside the rail is folded (`sidebarState` "rail", case 21). The rail stays; the shell's band carries the button
   * that unfolds the list again.
   */
  collapsed: boolean;
  /**
   * The expanded card floats OVER the content instead of the shell reserving
   * room for it when the shell is too narrow to push content. The shell
   * derives it from its measured width; the card then behaves as a transient
   * surface — it takes focus when it opens, collapses on Escape or a pointer
   * down on the content beside it, and hands focus back to the toggle.
   */
  overlay?: boolean;
  /** Fold the list (the button in the list header) or unfold it. */
  onToggleCollapse: () => void;
  /** Expanded card width (px). Ignored while collapsed (fixed icon rail). */
  width?: number;
  /** Available card width from the shell observer; caps rendering without changing the saved preference. */
  maxWidth?: number;
  /** Per-move drag update of the sidebar width (state only). */
  onWidthChange?: (px: number) => void;
  /** Drag-end / keyboard commit of the sidebar width (persist). Also drives the resize bar's double-click reset (commits
   * SIDEBAR_DEFAULT_WIDTH). */
  onWidthCommit?: (px: number) => void;
  /** Open the unified search overlay — the rail's search button. */
  onOpenUnifiedSearch: () => void;
  /** Recent main-chat sessions shown under the current project group. */
  sessions?: SessionSummary[];
  /** Workspace projects from the App-level active project source of truth. */
  projects?: ProjectIdentity[];
  /** Active chat session id for project conversation selection state. */
  currentSessionId?: string;
  /** Load a selected session from the project conversation list. */
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  /** Open a work-board item from its conversation row. A run's session lives in the sub-agent namespace and cannot be loaded
   * into a chat tile, so the row opens the item on the board — where its run transcripts already are. */
  onOpenWorkBoardItem?: (itemId: number) => void;
  /**
   * Open a side chat from its row: the conversation it belongs to in the
   * focused tile, then that tile's side-chat tab showing this side chat. The
   * rail's loop is window-wide and its store isolated, so the row cannot be
   * loaded into a tile the way a conversation is.
   */
  onOpenSideChat?: (sideChatSessionId: string, originSessionId?: string) => void;
  /** Open the live terminal or page and its own chat panel. */
  onOpenPaneChat?: (tabId: string) => void;
  /** Start a new main-chat session scoped to the selected project root. */
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list (after a context-menu mutation e.g. remove). */
  onRefreshProjects?: () => void | Promise<void>;
  /** Surface a refused project mutation — an add or a remove — to the user. */
  onProjectError?: ProjectErrorReporter;
  /** Surface an informational outcome of a project mutation the user made (never a confirmation). */
  onProjectNotice?: (message: string) => void;
  mainSurfaces?: readonly MainSurface[];
  browserTabs?: BrowserTabsApi;
  chatGroupIds?: readonly string[];
  onOpenSurface?: (tabId: string) => void;
  isSurfaceVisible?: (tabId: string) => boolean;
  /** Per-conversation pin state — reuses the existing starred-session mechanism (id truthy = pinned). */
  isSessionStarred?: (sessionId: string) => string | null;
  /** Toggle a conversation's pin state (any row, not just the active session). */
  onToggleSessionStar?: (sessionId: string, title?: string) => void | Promise<void>;
  /** True when the given project root is pinned — pinned projects sort first. */
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  /** Pin/unpin a project — persists immediately (SystemSettings). */
  onToggleProjectPin?: (projectRoot: string) => void;
  conversationActions?: ConversationRowActions;
  /** What a project row can do to itself — see ProjectRowActions. */
  projectActions?: ProjectRowActions;
  /**
   * Sessions whose turn is parked on a request the user cannot currently see
   * — an approval, a question or a deferred approval held by a pane that is
   * hidden, routed away, or not open at all. Their rows carry the yellow dot.
   * One selector (`pendingAnswers`) feeds this and the header controls, so
   * the sidebar and a pane header cannot disagree about who is waiting.
   */
  pendingAnswerSessionIds?: ReadonlySet<string>;
  /** A plugin or host request names no conversation and is waiting — the Plugins row carries the dot. */
  pluginRequestPending?: boolean;
  /** Cards waiting in the dedicated Suggestions conversation — the count its row carries. Derived from the window's card
   * queue. */
  suggestionsPendingCount?: number;
}

// The aside starts below the band on darwin, where the traffic lights would cover the rail; without a preload bridge no
// native alignment applies.
function isDarwinPlatform(): boolean {
  return (
    (window as unknown as { avePlatform?: { isDarwin: boolean } }).avePlatform?.isDarwin ?? false
  );
}

/**
 * Per-section hover tone. Primary nav reads as the main surface (`accent`);
 * the footer reads as secondary (`muted`), so its rows tint a step softer on
 * hover. Both are theme tokens — a bundle switch re-tints every surface and
 * the color-token gate stays clean (no raw literals).
 */
type NavTone = "accent" | "muted" | "settings";

/**
 * Per-tone styling: `hover` (inactive hover tint), `active` (selected bg+text),
 * `bar` (the left active-indicator bar color). The footer Settings row
 * carries its own color so its ACTIVE state matches its hover tint (green/
 * success on both, not the shared primary). All theme tokens — the
 * color-token gate stays clean.
 */
const NAV_TONE: Record<NavTone, { hover: string; active: string; bar: string }> = {
  accent: {
    hover: "hover:bg-accent hover:text-accent-foreground",
    active: "bg-primary/(--opacity-subtle) text-primary",
    bar: "bg-primary",
  },
  muted: {
    hover: "hover:bg-muted hover:text-foreground",
    active: "bg-primary/(--opacity-subtle) text-primary",
    bar: "bg-primary",
  },
  settings: {
    hover: "hover:bg-success/(--opacity-faint) hover:text-foreground",
    active: "bg-success/(--opacity-faint) text-success",
    bar: "bg-success",
  },
};

interface NavItemProps {
  preview?: SidebarPreviewData;
  loadPreview?: () => Promise<SidebarPreviewData>;
  viewKey: string;
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  /** The event is passed because HOW the row was clicked decides where the view opens — a plain click replaces the focused
   * pane, meta/ctrl opens a new one. */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Right-click. The row's own menu, so the modifier chord above is not the only way to discover the second destination. */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  collapsed: boolean;
  /** Hover tone for the inactive state. Defaults to the primary `accent` surface. */
  tone?: NavTone;
  "data-testid"?: string;
  "data-viewkey"?: string;
  "data-tour-anchor"?: string;
  title?: string;
  tooltipLabel?: string;
  trailingSlot?: React.ReactNode;
  /** `menuitem` when the row sits inside a NavGroup flyout. */
  role?: "menuitem";
  /** A badge pinned to the icon's corner, drawn in both the expanded row and the collapsed rail — unlike `trailingSlot`,
   * which only the row has room for. This is how an entry stays alerting after the sidebar collapses. */
  iconBadge?: React.ReactNode;
}

function NavItem({
  preview,
  loadPreview,
  viewKey: _viewKey,
  label,
  icon,
  isActive,
  onClick,
  onContextMenu,
  collapsed,
  tone = "accent",
  "data-testid": testId,
  "data-viewkey": dataViewKey,
  "data-tour-anchor": tourAnchor,
  title,
  tooltipLabel,
  trailingSlot,
  role,
  iconBadge,
}: NavItemProps) {
  const toneStyle = NAV_TONE[tone];
  const btn = collapsed ? (
    /* Collapsed — perfectly square icon button */
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      role={role}
      aria-current={isActive ? "page" : undefined}
      aria-label={title}
      title={title}
      data-testid={testId}
      data-viewkey={dataViewKey}
      data-tour-anchor={tourAnchor}
      className={[
        `relative ${RAIL_CONTROL_SIZE_CLASS} aspect-square flex items-center justify-center rounded-md transition-colors`,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? toneStyle.active
          : `text-muted-foreground ${toneStyle.hover}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="relative h-4 w-4 flex items-center justify-center">{icon}{iconBadge}</span>
    </button>
  ) : (
    /* Expanded — full-width row */
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      role={role}
      aria-current={isActive ? "page" : undefined}
      aria-label={title}
      title={title}
      data-testid={testId}
      data-viewkey={dataViewKey}
      data-tour-anchor={tourAnchor}
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? `${toneStyle.active} font-medium`
          : `text-muted-foreground ${toneStyle.hover}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="relative shrink-0 h-4 w-4 flex items-center justify-center">{icon}{iconBadge}</span>
      <span className="min-w-0 truncate flex-1 text-left">{label}</span>
      {trailingSlot && (
        <span className="ml-auto shrink-0">{trailingSlot}</span>
      )}
    </button>
  );

  if (preview) return <SidebarPreviewTrigger preview={preview} loadPreview={loadPreview}>{btn}</SidebarPreviewTrigger>;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* btn is already the collapsed square button element */}
          {btn}
        </TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel ?? title ?? label}</TooltipContent>
      </Tooltip>
    );
  }

  return btn;
}

function SidebarSurfaceRow({ surface, visible, onOpen }: {
  surface: SidebarSurface;
  visible: boolean;
  onOpen?: (tabId: string) => void;
}) {
  const { t } = useTranslation();
  const active = useActiveSurface();
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null);
  useEffect(() => {
    setFailedFavicon(null);
  }, [surface.faviconDataUrl]);
  const faviconUrl = surface.faviconDataUrl;
  const label = surface.title || surface.url || `${t(BUILTIN_LABEL_KEYS[surface.kind === "terminal" ? "terminal" : "web"])} ${surface.ordinal}`;
  const Icon = tabIcon(surface.kind);
  return (
    <NavItem
      preview={{ kind: surface.kind, title: label, ...(surface.url ? { url: surface.url } : {}) }}
      loadPreview={() => loadSidebarSurfacePreview(surface, label)}
      viewKey={surface.tabId}
      label={label}
      title={label}
      icon={surface.kind === "browser" && faviconUrl && faviconUrl !== failedFavicon
        ? <img src={faviconUrl} alt="" referrerPolicy="no-referrer" className="h-4 w-4 object-contain" onError={() => setFailedFavicon(faviconUrl)} />
        : <Icon className="h-4 w-4" />}
      isActive={visible && active?.tabId === surface.tabId}
      onClick={() => onOpen?.(surface.tabId)}
      collapsed={false}
      data-testid={`sidebar-surface-${surface.tabId}`}
    />
  );
}

// ─── NavGroup ────────────────────────────────────────────────────────────────

/** Sidebar nav groups: "features" holds the built-in views, "plugins" the installed plugin rows. */
type SidebarGroup = "plugins";

interface NavGroupProps {
  group: SidebarGroup;
  label: string;
  icon: React.ReactNode;
  /** A row inside this group is the current page — lights the trigger. */
  containsActive: boolean;
  /** Something inside this group is waiting on the user — draws the pending-answer dot. */
  attention?: boolean;
  collapsed: boolean;
  /** The rows, rendered inside the flyout; `close` dismisses it after a pick. */
  children: (close: () => void) => React.ReactNode;
}

const MENU_ROW_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * A nav group whose rows live in a FLYOUT anchored to its row and opening to
 * the right — not an accordion that pushes the list down. That is what keeps
 * the collapsed rail whole: its square icon opens the same flyout, so every
 * destination stays one click away without expanding anything. Expanded shows
 * label + chevron, collapsed the icon alone. Enter/Space open, arrows and
 * Home/End walk the rows, Esc closes, a pick navigates and closes.
 */
function NavGroup({ group, label, icon, containsActive, attention = false, collapsed, children }: NavGroupProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = `sidebar-group-${group}-menu`;
  const toneStyle = NAV_TONE.accent;
  const triggerProps = {
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    "data-testid": `sidebar-group-${group}`,
    "data-active": containsActive ? "true" : undefined,
  };
  const trigger = collapsed ? (
    <button
      {...triggerProps}
      aria-label={label}
      title={label}
      className={[
        `relative ${RAIL_CONTROL_SIZE_CLASS} aspect-square flex items-center justify-center rounded-md transition-colors`,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        containsActive ? toneStyle.active : `text-muted-foreground ${toneStyle.hover}`,
      ].join(" ")}
    >
      {containsActive && (
        <span className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="h-4 w-4 flex items-center justify-center">{icon}</span>
      {attention ? <PendingAnswerDot testId={`sidebar-group-${group}-pending-answer`} /> : null}
    </button>
  ) : (
    <button
      {...triggerProps}
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        containsActive ? `${toneStyle.active} font-medium` : `text-muted-foreground ${toneStyle.hover}`,
      ].join(" ")}
    >
      {containsActive && (
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="shrink-0 h-4 w-4 flex items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate flex-1 text-left">{label}</span>
      {attention ? <PendingAnswerDot inline testId={`sidebar-group-${group}-pending-answer`} /> : null}
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
    </button>
  );

  // Arrow keys walk the rows, wrapping; Home/End jump. Esc is Radix's own.
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!MENU_ROW_KEYS.has(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : event.key === "ArrowDown" ? (current + 1) % rows.length
      : (current - 1 + rows.length) % rows.length;
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={label}
        side="right"
        align="start"
        sideOffset={SHELL_GUTTER}
        className="w-56 p-1 space-y-0.5"
        data-testid={menuId}
        onKeyDown={onMenuKeyDown}
        // Land on the first row rather than the panel, so arrows work at once.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }}
      >
        {children(close)}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The `data-testid` a sidebar row carries for a view key.
 *
 * A view key can contain colons (`plugin-doctor:<id>`), which a testid cannot
 * carry legibly, so they flatten to dashes. Tests addressing a row have to
 * apply the same flattening; exporting it keeps the rule where the rows are
 * rendered instead of mirrored into a test helper.
 */
export function sidebarViewTestId(viewKey: string): string {
  return `sidebar-${viewKey.replace(/:/g, "-")}`;
}

/**
 * How a row that names a VIEW is opened — the click and the right-click, built
 * together so no row can offer one destination and not the other.
 *
 * Every such row is handed the same pair by the factory the Sidebar builds,
 * which is where the two destinations are decided; a row spreads them onto its
 * control and holds no opinion of its own.
 */
interface ViewRowHandlers {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Builds {@link ViewRowHandlers} for a view key. */
type ViewRowHandlerFactory = (viewKey: string) => ViewRowHandlers;

function FailedPluginNavItem({
  plugin,
  rowHandlers,
  collapsed,
  role,
}: {
  plugin: PluginCardSummary;
  rowHandlers: ViewRowHandlerFactory;
  collapsed: boolean;
  role?: "menuitem";
}) {
  const { t } = useTranslation();
  const viewKey = toPluginDoctorViewKey(plugin.id);
  const label = plugin.name || plugin.id;
  const title = t("sidebar.pluginDoctorRequiredTitle", { label });
  const IconComponent = pluginIconFor({
    icon: plugin.icon,
    iconText: plugin.iconText,
  });
  const trailingSlot = (
    <span
      className="rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-destructive"
      aria-label={t("sidebar.pluginDoctorRequiredAriaLabel")}
    >
      {t("sidebar.pluginDoctorBadge")}
    </span>
  );
  const icon = (
    <span className="relative h-4 w-4">
      <IconComponent className="h-4 w-4 text-destructive" />
      <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <Wrench className="h-2 w-2" aria-hidden="true" />
      </span>
    </span>
  );

  const renderItem = (itemIcon: ReactNode) => (
    <NavItem
      viewKey={viewKey}
      label={label}
      icon={itemIcon}
      isActive={false}
      {...rowHandlers(viewKey)}
      collapsed={collapsed}

      role={role}
      data-testid={sidebarViewTestId(viewKey)}
      data-viewkey={viewKey}
      title={title}
      tooltipLabel={title}
      trailingSlot={collapsed ? undefined : trailingSlot}
    />
  );

  return (
    <Suspense fallback={renderItem(<Wrench className="h-4 w-4 text-destructive" />)}>
      {renderItem(icon)}
    </Suspense>
  );
}

/** Disabled plugins retain a sidebar settings shortcut without failure styling or repair actions. */
function InactivePluginNavItem({
  plugin,
  rowHandlers,
  collapsed,
  role,
}: {
  plugin: PluginCardSummary;
  rowHandlers: ViewRowHandlerFactory;
  collapsed: boolean;
  role?: "menuitem";
}) {
  const { t } = useTranslation();
  const viewKey = toPluginSettingsViewKey(plugin.id);
  const label = plugin.name || plugin.id;
  const title = t("sidebar.pluginInactiveTitle", { label });
  const IconComponent = pluginIconFor({
    icon: plugin.icon,
    iconText: plugin.iconText,
  });
  const trailingSlot = (
    <span
      className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
      aria-label={t("sidebar.pluginInactiveAriaLabel")}
    >
      {t("sidebar.pluginInactiveBadge")}
    </span>
  );

  const renderItem = (itemIcon: ReactNode) => (
    <NavItem
      viewKey={viewKey}
      label={label}
      icon={itemIcon}
      isActive={false}
      {...rowHandlers(viewKey)}
      collapsed={collapsed}

      role={role}
      data-testid={sidebarViewTestId(viewKey)}
      data-viewkey={viewKey}
      title={title}
      tooltipLabel={title}
      trailingSlot={collapsed ? undefined : trailingSlot}
    />
  );

  return (
    <Suspense fallback={renderItem(<PowerOff className="h-4 w-4 text-muted-foreground" />)}>
      {renderItem(
        <span className="relative h-4 w-4">
          <IconComponent className="h-4 w-4 text-muted-foreground" />
          <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <PowerOff className="h-2 w-2" aria-hidden="true" />
          </span>
        </span>,
      )}
    </Suspense>
  );
}

function PluginNavItem({
  view,
  isActive,
  isUnauthed,
  rowHandlers,
  collapsed,
  role,
}: {
  view: PluginUiExtension;
  isActive: boolean;
  isUnauthed: boolean;
  rowHandlers: ViewRowHandlerFactory;
  collapsed: boolean;
  role?: "menuitem";
}) {
  const { t, locale } = useTranslation();
  const viewKey = toViewKey(view);
  const label = getPluginViewLabel(view, locale);
  const IconComponent = pluginIconFor({
    icon: view.icon,
    iconText: view.iconText,
  });

  const trailingSlot = isUnauthed ? (
    <span
      className="h-1.5 w-1.5 rounded-full bg-destructive"
      aria-label={t("sidebar.authRequiredAriaLabel")}
    />
  ) : null;

  return (
    <Suspense
      fallback={
        <NavItem
          viewKey={viewKey}
          label={label}
          icon={<span className="h-4 w-4" />}
          isActive={isActive}
          {...rowHandlers(viewKey)}
          collapsed={collapsed}

          role={role}
          data-testid={sidebarViewTestId(viewKey)}
          data-viewkey={viewKey}
        />
      }
    >
      <NavItem
        viewKey={viewKey}
        label={label}
        icon={<IconComponent className="h-4 w-4" />}
        isActive={isActive}
        {...rowHandlers(viewKey)}
        collapsed={collapsed}

        role={role}
        data-testid={sidebarViewTestId(viewKey)}
        data-viewkey={viewKey}
        trailingSlot={trailingSlot}
      />
    </Suspense>
  );
}

// One page of conversation rows. The lists have no upper bound, so the sidebar
// shows a page and offers the next one — revealed by scrolling in the flat
// General list, opened by a button in each project group. Neither CAPS the list,
// which is what left the remainder unreachable.
const SESSION_PAGE_SIZE = 6;

/** How far ahead of the scroller's edge the next page is prepared. */
const SESSION_REVEAL_MARGIN = "200px 0px";

/** Flat lists reveal pages at a sentinel; project groups use separate paging controls so one group cannot push all siblings
 * below the fold. */
function RevealingSessionList({
  sessions,
  renderRow,
  sentinelTestId,
  viewportRef,
}: {
  sessions: SessionSummary[];
  renderRow: (session: SessionSummary) => ReactNode;
  sentinelTestId: string;
  /** The scroller the sentinel is measured against — see the effect below. */
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const total = sessions.length;
  // The list SHRINKS under the window whenever the archive toggle hides rows again, so what is rendered is the revealed
  // count reconciled with the list that exists now — never a count carried over from a longer one.
  const shown = Math.max(SESSION_PAGE_SIZE, Math.min(visibleCount, total));
  const hasMore = shown < total;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    // Observe within the sidebar scroller and rebuild after reveal; an unchanged visible sentinel otherwise emits no new
    // intersection event.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount(Math.min(shown + SESSION_PAGE_SIZE, total));
      },
      { root: viewportRef.current, rootMargin: SESSION_REVEAL_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [total, shown, viewportRef]);

  return (
    <>
      {sessions.slice(0, shown).map(renderRow)}
      {hasMore ? <div ref={sentinelRef} aria-hidden="true" data-testid={sentinelTestId} /> : null}
    </>
  );
}

function useWorkspaceProjects(enabled: boolean): ProjectIdentity[] {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectIdentity[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.ave?.workspace?.listRoots?.().then((result) => {
      if (cancelled || !result?.ok) return;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      // fallbackName is only a safety net for a root with no resolvable basename (near-unreachable in practice) — the default
      // project is filtered out of every display surface anyway, so its exact string value is never shown.
      setProjects(workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.projectsLabel")));
    }).catch(() => {
      // Keep the localized fallback; the sidebar must remain usable without the workspace bridge.
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, t]);

  return projects;
}

/** Use sibling load and pin buttons; nested buttons are invalid and would route clicks to the outer button. */
/** What a conversation row can do to ITSELF. One object rather than eight loose props: these arrive together, they are
 * offered together in one menu, and a row that has some of them but not others would show a menu with holes in it. */
export interface ConversationRowActions {
  isArchived: (sessionId: string) => boolean;
  isUnread: (sessionId: string) => boolean;
  /** A turn is running in some tile that holds this conversation. */
  isResponding: (sessionId: string) => boolean;
  onRename: (sessionId: string, title: string) => void | Promise<void>;
  onSetArchived: (sessionId: string, archived: boolean) => void | Promise<void>;
  onSetUnread: (sessionId: string, unread: boolean) => void | Promise<void>;
  onShare: (sessionId: string) => void | Promise<void>;
  onCopy: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  /** Import a conversation. Acts on the LIST, not on any row — see the Chats tab's own context menu. */
  onImport?: () => void | Promise<void>;
}

/** What a project row can do to itself — see ConversationRowActions. */
export interface ProjectRowActions {
  isArchived: (projectRoot: string | undefined) => boolean;
  onSetArchived: (projectRoot: string) => void;
  label: (projectRoot: string | undefined) => string | undefined;
  onSetLabel: (projectRoot: string, label: string) => void;
}

/**
 * Rename in place, for whichever row is being renamed.
 *
 * One component because a conversation row and a project row rename
 * identically: the label becomes a field, Enter commits, Escape and blur
 * abandon. Two copies would be two chances for the two rows to disagree about
 * what Escape does.
 */
function InlineRename({
  initial,
  onCommit,
  onCancel,
  testId,
  t,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  testId: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      autoFocus
      value={value}
      placeholder={t("sidebar.renamePlaceholder")}
      aria-label={t("sidebar.renamePlaceholder")}
      data-testid={testId}
      className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 py-0.5 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      // Blur abandons rather than commits. A rename that lands because focus moved is a rename the user never confirmed.
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const next = value.trim();
          // An empty field is not a rename. Leave the row as it was.
          if (next) onCommit(next);
          else onCancel();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function SessionRow({
  session,
  active,
  onLoadSession,
  family = "main",
  onOpenFamilyRow,
  isPinned,
  onTogglePin,
  onOpenMenu,
  unread,
  pendingAnswer = false,
  pendingCount = 0,
  responding,
  archived,
  renaming,
  onCommitRename,
  onCancelRename,
  t,
}: {
  session: SessionSummary;
  active: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  /**
   * Which conversation family this row is. `main` is the ordinary chat row and
   * the only one with the main store's actions behind it; every other family
   * retains its accessible family label and offers exactly one thing — open.
   */
  family?: SessionFamily;
  /** Open a non-`main` row. The families differ in where that lands; the row does not. */
  onOpenFamilyRow?: () => void;
  /** Truthy when this conversation is pinned — pinned rows sort to the top and show a persistent filled pin. */
  isPinned?: boolean;
  /** Toggle this conversation's pin — omitted entirely hides the pin affordance. */
  onTogglePin?: () => void | Promise<void>;
  /** Open this row's actions menu. Wired to BOTH the right-click and the trailing entry button, so the two cannot offer
   * different things. */
  onOpenMenu?: (event: MouseEvent<HTMLElement>) => void;
  /** Marked unread — drawn as a dot plus a heavier title. */
  unread?: boolean;
  /** This conversation's turn is parked on a request, on screen or not — the yellow dot says "interrupted here, something is
   * waiting for an answer". */
  pendingAnswer?: boolean;
  /** Suggestions waiting in this conversation — drawn as a count. Only the dedicated Suggestions conversation has any. */
  pendingCount?: number;
  /** A turn is running here — the kind glyph gives way to a pulsing dot. */
  responding?: boolean;
  /** Archived — kept legible but visibly set aside. */
  archived?: boolean;
  renaming?: boolean;
  onCommitRename?: (title: string) => void;
  onCancelRename?: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const time = formatRelativeSessionTime(session.modifiedAt, t);
  const pinLabel = isPinned ? t("sidebar.unpinConversation") : t("sidebar.pinConversation");
  const familyLabel = t(SESSION_FAMILY_LABEL_KEYS[family]);
  return (
    <div
      onContextMenu={onOpenMenu}
      data-session-family={family}
      className={[
        "group relative flex w-full min-w-0 items-center rounded-md transition-colors",
        active
          ? "bg-primary/(--opacity-subtle) text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        // Archived rows stay READABLE. Dimming them to the point of illegibility would make the archive a place things go to be
        // lost, which is what delete is for.
        archived ? "opacity-70" : "",
      ].filter(Boolean).join(" ")}
      data-archived={archived ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      data-responding={responding ? "true" : undefined}
    >
      {/* ── Leading slot. One 14px square that holds the row's KIND at rest and
          its pin on hover. The two never coexist, so the row's text never
          shifts — the reason the swap happens here rather than by revealing a
          fourth control. A pinned row keeps the pin showing: the state has to
          be readable without hovering every row to find it. */}
      <span className="relative ml-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {onTogglePin ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void onTogglePin();
            }}
            className={[
              "absolute inset-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isPinned ? "flex text-primary" : "hidden group-hover:flex group-focus-within:flex",
            ].join(" ")}
            aria-label={pinLabel}
            title={pinLabel}
            aria-pressed={isPinned}
            data-testid={`sidebar-session-pin-${session.id}`}
          >
            <Pin className={`h-3 w-3 ${isPinned ? "fill-current" : ""}`} />
          </button>
        ) : null}
        {responding ? (
          /** A turn is running here. The pulse is the signal; with reduced motion the dot stands still and the label carries it. Same
           * square as the glyph, hidden the same way under the pin. */
          <span
            role="img"
            aria-label={t("sidebar.sessionResponding")}
            title={t("sidebar.sessionResponding")}
            data-testid={`sidebar-session-responding-${session.id}`}
            className={[
              "flex h-3.5 w-3.5 items-center justify-center",
              isPinned ? "invisible" : "group-hover:invisible group-focus-within:invisible",
            ].join(" ")}
          >
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
          </span>
        ) : (
          /* Family labels remain available to assistive tech. The main chat
             glyph stays hidden from it: on a list that is mostly chats, naming each
             one would read the same word down the whole column. */
          <MessageSquareText
            className={[
              "h-3.5 w-3.5",
              // Hidden — not removed. The glyph keeps reserving the square so the swap costs no layout.
              isPinned ? "invisible" : "group-hover:invisible group-focus-within:invisible",
            ].join(" ")}
            data-testid={`sidebar-conversation-glyph-${session.id}`}
            data-session-family={family}
            {...(family === "main"
              ? { "aria-hidden": "true" as const }
              : { role: "img", "aria-label": familyLabel })}
          />
        )}
      </span>
      {renaming && onCommitRename && onCancelRename ? (
        <div className="flex min-w-0 flex-1 items-center px-2 py-1">
          <InlineRename
            initial={session.title}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
            testId={`sidebar-session-rename-${session.id}`}
            t={t}
          />
        </div>
      ) : (
        <SidebarPreviewTrigger preview={{ kind: "conversation", title: session.title, message: session.preview, modifiedAt: session.modifiedAt, running: responding }}>
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`sidebar-session-${session.id}`}
          data-session-family={family}
          title={family === "main" ? undefined : familyLabel}
          onClick={() => {
            if (family !== "main") onOpenFamilyRow?.();
            else void onLoadSession?.(session.id);
          }}
          // Dragging a conversation onto a tile is how the main area is
          // arranged: the edge it lands on says whether to split that tile or
          // replace what it holds. A click still just opens it in place. Only a
          // main conversation has a tile form, so only it drags.
          draggable={family === "main"}
          onDragStart={(event) => {
            if (family !== "main") {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData(CHAT_SESSION_DRAG_TYPE, session.id);
            event.dataTransfer.effectAllowed = "copy";
          }}
        >
          {/* Unread is a dot AND weight. The dot alone would be the only
              carrier of the state, and colour alone is not a signal everyone
              receives. */}
          {unread ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              aria-hidden="true"
              data-testid={`sidebar-session-unread-${session.id}`}
            />
          ) : null}
          <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-foreground" : ""}`}>
            {session.title}
          </span>
          {pendingCount > 0 ? (
            <span
              className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums"
              aria-label={t("sidebar.suggestionsPendingCount", { count: pendingCount })}
              data-testid={`sidebar-pending-count-${session.id}`}
            >
              {pendingCount}
            </span>
          ) : pendingAnswer ? (
            <PendingAnswerDot inline testId={`sidebar-pending-answer-${session.id}`} />
          ) : null}
        </button>
        </SidebarPreviewTrigger>
      )}
      {time ? (
        <span className="shrink-0 pr-1 text-[10px] text-muted-foreground/(--opacity-intense) group-hover:hidden group-focus-within:hidden">
          {time}
        </span>
      ) : null}
      {/* ── Trailing slot: the way IN to this row's actions. Right-click already
          opens the same menu, but a right-click is undiscoverable — the button
          is what tells the user the menu exists. Both call one handler. */}
      {onOpenMenu ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(event);
          }}
          className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:flex group-focus-within:flex"
          aria-label={t("sidebar.conversationMenu")}
          title={t("sidebar.conversationMenu")}
          data-testid={`sidebar-session-menu-${session.id}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** The conversation list, exported because a chat GROUP renders the same list in its own sidebar. One list component, so
 * the window's sidebar and a group's sidebar cannot show two different pictures of the same conversations. */
function ProjectSessionList({
  sessions,
  currentSessionId,
  conversationSurfaceVisible,
  onLoadSession,
  onOpenWorkBoardItem,
  onOpenSideChat,
  onOpenPaneChat,
  onNewChatForProject,
  onRefreshProjects,
  onProjectError,
  onProjectNotice,
  projects: projectsProp,
  surfaces,
  bindingsLoaded,
  onOpenSurface,
  isSurfaceVisible,
  isSessionStarred,
  onToggleSessionStar,
  isProjectPinned,
  onToggleProjectPin,
  conversationActions,
  projectActions,
  scrollViewportRef,
  pendingAnswerSessionIds,
  suggestionsPendingCount,
  addFlow,
}: {
  /** The sidebar's add-project flow, shared with the project menu. */
  addFlow: SidebarAddFlow;
  sessions: SessionSummary[];
  currentSessionId?: string;
  onOpenWorkBoardItem?: (itemId: number) => void;
  onOpenSideChat?: (sideChatSessionId: string, originSessionId?: string) => void;
  /** Open the live terminal or page and its own chat panel. */
  onOpenPaneChat?: (tabId: string) => void;
  /**
   * Whether a CONVERSATION is what the window is showing.
   *
   * A session stays loaded while the user reads a plugin view or Settings, so
   * "which session is loaded" and "which row is the current page" are two
   * different questions. Answering them with one value put `aria-current`
   * on a chat row and on the plugin row at the same time — two rows claiming
   * to be the page the user is on.
   */
  conversationSurfaceVisible: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  onRefreshProjects?: () => void | Promise<void>;
  onProjectError?: ProjectErrorReporter;
  onProjectNotice?: (message: string) => void;
  projects?: ProjectIdentity[];
  surfaces: readonly SidebarSurface[];
  bindingsLoaded: boolean;
  onOpenSurface?: (tabId: string) => void;
  isSurfaceVisible?: (tabId: string) => boolean;
  isSessionStarred?: (sessionId: string) => string | null;
  onToggleSessionStar?: (sessionId: string, title?: string) => void | Promise<void>;
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  onToggleProjectPin?: (projectRoot: string) => void;
  conversationActions?: ConversationRowActions;
  projectActions?: ProjectRowActions;
  /** The card's scroll viewport. The Chats list reveals itself against THIS scroller, so the list has to be handed the
   * element rather than hunt for an ancestor by selector. */
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  /** See `SidebarProps.pendingAnswerSessionIds`. */
  pendingAnswerSessionIds?: ReadonlySet<string>;
  /** See `SidebarProps.suggestionsPendingCount`. */
  suggestionsPendingCount: number;
}) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  // Adding a project is the sidebar's one add flow (see `SidebarAddFlow`): the project menu and this list's right-click both
  // run it, and its adjacency warning shows here.
  const { pendingWarning, addProject, confirmAddProject, cancelPendingFolder } = addFlow;
  // The one command a right-click offers wherever there is no project row —
  // the Projects heading, its empty area, and the collapsed rail icon.
  const addProjectMenuHandlers = (): NativeContextMenuHandlers => ({
    "project.add": () => void addProject(),
  });
  // Reveal the project folder in the OS file manager (real capability: workspace.reveal).
  const revealProject = (projectRoot: string) => {
    if (!projectRoot) return;
    void window.ave?.workspace?.reveal?.(projectRoot);
  };
  // Remove a picked (non-default) project from the workspace root list (real capability: workspace.removeRoot). Refresh the
  // sidebar list on success so the removed project disappears immediately.
  const removeProject = async (project: ProjectIdentity): Promise<void> => {
    if (!project.projectRoot || project.isDefault) return;
    try {
      const result = await window.ave?.workspace?.removeRoot?.(project.projectRoot);
      if (!result?.ok) {
        onProjectError?.("remove", result?.error, result?.message);
        return;
      }
      // The user removed the project; a revocation that could not finish is reported, never asked about.
      if (result.cleanupPending) onProjectNotice?.(t("chatPreviewRail.removeRootCleanupPending"));
      await onRefreshProjects?.();
    } catch (error) {
      onProjectError?.("remove", "remove-failed", error instanceof Error ? error.message : undefined);
    }
  };
  const isSessionPinned = (sessionId: string) => Boolean(isSessionStarred?.(sessionId));
  const fallbackProjects = useWorkspaceProjects(projectsProp === undefined);
  const workspaceProjects = projectsProp ?? fallbackProjects;
  // Which row is mid-rename. One id for BOTH kinds of row: renaming two things at once is not a state the user can be in, so
  // it is not a state to model.
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Archived rows are out of the way by default and one click from being back.
  const [showArchived, setShowArchived] = useState(false);
  // Which project groups are showing all of their conversations. The project
  // section shows one page per group and the reader
  // opens the one they came for; letting every group run to its full length
  // would push the sibling projects below the fold.
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set());
  const toggleProjectSessions = (key: string) =>
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Exclude the default workspace at the display boundary. Pinned named
  // projects sort first, preserving order within each group.
  const namedProjects = useMemo(() => {
    const configured = workspaceProjects.filter((project) => !project.isDefault);
    return sortWithPinnedFirst(configured, (project) => Boolean(isProjectPinned?.(project.projectRoot)));
  }, [isProjectPinned, workspaceProjects]);
  const paneSurfaceOf = (session: SessionSummary) => session.family === "side-chat"
    ? surfaces.find((surface) => surface.tabId === session.paneTabId && surface.boundSessionIds.includes(session.id))
    : undefined;
  // The global list cannot establish that a pane ended from a window-local absence.
  // Wait for host bindings and omit unarchived pane chats not held by this window.
  const listableSessions = sessions.filter((session) => session.family !== "side-chat" || !session.paneTabId
    || (bindingsLoaded && (Boolean(session.archivedAt) || Boolean(paneSurfaceOf(session)))));
  const ordinarySessions = listableSessions.filter((session) => !paneSurfaceOf(session));
  const sessionsByProject = useMemo(
    () => namedProjects.map((project) => {
      const projectSessions = sortWithPinnedFirst(
        ordinarySessions.filter((session) => session.projectRoot && projectRootEquals(session.projectRoot, project.projectRoot)),
        (session) => isSessionPinned(session.id),
      );
      return { project, projectSessions };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isSessionPinned is derived fresh each render from isSessionStarred (a stable-enough dep); listing it would require useCallback ceremony for no behavioral benefit.
    [ordinarySessions, namedProjects, isSessionStarred],
  );
  // Display unscoped and unmatched-root sessions as plain chats; main strips legacy default-workspace metadata at the read
  // boundary.
  const ungroupedSessions = useMemo(() => {
    const plain = ordinarySessions.filter(
      (session) => !session.projectRoot || !namedProjects.some((project) => projectRootEquals(project.projectRoot, session.projectRoot)),
    );
    return sortWithPinnedFirst(plain, (session) => isSessionPinned(session.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordinarySessions, namedProjects, isSessionStarred]);

  const hasNamedProjects = sessionsByProject.length > 0;
  const projectOfSurface = (surface: SidebarSurface) => {
    const session = sessions.find((entry) => entry.id === surface.sessionId);
    return namedProjects.find((project) => session?.projectRoot && projectRootEquals(project.projectRoot, session.projectRoot));
  };
  const generalSurfaces = surfaces.filter((surface) => !projectOfSurface(surface));
  const hasUngroupedSessions = ungroupedSessions.length > 0 || generalSurfaces.length > 0;
  const renderSurfaceRow = (surface: SidebarSurface) => {
    const children = visibleSessions(listableSessions.filter((session) => paneSurfaceOf(session)?.tabId === surface.tabId));
    return (
      <div key={surface.tabId} data-testid={`sidebar-surface-tree-${surface.tabId}`}>
        <SidebarSurfaceRow surface={surface} visible={Boolean(isSurfaceVisible?.(surface.tabId))} onOpen={onOpenSurface} />
        {children.length > 0 && (
          <div className="ml-4 border-l border-border/(--opacity-half) pl-2" data-testid={`sidebar-surface-chats-${surface.tabId}`}>
            {children.map(renderFamilyRow)}
          </div>
        )}
      </div>
    );
  };

  const conversationMenuHandlers = (session: SessionSummary): NativeContextMenuHandlers => {
    const actions = conversationActions;
    const archived = actions?.isArchived(session.id) ?? false;
    const unread = actions?.isUnread(session.id) ?? false;
    return {
      "conversation.open": () => void onLoadSession?.(session.id),
      ...(actions
        ? {
            [unread ? "conversation.mark-read" : "conversation.mark-unread"]: () =>
              void actions.onSetUnread(session.id, !unread),
            // The Suggestions conversation's name comes from the catalog, so a rename would store a string no surface shows.
            ...(isSuggestionsSession(session.id)
              ? {}
              : { "conversation.rename": () => setRenamingKey(`session:${session.id}`) }),
            "conversation.share": () => void actions.onShare(session.id),
            "conversation.copy": () => void actions.onCopy(session.id),
            // Archived rows leave the list, and every unrequested card is addressed to the Suggestions conversation — archiving it
            // would hide every suggestion and its count. Main refuses it too.
            ...(isSuggestionsSession(session.id) && !archived
              ? {}
              : {
                  [archived ? "conversation.unarchive" : "conversation.archive"]: () =>
                    void actions.onSetArchived(session.id, !archived),
                }),
            "conversation.delete": () => void actions.onDelete(session.id),
          }
        : {}),
      ...(onToggleSessionStar
        ? {
            [isSessionPinned(session.id) ? "conversation.unpin" : "conversation.pin"]: () =>
              void onToggleSessionStar(session.id, session.title),
          }
        : {}),
    } as NativeContextMenuHandlers;
  };

  // Where one family's row lands when it is clicked. Every family but `main` opens the surface that already owns its
  // transcript; `main` has no entry here because it loads into the tile through `onLoadSession`.
  const openFamilyRow = (session: SessionSummary): (() => void) | undefined => {
    switch (session.family) {
      case "main":
        return undefined;
      case "routine":
        // A routine run IS a session in the main store — the routine panel opens it by loading it, and so does this row.
        return () => void onLoadSession?.(session.id);
      case "work-board":
        return session.workBoardItemId === undefined
          ? undefined
          : () => onOpenWorkBoardItem?.(session.workBoardItemId!);
      case "side-chat":
        if (paneSurfaceOf(session)) {
          return () => onOpenPaneChat?.(session.paneTabId!);
        }
        return () => onOpenSideChat?.(session.id, session.originSessionId);
    }
  };

  // A row that is not a main conversation is READ-ONLY here: it cannot be
  // renamed, archived, pinned, deleted or dragged, because those act on the
  // main session store and three of the four families do not live in it. It
  // offers the one thing it can do — open — and nothing that would misfire.
  const renderFamilyRow = (session: SessionSummary) => {
    const open = openFamilyRow(session);
    return (
      <div key={session.id}>
        <SessionRow
          session={session}
          active={false}
          family={session.family}
          pendingAnswer={pendingAnswerSessionIds?.has(session.id) ?? false}
          {...(open ? { onOpenFamilyRow: open } : {})}
          onOpenMenu={(event) => openNativeContextMenu(
            event,
            "conversation",
            (open ? { "conversation.open": open } : {}) as NativeContextMenuHandlers,
          )}
          t={t}
        />
        {bindingsLoaded && session.paneTabId && session.archivedAt && !paneSurfaceOf(session) && (
          <div className="truncate pl-7 text-[10px] text-muted-foreground">
            {t(session.paneTabId.startsWith("terminal:") ? "sidebar.formerTerminalChat" : "sidebar.formerPageChat")}
          </div>
        )}
      </div>
    );
  };

  const renderSessionRow = (listed: SessionSummary) => {
    if (listed.family !== "main") return renderFamilyRow(listed);
    // The dedicated Suggestions conversation is named from the catalog by its
    // id, in the language in use now, and carries the number of suggestions
    // waiting in it.
    const suggestions = isSuggestionsSession(listed.id);
    const session = { ...listed, title: resolveConversationTitle({ sessionId: listed.id, title: listed.title }, t) };
    return (
      <SessionRow
        key={session.id}
        session={session}
        pendingCount={suggestions ? suggestionsPendingCount : 0}
        active={conversationSurfaceVisible && session.id === currentSessionId}
        onLoadSession={onLoadSession}
        isPinned={isSessionPinned(session.id)}
        onTogglePin={onToggleSessionStar ? () => onToggleSessionStar(session.id, session.title) : undefined}
        onOpenMenu={(event) => openNativeContextMenu(event, "conversation", conversationMenuHandlers(session))}
        unread={conversationActions?.isUnread(session.id)}
        pendingAnswer={pendingAnswerSessionIds?.has(session.id) ?? false}
        responding={conversationActions?.isResponding(session.id)}
        archived={conversationActions?.isArchived(session.id)}
        renaming={renamingKey === `session:${session.id}`}
        onCommitRename={conversationActions
          ? (title) => {
              setRenamingKey(null);
              void conversationActions.onRename(session.id, title);
            }
          : undefined}
        onCancelRename={() => setRenamingKey(null)}
        t={t}
      />
    );
  };

  // Archived conversations leave the default listing. They are not deleted, so the toggle below brings them straight back —
  // the reason archive is worth having as something distinct from delete.
  const isSessionArchived = (session: SessionSummary) => Boolean(session.archivedAt) || Boolean(conversationActions?.isArchived(session.id));
  const visibleSessions = (list: SessionSummary[]) => showArchived ? list : list.filter((session) => !isSessionArchived(session));
  const hasArchivedSessions = listableSessions.some(isSessionArchived);

  // The folder's own actions, built once. The row's right-click and its trailing button both call this, so the two can never
  // offer different sets.
  const projectMenuHandlers = (project: ProjectIdentity): NativeContextMenuHandlers => {
    const root = project.projectRoot;
    const archived = Boolean(projectActions?.isArchived(root));
    return {
      // Offered while a turn runs too: the window starts the conversation beside a busy tile rather than in it, so a running
      // turn is no reason to take the folder's own first action away.
      "project.new-chat": () => void onNewChatForProject?.({
        ...(root ? { projectRoot: root } : {}),
        projectName: project.projectName,
      }),
      ...(onToggleProjectPin && root
        ? { [pinnedLabelFor(root)]: () => onToggleProjectPin(root) }
        : {}),
      ...(projectActions && root
        ? {
            "project.edit": () => setRenamingKey(`project:${root}`),
            [archived ? "project.unarchive" : "project.archive"]: () =>
              projectActions.onSetArchived(root),
          }
        : {}),
      ...(root ? { "project.reveal": () => revealProject(root) } : {}),
      // Also offered ON a row: someone hunting for "add a project" right-clicks the nearest project-looking thing.
      ...addProjectMenuHandlers(),
      ...(root && !project.isDefault
        ? { "project.remove": () => void removeProject(project) }
        : {}),
    } as NativeContextMenuHandlers;
  };
  const pinnedLabelFor = (root: string) =>
    isProjectPinned?.(root) ? "project.unpin" : "project.pin";

  // Archived FOLDERS leave the listing on the same terms archived conversations do, and answer to the same toggle — one
  // archive, one switch.
  const visibleProjects = showArchived || !projectActions
    ? sessionsByProject
    : sessionsByProject.filter(({ project }) => !projectActions.isArchived(project.projectRoot));

  return (
    <div className="min-w-0 space-y-3" data-testid="sidebar-sections">
      {/* Named projects keep their existing actions and pinned-first sessions. */}
      {/* Right-click anywhere in this section that is not a row (min-h keeps that
          blank target present even with one project) → "add project". Rows
          stop propagation once they answer, so their own menu still wins. */}
      <section
        aria-label={t("sidebar.projectsLabel")}
        className="mt-2 min-h-24 space-y-1"
        data-testid="sidebar-projects"
        onContextMenu={(event) => openNativeContextMenu(event, "project", addProjectMenuHandlers())}
      >
        <h2 className="px-2 text-[11px] font-medium text-muted-foreground" data-testid="sidebar-projects-heading">{t("sidebar.projectsLabel")}</h2>
        {pendingWarning ? (
          /** Same acknowledgement text the composer selector shows for the same `pickRoot` warning — one flow, one wording. */
          <div
            data-testid="sidebar-project-root-warning"
            className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
          >
            <div className="font-medium text-destructive">{t("composerProjectSelector.rootWarningTitle")}</div>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
              {pendingWarning.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                data-testid="sidebar-project-root-warning-confirm"
                onClick={() => void confirmAddProject()}
              >
                {t("composerProjectSelector.rootWarningConfirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="sidebar-project-root-warning-cancel"
                onClick={cancelPendingFolder}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
        {hasNamedProjects ? visibleProjects.map(({ project, projectSessions }) => {
          // Archived rows leave the list BEFORE it is paged, so a page is a page of rows the reader can actually see.
          const groupSessions = visibleSessions(projectSessions);
          const groupSurfaces = surfaces.filter((surface) => projectOfSurface(surface) === project);
          const groupKey = project.projectRoot ?? project.projectName;
          const groupExpanded = expandedProjects.has(groupKey);
          const shownGroupSessions = groupExpanded ? groupSessions : groupSessions.slice(0, SESSION_PAGE_SIZE);
          const hiddenGroupSessions = groupSessions.length - shownGroupSessions.length;
          const pinned = Boolean(isProjectPinned?.(project.projectRoot));
          const archived = Boolean(projectActions?.isArchived(project.projectRoot));
          const displayName = projectActions?.label(project.projectRoot) ?? project.projectName;
          const openProject = () => void onNewChatForProject?.({
            ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
            projectName: project.projectName,
          });
          return (
          <div key={project.projectRoot} className="space-y-1">
            {/* The folder row. Clicking it starts a chat here; the trailing
                button and the right-click open the SAME set of folder actions,
                built once below so the two entry points cannot diverge. */}
            <div
              className={[
                "group flex w-full min-w-0 items-center rounded-md transition-colors",
                "hover:bg-muted",
                archived ? "opacity-70" : "",
              ].filter(Boolean).join(" ")}
              data-archived={archived ? "true" : undefined}
              onContextMenu={(event) => openNativeContextMenu(event, "project", projectMenuHandlers(project))}
            >
              {renamingKey === `project:${project.projectRoot}` && projectActions && project.projectRoot ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1">
                  <Folder className="h-4 w-4 shrink-0 text-primary" />
                  <InlineRename
                    initial={displayName}
                    onCommit={(value) => {
                      setRenamingKey(null);
                      projectActions.onSetLabel(project.projectRoot!, value);
                    }}
                    onCancel={() => setRenamingKey(null)}
                    testId={`sidebar-project-rename-${projectTestId(project.projectRoot, project.projectName)}`}
                    t={t}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className={[
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  ].join(" ")}
                  title={project.projectRoot ?? t("sidebar.newProjectChat", { project: displayName })}
                  data-testid={`sidebar-project-${projectTestId(project.projectRoot, project.projectName)}`}
                  onClick={openProject}
                >
                  <Folder className="h-4 w-4 shrink-0 text-primary" />
                  {pinned ? <Pin className="h-3 w-3 shrink-0 fill-current text-primary" /> : null}
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                  {/* Hidden at rest, not removed — it keeps reserving its width
                      so the folder name does not re-truncate when the pointer
                      arrives. A row that reflows under the cursor is harder to
                      aim at than one that simply reveals a control. */}
                  <Plus
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground invisible group-hover:visible group-focus-within:visible"
                    aria-hidden="true"
                  />
                </button>
              )}
              {/* After the new-chat affordance, exactly as the folder's own
                  actions sit after the conversation's. */}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openNativeContextMenu(event, "project", projectMenuHandlers(project));
                }}
                className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:flex group-focus-within:flex"
                aria-label={t("sidebar.projectMenu")}
                title={t("sidebar.projectMenu")}
                data-testid={`sidebar-project-menu-${projectTestId(project.projectRoot, project.projectName)}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ml-4 border-l border-border/(--opacity-half) pl-2">
              {groupSessions.length > 0 || groupSurfaces.length > 0 ? (
                <>
                  {shownGroupSessions.map(renderSessionRow)}
                  {groupSurfaces.map(renderSurfaceRow)}
                  {/* A CONTROL, not a label: the conversations past the first
                      page are only reachable because this button opens them. */}
                  {hiddenGroupSessions > 0 || groupExpanded ? (
                    <button
                      type="button"
                      onClick={() => toggleProjectSessions(groupKey)}
                      className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={groupExpanded}
                      data-testid={`sidebar-project-sessions-more-${projectTestId(project.projectRoot, project.projectName)}`}
                    >
                      {groupExpanded
                        ? t("sidebar.fewerSessions")
                        : t("sidebar.moreSessions", { count: hiddenGroupSessions })}
                    </button>
                  ) : null}
                </>
              ) : (
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  {t("sidebar.noProjectSessions")}
                </div>
              )}
            </div>
          </div>
          );
        }) : (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("sidebar.noProjectSessions")}
          </div>
        )}
      </section>
      {/* Unassigned items remain flat under General. */}
      {/* Right-click the LIST itself (not a row) → import. Importing always
          creates a brand-new conversation, so it acts on the list; putting it
          on a row would imply it acts on that row. Rows stop propagation once
          they answer, so their own menu still wins. */}
      <section
        aria-label={t("sidebar.generalLabel")}
        className="mt-2 min-h-24 space-y-1"
        data-testid="sidebar-unassigned-sessions"
        onContextMenu={(event) => openNativeContextMenu(event, "conversation", {
          ...(conversationActions?.onImport
            ? { "conversation.import": () => void conversationActions.onImport!() }
            : {}),
        } as NativeContextMenuHandlers)}
      >
        <h2 className="px-2 text-[11px] font-medium text-muted-foreground">{t("sidebar.generalLabel")}</h2>
        {hasUngroupedSessions || hasArchivedSessions ? (
          <>
            <RevealingSessionList
              sessions={visibleSessions(ungroupedSessions)}
              renderRow={renderSessionRow}
              sentinelTestId="sidebar-unassigned-sessions-sentinel"
              viewportRef={scrollViewportRef}
            />
            {generalSurfaces.map(renderSurfaceRow)}
            {/* Offered only once something IS archived. A permanent toggle for
                an empty archive is a control that never does anything. */}
            {hasArchivedSessions ? (
              <button
                type="button"
                onClick={() => setShowArchived((value) => !value)}
                className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-pressed={showArchived}
                data-testid="sidebar-toggle-archived"
              >
                {showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
              </button>
            ) : null}
          </>
        ) : (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("sidebar.noProjectSessions")}
          </div>
        )}
      </section>

    </div>
  );
}

// Keep route navigation in the sidebar cluster and conversation mutations in pane headers; cluster placement stays fixed
// across collapse.
/** Whether something recorded against `root` belongs to `selected`. The 기본 프로젝트 also holds what names no open project:
 * a conversation without a root, or one whose project was removed. */
function belongsToProject(root: string | undefined, selected: ProjectIdentity, projects: readonly ProjectIdentity[]): boolean {
  if (!selected.isDefault) return Boolean(root) && projectRootEquals(root, selected.projectRoot);
  if (!root || projectRootEquals(root, selected.projectRoot)) return true;
  return !projects.some((project) => !project.isDefault && projectRootEquals(project.projectRoot, root));
}

export function Sidebar({
  activeView,
  onSelect,
  onSelectInNewPane,
  pluginViews,
  failedPluginCards = [],
  inactivePluginCards = [],
  pluginAuthStatuses,
  subscriptionRuntimePolicy,
  hasApiKey,
  onOpenSettings,
  subscriptionUnavailable = false,
  subscriptionPending = false,
  modelConfigured = null,
  projectSelection,
  selectedProject,
  recentProjectRoots = [],
  projectName,
  onSelectProjectRoot,
  onSelectAllProjects,
  onProjectAdded,
  onLaunch,
  onNewChatForProject,
  collapsed,
  overlay = false,
  onToggleCollapse,
  width = SIDEBAR_DEFAULT_WIDTH,
  maxWidth,
  onWidthChange,
  onWidthCommit,
  onOpenUnifiedSearch,
  sessions = [],
  projects,
  currentSessionId,
  onLoadSession,
  onOpenWorkBoardItem,
  onOpenSideChat,
  onOpenPaneChat,
  onRefreshProjects,
  onProjectError,
  onProjectNotice,
  mainSurfaces = [],
  browserTabs,
  chatGroupIds = [],
  onOpenSurface,
  isSurfaceVisible,
  isSessionStarred,
  onToggleSessionStar,
  conversationActions,
  projectActions,
  isProjectPinned,
  onToggleProjectPin,
  pendingAnswerSessionIds,
  pluginRequestPending = false,
  suggestionsPendingCount = 0,
}: SidebarProps) {
  const { t } = useTranslation();
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const { surfaces, bindingsLoaded } = useSidebarItems(mainSurfaces, chatGroupIds, browserTabs, sessionIds);
  const allProjects = projectSelection?.kind === "all";
  const allProjectList = useMemo(() => projects ?? [], [projects]);
  // The list shows the selected project only; the all-projects view shows every project, grouped (case 05, 10).
  const scoped = useMemo(() => {
    if (!selectedProject) return { sessions, projects: allProjectList, surfaces };
    const sessionRoot = new Map(sessions.map((session) => [session.id, session.projectRoot]));
    const inProject = (root: string | undefined) => belongsToProject(root, selectedProject, allProjectList);
    return {
      sessions: sessions.filter((session) => inProject(session.projectRoot)),
      projects: [selectedProject],
      surfaces: surfaces.filter((surface) =>
        inProject(surface.projectRoot ?? (surface.sessionId ? sessionRoot.get(surface.sessionId) : undefined))),
    };
  }, [selectedProject, sessions, allProjectList, surfaces]);
  // Nothing is named until the selection has loaded: "전체 프로젝트" before then would claim a choice nobody made.
  const shownName = selectedProject ? projectName(selectedProject) : allProjects ? t("sidebar.allProjects") : "";
  const resizable = !collapsed && Boolean(onWidthChange && onWidthCommit);
  // Card element ref — EdgeResizeBar applies the live drag width directly to this node's style (rAF-coalesced) so dragging
  // never re-renders the whole Sidebar tree, mirroring ChatSidePanel's drag-perf pattern.
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Folding animates the card width; an active resize drag must not. `isResizing` (true only between a drag's first move and
  // its commit) is the single gate that suppresses the transition for the drag path alone.
  const [isResizing, setIsResizing] = useState(false);
  const openRowMenu = useNativeContextMenu();
  /** Expose focused-pane and new-pane actions together; settings shortcuts have no independent view to open in another pane. */
  const viewRowHandlers = useCallback((
    viewKey: string,
    { open, after, newPane = true }: {
      open?: () => void;
      after?: () => void;
      newPane?: boolean;
    } = {},
  ): ViewRowHandlers => {
    const openHere = () => {
      if (open) open();
      else onSelect(viewKey);
      after?.();
    };
    // Absent on a narrow canvas, where there is no second pane to open into. The chord and the menu row go with it, together.
    const openBeside = newPane && onSelectInNewPane
      ? () => {
        onSelectInNewPane(viewKey);
        after?.();
      }
      : undefined;
    return {
      onClick: (event) => {
        if (openBeside && (event.metaKey || event.ctrlKey)) {
          openBeside();
          return;
        }
        openHere();
      },
      onContextMenu: (event) => {
        openRowMenu(event, "view-row", {
          "view.open": openHere,
          ...(openBeside ? { "view.open-in-new-pane": openBeside } : {}),
        });
      },
    };
  }, [onSelect, onSelectInNewPane, openRowMenu]);
  const handleWidthChange = useCallback(
    (px: number) => {
      setIsResizing(true);
      onWidthChange?.(px);
    },
    [onWidthChange],
  );
  const handleWidthCommit = useCallback(
    (px: number) => {
      setIsResizing(false);
      onWidthCommit?.(px);
    },
    [onWidthCommit],
  );

  const hasPluginEntries = pluginViews.length > 0
    || failedPluginCards.length > 0
    || inactivePluginCards.length > 0;
  const pluginsContainActive =
    pluginViews.some((view) => toViewKey(view) === activeView)
    || failedPluginCards.some((plugin) => toPluginDoctorViewKey(plugin.id) === activeView)
    || inactivePluginCards.some((plugin) => toPluginSettingsViewKey(plugin.id) === activeView);

  // ── The project menu (case 02) opens from the rail's project button or the list header's name: one menu, one opener at a
  // time. The launcher picker (case 06) opens from a launcher in the all-projects view.
  const [menuFrom, setMenuFrom] = useState<"rail" | "header" | null>(null);
  // 새 프로젝트 추가 (case 07–09) is one flow for the menu and the list: the OS folder dialog through `useAddProjectFolder`, an
  // adjacency warning answered in the list, then a switch to the project. A refused add is reported, because the dialog
  // closing looks the same whether the folder was added or refused; a cancel is the user's own decision and says nothing.
  const { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder } = useAddProjectFolder();
  const projectsRef = useRef(allProjectList);
  projectsRef.current = allProjectList;
  const applyAddOutcome = useCallback(async (outcome: AddProjectFolderOutcome): Promise<void> => {
    if (outcome.status === "failed") {
      onProjectError?.("add", outcome.error);
      return;
    }
    // The warning is answered in the list, so a folded list unfolds to show it.
    if (outcome.status === "needs-acknowledgement") {
      if (collapsed) onToggleCollapse();
      return;
    }
    if (outcome.status !== "added") return;
    const root = outcome.added ?? outcome.roots.find((each) => !each.isDefault)?.path;
    const alreadyOpen = root !== undefined && projectsRef.current.some((project) => projectRootEquals(project.projectRoot, root));
    await onRefreshProjects?.();
    if (root) onProjectAdded(root, alreadyOpen);
  }, [collapsed, onToggleCollapse, onProjectAdded, onProjectError, onRefreshProjects]);
  const addFlow = useMemo<SidebarAddFlow>(() => ({
    pendingWarning,
    addProject: async () => applyAddOutcome(await addFolder()),
    confirmAddProject: async () => applyAddOutcome(await confirmPendingFolder()),
    cancelPendingFolder,
  }), [pendingWarning, applyAddOutcome, addFolder, confirmPendingFolder, cancelPendingFolder]);
  const [pickerFor, setPickerFor] = useState<SidebarLaunchKind | null>(null);
  const menuModel = useMemo<ProjectMenuModel>(() => ({
    projects: allProjectList,
    selection: projectSelection,
    recentProjectRoots,
    projectName,
    isProjectPinned,
    onSelectRoot: onSelectProjectRoot,
    onSelectAll: onSelectAllProjects,
    onAddProject: () => void addFlow.addProject(),
  }), [allProjectList, projectSelection, recentProjectRoots, projectName, isProjectPinned, onSelectProjectRoot, onSelectAllProjects, addFlow]);
  const menuOpenChange = (from: "rail" | "header") => (open: boolean) => setMenuFrom(open ? from : null);
  const launchLabel = (kind: SidebarLaunchKind) => kind === "chat"
    ? t("mainToolbar.newChat")
    : t(kind === "web" ? "sidebar.newWeb" : "sidebar.newTerminal");
  const launcher = (kind: SidebarLaunchKind, icon: ReactNode, testId: string) => {
    const label = launchLabel(kind);
    const plus = allProjects ? null : <Plus className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 rounded-full bg-card" aria-hidden="true" />;
    return (
      <ProjectPicker
        key={kind}
        model={menuModel}
        launchLabel={label}
        open={pickerFor === kind}
        onOpenChange={(open) => {
          // Viewing one project, a launcher opens there without asking; only the all-projects view asks where (case 06).
          if (open && !allProjects) {
            onLaunch(kind, selectedProject);
            return;
          }
          setPickerFor(open ? kind : null);
        }}
        onPick={(project) => onLaunch(kind, project)}
      >
        <RailButton
          label={selectedProject
            ? t("sidebar.railOpensIn", { label, project: shownName })
            : t("sidebar.railChooseProject", { label })}
          icon={icon}
          badge={plus}
          data-testid={testId}
        />
      </ProjectPicker>
    );
  };
  const railView = (viewKey: "work-board" | "routines" | "memory" | "insights", testId: string, Icon: typeof WorkBoardIcon, current: boolean) => {
    const handlers = viewRowHandlers(viewKey);
    return (
      <RailButton
        key={viewKey}
        label={t("sidebar.railView", { label: t(BUILTIN_LABEL_KEYS[viewKey]), project: shownName })}
        icon={<Icon className="h-4 w-4" />}
        current={current}
        onClick={handlers.onClick}
        onContextMenu={handlers.onContextMenu}
        data-testid={testId}
        data-viewkey={viewKey}
      />
    );
  };

  // Overlay dismissal uses the shell toggle; listeners read the latest callback through a ref. Only the list overlays (case
  // 28): the rail stays where it is, outside the trap.
  const onToggleCollapseRef = useRef(onToggleCollapse);
  onToggleCollapseRef.current = onToggleCollapse;
  const overlayOpen = overlay && !collapsed;
  const renderedWidth = overlayOpen ? Math.min(width, maxWidth ?? width) : width;
  useEffect(() => {
    if (!overlayOpen) return;
    const card = cardRef.current;
    if (!card) return;
    card.focus({ preventScroll: true });
    // Captured now: when the list folds, the card is gone from the document by the time this effect is cleaned up.
    const shell = card.closest<HTMLElement>('[data-testid="app-shell"]');
    const collapse = () => onToggleCollapseRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      // A portaled menu or dialog manages its own keyboard scope above this navigation surface.
      if (active instanceof HTMLElement && !card.contains(active)
        && active.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      if (event.key === "Tab") {
        const controls = [...card.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]')]
          .filter((element) => {
            if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]')
              || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
            for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === "none" || style.visibility === "hidden") return false;
              if (parent === card) break;
            }
            return true;
          });
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          card.focus({ preventScroll: true });
        } else if (!card.contains(active) || active === card
          || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
        return;
      }
      if (event.key !== "Escape") return;
      // An editor inside the card (rename, search) owns its own Escape.
      const target = event.target;
      if (target instanceof HTMLElement && card.contains(target) && target.closest("input, textarea, [contenteditable=true]")) return;
      collapse();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || card.contains(target)) return;
      // Portaled surfaces (menus, dialogs, tooltips) mount outside the shell column; a pick inside one is not a click beside the
      // card.
      if (!shell?.contains(target)) return;
      collapse();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      // Hand focus to the band's unfold button only when the card had it (or dropped it to the body as its rows unmounted). A
      // mode flip that leaves the card open as a pushed sibling keeps focus where the user put it.
      const active = document.activeElement;
      const cardHadFocus = !active || active === document.body || card.contains(active);
      // The band's unfold button is already in the document: effects are cleaned up after the folded state commits.
      if (!cardHadFocus || !shell?.isConnected) return;
      shell.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse-toggle"]')?.focus({ preventScroll: true });
    };
  }, [overlayOpen]);
  // Subscription readiness is distinct from API-key presence: when a login runtime is selected, never describe its
  // verification state as an API-key problem or invite the user to configure an unrelated credential.
  const runtimeUnavailable = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatUnavailable : subscriptionUnavailable;
  const runtimePending = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatPending : subscriptionPending;
  const settingsNeedsApiKey = hasApiKey === false && !runtimeUnavailable && !runtimePending;
  const settingsHandlers = viewRowHandlers("settings", { open: onOpenSettings });
  const settingsLabel = t(BUILTIN_LABEL_KEYS.settings);
  const settingsNote = runtimePending
    ? t("subscriptionProvidersSection.statusChecking")
    : runtimeUnavailable
      ? t("formatIpcError.subscriptionChatUnavailable")
      : settingsNeedsApiKey ? t("mainToolbar.apiKeyRequired") : undefined;
  // On darwin the OS traffic lights sit over the top-left corner, so the rail and the list start below the band there.
  const darwin = isDarwinPlatform();
  const homeChord = darwin ? "⌘0" : "Ctrl+0";

  // The scroller the conversation list reveals itself against, handed down rather than looked up: the list is inside this
  // viewport by construction.
  const navScrollViewportRef = useRef<HTMLDivElement | null>(null);

  const rail = (
    <Rail
      project={(
        <ProjectMenu model={menuModel} open={menuFrom === "rail"} onOpenChange={menuOpenChange("rail")} side="right">
          <RailButton
            label={t("sidebar.railProjectButton", { project: shownName })}
            icon={<ProjectMark project={selectedProject} name={shownName} size="md" />}
            aria-haspopup="dialog"
            data-testid="sidebar-project-button"
            className="h-10 w-10"
          />
        </ProjectMenu>
      )}
      launchers={(
        <>
          {launcher("chat", <MessageSquarePlus className="h-4 w-4" />, "sidebar-new-chat")}
          {launcher("web", <WebViewIcon className="h-4 w-4" />, "sidebar-web")}
          {launcher("terminal", <TerminalViewIcon className="h-4 w-4" />, "sidebar-terminal")}
        </>
      )}
      views={(
        <>
          {railView("work-board", "toolbar-work-board", WorkBoardIcon, activeView === "work-board")}
          {railView("routines", "sidebar-routines", RoutinesIcon, activeView === "routines")}
          {railView("memory", "sidebar-memory", MemoryIcon, activeView === "memory")}
          {railView("insights", "sidebar-starred", InsightsIcon, activeView === "insights" || activeView === "starred")}
          {/* Extensions keep their flyout until they get a launcher of their own (S4). */}
          {hasPluginEntries ? (
            <NavGroup
              group="plugins"
              label={t("sidebar.pluginsLabel")}
              icon={<Blocks className="h-4 w-4" />}
              containsActive={pluginsContainActive}
              attention={pluginRequestPending}
              collapsed
            >
              {(close) => {
                const pick: ViewRowHandlerFactory = (viewKey) =>
                  viewRowHandlers(viewKey, { after: close });
                // A Doctor or switched-off row names a settings PAGE, not a view, so it offers only the one destination.
                const pickShortcut: ViewRowHandlerFactory = (viewKey) =>
                  viewRowHandlers(viewKey, { after: close, newPane: false });
                return (
                  <>
                    {pluginViews.map((view) => {
                      const viewKey = toViewKey(view);
                      const isUnauthed =
                        view.extension !== undefined &&
                        pluginAuthStatuses?.get(view.pluginId)?.kind === "unauthed";
                      return (
                        <PluginNavItem
                          key={viewKey}
                          view={view}
                          isActive={activeView === viewKey}
                          isUnauthed={Boolean(isUnauthed)}
                          rowHandlers={pick}
                          collapsed={false}
                          role="menuitem"
                        />
                      );
                    })}
                    {failedPluginCards.map((plugin) => (
                      <FailedPluginNavItem
                        key={`doctor:${plugin.id}`}
                        plugin={plugin}
                        rowHandlers={pickShortcut}
                        collapsed={false}
                        role="menuitem"
                      />
                    ))}
                    {inactivePluginCards.map((plugin) => (
                      <InactivePluginNavItem
                        key={`inactive:${plugin.id}`}
                        plugin={plugin}
                        rowHandlers={pickShortcut}
                        collapsed={false}
                        role="menuitem"
                      />
                    ))}
                  </>
                );
              }}
            </NavGroup>
          ) : null}
        </>
      )}
      footer={(
        <>
          <RailButton
            label={t("mainToolbar.unifiedSearch")}
            icon={<Search className="h-4 w-4" />}
            onClick={onOpenUnifiedSearch}
            data-testid="sidebar-search"
            data-tour-anchor="chat-history"
          />
          <RailButton
            label={settingsNote ? `${settingsLabel} · ${settingsNote}` : settingsLabel}
            icon={<SettingsIcon className={settingsNeedsApiKey || runtimeUnavailable ? "h-4 w-4 text-destructive" : "h-4 w-4"} />}
            current={activeView === "settings"}
            onClick={settingsHandlers.onClick}
            onContextMenu={settingsHandlers.onContextMenu}
            data-testid="sidebar-settings"
            data-tour-anchor="settings-entry"
            badge={modelConfigured === false ? (
              <span
                role="img"
                data-testid="sidebar-settings-alert"
                aria-label={t("sidebar.settingsAlertNoModel")}
                title={t("sidebar.settingsAlertNoModel")}
                className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive"
              />
            ) : undefined}
          />
        </>
      )}
    />
  );

  return (
    <SidebarPreviewProvider>
    <aside
      data-testid="primary-sidebar"
      data-sidebar-overlay={overlayOpen ? "true" : undefined}
      role="navigation"
      aria-label={t("sidebar.ariaLabel")}
      className={[
        // The rail and the list are two cards side by side, one gutter apart, on the same `--shell-card-inset*` lines the docked
        // side panel uses.
        "absolute left-(--shell-card-inset) bottom-(--shell-card-inset-bottom) flex min-h-0 gap-(--chrome-gap)",
        // Pushed, the cards sit under the docked panels' band; an overlaying list is the floating surface of the moment and must
        // cover everything the tile draws.
        overlayOpen ? "z-50" : "z-30",
        darwin ? "top-(--chrome-band-height)" : "top-(--shell-card-top)",
      ].join(" ")}
      // The aside overlays the Electron drag band. Mark it no-drag so its controls stay clickable.
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {rail}
      {collapsed ? null : (
      <div
        ref={cardRef}
        data-testid="sidebar-card"
        data-surface="card"
        data-sidebar-preview-boundary
        // Overlaying, the card receives focus when it opens (see the overlay effect) — programmatically only, never in the Tab
        // order.
        tabIndex={overlayOpen ? -1 : undefined}
        className={[
          "ave-surface-raised relative flex min-h-0 flex-col overflow-hidden rounded-2xl bg-card outline-none motion-reduce:transition-none",
          isResizing ? "" : "transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-out)]",
        ].join(" ")}
        style={{
          width: `${renderedWidth}px`,
          maxWidth: overlayOpen ? maxWidth ?? `calc(100vw - ${SHELL_GUTTER * 2}px)` : undefined,
        }}
      >
        {resizable ? (
          <EdgeResizeBar
            width={renderedWidth}
            edge="end"
            variant="inset"
            onWidthChange={handleWidthChange}
            onWidthCommit={handleWidthCommit}
            min={SIDEBAR_MIN_WIDTH}
            max={overlayOpen ? Math.min(SIDEBAR_MAX_WIDTH, maxWidth ?? SIDEBAR_MAX_WIDTH) : SIDEBAR_MAX_WIDTH}
            resetWidth={SIDEBAR_DEFAULT_WIDTH}
            applyElementRef={cardRef}
            ariaLabel={t("sidebar.resizeHandleAriaLabel")}
            data-testid="sidebar-resize-handle"
          />
        ) : null}
        {/* ── List header (case 04): the project name opens the same menu as the rail button; the right button folds the list. */}
        <div className="flex h-(--chrome-control-height) shrink-0 items-center gap-1 px-2 pt-2" data-testid="sidebar-list-header">
          <ProjectMenu model={menuModel} open={menuFrom === "header"} onOpenChange={menuOpenChange("header")} side="bottom">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={t("sidebar.projectHeaderButton", { project: shownName })}
              title={selectedProject ? `${shownName} · ${selectedProject.projectRoot}` : shownName}
              data-testid="sidebar-project-header"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ProjectMark project={selectedProject} name={shownName} />
              <span className="min-w-0 truncate">{shownName}</span>
              {selectedProject?.isDefault ? (
                <span className="shrink-0 rounded border border-border px-1 text-[10px] font-normal text-muted-foreground">{t("sidebar.defaultBadge")}</span>
              ) : null}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </ProjectMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-(--chrome-icon-button) w-(--chrome-icon-button) aspect-square shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onClick={onToggleCollapse}
                title={t("mainToolbar.collapseSidebar")}
                aria-label={t("mainToolbar.collapseSidebar")}
                aria-pressed
                data-testid="sidebar-collapse-toggle"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("mainToolbar.collapseSidebar")}</TooltipContent>
          </Tooltip>
        </div>
        {/* ── The project home row: pinned first, current only while the home is what the window shows. */}
        <div className="px-2 pt-1.5 pb-1">
          <button
            type="button"
            onClick={() => onSelect("project-home")}
            aria-current={activeView === "project-home" ? "page" : undefined}
            aria-keyshortcuts={darwin ? "Meta+0" : "Control+0"}
            data-testid="sidebar-project-home"
            className={[
              "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeView === "project-home" ? "bg-primary/(--opacity-subtle) font-medium text-primary" : "hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            <House className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{t("sidebar.projectHomeRow", { name: shownName })}</span>
            <kbd className="shrink-0 text-[11px] font-normal text-muted-foreground">{homeChord}</kbd>
          </button>
        </div>
        <div className="mx-2 h-px shrink-0 bg-border" aria-hidden="true" />
        {/* Radix ScrollArea wraps viewport content in a `display: table` div, which sizes to max-content — long unbreakable
            titles then blow the content wider than the card and get HARD-clipped by the viewport, so row-level `truncate` never
            produces its ellipsis. Force that wrapper back to block so width is bounded and `…` can kick in. */}
        <ScrollArea
          viewportRef={navScrollViewportRef}
          className="flex-1 min-h-0 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0"
        >
          <div className="px-2 pt-1 pb-1 space-y-0.5">
            <ProjectSessionList
              sessions={scoped.sessions}
              projects={scoped.projects}
              currentSessionId={currentSessionId}
              conversationSurfaceVisible={activeView === "home"}
              onLoadSession={onLoadSession}
              onOpenWorkBoardItem={onOpenWorkBoardItem}
              onOpenSideChat={onOpenSideChat}
              onOpenPaneChat={onOpenPaneChat}
              onNewChatForProject={onNewChatForProject}
              onRefreshProjects={onRefreshProjects}
              onProjectError={onProjectError}
              onProjectNotice={onProjectNotice}
              surfaces={scoped.surfaces}
              bindingsLoaded={bindingsLoaded}
              onOpenSurface={onOpenSurface}
              isSurfaceVisible={isSurfaceVisible}
              isSessionStarred={isSessionStarred}
              onToggleSessionStar={onToggleSessionStar}
              isProjectPinned={isProjectPinned}
              onToggleProjectPin={onToggleProjectPin}
              conversationActions={conversationActions}
              projectActions={projectActions}
              pendingAnswerSessionIds={pendingAnswerSessionIds}
              suggestionsPendingCount={suggestionsPendingCount}
              scrollViewportRef={navScrollViewportRef}
              addFlow={addFlow}
            />
          </div>
        </ScrollArea>
      </div>
      )}
    </aside>
    </SidebarPreviewProvider>
  );
}
