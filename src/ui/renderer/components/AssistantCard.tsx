import { Loader2, Pin, RefreshCw, GitBranch, AlertTriangle, History } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { memo, useMemo } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { clampDanglingMarkdownLink } from "../utils/streaming-markdown.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { MARKDOWN_SAFE_COMPONENTS, markdownUrlTransform } from "../utils/markdown-safe.js";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.js";
import { replaceToolNamesInText } from "../utils/tool-display.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { usePaneChatNavigation } from "../context/PaneChatNavigationContext.js";

/**
 * Trailing "[중단됨]"-style markers that older engine versions appended to the
 * assistant TEXT on abort. New turns carry `entry.interrupted` instead; these
 * literals survive only in already-persisted sessions, so they are stripped at
 * render and replaced by the same badge — one visual language for both eras.
 * Tail-anchored on the exact known catalog values: prose that merely mentions
 * the marker mid-sentence is left alone.
 */
const LEGACY_INTERRUPT_TAIL = /(?:\n*\s*)(?:\[Interrupted\]|\[중단됨\]|\[中断\]|\[Interrompu\]|\[Interrumpido\]|\[Unterbrochen\])\s*$/;
function splitLegacyInterruptTail(text: string): { text: string; hadMarker: boolean } {
  const stripped = text.replace(LEGACY_INTERRUPT_TAIL, "");
  return { text: stripped, hadMarker: stripped !== text };
}

/** Safe overrides plus a fenced-code header (language + copy). */
const ASSISTANT_MARKDOWN_COMPONENTS = { ...MARKDOWN_SAFE_COMPONENTS, pre: MarkdownCodeBlock };

function AssistantCardImpl({
  entry,
  actions,
  isStarred,
  isFinal = true,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
  isFinal?: boolean;
}) {
  const { t } = useTranslation();
  const paneChatNavigation = usePaneChatNavigation();
  const noticePane = entry.systemNotice === "operation-error" && entry.noticeSessionId
    ? paneChatNavigation?.resolveSession(entry.noticeSessionId)
    : undefined;
  // Distinguish host-emitted system notices from model replies.
  const isSystemNotice = entry.systemNotice !== undefined;
  // Style restored system notices as previous-session errors; keep live notices destructive without re-alarming on reload.
  const isRestoredNotice = isSystemNotice && entry.restored === true;
  const systemNoticeLabel =
    entry.systemNotice === "context-error"
      ? t("assistantCard.systemNoticeContextError")
      : entry.systemNotice === "stream-error"
        ? t("assistantCard.systemNoticeStreamError")
        : entry.systemNotice === "operation-error"
          ? t("assistantCard.systemNoticeOperationError")
        : t("assistantCard.systemNotice");
  const title = isSystemNotice
    ? systemNoticeLabel
    : entry.streaming
      ? t("assistantCard.titleStreaming")
      : t("assistantCard.title");
  const legacySplit = useMemo(() => splitLegacyInterruptTail(entry.text || ""), [entry.text]);
  const wasInterrupted = entry.interrupted === true || legacySplit.hadMarker;
  const displayText = useMemo(() => detectFromStream(legacySplit.text).cleanedText, [legacySplit.text]);
  const renderedText = useMemo(() => replaceToolNamesInText(displayText), [displayText]);
  const markdownText = noticePane
    ? t("assistantCard.conversationOpenInPane", { surface: noticePane.name })
    : entry.route === "command" ? preserveCommandLineBreaks(renderedText) : renderedText;
  const hasRenderableText = markdownText.trim().length > 0;
  const hasHeaderTitle = title.trim().length > 0;
  const showHeader = actions !== undefined || isSystemNotice || wasInterrupted || (entry.streaming && hasHeaderTitle);

  if (entry.streaming && !isSystemNotice && !hasRenderableText) {
    return null;
  }
  return (
    <div
      className={
        isRestoredNotice
          ? "group relative min-w-0 w-full max-w-full overflow-visible rounded-lg border border-border/(--opacity-medium) bg-muted/(--opacity-subtle) p-3 text-sm ave-anim-message-in"
          : isSystemNotice
            ? "group relative min-w-0 w-full max-w-full overflow-visible rounded-lg border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) p-3 text-sm shadow-sm ave-anim-message-in"
            : "group relative min-w-0 w-full max-w-full overflow-visible py-1 text-sm ave-anim-message-in"
      }
    >
      {/* Header bar — mirrors WorkBoardPanel's SectionShell header pattern */}
      {showHeader && (
        <div
          className={
            isRestoredNotice
              ? "mb-2 flex items-center gap-1.5 rounded border-b border-border/(--opacity-light) pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              : isSystemNotice
                ? "mb-2 flex items-center gap-1.5 rounded border-b border-destructive/(--opacity-light) pb-2 text-[11px] font-semibold uppercase tracking-wider text-destructive"
                : "mb-2 flex items-center gap-1.5 rounded pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          }
        >
          {isRestoredNotice ? (
            <History className="h-3 w-3" />
          ) : isSystemNotice ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          {title}
          {isRestoredNotice ? (
            <span
              data-testid="assistant-restored-notice-badge"
              className="rounded-full border border-border/(--opacity-medium) bg-muted/(--opacity-half) px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-muted-foreground"
            >
              {t("assistantCard.restoredNoticeBadge")}
            </span>
          ) : null}
          {wasInterrupted && !entry.streaming ? (
            <span
              data-testid="assistant-interrupted-badge"
              data-interrupted-by={entry.interruptedBy ?? "user"}
              className="rounded-full border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-warning"
            >
              {entry.interruptedBy === "host-exit"
                ? t("assistantCard.interruptedByHostExitBadge")
                : t("assistantCard.interruptedBadge")}
            </span>
          ) : null}
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isStarred ? <Pin key="starred" className="h-3 w-3 fill-emphasis text-emphasis ave-anim-star" /> : null}
          {actions && !entry.streaming ? (
            <div className={`ml-auto gap-1 ${isFinal !== false ? "flex" : "hidden group-hover:flex"}`}>
              {actions.onRetry && (
                <Tooltip><TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 text-muted-foreground hover:text-foreground"
                    onClick={actions.onRetry}
                    title={t("assistantCard.retryButton")}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </TooltipTrigger><TooltipContent>{t("assistantCard.retryButton")}</TooltipContent></Tooltip>
              )}
              {actions.onFork && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  onClick={actions.onFork}
                  title={t("assistantCard.forkButton")}
                >
                  <GitBranch className="h-3 w-3" />
                </Button>
              )}
              {actions.onToggleStar && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  onClick={actions.onToggleStar}
                  title={t("assistantCard.starButton")}
                >
                  <Pin key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis ave-anim-star" : ""}`} />
                </Button>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div
        className={`prose prose-sm ave-prose max-h-none max-w-none overflow-y-visible break-words [overflow-wrap:anywhere] ${entry.route === "command" ? "whitespace-pre-wrap" : ""}`}
        data-testid="assistant-message-body"
      >
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          urlTransform={markdownUrlTransform}
          components={ASSISTANT_MARKDOWN_COMPONENTS}
        >
          {entry.streaming ? clampDanglingMarkdownLink(markdownText) : markdownText}
        </ReactMarkdown>
      </div>

      {noticePane ? (
        <div className="mt-2 flex items-center gap-2" data-testid="assistant-notice-pane-action">
          <Button type="button" variant="outline" size="sm" onClick={() => paneChatNavigation?.openPaneChat(noticePane.tabId)}>
            {t("assistantCard.openPaneChat")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function preserveCommandLineBreaks(text: string): string {
  return text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

export const AssistantCard = memo(AssistantCardImpl);
