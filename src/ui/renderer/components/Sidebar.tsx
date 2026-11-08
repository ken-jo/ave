import { SidebarPreviewProvider, SidebarPreviewTrigger, type SidebarPreviewData } from "./SidebarPreview.js";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import { AgentStatusGlyph } from "./AgentStatusGlyph.js";
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  House,
  MessageSquarePlus,
  PanelLeftClose,
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
import { useSidebarItems } from "../hooks/use-sidebar-items.js";
import type { MainSurface } from "../preview/main-surfaces.js";
import type { BrowserTabsApi } from "../../../shared/browser-surface.js";
import type { SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import { useNativeContextMenu } from "../hooks/use-native-context-menu.js";
import {
  useAddProjectFolder,
  type AddProjectFolderOutcome,
  type ProjectErrorReporter,
} from "../hooks/use-add-project-folder.js";
import { RAIL_CONTROL_SIZE_CLASS, SHELL_GUTTER } from "../../../shared/shell-geometry.js";
import { Rail, RailButton } from "./sidebar/Rail.js";
import { ProjectMark, ProjectMenu, type ProjectMenuModel } from "./sidebar/ProjectMenu.js";
import { ProjectPicker } from "./sidebar/ProjectPicker.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ProjectTree, type ConversationRowActions, type ProjectRowActions, type SidebarAddFlow } from "./sidebar/ProjectTree.js";
import type { InlineViewKey } from "../../../shared/view-key.js";
import type { PluginCardSummary, PluginUiExtension } from "../types.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity, ProjectSelection } from "../../../shared/project-identity.js";
import { projectRootEquals } from "../../../shared/project-identity.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../../shared/side-panel.js";

// A nav row draws the same glyph the pane header draws for the view it opens — one map, so a row and the header it
// produces cannot disagree.
const WorkBoardIcon = BUILTIN_VIEW_ICONS["work-board"];
const RoutinesIcon = BUILTIN_VIEW_ICONS.routines;
const InsightsIcon = BUILTIN_VIEW_ICONS.insights;
const SettingsIcon = BUILTIN_VIEW_ICONS.settings;
const MemoryIcon = BUILTIN_VIEW_ICONS.memory;
const TerminalViewIcon = BUILTIN_VIEW_ICONS.terminal;
const WebViewIcon = BUILTIN_VIEW_ICONS.web;
const FolderViewIcon = BUILTIN_VIEW_ICONS.folder;

/** What the rail's launchers open. */
export type SidebarLaunchKind = "chat" | "web" | "terminal" | "folder";

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
  /** Open a new chat, web page or terminal in `project` (case 11–13). The rail asks which project in the all-projects view,
   * and launches nothing before the selection has loaded. */
  onLaunch: (kind: SidebarLaunchKind, project: ProjectIdentity) => void;
  /** The project list could not be read, so no project is known: the launchers say so and retry the list instead of opening. */
  projectListUnavailable?: boolean;
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
  /** 프로젝트 제거 (case 29): the app previews, confirms when something would be lost (case 31), and removes. */
  onRemoveProject: (project: ProjectIdentity) => void;
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
  /** Whether an all-projects group is open (case 05). */
  isProjectExpanded: (root: string) => boolean;
  onSetProjectExpanded: (root: string, expanded: boolean) => void;
  /** 옆에 분할로 열기 for a conversation row (case 20). */
  onOpenSessionBeside?: (sessionId: string) => void;
  /** 옆에 분할로 열기 for a terminal or page row. */
  onOpenSurfaceBeside?: (tabId: string) => void;
  /** Close a terminal or page in the main area from its row. */
  onCloseSurface?: (tabId: string) => void;
  /** Move a terminal or page in the main area to another open project. */
  onMoveSurface?: (tabId: string, projectRoot: string) => void;
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
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body-sm transition-colors",
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
      <AgentStatusGlyph
        size="md"
        mark={icon}
        working={false}
        badge={attention ? "waiting" : null}
        badgeTestId={`sidebar-group-${group}-pending-answer`}
      />
    </button>
  ) : (
    <button
      {...triggerProps}
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        containsActive ? `${toneStyle.active} font-medium` : `text-muted-foreground ${toneStyle.hover}`,
      ].join(" ")}
    >
      {containsActive && (
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <AgentStatusGlyph
        size="md"
        mark={icon}
        working={false}
        badge={attention ? "waiting" : null}
        badgeTestId={`sidebar-group-${group}-pending-answer`}
      />
      <span className="min-w-0 truncate flex-1 text-left">{label}</span>
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
      className="rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-tiny font-medium text-destructive"
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
      className="rounded-full bg-muted px-1.5 py-px text-tiny font-medium text-muted-foreground"
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
  onRemoveProject,
  projectListUnavailable = false,
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
  isProjectExpanded,
  onSetProjectExpanded,
  onOpenSessionBeside,
  onOpenSurfaceBeside,
  onCloseSurface,
  onMoveSurface,
  pendingAnswerSessionIds,
  pluginRequestPending = false,
  suggestionsPendingCount = 0,
}: SidebarProps) {
  const { t } = useTranslation();
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const { surfaces, bindingsLoaded } = useSidebarItems(mainSurfaces, chatGroupIds, browserTabs, sessionIds);
  const allProjects = projectSelection?.kind === "all";
  const allProjectList = useMemo(() => projects ?? [], [projects]);
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
    const root = outcome.added;
    const alreadyOpen = projectsRef.current.some((project) => projectRootEquals(project.projectRoot, root));
    await onRefreshProjects?.();
    onProjectAdded(root, alreadyOpen);
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
    : kind === "folder" ? t("folderView.newFolderView")
      : t(kind === "web" ? "sidebar.newWeb" : "sidebar.newTerminal");
  const listUnavailable = !selectedProject && !allProjects && projectListUnavailable;
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
          if (open && selectedProject) {
            onLaunch(kind, selectedProject);
            return;
          }
          // No project is known because the list failed: the launcher retries the list and opens nothing.
          if (open && listUnavailable) {
            void onRefreshProjects?.();
            return;
          }
          if (open && !allProjects) return;
          setPickerFor(open ? kind : null);
        }}
        onPick={(project) => onLaunch(kind, project)}
      >
        <RailButton
          label={selectedProject
            ? t("sidebar.railOpensIn", { label, project: shownName })
            : allProjects
              ? t("sidebar.railChooseProject", { label })
              : listUnavailable ? t("sidebar.railProjectsUnavailable", { label }) : label}
          icon={icon}
          badge={plus}
          // Until the selection has loaded there is no project to open in, and nothing opens without one. A failed list keeps
          // the button live as its retry.
          disabled={!selectedProject && !allProjects && !listUnavailable}
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
          {launcher("folder", <FolderViewIcon className="h-4 w-4" />, "sidebar-folder")}
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
        darwin ? "top-(--shell-card-top-darwin)" : "top-(--shell-card-top)",
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
          "ave-glass-tint ave-surface-raised relative flex min-h-0 flex-col overflow-hidden rounded-(--shell-card-radius) bg-card outline-none motion-reduce:transition-none",
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
        <div className="flex h-(--chrome-band-height) shrink-0 items-center gap-1 px-2" data-testid="sidebar-list-header">
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
                <span className="shrink-0 rounded border border-border px-1 text-tiny font-normal text-muted-foreground">{t("sidebar.defaultBadge")}</span>
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
              "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeView === "project-home" ? "bg-primary/(--opacity-subtle) font-medium text-primary" : "hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            <House className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{t("sidebar.projectHomeRow", { name: shownName })}</span>
            <kbd className="shrink-0 text-dense font-normal text-muted-foreground">{homeChord}</kbd>
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
          <div className="px-2 pt-1 pb-1">
            {/* Nothing is listed until the selection has loaded: the all-projects groups before then would show a view
                nobody chose. */}
            {selectedProject || allProjects ? (
              // A row that fails to render takes only the tree down, not the rail, the launchers or the work board.
              <ErrorBoundary compact boundaryName="sidebar-project-tree" fallback={t("sidebar.treeRenderError")} fallbackTestId="sidebar-tree-error">
                <ProjectTree
                  selectedProject={selectedProject}
                  projects={allProjectList}
                  projectName={projectName}
                  isProjectExpanded={isProjectExpanded}
                  onSetProjectExpanded={onSetProjectExpanded}
                  addFlow={addFlow}
                  sessions={sessions}
                  surfaces={surfaces}
                  bindingsLoaded={bindingsLoaded}
                  currentSessionId={currentSessionId}
                  conversationSurfaceVisible={activeView === "home"}
                  onLoadSession={onLoadSession}
                  onOpenWorkBoardItem={onOpenWorkBoardItem}
                  onOpenSideChat={onOpenSideChat}
                  onOpenPaneChat={onOpenPaneChat}
                  onNewChatForProject={onNewChatForProject}
                  onRemoveProject={onRemoveProject}
                  onOpenSurface={onOpenSurface}
                  isSurfaceVisible={isSurfaceVisible}
                  onOpenSessionBeside={onOpenSessionBeside}
                  onOpenSurfaceBeside={onOpenSurfaceBeside}
                  onCloseSurface={onCloseSurface}
                  onMoveSurface={onMoveSurface}
                  isSessionStarred={isSessionStarred}
                  onToggleSessionStar={onToggleSessionStar}
                  isProjectPinned={isProjectPinned}
                  onToggleProjectPin={onToggleProjectPin}
                  conversationActions={conversationActions}
                  projectActions={projectActions}
                  pendingAnswerSessionIds={pendingAnswerSessionIds}
                  suggestionsPendingCount={suggestionsPendingCount}
                />
              </ErrorBoundary>
            ) : null}
          </div>
        </ScrollArea>
        {/* The work board and memory stay under the list, outside its scroller (case 18). */}
        <div className="mx-2 h-px shrink-0 bg-border" aria-hidden="true" />
        <div className="shrink-0 space-y-0.5 px-2 py-1.5" data-testid="sidebar-card-footer">
          <NavItem
            viewKey="work-board"
            label={t(BUILTIN_LABEL_KEYS["work-board"])}
            icon={<WorkBoardIcon className="h-4 w-4" />}
            isActive={activeView === "work-board"}
            onClick={() => onSelect("work-board")}
            collapsed={false}
            data-testid="sidebar-card-work-board"
          />
          <NavItem
            viewKey="memory"
            label={t(BUILTIN_LABEL_KEYS.memory)}
            icon={<MemoryIcon className="h-4 w-4" />}
            isActive={activeView === "memory"}
            onClick={() => onSelect("memory")}
            collapsed={false}
            data-testid="sidebar-card-memory"
          />
        </div>
      </div>
      )}
    </aside>
    </SidebarPreviewProvider>
  );
}
