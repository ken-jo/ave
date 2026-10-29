import { chatSurface } from "./components/chat-surface.js";
import { resolveConversationTitle } from "../../shared/conversation-title.js";
import type { RewindMode } from "../../shared/code-rewind.js";
import { RewindDialog } from "./dialogs/RewindDialog.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { ChevronDown } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { isDebugStreamEnabled } from "../../lib/debug-stream.js";
import { ViewModeBanner, type ViewModeState } from "./components/ViewModeBanner.js";
import { TokenProgressRing } from "./components/TokenProgressRing.js";
import { type StatusBarProps } from "./components/StatusBar.js";
import { ChatSidePanel } from "./components/ChatSidePanel.js";
import type { SideChatOpenRequest } from "./components/SideChatView.js";

import { getApi } from "./api-client.js";
import { useChatContext } from "./context/ChatContext.js";
import { useInputStatusRow } from "./hooks/use-input-status-row.js";
import { captureComposerKeyboardIntent, type ComposerHandle } from "./components/Composer.js";
import { useSuggestedReplies } from "./hooks/use-suggested-replies.js";
import { hasActiveSuggestedReplies } from "./utils/composer-placeholder.js";
import type { PluginEntry } from "./types.js";
import type { QuickAction } from "./components/command-actions.js";
import { type AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { ApprovalRequest, AveApi } from "./types.js";
import { ApprovalDock } from "./components/permissions/ApprovalDock.js";
import { useApprovalSurface } from "./hooks/use-approval.js";
import type { SubAgentSpawn } from "./subagents/types.js";
import type { SkillBadgeProps } from "./components/SkillBadge.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import type { McpPromptEntry } from "./components/slash-picker-data.js";
import type { AgentPluginTemplatePrompt } from "../../shared/agent-plugin-prompt.js";
import type { ProjectIdentity } from "../../shared/project-identity.js";
import { isTurnStartEntry } from "./utils/classify-turn-entries.js";
import { collectChatPreviewModel, type ChatPreviewTarget } from "./preview/preview-targets.js";
import { useWorkspaceChanges } from "./hooks/use-workspace-changes.js";
import type { FileWorkspaceReveal } from "./preview/workspace-changes.js";
import { useAgentDocumentPanel } from "./preview/use-agent-document-panel.js";
import { useWorkspaceTabs } from "./preview/workspace-tabs.js";
import { isMovableTabKind, registerSideTabsSink, useSurfaceMoves, type MovableTabKind } from "./preview/surface-moves.js";
import { emitMainLayoutChange, takeRestoredSideTabs, terminalCwd } from "./preview/main-layout-restore.js";
import { forgetActiveSurface } from "./preview/active-surface.js";
import { savedSurfaceOf } from "./preview/main-layout-snapshot.js";
import { webSurfaceLocation } from "./preview/web-surfaces.js";
import { attachToComposer, registerComposerTarget } from "./preview/composer-targets.js";
import { closeBrowserTab, registerBrowserTabHost } from "./preview/agent-browser-bridge.js";
import { releaseBrowserObservationSession } from "./preview/browser-observation-bridge.js";
import { SIDE_PANEL_WIDTH_PREF, usePanelWidth } from "./hooks/use-panel-width.js";
import { normalizeBrowserNavigationUrl } from "./preview/url-safety.js";
import { createPortal } from "react-dom";
import { usePanePanelSlot } from "./components/PaneFrame.js";
import { computeToolActivity } from "./utils/tool-activity.js";
import { collectPromptHistory } from "./utils/prompt-history.js";
import { interruptedTurnOffer } from "./utils/history.js";
import { InterruptedTurnBanner } from "./components/InterruptedTurnBanner.js";
import { SuggestedTasksPanel } from "./components/SuggestedTasksPanel.js";
import type { SuggestedTask } from "./suggested-tasks/provider.js";
import { sidePanelLayout, useContainerNarrow } from "./hooks/use-container-narrow.js";
import { CHAT_THUMBNAIL_WIDTH, chatColumnsLayout, type ChatColumnsVisibility } from "./preview/chat-columns-layout.js";
import { ChatThumbnailColumn } from "./components/chat-thumbnail-column.js";
import { SIDE_PANEL_MIN_RESERVE } from "../../shared/side-panel.js";
import { useChatScroll } from "./hooks/use-chat-scroll.js";
import { useCheckpointView } from "./hooks/use-checkpoint-view.js";
import { useMessageQueue } from "./hooks/use-message-queue.js";
import { useAttachmentPicker } from "./hooks/use-attachment-picker.js";
import { TranscriptRenderer, type TurnSummary } from "./components/TranscriptRenderer.js";
import { ChatTranscript } from "./components/ChatTranscript.js";
import { ChatComposerDock } from "./components/ChatComposerDock.js";
import { ComposerContextNotice } from "./components/ComposerContextNotice.js";
import type { ProjectErrorReporter } from "./hooks/use-add-project-folder.js";
import { TEST_IDS } from "../../shared/test-ids.js";
import { DockedPanelColumn, useDockedPanelMotion } from "./components/DockedWorkPanel.js";
import { formatTokensExact } from "../../lib/cost-format.js";

/** Chat state comes from context; user-action callbacks remain explicit props. */
export interface ChatViewProps {
  api: AveApi;
  onAsk: (
    q: string,
    intent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => void | Promise<void>;
  /** Run a server-declared MCP prompt (staged, untrusted provenance). */
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
  onRunPluginPrompt: (prompt: AgentPluginTemplatePrompt) => void;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  /** Restore returns text to the composer unsent; code-only keeps history. Refusals preserve the current conversation. */
  onReturnHere: (idx: number, mode?: RewindMode) => Promise<{ ok: boolean }>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  /** userBubble is present only when Continue appends a new user row instead of rerunning the existing one. */
  onContinueFromLastUser?: (sessionId: string, opts?: { userBubble?: string }) => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
  onAbort: () => void | Promise<void>;
  /** Mid-stream "guide" utterance — non-interrupting direction adjustment. Returns IPC result so caller can preserve typed text on rejection. */
  onGuide: (text: string, intent?: UserKeyboardIntentSnapshot) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Surface visible error in chat transcript when guide is rejected (queue-full / too-long / no-active-turn). */
  onGuideError: (message: string) => void;
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  /** Workflow state stays at App level to survive view navigation. */
  subAgentSpawns: SubAgentSpawn[];
  loadedSkills: SkillBadgeProps[];
  /** Pending questions suppress routine overlays. */
  hasAskQuestions: boolean;
  /** Pending ask_user_question requests rendered in the non-modal composer dock. */
  askQuestions: AskUserQuestionRequest[];
  /** App-owned `/allow` interceptor; approval UI itself lives beside routed content. */
  approvalSentenceInterceptSubmit?: (text: string) => boolean;
  /** Only this conversation draws its own pending questions and those of its sub-agents. */
  pendingApprovals: readonly ApprovalRequest[];
  /** Called when a card submits or is dismissed; removes it from `askQuestions`. */
  onResolveAskQuestion: (id: string) => void;
  /** Plugin list — surfaced inside the SlashPicker's plugin category. */
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  /** Opens the deferred approval queue dialog from the footer approval count. */
  onOpenApprovalQueue?: () => void;
  currentSessionKind?: "main" | "routine";
  currentSessionTitle?: string;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;

  commandActions: QuickAction[];
  slashPickerOpen: boolean;
  onSlashPickerOpenChange: (open: boolean) => void;
  // sessionId remains stable until the user explicitly branches from a checkpoint.

  /** Toast surface rendered directly above the composer input. */
  statusBar?: StatusBarProps;
  /** App-owned toast producer for attachment capability warnings. */
  onAttachmentWarning?: (message: string) => void;
  /** Requested session-preview column state, preserved when the tile is narrow. */
  thumbnailOpen?: boolean;
  /** Controlled right-side work panel state, toggled from the title bar. */
  sidePanelOpen?: boolean;
  onColumnsVisibilityChange?: (visibility: ChatColumnsVisibility) => void;
  onSidePanelOpenChange: (open: boolean) => void;
  /** Tile identity addresses side-panel tabs during surface moves. */
  chatGroupId?: string;
  /** Side-chat requests target the tile whose conversation owns the panel. */
  sideChatOpenRequest?: SideChatOpenRequest | undefined;
  /** Tell the window its conversation list is stale — a side-chat turn moves a row in it. */
  onSessionsChanged?: (() => void | Promise<void>) | undefined;
  /** Use the window's hidden-card verdict so panel tabs and pane toggles show the same attention dot. */
  sideChatPendingAnswer?: boolean;
  /** Active project — drives the empty-state composer's project selector trigger label. */
  activeProject?: ProjectIdentity;
  /** Use the sidebar's project list so both selectors agree. */
  workspaceProjects?: ProjectIdentity[];
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  onRefreshProjects?: () => void | Promise<void>;
  onProjectError?: ProjectErrorReporter;
}


export function ChatView({ api, onAsk, onRunMcpPrompt, onRunPluginPrompt, onEditSave, onFork, onReturnHere, onToggleStar, onRetryEffort, onContinueFromLastUser, isEntryStarred, onAbort, onGuide, onGuideError, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, approvalSentenceInterceptSubmit, pendingApprovals, plugins, onSelectPlugin, onOpenApprovalQueue, currentSessionKind = "main", currentSessionTitle, onLoadSession, commandActions, slashPickerOpen, onSlashPickerOpenChange, statusBar, onAttachmentWarning, thumbnailOpen = false, sidePanelOpen = false, onColumnsVisibilityChange, onSidePanelOpenChange, sideChatOpenRequest, onSessionsChanged, sideChatPendingAnswer = false, activeProject, workspaceProjects, onNewChatForProject, onRefreshProjects, onProjectError, chatGroupId }: ChatViewProps) {
  const { t } = useTranslation();
  const approvals = useApprovalSurface();
  const approvalHead = pendingApprovals[0] ?? null;
  const workflowApi = getApi();
  const debugStreamEnabled = isDebugStreamEnabled();
  const composerRef = useRef<ComposerHandle | null>(null);
  const suggestedReplies = useSuggestedReplies();
  const suggestedRepliesActive = hasActiveSuggestedReplies(suggestedReplies);
  const readingColumnClass = "chat-reading-column mx-auto w-full max-w-(--reading-column-max)";
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hidden,
    hasApiKey, settingsLoaded, onOpenSettings,
    searchOpen, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget, autoCompactEnabled,
    tpmLimit, tpmPct,
    rolePresets, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    enableThinkingChat, processingDisplayLevel, reasoningAvailable, toggleThinking, usageAvailable, subscriptionRuntimePolicy, subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider, subscriptionUnavailableProvider, subscriptionPendingProvider,
    costEstimate, costBadgeClass, activeVendor,
    llmVendor, llmModel, llmRouteModalities,
  } = useChatContext();

  // Checkpoint view mode owns both transcript slicing and auto-scroll suppression.
  const [viewMode, setViewMode] = useState<ViewModeState | null>(null);

  const visibleEntries = useMemo(
    () => viewMode ? entries.slice(0, viewMode.slicedRangeEnd) : entries,
    [entries, viewMode],
  );
  // Offer new-chat controls only after readiness settles, with no pending request or suggestion ghost.
  const emptyConversation =
    hasAskQuestions === false &&
    visibleEntries.length === 0 &&
    hasApiKey !== null &&
    !suggestedRepliesActive &&
    viewMode === null;
  // Composer width follows layout, not emptiness, to avoid a jump on first send.
  const dockColumnClass = "chat-composer-column mx-auto w-full max-w-(--reading-column-max) min-w-0";
  // Close the project selector when its empty-state trigger unmounts.
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  useEffect(() => {
    if (!emptyConversation) setProjectSelectorOpen(false);
  }, [emptyConversation]);
  // Sub-agent rows come only from live spawn events with addressable child session ids.
  const [openedDocuments, setOpenedDocuments] = useState<{ sessionId: string; targets: ChatPreviewTarget[] } | null>(null);
  const previewModel = useMemo(() => {
    const model = collectChatPreviewModel({ entries: visibleEntries, attachments });
    model.targets = model.targets.map((target) => target.kind === "file" && target.sourceTurnId !== undefined
      ? { ...target, workspaceRoot: activeProject?.projectRoot }
      : target);
    if (openedDocuments?.sessionId === currentSessionId) {
      const openedTargetIds = new Set(openedDocuments.targets.map((target) => target.id));
      model.targets = model.targets.filter((target) => !openedTargetIds.has(target.id));
      model.targets.push(...openedDocuments.targets);
    }
    return model;
  }, [attachments, visibleEntries, openedDocuments, currentSessionId, activeProject?.projectRoot]);
  const reviewTurnKey = useMemo(() => visibleEntries.reduce((key, entry, index) =>
    entry.kind === "user" && isTurnStartEntry(entry) ? entry.messageId ?? String(index) : key, ""), [visibleEntries]);
  const workspaceChanges = useWorkspaceChanges({ api, sessionId: currentSessionId, streaming,
    turnKey: reviewTurnKey, files: previewModel.files, targets: previewModel.targets, workspaceRoot: activeProject?.projectRoot });
  const [fileReveal, setFileReveal] = useState<{ sessionId: string; request: FileWorkspaceReveal } | null>(null);
  const previewTargetIdKey = useMemo(
    () => previewModel.targets.map((target) => target.id).join("\u0001"),
    [previewModel.targets],
  );
  const previewTargetIds = useMemo(
    () => new Set(previewModel.targets.map((target) => target.id)),
    [previewModel.targets],
  );
  // Read target ids through a ref so session-switch pruning sees the entries committed with the new session id.
  const previewTargetIdsRef = useRef(previewTargetIds);
  useEffect(() => {
    previewTargetIdsRef.current = previewTargetIds;
  }, [previewTargetIds]);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  // Keep workspace tabs in ChatView so closing the rail or navigating away does not destroy them.
  const workspaceTabs = useWorkspaceTabs();
  const handleRevealChangedFile = useCallback((path: string) => {
    workspaceTabs.ensureContainerTab("file-browser");
    setFileReveal((previous) => ({ sessionId: currentSessionId, request: { path, token: (previous?.request.token ?? 0) + 1 } }));
    onSidePanelOpenChange(true);
  }, [workspaceTabs, currentSessionId, onSidePanelOpenChange]);
  const surfaceMoves = useSurfaceMoves();
  const { adoptTab, releaseTab, hasTab, setActiveTabId: selectWorkspaceTab } = workspaceTabs;
  const openSidePanelRef = useRef(onSidePanelOpenChange);
  openSidePanelRef.current = onSidePanelOpenChange;
  // Persist terminal directories and page addresses with the pane layout.
  const savedTabsRef = useRef({ tabs: workspaceTabs.tabs, browserUrlByTab: workspaceTabs.browserUrlByTab, activeTabId: workspaceTabs.activeTabId });
  savedTabsRef.current = { tabs: workspaceTabs.tabs, browserUrlByTab: workspaceTabs.browserUrlByTab, activeTabId: workspaceTabs.activeTabId };
  const sidePanelVisibleRef = useRef(false);
  // A tab that moved away and left the panel empty takes the panel with it: an open panel with no tabs is the workspace
  // launcher, which nobody asked for here and which floats over the conversation once the move narrows it.
  const releasedTabRef = useRef(false);
  useEffect(() => {
    if (!releasedTabRef.current) return;
    releasedTabRef.current = false;
    if (workspaceTabs.tabs.length === 0) openSidePanelRef.current(false);
  }, [workspaceTabs.tabs]);
  useEffect(() => {
    if (chatGroupId === undefined) return undefined;
    const unregister = registerSideTabsSink(chatGroupId, {
      adopt: adoptTab,
      // Whether the move emptied the panel is decided once the tab list commits (below), not from this render's list:
      // a tab adopted in the same batch keeps the panel open.
      release: (tabId) => {
        const tab = releaseTab(tabId);
        if (tab) releasedTabRef.current = true;
        return tab;
      },
      open: () => openSidePanelRef.current(true),
      activate: (tabId) => {
        if (!hasTab(tabId)) return false;
        selectWorkspaceTab(tabId);
        openSidePanelRef.current(true);
        return true;
      },
      snapshot: () => {
        const { tabs, browserUrlByTab } = savedTabsRef.current;
        return tabs.filter((tab) => isMovableTabKind(tab.kind)).map((tab) => savedSurfaceOf(
          { tabId: tab.id, kind: tab.kind as MovableTabKind, ordinal: tab.ordinal },
          tab.kind === "terminal" ? terminalCwd(tab.id) : null,
          tab.kind === "browser" ? webSurfaceLocation(tab.id) ?? browserUrlByTab[tab.id] ?? null : null,
        ));
      },
      visibleTabId: () => {
        if (!sidePanelVisibleRef.current) return null;
        const { tabs, activeTabId } = savedTabsRef.current;
        return (tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.id ?? null;
      },
    });
    for (const tab of takeRestoredSideTabs(chatGroupId)) adoptTab({ id: tab.tabId, kind: tab.kind, ordinal: tab.ordinal }, tab.url);
    return () => {
      unregister();
      // Clear the side-chat target when its group leaves.
      for (const tab of savedTabsRef.current.tabs) if (isMovableTabKind(tab.kind)) forgetActiveSurface(tab.id);
    };
  }, [chatGroupId, adoptTab, releaseTab, hasTab, selectWorkspaceTab]);
  const savedTabsKey = workspaceTabs.tabs.filter((tab) => isMovableTabKind(tab.kind)).map((tab) => `${tab.id}=${workspaceTabs.browserUrlByTab[tab.id] ?? ""}`).join("|");
  const seenSubAgentSpawnKeysRef = useRef<Set<string>>(new Set());
  // Keep persisted panel width beside the tab store so it survives panel unmount.
  const {
    width: sidePanelWidth,
    setWidth: setSidePanelWidth,
    commitWidth: commitSidePanelWidth,
  } = usePanelWidth(api, SIDE_PANEL_WIDTH_PREF);
  // Measure both optional columns so hiding one cannot change the visibility decision.
  const chatViewRootRef = useRef<HTMLDivElement | null>(null);
  const [chatViewRootElement, setChatViewRootElement] = useState<HTMLDivElement | null>(null);
  const handleChatViewRootRef = useCallback((element: HTMLDivElement | null) => {
    chatViewRootRef.current = element;
    setChatViewRootElement(element);
  }, []);
  const dockedPanelMotionRef = useRef<HTMLDivElement | null>(null);
  const panelSlot = usePanePanelSlot();
  const inFrame = panelSlot !== null;
  const panelHost = panelSlot?.panel ?? null;
  const tileElement = panelSlot?.tile ?? null;
  const { width: containerWidth, isNarrow } = useContainerNarrow(inFrame ? tileElement : chatViewRootElement);
  const columns = chatColumnsLayout(containerWidth, thumbnailOpen, sidePanelOpen, sidePanelWidth, isNarrow);
  // An explicitly revealed file remains reachable when the chat cannot spare a docked column.
  const revealedPanelOverlay = sidePanelOpen && columns.panelHiddenForWidth && fileReveal?.sessionId === currentSessionId;
  useEffect(() => {
    onColumnsVisibilityChange?.({ thumbnailHiddenForWidth: columns.thumbnailHiddenForWidth, panelHiddenForWidth: columns.panelHiddenForWidth && !revealedPanelOverlay });
  }, [onColumnsVisibilityChange, columns.thumbnailHiddenForWidth, columns.panelHiddenForWidth, revealedPanelOverlay]);
  const panelLayout = revealedPanelOverlay ? sidePanelLayout(containerWidth, true) : columns.panelLayout;
  const dockedPanelWidth = revealedPanelOverlay
    ? Math.min(panelLayout.max, Math.max(panelLayout.min, sidePanelWidth)) : columns.panelWidth;
  const dockedPanelShouldOpen = columns.panelVisible || revealedPanelOverlay;
  sidePanelVisibleRef.current = dockedPanelShouldOpen && !hidden;
  useEffect(() => {
    emitMainLayoutChange();
  }, [savedTabsKey, workspaceTabs.activeTabId, dockedPanelShouldOpen, hidden]);
  const dockedPanelMotion = useDockedPanelMotion(dockedPanelShouldOpen);
  const { present: dockedPanelPresent, expanded: dockedPanelExpanded } = dockedPanelMotion;
  // Keep side-chat and agent-browser tabs mounted while hidden to preserve pending gates and working pages.
  const sideChatKeepsPanel = workspaceTabs.tabs.some((tab) =>
    (tab.kind === "side-chat" && !tab.content) || tab.agentRequestId !== undefined);
  const [sidePanelResizing, setSidePanelResizing] = useState(false);
  useAgentDocumentPanel({
    api: window.ave?.preview, sessionId: currentSessionId ?? undefined, workspaceTabs,
    panelVisible: dockedPanelShouldOpen && dockedPanelPresent && dockedPanelExpanded, panelHidden: columns.panelHiddenForWidth && !revealedPanelOverlay,
    element: () => chatViewRootRef.current, targets: previewModel.targets,
    addTarget: (sessionId, target) => setOpenedDocuments((previous) => ({ sessionId, targets: [
      ...(previous?.sessionId === sessionId ? previous.targets.filter((existing) => existing.id !== target.id) : []), target,
    ] })),
    openPanel: () => onSidePanelOpenChange(true),
  });

  // A closing panel stops any resize in progress.
  useEffect(() => {
    if (!dockedPanelShouldOpen) setSidePanelResizing(false);
  }, [dockedPanelShouldOpen]);

  const handleSidePanelWidthChange = useCallback(
    (px: number) => {
      setSidePanelResizing(true);
      setSidePanelWidth(px);
    },
    [setSidePanelWidth],
  );
  const handleSidePanelWidthCommit = useCallback(
    (px: number) => {
      setSidePanelResizing(false);
      setSidePanelWidth(px);
      commitSidePanelWidth(Math.max(SIDE_PANEL_MIN_RESERVE, px));
    },
    [commitSidePanelWidth, setSidePanelWidth],
  );

  // Tool-derived local paths have no authorized OS-open channel; offer system-open only for web items.
  const toolActivity = useMemo(() => computeToolActivity(entries), [entries]);
  const promptHistory = useMemo(() => collectPromptHistory(entries), [entries]);
  // Offer interrupted-session continuation; never run it automatically.
  const interruptedOffer = useMemo(
    () => (streaming || viewMode || !currentSessionId || !onContinueFromLastUser
      ? null
      : interruptedTurnOffer(entries)),
    [entries, streaming, viewMode, currentSessionId, onContinueFromLastUser],
  );
  // Suggested tasks fill the composer for user review and placeholder replacement before sending.
  const handleChooseSuggestedTask = useCallback((task: SuggestedTask) => {
    setQuestion(task.prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [setQuestion]);

  // Single-click reuses an ephemeral preview; double-click pins a durable tab.
  const routeActivity = useCallback((target: string, web: boolean, mode: "ephemeral" | "pinned") => {
    const open = mode === "pinned" ? workspaceTabs.openPinned : workspaceTabs.openInEphemeral;
    if (web) {
      const safe = normalizeBrowserNavigationUrl(target);
      if (!safe) return;
      open({ source: "browser", url: safe });
    } else {
      const fileTarget = previewModel.targets.find(
        (candidate) => "path" in candidate && candidate.path === target,
      );
      if (fileTarget) {
        open({ source: "preview", targetId: fileTarget.id });
      } else {
        // Open the file browser when a path has no preview target.
        workspaceTabs.addTab("file-browser");
      }
    }
    onSidePanelOpenChange(true);
  }, [workspaceTabs, previewModel.targets, onSidePanelOpenChange]);
  const routeActivityItem = useCallback(
    (target: string, web: boolean) => routeActivity(target, web, "ephemeral"),
    [routeActivity],
  );
  const handlePreviewTarget = useCallback((target: ChatPreviewTarget) => {
    const openedTarget = target.kind === "file" ? { ...target, workspaceRoot: activeProject?.projectRoot } : target;
    setOpenedDocuments((previous) => ({ sessionId: currentSessionId, targets: [
      ...(previous?.sessionId === currentSessionId ? previous.targets.filter((existing) => existing.id !== target.id) : []),
      openedTarget,
    ] }));
    workspaceTabs.openInEphemeral({ source: "preview", targetId: target.id });
    setSelectedPreviewId(target.id);
    onSidePanelOpenChange(true);
  }, [workspaceTabs, onSidePanelOpenChange, currentSessionId, activeProject?.projectRoot]);
  const routeActivityItemPinned = useCallback(
    (target: string, web: boolean) => routeActivity(target, web, "pinned"),
    [routeActivity],
  );

  const openActivityItemInSystemApp = useCallback((target: string, web: boolean) => {
    if (web) {
      const safe = normalizeBrowserNavigationUrl(target);
      if (safe) void api.openExternalUrl(safe);
    }
    // Tool-derived local paths have no authorized OS-open channel.
  }, [api]);

  useEffect(() => {
    setSelectedPreviewId(null);
  }, [currentSessionId]);

  // Prune session-scoped tabs only on session switch; URL and launcher tabs outlive sessions, and streaming reclassification
  // must not close tabs.
  const { pruneContentTabs, closeContainerTab } = workspaceTabs;
  useEffect(() => {
    pruneContentTabs((targetId) => previewTargetIdsRef.current.has(targetId));
  }, [currentSessionId, pruneContentTabs]);

  // Sub-agent lists belong to a conversation and close on session switch; terminal/browser containers outlive it.
  useEffect(() => {
    closeContainerTab("subagent");
  }, [currentSessionId, closeContainerTab]);

  // Auto-open for new live sub-agent spawns, never for rows restored from disk.
  useEffect(() => {
    let sawLiveSpawn = false;
    for (const spawn of subAgentSpawns) {
      const key = `${currentSessionId}:${spawn.spawnId}`;
      if (seenSubAgentSpawnKeysRef.current.has(key)) continue;
      seenSubAgentSpawnKeysRef.current.add(key);
      if (!spawn.restored) sawLiveSpawn = true;
    }
    if (!sawLiveSpawn) return;
    workspaceTabs.ensureContainerTab("subagent");
    onSidePanelOpenChange(true);
  }, [currentSessionId, subAgentSpawns, workspaceTabs, onSidePanelOpenChange]);

  // Key side-chat requests only on nonce to prevent tab changes reopening the panel; refs keep browser registrations stable.
  const browserTabHostRef = useRef({ workspaceTabs, currentSessionId, onSidePanelOpenChange });
  useEffect(() => () => {
    if (currentSessionId) releaseBrowserObservationSession(currentSessionId);
  }, [currentSessionId]);
  useLayoutEffect(() => {
    browserTabHostRef.current = { workspaceTabs, currentSessionId, onSidePanelOpenChange };
  }, [workspaceTabs, currentSessionId, onSidePanelOpenChange]);
  useEffect(() => registerBrowserTabHost(api, {
    sessionId: () => browserTabHostRef.current.currentSessionId ?? null,
    hasTab: (tabId) => browserTabHostRef.current.workspaceTabs.tabs.some((tab) => tab.id === tabId),
    openAgentTab: (url, requestId, active) => {
      const { workspaceTabs: store, onSidePanelOpenChange: openPanel } = browserTabHostRef.current;
      if (store.openAgentBrowserTab(url, requestId, active) !== null && active) openPanel(true);
    },
    selectTab: (tabId) => {
      browserTabHostRef.current.workspaceTabs.setActiveTabId(tabId);
      browserTabHostRef.current.onSidePanelOpenChange(true);
    },
    closeTab: (tabId) => browserTabHostRef.current.workspaceTabs.closeTab(tabId),
  }), [api]);

  const sideChatOpenNonce = sideChatOpenRequest?.nonce;
  const openSideChatTabRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    openSideChatTabRef.current = () => {
      workspaceTabs.ensureContainerTab("side-chat");
      onSidePanelOpenChange(true);
    };
  }, [workspaceTabs, onSidePanelOpenChange]);
  useEffect(() => {
    if (sideChatOpenNonce === undefined) return;
    openSideChatTabRef.current();
  }, [sideChatOpenNonce]);

  useEffect(() => {
    if (previewModel.targets.length === 0) {
      setSelectedPreviewId(null);
      return;
    }
    if (selectedPreviewId && previewModel.targets.some((target) => target.id === selectedPreviewId)) return;
    setSelectedPreviewId(previewModel.targets[0]?.id ?? null);
  }, [previewModel.targets, previewTargetIdKey, selectedPreviewId]);

  const hasActiveStreamingEntry = useMemo(
    () => visibleEntries.some((entry) => "streaming" in entry && entry.streaming === true),
    [visibleEntries],
  );

  const turnSummaryByTurnStart = useMemo(() => {
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < visibleEntries.length; i++) {
      const e = visibleEntries[i];
      if (!e) continue;
      if (isTurnStartEntry(e)) curTurnStart = i;
      else if (e.kind === "turn_summary" && curTurnStart >= 0) {
        map.set(curTurnStart, {
          ...(e.endedByEndTurn === true ? { endedByEndTurn: true as const } : {}),
          turnDurationMs: e.turnDurationMs,
          toolCount: e.toolCount,
          cumulativeToolMs: e.cumulativeToolMs,
          tokensIn: e.tokensIn,
          freshInputTokens: e.freshInputTokens,
          tokensOut: e.tokensOut,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
          ...(e.vendorProvider !== undefined ? { vendorProvider: e.vendorProvider } : {}),
          ...(e.vendorModel !== undefined ? { vendorModel: e.vendorModel } : {}),
          ...(e.usageByModel !== undefined ? { usageByModel: e.usageByModel } : {}),
          ...(e.subscriptionUsage !== undefined ? { subscriptionUsage: e.subscriptionUsage } : {}),
        });
      }
    }
    return map;
  }, [visibleEntries]);

  const { scrollViewportRef, showJumpToBottom, scrollChatToBottom } = useChatScroll({
    entries,
    currentSessionId,
    chatEndRef,
    viewMode,
    searchOpen,
    searchMatches,
    searchIdx,
    hidden,
  });

  const { forkToast, handleEnterView, handleExitView, handleBranchFrom } = useCheckpointView({
    api,
    currentSessionId,
    entries,
    streaming,
    hasActiveStreamingEntry,
    onLoadSession,
    onContinueFromLastUser,
    setViewMode,
    scrollChatToBottom,
  });

  // Memoize the guide-channel object because the queue hook registers shortcuts against its identity.
  const messageQueueGuide = useMemo(
    () => ({ inject: onGuide, onError: onGuideError }),
    [onGuide, onGuideError],
  );
  // /allow proposes a choice to the app-owned approval dock instead of sending to the model.
  const {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  } = useMessageQueue({
    surface: "main",
    subscribeStream: api.onChatStream,
    composerRef,
    currentSessionId,
    question,
    attachments,
    streaming,
    setQuestion,
    setAttachments,
    onAsk,
    guide: messageQueueGuide,
    onAbort,
    interceptSubmit: approvalSentenceInterceptSubmit,
  });

  // Clear queued messages only after the host confirms a conversation rewind.
  const [rewindEntryIdx, setRewindEntryIdx] = useState<number | null>(null);
  const handleReturnHere = useCallback(async (idx: number) => {
    setRewindEntryIdx(idx);
    return { ok: false };
  }, []);
  const handleRestore = useCallback(async (mode: RewindMode) => {
    if (rewindEntryIdx === null || streaming) return { ok: false };
    const result = await onReturnHere(rewindEntryIdx, mode);
    if (result.ok) {
      if (mode !== "code") messageQueueStore.clear();
    }
    setRewindEntryIdx(null);
    return result;
  }, [onReturnHere, messageQueueStore, rewindEntryIdx, streaming]);
  useEffect(() => { setRewindEntryIdx(null); }, [currentSessionId]);

  const handleInsertSlashCommand = useCallback((cmd: string) => {
    setQuestion((prev) => (prev ? `${prev}${cmd} ` : `${cmd} `));
  }, [setQuestion]);

  const handleBottomSend = useCallback(() => {
    // The click is the gesture: capture its one-shot keyboard intent now.
    handleComposerSend(captureComposerKeyboardIntent());
  }, [handleComposerSend]);

  const runtimeImageAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.imageAttachmentProvider
    : subscriptionImageAttachmentProvider;
  const runtimeFileAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.fileAttachmentProvider
    : subscriptionFileAttachmentProvider;
  const runtimeUnavailableProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.unavailableProvider
    : subscriptionUnavailableProvider;
  const runtimePendingProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.pendingProvider
    : subscriptionPendingProvider;
  const attachmentUnavailableProvider = subscriptionRuntimePolicy?.provider
    ?? runtimeImageAttachmentProvider
    ?? runtimeFileAttachmentProvider
    ?? "subscription";
  const emitAttachmentUnavailable = useCallback(() => {
    onAttachmentWarning?.(t("app.subscriptionAttachmentUnsupported", {
      provider: attachmentUnavailableProvider,
    }));
  }, [attachmentUnavailableProvider, onAttachmentWarning, t]);
  const emitImageAttachmentLimitExceeded = useCallback(() => {
    onAttachmentWarning?.(t("app.subscriptionImageAttachmentLimitExceeded", {
      provider: attachmentUnavailableProvider,
    }));
  }, [attachmentUnavailableProvider, onAttachmentWarning, t]);
  const emitPastedTextClipped = useCallback((info: { keptChars: number; totalChars: number }) => {
    onAttachmentWarning?.(t("app.pastedTextClipped", {
      keptChars: info.keptChars,
      totalChars: info.totalChars,
    }));
  }, [onAttachmentWarning, t]);

  const emitDropRejected = useCallback((count: number) => {
    onAttachmentWarning?.(t("app.dropRejected", { count }));
  }, [onAttachmentWarning, t]);
  const { handleAttach, handleDropFiles, attachPastedText } = useAttachmentPicker({
    attachmentNCounter,
    setAttachments,
    setQuestion,
    composerRef,
    onDropRejected: emitDropRejected,
    imagesEnabled: subscriptionRuntimePolicy ? subscriptionRuntimePolicy.imagesEnabled : settingsLoaded !== false && runtimeImageAttachmentProvider === undefined,
    filesEnabled: subscriptionRuntimePolicy ? subscriptionRuntimePolicy.filesEnabled : settingsLoaded !== false && runtimeFileAttachmentProvider === undefined,
    imageAttachmentLimits: subscriptionRuntimePolicy?.imageAttachmentLimits,
    onAttachmentUnavailable: emitAttachmentUnavailable,
    onImageAttachmentLimitExceeded: emitImageAttachmentLimitExceeded,
    onPastedTextClipped: emitPastedTextClipped,
  });

  // Register the composer once per group through refs.
  const attachPastedTextRef = useRef(attachPastedText);
  attachPastedTextRef.current = attachPastedText;
  const conversationHiddenRef = useRef(hidden);
  conversationHiddenRef.current = hidden;
  useEffect(() => {
    if (chatGroupId === undefined) return undefined;
    return registerComposerTarget({
      groupId: chatGroupId,
      kind: "conversation",
      attach: (text) => attachPastedTextRef.current(text),
      available: () => !conversationHiddenRef.current,
      element: () => chatViewRootRef.current?.querySelector<HTMLElement>('[data-composer-surface="main"]') ?? null,
    });
  }, [chatGroupId]);
  // Side-panel terminal blocks attach to the group's last-used composer, including side chat.
  const attachFromSidePanel = useCallback(
    (text: string) => (chatGroupId === undefined ? attachPastedText(text) : attachToComposer(text, { fromGroup: chatGroupId })),
    [chatGroupId, attachPastedText],
  );

  const ringSlot = useMemo(() => {
    // Subscription runtimes have no verified API billing/context contract; do not present disabled projections as zero limits.
    if (usageAvailable === false) return null;
    return (
      <TokenProgressRing
        used={usedTokens}
        budget={effectiveBudget}
        contextBudget={contextBudget}
        tpmLimit={tpmLimit}
        costEstimate={costEstimate}
        costClass={costBadgeClass}
      />
    );
  }, [contextBudget, costBadgeClass, costEstimate, effectiveBudget, tpmLimit, usageAvailable, usedTokens]);

  const inputStatusRow = useInputStatusRow(api);
  const onOpenModelSettings = useCallback(() => onOpenSettings("llm"), [onOpenSettings]);
  const onOpenInputPermissions = useCallback(() => onOpenSettings("permissions"), [onOpenSettings]);

  // Composer-dock questions stay visible independently of transcript scrolling.
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return; // Preserve native Ctrl+C in inputs, textareas and contenteditable elements.
        const target = e.target as HTMLElement;
        const isEditable =
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        void onAbort();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, onAbort]);

  const transcriptEntries = (
    <TranscriptRenderer
      observeTerminal={!hidden}
      entries={visibleEntries}
      streaming={streaming}
      currentSessionId={currentSessionId}
      viewMode={viewMode}
      edit={{ editingEntryIdx, editBusy, setEditingEntryIdx, onEditSave }}
      search={{ searchOpen, searchMatches, searchMatchSet, searchIdx, searchHighlight }}
      actions={{
        isEntryStarred,
        onFork,
        onReturnHere: handleReturnHere,
        onToggleStar,
        onRetryEffort,
        onFeedback,
        handleEnterView,
        handleBranchFrom,
      }}
      turnSummaryByTurnStart={turnSummaryByTurnStart}
      activeVendor={activeVendor}
      showTokenCostBadge={usageAvailable !== false}
      debugStreamEnabled={debugStreamEnabled}
      processingDisplayLevel={processingDisplayLevel}
      onPreviewTarget={handlePreviewTarget}
    />
  );

  return (
    <div
      ref={handleChatViewRootRef}
      className="relative flex min-h-0 min-w-0 w-full flex-1 flex-row overflow-hidden"
      data-testid={TEST_IDS.chatViewRoot}
    >
      <div
        className={`@container/chat-transcript relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [container-type:size] ${approvalHead !== null && panelLayout.mode === "overlay" ? "z-50" : ""}`}
        data-testid="chat-main-column"
      >

      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      <div className="grid h-full min-h-0 min-w-0 grid-cols-1">
      <div className="relative min-h-0 min-w-0 overflow-hidden">
      {/* Checkpoint view-mode banner — sticky at the top of the chat scroll area */}
      <ViewModeBanner viewMode={viewMode} onExit={() => { void handleExitView(); }} />
      {/* Fork-success toast — auto-dismisses after 3 s */}
      {forkToast && (
        <div
          data-testid="fork-toast"
          className={`${chatSurface()} sticky top-0 z-30 mx-3 mt-2 px-3 py-2 text-xs text-foreground`}
        >
          {forkToast}
        </div>
      )}
      {currentSessionKind === "routine" && (
        <div
          data-testid="current-session-kind-banner"
          className={`${chatSurface()} sticky top-0 z-20 mx-3 mt-2 px-3 py-2 text-xs text-action-view`}
        >
          <span className="font-medium">{t("chatView.routineSessionLabel")}</span>
          {currentSessionTitle ? <span className="ml-2 text-muted-foreground">{currentSessionTitle}</span> : null}
        </div>
      )}
      <ChatTranscript
        scrollViewportRef={scrollViewportRef}
        readingColumnClass={readingColumnClass}
        loadedSkills={loadedSkills}
        visibleEntries={visibleEntries}
        hasApiKey={hasApiKey}
        hasAskQuestions={hasAskQuestions}
        suggestedRepliesActive={suggestedRepliesActive}
        transcriptEntries={transcriptEntries}
        chatEndRef={chatEndRef}
        streaming={streaming}
        emptyState={
          emptyConversation && hasApiKey === true ? (
            <SuggestedTasksPanel onChoose={handleChooseSuggestedTask} />
          ) : null
        }
      />
      {showJumpToBottom && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="ave-surface-raised absolute bottom-4 right-5 z-20 h-8 rounded-full bg-card/(--opacity-solid) px-3 text-xs backdrop-blur"
          onClick={() => scrollChatToBottom("smooth")}
          data-testid="jump-to-bottom"
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          {t("chatView.jumpToBottom")}
        </Button>
      )}
      </div>
      </div>
      </div>
      <InterruptedTurnBanner
        offer={interruptedOffer}
        onContinue={() => {
          if (!currentSessionId || !onContinueFromLastUser) return;
          // "resume" appends a new user row ("Continue") after the interrupted answer; "rerun" re-asks the user's own last message,
          // already on screen.
          void onContinueFromLastUser(
            currentSessionId,
            interruptedOffer === "resume" ? { userBubble: t("chatView.interruptedTurnContinue") } : undefined,
          );
        }}
      />
      <ChatComposerDock
        dockColumnClass={dockColumnClass}
        notices={<>
          <ComposerContextNotice percent={contextOverflowPct} autoCompactEnabled={autoCompactEnabled} />
          {typeof tpmPct === "number" && typeof tpmLimit === "number" && tpmPct >= 0.80 && (
            <div className={`${chatSurface({ edge: "quiet", elevation: "flat" })} mb-2 flex min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-xs text-warning`} role="status" aria-live="polite">
              <span className="font-medium">{t("chatView.tpmUsagePercent", { pct: Math.round(tpmPct * 100), used: formatTokensExact(usedTokens), limit: formatTokensExact(tpmLimit) })}</span>
              <span>{t(tpmPct >= 0.95 ? "chatView.tpmOverflowWarning" : "chatView.tpmNearingWarning")}</span>
            </div>
          )}
        </>}
        emptyConversation={emptyConversation}
        onOpenSettings={onOpenSettings}
        workflowApi={workflowApi}
        api={api}
        currentSessionId={currentSessionId}
        workspaceChanges={workspaceChanges}
        onRevealChangedFile={handleRevealChangedFile}
        messageQueueStore={messageQueueStore}
        onMessageQueueSendNow={handleMessageQueueSendNow}
        question={question}
        promptHistory={promptHistory}
        statusBar={statusBar}
        composerRef={composerRef}
        setQuestion={setQuestion}
        attachments={attachments}
        setAttachments={setAttachments}
        attachmentNCounter={attachmentNCounter}
        onComposerSend={handleComposerSend}
        suggestedReplies={suggestedReplies}
        commandActions={commandActions}
        plugins={plugins}
        onSelectPlugin={onSelectPlugin}
        hasApiKey={hasApiKey}
        viewMode={viewMode}
        streaming={streaming}
        onInsertSlashCommand={handleInsertSlashCommand}
        onRunMcpPrompt={onRunMcpPrompt}
        onRunPluginPrompt={onRunPluginPrompt}
        slashPickerOpen={slashPickerOpen}
        onSlashPickerOpenChange={onSlashPickerOpenChange}
        ringSlot={ringSlot}
        onImageAttachmentUnavailable={emitAttachmentUnavailable}
        onImageAttachmentLimitExceeded={emitImageAttachmentLimitExceeded}
        onAttach={handleAttach}
        onDropFiles={handleDropFiles}
        subscriptionRuntimePolicy={subscriptionRuntimePolicy}
        subscriptionImageAttachmentProvider={runtimeImageAttachmentProvider}
        subscriptionFileAttachmentProvider={runtimeFileAttachmentProvider}
        settingsLoaded={settingsLoaded}
        subscriptionUnavailableProvider={runtimeUnavailableProvider}
        subscriptionPendingProvider={runtimePendingProvider}
        llmVendor={llmVendor}
        llmModel={llmModel}
        llmRouteModalities={llmRouteModalities}
        rolePresets={rolePresets}
        activePresetId={activePresetId}
        onSelectPreset={setActivePresetId}
        onBottomSend={handleBottomSend}
        onCancel={flushQueueAsUserMessage}
        enableThinkingChat={enableThinkingChat}
        reasoningAvailable={reasoningAvailable}
        onToggleThinking={toggleThinking}
        inputStatusRow={inputStatusRow}
        onOpenModelSettings={onOpenModelSettings}
        onOpenPermissions={onOpenInputPermissions}
        onOpenApprovalQueue={onOpenApprovalQueue}
        pendingApprovals={pendingApprovals}
        askQuestions={askQuestions}
        onResolveAskQuestion={onResolveAskQuestion}
        activeProject={activeProject}
        workspaceProjects={workspaceProjects}
        onNewChatForProject={onNewChatForProject}
        onRefreshProjects={onRefreshProjects}
        onProjectError={onProjectError}
        projectSelectorOpen={projectSelectorOpen}
        onProjectSelectorOpenChange={setProjectSelectorOpen}
      />
      {/* This conversation's approval card, floating over its own composer.
          The pane frame around this view is the dock's scope: the composer it
          covers goes inert, the tile next door does not. */}
      <RewindDialog
        open={rewindEntryIdx !== null}
        onCancel={() => setRewindEntryIdx(null)}
        onRestore={handleRestore}
      />
      <ApprovalDock
        queue={pendingApprovals}
        conversationLabel={resolveConversationTitle({
          sessionId: currentSessionId ?? "",
          title: currentSessionTitle,
          messages: entries.flatMap((entry) => entry.kind === "user" || entry.kind === "assistant"
            ? [{ role: entry.kind, content: entry.text }] : []),
        }, t)}
        proposedChoice={
          approvalHead !== null && approvals.proposal?.requestId === approvalHead.id
            ? approvals.proposal.choice
            : null
        }
        onDecide={(choice, pattern, extras) => {
          if (approvalHead === null) return;
          void approvals.decide(approvalHead.id, choice, pattern, extras);
        }}
        onOpenPermanentDeny={approvals.openPermanentDeny}
        interactionLocked={approvalHead !== null && approvals.lockedRequestId === approvalHead.id}
        reviewerSuggestion={approvals.reviewerSuggestion}
      />
      </div>
      {columns.thumbnailVisible && (!inFrame || panelHost) ? (() => {
        const column = <aside style={{ width: CHAT_THUMBNAIL_WIDTH, order: 1 }} className="flex min-h-0 shrink-0 self-stretch overflow-hidden border-l" data-testid="chat-thumbnail-column">
          <ChatThumbnailColumn api={api} sessionId={currentSessionId} workspaceTabs={workspaceTabs} visible={!hidden}
            onOpenTab={(tabId) => {
              if (workspaceTabs.hasTab(tabId)) {
                workspaceTabs.setActiveTabId(tabId);
                onSidePanelOpenChange(true);
              } else {
                if (!surfaceMoves || chatGroupId === undefined) return;
                surfaceMoves.tabToSide(tabId, chatGroupId);
              }
            }}
            onCloseTab={closeBrowserTab} />
        </aside>;
        return panelHost ? createPortal(column, panelHost) : column;
      })() : null}
      {dockedPanelPresent || sideChatKeepsPanel ? (() => {
        // Inside a frame the panel waits for the slot to commit: rendering it inline for one pass and portaling it on the next
        // would remount the whole panel (a portal and a host element are different fiber kinds).
        if (inFrame && !panelHost) return null;
        const wrapper = (
        <DockedPanelColumn
          ref={dockedPanelMotionRef}
          id="chat-side-panel"
          testId="chat-side-panel-motion"
          motion={dockedPanelMotion}
          shouldOpen={dockedPanelShouldOpen}
          width={dockedPanelWidth}
          mode={panelLayout.mode}
          resizing={sidePanelResizing}
        >
          <ChatSidePanel
            api={api}
            visible={dockedPanelShouldOpen && !hidden}
            {...(chatGroupId !== undefined ? { chatGroupId } : {})}
            sessionId={currentSessionId}
            targets={previewModel.targets}
            files={previewModel.files}
            changes={workspaceChanges}
            revealRequest={fileReveal?.sessionId === currentSessionId ? fileReveal.request : null}
            onReference={(reference) => { composerRef.current?.insertFileReference(reference); }}
            onFileReference={(path) => { composerRef.current?.insertFileMention(path); }}
            selectedId={selectedPreviewId}
            onSelect={setSelectedPreviewId}
            workspaceTabs={workspaceTabs}
            subAgentSpawns={subAgentSpawns}
            width={dockedPanelWidth}
            minWidth={panelLayout.min}
            maxWidth={panelLayout.max}
            onWidthChange={handleSidePanelWidthChange}
            onWidthCommit={handleSidePanelWidthCommit}
            resizeElementRef={dockedPanelMotionRef}
            onClose={() => onSidePanelOpenChange(false)}
            sideChatOpenRequest={sideChatOpenRequest}
            onSessionsChanged={onSessionsChanged}
            sideChatPendingAnswer={sideChatPendingAnswer}
            activity={toolActivity}
            onOpenActivityItem={routeActivityItem}
            onOpenActivityItemPinned={routeActivityItemPinned}
            onOpenActivityItemInSystemApp={openActivityItemInSystemApp}
            onAttachText={attachFromSidePanel}
            className="relative flex shrink-0"
          />
        </DockedPanelColumn>
        );
        // Inside a frame the panel is the tile's guest, not this view's — see `PaneFrame`'s panel slot.
        return panelHost ? createPortal(wrapper, panelHost) : wrapper;
      })() : null}
    </div>
  );
}
