import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MessageSquareText, MoreHorizontal, Pin, Plus } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { formatRelativeSessionTime } from "../../../../shared/format-time.js";
import {
  projectRootEquals,
  type ProjectIdentity,
} from "../../../../shared/project-identity.js";
import type { SessionFamily, SessionListQuery } from "../../../../shared/session-lookup.js";
import { isSuggestionsSession } from "../../../../shared/suggestions-session.js";
import { resolveConversationTitle } from "../../../../shared/conversation-title.js";
import type { useAddProjectFolder } from "../../hooks/use-add-project-folder.js";
import {
  useNativeContextMenu,
  useNativeMenu,
  type NativeContextMenuHandlers,
  type NativeMenuRow,
} from "../../hooks/use-native-context-menu.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import type { SidebarSurface } from "../../hooks/use-sidebar-items.js";
import { useActiveSurface, surfaceUsedAt } from "../../preview/active-surface.js";
import { useExitedTerminals, useTerminalAttention } from "../../preview/terminal-attention.js";
import { AgentStatusGlyph, agentStatusLabels } from "../AgentStatusGlyph.js";
import { SidebarPreviewTarget, sidebarPreviewRowProps, useSidebarPreview } from "../SidebarPreview.js";
import { CHAT_SESSION_DRAG_TYPE } from "../pane-drop.js";
import { projectTestId } from "./ProjectCombobox.js";
import { orderedProjects, ProjectMark } from "./ProjectMenu.js";
import {
  bucketEntries,
  nestSessionEntries,
  sessionBranchExpanded,
  GROUP_PAGE_SIZE,
  sessionEntryKey,
  TREE_PAGE_SIZE,
  treeEntries,
  type TreeBucket,
  type TreeEntry,
} from "./project-tree-model.js";
import { SurfaceRow, TREE_ROW_FOCUS_CLASS, type TreeRowProps } from "./SurfaceRow.js";
import { continuationGuides, TreeIndentGuides, treeGuides, treeIndentStyle, type TreeGuide } from "./tree-indent-guides.js";

/** What assistive tech reads for each family's glyph. */
const SESSION_FAMILY_LABEL_KEYS: Record<SessionFamily, string> = {
  main: "sidebar.mainConversation",
  routine: "sidebar.routineConversation",
  "work-board": "sidebar.workBoardConversation",
  "side-chat": "sidebar.sideChatConversation",
  subagent: "sidebar.subAgentConversation",
};

/** The sidebar's one add-project flow, run from the project menu and the list's right-click. */
export interface SidebarAddFlow {
  pendingWarning: ReturnType<typeof useAddProjectFolder>["pendingWarning"];
  addProject: () => Promise<void>;
  confirmAddProject: () => Promise<void>;
  cancelPendingFolder: () => void;
}

/** What a conversation row can do to ITSELF. One object rather than eight loose props: these arrive together, they are
 * offered together in one menu, and a row that has some of them but not others would show a menu with holes in it. */
export interface ConversationRowActions {
  isArchived: (sessionId: string) => boolean;
  isUnread: (sessionId: string) => boolean;
  /** A turn is running in this conversation or one of its chats (`workingSessionIds`). */
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
      className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 py-0.5 text-body-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
  tree,
  expanded,
  onToggleExpanded,
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
  /** The row's place in the tree's keyboard model (case 20). */
  tree: TreeRowProps;
  expanded?: boolean;
  onToggleExpanded?: () => void;
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
  /** This conversation's turn is parked on a request, on screen or not — the warning badge on the glyph says "interrupted
   * here, something is waiting for an answer". */
  pendingAnswer?: boolean;
  /** Suggestions waiting in this conversation — drawn as a count. Only the dedicated Suggestions conversation has any. */
  pendingCount?: number;
  /** A turn is running here, in this conversation or one of its chats — the kind glyph gives way to the loader. */
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
  const preview = useSidebarPreview({ kind: "conversation", title: session.title, message: session.preview, modifiedAt: session.modifiedAt, running: responding, waiting: pendingAnswer && pendingCount === 0 });
  const rowPreview = sidebarPreviewRowProps(renaming ? null : preview);
  // The Suggestions row's count stands in for the waiting badge. The slot is hidden from assistive tech, so the row's button
  // says what the slot shows: a non-main family's name first (the chat family stays unnamed — on a list that is mostly chats,
  // naming each would read the same word down the column), then the state.
  const statusBadge = pendingAnswer && pendingCount === 0 ? "waiting" : null;
  const spokenSlot = [
    ...(family === "main" ? [] : [familyLabel]),
    ...agentStatusLabels(t, Boolean(responding), statusBadge),
  ];
  return (
    <div
      role="treeitem"
      aria-level={tree.level}
      aria-selected={active}
      aria-expanded={expanded}
      tabIndex={tree.tabIndex}
      data-tree-key={tree.treeKey}
      data-testid={`sidebar-row-session-${session.id}`}
      aria-describedby={rowPreview["aria-describedby"]}
      onFocus={(event) => { if (event.target === event.currentTarget) tree.onFocusRow(tree.treeKey); rowPreview.onFocus?.(event); }}
      onBlur={rowPreview.onBlur}
      onContextMenu={onOpenMenu}
      data-session-family={family}
      className={[
        "group relative flex w-full min-w-0 items-center rounded-md transition-colors",
        TREE_ROW_FOCUS_CLASS,
        active
          ? "bg-primary/(--opacity-subtle) text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      ].join(" ")}
      data-archived={archived ? "true" : undefined}
      data-session-context={session.context ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      data-responding={responding ? "true" : undefined}
      style={treeIndentStyle(tree.level)}
    >
      <TreeIndentGuides guides={tree.guides} />
      {/* The row's content, apart from its guides: an archived row dims only this, so the lines of the rows around it that
          pass through it keep their contrast. Archived rows stay READABLE. Dimming them to the point of illegibility would
          make the archive a place things go to be lost, which is what delete is for. */}
      <div
        className={`ave-sidebar-label flex min-w-0 flex-1 items-center ${archived ? "opacity-70" : ""}`}
        data-testid={`sidebar-row-content-${session.id}`}
      >
      {/* ── Leading slot. One 14px square that holds the row's KIND at rest and
          its pin on hover. The two never coexist, so the row's text never
          shifts — the reason the swap happens here rather than by revealing a
          fourth control. A pinned row keeps the pin showing: the state has to
          be readable without hovering every row to find it. */}
      <span className="relative ml-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {onTogglePin && !onToggleExpanded ? (
          <button
            type="button"
            tabIndex={-1}
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
        {/* The agent status slot: the kind glyph at rest, the loader in its place while a turn runs, and the corner badge
            while a turn is parked on a card. Mark and loader are hidden — not removed — under the pin, so the swap costs no
            layout; the badge stays readable over it. */}
        <AgentStatusGlyph
          working={Boolean(responding)}
          badge={statusBadge}
          hiddenFromAccessibility
          workingTestId={`sidebar-session-responding-${session.id}`}
          badgeTestId={`sidebar-pending-answer-${session.id}`}
          markClassName={onToggleExpanded ? undefined : isPinned ? "invisible" : "group-hover:invisible group-focus-within:invisible"}
          // Positioned after the pin, so it must let the pin take the click.
          className="pointer-events-none"
          mark={
            /* Decorative here: the whole slot is hidden from assistive tech, and the row's button names the family (non-main
               rows) and the state in its sr-only text instead. */
            <MessageSquareText
              className="h-3.5 w-3.5"
              aria-hidden="true"
              data-testid={`sidebar-conversation-glyph-${session.id}`}
              data-session-family={family}
            />
          }
        />
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
        <SidebarPreviewTarget handle={preview}>
        <button
          type="button"
          tabIndex={-1}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-body-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`sidebar-session-${session.id}`}
          data-session-family={family}
          title={family === "main" ? session.title : familyLabel}
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
          <span
            className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-foreground" : ""}`}
            data-testid={`sidebar-conversation-title-${session.id}`}
          >
            {session.title}
          </span>
          {spokenSlot.length > 0 ? <span className="sr-only">{spokenSlot.join(", ")}</span> : null}
          {pendingCount > 0 ? (
            <span
              className="shrink-0 rounded-full bg-primary px-1.5 text-tiny font-semibold leading-4 text-primary-foreground tabular-nums"
              aria-label={t("sidebar.suggestionsPendingCount", { count: pendingCount })}
              data-testid={`sidebar-pending-count-${session.id}`}
            >
              {pendingCount}
            </span>
          ) : null}
        </button>
        </SidebarPreviewTarget>
      )}
        {onToggleExpanded ? (
          <button type="button" tabIndex={-1} className="mr-1 flex shrink-0 items-center justify-center rounded-sm p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t(expanded ? "sidebar.collapseConversation" : "sidebar.expandConversation", { title: session.title })}
            data-testid={`sidebar-session-toggle-${session.id}`}
            onClick={(event) => { event.stopPropagation(); onToggleExpanded(); }}>
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      {time ? (
        <span className="ave-sidebar-label shrink-0 pr-1 text-tiny text-muted-foreground/(--opacity-intense) group-hover:hidden group-focus-within:hidden">
          {time}
        </span>
      ) : null}
      {/* ── Trailing slot: the way IN to this row's actions. Right-click already
          opens the same menu, but a right-click is undiscoverable — the button
          is what tells the user the menu exists. Both call one handler. */}
      {onOpenMenu ? (
        <button
          type="button"
          tabIndex={-1}
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
    </div>
  );
}


/** Whether something recorded against `root` belongs to `project`. The 기본 프로젝트 also holds what names no open project:
 * a conversation without a root, or one whose project was removed. */
function belongsToProject(root: string | undefined, project: ProjectIdentity, projects: readonly ProjectIdentity[]): boolean {
  if (!project.isDefault) return Boolean(root) && projectRootEquals(root, project.projectRoot);
  if (!root || projectRootEquals(root, project.projectRoot)) return true;
  return !projects.some((each) => !each.isDefault && projectRootEquals(each.projectRoot, root));
}

const BUCKET_LABEL_KEYS: Record<TreeBucket, string> = {
  pinned: "sidebar.treePinned",
  last7Days: "sidebar.treeLast7Days",
  last30Days: "sidebar.treeLast30Days",
  older: "sidebar.treeOlder",
};

/** One line of the tree, decided before anything is drawn so the roving tabindex can be settled in the same pass. */
type TreeLine =
  | { type: "header"; key: string; bucket: TreeBucket }
  | { type: "group"; key: string; project: ProjectIdentity; expanded: boolean; count: number }
  | { type: "entry"; key: string; entry: TreeEntry; level: number }
  | { type: "pane-chat"; key: string; entry: Extract<TreeEntry, { kind: "session" }>; level: number }
  | { type: "more"; key: string; scope: string; hidden: number; level: number }
  | { type: "empty"; key: string; level: number };

/** What the keyboard can do to the focused row (case 20). */
interface RowKeyActions {
  open: () => void;
  openBeside?: () => void;
  rename?: () => void;
  toggle?: () => void;
  menu?: (row: HTMLElement) => void;
}

/** A context menu asked for from the keyboard (Shift+F10, the menu key) opens at the row, as a right-click there would. */
function rowMenuEvent(row: HTMLElement): MouseEvent<HTMLElement> {
  const rect = row.getBoundingClientRect();
  return {
    currentTarget: row,
    clientX: rect.left + 16,
    clientY: rect.bottom,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as MouseEvent<HTMLElement>;
}

export interface ProjectTreeProps {
  /** The project the list shows; undefined shows every project as a group (case 05). */
  selectedProject: ProjectIdentity | undefined;
  /** Every open project, for the all-projects groups, the 기본 프로젝트's orphans and 다른 프로젝트로 이동. */
  projects: readonly ProjectIdentity[];
  projectName: (project: ProjectIdentity) => string;
  isProjectExpanded: (root: string) => boolean;
  onSetProjectExpanded: (root: string, expanded: boolean) => void;
  addFlow: SidebarAddFlow;
  sessions: SessionSummary[];
  hiddenRoots?: Record<string, number>;
  hasArchived?: boolean;
  visibleSurfaceIds?: string[];
  pinnedSessionIds?: string[];
  onSessionListOptionsChange?: (options: NonNullable<SessionListQuery["sidebar"]>) => void;
  surfaces: readonly SidebarSurface[];
  bindingsLoaded: boolean;
  currentSessionId?: string;
  /**
   * Whether a CONVERSATION is what the window is showing.
   *
   * A session stays loaded while the user reads a plugin view or Settings, so "which session is loaded" and "which row is
   * the current page" are two different questions.
   */
  conversationSurfaceVisible: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onOpenWorkBoardItem?: (itemId: number) => void;
  activeSubAgentSessionId?: string;
  onOpenSubAgent?: (session: SessionSummary) => void;
  onOpenSideChat?: (sideChatSessionId: string, originSessionId?: string) => void;
  /** Open the live terminal or page and its own chat panel. */
  onOpenPaneChat?: (tabId: string) => void;
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** 프로젝트 제거 (case 29): the app previews, confirms when something would be lost, and removes. */
  onRemoveProject: (project: ProjectIdentity) => void;
  onOpenSurface?: (tabId: string) => void;
  isSurfaceVisible?: (tabId: string) => boolean;
  /** 옆에 분할로 열기 (⌥Enter): the conversation in a new pane beside the focused one. */
  onOpenSessionBeside?: (sessionId: string) => void;
  /** The same for a terminal or page. */
  onOpenSurfaceBeside?: (tabId: string) => void;
  /** Close a terminal or page in the main area, as its pane's close button does. */
  onCloseSurface?: (tabId: string) => void;
  /** 다른 프로젝트로 이동: a terminal or page in the main area belongs to another open project from now on. */
  onMoveSurface?: (tabId: string, projectRoot: string) => void;
  isSessionStarred?: (sessionId: string) => string | null;
  onToggleSessionStar?: (sessionId: string, title?: string) => void | Promise<void>;
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  onToggleProjectPin?: (projectRoot: string) => void;
  conversationActions?: ConversationRowActions;
  projectActions?: ProjectRowActions;
  /** Conversations whose turn is parked on an answer. */
  pendingAnswerSessionIds?: ReadonlySet<string>;
  /** Suggestions waiting in the dedicated Suggestions conversation. */
  suggestionsPendingCount: number;
}

/**
 * The project tree (cases 05, 18, 19, 20): a project's conversations and open terminals and pages in one list, newest first
 * under time headers, or every project as a folding group. It is one `role="tree"` with a roving tabindex: Tab enters at
 * one row and leaves in one step, and the arrow keys, Home and End, Enter, ⌥Enter, F2 and the menu key work the rows.
 */
export function ProjectTree({
  selectedProject,
  projects,
  projectName,
  isProjectExpanded,
  onSetProjectExpanded,
  addFlow,
  sessions,
  hiddenRoots = {},
  hasArchived = false,
  visibleSurfaceIds,
  pinnedSessionIds = [],
  onSessionListOptionsChange,
  surfaces,
  bindingsLoaded,
  currentSessionId,
  conversationSurfaceVisible,
  onLoadSession,
  onOpenWorkBoardItem,
  onOpenSideChat,
  activeSubAgentSessionId,
  onOpenSubAgent,
  onOpenPaneChat,
  onNewChatForProject,
  onRemoveProject,
  onOpenSurface,
  isSurfaceVisible,
  onOpenSessionBeside,
  onOpenSurfaceBeside,
  onCloseSurface,
  onMoveSurface,
  isSessionStarred,
  onToggleSessionStar,
  isProjectPinned,
  onToggleProjectPin,
  conversationActions,
  projectActions,
  pendingAnswerSessionIds,
  suggestionsPendingCount,
}: ProjectTreeProps) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  const openMenu = useNativeMenu();
  // Re-read on every change of the shown surface: showing one is what moves it up the list.
  const activeSurface = useActiveSurface();
  const attention = useTerminalAttention();
  const exitedTerminals = useExitedTerminals();
  const { pendingWarning, addProject, confirmAddProject, cancelPendingFolder } = addFlow;
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Archived rows are out of the way by default and one click from being back.
  const [showArchived, setShowArchived] = useState(false);
  // How many rows each list shows; a list not listed shows its first page.
  const [shownByScope, setShownByScope] = useState<Readonly<Record<string, number>>>({});
  const [expandedSessions, setExpandedSessions] = useState<Readonly<Record<string, boolean>>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const keyActions = useRef(new Map<string, RowKeyActions>());

  const isSessionPinned = (sessionId: string) => Boolean(isSessionStarred?.(sessionId));
  const isSessionArchived = (session: SessionSummary) => Boolean(session.archivedAt);
  const paneSurfaceOf = (session: SessionSummary) => session.family === "side-chat"
    ? surfaces.find((surface) => surface.tabId === session.paneTabId && surface.boundSessionIds.includes(session.id))
    : undefined;
  const hasArchivedSessions = hasArchived || sessions.some(isSessionArchived);
  const paneSessionEntries = new Map<string, Extract<TreeEntry, { kind: "session" }>>();
  const sessionRoot = new Map(sessions.map((session) => [session.id, session.projectRoot]));
  const surfaceRoot = (surface: SidebarSurface) => surface.projectRoot ?? (surface.sessionId ? sessionRoot.get(surface.sessionId) : undefined);
  const now = Date.now();
  const entriesOf = (project: ProjectIdentity): TreeEntry[] => nestSessionEntries(treeEntries({
    sessions: sessions.filter((session) => belongsToProject(session.projectRoot, project, projects)),
    surfaces: surfaces.filter((surface) => belongsToProject(surfaceRoot(surface), project, projects) && (visibleSurfaceIds === undefined || visibleSurfaceIds.includes(surface.tabId))),
    isPinned: isSessionPinned,
    surfaceAt: (tabId) => surfaceUsedAt(tabId, now),
  })).filter((entry) => {
    if (entry.kind !== "session" || !paneSurfaceOf(entry.session)) return true;
    paneSessionEntries.set(entry.session.id, entry);
    return false;
  });
  const showMore = (scope: string, page: number) =>
    setShownByScope((current) => ({ ...current, [scope]: (current[scope] ?? page) + page }));

  const selectedId = activeSubAgentSessionId ?? (conversationSurfaceVisible ? currentSessionId : undefined);
  const rootLimits = Object.fromEntries(Object.entries(shownByScope).map(([scope, count]) => [
    scope === "project" ? selectedProject?.projectRoot ?? "" : scope.slice("group:".length), count,
  ]));
  const sessionListOptions = JSON.stringify({
    rootLimit: selectedProject ? TREE_PAGE_SIZE : GROUP_PAGE_SIZE,
    rootLimits,
    expandedParentIds: [...new Set([...Object.keys(expandedSessions).filter((id) => expandedSessions[id]), ...(selectedId ? [selectedId] : [])])],
    selectedSessionId: selectedId,
    pinnedSessionIds,
    showArchived,
    defaultProjectRoot: projects.find((project) => project.isDefault)?.projectRoot,
    projectRoots: projects.map((project) => project.projectRoot),
    surfaces: surfaces.map((surface) => ({ id: surface.tabId, projectRoot: surfaceRoot(surface), modifiedAt: new Date(surfaceUsedAt(surface.tabId, now)).toISOString(), boundSessionIds: [...surface.boundSessionIds] })),
  } satisfies NonNullable<SessionListQuery["sidebar"]>);
  useEffect(() => {
    onSessionListOptionsChange?.(JSON.parse(sessionListOptions));
  }, [onSessionListOptionsChange, sessionListOptions]);
  const branchExpanded = (entry: Extract<TreeEntry, { kind: "session" }>) => sessionBranchExpanded(entry, selectedId, (id) => Boolean(conversationActions?.isResponding(id) || pendingAnswerSessionIds?.has(id)), expandedSessions[entry.session.id]);

  // ── Lines, top to bottom.
  const lines: TreeLine[] = [];
  const pushEntries = (scope: string, entries: TreeEntry[], level: number, withHeaders: boolean) => {
    const emit = (entry: TreeEntry, entryLevel = level) => {
      lines.push({ type: "entry", key: entry.key, entry, level: entryLevel });
      if (entry.kind === "session" && branchExpanded(entry)) {
        for (const child of entry.children ?? []) emit(child, entryLevel + 1);
      }
      if (entry.kind !== "surface") return;
      for (const session of sessions.filter((each) => paneSurfaceOf(each)?.tabId === entry.surface.tabId)) {
        const paneEntry = paneSessionEntries.get(session.id);
        if (!paneEntry) continue;
        lines.push({ type: "pane-chat", key: paneEntry.key, entry: paneEntry, level: entryLevel + 1 });
        if (branchExpanded(paneEntry)) {
          for (const child of paneEntry.children ?? []) emit(child, entryLevel + 2);
        }
      }
    };
    if (withHeaders) {
      for (const { bucket, entries: rows } of bucketEntries(entries, now, isSessionPinned)) {
        lines.push({ type: "header", key: `header:${scope}:${bucket}`, bucket });
        rows.forEach((entry) => { emit(entry); });
      }
    } else entries.forEach((entry) => { emit(entry); });
    const root = scope === "project" ? selectedProject?.projectRoot ?? "" : scope.slice("group:".length);
    const hidden = hiddenRoots[root] ?? 0;
    if (hidden > 0) lines.push({ type: "more", key: `more:${scope}`, scope, hidden, level });
  };
  if (selectedProject) {
    const entries = entriesOf(selectedProject);
    if (entries.length === 0) lines.push({ type: "empty", key: "empty:project", level: 1 });
    else pushEntries("project", entries, 1, true);
  } else {
    const groups = orderedProjects(projects, isProjectPinned)
      .filter((project) => showArchived || !projectActions?.isArchived(project.projectRoot));
    for (const project of groups) {
      const entries = entriesOf(project);
      const expanded = isProjectExpanded(project.projectRoot);
      lines.push({ type: "group", key: `project:${project.projectRoot}`, project, expanded, count: entries.length });
      if (!expanded) continue;
      const scope = `group:${project.projectRoot}`;
      if (entries.length === 0) lines.push({ type: "empty", key: `empty:${scope}`, level: 2 });
      else pushEntries(scope, entries, 2, false);
    }
  }
  const rowKeys = lines.filter((line) => line.type !== "header" && line.type !== "empty").map((line) => line.key);
  // The indent guides of every line, drawn from the same flat order the keyboard walks. A time header ends every run of
  // siblings above it, as a level-0 break.
  const guidesOf = new Map<string, TreeGuide[]>();
  treeGuides(lines.map((line) => line.type === "header" ? 0 : line.type === "group" ? 1 : line.level))
    .forEach((guides, index) => guidesOf.set(lines[index]!.key, guides));
  const lineGuides = (key: string): TreeGuide[] => guidesOf.get(key) ?? [];
  const currentKey = conversationSurfaceVisible && currentSessionId
    ? sessionEntryKey(currentSessionId)
    : activeSurface && isSurfaceVisible?.(activeSurface.tabId) ? `surface:${activeSurface.tabId}` : undefined;
  const rovingKey = focusKey !== null && rowKeys.includes(focusKey)
    ? focusKey
    : currentKey !== undefined && rowKeys.includes(currentKey) ? currentKey : rowKeys[0];
  // A focused row that goes away (closed, archived, deleted) would drop focus to the page: hand it to the row that took its
  // place, else the one before it.
  const previousRowKeys = useRef<readonly string[]>(rowKeys);
  const rowKeysSignature = rowKeys.join("\n");
  useEffect(() => {
    const previous = previousRowKeys.current;
    previousRowKeys.current = rowKeys;
    if (focusKey === null || rowKeys.includes(focusKey)) return;
    const index = previous.indexOf(focusKey);
    const neighbour = previous.slice(index + 1).find((key) => rowKeys.includes(key))
      ?? previous.slice(0, Math.max(index, 0)).reverse().find((key) => rowKeys.includes(key))
      ?? rowKeys[0];
    if (neighbour === undefined) return;
    setFocusKey(neighbour);
    // Only when focus was lost with the row; focus the user moved elsewhere stays there.
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const row = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
      .find((each) => each.dataset.treeKey === neighbour);
    row?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the row set changes
  }, [rowKeysSignature]);
  const actions = new Map<string, RowKeyActions>();
  keyActions.current = actions;
  const treeRow = (key: string, level: number): TreeRowProps => ({
    treeKey: key,
    tabIndex: key === rovingKey ? 0 : -1,
    level,
    guides: lineGuides(key),
    onFocusRow: setFocusKey,
  });
  /** Put focus back on a row once a rename it held has closed. */
  const refocusRow = (key: string) => {
    setTimeout(() => {
      const row = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
        .find((each) => each.dataset.treeKey === key);
      row?.focus();
    }, 0);
  };

  // ── Conversations.
  const conversationMenuHandlers = (session: SessionSummary): NativeContextMenuHandlers => {
    const rowActions = conversationActions;
    const archived = rowActions?.isArchived(session.id) ?? false;
    const unread = rowActions?.isUnread(session.id) ?? false;
    return {
      "conversation.open": () => void onLoadSession?.(session.id),
      ...(onOpenSessionBeside ? { "conversation.open-split": () => onOpenSessionBeside(session.id) } : {}),
      ...(rowActions
        ? {
            [unread ? "conversation.mark-read" : "conversation.mark-unread"]: () =>
              void rowActions.onSetUnread(session.id, !unread),
            // The Suggestions conversation's name comes from the catalog, so a rename would store a string no surface shows.
            ...(isSuggestionsSession(session.id)
              ? {}
              : { "conversation.rename": () => setRenamingKey(sessionEntryKey(session.id)) }),
            "conversation.share": () => void rowActions.onShare(session.id),
            "conversation.copy": () => void rowActions.onCopy(session.id),
            // Every unrequested card is addressed to the Suggestions conversation — archiving it would hide every
            // suggestion and its count. Main refuses it too.
            ...(isSuggestionsSession(session.id) && !archived
              ? {}
              : {
                  [archived ? "conversation.unarchive" : "conversation.archive"]: () =>
                    void rowActions.onSetArchived(session.id, !archived),
                }),
            "conversation.delete": () => void rowActions.onDelete(session.id),
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
  // transcript; `main` loads into the tile through `onLoadSession`.
  const openFamilyRow = (session: SessionSummary): (() => void) | undefined => {
    switch (session.family) {
      case "subagent":
        return () => onOpenSubAgent?.(session);
      case "main":
        return undefined;
      case "routine":
        return () => void onLoadSession?.(session.id);
      case "work-board":
        return session.workBoardItemId === undefined
          ? undefined
          : () => onOpenWorkBoardItem?.(session.workBoardItemId!);
      case "side-chat":
        if (paneSurfaceOf(session)) return () => onOpenPaneChat?.(session.paneTabId!);
        return () => onOpenSideChat?.(session.id, session.originSessionId);
    }
  };

  // A row that is not a main conversation is READ-ONLY here: rename, archive, pin, delete and drag act on the main session
  // store. Other families offer their owning transcript’s open action.
  const renderFamilyRow = (session: SessionSummary, key: string, level: number, branch: { expanded?: boolean; onToggleExpanded?: () => void } = {}) => {
    const open = openFamilyRow(session);
    const familyMenu = (open ? { "conversation.open": open } : {}) as NativeContextMenuHandlers;
    actions.set(key, {
      open: () => open?.(),
      toggle: branch.onToggleExpanded,
      menu: (row) => void openNativeContextMenu(rowMenuEvent(row), "conversation", familyMenu),
    });
    return (
      <div key={key}>
        <SessionRow
          tree={treeRow(key, level)}
          session={session}
          {...branch}
          active={session.id === activeSubAgentSessionId}
          family={session.family}
          pendingAnswer={pendingAnswerSessionIds?.has(session.id) ?? false}
          responding={conversationActions?.isResponding(session.id)}
          archived={isSessionArchived(session)}
          {...(open ? { onOpenFamilyRow: open } : {})}
          onOpenMenu={(event) => openNativeContextMenu(event, "conversation", familyMenu)}
          t={t}
        />
        {bindingsLoaded && session.paneTabId && session.archivedAt && !paneSurfaceOf(session) && (
          // Under its row's text, so it takes the row's indent and carries on the lines that run past the row.
          <div
            className="relative truncate pl-7 text-tiny text-muted-foreground"
            style={treeIndentStyle(level, 1.75)}
            data-testid={`sidebar-former-pane-${session.id}`}
          >
            <TreeIndentGuides guides={continuationGuides(lineGuides(key))} reachUp={false} />
            {t(session.paneTabId.startsWith("terminal:") ? "sidebar.formerTerminalChat" : "sidebar.formerPageChat")}
          </div>
        )}
      </div>
    );
  };

  const renderSessionRow = (entry: Extract<TreeEntry, { kind: "session" }>, key: string, level: number) => {
    const listed = entry.session;
    const expanded = branchExpanded(entry);
    const branch = listed.hasChildren || entry.children?.length ? { expanded, onToggleExpanded: () => setExpandedSessions((current) => ({ ...current, [listed.id]: !expanded })) } : {};
    if (listed.family !== "main") return renderFamilyRow(listed, key, level, branch);
    // The dedicated Suggestions conversation is named from the catalog by its id and carries the number of suggestions
    // waiting in it.
    const suggestions = isSuggestionsSession(listed.id);
    const session = { ...listed, title: resolveConversationTitle({ sessionId: listed.id, title: listed.title }, t) };
    const canRename = Boolean(conversationActions) && !suggestions;
    actions.set(key, {
      open: () => void onLoadSession?.(session.id),
      toggle: branch.onToggleExpanded,
      ...(onOpenSessionBeside ? { openBeside: () => onOpenSessionBeside(session.id) } : {}),
      ...(canRename ? { rename: () => setRenamingKey(key) } : {}),
      menu: (row) => void openNativeContextMenu(rowMenuEvent(row), "conversation", conversationMenuHandlers(session)),
    });
    return (
      <SessionRow
        key={key}
        {...branch}
        tree={treeRow(key, level)}
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
        archived={isSessionArchived(session)}
        renaming={renamingKey === key}
        onCommitRename={conversationActions
          ? (title) => {
              setRenamingKey(null);
              refocusRow(key);
              void conversationActions.onRename(session.id, title);
            }
          : undefined}
        onCancelRename={() => {
          setRenamingKey(null);
          refocusRow(key);
        }}
        t={t}
      />
    );
  };

  // ── Terminals and pages.
  const surfaceMenuRows = (surface: SidebarSurface): NativeMenuRow[][] => {
    // Only a main-area surface carries its own project; a side panel's tab goes where its conversation goes.
    const main = surface.projectRoot !== undefined;
    const others = main ? orderedProjects(projects, isProjectPinned)
      .filter((project) => !projectRootEquals(project.projectRoot, surface.projectRoot!)) : [];
    const first: NativeMenuRow[] = [
      { id: "open", label: t("sidebar.treeOpen"), accelerator: "Enter", onSelect: () => onOpenSurface?.(surface.tabId) },
      ...(main && onOpenSurfaceBeside
        ? [{ id: "beside", label: t("sidebar.openInSplit"), accelerator: "Alt+Enter", onSelect: () => onOpenSurfaceBeside(surface.tabId) }]
        : []),
      ...(main && onMoveSurface && others.length > 0
        ? [{
            id: "move",
            label: t("sidebar.moveToProject"),
            submenu: others.map((project) => ({
              id: `move:${project.projectRoot}`,
              label: projectName(project),
              onSelect: () => onMoveSurface(surface.tabId, project.projectRoot),
            })),
          }]
        : []),
    ];
    const close: NativeMenuRow[] = main && onCloseSurface
      ? [{
          id: "close",
          label: t(surface.kind === "terminal" ? "sidebar.closeTerminalEnding" : "sidebar.closePage"),
          onSelect: () => onCloseSurface(surface.tabId),
        }]
      : [];
    return close.length > 0 ? [first, close] : [first];
  };
  const renderSurfaceRow = (surface: SidebarSurface, key: string, level: number) => {
    const main = surface.projectRoot !== undefined;
    const showMenu = (at: { x: number; y: number }) =>
      void openMenu(at, surfaceMenuRows(surface).map((items) => ({ items })));
    actions.set(key, {
      open: () => onOpenSurface?.(surface.tabId),
      ...(main && onOpenSurfaceBeside ? { openBeside: () => onOpenSurfaceBeside(surface.tabId) } : {}),
      menu: (row) => {
        const rect = row.getBoundingClientRect();
        showMenu({ x: rect.left + 16, y: rect.bottom });
      },
    });
    const status = surface.kind !== "terminal" ? undefined
      : attention.has(surface.tabId) ? { text: t("sidebar.surfaceAttention"), tone: "attention" as const }
      : exitedTerminals.has(surface.tabId) ? { text: t("sidebar.surfaceExited"), tone: "muted" as const }
      : undefined;
    return (
      <SurfaceRow
        key={key}
        {...treeRow(key, level)}
        surface={surface}
        current={Boolean(isSurfaceVisible?.(surface.tabId)) && activeSurface?.tabId === surface.tabId}
        {...(status ? { status } : {})}
        onOpen={() => onOpenSurface?.(surface.tabId)}
        onOpenMenu={showMenu}
        {...(main && onCloseSurface ? { onClose: () => onCloseSurface(surface.tabId) } : {})}
      />
    );
  };

  // ── Project groups (the all-projects view).
  const revealProject = (projectRoot: string) => void window.ave?.workspace?.reveal?.(projectRoot);
  const addProjectMenuHandlers = (): NativeContextMenuHandlers => ({ "project.add": () => void addProject() });
  const newChatIn = (project: ProjectIdentity) => void onNewChatForProject?.({ projectRoot: project.projectRoot, projectName: project.projectName });
  // The folder's own actions, built once: the row's right-click, its trailing button and the menu key all call this.
  const projectMenuHandlers = (project: ProjectIdentity): NativeContextMenuHandlers => {
    const root = project.projectRoot;
    const archived = Boolean(projectActions?.isArchived(root));
    return {
      "project.new-chat": () => newChatIn(project),
      ...(onToggleProjectPin ? { [isProjectPinned?.(root) ? "project.unpin" : "project.pin"]: () => onToggleProjectPin(root) } : {}),
      ...(projectActions
        ? {
            "project.edit": () => setRenamingKey(`project:${root}`),
            [archived ? "project.unarchive" : "project.archive"]: () => projectActions.onSetArchived(root),
          }
        : {}),
      "project.reveal": () => revealProject(root),
      // Also offered ON a row: someone hunting for "add a project" right-clicks the nearest project-looking thing.
      ...addProjectMenuHandlers(),
      ...(project.isDefault ? {} : { "project.remove": () => onRemoveProject(project) }),
    } as NativeContextMenuHandlers;
  };
  const renderGroupRow = (line: Extract<TreeLine, { type: "group" }>) => {
    const { project, expanded, count, key } = line;
    const root = project.projectRoot;
    const name = projectName(project);
    const pinned = Boolean(isProjectPinned?.(root));
    const archived = Boolean(projectActions?.isArchived(root));
    const testId = projectTestId(root, project.projectName);
    const toggle = () => onSetProjectExpanded(root, !expanded);
    actions.set(key, {
      open: toggle,
      toggle,
      ...(projectActions ? { rename: () => setRenamingKey(key) } : {}),
      menu: (row) => void openNativeContextMenu(rowMenuEvent(row), "project", projectMenuHandlers(project)),
    });
    const row = treeRow(key, 1);
    return (
      <div
        key={key}
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={false}
        tabIndex={row.tabIndex}
        data-tree-key={key}
        data-testid={`sidebar-project-${testId}`}
        data-archived={archived ? "true" : undefined}
        onFocus={(event) => { if (event.target === event.currentTarget) setFocusKey(key); }}
        onContextMenu={(event) => openNativeContextMenu(event, "project", projectMenuHandlers(project))}
        className={[
          "ave-sidebar-label group mt-1 flex w-full min-w-0 items-center rounded-md transition-colors hover:bg-muted",
          TREE_ROW_FOCUS_CLASS,
          archived ? "opacity-70" : "",
        ].filter(Boolean).join(" ")}
      >
        {renamingKey === key && projectActions ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">
            <ProjectMark project={project} name={name} />
            <InlineRename
              initial={name}
              onCommit={(value) => {
                setRenamingKey(null);
                refocusRow(key);
                projectActions.onSetLabel(root, value);
              }}
              onCancel={() => {
                setRenamingKey(null);
                refocusRow(key);
              }}
              testId={`sidebar-project-rename-${testId}`}
              t={t}
            />
          </div>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            onClick={toggle}
            aria-label={t(expanded ? "sidebar.collapseProjectGroup" : "sidebar.expandProjectGroup", { project: name })}
            title={root}
            data-testid={`sidebar-project-toggle-${testId}`}
            // px-2 puts the chevron where every other row puts its leading icon, so the guide under the group lines up.
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-body-sm font-medium text-foreground focus-visible:outline-none"
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <ProjectMark project={project} name={name} />
            {pinned ? <Pin className="h-3 w-3 shrink-0 fill-current text-primary" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {project.isDefault ? (
              <span className="shrink-0 rounded border border-border px-1 text-tiny font-normal text-muted-foreground">{t("sidebar.defaultBadge")}</span>
            ) : null}
            {expanded ? null : (
              <span className="shrink-0 pr-1 text-dense font-normal tabular-nums text-muted-foreground group-hover:hidden" data-testid={`sidebar-project-count-${testId}`}>
                {count}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            newChatIn(project);
          }}
          className="hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none group-hover:flex group-focus-within:flex"
          aria-label={t("sidebar.newProjectChat", { project: name })}
          title={t("sidebar.newProjectChat", { project: name })}
          data-testid={`sidebar-project-new-${testId}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            openNativeContextMenu(event, "project", projectMenuHandlers(project));
          }}
          className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none group-hover:flex group-focus-within:flex"
          aria-label={t("sidebar.projectMenu")}
          title={t("sidebar.projectMenu")}
          data-testid={`sidebar-project-menu-${testId}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const renderLine = (line: TreeLine) => {
    switch (line.type) {
      case "header":
        // Sticky at the scroller's top while its rows pass under it (case 18).
        return (
          <div
            key={line.key}
            role="presentation"
            data-testid={`sidebar-tree-header-${line.bucket}`}
            className="sticky top-0 z-10 bg-card px-2 pb-1 pt-2 text-dense font-medium text-muted-foreground"
          >
            {t(BUCKET_LABEL_KEYS[line.bucket])}
          </div>
        );
      case "group":
        return renderGroupRow(line);
      case "entry":
        return line.entry.kind === "session"
          ? renderSessionRow(line.entry, line.key, line.level)
          : renderSurfaceRow(line.entry.surface, line.key, line.level);
      case "pane-chat":
        return renderSessionRow(line.entry, line.key, line.level);
      case "more": {
        const page = line.scope === "project" ? TREE_PAGE_SIZE : GROUP_PAGE_SIZE;
        actions.set(line.key, { open: () => showMore(line.scope, page) });
        const row = treeRow(line.key, line.level);
        return (
          <div
            key={line.key}
            role="treeitem"
            aria-level={line.level}
            aria-selected={false}
            tabIndex={row.tabIndex}
            data-tree-key={line.key}
            data-testid={`sidebar-tree-more-${line.scope === "project" ? "project" : projectTestId(line.scope.slice("group:".length), "group")}`}
            onFocus={(event) => { if (event.target === event.currentTarget) setFocusKey(line.key); }}
            onClick={() => showMore(line.scope, page)}
            className={`relative w-full cursor-pointer rounded-md px-2 py-1 text-left text-dense text-muted-foreground hover:bg-muted hover:text-foreground ${TREE_ROW_FOCUS_CLASS}`}
            style={treeIndentStyle(line.level, 0.5)}
          >
            <TreeIndentGuides guides={row.guides} />
            {t("sidebar.treeMore", { count: line.hidden })}
          </div>
        );
      }
      case "empty":
        return (
          <div key={line.key} role="presentation" className="relative px-2 py-1.5 text-dense text-muted-foreground" style={treeIndentStyle(line.level, 0.5)}>
            <TreeIndentGuides guides={lineGuides(line.key)} />
            {t("sidebar.noProjectSessions")}
          </div>
        );
    }
  };

  // A group's rows and a terminal's pane chats sit in a plain container under their row: the tree stays flat for the
  // keyboard (levels say the nesting), and the container only groups them. The indent and the lines are each row's own
  // (`TreeIndentGuides`), so a container adds no margin or border of its own.
  const renderLines = (from: readonly TreeLine[]): ReactNode[] => {
    const out: ReactNode[] = [];
    let index = 0;
    while (index < from.length) {
      const line = from[index]!;
      index += 1;
      if (line.type === "group") {
        const children: TreeLine[] = [];
        while (index < from.length && from[index]!.type !== "group") children.push(from[index++]!);
        out.push(
          <Fragment key={line.key}>
            {renderGroupRow(line)}
            {line.expanded ? (
              <div role="none" className="space-y-0.5" data-testid={`sidebar-project-group-${projectTestId(line.project.projectRoot, line.project.projectName)}`}>
                {renderLines(children)}
              </div>
            ) : null}
          </Fragment>,
        );
        continue;
      }
      if (line.type === "entry" && line.entry.kind === "surface") {
        const chats: TreeLine[] = [];
        while (index < from.length) {
          const next = from[index]!;
          if ((next.type !== "pane-chat" && next.type !== "entry") || next.level <= line.level) break;
          chats.push(next);
          index += 1;
        }
        const tabId = line.entry.surface.tabId;
        out.push(
          <Fragment key={line.key}>
            {renderLine(line)}
            {chats.length > 0 ? (
              <div role="none" className="space-y-0.5" data-testid={`sidebar-surface-chats-${tabId}`}>
                {chats.map(renderLine)}
              </div>
            ) : null}
          </Fragment>,
        );
        continue;
      }
      out.push(renderLine(line));
    }
    return out;
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = event.target as HTMLElement;
    // Keys typed into a rename field, or pressed on a row's own button, are theirs.
    if (row.getAttribute("role") !== "treeitem") return;
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const index = items.indexOf(row);
    const rowActions = keyActions.current.get(row.dataset.treeKey ?? "");
    const focusAt = (next: number) => items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
    const expanded = row.getAttribute("aria-expanded");
    switch (event.key) {
      case "ArrowDown": focusAt(index + 1); break;
      case "ArrowUp": focusAt(index - 1); break;
      case "Home": focusAt(0); break;
      case "End": focusAt(items.length - 1); break;
      case "ArrowRight":
        if (expanded === "false") rowActions?.toggle?.();
        else if (expanded === "true") focusAt(index + 1);
        else return;
        break;
      case "ArrowLeft": {
        if (expanded === "true") {
          rowActions?.toggle?.();
          break;
        }
        const level = Number(row.getAttribute("aria-level"));
        const parent = items.slice(0, index).reverse().find((each) => Number(each.getAttribute("aria-level")) < level);
        if (!parent) return;
        parent.focus();
        break;
      }
      case "Enter":
        if (event.altKey) {
          if (!rowActions?.openBeside) return;
          rowActions.openBeside();
        } else rowActions?.open();
        break;
      // Space opens the row as Enter does, as the rows' buttons did before they became one tree.
      case " ":
        rowActions?.open();
        break;
      case "F2":
        if (!rowActions?.rename) return;
        rowActions.rename();
        break;
      case "ContextMenu":
        rowActions?.menu?.(row);
        break;
      case "F10":
        if (!event.shiftKey || !rowActions?.menu) return;
        rowActions.menu(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const hasArchivedProjects = !selectedProject && projects.some((project) => projectActions?.isArchived(project.projectRoot));
  // Right-click the list itself (not a row): a project's list offers import, which makes a conversation there; the
  // all-projects list offers 프로젝트 추가. Rows stop propagation once they answer, so their own menu still wins.
  const listMenu = (event: MouseEvent<HTMLElement>) => {
    if (selectedProject) {
      openNativeContextMenu(event, "conversation", (conversationActions?.onImport
        ? { "conversation.import": () => void conversationActions.onImport!() }
        : {}) as NativeContextMenuHandlers);
    } else openNativeContextMenu(event, "project", addProjectMenuHandlers());
  };
  const label = selectedProject ? projectName(selectedProject) : t("sidebar.allProjects");

  return (
    <div className="min-h-24 min-w-0 pb-1" data-testid="sidebar-sections" onContextMenu={listMenu}>
      {pendingWarning ? (
        /** Same acknowledgement text the composer selector shows for the same `pickRoot` warning — one flow, one wording. */
        <div
          data-testid="sidebar-project-root-warning"
          className="my-1 space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-dense"
        >
          <div className="font-medium text-destructive">{t("composerProjectSelector.rootWarningTitle")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
            {pendingWarning.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" data-testid="sidebar-project-root-warning-confirm" onClick={() => void confirmAddProject()}>
              {t("composerProjectSelector.rootWarningConfirm")}
            </Button>
            <Button type="button" size="sm" variant="ghost" data-testid="sidebar-project-root-warning-cancel" onClick={cancelPendingFolder}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <div
        ref={treeRef}
        role="tree"
        aria-label={t("sidebar.treeAriaLabel", { project: label })}
        data-testid="sidebar-tree"
        onKeyDown={onTreeKeyDown}
        className="min-w-0 space-y-0.5"
      >
        {renderLines(lines)}
      </div>
      {/* Offered only once something IS archived. A permanent toggle for an empty archive is a control that never does
          anything. */}
      {hasArchivedSessions || hasArchivedProjects ? (
        <button
          type="button"
          onClick={() => setShowArchived((value) => !value)}
          className="mt-1 w-full rounded-md px-2 py-1 text-left text-dense text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-pressed={showArchived}
          data-testid="sidebar-toggle-archived"
        >
          {showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
        </button>
      ) : null}
    </div>
  );
}
