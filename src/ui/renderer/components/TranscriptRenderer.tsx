import { useMemo, useState } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import { chatSurface } from "./chat-surface.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { parseStagedEnvelope } from "../../../shared/staged-origins.js";
import { Button } from "../../../components/ui/button.js";
import { Bot, Brain, ChevronDown, ChevronRight, GitBranch, Loader2, Pencil, Undo2 } from "lucide-react";
import type { ChatEntry, CheckpointTrigger } from "../../../lib/chat-stream-state.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { debugLog } from "../../../lib/debug-stream.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { formatDuration, KOREAN_DURATION_UNITS } from "../../../lib/turn-summary-format.js";
import { knownModelPricing, resolveModelPricing } from "../../../shared/model-pricing.js";
import { usePricingOverrides } from "../hooks/use-pricing-overrides.js";
import { highlightText } from "../utils/html-preview.js";
import { trustOriginLabel } from "../utils/trust-origin-label.js";
import { classifyTurnEntries, isTurnStartEntry } from "../utils/classify-turn-entries.js";
import { formatHhMm } from "../../../shared/format-time.js";
import { entryRenderRevision } from "../utils/chat-entry-revision.js";
import { TerminalObservationCommands, useTerminalObservation } from "./TerminalObservationContent.js";
import { AssistantCard } from "./AssistantCard.js";
import { UserMessageEditor } from "./UserMessageEditor.js";
import { ToolGroupCard, type ToolSandboxMode } from "./ToolGroupCard.js";
import type { ViewModeState } from "./ViewModeBanner.js";
import { WorkGroup } from "./WorkGroup.js";
import { PermissionReviewStatusCard } from "./PermissionReviewStatusCard.js";
import { TurnActionBar } from "./TurnActionBar.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";
import {
  DEFAULT_PROCESSING_DISPLAY_LEVEL,
  type ProcessingDisplayLevel,
} from "../../../shared/processing-display-level.js";
import { shouldShowAssistantEntry } from "../utils/processing-display-policy.js";
import { fileMentionReferenceLabel, parseFileMentionReferences } from "../../../shared/file-mention-reference.js";
import { fileMentionPreviewTarget, type ChatPreviewTarget } from "../preview/preview-targets.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

/** Per-turn provider-reported usage summary, keyed by turn-start entry index. Built by the caller (from `turn_summary`
 * entries) and consumed here to feed the WorkGroup step count / duration and the final TurnActionBar cost badge. */
export type TurnSummary = {
  /** Present only when the engine reached a natural `end_turn`. */
  endedByEndTurn?: true;
  turnDurationMs: number;
  toolCount: number;
  cumulativeToolMs: number;
  tokensIn: number;
  freshInputTokens: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  vendorProvider?: LLMVendor;
  vendorModel?: string;
  usageByModel?: Extract<ChatEntry, { kind: "turn_summary" }>["usageByModel"];
  subscriptionUsage?: Extract<ChatEntry, { kind: "turn_summary" }>["subscriptionUsage"];
};

/** Edit-cluster props: cohesion group co-derived from the transcript in the caller. Presence enables the inline
 * user-message editor + the "edit" hover action. Omit to render the transcript read-only (side-chat / sub-agent). */
interface TranscriptEditProps {
  editingEntryIdx: number | null;
  editBusy: boolean;
  setEditingEntryIdx: (i: number | null) => void;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
}

/** Search-cluster props: highlight + match-ring state. Omit to render without search highlighting (defaults collapse to no
 * ring, no highlight). */
interface TranscriptSearchProps {
  searchOpen: boolean;
  searchMatches: number[];
  searchMatchSet: Set<number>;
  searchIdx: number;
  searchHighlight: string;
}

/**
 * Action-cluster props: mutating per-entry / per-turn actions (fork, rewind,
 * star, retry, feedback) + checkpoint navigation. Each action renders only when
 * its callback is present (side-chat omits the cluster to opt out of all
 * actions). `isEntryStarred` defaults to `() => null` so the star indicator is
 * inert when the caller does not track starred state.
 */
interface TranscriptActionProps {
  isEntryStarred?: (idx: number) => string | null;
  onFork?: (idx: number) => void | Promise<void>;
  /** Rewind to just before this user message: the conversation from it onward is discarded and its text goes back into the
   * composer, unsent. Distinct from edit (which resends) and fork (which branches into a new session). */
  onReturnHere?: (idx: number) => void | Promise<{ ok: boolean }>;
  onToggleStar?: (idx: number) => void | Promise<void>;
  onRetryEffort?: () => void | Promise<void>;
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  handleEnterView?: (compactNum: number) => Promise<void> | void;
  handleBranchFrom?: (compactNum: number) => Promise<void> | void;
}

export interface SharedTranscriptProps {
  entries: ChatEntry[];
  streaming: boolean;
  observeTerminal?: boolean;
  currentSessionId: string;

  // Optional capability clusters suppress features when absent.
  turnSummaryByTurnStart?: Map<number, TurnSummary>;
  edit?: TranscriptEditProps;
  search?: TranscriptSearchProps;
  actions?: TranscriptActionProps;

  /** Checkpoint read-only slice banner state. Suppresses mutating actions on the main path even when the action callbacks are
   * present. Omit (default `null`) for sources that never enter a checkpoint slice. */
  viewMode?: ViewModeState | null;

  /** Final TurnActionBar vendor fallback when a turn_summary has no vendor. */
  activeVendor?: LLMVendor;

  /** False when the active runtime has no API-key billing contract. A validated subscription telemetry segment still renders
   * its token-only badge. */
  showTokenCostBadge?: boolean;

  /** When true, WorkGroup render decisions are traced via debugLog. */
  debugStreamEnabled?: boolean;

  /** Read-only companion surfaces such as the sub-agent side panel need the same WorkGroup / ToolGroup SOT as main chat, but
   * with historical content visible immediately after selecting a row. */
  workGroupsForceOpen?: boolean;

  /** Controls which model work items are visible inside each WorkGroup. */
  processingDisplayLevel?: ProcessingDisplayLevel;
  onPreviewTarget?: (target: ChatPreviewTarget) => void;
}

const NO_STAR: () => string | null = () => null;

/** Read-only transcript sources omit mutating callbacks; render each action only when its capability is present. */
export function TranscriptRenderer({
  entries,
  streaming,
  observeTerminal = false,
  currentSessionId,
  turnSummaryByTurnStart,
  edit,
  search,
  actions,
  viewMode = null,
  activeVendor,
  showTokenCostBadge = true,
  debugStreamEnabled = false,
  workGroupsForceOpen = false,
  processingDisplayLevel = DEFAULT_PROCESSING_DISPLAY_LEVEL,
  onPreviewTarget,
}: SharedTranscriptProps): React.ReactElement {
  const { t } = useTranslation();
  const terminalObservation = useTerminalObservation(currentSessionId, observeTerminal, entries.length);
  const openNativeContextMenu = useNativeContextMenu();
  const pricingOverrides = usePricingOverrides();

  // Cluster fields with explicit inert defaults. These defaults ARE the no-regression contract: forgetting one produces
  // wrong runtime output (footers / actions silently vanish) with no type error.
  const summaryByTurnStart = turnSummaryByTurnStart;
  const editingEntryIdx = edit?.editingEntryIdx ?? null;
  const editBusy = edit?.editBusy ?? false;
  const setEditingEntryIdx = edit?.setEditingEntryIdx;
  const onEditSave = edit?.onEditSave;

  const searchOpen = search?.searchOpen ?? false;
  const searchMatches = search?.searchMatches;
  const searchMatchSet = search?.searchMatchSet;
  const searchIdx = search?.searchIdx ?? 0;
  const searchHighlight = search?.searchHighlight ?? "";

  const isEntryStarred = actions?.isEntryStarred ?? NO_STAR;
  const onFork = actions?.onFork;
  const onReturnHere = actions?.onReturnHere;
  const onToggleStar = actions?.onToggleStar;
  const onRetryEffort = actions?.onRetryEffort;
  const onFeedback = actions?.onFeedback;
  const handleEnterView = actions?.handleEnterView;
  const handleBranchFrom = actions?.handleBranchFrom;

  const rendered = useMemo(() => {
  // Show TurnActionBar only after the whole turn completes; intermediate work collapses together after the final answer.
  const activeEntries = entries;

  // A permission review belongs to one tool call, so it renders ON that tool's
  // row (ToolGroupCard) whenever the row exists — main chat and the sub-agent
  // panel both come through here, so both surfaces show the same thing. A
  // standalone card is left only for verdicts with no row: a review still in
  // flight before tool_start, a pending approval, or a tool that never ran.
  const permissionReviewsByToolUseId = new Map<string, PermissionReviewEntry>();
  const toolUseIdsWithRow = new Set<string>();
  for (const candidate of activeEntries) {
    if (candidate.kind === "permission_review") {
      permissionReviewsByToolUseId.set(candidate.toolUseId, candidate);
    } else if (candidate.kind === "tool_group") {
      for (const tool of candidate.tools) toolUseIdsWithRow.add(tool.toolUseId);
    }
  }
  // A tool that ran several commands shows the least confined one.
  const sandboxModesByToolUseId = new Map<string, ToolSandboxMode>();
  for (const command of terminalObservation.commands) {
    if (sandboxModesByToolUseId.get(command.toolUseId) !== "unconfined") sandboxModesByToolUseId.set(command.toolUseId, command.sandbox.mode);
  }
  const rendersOnToolRow = (candidate: PermissionReviewEntry): boolean =>
    toolUseIdsWithRow.has(candidate.toolUseId);

  const { lastTurnStartIdx, entryClassMap, finalTurnStartMap, entryTurnStartMap } =
    classifyTurnEntries(activeEntries, streaming);

  // One backward pass instead of a scan from the top per work group: this memo re-runs on every streamed token, and a
  // per-group `findIndex` made a long session quadratic in its length on each token.
  const nextTurnStartAfter = new Int32Array(activeEntries.length + 1);
  nextTurnStartAfter[activeEntries.length] = -1;
  for (let k = activeEntries.length - 1; k >= 0; k--) {
    const following = activeEntries[k + 1];
    nextTurnStartAfter[k] = following !== undefined && isTurnStartEntry(following)
      ? k + 1
      : nextTurnStartAfter[k + 1] ?? -1;
  }

  const rendered: React.ReactNode[] = [];
  const pushTerminalCommands = (groups: ChatEntry[], key: string): void => {
    const toolIds = new Set(groups.flatMap((entry) => entry.kind === "tool_group" ? entry.tools.flatMap((tool) => tool.toolUseId ? [tool.toolUseId] : []) : []));
    const commands = terminalObservation.commands.filter((command) => toolIds.has(command.toolUseId));
    if (commands.length > 0) rendered.push(<TerminalObservationCommands key={key} observation={terminalObservation} commands={commands} />);
  };
  // Reasoning, permission-review and tool-group rows draw the same whether the entry is the live tail of a turn or an
  // unclassified straggler.
  const pushSideEntry = (
    entry: (typeof activeEntries)[number],
    idx: number,
    ringCls: string,
  ): boolean => {
    if (entry.kind === "reasoning") {
      if (processingDisplayLevel !== "tools") {
        rendered.push(
          <div
            key={idx}
            data-chat-entry-index={idx}
            className={`min-w-0 w-full max-w-full rounded-md${ringCls ? ` ${ringCls}` : ""}`}
          >
            <ReasoningCard entry={entry} />
          </div>,
        );
      }
      return true;
    }
    if (entry.kind === "permission_review") {
      if (!rendersOnToolRow(entry)) {
        rendered.push(<PermissionReviewStatusCard key={`permission-review-${entry.toolUseId}`} entry={entry} />);
      }
      return true;
    }
    if (entry.kind === "tool_group") {
      rendered.push(
        <ToolGroupCard
          key={entry.groupId}
          group={entry}
          sessionId={currentSessionId}
          permissionReviews={permissionReviewsByToolUseId}
          sandboxModes={sandboxModesByToolUseId}
        />,
      );
      pushTerminalCommands([entry], `terminal-${entry.groupId}`);
      return true;
    }
    return false;
  };
  let i = 0;
  while (i < activeEntries.length) {
    const entry = activeEntries[i];
    if (!entry) { i++; continue; }
    // Capture idx by value — closures in this loop must not close over mutable `i`
    const idx = i;

    const ringClassFor = (entryIdx: number) => {
      const isMatch = searchMatchSet?.has(entryIdx) ?? false;
      const isCurrentMatch = searchOpen && searchMatches?.[searchIdx] === entryIdx;
      return isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/(--opacity-medium)" : "";
    };
    const ringCls = ringClassFor(idx);

    if (entry.kind === "user") {
      // Add turn spacing only after completed answers; the important utility must override the parent sibling-spacing selector.
      const prevEntry = i > 0 ? activeEntries[i - 1] : undefined;
      const prevAssistantComplete =
        prevEntry?.kind === "assistant" && prevEntry.streaming !== true;
      const userGapCls = prevAssistantComplete ? "!mt-4" : "";
      // A sub-agent report enters the parent transcript as a user-role message
      // because that is how the model receives it — but it is not the user's
      // text and must not read as such. It gets its own left-aligned box with
      // the reporting child named, and none of the edit/fork/pin affordances
      // that only make sense on something the user wrote.
      if (entry.injectHint === "sub-agent") {
        rendered.push(
          <div
            key={idx}
            data-chat-entry-index={idx}
            data-testid="subagent-report-entry"
            className={`mr-auto w-fit min-w-0 max-w-[85%] ${userGapCls}`}
          >
            <div
              data-testid="subagent-report-bubble"
              className={`min-w-0 overflow-hidden rounded-lg border border-primary/(--opacity-medium) bg-muted/(--opacity-subtle) px-3.5 py-2.5 text-body-sm text-foreground shadow-sm ${ringCls}`}
            >
              <div
                data-testid="subagent-report-label"
                className="mb-1 inline-flex items-center gap-1 rounded bg-muted/(--opacity-medium) px-1.5 py-0.5 text-micro text-muted-foreground"
                title={t("chatView.subAgentReportTitle")}
              >
                <Bot className="h-3 w-3 text-primary" />
                {entry.subAgentTitle
                  ? t("chatView.subAgentReportLabelNamed", { title: entry.subAgentTitle })
                  : t("chatView.subAgentReportLabel")}
              </div>
              <div className="cursor-text select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}
              </div>
            </div>
          </div>,
        );
      } else if (editingEntryIdx === i && setEditingEntryIdx && onEditSave) {
        rendered.push(
          <div key={idx} className={userGapCls}>
            <UserMessageEditor
              initialText={entry.text}
              busy={editBusy}
              onCancel={() => setEditingEntryIdx(null)}
              onSave={(next) => void onEditSave(idx, next)}
            />
          </div>
        );
      } else {
        // Hover actions render only when their callbacks are present. Main passes them (identical to pre-extraction); read-only
        // sources omit the edit/action clusters, so no dangling handlers are wired.
        const showHoverActions =
          !viewMode && (!!setEditingEntryIdx || !!onFork || !!onReturnHere);
        // The send time is persisted on the message, so it is shown as recorded or not at all — a card with no recorded time must
        // not invent one.
        const sentAtLabel = formatHhMm(entry.createdAt);
        rendered.push(
          <div
            key={idx}
            data-chat-entry-index={idx}
            className={`group relative ml-auto w-fit min-w-0 max-w-[75%] ${userGapCls}`}
            onContextMenu={(event) =>
              openNativeContextMenu(event, "message", {
                "message.copy": () => void navigator.clipboard?.writeText(entry.text),
                ...(!viewMode && setEditingEntryIdx
                  ? { "message.edit": () => setEditingEntryIdx(idx) }
                  : {}),
                ...(!viewMode && onFork
                  ? { "message.fork": () => void onFork(idx) }
                  : {}),
                ...(!viewMode && onReturnHere && !streaming
                  ? { "message.returnHere": () => void onReturnHere(idx) }
                  : {}),
              } as NativeContextMenuHandlers)
            }
          >
            <div
              data-testid="user-message-bubble"
              className={`min-w-0 overflow-hidden rounded-lg border border-message-user-border bg-message-user px-3.5 py-2.5 text-body-sm text-message-user-foreground shadow-sm ${ringCls}`}
            >
              {/* Sender is implicit. Metadata stays above the selectable body. */}
              {entry.origin ? (
                <div
                  data-testid="user-message-origin-badge"
                  className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted"
                  title={trustOriginLabel(entry.origin)}
                >
                  {trustOriginLabel(entry.origin)}
                </div>
              ) : null}
              {entry.injectHint === "queue" ? (
                <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted" title={t("chatView.queueInjectTitle")}>
                  {t("chatView.queueInjectLabel")}
                </div>
              ) : entry.injectHint === "interrupt" ? (
                <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted" title={t("chatView.interruptTitle")}>
                  {t("chatView.interruptLabel")}
                </div>
              ) : null}
              <div className="cursor-text select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {renderUserMessageText(entry.text, searchHighlight, onPreviewTarget)}
              </div>
            </div>
            {/* Keep a fixed footer slot outside the bubble. The send time holds
                the row open, so revealing the controls changes only opacity and
                transform, never message or transcript height. The time is the
                last child of this `justify-end` row so it stays pinned to the
                trailing edge; the controls occupy the leading side and slide in
                beside it. */}
            {(showHoverActions || sentAtLabel) && (
              <div className="mt-1 flex h-7 items-center justify-end gap-1">
                {showHoverActions ? (
                  <div
                    data-testid="user-message-actions"
                    className="flex translate-x-1 gap-1 opacity-0 pointer-events-none transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-focus-within:pointer-events-auto motion-reduce:transition-none motion-reduce:transform-none"
                  >
                    {setEditingEntryIdx ? (
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.editButtonTitle")} onClick={() => setEditingEntryIdx(idx)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                    ) : null}
                    {onFork ? (
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.forkButtonTitle")} onClick={() => void onFork(idx)}>
                        <GitBranch className="h-3 w-3" />
                      </Button>
                    ) : null}
                    {/* Rewinding drops the turns after this message, so it is
                        offered only when no turn is producing more of them. */}
                    {onReturnHere ? (
                      <Button type="button" variant="ghost" size="icon-xs" disabled={streaming} className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.returnHereButtonTitle")} onClick={() => void onReturnHere(idx)}>
                        <Undo2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {sentAtLabel ? (
                  <span data-testid="user-message-time" className="shrink-0 px-1 text-xs text-muted-foreground">
                    {sentAtLabel}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        );
      }
      // Only the active turn's start can need the placeholder, so only it pays for the scan (a scan per user message made long
      // sessions quadratic).
      const needsActiveStart =
        streaming &&
        idx === lastTurnStartIdx &&
        !activeEntries.some(
          (nextEntry, nextIdx) =>
            nextIdx > idx &&
            (nextEntry.kind === "assistant" ||
              nextEntry.kind === "reasoning" ||
              nextEntry.kind === "tool_group" ||
              nextEntry.kind === "permission_review"),
        );
      if (needsActiveStart) {
        rendered.push(
          <WorkGroup
            key={`wg-${currentSessionId}:${idx}:active-start`}
            stepCount={0}
            streaming
            revision={`${currentSessionId}:${idx}:active-start`}
          >
            {null}
          </WorkGroup>,
        );
      }
      i++;
      continue;
    }

    if (entry.kind === "ask_user_answer") {
      rendered.push(<AskUserAnswerBubble key={idx} entry={entry} />);
      i++;
      continue;
    }

    if (entry.kind === "system") {
      rendered.push(
        <div
          key={idx}
          data-testid="system-entry"
          className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/(--opacity-medium) border border-border/(--opacity-medium)"
        >
          {entry.text}
        </div>,
      );
      i++;
      continue;
    }

    // turn_summary entry — 데이터 carrier 로 history 에 남기되 standalone 렌더링 안 함. 같은 turn 의 final AssistantCard / WorkGroup 이
    // turnSummaryByTurnStart 에서 lookup 해 inline 으로 표시한다.
    if (entry.kind === "turn_summary" || entry.kind === "context_usage") {
      i++;
      continue;
    }

    // Keep the checkpoint label, available navigation and summary in one history unit.
    if (entry.kind === "checkpoint") {
      rendered.push(
        <CheckpointDivider
          key={`cp-${idx}`}
          trigger={entry.trigger}
          messageCount={entry.removedMessages}
          compactNum={entry.compactNum}
          compactStatus={entry.compactStatus}
          truncatedDir={entry.truncatedDir}
          summary={entry.summary}
          {...(handleEnterView ? { onEnterView: handleEnterView } : {})}
          {...(handleBranchFrom ? { onBranchFrom: handleBranchFrom } : {})}
        />,
      );
      i++;
      continue;
    }

    if (entry.kind === "session_resume") {
      rendered.push(
        <SessionResumeDivider
          key={`sr-${idx}`}
          preambleChars={entry.preambleChars}
        />,
      );
      i++;
      continue;
    }

    if (entry.kind === "imported_trigger") {
      rendered.push(
        <ImportedTriggerCard
          key={`trigger:${entry.sessionId}`}
          entry={entry}
        />,
      );
      i++;
      continue;
    }

    if (entryClassMap.get(i) === "intermediate") {
      const groupStart = i;
      const groupTurnStart = entryTurnStartMap.get(i) ?? 0;
      // Spinner is shown only while this WorkGroup belongs to the currently active turn
      const groupIsActiveTurn = groupTurnStart === lastTurnStartIdx && streaming;
      if (debugStreamEnabled && groupIsActiveTurn) {
        debugLog("ChatView", "WorkGroup:render-decision", {
          groupStart,
          groupTurnStart,
          lastTurnStartIdx,
          globalStreaming: streaming,
          groupIsActiveTurn,
        });
      }
      const groupEntries: { idx: number; node: React.ReactNode }[] = [];
      const groupRevisions: string[] = [];
      let groupHasPermissionReview = false;
      let progressLabel: string | undefined;

      while (i < activeEntries.length) {
        const e = activeEntries[i];
        if (!e) { i++; continue; }
        if ((entryTurnStartMap.get(i) ?? groupTurnStart) !== groupTurnStart) break;
        const cls = entryClassMap.get(i);
        if (cls === "final") break;
        if (e.kind === "reasoning") {
          if (cls === "intermediate") {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            // The active WorkGroup header is the one live thinking status. Keep its underlying reasoning in the group, but reveal the
            // card only after the turn settles so the transcript does not repeat it.
            if (!groupIsActiveTurn && processingDisplayLevel !== "tools") {
              groupEntries.push({ idx: i, node: <ReasoningCard key={i} entry={e} /> });
            }
          } else {
            break;
          }
        } else if (e.kind === "permission_review") {
          if (cls === "intermediate") {
            if (
              e.status === "reviewing" ||
              e.status === "auto_approved"
            ) {
              groupHasPermissionReview = true;
            }
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            if (!rendersOnToolRow(e)) {
              groupEntries.push({
                idx: i,
                node: <PermissionReviewStatusCard key={`permission-review-${e.toolUseId}`} entry={e} />,
              });
            }
          } else {
            break;
          }
        } else if (e.kind === "tool_group") {
          if (cls === "intermediate") {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({
              idx: i,
              node: (
                <ToolGroupCard
                  key={e.groupId}
                  group={e}
                  sessionId={currentSessionId}
                  permissionReviews={permissionReviewsByToolUseId}
                  sandboxModes={sandboxModesByToolUseId}
                />
              ),
            });
          } else {
            break;
          }
        } else if (e.kind === "assistant") {
          if (cls === "intermediate") {
            const starred = !!isEntryStarred(i);
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred }));
            if (e.phase === "status" && groupIsActiveTurn) {
              progressLabel = e.text;
            } else if (shouldShowAssistantEntry(e, cls, processingDisplayLevel)) {
              groupEntries.push({
                idx: i,
                node: (
                  <AssistantCard
                    key={i}
                    entry={e}
                    isStarred={starred}
                    isFinal={false}
                  />
                ),
              });
            }
          } else {
            break;
          }
        } else if (e.kind === "ask_user_answer") {
          // ask_user_question 의 사용자 응답 카드도 같은 turn 의
          // WorkGroup 안에 inline 으로 흡수. 이전: 이 branch 가 없어
          // default break 로 떨어지면서 WorkGroup 가 분리 → 사용자가
          // "작업 3단계 + 작업 9단계" 로 보이던 UX 분리 (2026-05-07).
          // entryTurnStartMap 에는 ask_user_answer 가 없어 line 901
          // 의 fallback 으로 같은 turn 처리되었으나, 여기서 명시 push
          // 가 없으면 default `break` 로 떨어짐. 안전을 위해 walkback
          // 으로 turnStart 일치 검증.
          let aaTurnStart = -1;
          for (let k = i; k >= 0; k--) {
            if (isTurnStartEntry(activeEntries[k])) { aaTurnStart = k; break; }
          }
          if (aaTurnStart === groupTurnStart) {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({
              idx: i,
              node: <AskUserAnswerBubble key={`ask-${i}`} entry={e} />,
            });
          } else {
            break;
          }
        } else {
          break;
        }
        i++;
      }

      // A filtered completed turn can have no visible intermediate rows. Do not leave a collapsed, empty work group behind; an
      // active turn still needs its single progress header even before a visible row arrives.
      if (groupEntries.length > 0 || groupIsActiveTurn) {
        // Prefer the turn_summary's authoritative `toolCount` over
        // groupEntries.length — the latter includes reasoning /
        // assistant bubbles / ask_user_answer and would diverge from the actual
        // tool-call count.
        // Without an authoritative host summary, count exactly the rows that
        // this group renders. In particular, a permission review attached to a
        // tool row must not be counted once here and again inside that tool.
        const fallbackStepCount = groupEntries.length;
        const nextTurnStartIdx = nextTurnStartAfter[groupTurnStart] ?? -1;
        const turnEntries = activeEntries.slice(
          groupTurnStart + 1,
          nextTurnStartIdx === -1 ? activeEntries.length : nextTurnStartIdx,
        );
        const transcriptSummary = turnEntries.find(
          (candidate): candidate is Extract<ChatEntry, { kind: "turn_summary" }> =>
            candidate.kind === "turn_summary",
        );
        // The map is the normal main/side surface path. Falling back to the carried entry keeps direct read-only transcript
        // consumers from mistaking an incomplete summary for a completed turn.
        const groupSummary = summaryByTurnStart?.get(groupTurnStart) ?? transcriptSummary;
        // A summary carries usage totals, but an error/interrupt can still settle the renderer after it. Do not turn that terminal
        // state into a successful-looking completion label.
        const hasTerminalFailure = turnEntries.some(
          (candidate) =>
            candidate.kind === "assistant" &&
            (
              candidate.terminalError === true ||
              candidate.systemNotice !== undefined ||
              candidate.interrupted === true
            ),
        );
        const hasCleanFinalResponse = turnEntries.some(
          (candidate, offset) => {
            const candidateIdx = groupTurnStart + 1 + offset;
            return (
              candidate.kind === "assistant" &&
              entryClassMap.get(candidateIdx) === "final" &&
              finalTurnStartMap.get(candidateIdx) === groupTurnStart &&
              candidate.terminalError !== true &&
              candidate.systemNotice === undefined &&
              candidate.interrupted !== true
            );
          },
        );
        const currentSearchMatch = searchOpen ? searchMatches?.[searchIdx] : undefined;
        const groupHasCurrentSearchMatch =
          currentSearchMatch !== undefined && groupEntries.some((groupEntry) => groupEntry.idx === currentSearchMatch);
        const groupSearchRevision = groupEntries
          .map((groupEntry) => `${groupEntry.idx}:${ringClassFor(groupEntry.idx)}`)
          .join("|");
        rendered.push(
          <WorkGroup
            key={`wg-${currentSessionId}:${groupStart}`}
            stepCount={groupSummary?.toolCount ?? fallbackStepCount}
            streaming={groupIsActiveTurn}
            turnDurationMs={groupSummary?.turnDurationMs}
            completed={!hasTerminalFailure && (
              groupSummary !== undefined
                ? groupSummary.endedByEndTurn === true
                : hasCleanFinalResponse
            )}
            progressLabel={groupIsActiveTurn ? progressLabel : undefined}
            revision={[currentSessionId, processingDisplayLevel, groupSearchRevision, ...groupRevisions].join("||")}
            forceOpen={workGroupsForceOpen || groupHasPermissionReview || groupHasCurrentSearchMatch}
          >
            {groupEntries.map((ge) => (
              <div
                key={ge.idx}
                data-chat-entry-index={ge.idx}
                className={ringClassFor(ge.idx) || undefined}
              >
                {ge.node}
              </div>
            ))}
          </WorkGroup>
        );
      }
      pushTerminalCommands(activeEntries.slice(groupStart, i), `terminal-${groupStart}`);
      continue;
    }

    if (entryClassMap.get(i) === "live") {
      if (!pushSideEntry(entry, idx, ringCls) && entry.kind === "assistant") {
        // Before assistant_round closes, streamed text has no trustworthy
        // work/final signal. Filtered modes withhold that ambiguous text and
        // reveal it as soon as the round is stamped `final`; guessing here
        // would leak intermediate narration in the modes meant to hide it.
        if (shouldShowAssistantEntry(entry, "live", processingDisplayLevel)) {
          rendered.push(
            <div key={idx} data-chat-entry-index={idx} className={`min-w-0 w-full max-w-full overflow-x-hidden rounded-lg${ringCls ? ` ${ringCls}` : ""}`}>
              <AssistantCard
                entry={entry}
                isStarred={!!isEntryStarred(idx)}
                isFinal={true}
              />
            </div>
          );
        }
      }
      i++;
      continue;
    }

    if (entryClassMap.get(i) === "final" && entry.kind === "assistant") {
      const turnStartIdx = finalTurnStartMap.get(i) ?? 0;
      const summary = summaryByTurnStart?.get(turnStartIdx);
      const summaryVendor = summary?.vendorProvider;
      const hasSubscriptionUsage = (summary?.subscriptionUsage?.length ?? 0) > 0;
      const summaryPricing = !hasSubscriptionUsage && summary?.vendorProvider && summary.vendorModel
        ? knownModelPricing(resolveModelPricing(summary.vendorProvider, summary.vendorModel, pricingOverrides))?.rates
        : undefined;
      // Mutating actions are gated on BOTH (a) not being in a read-only
      // view-mode slice AND (b) the callback being present. Main passes all
      // callbacks + a nullable viewMode → identical to pre-extraction;
      // read-only sources omit the callbacks → no actions rendered.
      const barActions =
        !viewMode && (onRetryEffort || onFork || onToggleStar)
          ? {
              ...(onRetryEffort ? { onRetry: () => void onRetryEffort() } : {}),
              ...(onFork ? { onFork: () => void onFork(idx) } : {}),
              ...(onToggleStar ? { onToggleStar: () => void onToggleStar(idx) } : {}),
            }
          : {};
      rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-lg`}>
          <AssistantCard
            entry={entry}
            isStarred={!!isEntryStarred(idx)}
            isFinal={true}
          />
          {/* Suppress mutating TurnActionBar actions in view-mode / when the
              source omits the action callbacks. */}
          <TurnActionBar
            timestamp={entry.kind === "assistant" ? entry.createdAt : undefined}
            turnSummary={showTokenCostBadge || hasSubscriptionUsage ? summary : undefined}
            pricing={summaryPricing}
            vendor={hasSubscriptionUsage ? undefined : summaryVendor ?? activeVendor}
            isStarred={!!isEntryStarred(idx)}
            copyText={detectFromStream(entry.text || "").cleanedText || undefined}
            actions={barActions}
            onFeedback={!viewMode && onFeedback ? (rating, reason) => void onFeedback(idx, rating, reason) : undefined}
          />
        </div>
      );
      i++;
      continue;
    }

    pushSideEntry(entry, idx, ringCls);
    i++;
  }
  return rendered;
  // Dependency array preserves the original per-field memoization granularity
  // (flat primitives, NOT the cluster objects) so main-path perf is unchanged:
  // the memo recomputes only when an actually-consumed value changes, exactly as
  // the pre-extraction useMemo did. `t` is intentionally omitted — it is a
  // stable, provider-free translator and was not a dependency in the original.
  }, [
    activeVendor,
    currentSessionId,
    debugStreamEnabled,
    editBusy,
    editingEntryIdx,
    handleBranchFrom,
    handleEnterView,
    isEntryStarred,
    onEditSave,
    onFeedback,
    onFork,
    onRetryEffort,
    onReturnHere,
    onToggleStar,
    onPreviewTarget,
    openNativeContextMenu,
    searchHighlight,
    searchIdx,
    searchMatchSet,
    searchMatches,
    searchOpen,
    setEditingEntryIdx,
    showTokenCostBadge,
    streaming,
    summaryByTurnStart,
    viewMode,
    workGroupsForceOpen,
    processingDisplayLevel,
    entries,
    pricingOverrides,
    terminalObservation,
  ]);

  return <>{rendered}{terminalObservation.error ? <TerminalObservationCommands observation={terminalObservation} /> : null}</>;
}

function renderUserMessageText(text: string, searchHighlight: string, onPreviewTarget?: (target: ChatPreviewTarget) => void): React.ReactNode {
  const plain = (value: string) => searchHighlight ? highlightText(value, searchHighlight) : value;
  if (!onPreviewTarget) return plain(text);
  let references: ReturnType<typeof parseFileMentionReferences>;
  try {
    references = parseFileMentionReferences(text);
  } catch {
    return plain(text);
  }
  if (references.length === 0) return plain(text);
  const parts: React.ReactNode[] = [];
  let position = 0;
  for (const { start, end, reference } of references) {
    parts.push(<span key={`text-${position}`}>{plain(text.slice(position, start))}</span>);
    const label = fileMentionReferenceLabel(reference);
    parts.push(
      <button key={`reference-${start}`} type="button"
        className="inline rounded border border-message-user-border bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 align-baseline font-mono text-xs hover:bg-message-user-muted/(--opacity-medium) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={reference.turnId}
        onClick={() => onPreviewTarget(fileMentionPreviewTarget(reference))}>
        {plain(label)}
      </button>,
    );
    position = end;
  }
  parts.push(<span key={`text-${position}`}>{plain(text.slice(position))}</span>);
  return parts;
}

// Small render-only pieces of the transcript. They live here rather than in
// their own modules because TranscriptRenderer is their only consumer.

function SessionResumeDivider({ preambleChars }: { preambleChars: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="session-resume-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
      <span className="text-[10px] text-success/(--opacity-emphatic) font-medium">
        {t("sessionResumeDivider.resumeLabel", { preambleChars })}
      </span>
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
    </div>
  );
}

export function SummaryToast({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid="summary-toast"
      className="group w-full min-w-0 max-w-full text-foreground"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg text-xs font-medium normal-case tracking-normal text-muted-foreground marker:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-(--motion-fast) ease-(--motion-ease-out) group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        <span className="inline-block lowercase first-letter:uppercase">{t("summaryToast.previousSummary")}</span>
      </summary>
      <div
        className="prose prose-sm ave-prose mt-2 max-w-none break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="summary-toast-body"
      >
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {summary}
        </ReactMarkdown>
      </div>
    </details>
  );
}

type ImportedTriggerEntry = Extract<ChatEntry, { kind: "imported_trigger" }>;

function ImportedTriggerCard({ entry }: { entry: ImportedTriggerEntry }) {
  // Read staged provenance from the actual prompt envelope through the origin table so display agrees with engine
  // classification.
  const envelopeSource = parseStagedEnvelope(entry.prompt)?.source;
  return (
    <div
      className="mx-3 my-1 rounded border border-action-view/(--opacity-light) bg-action-view/(--opacity-faint) px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1 text-action-view font-medium">
        <span className="shrink-0">●</span>
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{envelopeSource ?? entry.summary.slice(0, 60)}</span>
      </div>
      {entry.summary && (
        <div className="mt-1 text-muted-foreground prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
            {entry.summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function AskUserAnswerBubble({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "ask_user_answer" }>;
}) {
  const { t } = useTranslation();
  if (entry.dismissed) {
    return (
      <div
        className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-muted-foreground/(--opacity-strong) bg-card/(--opacity-intense) px-3 py-2 text-xs text-muted-foreground shadow-sm"
        data-testid="ask-user-answer-bubble"
      >
        <div className="text-[10.5px] text-muted-foreground/(--opacity-intense)">{t("chatView.askAnswerSkippedLabel")}</div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{t("chatView.askAnswerSkippedProceed")}</div>
      </div>
    );
  }

  return (
    <div
      className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-message-user bg-card/(--opacity-near) px-3 py-2.5 text-xs text-card-foreground shadow-sm"
      data-testid="ask-user-answer-bubble"
    >
      <div className="mb-1 text-[10.5px] text-muted-foreground">
        {entry.rows.length > 1 ? t("chatView.askAnswerMyAnswerMultiple", { count: entry.rows.length }) : t("chatView.askAnswerMyAnswerSingle")}
      </div>
      <div className="space-y-0.5">
        {entry.rows.map((row, idx) => (
          <div key={`${idx}:${row.label}`} className="flex min-w-0 items-baseline gap-2">
            <span className="w-[4.5rem] shrink-0 truncate text-[10.5px] text-muted-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] [overflow-wrap:anywhere]">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Keep reasoning collapsed during and after streaming; only user interaction reveals it. */
export function ReasoningCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "reasoning" }>;
}) {
  const { locale, t } = useTranslation();
  const streaming = entry.streaming === true;
  // Always collapsed by default — even while streaming. Expands only on click.
  const [open, setOpen] = useState(false);

  const title = streaming
    ? t("reasoningCard.thinkingTitle")
    : entry.durationMs !== undefined && entry.durationMs >= 1000
      // Sub-second thinking says nothing a duration would add.
      ? t("reasoningCard.thoughtForDuration", {
          duration: formatDuration(entry.durationMs, locale.startsWith("ko") ? KOREAN_DURATION_UNITS : undefined),
        })
      : t("reasoningCard.thoughtCompleteTitle");
  const hasBody = entry.text.trim().length > 0;
  const bodyVisible = open && hasBody;

  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-sm text-muted-foreground ave-anim-message-in">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/(--opacity-muted)"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={bodyVisible}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          : <Brain className="h-3 w-3 flex-shrink-0" />}
        <span className="min-w-0 font-medium">{title}</span>
        {/* Chevron always shown (even while streaming) so the folded block reads
            as expandable. */}
        <span className="shrink-0">
          {bodyVisible
            ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        </span>
      </button>
      {bodyVisible && (
        <div className="ml-3 min-w-0 whitespace-pre-wrap break-words border-l-2 border-muted py-1 pl-3 text-[11px] italic leading-5 text-muted-foreground/(--opacity-intense) [overflow-wrap:anywhere] ave-anim-fade-in">
          {entry.text}
        </div>
      )}
    </div>
  );
}

type CompactStatus =
  | "summarized"
  | "content_truncated"
  | "noop"
  | "reduced_insufficient_forced";

interface Variant {
  label: string;
  lineCls: string;
  textCls: string;
}

const STATUS_VARIANTS: Record<CompactStatus, Variant> = {
  summarized: {
    label: "checkpointDivider.statusSummarized",
    lineCls: "bg-border-subtle",
    textCls: "text-muted-foreground",
  },
  content_truncated: {
    label: "checkpointDivider.statusContentTruncated",
    lineCls: "bg-warning/(--opacity-medium)",
    textCls: "text-warning/(--opacity-near)",
  },
  noop: {
    label: "checkpointDivider.statusNoop",
    lineCls: "bg-muted-foreground/25",
    textCls: "text-muted-foreground/(--opacity-stronger)",
  },
  reduced_insufficient_forced: {
    label: "checkpointDivider.statusReducedInsufficient",
    lineCls: "bg-destructive/(--opacity-medium)",
    textCls: "text-destructive/(--opacity-near)",
  },
};

const TRIGGER_VARIANTS: Record<CheckpointTrigger | "default", Variant> = {
  "auto-compact": {
    label: "checkpointDivider.triggerAutoCompact",
    lineCls: "bg-border-subtle",
    textCls: "text-muted-foreground",
  },
  "manual": {
    label: "checkpointDivider.triggerManual",
    lineCls: "bg-border-subtle",
    textCls: "text-muted-foreground",
  },
  default: {
    label: "checkpointDivider.triggerAutoCompact",
    lineCls: "bg-border-subtle",
    textCls: "text-muted-foreground",
  },
};

export function CheckpointDivider({
  trigger,
  messageCount,
  compactNum,
  compactStatus,
  truncatedDir,
  summary,
  onEnterView,
  onBranchFrom,
}: {
  trigger?: CheckpointTrigger;
  messageCount: number;
  /** Compact sequence number — enables view/branch action buttons. */
  compactNum?: number;

  compactStatus?: CompactStatus;

  truncatedDir?: string;
  summary?: string;
  /** Enter view-mode for this checkpoint. */
  onEnterView?: (compactNum: number) => void | Promise<void>;
  /** Fork a new session from this checkpoint. */
  onBranchFrom?: (compactNum: number) => void | Promise<void>;
}) {
  const { t } = useTranslation();

  const variant: Variant = compactStatus !== undefined
    ? STATUS_VARIANTS[compactStatus]
    : TRIGGER_VARIANTS[trigger ?? "default"];

  const hasBoundary = compactStatus === undefined
    || compactStatus === "summarized"
    || compactStatus === "reduced_insufficient_forced";
  const hasActions =
    hasBoundary && compactNum !== undefined && (onEnterView !== undefined || onBranchFrom !== undefined);
  return (
    <div
      data-testid="checkpoint-divider"
      data-trigger={trigger ?? "default"}
      data-compact-status={compactStatus ?? "summarized"}
      data-compact-num={compactNum}
      className={`${chatSurface({ edge: "quiet", elevation: "flat" })} my-2 flex min-w-0 flex-col gap-2 px-3 py-2`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-px flex-1 ${variant.lineCls}`} />
        <span className={`min-w-0 text-center text-xs ${variant.textCls} font-medium`}>
          {t("checkpointDivider.checkpoint")}{compactNum !== undefined ? ` #${compactNum}` : ""} · {t(variant.label)} ({t("checkpointDivider.messageCount", { count: messageCount })})
        </span>
        <span className={`h-px flex-1 ${variant.lineCls}`} />
      </div>
      {truncatedDir !== undefined && (
        <div className="break-words text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t("checkpointDivider.originalPreserved", { dir: truncatedDir })}
        </div>
      )}
      {hasActions && (
        <div
          data-testid="checkpoint-actions"
          className="flex flex-wrap items-center justify-center gap-2"
        >
          {onEnterView !== undefined && compactNum !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              data-testid="ck-btn-view"
              onClick={() => { void onEnterView(compactNum); }}
              aria-label={t("checkpointDivider.viewAriaLabel", { num: compactNum })}
            >
              {t("checkpointDivider.viewButton")}
            </Button>
          )}
          {onBranchFrom !== undefined && compactNum !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              data-testid="ck-btn-fork"
              onClick={() => { void onBranchFrom(compactNum); }}
              aria-label={t("checkpointDivider.branchAriaLabel", { num: compactNum })}
            >
              {t("checkpointDivider.branchButton")}
            </Button>
          )}
        </div>
      )}
      {summary && <SummaryToast summary={summary} />}
    </div>
  );
}
