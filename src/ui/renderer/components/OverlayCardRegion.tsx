// Cards stay with their owning conversation and never enter chat history; hidden conversations signal through sidebar
// attention dots.

import { useEffect, useMemo, useRef, useState } from "react";
import { ALERT_HOST_PLUGIN_ID } from "../../../shared/alerts-types.js";
import { routineThumbnailOwner, useOverlayContext } from "../context/OverlayContext.js";
import { OverlayCard } from "./OverlayCard.js";
import { useTranslation } from "../../../i18n/react.js";
import { FLOATING_LANE_ITEM_WIDTH } from "./FloatingRightLane.js";
import type { OverlayCardPlacement } from "./chat-group-session-registry.js";
import type { OnboardingProposalDisposition } from "../../../main/onboarding-proposal-store.js";

export interface OverlayCardRegionProps {
  /** The tile this region renders inside. */
  chatGroupId: string;
  /**
   * The conversation this region's primary action runs in — this tile's.
   * Stated here rather than inferred from where the card happens to be
   * drawn, because a card with no origin is drawn in the FOCUSED pane and
   * its turn has to start there.
   */
  actionChatGroupId: string;
  /** Where a card belongs, given the conversation it came from, and whether that conversation is still open. The window
   * answers it, because only the window can see every tile. */
  overlayCardTile: (card: { originSessionId?: string }) => OverlayCardPlacement;
  /** Called when the user confirms a plugin overlay item, with the tile that showed the card — the conversation the staged
   * prompt is inserted into and the turn is started in. */
  onPluginPrimaryAction: (overlayItemId: string, chatGroupId: string) => void;
  /** The insertion card's second answer: run its prompt in a new conversation started in the tile that showed the card,
   * rather than in the card's own. Omitted, the card offers only the primary action. */
  onContinueInNewConversation?: (overlayItemId: string, chatGroupId: string) => void;
  /** Called when the user closes an alert card without accepting it. */
  onAlertDismiss?: (overlayItemId: string) => void;
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
  /** The user's answer to an onboarding proposal, with the tile that showed the card — an accepted composer action prefills
   * THAT conversation, the same rule the insertion cards follow. */
  onProposalAnswer?: (
    overlayItemId: string,
    disposition: OnboardingProposalDisposition,
    chatGroupId: string,
  ) => void;
}

export function OverlayCardRegion({
  chatGroupId, actionChatGroupId, overlayCardTile, onPluginPrimaryAction, onContinueInNewConversation, onAlertDismiss, onRoutineAcknowledge,
  onProposalAnswer,
}: OverlayCardRegionProps) {
  const { t } = useTranslation();
  const { queue, dismiss, openSession, expandedCardIds, setCardExpanded, thumbnailSessions } =
    useOverlayContext();

  // This surface's slice of the window queue. Every tile mounts a region and each keeps only the cards attributed to it, so
  // a card is shown — and so dismissed or confirmed — exactly once however many tiles are open.
  const mine = useMemo(
    () => queue.filter((item) => overlayCardTile(item).chatGroupId === chatGroupId
      && routineThumbnailOwner(item, thumbnailSessions) === null),
    [queue, overlayCardTile, chatGroupId, thumbnailSessions],
  );

  // The region hangs in the tile's floating lane at the lane's own width.
  const regionClassName = `pointer-events-none ${FLOATING_LANE_ITEM_WIDTH}`;

  const [activeIndex, setActiveIndex] = useState(0);
  // Clamped rather than corrected in an effect: the slice can shrink between renders (a card dismissed, or one that followed
  // focus to another tile), and rendering `undefined` for a frame would flash the card away and back.
  const index = mine.length === 0 ? 0 : Math.min(activeIndex, mine.length - 1);
  const active = mine[index] ?? null;

  // A card that just arrived is the one the user means. Kept in an effect rather than inside a state updater because
  // StrictMode double-invokes updaters, which would advance twice.
  const previousCountRef = useRef(0);
  useEffect(() => {
    if (mine.length > previousCountRef.current) setActiveIndex(mine.length - 1);
    previousCountRef.current = mine.length;
  }, [mine.length]);

  if (!active) return null;

  const queueIndex = index + 1;
  const queueTotal = mine.length;
  const prev = () => setActiveIndex(Math.max(0, index - 1));
  const next = () => setActiveIndex(Math.min(mine.length - 1, index + 1));
  const expanded = expandedCardIds.has(active.id);
  const onExpandedChange = (value: boolean) => setCardExpanded(active.id, value);
  const pluginId = active.source.kind === "plugin" || active.source.kind === "proposal"
    || (active.source.kind === "alert" && active.source.pluginId !== ALERT_HOST_PLUGIN_ID)
    ? active.source.pluginId
    : undefined;

  if (active.source.kind === "routine") {
    const { routineId, firedAt } = active.source;

    const hasSession = !!active.routineSessionId;
    return (
      <div
        data-testid="overlay-card-region"
        data-overlay-surface={chatGroupId}
        // Position comes from `FloatingRightLane`, which is also what kept the old tool-activity rail from landing on top of this
        // card's controls.
        className={regionClassName}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={firedAt}
            running={active.running}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => {
              if (!active.running) onRoutineAcknowledge?.(routineId, firedAt);
              dismiss(active.id);
            }}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onPrimaryAction={hasSession ? () => {
              void (async () => {
                const opened = await openSession(active.routineSessionId!);
                if (opened) {
                  onRoutineAcknowledge?.(routineId, firedAt);
                  dismiss(active.id);
                }
              })();
            } : undefined}
            primaryActionLabel={t("overlayCardRegion.viewResult")}
            kind="routine"
          />
        </div>
      </div>
    );
  }

  // Onboarding proposal — the card ASKS, and the three buttons are the answer.
  // No `pendingPrompt` and no turn: what accepting does lives in
  // `source.action` and is performed by the host, so an unanswerable card
  // cannot exist here the way an orphaned insertion card can.
  if (active.source.kind === "proposal") {
    const answer = (disposition: OnboardingProposalDisposition) => () => {
      dismiss(active.id);
      onProposalAnswer?.(active.id, disposition, actionChatGroupId);
    };
    return (
      <div
        data-testid="overlay-card-region"
        data-overlay-surface={chatGroupId}
        data-overlay-source="proposal"
        className={regionClassName}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={active.createdAt}
            running={false}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => dismiss(active.id)}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            primaryActionLabel={active.primaryActionLabel}
            dispositions={{
              onAccept: answer("accepted"),
              onLater: answer("later"),
              onNever: answer("never"),
            }}
            kind="plugin"
            pluginId={pluginId}
            pluginDisplayName={active.pluginDisplayName}
          />
        </div>
      </div>
    );
  }

  // Insertion variants — plugin overlay trigger and MCP-app `ui/message`. Both stage a
  // `pendingPrompt` that only a user CLICK turns into a chat turn; they differ solely in
  // provenance (the envelope in `pendingPrompt` and the badge below).
  if (active.source.kind === "plugin" || active.source.kind === "app" || active.source.kind === "alert") {
    const kind = active.source.kind === "app" ? "app"
      : active.source.kind === "alert" && active.source.pluginId === ALERT_HOST_PLUGIN_ID ? "host" : "plugin";
    const isAlert = active.source.kind === "alert";
    return (
      <div
        data-testid="overlay-card-region"
        data-overlay-surface={chatGroupId}
        className={regionClassName}
      >
        <div className="pointer-events-auto">
          <OverlayCard
            key={active.id}
            title={active.title}
            summary={active.summary}
            firedAt={active.createdAt}
            running={active.running}
            queueIndex={queueIndex}
            queueTotal={queueTotal}
            onPrev={prev}
            onNext={next}
            onDismiss={() => {
              dismiss(active.id);
              if (isAlert) onAlertDismiss?.(active.id);
            }}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onPrimaryAction={() => {
              // Dismiss from queue first, then notify App for chat insert.
              dismiss(active.id);
              onPluginPrimaryAction(active.id, actionChatGroupId);
            }}
            primaryActionLabel={active.primaryActionLabel ?? t("overlayCardRegion.confirm")}
            {...(onContinueInNewConversation
              ? {
                  secondaryAction: {
                    label: t("overlayCardRegion.continueInNewConversation"),
                    onClick: () => {
                      // Same order as the primary action: off the queue, then run. The handler puts it back if no conversation started.
                      dismiss(active.id);
                      onContinueInNewConversation(active.id, actionChatGroupId);
                    },
                  },
                }
              : {})}
            kind={kind}
            pluginId={pluginId}
            pluginDisplayName={active.pluginDisplayName}
          />
        </div>
      </div>
    );
  }

  return null;
}
