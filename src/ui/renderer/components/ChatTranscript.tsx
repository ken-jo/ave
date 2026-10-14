import type React from "react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { SkillBadge, type SkillBadgeProps } from "./SkillBadge.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export interface ChatTranscriptProps {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  readingColumnClass: string;
  loadedSkills: SkillBadgeProps[];
  visibleEntries: ChatEntry[];
  hasApiKey: boolean | null;
  hasAskQuestions: boolean;
  suggestedRepliesActive: boolean;
  transcriptEntries: React.ReactNode;
  chatEndRef: RefObject<HTMLDivElement | null>;
  /** A turn is streaming into this transcript. */
  streaming?: boolean;
  /** Shown in place of the transcript on an empty conversation (suggested tasks). */
  emptyState?: React.ReactNode;
}

/**
 * Presentational chat transcript scroll region: skill badges, empty state, the
 * rendered transcript entries, and the bottom anchor.
 * Scroll behavior lives in `useChatScroll` — this component only receives the
 * viewport ref + already-rendered nodes.
 */
export function ChatTranscript({
  scrollViewportRef,
  readingColumnClass,
  loadedSkills,
  visibleEntries,
  hasApiKey,
  hasAskQuestions,
  suggestedRepliesActive,
  transcriptEntries,
  chatEndRef,
  emptyState,
  streaming = false,
}: ChatTranscriptProps) {
  const { t } = useTranslation();
  // Screen readers: the transcript is an ARIA log (implicitly polite-live), and
  // `aria-busy` holds announcements while tokens stream so a reply is not read
  // out fragment by fragment. The end of a turn is announced once, from a
  // separate status node, on the streaming → idle edge.
  const wasStreamingRef = useRef(streaming);
  const [completionNotice, setCompletionNotice] = useState("");
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) setCompletionNotice(t("chatView.responseComplete"));
    else if (streaming) setCompletionNotice("");
    wasStreamingRef.current = streaming;
  }, [streaming, t]);
  return (
    <>
    {/* Outside the log on purpose: a live region nested in another live
        region is double-read or swallowed depending on the screen reader. */}
    <div className="sr-only" role="status" data-testid="chat-transcript-status">
      {completionNotice}
    </div>
    <ScrollArea type="always" className="ave-chat-scroll h-full min-h-0 min-w-0 max-w-full" viewportRef={scrollViewportRef}><div
      className={`min-w-0 overflow-x-hidden space-y-4 py-5 ${readingColumnClass}`}
      role="log"
      aria-label={t("chatView.transcriptLabel")}
      aria-busy={streaming}
      data-testid="chat-transcript-log"
    >
      {/* Workflow tools (S1+S2): skill badges + ask-user inline.
          SessionTasksPanel is intentionally NOT here — it sits above the input
          cluster (see below the ScrollArea) so it stays visible regardless of
          chat scroll position. */}
      {loadedSkills.length > 0 && (
        <div className="flex w-full max-w-full flex-wrap gap-2" data-testid="skill-badges-row">
          {loadedSkills.map((s, i) => (
            <SkillBadge key={`${s.name}:${i}`} {...s} />
          ))}
        </div>
      )}
      {/* Ready-state empty-prompt: only when we know `hasApiKey === true`.
          `null` (still loading) and `false` (no key) both suppress the
          ready copy so the user never sees a fake-logged-in race
          where the empty state paints before the boot probe resolves
          (#1014 tracer: Stage B). */}
      {visibleEntries.length === 0 && hasApiKey === true && !hasAskQuestions && !suggestedRepliesActive && (
        <div className="sr-only">
          {t("chatView.emptyState")}
        </div>
      )}
      {/* No-key state is NOT surfaced here: the affordance lives in the
          composer's reserved top strip as `ComposerApiKeyChip`, an
          absolutely-positioned chip + overlay popover that keeps both of the
          retired card's destinations (settings / marketplace). */}
      {visibleEntries.length === 0 ? emptyState : null}
      {transcriptEntries}
      <div ref={chatEndRef} />
    </div></ScrollArea>
    </>
  );
}
