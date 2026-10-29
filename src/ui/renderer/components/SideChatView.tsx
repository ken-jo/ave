/** Pane side chats bind every turn to their surface tab; rail side chats name no tab. Both use the shared transcript
 * renderer. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { TranscriptRenderer } from "./TranscriptRenderer.js";
import { Composer, ComposerFrame, captureComposerKeyboardIntent, type ComposerHandle } from "./Composer.js";
import { BoundSurfaceChip, type BoundSurface } from "./BoundSurfaceChip.js";
import { registerComposerTarget } from "../preview/composer-targets.js";
import { ComposerApiKeyChip, resolveComposerRuntimeGates } from "./ChatComposerDock.js";
import { AttachButton, ShortcutsButton, TurnControlButton } from "./InputActionBar.js";
import { MessageQueuePanel } from "./MessageQueuePanel.js";
import { ShellTasksPanel } from "./ShellTasksPanel.js";
import { useSideChat } from "../hooks/use-side-chat.js";
import { useChatScroll } from "../hooks/use-chat-scroll.js";
import { useMessageQueue } from "../hooks/use-message-queue.js";
import { useAttachmentPicker } from "../hooks/use-attachment-picker.js";
import { computeComposerPlaceholder } from "../utils/composer-placeholder.js";
import { composeOutgoing } from "../utils/compose.js";
import { collectPromptHistory } from "../utils/prompt-history.js";
import { ATTACH_MAX_COUNT, type Attachment } from "../types/attachments.js";
import type { AveApi } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import { useOptionalChatContext, type ChatContextValue } from "../context/ChatContext.js";
import { useApprovalSurface } from "../hooks/use-approval.js";
import { useWorkflowTools } from "../hooks/use-workflow-tools.js";
import { ApprovalDock } from "./permissions/ApprovalDock.js";
import { QuestionOverlay } from "./QuestionOverlay.js";
import { sessionOwnedBy } from "./chat-group-session-registry.js";
import { formatIpcError } from "../format-ipc-error.js";
import { errorMessage } from "../../../shared/error-message.js";
import { DEFAULT_PROCESSING_DISPLAY_LEVEL } from "../../../shared/processing-display-level.js";
import { estimateOutgoingUserMessageTokens } from "../../../shared/multimodal-token-estimate.js";
import { useContextBudget } from "../hooks/use-context-budget.js";
import { ComposerContextNotice } from "./ComposerContextNotice.js";

/**
 * A sidebar row asking one tile to show a stored side chat.
 *
 * The rail's conversation loop is window-wide and its store isolated, so a side
 * chat cannot be loaded into a tile the way a conversation is: it is shown in
 * the tile's own side-chat tab. `nonce` is what makes the same side chat asked
 * for twice two requests — the ids alone compare equal and the second ask would
 * be indistinguishable from no ask at all.
 */
export interface SideChatOpenRequest {
  chatGroupId: string;
  sessionId: string;
  nonce: number;
}

/** The side transcript has no search band; the scroll hook still wants a stable list. */
const NO_SEARCH_MATCHES: number[] = [];

/**
 * The side chat claims approvals and questions for its own session only; a
 * sub-agent it starts runs a child session whose cards keep the window's
 * routing. The set is therefore empty by construction. It still claims through
 * the tile's own rule (`sessionOwnedBy`) so the two readers cannot drift.
 */
const NO_CHILD_SESSIONS: ReadonlySet<string> = new Set();

/** Stable empty lists: the composer's inline menu memoizes on their identity. */
const NO_COMMAND_ACTIONS: never[] = [];
const NO_INLINE_PLUGINS: never[] = [];
const NO_QUESTIONS: never[] = [];
const NOOP_SELECT_PLUGIN = () => {};

/** What the composer needs to know about the model it sends to. Inside a conversation tile it comes from the tile's chat
 * context; a pane chat, which has no conversation around it, is handed the window's. */
export type SideChatRuntime = Pick<ChatContextValue,
  | "hasApiKey" | "settingsLoaded" | "onOpenSettings"
  | "subscriptionRuntimePolicy" | "subscriptionImageAttachmentProvider" | "subscriptionFileAttachmentProvider"
  | "subscriptionUnavailableProvider" | "subscriptionPendingProvider"
  | "llmVendor" | "llmModel" | "llmRouteModalities" | "processingDisplayLevel" | "usageAvailable"
  | "llmContextWindow" | "llmInputLimit" | "autoCompactEnabled">;

interface SideChatViewProps {
  api: AveApi;
  /** The terminal or page of the pane this chat sits in (a pane's own chat). Every turn names it, so the chat's tools act on
   * that pane by default. */
  boundSurface?: BoundSurface | undefined;
  /** The model readiness for a chat with no conversation tile around it. */
  runtime?: SideChatRuntime | undefined;
  /** What a chat that is not a pane's acts on, drawn above its composer (the rail's chip for the window's active terminal or
   * page). */
  targetChip?: ReactNode;
  /** A stored side chat this panel has been asked to show. */
  openRequest?: SideChatOpenRequest | undefined;
  /** A turn here creates or moves a row in the window's conversation list — a side chat is listed under the conversation it
   * belongs to — and the list is read, not pushed, so it has to be told. */
  onSessionsChanged?: (() => void | Promise<void>) | undefined;
  /** This tab is the one the panel is showing. The view stays mounted behind another tab so its session and its parked cards
   * survive the switch; this says whether the user can see them. */
  shown?: boolean;
  /**
   * The session this side chat holds, reported to the panel that hosts it
   * whenever it changes. The panel keeps the sub-agents that session's turns
   * start (#2345) and draws them in its sub-agent tab. The panel, not this
   * view, owns them: closing the side-chat tab unmounts the view while its
   * loop — and the agents it started — keeps running in main.
   */
  onSessionIdChange?: ((sessionId: string) => void) | undefined;
  /** Lets the retained panel observe this exact claim after the side view closes. */
  onSessionClaim?: ((isCurrent: () => boolean) => void) | undefined;
  /** The conversation group whose side panel holds this chat: its composer is one a terminal block in that panel can be
   * attached to. */
  chatGroupId?: string | undefined;
}

export function SideChatView({ api, openRequest, onSessionsChanged, shown = true, onSessionIdChange, onSessionClaim, chatGroupId, boundSurface, runtime, targetChip }: SideChatViewProps) {
  const { t } = useTranslation();
  // If side chat is unavailable (preload without the surface), surface a stable disabled state rather than a broken
  // composer.
  const sideChat = api.sideChat;
  if (!sideChat) {
    return (
      <div
        className="p-4 text-xs text-muted-foreground"
        data-testid="chat-side-panel-side-chat-unavailable"
      >
        {t("chatPreviewRail.sideChat.unavailable")}
      </div>
    );
  }
  return (
    <SideChatSession
      api={api}
      sideChat={sideChat}
      openRequest={openRequest}
      onSessionsChanged={onSessionsChanged}
      shown={shown}
      onSessionIdChange={onSessionIdChange}
      onSessionClaim={onSessionClaim}
      chatGroupId={chatGroupId}
      boundSurface={boundSurface}
      runtime={runtime}
      targetChip={targetChip}
    />
  );
}

function SideChatSession({
  api,
  sideChat,
  openRequest,
  onSessionsChanged,
  shown,
  onSessionIdChange,
  onSessionClaim,
  chatGroupId,
  boundSurface,
  runtime: runtimeProp,
  targetChip,
}: SideChatViewProps & { sideChat: NonNullable<AveApi["sideChat"]>; shown: boolean }) {
  const { t } = useTranslation();
  const chatContext = useOptionalChatContext();
  const runtime: SideChatRuntime | null = runtimeProp ?? chatContext;
  // A side chat runs its own session; its approval cards belong in this panel, which holds the claim while hidden as well as
  // while shown.
  const approvals = useApprovalSurface();
  useSyncExternalStore(approvals.claims.subscribe, approvals.claims.readVersion, approvals.claims.readVersion);
  const sessionIdRef = useRef<string | null>(null);
  const bindingActiveRef = useRef(true);
  const onSessionIdChangeRef = useRef(onSessionIdChange);
  const onSessionClaimRef = useRef(onSessionClaim);
  const claimRef = useRef<{
    sessionId: string;
    claims: typeof approvals.claims;
    ownsSession: (sessionId: string) => boolean;
    release: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    onSessionIdChangeRef.current = onSessionIdChange;
    onSessionClaimRef.current = onSessionClaim;
  }, [onSessionIdChange, onSessionClaim]);
  const hasCurrentClaim = useCallback(() => {
    const claim = claimRef.current;
    return bindingActiveRef.current && claim !== null &&
      claim.claims.isClaimCurrent(`side-chat:${claim.sessionId}`, claim.ownsSession);
  }, []);
  const handleSessionBound = useCallback((next: string) => {
    if (!bindingActiveRef.current) return;
    const changed = sessionIdRef.current !== next;
    sessionIdRef.current = next;
    const claim = claimRef.current;
    if (claim === null || claim.sessionId !== next || claim.claims !== approvals.claims || !hasCurrentClaim()) {
      claim?.release();
      const ownsSession = (id: string) => sessionOwnedBy(next, NO_CHILD_SESSIONS, id);
      claimRef.current = {
        sessionId: next,
        claims: approvals.claims,
        ownsSession,
        release: approvals.claims.claim(`side-chat:${next}`, ownsSession),
      };
    }
    // The predicate, claim and panel identity are ready before the host's next event in this dispatch, even while the session
    // state awaits a render.
    if (changed) onSessionIdChangeRef.current?.(next);
    const current = claimRef.current!;
    onSessionClaimRef.current?.(() => current.claims.isClaimCurrent(`side-chat:${next}`, current.ownsSession));
  }, [approvals.claims, hasCurrentClaim]);
  // Called BEFORE `useMessageQueue` below, so the transcript's stream listener
  // is registered first and judges each frame first. That ordering is no longer
  // load-bearing — the shared verdict is a pure read and the queue's drain is
  // deferred out of the dispatch — and `use-message-queue.test.ts` pins the
  // reversed order to keep it that way.
  const {
    entries,
    turnSummaryByTurnStart,
    isStreaming,
    sessionId,
    send,
    newSession,
    loadSession,
    restore,
    clear,
    abort,
    isCurrentTurnEvent,
  } = useSideChat(api, { onSessionBound: handleSessionBound, paneTabId: boundSurface?.tabId });
  // A pane chat is its pane's conversation: it opens on what the pane already said, read without moving the side loop, and
  // "New" ends it for the pane instead of switching the loop under another view's turn.
  const paneTabId = boundSurface?.tabId;
  const [paneError, setPaneError] = useState<string | null>(null);
  useEffect(() => {
    if (paneTabId === undefined) return undefined;
    let current = true;
    void sideChat.paneHistory(paneTabId).then((res) => {
      if (!current) return;
      if (!res.ok) setPaneError(formatIpcError(res.error, undefined));
      else if (res.sessionId !== null) restore(res.sessionId, res.messages);
    }, (err: unknown) => {
      if (current) setPaneError(errorMessage(err));
    });
    return () => {
      current = false;
    };
  }, [sideChat, paneTabId, restore]);
  const startNew = useCallback(async () => {
    if (paneTabId === undefined) {
      await newSession();
      return;
    }
    try {
      const res = await sideChat.endPaneChat(paneTabId, "new");
      if (!res.ok) {
        setPaneError(formatIpcError(res.error, undefined));
        return;
      }
      setPaneError(null);
      clear();
    } catch (err) {
      setPaneError(errorMessage(err));
    }
    void onSessionsChanged?.();
  }, [sideChat, paneTabId, newSession, clear, onSessionsChanged]);
  const tileHidden = chatContext?.hidden === true;
  // Late session-mutation replies cannot restore a claim after teardown.
  useLayoutEffect(() => {
    bindingActiveRef.current = true;
    if (sessionIdRef.current !== null) handleSessionBound(sessionIdRef.current);
    return () => {
      bindingActiveRef.current = false;
      claimRef.current?.release();
      claimRef.current = null;
    };
  }, [handleSessionBound]);
  const sessionOwned = hasCurrentClaim();
  const pendingApprovals = useMemo(
    () => (!sessionOwned || sessionId === null
      ? []
      : approvals.queue.filter((req) =>
        req.sessionId !== undefined && sessionOwnedBy(sessionId, NO_CHILD_SESSIONS, req.sessionId))),
    [approvals.queue, sessionId, sessionOwned],
  );
  const approvalHead = pendingApprovals[0] ?? null;
  // The questions the side loop's turn parks, kept and drawn here for the same reason the approvals are. The predicate reads
  // the session through a ref so the channel subscription survives a new or loaded session.
  const ownsSession = useCallback(
    (id: string) => hasCurrentClaim() && sessionIdRef.current !== null &&
      sessionOwnedBy(sessionIdRef.current, NO_CHILD_SESSIONS, id),
    [hasCurrentClaim],
  );
  const { askQuestions: retainedQuestions, dismissAskQuestion } = useWorkflowTools(api, {
    ownsSession,
    drawsSession: ownsSession,
  });
  const askQuestions = useMemo(
    () => !sessionOwned || sessionId === null
      ? NO_QUESTIONS
      : retainedQuestions.filter((request) => sessionOwnedBy(sessionId, NO_CHILD_SESSIONS, request.sessionId)),
    [retainedQuestions, sessionId, sessionOwned],
  );
  // What the tile beside this panel publishes to the window on the side chat's behalf: the window leaves this session's
  // questions to this panel and marks the way here while a card waits off screen.
  const publishSideChatSurface = chatContext?.publishSideChatSurface;
  useEffect(() => {
    publishSideChatSurface?.(!sessionOwned || sessionId === null ? null : { sessionId, askQuestions, shown });
  }, [publishSideChatSurface, sessionId, askQuestions, shown, sessionOwned]);
  // Withdrawn on unmount only: a tile whose side chat is gone must not keep reporting a session that nothing draws any more.
  useEffect(() => () => publishSideChatSurface?.(null), [publishSideChatSurface]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentNCounter = useRef(0);
  const composerRef = useRef<ComposerHandle | null>(null);
  const shellTasksApi = useMemo(() => ({
    chatListShellTasks: sideChat.listShellTasks,
    chatControlShellTask: sideChat.controlShellTask,
  }), [sideChat]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Side chat is a second ConversationLoop, not a second credential policy. Read the app-level readiness contract so it
  // cannot bypass a selected subscription login that is still checking, signed out, or unsupported.
  const hasApiKey = runtime?.hasApiKey ?? null;
  const subscriptionRuntimePolicy = runtime?.subscriptionRuntimePolicy;
  const {
    runtimeImageAttachmentProvider,
    runtimeFileAttachmentProvider,
    runtimeUnavailable,
    runtimePending,
    attachmentInputsReady,
    imagesEnabled,
    filesEnabled,
    draftHasUnsupportedAttachment,
  } = resolveComposerRuntimeGates({
    subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider: runtime?.subscriptionImageAttachmentProvider,
    subscriptionFileAttachmentProvider: runtime?.subscriptionFileAttachmentProvider,
    settingsLoaded: runtime?.settingsLoaded,
    subscriptionUnavailableProvider: runtime?.subscriptionUnavailableProvider,
    subscriptionPendingProvider: runtime?.subscriptionPendingProvider,
    attachments,
    llmVendor: runtime?.llmVendor,
    llmModel: runtime?.llmModel,
    llmRouteModalities: runtime?.llmRouteModalities,
  });
  // The side loop runs no local slash commands, so a missing credential blocks the field outright — there is no keyless "/"
  // path to keep open.
  const composerInputDisabled = !attachmentInputsReady || runtimeUnavailable || hasApiKey === false;
  const composerSendDisabled = composerInputDisabled || draftHasUnsupportedAttachment;
  const hasDraft = draft.trim().length > 0 || attachments.length > 0;
  const composedDraft = useMemo(
    () => composeOutgoing({ raw: draft.trim(), attachments, activePreset: null }),
    [draft, attachments],
  );
  const { contextOverflowPct } = useContextBudget({
    entries,
    contextWindow: runtime?.llmContextWindow ?? 0,
    inputLimit: runtime?.llmInputLimit,
    draftTokenEstimate: estimateOutgoingUserMessageTokens(composedDraft.text, composedDraft.attachments),
    enabled: runtime?.usageAvailable !== false,
  });

  // Up/Down recall in the side composer walks this side conversation's prompts.
  const promptHistory = useMemo(() => collectPromptHistory(entries), [entries]);

  // The main transcript's scroll model: follow the stream only while pinned near the bottom, and offer a jump back once the
  // reader has scrolled away.
  const { scrollViewportRef, showJumpToBottom, scrollChatToBottom } = useChatScroll({
    entries,
    currentSessionId: sessionId ?? "",
    chatEndRef,
    viewMode: null,
    searchOpen: false,
    searchMatches: NO_SEARCH_MATCHES,
    searchIdx: 0,
    hidden: tileHidden || !shown,
  });

  const allocateN = useCallback(() => ++attachmentNCounter.current, []);

  // User sends include attachments and interrupt as requested; queue drains carry text only. Every send carries the parent
  // conversation binding.
  const originSessionId = chatContext?.currentSessionId;
  // Named on every turn: a pane chat's tools act on its pane's tab.
  const boundKind = boundSurface?.kind;
  const boundTabId = boundSurface?.tabId;
  const handleAsk = useCallback(
    (
      text: string,
      intent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      const origin = {
        ...(originSessionId ? { originSessionId } : {}),
        ...(boundKind !== undefined && boundTabId !== undefined ? { surface: { kind: boundKind, tabId: boundTabId } } : {}),
      };
      const settle = (turn: Promise<void>) => turn.finally(() => void onSessionsChanged?.());
      if (opts?.inputOrigin === "queue-auto") {
        return settle(send(text, { injectHint: opts.injectHint, inputOrigin: "queue-auto", ...origin }));
      }
      const composed = composeOutgoing({ raw: text, activePreset: null, attachments });
      setDraft("");
      setAttachments([]);
      return settle(send(composed.text, {
        attachments: composed.attachments,
        ...(opts?.injectHint ? { injectHint: opts.injectHint } : {}),
        ...(intent ? { userIntent: intent } : {}),
        ...origin,
      }));
    },
    [send, attachments, originSessionId, boundKind, boundTabId, onSessionsChanged],
  );

  // A stored side chat the sidebar asked this panel to show. Keyed on the request's nonce so asking for the same one twice
  // loads it twice — the second click of a row the user is already looking at still means "go there".
  const consumedOpenNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || consumedOpenNonceRef.current === openRequest.nonce) return;
    consumedOpenNonceRef.current = openRequest.nonce;
    void loadSession(openRequest.sessionId);
  }, [openRequest, loadSession]);

  const {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  } = useMessageQueue({
    surface: "side",
    subscribeStream: sideChat.onStream,
    composerRef,
    currentSessionId: sessionId ?? "",
    question: draft,
    attachments,
    streaming: isStreaming,
    setQuestion: setDraft,
    setAttachments,
    onAsk: handleAsk,
    onAbort: abort,
    // Same verdict the transcript uses. An interrupted turn's trailing `done`
    // reaches this channel after the replacement turn has started; without the
    // shared guard the queue would read it as "the turn ended" and drain a row
    // onto the live turn.
    isCurrentTurnEvent,
  });

  const handleBottomSend = useCallback(() => {
    // The click is the gesture: capture its one-shot keyboard intent now.
    handleComposerSend(captureComposerKeyboardIntent());
  }, [handleComposerSend]);

  const { handleAttach, handleDropFiles, attachPastedText } = useAttachmentPicker({
    attachmentNCounter,
    setAttachments,
    setQuestion: setDraft,
    composerRef,
    // Same channel as this surface's other composer warnings.
    onDropRejected: (count) => console.warn(`${count} dropped item(s) were not attached`),
    imagesEnabled,
    filesEnabled,
    imageAttachmentLimits: subscriptionRuntimePolicy?.imageAttachmentLimits,
  });

  // This side chat's composer, as a place a terminal block in the same side panel can be attached to — while it is the tab
  // the panel shows (see `preview/composer-targets.ts`).
  const dockRef = useRef<HTMLDivElement | null>(null);
  const attachPastedTextRef = useRef(attachPastedText);
  attachPastedTextRef.current = attachPastedText;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (chatGroupId === undefined) return undefined;
    return registerComposerTarget({
      groupId: chatGroupId,
      kind: "side-chat",
      attach: (text) => attachPastedTextRef.current(text),
      available: () => shownRef.current,
      element: () => dockRef.current,
    });
  }, [chatGroupId]);

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="side-chat-view" data-approval-scope>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("chatPreviewRail.sideChat.title")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => void startNew()}
          // Disabled mid-stream: starting a new session mutates the shared side loop; the main handler aborts the in-flight turn
          // first, but blocking the affordance avoids the surprising "New drops my streaming reply".
          disabled={isStreaming}
          data-testid="side-chat-new"
          aria-label={t("chatPreviewRail.sideChat.newSession")}
        >
          <Plus className="h-3 w-3" />
          {t("chatPreviewRail.sideChat.newSession")}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollViewportRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2"
        data-testid="side-chat-transcript"
      >
        {paneError ? (
          <div className="text-xs text-destructive" role="alert" data-testid="side-chat-pane-error">{paneError}</div>
        ) : null}
        {entries.length === 0 ? (
          <div className="pt-6 text-center text-xs text-muted-foreground">
            {t("chatPreviewRail.sideChat.empty")}
          </div>
        ) : (
          <TranscriptRenderer
            observeTerminal={shown && !tileHidden && sessionOwned}
            entries={entries}
            streaming={isStreaming}
            currentSessionId={sessionId ?? "side-chat"}
            turnSummaryByTurnStart={turnSummaryByTurnStart}
            showTokenCostBadge={runtime?.usageAvailable !== false}
            processingDisplayLevel={
              runtime?.processingDisplayLevel ?? DEFAULT_PROCESSING_DISPLAY_LEVEL
            }
          />
        )}
        <div ref={chatEndRef} />
      </div>
      {showJumpToBottom && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="ave-surface-raised absolute bottom-3 right-3 z-20 h-7 rounded-full bg-card/(--opacity-solid) px-2.5 text-[11px] backdrop-blur"
          onClick={() => scrollChatToBottom("smooth")}
          data-testid="side-chat-jump-to-bottom"
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          {t("chatView.jumpToBottom")}
        </Button>
      )}
      </div>

      {/* `data-composer-surface` marks the whole dock subtree, matching the
          main dock: the queue panel, the field, and the action row below all
          carry test ids the main dock also renders. */}
      <div
        ref={dockRef}
        className="shrink-0 border-t px-2 pb-2 pt-1.5"
        data-testid="side-chat-composer-dock"
        data-composer-surface="side"
      >
        <MessageQueuePanel
          store={messageQueueStore}
          onSendNow={handleMessageQueueSendNow}
          heldByApproval={approvalHead !== null}
        />
        {/* The same no-credential affordance the main dock shows, in the strip
            above the input box. `hasApiKey` is the app's readiness verdict, so a
            keyless-ready session never shows it and `null` (probe unresolved)
            stays silent. */}
        {hasApiKey === false && runtime ? (
          <div className="mb-1.5 flex justify-end" data-testid="side-chat-api-key-chip-slot">
            <ComposerApiKeyChip
              onOpenSettings={runtime.onOpenSettings}
              subscriptionRuntimePolicy={subscriptionRuntimePolicy}
              subscriptionUnavailableProvider={runtime.subscriptionUnavailableProvider}
              subscriptionPendingProvider={runtime.subscriptionPendingProvider}
            />
          </div>
        ) : null}
        {boundSurface ? <BoundSurfaceChip surface={boundSurface} /> : targetChip}
        <ComposerContextNotice percent={contextOverflowPct} autoCompactEnabled={runtime?.autoCompactEnabled} />
        <ComposerFrame>
          <Composer
            ref={composerRef}
            surface="side"
            text={draft}
            onTextChange={setDraft}
            promptHistory={promptHistory}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            allocateN={allocateN}
            saveClipboardImage={(b64) => window.ave.attach.saveClipboardImage(b64)}
            discardClipboardImage={(filePath) => window.ave.attach.discardClipboardImage(filePath)}
            openExternal={(p) => window.ave.attach.openExternal(p)}
            imagesEnabled={imagesEnabled}
            filesEnabled={filesEnabled}
            onDropFiles={handleDropFiles}
            imageAttachmentLimits={subscriptionRuntimePolicy?.imageAttachmentLimits}
            onSend={handleComposerSend}
            commandActions={NO_COMMAND_ACTIONS}
            inlinePlugins={NO_INLINE_PLUGINS}
            onSelectPlugin={NOOP_SELECT_PLUGIN}
            disabled={composerInputDisabled}
            sendDisabled={composerSendDisabled}
            onWarning={(message) => console.warn(message)}
            placeholder={computeComposerPlaceholder({
              hasApiKey,
              streaming: isStreaming,
              subscriptionUnavailable: runtimeUnavailable,
              subscriptionPending: runtimePending,
            })}
          />
          {/* Compact action row: the shared attach + shortcuts + turn control,
              without the main dock's slash picker, persona, and status sub-row —
              those act on the main loop (its commands, its persona, its context
              budget), which the side loop does not share. */}
          <div
            className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pb-2 pt-1"
            data-testid="side-chat-action-row"
          >
            <AttachButton
              onAttach={handleAttach}
              disabled={
                attachments.length >= ATTACH_MAX_COUNT ||
                !attachmentInputsReady ||
                hasApiKey === false ||
                (!imagesEnabled && !filesEnabled)
              }
              disabledReason={!attachmentInputsReady
                ? "runtime-pending"
                : (!imagesEnabled && !filesEnabled)
                ? "subscription-unsupported"
                : hasApiKey === false ? "no-api-key" : "limit"}
              disabledSubscriptionProvider={
                runtimeImageAttachmentProvider ?? runtimeFileAttachmentProvider
              }
            />
            {sessionId && <ShellTasksPanel api={shellTasksApi} sessionId={sessionId} composerRef={composerRef} />}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <ShortcutsButton />
              <TurnControlButton
                isBusy={isStreaming}
                hasDraft={hasDraft}
                isSendDisabled={composerSendDisabled || !hasDraft}
                onSend={handleBottomSend}
                onCancel={flushQueueAsUserMessage}
              />
            </div>
          </div>
        </ComposerFrame>
      </div>
      {/* Same z-index for both cards, so DOM order stacks them: the approval
          comes last and stays the topmost decision, as it does in ChatView. */}
      <QuestionOverlay api={api} requests={askQuestions} onResolved={dismissAskQuestion} />
      <ApprovalDock
        queue={pendingApprovals}
        conversationLabel={t("chatPreviewRail.sideChat.title")}
        onDecide={(choice, pattern, extras) => {
          if (approvalHead === null) return;
          void approvals.decide(approvalHead.id, choice, pattern, extras);
        }}
        onOpenPermanentDeny={approvals.openPermanentDeny}
        interactionLocked={approvalHead !== null && approvals.lockedRequestId === approvalHead.id}
        reviewerSuggestion={approvals.reviewerSuggestion}
      />
    </div>
  );
}
