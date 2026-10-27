import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "../../i18n/react.js";
import { MAX_CHAT_GROUPS } from "../../contract/app-contract.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ThemeProvider } from "./theme/index.js";
import { OverlayContextProvider, type OverlayItem } from "./context/OverlayContext.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { MainToolbar } from "./MainToolbar.js";
import { Sidebar, isDarwinPlatform } from "./components/Sidebar.js";
import { MarketplaceAnnouncementBanner } from "./components/MarketplaceAnnouncementBanner.js";
import { DeprecatedModelNotice, RetiredProviderNotice } from "./components/RetiredProviderNotice.js";
import { StatusBar } from "./components/StatusBar.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { DevComponentLabels } from "./components/DevComponentLabels.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import { ChatGroupSession, type ChatGroupEnvironment } from "./components/ChatGroupSession.js";
import { ChatGroupSessionRegistry, useChatGroupSession, useTileSessions, tileHoldingSession, pruneGroupRequests, overlayCardTile, pendingAnswers as selectPendingAnswers, type OverlayCardPlacement } from "./components/chat-group-session-registry.js";
import { leafIds } from "./components/pane-tree.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
// One mounted singleton per away display mode; empty slots render nothing.
import { McpAppPipPanel } from "./components/McpAppPipPanel.js";
import { McpAppFullscreenPanel } from "./components/McpAppFullscreenPanel.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { WorkBoardPanel } from "./components/WorkBoardPanel.js";
import { StarredView } from "./components/StarredView.js";
import { SettingsInlineView } from "./SettingsInlineView.js";
import { PageShell } from "./components/PageShell.js";
import type { ConversationRowActions, ProjectRowActions } from "./components/Sidebar.js";
import { WebSurfaceLayer } from "./components/WebSurfaceLayer.js";
import { SurfacePane } from "./components/MainSurfacePanels.js";
import type { SideChatRuntime } from "./components/SideChatView.js";
import { SURFACE_KIND_OF_VIEW, VIEW_OF_SURFACE_KIND, useMainSurfaces, type MainSurface } from "./preview/main-surfaces.js";
import { SurfaceMovesContext, activateSideTab, getSideTabsSink, isMovableTabKind, type SurfaceDragPayload, type SurfaceMoves } from "./preview/surface-moves.js";
import { latestUnreadTerminal, markTerminalRead, useTerminalAttentionWatcher } from "./preview/terminal-attention.js";
import { surfaceMountLocation, useSurfaceMountRevision } from "./preview/surface-mounts.js";
import { approvalsForDocks } from "./components/permissions/TerminalEgressBanner.js";
import { forgetActiveSurface, showActiveSurface, subscribeSurfaceClosed, updateActiveSurface, useReportActiveSurface, type ActiveSurface } from "./preview/active-surface.js";
import { registerBrowserTabHost } from "./preview/agent-browser-bridge.js";
import { connectBrowserObservations } from "./preview/browser-observation-bridge.js";
import { attachToComposer } from "./preview/composer-targets.js";
import { useMainLayout } from "./hooks/use-main-layout.js";
import { getWebSurfaces } from "./preview/web-surfaces.js";
import { PANEL_COMMANDS, panelCommandFor, type PanelCommandId } from "./components/panel-commands.js";
import { PaneGutter, PANE_HOME, PaneFrame, areaStyle, chatGroupApi, useChatGroups, type PaneSplitAxis } from "./components/PaneFrame.js";
import type { DropTarget } from "./components/pane-drop.js";
import { useSessionList, useTurnAttention, type SessionSummary } from "./hooks/use-sessions.js";
import { isInstanceViewKey, parseInlineViewKey, type InlineViewKey, type InstanceViewKey, type PluginViewKey } from "../../shared/view-key.js";
import { CONTENT_TITLE_INSET, NARROW_DEAD_BAND_PX, SHELL_GUTTER, collapsedBandLeadClearance, sidebarPushThreshold } from "../../shared/shell-geometry.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { ApprovalLaneCard, unattributedRequestLabel } from "./components/permissions/ApprovalDock.js";
import { OverlayCardRegion } from "./components/OverlayCardRegion.js";
import type { ApprovalRequest } from "./types.js";
import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

import { getApi, getPluginViewDescription, getPluginViewLabel, isDarwin, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./types.js";
import { pluginIconFor } from "./utils/plugin-icon.js";
import {
  parsePluginDoctorViewKey,
  parsePluginSettingsViewKey,
  toPluginDoctorViewKey,
} from "./utils/plugin-doctor-view.js";
import { buildQuickActions } from "./components/command-actions.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { useContainerNarrow } from "./hooks/use-container-narrow.js";
import { useSidebarState } from "./hooks/use-sidebar-state.js";
import { Button } from "../../components/ui/button.js";
import { PanelLeftOpen } from "lucide-react";
import { SIDEBAR_WIDTH_PREF, usePanelWidth } from "./hooks/use-panel-width.js";
import { useActiveView } from "./hooks/use-active-view.js";
import { useSettingsTab } from "./hooks/use-settings-tab.js";
import { useProjectPreferences } from "./hooks/use-project-preferences.js";
import { useRoutineOverlay } from "./hooks/use-routine-overlay.js";
import { isSuggestionsSession, sessionDisplayTitle } from "../../shared/suggestions-session.js";
import { usePluginViewRouting } from "./hooks/use-plugin-view-routing.js";
import { useOnboardingTourController } from "./hooks/use-onboarding-tour-controller.js";
import { DocumentEngineInstallContent } from "./components/DocumentEngineInstallContent.js";
import { usePluginLifecycleRefresh } from "./hooks/use-plugin-lifecycle-refresh.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { ApprovalSurfaceProvider, useApproval, useDeferredSessionIds, type ApprovalSurfaceContextValue } from "./hooks/use-approval.js";
import { usePermissionSignals } from "./hooks/use-permission-signals.js";
import { useApprovalSentence } from "./hooks/use-approval-sentence.js";
import { useSearch } from "./hooks/use-search.js";
import { useStarred } from "./hooks/use-starred.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { useMarketplaceAnnouncements } from "./hooks/use-marketplace-announcements.js";
import type { MarketplaceAnnouncementActionTarget } from "../../shared/marketplace-announcements.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { requestUpdateReview } from "./tabs/git-marketplace/update-review-request.js";
import type { PackageUpdateView } from "../../shared/git-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useWindowFileDropGuard } from "./hooks/use-window-file-drop-guard.js";
import { normalizeSettingsTab, type SettingsPath } from "../../shared/settings-tabs.js";
import {
  BUILTIN_LABEL_KEYS,
  BUILTIN_VIEW_ICONS,
  toViewLocation,
  viewLocationBreadcrumb,
  type PaneViewKey,
  type ViewLocation,
} from "./utils/view-location.js";
import { useViewHistory } from "./hooks/use-view-history.js";
import { useViewHistoryShortcuts } from "./hooks/use-view-history-shortcuts.js";
import type { ProjectIdentity } from "../../shared/project-identity.js";
import {
  defaultProjectFromProjects,
  findWorkspaceProject,
  projectIdentityFromPayload,
  reconcileActiveProject,
  workspaceRootsToProjects,
} from "../../shared/project-identity.js";
import { formatIpcError } from "./format-ipc-error.js";
import type { ProjectErrorReporter } from "./hooks/use-add-project-folder.js";
import { TEST_IDS } from "../../shared/test-ids.js";
import { errorMessage } from "../../shared/error-message.js";

/** A canvas not laid out yet measures 0x0 — that is "unmeasured", not "no room". */
function measuredCanvasSize(canvas: HTMLElement | null) {
  return canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0
    ? { width: canvas.clientWidth, height: canvas.clientHeight }
    : undefined;
}

export function App() {
  const { locale, t } = useTranslation();
  const api = useMemo(() => getApi(), []);

  // Prevent dropped files from navigating the window to file://.
  useWindowFileDropGuard();

  // Read the focused tile through the session registry; see chat-group-session-registry.ts for store lifetime.
  const chatGroupSessions = useMemo(() => new ChatGroupSessionRegistry(), []);

  // The conversation list belongs to the window, independently of tile sessions.
  const { sessions, refreshSessions } = useSessionList(api);

  // Window-scoped toasts subscribe before plugin auth can emit them.
  const {
    persistent: statusPersistent,
    visibleToast: statusVisibleToast,
    pendingCount: statusPendingCount,
    pushToast: statusPushToast,
    removeToast: statusRemoveToast,
  } = useStatusBar({ api });

  // Notification clicks restore and focus the window through notifyClick; other toasts carry no notification.
  const handleStatusToastClick = useCallback(
    (toast: { id: string; notification?: NotificationToastMeta }) => {
      if (!toast.notification) return;
      try {
        void api.notifyClick?.({
          kind: toast.notification.kind,
          contextRef: toast.notification.contextRef,
        });
      } catch {
        // notifyClick is best-effort UX; failure must not crash the bar.
      }
      statusRemoveToast(toast.id);
    },
    [api, statusRemoveToast],
  );

  // Download and install require a badge click; unsigned macOS builds use a manual-install toast.
  const appUpdate = useAppUpdate(api, () => {
    // Unsigned macOS builds require manual installation; the host has opened the update guide.
    statusPushToast({
      severity: "warning",
      message: t("app.manualInstallRequiredToast"),
      ttlMs: 20000,
    });
  });

  const {
    onTourComplete,
    onTourDismiss,
    checkApiKey,
    effectiveHasApiKey,
    documentEngineOnboardingOpen,
    dismissDocumentEngineOnboarding,
  } = useOnboardingTourController(api);
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  // Persist the current settings tab and return view so restart resumes the same page.
  const { settingsTab, setSettingsTab, restoresApplied: settingsTabRestoresApplied } =
    useSettingsTab(api);
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null);
  const chatGroupCanvasRef = useRef<HTMLDivElement>(null);
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  const handleCanvasRef = useCallback((element: HTMLDivElement | null) => {
    chatGroupCanvasRef.current = element;
    setCanvasElement(element);
  }, []);
  // Persisted sidebar width drives both the card and the canvas reserve.
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = usePanelWidth(api, SIDEBAR_WIDTH_PREF);
  const pushThreshold = sidebarPushThreshold(sidebarWidth);
  const { isNarrow: sidebarNarrow, width: shellWidth } = useContainerNarrow(shellElement, {
    enter: pushThreshold, exit: pushThreshold + NARROW_DEAD_BAND_PX,
  });
  const { sidebarState, setSidebarState } = useSidebarState(api, shellWidth);
  const sidebarCollapsed = sidebarState === "rail";
  const sidebarHidden = sidebarState === "hidden";
  const sidebarOverlay = sidebarNarrow && sidebarState === "expanded";
  const sidebarFocusPending = useRef(false);
  useEffect(() => {
    if (!sidebarFocusPending.current) return;
    sidebarFocusPending.current = false;
    shellElement?.querySelector<HTMLButtonElement>(sidebarHidden
      ? '[data-testid="sidebar-show"]'
      : '[data-testid="sidebar-collapse-toggle"]')?.focus({ preventScroll: true });
  }, [sidebarHidden, shellElement]);
  const hideSidebar = useCallback(() => {
    sidebarFocusPending.current = true;
    setSidebarState("hidden");
  }, [setSidebarState]);
  const showSidebar = useCallback(() => {
    sidebarFocusPending.current = true;
    setSidebarState("expanded");
  }, [setSidebarState]);

  // Tile geometry follows docs/design/tiled-chat-groups.md.
  const chatGroups = useChatGroups(canvasElement);
  const mainSurfaces = useMainSurfaces();
  // Pane layout, terminal directories and page addresses persist across launches.
  useMainLayout(api, chatGroups, mainSurfaces);
  // Watch every terminal for attention notifications, including hidden terminals.
  const terminalNotificationTitle = useCallback(() => t("mainPanels.terminalNotificationTitle"), [t]);
  useTerminalAttentionWatcher(api.terminal, terminalNotificationTitle);

  /** Window controls address the focused tile, including search, streaming status and tour prefills. */
  // Split along the longer pixel dimension; tree fractions alone cannot identify it.
  const focusedSession = useChatGroupSession(chatGroupSessions, chatGroups.focusedId);
  const tileSessions = useTileSessions(chatGroupSessions);
  const { entries, streaming, currentSessionId, currentSessionProject } = focusedSession;
  const settings = useSettings(api);

  const {
    open: searchOpen, query: searchQuery, caseSensitive: searchCase,
    matches: searchMatches, matchSet: searchMatchSet, matchIdx: searchIdx, highlight: searchHighlight,
    changeQuery: searchChangeQuery, toggleCase: searchToggleCase,
    openOverlay: searchOpenOverlay, toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev, jumpToMatch: searchJumpToMatch,
  } = useSearch(entries as unknown as ChatEntry[], {
    processingDisplayLevel: settings.processingDisplayLevel,
    streaming,
  });

  const handleExport = useCallback(async (format: "markdown" | "json", sessionId?: string) => {
    try { await api.chatExport(format, sessionId); }
    catch (err) { console.warn("[ave] export failed:", errorMessage(err)); }
  }, [api]);

  // Import creates a new session and returns its id; it never overwrites the current session.
  const handleImport = useCallback(async (): Promise<string | null> => {
    try {
      const result = await api.chatImport();
      return result.ok ? result.sessionId : null;
    } catch (err) {
      console.warn("[ave] import failed:", errorMessage(err));
      return null;
    }
  }, [api]);

  // Focus an existing tile instead of loading its session twice. Refs keep shared callbacks stable during streaming.
  const chatGroupsRef = useRef(chatGroups);
  chatGroupsRef.current = chatGroups;
  const { focus: focusGroup } = chatGroups;
  const focusChatGroup = useCallback((chatGroupId: string): boolean => {
    const { tree, focusedId } = chatGroupsRef.current;
    // A host focus request can race a tile close; never focus an id absent from the tree.
    if (chatGroupId === focusedId || !leafIds(tree).includes(chatGroupId)) return false;
    focusGroup(chatGroupId);
    return true;
  }, [focusGroup]);
  // Card placement needs all tile sessions plus the focused pane for cards with no conversation owner.
  const overlayCardTileForWindow = useCallback(
    (card: { originSessionId?: string }): OverlayCardPlacement =>
      overlayCardTile(tileSessions, chatGroups.focusedId, card),
    [tileSessions, chatGroups.focusedId],
  );

  // Fire-and-forget: a removed group is no longer addressable by the window.
  const releaseChatGroupLoop = useCallback((chatGroupId: string) => {
    void chatGroupApi(api, chatGroupId).chatGroupRelease().catch((err: unknown) => {
      console.warn("[ave] chat group release failed: %s", errorMessage(err));
    });
  }, [api]);

  // Release conversations on tile close or idle-group adoption, never when the canvas folds.
  const closeChatGroup = useCallback((chatGroupId: string) => {
    chatGroups.close(chatGroupId);
    releaseChatGroupLoop(chatGroupId);
  }, [chatGroups, releaseChatGroupLoop]);

  const [pendingSessionDrop, setPendingSessionDrop] =
    useState<{ chatGroupId: string; sessionId: string } | null>(null);

  // Hold the requested project on the adopted tile until hydration; a refused adoption must leave the window project
  // unchanged.
  const [freshProjectByGroup, setFreshProjectByGroup] =
    useState<ReadonlyMap<string, ProjectIdentity>>(() => new Map());
  const liveGroupIds = useMemo(
    () => new Set(chatGroups.groups.map((group) => group.id)),
    [chatGroups.groups],
  );
  useEffect(() => {
    setFreshProjectByGroup((current) => pruneGroupRequests(current, liveGroupIds, tileSessions));
  }, [liveGroupIds, tileSessions]);

  const focusTileHolding = useCallback((sessionId: string): boolean => {
    const holder = tileHoldingSession(tileSessions, sessionId);
    if (holder === undefined) return false;
    // A session in the focused tile is already reached even when focusChatGroup reports no focus change.
    focusChatGroup(holder.chatGroupId);
    return true;
  }, [tileSessions, focusChatGroup]);

  /** Adopt beside a busy group, or return null at the busy-group ceiling. Deliver the session after the new tile publishes
   * its handle. */
  const adoptGroupBeside = useCallback((targetGroupId: string): string | null => {
    const adopted = chatGroupsRef.current.adopt(targetGroupId, (chatGroupId) => {
      const each = tileSessions.find((candidate) => candidate.chatGroupId === chatGroupId);
      // Treat a group with no published tile as busy; releasing it could abort an unseen turn.
      if (each === undefined) return false;
      return !each.streaming;
    }, measuredCanvasSize(chatGroupCanvasRef.current));
    if (!adopted) {
      statusPushToast({
        severity: "warning",
        message: t("app.conversationCeilingReached", { count: MAX_CHAT_GROUPS }),
        ttlMs: 8_000,
      });
      return null;
    }
    if (adopted.released !== null) {
      releaseChatGroupLoop(adopted.released);
      // Disclose replacement of a tile: the session persists, but its draft and scroll position do not.
      statusPushToast({
        severity: "info",
        message: t("app.conversationSetAside"),
        ttlMs: 8_000,
      });
    }
    return adopted.chatGroupId;
  }, [releaseChatGroupLoop, statusPushToast, t, tileSessions]);

  /** Never swap sessions on a running loop: saveSession would write one conversation into the other session file. */
  const reachSession = useCallback(async (
    sessionId: string,
    targetGroupId: string,
  ): Promise<boolean> => {
    if (focusTileHolding(sessionId)) return true;
    const target = tileSessions.find((tile) => tile.chatGroupId === targetGroupId);
    const tile = chatGroupSessions.read(targetGroupId);
    if (target !== undefined && !target.streaming && tile) return tile.loadSession(sessionId);
    const adoptedGroupId = adoptGroupBeside(targetGroupId);
    if (adoptedGroupId === null) return false;
    // Deliver the adopted session when its tile publishes a handle.
    setPendingSessionDrop({ chatGroupId: adoptedGroupId, sessionId });
    return true;
  }, [adoptGroupBeside, chatGroupSessions, focusTileHolding, tileSessions]);

  const handleLoadSessionAndRefresh = useCallback(
    (sessionId: string) => reachSession(sessionId, chatGroupsRef.current.focusedId),
    [reachSession],
  );

  const handleImportAndLoad = useCallback(async () => {
    const sessionId = await handleImport();
    if (!sessionId) return;
    await handleLoadSessionAndRefresh(sessionId);
  }, [handleImport, handleLoadSessionAndRefresh]);

  /** Edge drops create a tile; defer loading until that tile publishes its handle. */
  const handleSessionDrop = useCallback((
    targetGroupId: string,
    sessionId: string,
    target: DropTarget,
  ) => {
    const holder = tileHoldingSession(tileSessions, sessionId);
    if (holder) {
      chatGroups.focus(holder.chatGroupId);
      return;
    }
    if (target === "center") {
      chatGroups.focus(targetGroupId);
      // Use reachSession for center drops so a busy tile can adopt a group instead of silently refusing the load.
      void reachSession(sessionId, targetGroupId);
      return;
    }
    const created = chatGroups.dropOnEdge(targetGroupId, target);
    // The frame disables edge drops at the four-tile ceiling.
    if (created) setPendingSessionDrop({ chatGroupId: created, sessionId });
  }, [chatGroups, reachSession, tileSessions]);

  useEffect(() => {
    if (!pendingSessionDrop) return;
    const { chatGroupId, sessionId } = pendingSessionDrop;
    const deliver = () => {
      const tile = chatGroupSessions.read(chatGroupId);
      if (!tile) return false;
      void tile.loadSession(sessionId);
      setPendingSessionDrop(null);
      return true;
    };
    if (deliver()) return;
    return chatGroupSessions.subscribe(chatGroupId, () => { deliver(); });
  }, [pendingSessionDrop, chatGroupSessions]);

  /** Move surface ownership and pane location together; the surface itself stays mounted. */
  const surfaceMoves = useMemo<SurfaceMoves>(() => {
    const sinkOf = (chatGroupId: string) => {
      const sink = getSideTabsSink(chatGroupId);
      // Every pane must have a mounted conversation group and side panel.
      if (!sink) throw new Error(`side-tabs-sink-missing:${chatGroupId}`);
      return sink;
    };
    const guestUrl = (tabId: string) => getWebSurfaces().find((each) => each.tabId === tabId)?.url ?? null;
    const tabToSide: SurfaceMoves["tabToSide"] = (tabId, toGroupId) => {
      const sink = sinkOf(toGroupId);
      if (sink.activate(tabId)) {
        chatGroups.focus(toGroupId);
        return;
      }
      const surface = mainSurfaces.release(tabId);
      let adopted = false;
      if (surface) {
        sink.adopt({ id: surface.tabId, kind: surface.kind, ordinal: surface.ordinal }, surface.kind === "browser" ? guestUrl(tabId) : null);
        adopted = true;
        for (const [paneId, content] of Object.entries(chatGroups.contentById)) {
          if (content?.surface === tabId) chatGroups.setPaneContent(paneId, PANE_HOME);
        }
      } else {
        for (const group of chatGroups.groups) {
          if (group.id === toGroupId) continue;
          const source = sinkOf(group.id);
          if (!source.snapshot().some((tab) => tab.tabId === tabId)) continue;
          const tab = source.release(tabId);
          if (!tab) return;
          sink.adopt(tab, tab.kind === "browser" ? guestUrl(tabId) : null);
          adopted = true;
          break;
        }
      }
      if (!adopted) return;
      sink.open();
      chatGroups.focus(toGroupId);
    };
    return {
      tabToSide,
      tabToMain: (fromGroupId, tabId, drop) => {
        const sink = sinkOf(fromGroupId);
        const tab = sink.release(tabId);
        if (!tab) return;
        if (!isMovableTabKind(tab.kind)) throw new Error(`surface-not-movable:${tab.kind}`);
        mainSurfaces.adopt({ tabId, kind: tab.kind, ordinal: tab.ordinal, url: tab.kind === "browser" ? guestUrl(tabId) : null });
        const location: ViewLocation = { view: VIEW_OF_SURFACE_KIND[tab.kind], surface: tabId };
        if (drop) {
          const placed = drop.target === "center" ? null : chatGroups.placeOnEdge(drop.paneId, drop.target, location);
          if (placed === null) {
            chatGroups.setPaneContent(drop.paneId, location);
            chatGroups.focus(drop.paneId);
          }
          return;
        }
        const beside = chatGroups.canSplit
          && chatGroups.splitFits(fromGroupId, "row", measuredCanvasSize(chatGroupCanvasRef.current))
          ? chatGroups.placeOnEdge(fromGroupId, "right", location)
          : null;
        if (beside === null) chatGroups.setPaneContent(fromGroupId, location);
      },
      paneToSide: (paneId, toGroupId = paneId) => {
        const surfaceId = chatGroups.contentById[paneId]?.surface;
        if (!surfaceId) return;
        tabToSide(surfaceId, toGroupId);
      },
    };
  }, [chatGroups, mainSurfaces]);

  const handleSurfaceDrop = useCallback((targetPaneId: string, payload: SurfaceDragPayload, target: DropTarget) => {
    if ("side" in payload.from) {
      surfaceMoves.tabToMain(payload.from.side, payload.tabId, { paneId: targetPaneId, target });
      return;
    }
    const fromPane = payload.from.pane;
    if (fromPane === targetPaneId) return;
    const location = chatGroups.contentById[fromPane];
    if (!location?.surface) return;
    const placed = target === "center" ? null : chatGroups.placeOnEdge(targetPaneId, target, location, fromPane);
    if (placed === null) chatGroups.movePaneContent(fromPane, targetPaneId);
  }, [chatGroups, surfaceMoves]);

  const reopenClosedSurface = useCallback(() => {
    const closed = mainSurfaces.takeLastClosed();
    if (!closed) return;
    // Restore terminals at their last directory and pages at their last address.
    const surface = mainSurfaces.create(closed.kind, closed.url, closed.cwd);
    chatGroups.setPaneContent(chatGroups.focusedId, { view: VIEW_OF_SURFACE_KIND[closed.kind], surface: surface.tabId });
  }, [chatGroups, mainSurfaces]);

  const activeSurfaceOf = useCallback((surface: MainSurface): ActiveSurface => ({
    kind: surface.kind,
    tabId: surface.tabId,
    label: `${t(BUILTIN_LABEL_KEYS[VIEW_OF_SURFACE_KIND[surface.kind]])} ${surface.ordinal}`,
    cwd: surface.cwd ?? null,
  }), [t]);
  const mainBrowserHostRef = useRef({ chatGroups, mainSurfaces });
  mainBrowserHostRef.current = { chatGroups, mainSurfaces };
  const openWorkspaceSurface = useCallback((tabId: string) => {
    const { chatGroups: groups, mainSurfaces: surfaces } = mainBrowserHostRef.current;
    const surface = surfaces.get(tabId);
    if (surface) {
      const paneId = Object.entries(groups.contentById).find(([, content]) => content?.surface === tabId)?.[0];
      if (paneId) {
        groups.focus(paneId);
      } else groups.setPaneContent(groups.focusedId, { view: VIEW_OF_SURFACE_KIND[surface.kind], surface: tabId });
      showActiveSurface(activeSurfaceOf(surface));
      return true;
    }
    const groupId = activateSideTab(tabId);
    if (groupId) {
      groups.setPaneContent(groupId, PANE_HOME);
      groups.focus(groupId);
      const selected = getSideTabsSink(groupId)?.snapshot().find((entry) => entry.tabId === tabId);
      if (!selected) throw new Error("Selected surface is missing");
      showActiveSurface(activeSurfaceOf(selected));
      return true;
    }
    return false;
  }, [activeSurfaceOf]);

  /** Show the most recent live terminal asking for attention; discard stale entries until one can be shown. */
  const jumpToUnreadTerminal = useCallback(() => {
    for (let latest = latestUnreadTerminal(); latest; latest = latestUnreadTerminal()) {
      const { tabId } = latest;
      const opened = openWorkspaceSurface(tabId);
      markTerminalRead(tabId);
      if (opened) return;
    }
  }, [openWorkspaceSurface]);

  // The reported side-chat target is also the default for agent tools that name no tab.
  useReportActiveSurface(api);
  // Closing a surface stops and archives its pane chat.
  useEffect(() => subscribeSurfaceClosed((tabId) => {
    const sideChat = api.sideChat;
    if (!sideChat) return;
    void sideChat.endPaneChat(tabId, "closed").then((res) => {
      if (!res.ok) console.warn(`pane chat for ${tabId} not ended: ${res.error}`);
      else if (res.sessionId !== null) void refreshSessions();
    }, (err: unknown) => console.warn(`pane chat for ${tabId} not ended: ${errorMessage(err)}`));
  }), [api, refreshSessions]);

  // Main-area browser selection reveals an existing page; new agent tabs belong beside the requesting chat.
  useEffect(() => connectBrowserObservations(window.ave.preview), []);
  useEffect(() => registerBrowserTabHost(api, {
    sessionId: () => null,
    hasTab: (tabId) => mainBrowserHostRef.current.mainSurfaces.get(tabId)?.kind === "browser",
    selectTab: openWorkspaceSurface,
    closeTab: (tabId) => {
      const { chatGroups: groups, mainSurfaces: surfaces } = mainBrowserHostRef.current;
      for (const [paneId, content] of Object.entries(groups.contentById)) {
        if (content?.surface === tabId) groups.setPaneContent(paneId, PANE_HOME);
      }
      surfaces.close(tabId);
      forgetActiveSurface(tabId);
    },
  }), [api, openWorkspaceSurface]);

  // Pane focus selects the side-chat target; later shell directory reports only update that target.
  const focusedSurfaceId = chatGroups.contentById[chatGroups.focusedId]?.surface;
  const focusedMainSurface = focusedSurfaceId ? mainSurfaces.surfaces.find((each) => each.tabId === focusedSurfaceId) : undefined;
  const focusedActiveSurface: ActiveSurface | null = focusedMainSurface
    ? activeSurfaceOf(focusedMainSurface)
    : null;
  const focusedActiveSurfaceRef = useRef(focusedActiveSurface);
  focusedActiveSurfaceRef.current = focusedActiveSurface;
  useEffect(() => {
    if (focusedActiveSurfaceRef.current) showActiveSurface(focusedActiveSurfaceRef.current);
  }, [chatGroups.focusedId, focusedActiveSurface?.tabId]);
  useEffect(() => {
    if (focusedActiveSurfaceRef.current) updateActiveSurface(focusedActiveSurfaceRef.current);
  }, [focusedActiveSurface?.label, focusedActiveSurface?.cwd]);

  const runPanelCommand = useCallback((id: PanelCommandId) => {
    const focused = chatGroups.focusedId;
    switch (id) {
      case "pane.moveLeft":
      case "pane.moveRight":
      case "pane.moveUp":
      case "pane.moveDown": {
        if (!chatGroups.contentById[focused]?.surface) return;
        const direction = ({ "pane.moveLeft": "left", "pane.moveRight": "right", "pane.moveUp": "up", "pane.moveDown": "down" } as const)[id];
        const neighbor = chatGroups.paneNeighbor(focused, direction);
        if (neighbor) chatGroups.movePaneContent(focused, neighbor);
        return;
      }
      case "pane.toggleMaximize":
        if (chatGroups.canMaximize) chatGroups.toggleMaximize(focused);
        return;
      case "surface.reopenClosed":
        reopenClosedSurface();
        return;
      case "terminal.jumpToUnread":
        jumpToUnreadTerminal();
        return;
    }
  }, [chatGroups, reopenClosedSurface, jumpToUnreadTerminal]);

  // Capture panel chords before terminal textareas can swallow them.
  const runPanelCommandRef = useRef(runPanelCommand);
  runPanelCommandRef.current = runPanelCommand;
  useEffect(() => {
    const darwin = isDarwin();
    const onKeyDown = (event: KeyboardEvent) => {
      const id = panelCommandFor(event, darwin);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      runPanelCommandRef.current(id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const {
    isProjectPinned,
    toggleProjectPin,
    isProjectArchived,
    toggleProjectArchived,
    projectLabel,
    setProjectLabel,
  } = useProjectPreferences(api);
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [devLabelsOn, setDevLabelsOn] = useState(false);
  const [workspaceProjects, setWorkspaceProjects] = useState<ProjectIdentity[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectIdentity | undefined>(undefined);

  // Bind dev-tool shortcuts only in dev mode; packaged builds expose no dev IPC handlers.
  useEffect(() => {
    if ((window as unknown as { __aveDevMode?: boolean }).__aveDevMode !== true) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDevToolsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const { updates: marketplaceUpdates, skip: skipMarketplaceUpdates } = useMarketplaceUpdates(api);
  const { announcements: marketplaceAnnouncements, dismiss: dismissMarketplaceAnnouncement } = useMarketplaceAnnouncements(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const approvals = useApproval();
  const { queue: approvalQueue, decide: handleApprovalDecide, claims: approvalClaims } = approvals;
  // Conversation cards stay with their owning surface; unowned host/plugin cards use the focused pane. One selector drives
  // both cards and attention dots.
  const deferredSessionIds = useDeferredSessionIds(api.permission);
  const [overlayQueue, setOverlayQueue] = useState<readonly OverlayItem[]>([]);
  // Terminal egress asks use the tab banner while mounted, otherwise the pane lane, so hidden tabs can still be answered.
  const surfaceMountRevision = useSurfaceMountRevision();
  const dockApprovals = useMemo(
    () => approvalsForDocks(approvalQueue, (tabId) => surfaceMountLocation(tabId) !== null),
    // The revision is what makes `surfaceMountLocation` worth re-reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvalQueue, surfaceMountRevision],
  );
  // The pane-chat claim identifies card ownership for chats outside the tile registry.
  const approvalClaimsVersion = useSyncExternalStore(approvalClaims.subscribe, approvalClaims.readVersion, approvalClaims.readVersion);
  const pendingAnswers = useMemo(() => selectPendingAnswers({
    approvals: dockApprovals,
    tiles: tileSessions,
    deferredSessionIds,
    overlayCards: overlayQueue,
    sessions,
    isClaimed: (sessionId) => approvalClaims.ownerOf(sessionId) !== null,
  }), [dockApprovals, tileSessions, deferredSessionIds, overlayQueue, sessions, approvalClaims, approvalClaimsVersion]);
  const laneApprovalHead = pendingAnswers.unattributed[0] ?? null;
  const suggestionsPendingCount = useMemo(
    () => overlayQueue.filter((card) => isSuggestionsSession(card.originSessionId)).length,
    [overlayQueue],
  );
  // Subscribe once per window to avoid duplicate permission-memory and reviewer disclosures across tiles.
  const { userApprovalHitToast, reviewerSuggestion } = usePermissionSignals();
  const [exactDenyDraft, setExactDenyDraft] = useState<ExactDenyDraft | null>(null);
  // Only out-of-directory cards consume /allow proposals; other approval forms cannot display them.
  const approvalSentenceTarget = useMemo(() => {
    const inFocusedTile = approvalQueue.find((req) =>
      req.kind === "out-of-allowed-dir"
        && req.sessionId !== undefined
        && approvalClaims.ownerOf(req.sessionId) === chatGroups.focusedId);
    if (inFocusedTile !== undefined) return inFocusedTile;
    return pendingAnswers.unattributed.find((req) => req.kind === "out-of-allowed-dir") ?? null;
  }, [approvalQueue, approvalClaims, chatGroups.focusedId, pendingAnswers.unattributed]);
  const {
    proposedChoice: approvalProposedChoice,
    interceptSubmit: interceptApprovalSentence,
  } = useApprovalSentence({
    approvalRequest: approvalSentenceTarget,
    onNotice: (message: string) => focusedSession.appendSystemEntry(message),
  });
  const approvalProposal = useMemo(
    () => (approvalSentenceTarget !== null && approvalProposedChoice !== null
      ? { requestId: approvalSentenceTarget.id, choice: approvalProposedChoice }
      : null),
    [approvalSentenceTarget, approvalProposedChoice],
  );

  // Routine primary actions reach the card-owning tile through the registry.
  const { pluginViews, pluginCards, refreshViews, refreshCards } = usePluginMarketplace(api);

  // Restore plugin views only after the installed-view list confirms they still exist.
  const loadedPluginViewKeys = useMemo(
    () => pluginViews.map((view) => toViewKey(view)),
    [pluginViews],
  );
  // The new-pane navigation claim lasts one gesture.
  const newPaneTargetRef = useRef<string | null>(null);
  // The focused pane owns the active location; useActiveView owns restoration and persistence.
  /** Bare terminal/web destinations reuse an unshown surface before creating one; fresh always creates an instance. */
  const showInstanceView = useCallback((paneId: string, view: InstanceViewKey, fresh = false) => {
    const kind = SURFACE_KIND_OF_VIEW[view];
    const shown = new Set(Object.values(chatGroups.contentById).map((content) => content.surface));
    const unshown = fresh
      ? undefined
      : [...mainSurfaces.surfaces].reverse().find((surface) => surface.kind === kind && !shown.has(surface.tabId));
    const surface = unshown ?? mainSurfaces.create(kind);
    chatGroups.setPaneContent(paneId, { view, surface: surface.tabId });
  }, [chatGroups, mainSurfaces]);
  const activeViewPane = useMemo(() => ({
    view: chatGroups.contentById[chatGroups.focusedId]?.view ?? "home",
    navigate: (next: InlineViewKey) => {
      // Route within the creating event to avoid recording the new pane's blank conversation in history.
      const paneId = newPaneTargetRef.current ?? chatGroups.focusedId;
      if (isInstanceViewKey(next)) {
        // A new-pane gesture creates a surface instance instead of moving a running one.
        showInstanceView(paneId, next, newPaneTargetRef.current !== null);
        return;
      }
      chatGroups.setPaneContent(paneId, { view: next });
    },
  }), [chatGroups.contentById, chatGroups.focusedId, chatGroups.setPaneContent, showInstanceView]);
  const { activeView, setActiveView, restoresApplied: activeViewRestoresApplied } =
    useActiveView(api, loadedPluginViewKeys, activeViewPane);
  // Summed monotonic restore counters signal completion of either location half.
  const restoresApplied = activeViewRestoresApplied + settingsTabRestoresApplied;
  // History includes the settings tab and surface id so return visits resolve the same page or instance.
  const focusedSurface = chatGroups.contentById[chatGroups.focusedId]?.surface;
  const location = useMemo(() => {
    const base = toViewLocation(activeView, settingsTab);
    return isInstanceViewKey(activeView) && focusedSurface ? { ...base, surface: focusedSurface } : base;
  }, [activeView, settingsTab, focusedSurface]);
  // Restore both location halves so settings history returns to the recorded tab.
  const navigateToLocation = useCallback((to: ViewLocation) => {
    if (to.view === "settings") setSettingsTab(to.settingsTab ?? "llm");
    // Reuse a live surface; a closed one resolves as a bare destination.
    if (to.surface && mainSurfaces.surfaces.some((surface) => surface.tabId === to.surface)) {
      chatGroups.setPaneContent(chatGroups.focusedId, to);
      return;
    }
    setActiveView(to.view);
  }, [setSettingsTab, setActiveView, mainSurfaces.surfaces, chatGroups]);
  // Settings-section targets are one-shot events; persisting them would replay scrolling on every history visit.
  const [settingsSectionTarget, setSettingsSectionTarget] = useState<string | null>(null);
  const clearSettingsSectionTarget = useCallback(() => setSettingsSectionTarget(null), []);
  const navigateToSettingsPath = useCallback(
    (path: SettingsPath) => {
      navigateToLocation({ view: "settings", settingsTab: path.tab });
      setSettingsSectionTarget(path.section ?? null);
    },
    [navigateToLocation],
  );
  // Refresh the list after a Suggestions card arrives so its row receives the attention count.
  const refreshSessionsOnSuggestion = useCallback(() => { void refreshSessions(); }, [refreshSessions]);
  const {
    addFireRef,
    dismissRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleContinueInNewConversation,
    handleAlertDismiss,
    handleRoutineAcknowledge,
    handleProposalAnswer,
  } = useRoutineOverlay({
    api, t, locale, registry: chatGroupSessions,
    onNavigateToSettings: navigateToSettingsPath,
    onSuggestionStaged: refreshSessionsOnSuggestion,
  });

  const viewHistory = useViewHistory(location, navigateToLocation, restoresApplied);
  useViewHistoryShortcuts(viewHistory);

  const handleOpenPermanentDeny = useCallback((
    request: ApprovalRequest,
    verdictAtApproval: UserApprovalVerdict,
  ) => {
    setExactDenyDraft({
      requestId: request.id,
      toolName: request.toolName,
      args: request.args,
      source: request.source ?? "builtin",
      trustOrigin: request.trustOrigin,
      approvalCacheKey: request.approvalCacheKey,
      verdictAtApproval,
    });
    navigateToLocation({ view: "settings", settingsTab: "permissions" });
  }, [navigateToLocation]);

  const handleExactDenySaved = useCallback((requestId: string) => {
    setExactDenyDraft((current) => current?.requestId === requestId ? null : current);
    if (approvalQueue.some((req) => req.id === requestId)) {
      void handleApprovalDecide(requestId, "deny-once");
    }
  }, [approvalQueue, handleApprovalDecide]);

  useEffect(() => {
    if (exactDenyDraft && !approvalQueue.some((req) => req.id === exactDenyDraft.requestId)) {
      setExactDenyDraft(null);
    }
  }, [approvalQueue, exactDenyDraft]);

  const approvalSurface = useMemo<ApprovalSurfaceContextValue>(() => ({
    ...approvals,
    openPermanentDeny: handleOpenPermanentDeny,
    lockedRequestId: exactDenyDraft?.requestId ?? null,
    proposal: approvalProposal,
    reviewerSuggestion,
  }), [approvals, handleOpenPermanentDeny, exactDenyDraft, approvalProposal, reviewerSuggestion]);

  // Share one plugin-auth poll and event subscription across window surfaces.
  const { statuses: pluginAuthStatuses, refresh: refreshPluginAuthStatus } = usePluginAuthStatuses(api, pluginCards);

  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets(api);
  const {
    starred,
    refreshStarred,
    isEntryStarred: starredIsEntry,
    handleToggleStar: starredToggle,
    isSessionStarred,
    handleToggleSessionStar,
  } = useStarred(api);
  const handleProjectError = useCallback<ProjectErrorReporter>((operation, error, message) => {
    statusPushToast({
      severity: "error",
      message: formatIpcError(error, message, {
        // Unknown codes use a contextual fallback; the file-browser label avoids the menu label's trailing ellipsis.
        fallbackContext: operation === "add"
          ? t("chatPreviewRail.addProjectRoot")
          : operation === "remove"
            ? t("sidebar.projectMenuRemove")
            : operation === "new-chat"
              ? t("mainToolbar.newChat")
              : t("sidebar.projectsLabel"),
      }),
      ttlMs: 10_000,
    });
  }, [statusPushToast, t]);

  // Toast project-list faults only on condition changes; clear the memory after recovery.
  const reportedListFault = useRef<string | null>(null);
  const reportProjectListFault = useCallback((code: string) => {
    if (reportedListFault.current === code) return;
    reportedListFault.current = code;
    handleProjectError("list", code);
  }, [handleProjectError]);

  const refreshWorkspaceProjects = useCallback(async () => {
    try {
      const result = await window.ave?.workspace?.listRoots?.();
      if (!result?.ok) {
        // Report unreadable project lists instead of silently presenting them as empty.
        if (result?.error) reportProjectListFault(result.error);
        return;
      }
      if (result.settingsFault) reportProjectListFault(result.settingsFault);
      else reportedListFault.current = null;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      // The default project is hidden from display surfaces, so its fallback basename is never shown.
      const projects = workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.projectsLabel"));
      setWorkspaceProjects(projects);
      setActiveProject((current) => reconcileActiveProject(current, projects));
    } catch {
      // The backend still defaults chat creation to the anchored workspace root.
    }
  }, [reportProjectListFault, t]);

  useEffect(() => {
    void refreshWorkspaceProjects();
  }, [refreshWorkspaceProjects]);

  /** Main authorizes project roots; do not replace an explicit root missing from a stale renderer list. */
  const resolveKnownProject = useCallback((project: ProjectIdentity | undefined): ProjectIdentity | undefined => {
    if (!project) return undefined;
    return findWorkspaceProject(workspaceProjects, project) ?? project;
  }, [workspaceProjects]);

  useEffect(() => {
    // Wait for the focused tile to hydrate before following its project; an unpublished tile does not imply the default
    // project.
    if (!currentSessionId) return;
    const sessionProject = projectIdentityFromPayload(currentSessionProject);
    setActiveProject(reconcileActiveProject(sessionProject, workspaceProjects));
  }, [currentSessionId, currentSessionProject, workspaceProjects]);

  const defaultWorkspaceProject = useMemo(
    () => defaultProjectFromProjects(workspaceProjects),
    [workspaceProjects],
  );

  const handleOpenRoutineSession = useCallback(
    async (sessionId: string) => {
      // Switch from routines only after the requested conversation is reached.
      try {
        const loaded = await handleLoadSessionAndRefresh(sessionId);
        if (loaded !== false) setActiveView("home");
        return loaded;
      } catch (err) {
        console.warn("[ave] openRoutineSession failed:", errorMessage(err));
        return false;
      }
    },
    [handleLoadSessionAndRefresh, setActiveView],
  );

  useEffect(() => {
    if (!searchOpen) return;
    void refreshSessions();
    void refreshStarred();
  }, [refreshSessions, refreshStarred, searchOpen]);

  // Refresh the conversation list when work-board runs start or end.
  useEffect(() => {
    const unsubscribeStarted = api.onWorkBoardRunStarted(() => void refreshSessions());
    const unsubscribeFinished = api.onWorkBoardRunFinished(() => void refreshSessions());
    const unsubscribeFailed = api.onWorkBoardRunFailed(() => void refreshSessions());
    return () => {
      unsubscribeStarted();
      unsubscribeFinished();
      unsubscribeFailed();
    };
  }, [api, refreshSessions]);

  // Routine loops have no tile turn-end event; refresh their conversation rows separately.
  useEffect(() => {
    if (typeof api.onRoutineFired !== "function") return undefined;
    return api.onRoutineFired(() => void refreshSessions());
  }, [api, refreshSessions]);

  const {
    llmVendor,
    llmModel,
    llmContextWindow,
    llmOutputTokenLimit,
    llmInputLimit,
    autoCompactEnabled,
    llmRoutePricing,
    llmRouteModalities,
    enableThinkingChat,
    processingDisplayLevel,
    llmReadyWithoutApiKey,
    retiredLlmProvider,
    deprecatedLlmModel,
    subscriptionRuntimePolicy,
    refresh: refreshLlmSettings,
    settingsLoaded,
    toggleThinking,
    activeChatModel,
  } = settings;
  const {
    activeSubscriptionRuntime,
    subscriptionSelected: subscriptionRuntimeSelected,
    chatReady: subscriptionChatReady,
  } = subscriptionRuntimePolicy;
  const chatReadyWithoutApiKey = subscriptionRuntimeSelected
    ? subscriptionChatReady === true
    : llmReadyWithoutApiKey;
  // Hide billing/context projections until the authoritative runtime snapshot loads.
  const apiUsageProjectionAvailable = settingsLoaded && !subscriptionRuntimeSelected;
  const effectiveLlmReady = useMemo(
    () => {
      // Subscription readiness alone authorizes sending; pending or failed selections must not fall back to stale API keys.
      if (subscriptionRuntimeSelected) return subscriptionChatReady === true;
      // A removed provider keeps API chat unavailable until the user selects a replacement.
      if (retiredLlmProvider) return false;
      return effectiveHasApiKey === null
        ? (chatReadyWithoutApiKey ? true : null)
        : effectiveHasApiKey || chatReadyWithoutApiKey;
    },
    [effectiveHasApiKey, chatReadyWithoutApiKey, subscriptionChatReady, subscriptionRuntimeSelected, retiredLlmProvider],
  );
  const subscriptionUnavailableProvider = subscriptionRuntimePolicy.unavailableProvider;
  const subscriptionPendingProvider = subscriptionRuntimePolicy.pendingProvider;
  // Use activeChatModel for readiness, and wait for the settings snapshot before showing configuration alerts.
  const chatModelConfigured = settingsLoaded && activeChatModel
    ? activeChatModel.kind !== "none"
    : null;
  const subscriptionImageAttachmentProvider = subscriptionRuntimePolicy.imageAttachmentProvider;
  const subscriptionFileAttachmentProvider = subscriptionRuntimePolicy.fileAttachmentProvider;
  const {
    handleViewSelect,
    pluginPaneFor,
  } = usePluginViewRouting({
    api, t, activeView, setActiveView,
    pluginViews, pluginCards, pluginAuthStatuses, refreshPluginAuthStatus,
    statusPushToast,
  });

  // Resolve plugin path labels from declared titles so sidebar and toolbar agree.
  const viewNav = useMemo(() => {
    const deps = {
      t,
      pluginViewLabel: (viewKey: string) => {
        const view = pluginViews.find((candidate) => toViewKey(candidate) === viewKey);
        return view ? getPluginViewLabel(view, locale) : undefined;
      },
      // Default-workspace sessions are plain chats; only named projects label the root crumb.
      sessionProject: activeProject && !activeProject.isDefault ? activeProject : undefined,
    };
    // History buttons name their destinations even when the path cannot fit.
    const destinationLabel = (target: ViewLocation | null) =>
      target ? viewLocationBreadcrumb(target, deps).at(-1)?.label : undefined;
    return {
      segments: viewLocationBreadcrumb(location, deps),
      canGoBack: viewHistory.canGoBack,
      canGoForward: viewHistory.canGoForward,
      backLabel: destinationLabel(viewHistory.backTo),
      forwardLabel: destinationLabel(viewHistory.forwardTo),
      onBack: viewHistory.goBack,
      onForward: viewHistory.goForward,
      onSelectSegment: navigateToLocation,
    };
  }, [location, t, locale, pluginViews, viewHistory, navigateToLocation, activeProject]);

  // Share conversation actions between headers and sidebar menus. Plugin-grid auth indicators follow manifest.auth and live
  // status.
  const pluginEntries = useMemo<PluginEntry[]>(() => {
    const viewEntries: PluginEntry[] = pluginViews.map((view): PluginEntry => {
      const card = pluginCards.find((candidate) => candidate.id === view.pluginId);
      return {
        viewKey: toViewKey(view),
        pluginId: view.pluginId,
        loadStatus: card?.loadStatus,
        preparationStatus: card?.preparationStatus,
        label: getPluginViewLabel(view, locale),
        icon: view.icon,
        iconText: view.iconText,
        unauthed: pluginAuthStatuses.get(view.pluginId)?.kind === "unauthed",
      };
    });
    const viewKeys = new Set(viewEntries.map((entry) => entry.viewKey));
    const viewPluginIds = new Set(
      viewEntries
        .map((entry) => entry.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0),
    );
    const preparingCardEntries = pluginCards.flatMap((card) => {
      if (card.loadStatus !== "preparing") return [];
      return (card.uiExtensions ?? [])
        .map((extension): PluginEntry | null => {
          const viewKey = `plugin:${card.id}:${extension.id}`;
          if (viewKeys.has(viewKey)) return null;
          return {
            viewKey,
            pluginId: card.id,
            loadStatus: card.loadStatus,
            preparationStatus: card.preparationStatus,
            label: getPluginViewLabel({ pluginId: card.name, extension }, locale),
            icon: card.icon,
            iconText: card.iconText,
            unauthed: false,
          };
        })
        .filter((entry): entry is PluginEntry => entry !== null);
    });
    const failedCardEntries = pluginCards.flatMap((card): PluginEntry[] => {
      if (card.loadStatus !== "failed" || viewPluginIds.has(card.id)) return [];
      return [{
        viewKey: toPluginDoctorViewKey(card.id),
        pluginId: card.id,
        loadStatus: card.loadStatus,
        label: card.name,
        icon: card.icon,
        iconText: card.iconText,
        unauthed: false,
        doctorRequired: true,
      }];
    });
    return [...viewEntries, ...preparingCardEntries, ...failedCardEntries];
  }, [pluginViews, pluginAuthStatuses, pluginCards, locale]);

  const failedPluginCards = useMemo(() => {
    const pluginIdsWithViews = new Set(pluginViews.map((view) => view.pluginId));
    return pluginCards.filter((card) =>
      card.loadStatus === "failed" && !pluginIdsWithViews.has(card.id)
    );
  }, [pluginCards, pluginViews]);

  // Keep disabled sidebar extensions visible as settings shortcuts even though they have no live view.
  const inactivePluginCards = useMemo(() => {
    const pluginIdsWithViews = new Set(pluginViews.map((view) => view.pluginId));
    return pluginCards.filter((card) =>
      card.loadStatus === "disabled"
      && !pluginIdsWithViews.has(card.id)
      && (card.uiExtensions?.length ?? 0) > 0
    );
  }, [pluginCards, pluginViews]);

  useEffect(() => {
    if (typeof api.onNotificationClicked !== "function") return undefined;
    return api.onNotificationClicked((payload) => {
      const contextRef = payload.contextRef;
      if (contextRef?.sessionId) {
        setActiveView("home");
        void handleLoadSessionAndRefresh(contextRef.sessionId);
        return;
      }
      if (payload.kind === "approval" || contextRef?.approvalId) {
        setActiveView("home");
        if (approvalQueue.length === 0) setDeferredQueueOpen(true);
        return;
      }
      if (payload.kind === "routine" || contextRef?.routineId) {
        handleViewSelect("routines");
        return;
      }
      if (payload.kind === "ask-user" || contextRef?.questionId) {
        setActiveView("home");
        return;
      }
      setActiveView("home");
    });
  }, [api, approvalQueue.length, handleLoadSessionAndRefresh, handleViewSelect]);

  // Settings remains inline at every width; reselecting it changes the tab without remounting.
  const onOpenSettings = useCallback((tab = "llm") => {
    setSettingsTab(normalizeSettingsTab(tab));
    setActiveView("settings");
  }, []);
  // Updates install only through marketplace review.
  const reviewMarketplaceUpdates = useCallback((updates: PackageUpdateView[]) => {
    requestUpdateReview(updates);
    onOpenSettings("marketplace");
  }, [onOpenSettings]);

  const handleViewSelectWithDoctor = useCallback((key: string) => {
    // Disabled-plugin rows open their settings toggle without a warning toast.
    if (parsePluginSettingsViewKey(key)) {
      onOpenSettings("plugin-config");
      return;
    }
    const doctorPluginId = parsePluginDoctorViewKey(key);
    if (doctorPluginId) {
      const card = pluginCards.find((candidate) => candidate.id === doctorPluginId);
      statusPushToast({
        severity: "warning",
        message: t("app.pluginDoctorRequiredToast", { label: card?.name ?? doctorPluginId }),
        ttlMs: 10000,
      });
      onOpenSettings("plugin-config");
      return;
    }
    handleViewSelect(key);
  }, [handleViewSelect, onOpenSettings, pluginCards, statusPushToast, t]);

  // Board-item targets are consumed once rather than persisted as history locations.
  const [workBoardFocusItemId, setWorkBoardFocusItemId] = useState<number | null>(null);
  const openWorkBoardItem = useCallback((itemId: number) => {
    handleViewSelectWithDoctor("work-board");
    setWorkBoardFocusItemId(itemId);
  }, [handleViewSelectWithDoctor]);

  /** Side-chat requests are one-shot events; nonce distinguishes repeated requests for the same ids. */
  const [sideChatOpenRequest, setSideChatOpenRequest] = useState<
    { chatGroupId: string; sessionId: string; nonce: number } | null
  >(null);
  const sideChatRequestNonce = useRef(0);
  const openSideChat = useCallback(async (sideChatSessionId: string, originSessionId?: string) => {
    // Reach the parent conversation when possible; otherwise show the side chat beside the focused conversation.
    if (originSessionId !== undefined) {
      try {
        const loaded = await handleLoadSessionAndRefresh(originSessionId);
        if (loaded !== false) setActiveView("home");
      } catch (err) {
        console.warn("[ave] openSideChat parent load failed:", errorMessage(err));
      }
    } else {
      setActiveView("home");
    }
    setSideChatOpenRequest({
      chatGroupId: chatGroupsRef.current.focusedId,
      sessionId: sideChatSessionId,
      nonce: ++sideChatRequestNonce.current,
    });
  }, [handleLoadSessionAndRefresh, setActiveView]);

  /** Create and navigate in one commit to avoid a blank history entry; retain ordinary auth and duplicate-view gates. */
  const openViewInNewPane = useCallback((key: string) => {
    // Reject invalid destinations before allocating a pane.
    const parsed = parseInlineViewKey(key);
    if (!parsed) {
      console.warn(`[nav] ignoring unknown view key '${key}'`);
      return;
    }
    if (chatGroups.paneShowing({ view: parsed.key }) === undefined) {
      const opened = chatGroups.openPane(
        chatGroups.focusedId,
        measuredCanvasSize(chatGroupCanvasRef.current),
      );
      if (opened === null) {
        statusPushToast({ severity: "warning", message: t("app.newPaneNoRoom"), ttlMs: 6000 });
        return;
      }
      newPaneTargetRef.current = opened;
    }
    try {
      handleViewSelectWithDoctor(key);
    } finally {
      // Clear the navigation claim after this event so deferred sign-in cannot capture unrelated navigation.
      newPaneTargetRef.current = null;
    }
  }, [chatGroups, handleViewSelectWithDoctor, statusPushToast, t]);

  // Leaving home closes the side panel; opening it elsewhere first returns home. Inline settings saves refresh live
  // configuration directly.
  const handleInlineSettingsSaved = useCallback(() => {
    void checkApiKey();
    void refreshLlmSettings();
  }, [checkApiKey, refreshLlmSettings]);

  const handleNewChat = useCallback(async (project?: { projectRoot?: string; projectName?: string }) => {
    const nextProject = resolveKnownProject(projectIdentityFromPayload(project)) ?? activeProject ?? defaultWorkspaceProject;
    if (streaming) {
      // New Chat beside a busy tile adopts another group; at the ceiling it refuses without changing the current conversation.
      const adopted = adoptGroupBeside(chatGroupsRef.current.focusedId);
      if (adopted === null) return;
      // Hydrate the tile under its requested project; update the window project only after chatNew succeeds.
      if (nextProject) {
        setFreshProjectByGroup((current) => new Map(current).set(adopted, nextProject));
      }
      setActiveView("home");
      return;
    }
    // Start chatNew on the focused tile's loop and reset that tile's transcript.
    const started = await focusedSession.startNewChat(nextProject
      ? { projectRoot: nextProject.projectRoot, projectName: nextProject.projectName }
      : undefined);
    if (!started) return;
    if (nextProject) setActiveProject(nextProject);
    setActiveView("home");
  }, [
    activeProject, adoptGroupBeside, defaultWorkspaceProject, focusedSession,
    resolveKnownProject, setActiveView, streaming,
  ]);

  // Refresh the conversation list after every row mutation.
  const conversationActions = useMemo<ConversationRowActions>(() => {
    const findSession = (sessionId: string) => sessions.find((session) => session.id === sessionId);
    const applyUpdate = async (
      payload: { sessionId: string; title?: string; archived?: boolean; unread?: boolean },
    ) => {
      const result = await api.chatSessionUpdate(payload);
      if (!result?.ok) {
        console.warn("[ave] conversation update failed:", result?.error);
        return;
      }
      await refreshSessions();
    };
    return {
      isArchived: (sessionId) => Boolean(findSession(sessionId)?.archivedAt),
      isUnread: (sessionId) => Boolean(findSession(sessionId)?.unreadSince),
      isResponding: (sessionId) =>
        tileSessions.some((tile) => tile.sessionId === sessionId && tile.streaming),
      onRename: (sessionId, title) => applyUpdate({ sessionId, title }),
      onSetArchived: (sessionId, archived) => applyUpdate({ sessionId, archived }),
      onSetUnread: (sessionId, unread) => applyUpdate({ sessionId, unread }),
      onShare: (sessionId) => handleExport("markdown", sessionId),
      onCopy: async (sessionId) => {
        const history = await api.chatSessionHistory(sessionId);
        const messages = history?.messages ?? [];
        if (messages.length === 0) return;
        const text = messages
          .map((message) => {
            const body = typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content);
            return `## ${message.role}\n\n${body}`;
          })
          .join("\n\n");
        await navigator.clipboard.writeText(text);
      },
      onImport: handleImportAndLoad,
      onDelete: async (sessionId) => {
        const result = await api.chatSessionDelete(sessionId);
        if (!result?.ok) {
          if (!("canceled" in result && result.canceled)) {
            console.warn("[ave] conversation delete failed:", result?.error);
          }
          return;
        }
        // After deleting a loaded session, restart its idle holder under the same project, even if another tile is focused.
        if (result.wasLoaded) {
          const holder = tileHoldingSession(tileSessions, sessionId);
          const tile = holder ? chatGroupSessions.read(holder.chatGroupId) : undefined;
          if (holder && tile) {
            const { projectRoot, projectName } = tile.currentSessionProject;
            const scoped = projectRoot ? { projectRoot, projectName } : undefined;
            const started = await tile.startNewChat(scoped);
            // If the deleted session's project is no longer authorized, restart its holder under the default project.
            if (!started && scoped) await tile.startNewChat(undefined);
            if (holder.chatGroupId === chatGroupsRef.current.focusedId) setActiveView("home");
          }
        }
        await refreshSessions();
      },
    };
  }, [api, sessions, tileSessions, chatGroupSessions, refreshSessions, handleExport, handleImportAndLoad, setActiveView]);
  // Turns ending off screen mark their rows unread; viewing the conversation clears the mark.
  useTurnAttention({
    tiles: tileSessions,
    attention: {
      focusedChatGroupId: chatGroups.focusedId,
      conversationVisible:
        (chatGroups.contentById[chatGroups.focusedId]?.view ?? "home") === "home",
    },
    isUnread: conversationActions.isUnread,
    setUnread: conversationActions.onSetUnread,
    onTurnsEnded: refreshSessions,
  });

  const projectActions = useMemo<ProjectRowActions>(() => ({
    isArchived: isProjectArchived,
    onSetArchived: toggleProjectArchived,
    label: projectLabel,
    onSetLabel: setProjectLabel,
  }), [isProjectArchived, toggleProjectArchived, projectLabel, setProjectLabel]);

  const toggleSlashPicker = useCallback(() => {
    if (activeView !== "home") {
      setActiveView("home");
      setSlashPickerOpen(true);
    } else {
      setSlashPickerOpen((prev) => !prev);
    }
  }, [activeView]);

  useAppBootstrap({
    api, refreshViews, refreshCards: async () => { await refreshCards(); }, checkApiKey,
    setActiveView, onOpenSettings,
    toggleSlashPicker,
  });
  usePluginLifecycleRefresh({ api, pluginCards, refreshViews, refreshCards });

  // Clear SlashPicker state off home so returning does not reopen a stale menu.
  useEffect(() => {
    if (activeView !== "home") setSlashPickerOpen(false);
  }, [activeView]);

  const commandActions = useMemo(
    () =>
      buildQuickActions({
        setActiveView: handleViewSelect,
        openSettings: onOpenSettings,
        handleNewChat,
        openNewSurface: (view) => showInstanceView(chatGroupsRef.current.focusedId, view, true),
        pluginViews,
        locale,
      }).concat(PANEL_COMMANDS.map((command) => ({
        id: command.id,
        label: isDarwin() ? `${t(command.labelKey)}  ${command.hint}` : t(command.labelKey),
        run: () => runPanelCommand(command.id),
      }))),
    [pluginViews, locale, handleNewChat, handleViewSelect, onOpenSettings, showInstanceView, runPanelCommand, t],
  );

  const onNewChat = useCallback(() => { void handleNewChat(); }, [handleNewChat]);
  const onNewChatForProject = useCallback((project: { projectRoot?: string; projectName?: string }) => {
    void handleNewChat(project);
  }, [handleNewChat]);
  const handleMarketplaceAnnouncementDismiss = useCallback(
    (id: number) => {
      dismissMarketplaceAnnouncement(id).catch((err) => {
        console.error(
          "[marketplace-announcement] dismiss persistence failed",
          err,
        );
      });
    },
    [dismissMarketplaceAnnouncement],
  );
  /** Marketplace announcements may navigate through existing sinks, never write machine settings. */
  const handleMarketplaceAnnouncementAction = useCallback(
    (target: MarketplaceAnnouncementActionTarget) => {
      if (target.kind === "settings") {
        navigateToSettingsPath({ tab: target.settingsTab, section: target.settingsSection });
        return;
      }
      void api.openExternalUrl(target.url);
    },
    [navigateToSettingsPath, api],
  );

  /** Tiles share window-scoped dependencies through one environment object. */
  const chatGroupEnvironment = useMemo<ChatGroupEnvironment>(() => ({
    llmVendor, llmModel, llmContextWindow, llmInputLimit, autoCompactEnabled, llmRoutePricing, llmRouteModalities, settingsLoaded,
    subscriptionRuntimeSelected, subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    apiUsageProjectionAvailable,
    // Keep output controls disabled until the persisted runtime selection loads.
    chatReasoningAvailable: settingsLoaded && activeSubscriptionRuntime === null,
    effectiveLlmReady, chatReadyWithoutApiKey, activeChatModel, checkApiKey,
    // Estimate output cost from the route's effective limit.
    onOpenSettings,
    maxOutputTokens: llmOutputTokenLimit.effective,
    maxOutputTokensSource: llmOutputTokenLimit.effectiveSource,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    enableThinkingChat, toggleThinking,
    processingDisplayLevel,
    refreshSessions, sessions, focusChatGroup,
    sideChatOpenRequest,
    isSessionStarred: (sessionId: string) => Boolean(isSessionStarred(sessionId)),
    handleToggleSessionStar,
    starredIsEntry, starredToggle,
    search: {
      searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet,
      searchIdx, searchHighlight, searchChangeQuery, searchToggleCase,
      searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    },
    onExport: handleExport, onImport: handleImport,
    plugins: pluginEntries,
    onSelectPlugin: handleViewSelectWithDoctor,
    onOpenApprovalQueue: () => setDeferredQueueOpen(true),
    commandActions, slashPickerOpen, onSlashPickerOpenChange: setSlashPickerOpen,
    approvalSentenceInterceptSubmit: interceptApprovalSentence,
    activeProject: activeProject ?? defaultWorkspaceProject,
    freshProjectByGroup,
    workspaceProjects,
    onNewChatForProject,
    onRefreshProjects: refreshWorkspaceProjects,
    onProjectError: handleProjectError,
    pendingAnswers,
  }), [
    llmVendor, llmModel, llmContextWindow, llmInputLimit, autoCompactEnabled, llmRoutePricing, llmRouteModalities, settingsLoaded, subscriptionRuntimeSelected, subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    apiUsageProjectionAvailable, activeSubscriptionRuntime,
    effectiveLlmReady, chatReadyWithoutApiKey, activeChatModel, checkApiKey, onOpenSettings, llmOutputTokenLimit,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    enableThinkingChat, toggleThinking, processingDisplayLevel, refreshSessions, focusChatGroup, sessions,
    sideChatOpenRequest,
    isSessionStarred, handleToggleSessionStar, starredIsEntry, starredToggle,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx,
    searchHighlight, searchChangeQuery, searchToggleCase, searchNext, searchPrev,
    searchCloseOverlay, searchToggleOverlay,
    handleExport, handleImport, pluginEntries, handleViewSelectWithDoctor,
    commandActions, slashPickerOpen,
    interceptApprovalSentence,
    activeProject, defaultWorkspaceProject, freshProjectByGroup, workspaceProjects,
    onNewChatForProject, refreshWorkspaceProjects, handleProjectError,
    pendingAnswers,
  ]);

  const paneChatRuntime = useMemo<SideChatRuntime>(() => ({
    hasApiKey: effectiveLlmReady, settingsLoaded, onOpenSettings,
    subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    llmVendor, llmModel, llmRouteModalities, processingDisplayLevel,
    usageAvailable: apiUsageProjectionAvailable,
    llmContextWindow, llmInputLimit, autoCompactEnabled,
  }), [
    effectiveLlmReady, settingsLoaded, onOpenSettings, subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    llmVendor, llmModel, llmRouteModalities, processingDisplayLevel, apiUsageProjectionAvailable,
    llmContextWindow, llmInputLimit, autoCompactEnabled,
  ]);

  /** A maximized pane's restore control carries attention for requests parked in hidden panes. */
  const paneRestoreAttention = (paneId: string): boolean =>
    chatGroups.maximizedId === paneId && pendingAnswers.hiddenPaneIds.size > 0;

  /** Draw each pane's lane once, in its visible frame. Unowned host/plugin approvals follow focus without covering a
   * composer. */
  const paneLane = (chatGroupId: string): ReactNode => (
    <>
      {chatGroupId === chatGroups.focusedId && laneApprovalHead !== null ? (
        <ApprovalLaneCard
          queue={pendingAnswers.unattributed}
          conversationLabel={unattributedRequestLabel(laneApprovalHead, t)}
          proposedChoice={
            approvalProposal?.requestId === laneApprovalHead.id ? approvalProposal.choice : null
          }
          onDecide={(choice, pattern, extras) => {
            void handleApprovalDecide(laneApprovalHead.id, choice, pattern, extras);
          }}
          onOpenPermanentDeny={handleOpenPermanentDeny}
          interactionLocked={exactDenyDraft?.requestId === laneApprovalHead.id}
          reviewerSuggestion={reviewerSuggestion}
        />
      ) : null}
      <OverlayCardRegion
        chatGroupId={chatGroupId}
        actionChatGroupId={chatGroupId}
        overlayCardTile={overlayCardTileForWindow}
        onPluginPrimaryAction={(id, actionChatGroupId) => {
          void handlePluginPrimaryAction(id, actionChatGroupId);
        }}
        onContinueInNewConversation={(id, actionChatGroupId) => {
          void handleContinueInNewConversation(id, actionChatGroupId);
        }}
        onAlertDismiss={handleAlertDismiss}
        onRoutineAcknowledge={handleRoutineAcknowledge}
        onProposalAnswer={(id, disposition, actionChatGroupId) => {
          void handleProposalAnswer(id, disposition, actionChatGroupId);
        }}
      />
    </>
  );

  /** Each routed pane renders its own view and returns to its own conversation. */
  const renderPaneRoute = (view: InlineViewKey, paneId: string, settle: ReactNode): ReactNode => {
    // Closing a routed view reveals its conversation; toolbar history remains the sole owner of replay.
    const closePane = () => chatGroups.setPaneContent(paneId, PANE_HOME);
    /** Label the control for the dismissed view because the pane itself remains open. */
    const routedCloseLabel = (title: string) => t("pane.closeView", { view: title });
    const pluginPane = pluginPaneFor(view);
    /** Routed views retain the conversation tile's focus, split and maximize controls; close returns to the conversation. */
    const asTile = {
      focused: chatGroups.focusedId === paneId,
      onFocus: () => chatGroups.focus(paneId),
      lane: paneLane(paneId),
      // Routed frames retain the conversation's pending-answer cards in their settle slot.
      settle,
      restoreAttention: paneRestoreAttention(paneId),
      onSurfaceDrop: (payload: SurfaceDragPayload, target: DropTarget) => handleSurfaceDrop(paneId, payload, target),
      ...(chatGroups.canSplit ? {
        canSplit: true,
        onSplit: (axis: PaneSplitAxis) => chatGroups.split(paneId, axis),
        splitFits: (axis: PaneSplitAxis) => chatGroups.splitFits(
          paneId, axis, measuredCanvasSize(chatGroupCanvasRef.current),
        ),
      } : {}),
      ...(chatGroups.canMaximize ? {
        maximized: chatGroups.maximizedId === paneId,
        onToggleMaximize: () => chatGroups.toggleMaximize(paneId),
      } : {}),
    };
    /** The cell owns tile insets; data-view distinguishes simultaneous routed pane shells. */
    const paneShell = (view: InlineViewKey, frame: ReactNode) => (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="main-pane-shell"
        data-view={view}
      >
        {frame}
      </div>
    );

    /** Apply body margins once: page for column content, none for views such as Settings that own full-height regions. */
    const viewPane = (
      view: PaneViewKey,
      body: ReactNode,
      bodyInset: "none" | "page" = "page",
    ) => {
      const PaneIcon = BUILTIN_VIEW_ICONS[view];
      const title = t(BUILTIN_LABEL_KEYS[view]);
      return paneShell(view, (
        <PaneFrame
          title={title}
          icon={<PaneIcon className="h-4 w-4" />}
          bodyInset={bodyInset}
          onClose={closePane}
          closeLabel={routedCloseLabel(title)}
          {...asTile}
        >
          {body}
        </PaneFrame>
      ));
    };

    if (view === "memory") {
      return viewPane("memory", (
        <MemorySearchPanel
          api={api}
          project={activeProject ?? defaultWorkspaceProject}
          onOpenSession={async (sessionId) => {
            const loaded = await handleLoadSessionAndRefresh(sessionId);
            if (loaded !== false) closePane();
            return loaded;
          }}
        />
      ));
    }

    if (view === "insights" || view === "starred") {
      return viewPane(view, (
        <StarredView
          api={api}
          starred={starred}
          sessions={sessions}
          workspaceProjects={workspaceProjects}
          currentSessionId={currentSessionId}
          refreshStarred={refreshStarred}
          onJumpToSession={handleLoadSessionAndRefresh}
          onActivateHome={closePane}
        />
      ));
    }

    if (view === "routines") {
      return viewPane("routines", (
        <RoutinePanel
          api={api}
          onOpenSession={(sessionId) => {
            void (async () => {
              const loaded = await handleLoadSessionAndRefresh(sessionId);
              if (loaded !== false) closePane();
            })();
          }}
        />
      ));
    }

    if (view === "settings") {
      // Settings owns its two-region layout, so the frame adds no inset.
      return viewPane("settings", (
        <SettingsInlineView
          api={api}
          /** Settings away-authority targets the conversation focus came from, not the pane currently showing Settings. */
          chatGroupId={paneId}
          initialTab={settingsTab}
          sectionTarget={settingsSectionTarget}
          onSectionApplied={clearSettingsSectionTarget}
          onSaved={handleInlineSettingsSaved}
          onTabChange={setSettingsTab}
          exactDenyDraft={exactDenyDraft ?? null}
          onExactDenySaved={handleExactDenySaved ?? (() => undefined)}
          onDiscardExactDeny={() => setExactDenyDraft(null)}
        />
      ), "none");
    }

    if (view === "work-board") {
      return viewPane("work-board", (
        <WorkBoardPanel
          api={api}
          project={activeProject ?? defaultWorkspaceProject}
          focusItemId={workBoardFocusItemId}
          onFocusConsumed={() => setWorkBoardFocusItemId(null)}
        />
      ));
    }

    if (view === "terminal" || view === "web") {
      const surfaceId = chatGroups.contentById[paneId]?.surface;
      const surface = mainSurfaces.surfaces.find((each) => each.tabId === surfaceId);
      if (!surface) {
        // Report a missing surface and offer navigation away.
        return viewPane(view, (
          <p className="text-sm text-muted-foreground" data-testid="surface-pane-gone">{t("mainPanels.surfaceGone")}</p>
        ));
      }
      const name = `${t(BUILTIN_LABEL_KEYS[view])} ${surface.ordinal}`;
      // Closing a terminal/web surface ends it and returns the pane to its conversation.
      const closeSurface = () => {
        closePane();
        mainSurfaces.close(surface.tabId);
        forgetActiveSurface(surface.tabId);
        if (surface.kind === "terminal") void api.terminal?.kill(surface.tabId);
      };
      return paneShell(view, (
        <SurfacePane
          api={api}
          surface={surface}
          paneId={paneId}
          frame={{
            ...asTile,
            onClose: closeSurface,
            closeLabel: routedCloseLabel(name),
            dragSurface: { tabId: surface.tabId, kind: surface.kind, from: { pane: paneId } },
          }}
          chatRuntime={paneChatRuntime}
          onSessionsChanged={refreshSessions}
          onNavigate={mainSurfaces.setUrl}
          // Main-terminal blocks attach to the last composer the user typed in.
          onAttachText={(text) => attachToComposer(text, { focusedGroupId: chatGroups.focusedId })}
        />
      ));
    }

    // Keep conversation tiles mounted across navigation so running turns retain their stream subscriptions.
    if (view === "home") return null;

    // The exhaustive built-in narrowing makes an omitted built-in route a compile error before treating the key as a plugin.
    const pluginKey: PluginViewKey = view;
    void pluginKey;
    /** Plugin labels come from manifests; unmount hidden plugin guests to release their renderer and partition, accepting
     * reload on return. */
    const PluginPaneIcon = pluginIconFor({
      icon: pluginPane.view?.icon,
      iconText: pluginPane.view?.iconText,
    });
    const pluginTitle = pluginPane.view
      ? getPluginViewLabel(pluginPane.view, locale)
      : t("be_pluginUiHost.pluginUiTitle");
    return paneShell(view, (
      <PaneFrame
        title={pluginTitle}
        description={(pluginPane.view && getPluginViewDescription(pluginPane.view.extension, locale))
          ?? t("be_pluginUiHost.pluginUiLoadingDesc")}
        icon={(
          <Suspense fallback={<span className="h-4 w-4" />}>
            <PluginPaneIcon className="h-4 w-4" />
          </Suspense>
        )}
        onClose={closePane}
        closeLabel={routedCloseLabel(pluginTitle)}
        {...asTile}
      >
        <PluginUiHostView
          view={pluginPane.view ?? null}
          preparing={pluginPane.preparing}
          authError={pluginPane.authError ?? null}
        />
      </PaneFrame>
    ));
  };

  return (
    <ErrorBoundary fallback={t("app.appErrorFallback")}>
      <ThemeProvider api={api}>
        <TooltipProvider>
          {/* IMPORTANT (render-order coupling): OverlayContextProvider MUST stay
              INSIDE this stack. It populates `addFireRef.current` DURING ITS
              RENDER (a synchronous assignment, before any effects fire), so the
              routine/overlay IPC subscriptions that App owns can call addFire()
              from outside the React tree. Hoisting it out — or mounting it below
              its consumers — would leave that ref null when the first IPC event
              lands. See src/ui/renderer/context/OverlayContext.tsx. */}
          <ApprovalSurfaceProvider value={approvalSurface}>
          <OverlayContextProvider
            onOpenSession={handleOpenRoutineSession}
            addFireRef={addFireRef}
            dismissRef={dismissRef}
            runningRoutines={runningRoutines}
            onQueueChange={setOverlayQueue}
          >
            {/* `relative` makes THIS full-height shell column the positioning
                context for the floating-card Sidebar, so the card's `top-0` reaches
                the window top — extending UP into the traffic-light band and
                reclaiming that vertical space on the left. */}
            <div ref={setShellElement} data-testid="app-shell" data-sidebar-state={sidebarState} className="relative flex h-screen min-w-0 flex-col overflow-hidden">
              {/* Single top band — window controls + the app toolbar cluster live
                  together here. The toolbar content is passed as children so it
                  renders IN the band (no separate toolbar row below it). */}
              {/* The band's path names what is open, so it lines up with that
                  thing's own title one row below — NOT with the sidebar card's
                  edge. `CONTENT_TITLE_INSET` is the distance from the card to
                  where a title starts: the gutter between the card and the
                  content, plus the content surface's own leading padding.
                  Collapsed, the card retracts but its cluster strip stays bare
                  on this band, so the path clears THAT strip instead.
                  Overlaying on a narrow window, the band is not pushed
                  either: it keeps the collapsed lead and the card floats
                  over the path the way it floats over the tile. */}
              <CustomTitleBar
                keepVisibleInFullscreen={sidebarHidden}
                leadClearance={sidebarHidden ? 0 : sidebarCollapsed || sidebarOverlay ? collapsedBandLeadClearance(isDarwinPlatform()) : sidebarWidth + SHELL_GUTTER + CONTENT_TITLE_INSET}
              >
                {sidebarHidden && (
                  <Button
                    data-testid="sidebar-show"
                    variant="ghost"
                    size="icon"
                    className="h-(--chrome-icon-button) w-(--chrome-icon-button) shrink-0"
                    title={t("mainToolbar.showSidebar")}
                    aria-label={t("mainToolbar.showSidebar")}
                    onClick={showSidebar}
                    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                )}
                <MainToolbar
                  viewNav={viewNav}
                  streaming={streaming}
                  hasApiKey={effectiveLlmReady}
                  onOpenDevTools={() => setDevToolsOpen((v) => !v)}
                  appUpdateState={appUpdate.state}
                  appUpdateInFlight={appUpdate.inFlight}
                  onDownloadAppUpdate={appUpdate.download}
                  onInstallAppUpdate={appUpdate.install}
                  onSkipAppUpdate={appUpdate.skip}
                  pluginUpdates={{
                    updates: marketplaceUpdates,
                    onSkip: skipMarketplaceUpdates,
                    onReview: reviewMarketplaceUpdates,
                  }}
                  bootstrapStatus={{
                    status: bootstrapStatus,
                    onDismiss: dismissBootstrapStatus,
                    onRetry: () => void retryBootstrap(),
                  }}
                />
              </CustomTitleBar>
              {/* The floating-card Sidebar is anchored against the full-height shell
                  column above (NOT this content row) so its `top-0` spans up into the
                  band. The content `<main>` carries left padding equal to the card
                  width + insets so the rail never occludes the canvas. */}
              {!sidebarHidden && <Sidebar
                activeView={activeView}
                onSelect={handleViewSelectWithDoctor}
                onSelectInNewPane={chatGroups.isSingleTile ? undefined : openViewInNewPane}
                pluginViews={pluginViews}
                failedPluginCards={failedPluginCards}
                inactivePluginCards={inactivePluginCards}
                pluginAuthStatuses={pluginAuthStatuses}
                sessions={sessions}
                currentSessionId={currentSessionId}
                onLoadSession={async (sessionId) => {
                  const loaded = await handleLoadSessionAndRefresh(sessionId);
                  if (loaded !== false) setActiveView("home");
                  return loaded;
                }}
                onOpenWorkBoardItem={openWorkBoardItem}
                onOpenSideChat={(sideChatSessionId, originSessionId) =>
                  void openSideChat(sideChatSessionId, originSessionId)}
                pendingAnswerSessionIds={pendingAnswers.sessionIds}
                suggestionsPendingCount={suggestionsPendingCount}
                pluginRequestPending={pendingAnswers.unattributed.length > 0}
                hasApiKey={effectiveLlmReady}
                subscriptionUnavailable={subscriptionUnavailableProvider !== undefined}
                subscriptionPending={subscriptionPendingProvider !== undefined}
                subscriptionRuntimePolicy={subscriptionRuntimePolicy}
                modelConfigured={chatModelConfigured}
                onOpenSettings={() => onOpenSettings()}
                onNewChat={onNewChat}
                onNewChatForProject={onNewChatForProject}
                onRefreshProjects={refreshWorkspaceProjects}
                onProjectError={handleProjectError}
                projects={workspaceProjects}
                collapsed={sidebarCollapsed}
                overlay={sidebarOverlay}
                onToggleCollapse={() => setSidebarState(sidebarCollapsed ? "expanded" : "rail")}
                onHide={hideSidebar}
                width={sidebarWidth}
                maxWidth={sidebarOverlay ? Math.max(0, shellWidth - SHELL_GUTTER * 2) : undefined}
                onWidthChange={setSidebarWidth}
                onWidthCommit={commitSidebarWidth}
                onOpenUnifiedSearch={() => { searchOpenOverlay(); }}
                viewNav={viewNav}
                conversationActions={conversationActions}
                projectActions={projectActions}
                mainSurfaces={mainSurfaces.surfaces}
                browserTabs={api.browserTabs}
                chatGroupIds={leafIds(chatGroups.tree)}
                onOpenSurface={openWorkspaceSurface}
                isSurfaceVisible={(tabId) => focusedSurface
                  ? focusedSurface === tabId
                  : activeView === "home" && getSideTabsSink(chatGroups.focusedId)?.visibleTabId?.() === tabId}
                isSessionStarred={isSessionStarred}
                onToggleSessionStar={handleToggleSessionStar}
                isProjectPinned={isProjectPinned}
                onToggleProjectPin={toggleProjectPin}
              />}
              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <main
                  data-sidebar-overlay={sidebarOverlay ? "true" : undefined}
                  className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
                    !sidebarHidden && (sidebarCollapsed || sidebarOverlay) ? "pl-(--shell-collapsed-rail-reserve)" : ""
                  }`}
                  // Overlay navigation retains the collapsed reserve without shrinking the canvas.
                  style={sidebarHidden ? { paddingLeft: 0 } : sidebarCollapsed || sidebarOverlay ? undefined : { paddingLeft: `${sidebarWidth + SHELL_GUTTER}px` }}
                >
                  {/* The window's notice strip — the announcement banner, the
                      permission-memory toast and the window status toasts
                      (host notifications, installs, the app update). Each is
                      about the WINDOW, so it is subscribed once and drawn once,
                      here, IN FLOW: a flex sibling above the route canvas that
                      takes its height from the canvas. It used to float over
                      the canvas's top-right corner — the corner every pane
                      keeps for its own floating lane — so a tall stack covered
                      the rightmost tile's cards, and a tile's own dock drew the
                      window toasts once per tile. Nothing here is positioned,
                      so nothing here needs a sidebar inset: <main>'s leading
                      padding keeps in-flow content clear of the rail, and an
                      overlaying sidebar card covers this strip exactly as it
                      covers the tile below it. `empty:hidden` gives the strip
                      no height while every child renders null. Plugin updates
                      and managed-plugin bootstrap are toolbar pills, beside the
                      app-update pill (see MainToolbar). */}
                  <div
                    className="flex shrink-0 flex-col gap-2 px-(--chrome-gap) pt-2 empty:hidden [&>*]:m-0"
                    data-testid="window-notice-strip"
                  >
                    {documentEngineOnboardingOpen ? <DocumentEngineInstallContent onDismiss={dismissDocumentEngineOnboarding} /> : null}
                    <RetiredProviderNotice
                      retiredProvider={subscriptionRuntimeSelected ? null : retiredLlmProvider}
                      onChooseProvider={() => onOpenSettings("llm")}
                    />
                    <DeprecatedModelNotice
                      model={subscriptionRuntimeSelected ? null : deprecatedLlmModel}
                      onChooseModel={() => onOpenSettings("llm")}
                    />
                    <MarketplaceAnnouncementBanner
                      announcements={marketplaceAnnouncements}
                      onDismiss={handleMarketplaceAnnouncementDismiss}
                      onAction={handleMarketplaceAnnouncementAction}
                    />
                    {/* Verdict-tier tint surfaces the trust gradient:
                        low → --success (informational re-approval), medium →
                        --warning, high → --destructive + role="alert" (the user
                        is re-using a high-risk approval). Semantic tokens, so a
                        theme bundle supplies the actual color. */}
                    {userApprovalHitToast && (() => {
                      const verdict = userApprovalHitToast.verdictAtApproval;
                      const isHigh = verdict === "high";
                      const token =
                        verdict === "high" ? "destructive"
                        : verdict === "medium" ? "warning"
                        : "success";
                      const tone = `border-[hsl(var(--${token})/0.4)] bg-[hsl(var(--${token})/0.1)] text-[hsl(var(--${token}))]`;
                      return (
                        <div
                          data-testid="user-approval-hit-toast"
                          data-verdict={verdict}
                          role={isHigh ? "alert" : "status"}
                          aria-live={isHigh ? "assertive" : "polite"}
                          className={`rounded-md border px-3 py-2 text-xs ${tone}`}
                        >
                          <span className="font-medium">{t("chatView.approvalMemoryApplied")}</span>
                          <span className="ml-2 text-muted-foreground">
                            {userApprovalHitToast.toolName} · {userApprovalHitToast.scope === "persistent" ? t("chatView.approvalScopePersistent") : userApprovalHitToast.scope === "global" ? t("chatView.approvalScopeGlobal") : t("chatView.approvalScopeSession")} · {verdict.toUpperCase()}
                          </span>
                        </div>
                      );
                    })()}
                    <StatusBar
                      persistent={statusPersistent}
                      visibleToast={statusVisibleToast}
                      pendingCount={statusPendingCount}
                      onToastClick={handleStatusToastClick}
                      onToastDismiss={(toast) => statusRemoveToast(toast.id)}
                    />
                  </div>
                  <DevToolsPanel
                    api={api}
                    open={devToolsOpen}
                    onClose={() => setDevToolsOpen(false)}
                    labelsOn={devLabelsOn}
                    onToggleLabels={() => setDevLabelsOn((v) => !v)}
                  />
                  {devLabelsOn && <DevComponentLabels />}
                  {searchOpen && (
                    <UnifiedSearchPanel
                      api={api}
                      open={searchOpen}
                      query={searchQuery}
                      caseSensitive={searchCase}
                      entries={entries as ChatEntry[]}
                      conversationMatches={searchMatches}
                      currentConversationMatch={searchIdx}
                      sessions={sessions}
                      project={activeProject ?? defaultWorkspaceProject}
                      starred={starred}
                      onChangeQuery={searchChangeQuery}
                      onToggleCase={searchToggleCase}
                      onNextConversationMatch={searchNext}
                      onPrevConversationMatch={searchPrev}
                      onJumpToConversationMatch={(matchIndex) => {
                        setActiveView("home");
                        searchJumpToMatch(matchIndex);
                      }}
                      onOpen={searchOpenOverlay}
                      onClose={searchCloseOverlay}
                      onLoadSession={async (sessionId) => {
                        const loaded = await handleLoadSessionAndRefresh(sessionId);
                        if (loaded !== false) setActiveView("home");
                        return loaded;
                      }}
                      onOpenMemoryView={() => {
                        setActiveView("memory");
                        searchCloseOverlay();
                      }}
                      onOpenRoutinesView={() => {
                        setActiveView("routines");
                        searchCloseOverlay();
                      }}
                    />
                  )}

                  {/* Routed content and route-independent foreground surfaces share a
                      content-box positioning context. Floating surfaces can anchor to
                      this canvas without ignoring <main>'s sidebar padding or taking
                      flex space away from the active route. */}
                  <div
                    className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    data-testid={TEST_IDS.routeCanvas}
                  >
                    {/* Inner ErrorBoundary scoped to the routed main content so a
                        single failing plugin (e.g. stale manifest schema mismatch —
                        issue #736) does NOT bring down MainToolbar / Settings page /
                        Marketplace tab. The user must remain able to update /
                        uninstall the broken plugin via Settings, otherwise they are
                        locked out and the only recovery is manually rm-ing
                        ~/.ave/plugins/<id>/.
                        onReset: refresh plugin state then re-render — for transient
                        throws this avoids the deterministic reload-into-same-crash
                        loop where the bad data is reloaded with the page. */}
                    <ErrorBoundary
                      boundaryName="main-content"
                      fallback={t("app.mainContentErrorFallback")}
                      onReset={() => {
                        void refreshViews();
                        void refreshCards();
                        setActiveView("home");
                      }}
                    >
                      {/* The panes. Every one of them, whatever it is showing:
                          a routed view is drawn INSIDE the pane that holds it,
                          so it takes that pane's box on the canvas and leaves
                          its neighbours alone.

                          The conversations under them stay mounted. A tile
                          subscribes to its group's stream when it mounts, so
                          swapping it out to render Settings would drop the
                          frames of a turn still in flight — and take the
                          composer draft and scroll position with it.

                          `data-visible` answers "is a conversation on screen":
                          with one pane it is the old `activeView === "home"`,
                          and with several it is true while any of them still
                          draws its conversation. Nothing in the window reads
                          it — the cards a pane holds are the pane's own — it
                          is the observable the route tests assert against
                          when they check that a gate still reaches the user
                          after the route has left the chat surface. `contents`
                          keeps the wrapper out of the layout entirely, so the
                          flex chain reads exactly as it does when this is the
                          only child. */}
                      <SurfaceMovesContext.Provider value={surfaceMoves}>
                      <div
                        data-testid="chat-surface"
                        data-visible={chatGroups.groups.some((group) => !group.hidden
                          && (chatGroups.contentById[group.id]?.view ?? "home") === "home") ? "true" : "false"}
                        className="contents"
                      >
                        <PageShell
                              padded={false}
                              maxWidth="none"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <>
                                {/* The away surfaces for an MCP-app card that left its home
                                    mount — one singleton each (each renders nothing while no
                                    card occupies its slot). Mounted once here rather than
                                    per-transcript-card, matching the slots' own
                                    single-occupant design. */}
                                <McpAppPipPanel />
                                <McpAppFullscreenPanel />
                                {/* Tiles are positioned from the split tree's boxes rather
                                    than nested flex containers, so a tile's rectangle is
                                    one number that the layout, a drag hit-test, and a
                                    measurement in a test all read the same way. */}
                                <div className="min-h-0 min-w-0 flex-1 pb-(--chrome-gap) pl-(--chrome-gap-tight) pr-(--chrome-gap) pt-0" data-testid="pane-row">
                                {/* The positioning context is INSIDE the padding: an
                                    absolutely-positioned child resolves against the padding
                                    box, so anchoring the tiles to the row itself would eat
                                    the air that lines the chat group's bottom edge up with
                                    the sidebar's. */}
                                <div ref={handleCanvasRef} className="relative h-full w-full" data-testid="pane-canvas">
                                {chatGroups.groups.map((group) => {
                                const paneView = (chatGroups.contentById[group.id]?.view ?? "home") as InlineViewKey;
                                return (
                                <div
                                  key={group.id}
                                  /** Use pixel half-gutters so adjacent tiles make an 8px gap and stay aligned with sidebar chrome at every font scale. */
                                  className="absolute flex p-(--chrome-gap-tight)"
                                  /** Keep hidden tiles mounted to preserve running turns, stream subscriptions and stop controls. */
                                  style={{ ...areaStyle(group.box), ...(group.hidden ? { display: "none" } : {}) }}
                                  data-testid={`pane-cell:${group.id}`}
                                  data-hidden={group.hidden ? "true" : undefined}
                                >
                                  {/* The tile owns its conversation: every hook inside is
                                      keyed on its group-bound api, so two tiles stream at
                                      once without either seeing the other's transcript.

                                      A routed view replaces the conversation IN THE CELL,
                                      so it inherits the tile's box, its inset and its place
                                      in the split tree — and the panes beside it keep
                                      drawing whatever they hold. It is rendered from inside
                                      the tile's render prop because it carries the tile's
                                      own `settle` cards: the conversation behind the view
                                      is hidden rather than unmounted — the turn it may be
                                      streaming, its composer draft and its scroll position
                                      all live in here — and the cards its turn is parked
                                      on are drawn in the frame that IS visible, whichever
                                      that is. `contents` while the conversation draws, so
                                      the wrapper adds no box of its own. */}
                                  <ChatGroupSession
                                    chatGroupId={group.id}
                                    api={api}
                                    registry={chatGroupSessions}
                                    env={chatGroupEnvironment}
                                    panelOpen={group.panelOpen}
                                    thumbnailOpen={group.thumbnailOpen}
                                    onThumbnailOpenChange={(open) => chatGroups.setThumbnailOpen(group.id, open)}
                                    focused={chatGroups.focusedId === group.id}
                                    // Route visibility hides the conversation dock; tree visibility decides whether its frame can draw cards or must park
                                    // them.
                                    hidden={group.hidden || paneView !== "home"}
                                    paneHidden={group.hidden}
                                    onSidePanelOpenChange={(open) => chatGroups.setPanelOpen(group.id, open)}
                                  >
                                    {({ actions, trailing, content, settle, currentSessionId: tileSessionId }) => (
                                      <>
                                      {renderPaneRoute(paneView, group.id, settle)}
                                      <div className={paneView === "home" ? "contents" : "hidden"}>
                                      <PaneFrame
                                        title={
                                          sessionDisplayTitle(
                                            tileSessionId,
                                            sessions.find((session: SessionSummary) => session.id === tileSessionId)?.title,
                                            t,
                                          )
                                          ?? t("mainToolbar.newChat")
                                        }
                                        focused={chatGroups.focusedId === group.id}
                                        onFocus={() => chatGroups.focus(group.id)}
                                        onSessionDrop={(sessionId, target) =>
                                          handleSessionDrop(group.id, sessionId, target)}
                                        onSurfaceDrop={(payload, target) =>
                                          handleSurfaceDrop(group.id, payload, target)}
                                        canSplit={chatGroups.canSplit}
                                        asideSlot
                                        bodyInset="none"
                                        lane={paneView === "home" ? paneLane(group.id) : undefined}
                                        trailing={trailing}
                                        actions={actions}
                                        {...(chatGroups.canSplit ? {
                                          onSplit: (axis: PaneSplitAxis) => chatGroups.split(group.id, axis),
                                          splitFits: (axis: PaneSplitAxis) => chatGroups.splitFits(
                                            group.id, axis, measuredCanvasSize(chatGroupCanvasRef.current),
                                          ),
                                        } : {})}
                                        {...(chatGroups.closable ? { onClose: () => closeChatGroup(group.id) } : {})}
                                        {...(chatGroups.canMaximize ? {
                                          maximized: chatGroups.maximizedId === group.id,
                                          onToggleMaximize: () => chatGroups.toggleMaximize(group.id),
                                        } : {})}
                                        restoreAttention={paneRestoreAttention(group.id)}
                                      >
                                        {content}
                                      </PaneFrame>
                                      </div>
                                      </>
                                    )}
                                  </ChatGroupSession>
                                </div>
                                );
                                })}
                                {/* The boundaries sit in the 8px the cells' half-gutters
                                    leave between tiles, so the bar's strip is exactly
                                    the gap and steals nothing from either transcript. */}
                                {chatGroups.gutters.map((gutter) => (
                                  <PaneGutter
                                    key={gutter.key}
                                    gutter={gutter}
                                    canvasRef={chatGroupCanvasRef}
                                    previewResize={chatGroups.previewResize}
                                    onResize={chatGroups.resize}
                                  />
                                ))}
                                </div>
                                </div>
                              </>
                            </PageShell>
                      </div>
                      </SurfaceMovesContext.Provider>
                    </ErrorBoundary>
                  </div>
                  {/* StatusBar notifications render inside ChatView, directly above
                      the composer. The composer's own status sub-row keeps showing
                      the ring / permission / model cells. The conversation's tool
                      activity is derived inside ChatView and shown by the right-docked
                      ChatSidePanel, so its open-actions reach the workspace store. */}
                </main>
              </div>
            </div>

            {/* App-level dialogs that remain available after removing setup flows. */}
            <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={setDeferredQueueOpen} />
            <SpotlightTour
              api={api}
              onComplete={onTourComplete}
              onDismiss={onTourDismiss}
            />
            <DevConsoleToggle />
            {/* Every browser tab's page, laid over wherever the tab is shown
                (see WebSurfaceLayer). Portaled to <body>: no ancestor here may
                capture its fixed positioning or its stacking. */}
            <WebSurfaceLayer api={api} />
          </OverlayContextProvider>
          </ApprovalSurfaceProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
