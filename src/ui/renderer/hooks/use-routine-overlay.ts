import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { getApi } from "../api-client.js";
import type { RoutineFiredPayload } from "../../../shared/routines-types.js";
import type { AlertCardClosedReason } from "../../../shared/alerts-types.js";
import { ALERT_HOST_PLUGIN_ID } from "../../../shared/alerts-types.js";
import {
  routeToSuggestionsSession,
  type OverlayContextValue,
  type OverlayItem,
} from "../context/OverlayContext.js";
import {
  tileHoldingSession,
  type ChatGroupSessionRegistry,
} from "../components/chat-group-session-registry.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import { errorMessage } from "../../../shared/error-message.js";
import { isSuggestionsSession } from "../../../shared/suggestions-session.js";
import { parseSettingsPath, type SettingsPath } from "../../../shared/settings-tabs.js";
import type { OnboardingProposalDisposition } from "../../../main/onboarding-proposal-store.js";

type Api = ReturnType<typeof getApi>;

export interface UseRoutineOverlayResult {
  /**
   * Populated by OverlayContextProvider DURING its render so the routine/overlay
   * IPC subscriptions here can call addFire() from outside the React tree. App
   * threads this straight into OverlayContextProvider.
   */
  addFireRef: MutableRefObject<OverlayContextValue["addFire"] | null>;
  /** The same for dismiss(), so main can withdraw a card it staged. */
  dismissRef: MutableRefObject<OverlayContextValue["dismiss"] | null>;
  /** In-flight LLM routine sessions; OverlayContextProvider derives running flags. */
  runningRoutines: Set<string>;
  handlePluginPrimaryAction: (overlayItemId: string, chatGroupId: string) => Promise<void>;
  /** Run an insertion card's prompt as the first turn of a new conversation instead. */
  handleContinueInNewConversation: (overlayItemId: string, chatGroupId: string) => Promise<void>;
  /** The user closed an alert card without accepting it; main closes its identity. */
  handleAlertDismiss: (overlayItemId: string) => void;
  handleRoutineAcknowledge: (routineId: string, firedAt: string) => void;
  handleProposalAnswer: (
    overlayItemId: string,
    disposition: OnboardingProposalDisposition,
    chatGroupId: string,
  ) => Promise<void>;
}

/**
 * Routine + plugin-overlay IPC ownership, extracted verbatim from App.tsx.
 *
 * Owns the routine-fire overlay pipeline: `runningRoutines`, the `addFireRef`
 * surfaced to OverlayContextProvider, the `overlayItemsRef` lookup map, and the
 * two IPC subscription effects (routine running/finished/failed/fired + pending
 * drain; plugin overlay show/dismiss). Also owns the two overlay action
 * callbacks.
 *
 * `handlePluginPrimaryAction` reaches a conversation through the tile registry
 * rather than a captured callback: the card is shown in ONE tile, and the turn
 * it starts belongs to that tile's conversation, which the window cannot know
 * at subscribe time.
 */
export function useRoutineOverlay({
  api,
  t,
  locale,
  registry,
  onNavigateToSettings,
  onSuggestionStaged,
}: {
  api: Api;
  t: TranslateFn;
  /** The locale an accepted proposal's follow-up list is resolved in. */
  locale: string;
  registry: ChatGroupSessionRegistry;
  /**
   * Move the settings view onto a destination. A proposal's `settings` action
   * names a tab and optionally a section within it, and the window owns
   * navigation, so it supplies the move.
   */
  onNavigateToSettings: (path: SettingsPath) => void;
  /**
   * A card addressed to the dedicated Suggestions conversation arrived. Main
   * made that conversation exist (or moved it up) before sending, so the window
   * re-reads its list: the row has to be listed for the card to mark it.
   */
  onSuggestionStaged: () => void;
}): UseRoutineOverlayResult {
  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<OverlayContextValue["addFire"] | null>(null);
  const dismissRef = useRef<OverlayContextValue["dismiss"] | null>(null);
  const onSuggestionStagedRef = useRef(onSuggestionStaged);
  useEffect(() => {
    onSuggestionStagedRef.current = onSuggestionStaged;
  }, [onSuggestionStaged]);

  /**
   * The one way a card enters the queue: routed first, so a card the user did
   * not ask for is addressed to the Suggestions conversation and never to the
   * focused one. Returns the card as queued.
   */
  const stage = useCallback((incoming: OverlayItem): OverlayItem => {
    const item = routeToSuggestionsSession(incoming);
    addFireRef.current?.(item);
    if (isSuggestionsSession(item.originSessionId)) onSuggestionStagedRef.current();
    return item;
  }, []);

  const pushRoutineResult = useCallback((evt: RoutineFiredPayload) => {
    stage({
      id: `${evt.id}-${evt.firedAt}`,
      source: { kind: "routine", routineId: evt.id, firedAt: evt.firedAt },
      title: evt.title,
      summary: evt.summary,
      running: false,
      createdAt: evt.firedAt,
      routineSessionId: evt.routineSessionId,
    });
  }, [stage]);

  // Single subscription for routine IPC events. runningStarted pushes a
  // running OverlayItem immediately (running:true); fired replaces it with the
  // completed item (running:false + summary). runningRoutines Set is kept in
  // sync for OverlayContextProvider to derive running flags on queue items.
  useEffect(() => {
    const unsubStarted = api.onRoutineRunningStarted((payload) => {
      const { routineId, firedAt, title } = payload;
      setRunningRoutines((prev) => new Set([...prev, routineId]));
      stage({
        id: `${routineId}-running`,
        source: { kind: "routine", routineId, firedAt },
        title,
        summary: "",
        running: true,
        createdAt: firedAt,
      });
    });

    const unsubFinished = api.onRoutineRunningFinished((routineId) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
    });

    // Major fix: clears running:true stuck OverlayItem when LLM session fails.
    // Uses the same stale-replace path as fired so the running OverlayItem
    // transitions to a visible error summary instead of staying spinning.
    const unsubFailed = api.onRoutineFailed((evt) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(evt.routineId);
        return next;
      });
      const failedAt = new Date().toISOString();
      stage({
        id: `${evt.routineId}-running`,
        source: { kind: "routine", routineId: evt.routineId, firedAt: failedAt },
        title: t("app.routineFailedTitle"),
        summary: t("app.routineFailedSummary", { error: evt.error }),
        running: false,
        createdAt: failedAt,
      });
    });

    void (async () => {
      try {
        const pending = await api.listPendingRoutineResults();
        for (const result of pending) pushRoutineResult(result);
      } catch (err) {
        console.warn("[ave] listPendingRoutineResults failed:", errorMessage(err));
      }
    })();

    // Fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFired(pushRoutineResult);

    return () => { unsubStarted(); unsubFinished(); unsubFailed(); unsubFired(); };
  }, [api, pushRoutineResult, stage, t]);

  // Overlay items ref tracks all items pushed via onOverlayShow so
  // handlePluginPrimaryAction can look up pendingPrompt by id without needing
  // to reach into OverlayContext (App.tsx is the parent of OverlayContextProvider).
  const overlayItemsRef = useRef<Map<string, OverlayItem>>(new Map());
  /** Ids changed while the initial alert snapshot is pending. */
  const alertSnapshotChangesRef = useRef<Set<string> | null>(null);

  // Overlay IPC subscriptions: main pushes plugin OverlayItems via OVERLAY_V1.show.
  useEffect(() => {
    if (typeof api.onOverlayShow !== "function") return;
    const show = (incoming: OverlayItem): void => {
      // The lookup handlePluginPrimaryAction reads by id; the queue takes the
      // same (routed) object, so the confirm resolves the same conversation the
      // card is drawn in.
      const item = stage(incoming);
      overlayItemsRef.current.set(item.id, item);
    };
    const changedDuringPull = new Set<string>();
    alertSnapshotChangesRef.current = changedDuringPull;
    const finishPull = () => {
      if (alertSnapshotChangesRef.current === changedDuringPull) alertSnapshotChangesRef.current = null;
    };
    const unsubShow = api.onOverlayShow((item) => {
      alertSnapshotChangesRef.current?.add(item.id);
      show(item);
    });
    // Alert cards staged before this window was listening — at boot, or
    // before a reload. Subscribe to both changes first. A snapshot response
    // can arrive after a newer push or user action, so those ids take precedence.
    let pulled = true;
    const unsubDismiss = typeof api.onOverlayDismiss === "function"
      ? api.onOverlayDismiss((id) => {
          // Main withdrew the card: it leaves the queue as well as the lookup,
          // so no one can confirm a card whose prompt main no longer stands by.
          alertSnapshotChangesRef.current?.add(id);
          overlayItemsRef.current.delete(id);
          dismissRef.current?.(id);
        })
      : () => {};
    if (api.alerts) {
      void api.alerts.listOpen().then((cards) => {
        if (pulled) for (const card of cards) {
          if (!changedDuringPull.has(card.id)) show(card);
        }
      }).catch((err) => {
        console.warn("[ave] alerts listOpen failed:", errorMessage(err));
      }).finally(finishPull);
    } else {
      finishPull();
    }
    return () => { pulled = false; finishPull(); unsubShow(); unsubDismiss(); };
  }, [api, stage]);

  // Insertion-overlay primary action handler (user confirm → main chat insert).
  // Called from OverlayCardRegion with the OverlayItem.id after OverlayContext.dismiss()
  // has already removed the item from the queue. overlayItemsRef still holds it.
  //
  // Two staged sources land here, and BOTH are non-user-authored: a plugin overlay
  // trigger and an MCP App's `ui/message` that arrived with no turn in flight. The
  // click is the gate — neither may start a turn on its own. They differ only in
  // provenance, which rides the envelope already inside `pendingPrompt` and the send
  // mode (→ `plugin-emitted` / `app-emitted` trust origin in main).
  const reportAlertClosed = useCallback(
    (alertId: string, reason: AlertCardClosedReason) => {
      void api.alerts?.cardClosed(alertId, reason).catch((err) => {
        console.warn("[ave] alerts cardClosed failed:", errorMessage(err));
      });
    },
    [api],
  );

  /**
   * The insertion card the user acted on, and the tile that showed it.
   *
   * The tile is resolved from the card's ORIGIN, not from the surface that
   * rendered it. The two agree whenever the origin conversation is open — that
   * is how the card got there — but the tile can close between the paint and
   * the click, and inserting into the caller's tile then would put a prompt
   * staged for one conversation into another. A card with no origin has no
   * conversation to contradict, so the group the caller named (a tile's own, or
   * the focused one for the window's region) stands.
   */
  const resolveInsertion = useCallback((overlayItemId: string, chatGroupId: string) => {
    const item = overlayItemsRef.current.get(overlayItemId);
    if (!item) return null;
    const { source, pendingPrompt } = item;
    // Only the INSERTION sources reach here. A routine has its own primary
    // action, and a proposal answers rather than inserts — see
    // `handleProposalAnswer`. An alert is a plugin's insertion card rendered
    // by the host: same staged origin, same confirm.
    if (source.kind !== "plugin" && source.kind !== "app" && source.kind !== "alert") return null;
    if (!pendingPrompt) return null;
    const targetGroupId = item.originSessionId === undefined
      ? chatGroupId
      : tileHoldingSession(registry.readTiles(), item.originSessionId)?.chatGroupId;
    const tile = targetGroupId === undefined ? undefined : registry.read(targetGroupId);
    if (!tile) {
      console.warn("[ave] overlay confirm dropped: origin conversation is no longer open");
      return null;
    }
    return { item, source, pendingPrompt, tile };
  }, [registry]);

  /** Insert the staged prompt into `tile` and start its turn; the card is then spent. */
  const runInsertion = useCallback((
    overlayItemId: string,
    { item, source, pendingPrompt, tile }: NonNullable<ReturnType<typeof resolveInsertion>>,
  ) => {
    alertSnapshotChangesRef.current?.add(overlayItemId);
    overlayItemsRef.current.delete(overlayItemId);

    // Insert as imported_trigger entry — staged provenance preserved, NOT a plain
    // user bubble (architecture §9 plugin provenance contract; same rule for apps).
    tile.insertImportedTriggerEntry({
      sessionId: source.kind === "alert" ? source.alertId : source.eventId,
      source: source.kind === "app" ? `app:${source.serverId}`
        : source.kind === "alert" && source.pluginId === ALERT_HOST_PLUGIN_ID ? `host:${source.kindId}` : `plugin:${source.pluginId}`,
      prompt: pendingPrompt,
      summary: item.summary,
    });

    // Start THAT tile's turn (user-in-the-loop confirm → auto-process). Both
    // modes skip the user-bubble append since the imported_trigger marker
    // already represents the staged prompt.
    void tile.ask(
      pendingPrompt,
      source.kind === "app" ? "app-message" : "trigger-import",
    );
    if (source.kind === "alert") reportAlertClosed(source.alertId, "accepted");
  }, [reportAlertClosed]);

  const handlePluginPrimaryAction = useCallback(
    async (overlayItemId: string, chatGroupId: string) => {
      const target = resolveInsertion(overlayItemId, chatGroupId);
      if (target) runInsertion(overlayItemId, target);
    },
    [resolveInsertion, runInsertion],
  );

  // The card's other answer: run the suggestion in a FRESH conversation rather
  // than the one the card belongs to. The tile that showed the card starts it,
  // and the staged prompt is its first turn, with the same provenance. When no
  // new conversation starts (that tile is mid-turn, or main refused), nothing
  // ran, so the card goes back in the queue.
  const handleContinueInNewConversation = useCallback(
    async (overlayItemId: string, chatGroupId: string) => {
      const target = resolveInsertion(overlayItemId, chatGroupId);
      if (!target) return;
      if (!(await target.tile.startNewChat())) {
        addFireRef.current?.(target.item);
        return;
      }
      runInsertion(overlayItemId, target);
    },
    [resolveInsertion, runInsertion],
  );

  // The user closed an alert card without accepting it. Main keeps the
  // identity closed for the card's lifetime, so a re-raise does not bring it
  // back.
  const handleAlertDismiss = useCallback(
    (overlayItemId: string) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      alertSnapshotChangesRef.current?.add(overlayItemId);
      overlayItemsRef.current.delete(overlayItemId);
      if (item?.source.kind === "alert") reportAlertClosed(item.source.alertId, "dismissed");
    },
    [reportAlertClosed],
  );

  const handleRoutineAcknowledge = useCallback(
    (routineId: string, firedAt: string) => {
      void api.acknowledgeRoutineResult(routineId, firedAt).catch((err) => {
        console.warn("[ave] acknowledgeRoutineResult failed:", errorMessage(err));
      });
    },
    [api],
  );

  // The user's answer to an onboarding proposal. Accepting performs the action
  // the manifest declared — and only that: text into a composer, or the
  // settings view onto the section that holds the option. Nothing here starts
  // a turn, which is why a proposal never travels the `imported_trigger` path
  // the insertion cards use.
  //
  // The answer is recorded whichever way it went, including "accepted": all
  // three are final for this launch, and two of them are final for good. The
  // host's reply re-stages whatever is still unanswered, so the next question
  // arrives only after this one has one.
  const handleProposalAnswer = useCallback(
    async (
      overlayItemId: string,
      disposition: OnboardingProposalDisposition,
      chatGroupId: string,
    ) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item || item.source.kind !== "proposal") return;
      const { pluginId, proposalId, action } = item.source;
      overlayItemsRef.current.delete(overlayItemId);

      if (disposition === "accepted") {
        if (action.kind === "composer") {
          // The pane whose region showed the card — the focused one, where the
          // user is — the same rule an insertion card inserts by.
          const tile = registry.read(chatGroupId);
          if (tile) tile.prefillComposer(action.prompt);
        } else if (action.kind === "settings") {
          // Fail-closed rather than landing on the default tab: manifest
          // validation already rejected a path this build cannot reach, so a
          // null here means the declared destination is gone, and sending the
          // user somewhere else would answer their "yes" with the wrong page.
          const path = parseSettingsPath(action.path);
          if (path) onNavigateToSettings(path);
        }
      }

      try {
        await api.onboarding.answer(`${pluginId}:${proposalId}`, disposition, locale);
      } catch (err) {
        console.warn("[ave] onboarding proposal answer failed:", errorMessage(err));
      }
    },
    [api, locale, onNavigateToSettings, registry],
  );

  return {
    addFireRef,
    dismissRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleContinueInNewConversation,
    handleAlertDismiss,
    handleRoutineAcknowledge,
    handleProposalAnswer,
  };
}
