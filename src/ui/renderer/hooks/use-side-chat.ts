/**
 * use-side-chat — a LIGHTWEIGHT side-chat controller hook that renders through
 * the SAME shared TranscriptRenderer as the main chat.
 *
 * Deliberately NOT built on the heavy main-chat ChatContext (~40 fields,
 * checkpoint/compact/fork/star machinery). Side chat is a compact second session
 * in the workspace rail, so this hook keeps ONLY what a minimal transcript needs:
 * a local `entries: ChatEntry[]` list, a `send`, `newSession`, `loadSession`,
 * `isStreaming`, and `abort`.
 *
 * INPUT PARITY: `send` follows the main composer's rule for a send that lands
 * while a turn is running — a user gesture interrupts (abort, then send); the
 * end-of-turn queue drain does not. The queue itself, and the keys that feed it
 * (Enter, ⌘⏎, Esc), are the shared `useMessageQueue` hook, not this one.
 *
 * RENDER PARITY: the side channel already emits the full frame set
 * (`reasoning_delta` / `permission_review` / `tool_start` / `tool_end` /
 * `turn_summary` / `compact_notice` / `assistant_round` / `done`) via the shared
 * `runStreamedTurn`. This hook applies the main chat's frame reducer
 * (`applyTranscriptFrame` / `applyReasoningDelta` in `lib/chat-stream-state`)
 * so tool calls, thinking, and permission-review status cards render
 * identically to the main transcript.
 *
 * ISOLATION: it subscribes to the DEDICATED `api.sideChat.onStream` channel —
 * NEVER `onChatStream` — so main-chat frames can never leak into this transcript
 * (and vice versa). The stale-frame guard adopts a monotonic streamId only from
 * this view's matching prelude and drops superseded turns BEFORE any reducer
 * runs. View teardown retires pending work and cancels only its local request.
 *
 * Tool APPROVAL is NOT handled here: the side loop shares the host's global
 * ApprovalGate, which broadcasts on the app-global `ave:approval:request`
 * channel into the window's one queue (App.tsx `useApproval`). SideChatView
 * claims this loop's `sessionId` there and draws the card inside its own
 * panel. Only the informational `permission_review` STATUS card flows through
 * this transcript.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import {
  applyReasoningDelta,
  applyTranscriptFrame,
  dropPendingLlmStatusAssistant,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  isTranscriptFrame,
  markTurnAssistantInterrupted,
  setAssistantError,
  upsertStreamingAssistant,
  type ChatEntry,
  type ChatStreamEvent,
} from "../../../lib/chat-stream-state.js";
import { formatLlmStatusMessage } from "../../../lib/llm-status-message.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import type { UserContentPart } from "../../../engine/llm/types.js";
import type { ActiveWorkspaceSurface } from "../../../shared/browser-surface.js";
import { formatIpcError } from "../format-ipc-error.js";
import { historyToEntries } from "../utils/history.js";
import { isTurnStartEntry } from "../utils/classify-turn-entries.js";
import type { TurnSummary } from "../components/TranscriptRenderer.js";
import type { AveApi } from "../types.js";
import { errorMessage } from "../../../shared/error-message.js";

interface SideChatSendOptions {
  /** Vision / resource parts composed from the composer's attachments. */
  attachments?: UserContentPart[];
  /** Badge on the user bubble: a drained queue row, or an interrupting send. */
  injectHint?: "queue" | "interrupt";
  /**
   * `queue-auto` is the end-of-turn queue drain: it follows the turn that just
   * closed and must not stop anything. Every other send is the user's own
   * gesture (Enter when idle, ⌘⏎, Esc-inject, a row's "send now") and, when a
   * turn is still running, interrupts it first — the main composer's rule.
   */
  inputOrigin?: "queue-auto";
  /** The pane tab this chat is bound to (a pane's own chat), named on every turn. */
  surface?: ActiveWorkspaceSurface;
  /**
   * The conversation this side chat belongs to. Sent on every turn; the host
   * records it once, on the turn that first gives the side chat a file, and the
   * sidebar lists the row under that conversation.
   */
  originSessionId?: string;
}

export interface UseSideChat {
  entries: ChatEntry[];
  turnSummaryByTurnStart: Map<number, TurnSummary>;
  isStreaming: boolean;
  sessionId: string | null;
  send: (text: string, opts?: SideChatSendOptions) => Promise<void>;
  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  abort: () => Promise<void>;
  /**
   * Stale-frame verdict for one side-chat stream frame, shared with every other
   * subscriber on this channel (the message queue) so they agree on which turn
   * a frame belongs to. Calling it ADOPTS the streamId of a matching user prelude,
   * which is idempotent for a given frame however many subscribers ask.
   */
  isCurrentTurnEvent: (event: ChatStreamEvent) => boolean;
}

export interface UseSideChatOptions {
  /** Acquires ownership on an accepted send, new or load, including the same session. */
  onSessionBound?: (sessionId: string) => void;
}

interface SessionChangeIntent {
  generation: number;
  previous: SessionChangeIntent | null;
  state: "pending" | "accepted" | "refused" | "failed";
  applied: boolean;
  applyResult?: () => { historyReplaced: boolean };
  refusalMessage?: string;
  refusedSends?: Array<{ userEntry: ChatEntry; message: string }>;
}

type SessionChangeResult = Awaited<ReturnType<NonNullable<AveApi["sideChat"]>["new" | "load"]>>;

export function useSideChat(api: AveApi, options?: UseSideChatOptions): UseSideChat {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const viewMountedRef = useRef(true);
  const activeSendRequestIdRef = useRef<string | null>(null);
  const activeUserEntryRef = useRef<ChatEntry | null>(null);
  const boundSendRequestIdRef = useRef<string | null>(null);
  // Invoke replies can outlive the terminal frame. A deliberate stream reset
  // supersedes their generation; refused replacements restore the prior one.
  const sendGenerationRef = useRef(0);
  // Restoring an intent must never reuse a generation already issued to a
  // different request whose reply may still be pending.
  const generationSequenceRef = useRef(0);
  const sessionChangeIntentRef = useRef<SessionChangeIntent | null>(null);
  const pendingSendRef = useRef<ReturnType<NonNullable<AveApi["sideChat"]>["send"]> | null>(null);
  const onSessionBoundRef = useRef(options?.onSessionBound);
  useLayoutEffect(() => {
    onSessionBoundRef.current = options?.onSessionBound;
  }, [options?.onSessionBound]);
  const recordSessionId = useCallback((next: string, acquired = true) => {
    const changed = sessionIdRef.current !== next;
    if (changed) {
      sessionIdRef.current = next;
      setSessionId(next);
    }
    if (changed || acquired) onSessionBoundRef.current?.(next);
  }, []);

  // Stream-accumulator refs — mirror the main hook so `assistant_round` / `done`
  // can finalize the streamed body / thought exactly as the main transcript does.
  const streamRef = useRef("");
  const thoughtRef = useRef("");
  // Final assistant text is canonical at assistant_round(end_turn). Later deltas
  // in the same stream are protocol tail noise, not a new response.
  const finalAssistantRoundClosedRef = useRef(false);
  const terminalStreamClosedRef = useRef(false);

  // ── Isolation guard ──
  // Guards the reducer against stale frames after abort / new-session: only the
  // in-flight streamId is applied to the transcript. The main process allocates
  // the streamId monotonically (`++nextSideStreamId`), so the renderer cannot
  // know it at `send` time (the send invoke resolves only when the turn ENDS).
  // Instead the matching user prelude ADOPTS its streamId here; any later frame
  // whose streamId differs is from a superseded turn and is dropped.
  // `send` / `abort` / `newSession` / `loadSession` re-arm `activeStreamIdRef`
  // to null so the next turn's matching prelude adopts the new id. `done` and
  // `error` deliberately do NOT: a frame's verdict has to read the same for
  // every subscriber that asks about it during one dispatch, and the next
  // `send` re-arms before another turn can exist.
  const activeStreamIdRef = useRef<number | null>(null);
  const activeStreamSessionIdRef = useRef<string | null>(null);
  // Highest streamId ever adopted. Because main allocates ids monotonically, a
  // straggler frame from a JUST-FINISHED turn carries a LOWER id than the next
  // turn's — after a re-arm we must adopt only a strictly-greater id so such a
  // straggler can never be mistaken for the new turn's first frame.
  const maxStreamIdRef = useRef<number>(-1);
  // Mirror of `isStreaming` for the unmount teardown and for `send`'s
  // interrupt check, neither of which can read the latest state directly. The
  // mirror used to be assigned during RENDER, which left it stale for every
  // reader that ran between a state change and the next commit — the window in
  // which a send that should interrupt decides it has nothing to interrupt.
  // `setStreaming` is the only writer of both, so they cannot diverge.
  const isStreamingRef = useRef(false);
  const setStreaming = useCallback((next: boolean) => {
    isStreamingRef.current = next;
    if (!next) {
      activeSendRequestIdRef.current = null;
      activeUserEntryRef.current = null;
      boundSendRequestIdRef.current = null;
    }
    setIsStreaming(next);
  }, []);

  // Empty the stream accumulators. Says nothing about which turn is current —
  // frame handlers use this so that judging a frame stays a pure read of the
  // guard (see `isCurrentTurnEvent`).
  const resetStreamAccumulators = useCallback(() => {
    streamRef.current = "";
    thoughtRef.current = "";
    finalAssistantRoundClosedRef.current = false;
  }, []);

  // …and abandon the turn on top of that: the guard is re-armed so the NEXT
  // turn's matching prelude adopts its own streamId. Only the deliberate transitions
  // do this — starting a turn, stopping one, swapping sessions — never a frame
  // handler.
  const resetStreamState = useCallback(() => {
    sendGenerationRef.current = ++generationSequenceRef.current;
    resetStreamAccumulators();
    activeStreamIdRef.current = null;
    activeStreamSessionIdRef.current = null;
    terminalStreamClosedRef.current = false;
    activeSendRequestIdRef.current = null;
    activeUserEntryRef.current = null;
    boundSendRequestIdRef.current = null;
  }, [resetStreamAccumulators]);

  // Hidden tabs remain mounted. Teardown retires pending continuations before
  // cancelling this view's request, so delayed work cannot start an orphan turn.
  // The lifetime does not follow api-identity churn.
  useEffect(() => {
    viewMountedRef.current = true;
    return () => {
      viewMountedRef.current = false;
      const sendRequestId = activeSendRequestIdRef.current;
      const streaming = isStreamingRef.current;
      resetStreamState();
      sessionChangeIntentRef.current = null;
      if (streaming && sendRequestId !== null) {
        void api.sideChat?.abort(sendRequestId).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetStreamState]);

  // The stale-frame rule, and the SINGLE place a turn's streamId is adopted.
  // Returned from this hook so the shared message queue drains against the SAME
  // verdict: a second, independent copy of this rule would let a superseded
  // turn's trailing `done` (an aborted turn still emits one — `runStreamedTurn`
  // sends `turn.completed` on every return) drain a queued row into a fresh
  // send while the surviving turn is still running.
  //
  // Every subscriber on this channel asks about the same frame, one after the
  // other, and they must get the same answer. Two things make that hold:
  // recording a stream id is idempotent for a frame that has already been
  // judged; and no FRAME HANDLER re-arms the guard
  // (`done` resets the accumulators only) — the deliberate transitions do, and
  // those never run inside a dispatch. Caching the answer by frame identity
  // would NOT work: the context bridge hands each subscriber its own copy.
  const isCurrentTurnEvent = useCallback(
    (event: ChatStreamEvent): boolean => {
      if (!viewMountedRef.current) return false;
      if (event.type === "user_message" && (
        activeSendRequestIdRef.current === null
        || event.sendRequestId !== activeSendRequestIdRef.current
        || typeof event.sessionId !== "string" || event.sessionId.trim().length === 0
      )) {
        // A peer's prelude must not adopt its stream or let its tail settle
        // this view's pending send. Remember the id when the guard re-arms.
        if (typeof event.streamId === "number") {
          maxStreamIdRef.current = Math.max(maxStreamIdRef.current, event.streamId);
        }
        return false;
      }
      if (activeStreamIdRef.current === null) {
        // A view mounted mid-turn may never have seen a peer's prelude. Its
        // remaining frames cannot establish ownership of a pending local send.
        if (!isStreamingRef.current || event.type !== "user_message") return false;
        if (!judgeStreamFrame(event, activeStreamIdRef, maxStreamIdRef)) return false;
        activeStreamSessionIdRef.current = event.sessionId!;
        return true;
      }
      if (event.sessionId !== undefined && event.sessionId !== activeStreamSessionIdRef.current) return false;
      return judgeStreamFrame(event, activeStreamIdRef, maxStreamIdRef);
    },
    [],
  );

  // Subscribe to the DEDICATED side-chat stream. Frames reduce through the
  // reducer the main chat uses, so tool / reasoning / permission-review render
  // identically. The stale-frame guard runs FIRST, before any reducer, so it
  // stays orthogonal to the richer frame set.
  useEffect(() => {
    if (!api.sideChat) return;
    const handleSideStreamEvent = (event: ChatStreamEvent) => {
      if (!isCurrentTurnEvent(event)) return;
      if (terminalStreamClosedRef.current) return;

      const ev = event;
      if (ev.type === "user_message") {
        if (isStreamingRef.current
          && activeSendRequestIdRef.current !== null
          && ev.sendRequestId === activeSendRequestIdRef.current
          && typeof ev.sessionId === "string" && ev.sessionId.trim().length > 0) {
          const acquired = boundSendRequestIdRef.current !== ev.sendRequestId;
          boundSendRequestIdRef.current = ev.sendRequestId;
          sessionChangeIntentRef.current = null;
          if (sessionIdRef.current !== null && sessionIdRef.current !== ev.sessionId
            && activeUserEntryRef.current !== null) {
            // A peer can change the window-wide loop between this view's turns.
            // Its accepted prelude must not relabel history from the old session.
            setEntries([activeUserEntryRef.current]);
          }
          recordSessionId(ev.sessionId, acquired);
        }
        // The shared stream can reach another view whose own send is pending
        // or idle. Only this request binds ownership; the user bubble is local.
      } else if (ev.type === "llm_status") {
        // A terminal frame has closed this stream. Do not let delayed provider
        // status resurrect a dismissed placeholder after done, error, or abort.
        if (!isStreamingRef.current || finalAssistantRoundClosedRef.current) return;
        const message = formatLlmStatusMessage(ev);
        if (!message) return;
        setEntries((p) => upsertStreamingAssistant(p, message, "status"));
      } else if (ev.type === "text_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        const delta = ev.text;
        streamRef.current += delta;
        const text = streamRef.current;
        setEntries((p) => upsertStreamingAssistant(p, text));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        thoughtRef.current += ev.text;
        const thought = thoughtRef.current;
        setEntries((p) => applyReasoningDelta(p, thought));
      } else if (ev.type === "assistant_round") {
        const phase = ev.stopReason === "end_turn" && ev.hasToolCalls !== true ? "final" : "work";
        if (finalAssistantRoundClosedRef.current) return;
        const thought = ev.thought ?? thoughtRef.current;
        const rawText = ev.text || streamRef.current;
        const finalText = visibleText(detectFromStream(rawText).cleanedText);
        setEntries((p) => {
          let next = finalizeStreamingReasoning(p, thought);
          next = finalizeStreamingAssistant(next, finalText, { phase, overrideText: finalText });
          return next;
        });
        finalAssistantRoundClosedRef.current = phase === "final";
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (isTranscriptFrame(ev)) {
        setEntries((p) => applyTranscriptFrame(p, ev));
      } else if (ev.type === "error") {
        terminalStreamClosedRef.current = true;
        // Read the accumulated thought HERE, not inside the updater: React runs
        // the updater at flush time, by which point the synchronous
        // `resetStreamAccumulators()` below has already emptied the ref.
        const thought = thoughtRef.current;
        setEntries((p) =>
          setAssistantError(
            p,
            t("useChatState.errorPrefix", { error: ev.error || t("useChatState.unknownError") }),
            thought,
            ev.systemNotice,
          ),
        );
        setStreaming(false);
        resetStreamAccumulators();
      } else if (ev.type === "done") {
        terminalStreamClosedRef.current = true;
        if (!finalAssistantRoundClosedRef.current && (streamRef.current || thoughtRef.current)) {
          const detected = detectFromStream(streamRef.current);
          const finalText = visibleText(detected.cleanedText);
          const thought = thoughtRef.current;
          setEntries((p) => {
            let next = finalizeStreamingReasoning(p, thought);
            next = finalizeStreamingAssistant(next, finalText, { overrideText: finalText });
            return next;
          });
        } else {
          setEntries((p) => dropPendingLlmStatusAssistant(p));
        }
        setStreaming(false);
        resetStreamAccumulators();
      }
    };
    const off = api.sideChat.onStream(handleSideStreamEvent);

    // E2E test seam — only exposed when AVE_DEV=1 (same gate + rationale as the
    // main chat's `__aveChatStream`). Playwright side-chat specs use this to
    // inject synthetic tool_start / tool_end / reasoning_delta frames onto the
    // DEDICATED side channel (no live LLM), proving the side transcript renders
    // through the shared TranscriptRenderer identically to the main transcript.
    // Inert in packaged production builds where the launcher never sets the flag.
    const w = window as unknown as {
      ave?: { env?: { isDev?: boolean } };
      __aveSideChatStream?: { _emit: typeof handleSideStreamEvent };
    };
    if (w.ave?.env?.isDev === true) {
      w.__aveSideChatStream = { _emit: handleSideStreamEvent };
    }

    return () => {
      off();
      if (w.__aveSideChatStream && w.__aveSideChatStream._emit === handleSideStreamEvent) {
        delete w.__aveSideChatStream;
      }
    };
  }, [api, resetStreamAccumulators, isCurrentTurnEvent, recordSessionId, setStreaming, t]);

  const abandonTurn = useCallback(() => {
    // Abandon the turn BEFORE the round trip, not after it. The host settles the
    // turn while this call is in flight, and an aborted turn still emits a
    // trailing `done` — `runStreamedTurn` sends `turn.completed` on every
    // return — so that frame lands DURING the await. Re-arming the guard
    // afterwards left a window in which the frame still read as the current
    // turn's, and the message queue drained a row into a new turn on top of the
    // one the interrupt was about to start.
    //
    // The answer that was cut short keeps what it streamed and wears the
    // interrupted badge, exactly as the main transcript marks a stopped turn; an
    // answer that had not produced a byte yet is dropped rather than left as an
    // empty bubble with a spinner. The thought is read here, not inside the
    // updater, because the reset empties the ref synchronously while React
    // flushes the updater later.
    const thought = thoughtRef.current;
    const sendRequestId = activeSendRequestIdRef.current;
    const streaming = isStreamingRef.current;
    resetStreamState();
    setStreaming(false);
    if (streaming) {
      // The guard now drops closing frames, so settle retained rows locally.
      setEntries((p) => finalizeStreamingAssistant(
        markTurnAssistantInterrupted(finalizeStreamingReasoning(
          dropPendingStreamingAssistant(dropPendingLlmStatusAssistant(p)),
          thought,
        )),
        "",
        { phase: "work" },
      ));
    }
    return { sendRequestId, generation: sendGenerationRef.current };
  }, [resetStreamState, setStreaming]);

  const reportOperationError = useCallback((generation: number, message: string) => {
    if (!viewMountedRef.current || generation !== sendGenerationRef.current) return;
    setEntries((p) => setAssistantError(p, message, "", "stream-error"));
  }, []);

  const restoreSessionIntent = useCallback((intent: SessionChangeIntent): SessionChangeIntent => {
    let restored = intent;
    while (restored.state === "refused" && restored.previous !== null) {
      const previous = restored.previous;
      if (restored.refusedSends?.length) {
        (previous.refusedSends ??= []).push(...restored.refusedSends);
        restored.refusedSends = undefined;
      }
      restored = previous;
    }
    sendGenerationRef.current = restored.generation;
    sessionChangeIntentRef.current = restored.state === "pending" ? restored : null;
    return restored;
  }, []);

  const abort = useCallback(async () => {
    if (!viewMountedRef.current || !api.sideChat) return;
    const { sendRequestId, generation } = abandonTurn();
    // Awaited last: an interrupting send goes out immediately after this
    // resolves, and the host refuses a send while its turn is still in flight.
    //
    // Reported, not thrown. By this point the interrupt is committed in the
    // local UI — the composer cleared the draft before calling and the transcript
    // already marks the answer stopped — so letting a transport failure escape
    // would destroy the text the user typed and strand the host turn, still
    // streaming into frames this hook now drops. The send goes out either way;
    // if the host really is still busy it refuses that send with its own
    // message.
    try {
      if (sendRequestId !== null) {
        const res = await api.sideChat.abort(sendRequestId);
        if (!res.ok) reportOperationError(generation, formatIpcError(res.error, undefined));
      }
    } catch (err) {
      reportOperationError(generation, errorMessage(err));
    }
  }, [api, abandonTurn, reportOperationError]);

  const send = useCallback(
    async (text: string, opts?: SideChatSendOptions) => {
      const trimmed = text.trim();
      if (!viewMountedRef.current || !api.sideChat) return;
      if (!trimmed && !(opts?.attachments && opts.attachments.length > 0)) return;
      if (isStreamingRef.current && opts?.inputOrigin === "queue-auto" && pendingSendRef.current !== null) {
        // Let the earlier invoke settle before snapshotting it for a queued
        // replacement. Its refusal must not be lost and later restored as live.
        const pendingGeneration = sendGenerationRef.current;
        await pendingSendRef.current.catch(() => undefined);
        if (pendingGeneration !== sendGenerationRef.current) return;
      }
      // A user gesture while a turn is running is an interrupt: stop the running
      // turn and wait for it to settle before the new one goes out, so its
      // closing frames cannot land on the new turn's transcript. The side channel
      // has no `interrupt` flag on send, so the abort is its own round trip.
      if (isStreamingRef.current && opts?.inputOrigin !== "queue-auto") {
        const aborted = abort();
        const abortGeneration = sendGenerationRef.current;
        await aborted;
        if (abortGeneration !== sendGenerationRef.current) return;
      }
      // What the stream state held before this send re-armed it. A send the
      // host REFUSES creates no turn, so the re-arm has to be undone: whatever
      // turn was streaming is still streaming there, and a guard left re-armed
      // drops the rest of its frames for good — their ids are no longer above
      // the high-water mark, so they can never be adopted again.
      const streamStateBeforeSend = {
        generation: sendGenerationRef.current,
        streaming: isStreamingRef.current,
        sendRequestId: activeSendRequestIdRef.current,
        userEntry: activeUserEntryRef.current,
        sessionChangeIntent: sessionChangeIntentRef.current,
        boundSendRequestId: boundSendRequestIdRef.current,
        activeStreamId: activeStreamIdRef.current,
        activeStreamSessionId: activeStreamSessionIdRef.current,
        terminalStreamClosed: terminalStreamClosedRef.current,
        stream: streamRef.current,
        thought: thoughtRef.current,
        finalAssistantRoundClosed: finalAssistantRoundClosedRef.current,
      };
      // Re-arm the stale-frame guard + clear accumulators: the next turn's
      // matching prelude adopts its streamId (see activeStreamIdRef doc).
      resetStreamState();
      const sendGeneration = sendGenerationRef.current;
      const sendRequestId = crypto.randomUUID();
      activeSendRequestIdRef.current = sendRequestId;
      const userEntry: ChatEntry = {
        kind: "user",
        text: trimmed,
        createdAt: Date.now(),
        ...(opts?.injectHint ? { injectHint: opts.injectHint } : {}),
      };
      activeUserEntryRef.current = userEntry;
      setEntries((prev) => [...prev, userEntry]);
      setStreaming(true);
      // The main-window webContents receives the stream frames; the invoke
      // resolves with the final TurnResult (unused here — the transcript is built
      // from the stream). A rejected/failed result surfaces as an error entry so
      // the transcript never hangs on a permanent spinner.
      let pendingSend: ReturnType<NonNullable<AveApi["sideChat"]>["send"]> | null = null;
      try {
        pendingSend = api.sideChat.send(trimmed, opts?.attachments, opts?.originSessionId, sendRequestId, opts?.surface);
        pendingSendRef.current = pendingSend;
        const result = await pendingSend;
        if (sendGeneration !== sendGenerationRef.current) return;
        if (!result.ok) {
          // Execution failures also return this shape. A matching prelude proves
          // this request started a turn, so its failure cannot revive the prior one.
          if (activeStreamIdRef.current !== null && terminalStreamClosedRef.current) return;
          // Localized, not the raw code: this hook used to put the kebab-case string
          // straight in the transcript, so a Korean user tripping a bound read
          // `too-many-resource-attachments`. Main chat already resolves codes through
          // the same map; side chat is the same transcript to the person reading it.
          const thought = thoughtRef.current;
          const refusalMessage = formatIpcError(result.error, undefined);
          setEntries((p) =>
            setAssistantError(
              p,
              refusalMessage,
              thought,
              "stream-error",
            ),
          );
          if (activeStreamIdRef.current !== null) {
            terminalStreamClosedRef.current = true;
            setStreaming(false);
            resetStreamAccumulators();
            return;
          }
          setStreaming(streamStateBeforeSend.streaming);
          // No matching prelude was accepted; restore the unstarted replacement.
          sendGenerationRef.current = streamStateBeforeSend.generation;
          activeSendRequestIdRef.current = streamStateBeforeSend.sendRequestId;
          activeUserEntryRef.current = streamStateBeforeSend.userEntry;
          sessionChangeIntentRef.current = streamStateBeforeSend.sessionChangeIntent;
          boundSendRequestIdRef.current = streamStateBeforeSend.boundSendRequestId;
          activeStreamIdRef.current = streamStateBeforeSend.activeStreamId;
          activeStreamSessionIdRef.current = streamStateBeforeSend.activeStreamSessionId;
          terminalStreamClosedRef.current = streamStateBeforeSend.terminalStreamClosed;
          streamRef.current = streamStateBeforeSend.stream;
          thoughtRef.current = streamStateBeforeSend.thought;
          finalAssistantRoundClosedRef.current = streamStateBeforeSend.finalAssistantRoundClosed;
          if (streamStateBeforeSend.sessionChangeIntent !== null) {
            const sessionIntent = restoreSessionIntent(streamStateBeforeSend.sessionChangeIntent);
            (sessionIntent.refusedSends ??= []).push({ userEntry, message: refusalMessage });
            const applied = sessionIntent.applyResult?.();
            if (applied?.historyReplaced && sessionIntent.refusalMessage) {
              reportOperationError(sessionIntent.generation, sessionIntent.refusalMessage);
            }
          }
        }
      } catch (err) {
        if (sendGeneration !== sendGenerationRef.current) return;
        // An owned terminal frame has already supplied the execution's outcome.
        if (activeStreamIdRef.current !== null && terminalStreamClosedRef.current) return;
        // Left raw on purpose: this branch is a transport failure, not a handler code
        // (the handler returns `{ ok: false, error }` above for those), so there is
        // nothing to look up and the message is the only diagnostic.
        const thought = thoughtRef.current;
        setEntries((p) =>
          setAssistantError(
            p,
            errorMessage(err),
            thought,
            "stream-error",
          ),
        );
        setStreaming(false);
        // Delivery is uncertain. Abandon this request so delayed frames cannot
        // revive it as another turn after the transport failure.
        resetStreamState();
      } finally {
        if (pendingSendRef.current === pendingSend) pendingSendRef.current = null;
      }
    },
    [api, abort, reportOperationError, resetStreamAccumulators, resetStreamState, restoreSessionIntent, setStreaming],
  );

  const changeSession = useCallback(async (invoke: () => Promise<SessionChangeResult>, clearHistory: boolean) => {
    const previous = sessionChangeIntentRef.current;
    const { generation } = abandonTurn();
    const intent: SessionChangeIntent = {
      generation,
      previous,
      state: "pending",
      applied: false,
    };
    sessionChangeIntentRef.current = intent;
    if (clearHistory) setEntries([]);
    try {
      const res = await invoke();
      intent.state = res.ok ? "accepted" : "refused";
      if (res.ok) {
        intent.applyResult = () => {
          const historyReplaced = "messages" in res;
          if (historyReplaced) {
            const history = historyToEntries(res.messages);
            const pendingUser = activeStreamIdRef.current === null ? activeUserEntryRef.current : null;
            let next = history;
            for (const refused of intent.refusedSends ?? []) {
              next = setAssistantError([...next, refused.userEntry], refused.message, "", "stream-error");
            }
            if (pendingUser !== null && !next.includes(pendingUser)) next = [...next, pendingUser];
            setEntries(next);
          }
          recordSessionId(res.sessionId, !intent.applied);
          intent.applied = true;
          return { historyReplaced };
        };
      }
      // A pending send has not superseded this change until its prelude proves
      // acceptance. Keep the shared candidate across mixed pending intents.
      if ((generation !== sendGenerationRef.current && (!res.ok || sessionChangeIntentRef.current !== intent))
        || !viewMountedRef.current) return;
      if (res.ok) {
        const applied = intent.applyResult!();
        if (intent.refusalMessage && applied.historyReplaced) reportOperationError(generation, intent.refusalMessage);
        sessionChangeIntentRef.current = null;
      } else {
        const message = intent.refusalMessage ?? formatIpcError(res.error, undefined);
        if (intent.previous !== null) {
          // A refused replacement never changed the host session. Preserve the
          // earlier accepted change, even when its reply has already arrived.
          const restored = restoreSessionIntent(intent.previous);
          if (intent.refusedSends?.length) {
            (restored.refusedSends ??= []).push(...intent.refusedSends);
            intent.refusedSends = undefined;
          }
          restored.refusalMessage = message;
          restored.applyResult?.();
          reportOperationError(restored.generation, message);
        } else {
          sessionChangeIntentRef.current = null;
          reportOperationError(generation, message);
        }
      }
    } catch (err) {
      intent.state = "failed";
      if (sessionChangeIntentRef.current === intent) sessionChangeIntentRef.current = null;
      reportOperationError(generation, errorMessage(err));
    }
  }, [abandonTurn, recordSessionId, reportOperationError, restoreSessionIntent]);

  const newSession = useCallback(async () => {
    const sideChat = api.sideChat;
    if (!viewMountedRef.current || !sideChat) return;
    await changeSession(() => sideChat.new(), true);
  }, [api, changeSession]);

  const loadSession = useCallback(
    async (id: string) => {
      const sideChat = api.sideChat;
      if (!viewMountedRef.current || !sideChat) return;
      await changeSession(() => sideChat.load(id), false);
    },
    [api, changeSession],
  );

  // Per-turn provider-usage lookup keyed by turn-start index — same derivation
  // as ChatView so the shared TranscriptRenderer's WorkGroup step-count /
  // TurnActionBar cost badge show the SIDE loop's own token/cost totals.
  const turnSummaryByTurnStart = useMemo(() => {
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
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
        });
      }
    }
    return map;
  }, [entries]);

  return {
    entries,
    turnSummaryByTurnStart,
    isStreaming,
    sessionId,
    send,
    newSession,
    loadSession,
    abort,
    isCurrentTurnEvent,
  };
}

/**
 * Does this frame belong to the turn currently on screen? Adopting is part of
 * the answer: the main process allocates side-chat stream ids monotonically and
 * the renderer cannot know a turn's id at `send` time (the invoke resolves only
 * when the turn ENDS), so its matching user prelude establishes it.
 */
function judgeStreamFrame(
  event: ChatStreamEvent,
  activeStreamId: { current: number | null },
  maxStreamId: { current: number },
): boolean {
  const streamId = typeof event.streamId === "number" ? event.streamId : null;
  if (streamId === null) return false;
  if (activeStreamId.current === null) {
    // Between turns: adopt this frame's streamId ONLY if it is newer than any
    // id we have already seen. A lower/equal id is a straggler from a finished
    // turn and is dropped (never adopted as the "new" turn).
    if (streamId <= maxStreamId.current) return false;
    activeStreamId.current = streamId;
    maxStreamId.current = streamId;
    return true;
  }
  // A frame from a superseded turn (aborted / replaced) is dropped.
  return streamId === activeStreamId.current;
}

function visibleText(text: string): string {
  return text.trim().length > 0 ? text : "";
}

// Drop a trailing still-streaming assistant entry on abort so it doesn't hang
// with a spinner (finalizeStreamingReasoning/Assistant then settle any thought).
function dropPendingStreamingAssistant(entries: ChatEntry[]): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (last && last.kind === "assistant" && last.streaming === true && last.text.length === 0) {
    return entries.slice(0, -1);
  }
  return entries;
}
