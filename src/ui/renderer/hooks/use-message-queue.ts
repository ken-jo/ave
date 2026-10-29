import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MessageQueueStore,
  formatQueueInject,
  type MessageQueueItem,
} from "../state/message-queue-store.js";
import type { Attachment } from "../types/attachments.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import { blockingSurfaceCovers } from "../components/permissions/ApprovalDock.js";
import type { ChatStreamEvent } from "../../../lib/chat-stream-state.js";
import { captureComposerKeyboardIntent, type ComposerHandle, type ComposerSurface } from "../components/Composer.js";
import { errorMessage } from "../../../shared/error-message.js";
import { augmentFileReferenceMarkers } from "../utils/compose.js";

/**
 * Mid-turn guidance: the brake-point hand-off (`tool_end` → engine round
 * boundary) and the ⌘K shortcut. Only a loop that exposes a guide channel can
 * offer it; a surface without one drains its queue at the end of the turn
 * instead, and the shortcut is not registered.
 */
interface MessageQueueGuide {
  /** `intent` is present only for a guide the user just typed (⌘K); a queue flush at a round boundary has none, so main treats it as
   * another principal's text, as a queued send is `queue-auto` rather than the keyboard. */
  inject: (text: string, intent?: UserKeyboardIntentSnapshot) => Promise<{ ok: true } | { ok: false; error: string }>;
  onError: (message: string) => void;
}

/** Where the dev/e2e seam publishes each surface's live store. One key per surface: the side chat mounting must not shadow
 * the main store a Playwright spec is asserting against. */
const DEV_STORE_KEY: Record<ComposerSurface, "__ave_message_queue_store__" | "__ave_side_chat_message_queue_store__"> = {
  main: "__ave_message_queue_store__",
  side: "__ave_side_chat_message_queue_store__",
};

export interface UseMessageQueueParams {
  /** Which composer this queue belongs to — selects the dev/e2e store seam. */
  surface: ComposerSurface;
  /**
   * The stream this queue drains against: the group's `onChatStream` for a
   * main tile, `sideChat.onStream` for the side chat. The two are isolated by
   * wire channel, so a queue subscribed to the wrong one would drain on the
   * other surface's `done`.
   */
  subscribeStream: (handler: (event: ChatStreamEvent) => void) => () => void;
  /** Use the surface's stale-frame verdict before draining; a late aborted-turn done must not send queue-auto over its
   * replacement turn. */
  isCurrentTurnEvent?: (event: ChatStreamEvent) => boolean;
  /**
   * The composer whose textarea the window-level shortcuts (⌘⏎, Esc) act on.
   * Several composers are mounted at once — one per tile, plus the side chat
   * — and every one of them carries the same test id, so ownership is decided
   * by element identity, not by attribute.
   */
  composerRef: RefObject<ComposerHandle | null>;
  currentSessionId: string;
  question: string;
  attachments: Attachment[];
  streaming: boolean;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onAsk: (
    q: string,
    intent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => void | Promise<void>;
  guide?: MessageQueueGuide;
  onAbort: () => void | Promise<void>;
  /**
   * First refusal on composer submissions. Returns true when it has consumed
   * the text, in which case the composer clears and nothing is queued or sent.
   * `/allow` uses it to answer a pending approval instead of talking to the
   * model — see {@link ./use-approval-sentence.js}. Both submit gestures route
   * through it, so ⌘⏎ cannot slip past what Enter honours.
   */
  interceptSubmit?: (text: string) => boolean;
}

export interface UseMessageQueueResult {
  messageQueueStore: MessageQueueStore;
  handleComposerSend: (intent: UserKeyboardIntentSnapshot) => void;
  handleMessageQueueSendNow: (item: MessageQueueItem) => void;
  flushQueueAsUserMessage: () => void;
}

/** Share queue behavior across composer surfaces; only stream ownership and guide-channel availability differ. */
export function useMessageQueue({
  surface,
  subscribeStream,
  composerRef,
  currentSessionId,
  question,
  attachments,
  streaming,
  setQuestion,
  setAttachments,
  onAsk,
  guide,
  onAbort,
  interceptSubmit,
  isCurrentTurnEvent,
}: UseMessageQueueParams): UseMessageQueueResult {
  const { t } = useTranslation();

  const messageQueueStore = useMemo(() => new MessageQueueStore(), []);

  const queueAutoInflightRef = useRef(false);
  /** A guide hand-off is awaiting its result — do not send the same items again. */
  const guideFlushInflightRef = useRef<{ id: string; text: string; disposition?: "dropped" | "delivered" } | null>(null);
  /** The engine refused this turn's hand-off — stop retrying until the turn ends. */
  const guideFlushBlockedRef = useRef(false);
  const turnEpochRef = useRef(0);
  const completedTurnEpochRef = useRef<number | null>(null);
  const previousStreamingRef = useRef(streaming);

  const startQueueTurn = useCallback(() => {
    turnEpochRef.current += 1;
    completedTurnEpochRef.current = null;
    guideFlushBlockedRef.current = false;
  }, []);

  useEffect(() => {
    if (streaming && !previousStreamingRef.current) startQueueTurn();
    previousStreamingRef.current = streaming;
  }, [streaming, startQueueTurn]);

  // dev/e2e runtime test hook — Playwright launches production-built renderer assets, so this must use preload runtime env
  // instead of build-time NODE_ENV.
  useEffect(() => {
    const key = DEV_STORE_KEY[surface];
    const w = window as unknown as Partial<Record<typeof key, MessageQueueStore>> & {
      ave?: { env?: { isDev?: boolean; isE2E?: boolean } };
    };
    if (w.ave?.env?.isDev === true && w.ave?.env?.isE2E === true) {
      w[key] = messageQueueStore;
    }
    return () => {
      if (w[key] === messageQueueStore) {
        delete w[key];
      }
    };
  }, [messageQueueStore, surface]);

  /** True when the keyboard event was raised inside THIS composer's textarea. */
  const ownsTarget = useCallback(
    (target: EventTarget | null): boolean => {
      const textarea = composerRef.current?.textarea();
      return textarea !== null && textarea !== undefined && target === textarea;
    },
    [composerRef],
  );
  useEffect(() => {
    messageQueueStore.clear();
    // The guide-flush refs are turn-scoped, and `done` is what normally clears
    // them. Switching sessions mid-turn means that `done` never arrives for
    // this hook, so a refusal from the old session would keep suppressing
    // brake-point hand-offs in the new one. Reset them with the queue.
    guideFlushInflightRef.current = null;
    startQueueTurn();
  }, [currentSessionId, messageQueueStore, startQueueTurn]);

  const drainPendingQueue = useCallback(({ deferSend = true }: { deferSend?: boolean } = {}) => {
    if (queueAutoInflightRef.current) return;
    const taken = messageQueueStore.takeAll();
    if (taken.length === 0) return;
    queueAutoInflightRef.current = true;
    const formatted = formatQueueInject(taken);
    const send = async () => {
      try {
        startQueueTurn();
        await onAsk(formatted, undefined, { injectHint: "queue", inputOrigin: "queue-auto" });
      } finally {
        queueAutoInflightRef.current = false;
      }
    };
    // Let every subscriber judge done before the next turn starts; rows and the reentrancy guard are claimed synchronously.
    if (deferSend) queueMicrotask(() => { void send(); });
    else void send();
  }, [messageQueueStore, onAsk, startQueueTurn]);

  /** Keep rows until guide acceptance; serialize flushes and stop retrying refusals until turn end, when queued text can
   * drain as a fresh turn. */
  const flushQueueViaGuide = useCallback(() => {
    if (!guide) return;
    if (guideFlushInflightRef.current || guideFlushBlockedRef.current) return;
    const reservation = messageQueueStore.reservePending();
    if (!reservation) return;
    const count = reservation.items.length;
    const formatted = formatQueueInject(reservation.items);
    const turnEpoch = turnEpochRef.current;
    const handoff = { id: reservation.id, text: formatted, disposition: undefined as "dropped" | "delivered" | undefined };
    guideFlushInflightRef.current = handoff;
    void (async () => {
      let accepted = false;
      const reportFailure = (reason: string) => {
        if (turnEpochRef.current !== turnEpoch) return;
        const reasonLabel =
          reason === "queue-full" ? t("chatView.queueFlushFailReasonFull") :
          reason === "too-long" ? t("chatView.queueFlushFailReasonTooLong") :
          reason === "no-active-turn" ? t("chatView.queueFlushFailReasonNoTurn") :
          `(${reason})`;
        guideFlushBlockedRef.current = completedTurnEpochRef.current !== turnEpoch;
        guide.onError(t("chatView.queueFlushFailMessage", { count, reasonLabel }));
        console.warn(`[message-queue] guide flush refused (${reason}), items kept:`, formatted.slice(0, 80));
      };
      try {
        const result = await guide.inject(formatted);
        if (guideFlushInflightRef.current !== handoff) return;
        if (handoff.disposition === "delivered" || result?.ok === true) {
          if (handoff.disposition === "dropped") return;
          accepted = true;
          messageQueueStore.settleReservation(reservation.id, formatted);
          return;
        }
        reportFailure(result?.error ?? "unknown");
      } catch {
        if (handoff.disposition === "delivered") accepted = true;
        else if (guideFlushInflightRef.current === handoff) reportFailure("unknown");
      } finally {
        messageQueueStore.settleReservation(reservation.id);
        if (guideFlushInflightRef.current === handoff) {
          guideFlushInflightRef.current = null;
          if (!accepted && completedTurnEpochRef.current === turnEpoch) {
            // A done frame may have arrived while these rows were reserved. Retry its drain only if no newer turn owns the surface.
            queueMicrotask(() => {
              if (turnEpochRef.current === turnEpoch && completedTurnEpochRef.current === turnEpoch) {
                drainPendingQueue({ deferSend: false });
              }
            });
          }
        }
      }
    })();
  }, [messageQueueStore, guide, t, drainPendingQueue]);

  useEffect(() => {
    const unsub = subscribeStream((ev) => {
      // A frame from a superseded turn drives nothing here: not the brake-point hand-off, not the delivery bookkeeping, and
      // above all not the end-of-turn drain.
      if (isCurrentTurnEvent && !isCurrentTurnEvent(ev)) return;
      if (ev.type === "user_message") {
        startQueueTurn();
        return;
      }
      if (ev.type === "tool_end") {
        // mid-turn brake-point — 엔진 round boundary 에 합류 (onGuide).
        flushQueueViaGuide();
        return;
      }
      if (ev.type === "guidance_injected") {
        // Delivered. The text is a user bubble in the transcript now, so the row has somewhere to have gone — this is the only
        // place it is cleared after a hand-off.
        const text = typeof ev.text === "string" ? ev.text : "";
        if (text.length > 0) {
          const handoff = guideFlushInflightRef.current;
          if (handoff && text.includes(handoff.text)) {
            handoff.disposition = "delivered";
            messageQueueStore.settleReservation(handoff.id, handoff.text);
          }
          messageQueueStore.clearDelivered(text);
        }
        return;
      }
      if (ev.type === "guidance_dropped") {
        // The engine took it but could not deliver it. The rows are the user's again so the end-of-turn drain below picks them up
        // — the `done` that follows this event does exactly that.
        const handoff = guideFlushInflightRef.current;
        if (handoff && (!ev.text || ev.text.includes(handoff.text))) handoff.disposition = "dropped";
        messageQueueStore.releaseHandedOff();
        return;
      }
      if (ev.type === "error") {
        // A turn that ends in an error has still ended, and `done` does not always follow. Release the block here too, or one
        // refused hand-off would keep suppressing brake points for every turn after it.
        guideFlushBlockedRef.current = false;
        return;
      }
      if (ev.type === "done") {
        completedTurnEpochRef.current = turnEpochRef.current;
        // A refusal only blocks the rest of THAT turn; the next one starts clean and may use its brake points again.
        guideFlushBlockedRef.current = false;
        // turn 종료 시 큐 잔존 항목 → 새 user message 로 자동 inject.
        // inputOrigin "queue-auto" 사용 — chat.ts validator 가 userActivation
        // 검사 우회 (IPC stream context = user gesture 밖).
        // re-entrancy guard (critic Round 2 M4): inflight inject 중 재 done
        // event 무시 — rapid done sequence 시 cascade race 방지.
        drainPendingQueue();
      }
    });
    return unsub;
  }, [subscribeStream, flushQueueViaGuide, messageQueueStore, drainPendingQueue, startQueueTurn, isCurrentTurnEvent]);

  // Do not drain on transient streaming=false; use real brake points or explicit user injection. An empty queue leaves
  // Escape as abort only.
  const flushQueueAsUserMessage = useCallback(() => {
    const taken = messageQueueStore.takeAll();
    if (taken.length === 0) {
      void onAbort();
      return;
    }
    const formatted = formatQueueInject(taken);
    // ESC / esc 취소 = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint.
    startQueueTurn();
    void onAsk(formatted, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAbort, onAsk, startQueueTurn]);

  // composer Enter morph — busy = queue.add, idle = onAsk 직행. ⌘⏎ = 즉시 주입 (LLM abort + 큐 selected + 현재 입력).
  const handleComposerSend = useCallback(
    (intent: UserKeyboardIntentSnapshot) => {
      const text = question;
      if (text.trim().length === 0 && attachments.length === 0) return;
      if (interceptSubmit?.(text)) {
        setQuestion("");
        return;
      }
      if (streaming) {
        // Busy: 큐에 추가. cap 초과 throw catch 해서 textarea 보존.
        if (text.trim().length > 0) {
          try {
            messageQueueStore.add(augmentFileReferenceMarkers(text, attachments));
          } catch (err) {
            console.warn("[message-queue] add rejected:", errorMessage(err));
            return;
          }
        }
        // 첨부도 같이 비움 — busy 분기에서 첨부 잔존하면 다음 idle 입력 시 의도치 않게 따라감 (mental model 위배). 큐 schema 가 첨부 비포함이라 busy 시 첨부는 명시적으로 사용자가 재선택하는
        // 것이 명확.
        setQuestion("");
        if (attachments.length > 0) setAttachments([]);
      } else {
        // Idle: 직행 전송
        startQueueTurn();
        void onAsk(text, intent);
      }
    },
    [
      question, attachments, streaming, messageQueueStore, onAsk,
      setQuestion, setAttachments, interceptSubmit, startQueueTurn,
    ],
  );

  const handleImmediateInject = useCallback(() => {
    const text = question.trim();
    if (interceptSubmit?.(text)) {
      setQuestion("");
      return;
    }
    const taken = messageQueueStore.takeSelected();
    const parts: string[] = [];
    if (taken.length > 0) parts.push(formatQueueInject(taken));
    if (text.length > 0) parts.push(text);
    if (parts.length === 0) return;
    const combined = parts.join("\n");
    setQuestion("");
    // ⌘⏎ = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint. handleAsk 가 streaming 시 자체 abort 처리.
    startQueueTurn();
    void onAsk(combined, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [question, messageQueueStore, onAsk, setQuestion, interceptSubmit, startQueueTurn]);

  const handleMessageQueueSendNow = useCallback((item: MessageQueueItem) => {
    const taken = messageQueueStore.takeOne(item.id);
    if (!taken) return;
    const text = formatQueueInject([taken]);
    startQueueTurn();
    void onAsk(text, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAsk, startQueueTurn]);

  // ESC 우선순위
  //   1. 모달 (Radix Dialog [data-state="open"]) → 모달이 가로챔 (defensive)
  //   2. 큐 선택 항목 있음 → 선택 해제만 (LLM 안 건드림)
  //   3. composer textarea 안에서 ESC → LLM 취소
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (blockingSurfaceCovers(e.target)) return;
      if (messageQueueStore.hasSelected()) {
        e.preventDefault();
        messageQueueStore.clearSelection();
        return;
      }
      if (!ownsTarget(e.target)) return;
      e.preventDefault();
      // ESC = LLM abort + the queue injected as a new user message — not a bare stop. An empty queue is a plain abort; onAsk
      // aborts for itself.
      flushQueueAsUserMessage();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, messageQueueStore, ownsTarget, flushQueueAsUserMessage]);

  // ⌘⏎ — composer textarea 에서 즉시 주입. busy 시 = 인터럽트 (LLM abort + 새
  // turn). idle 시도 동작 (큐가 있으면 큐+입력 inject, 없으면 입력만 send).
  // 사용자 mental model: "⌘⏎ = 지금 즉시 보내" — busy/idle 무관 일관 동작.
  // 가드 (streaming) 제거 — 사용자 보고 2026-05-15 (idle ⌘⏎ 가 무동작이던 회귀).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // 한국어 IME composing 가드 제거 — composing 시 첫 ⌘⏎ 가 IME commit 으로 소비되고 두 번째 ⌘⏎ 가 동작하는 회귀 (사용자 보고 2026-05-15). 미확정 음절 손실은 마이너 —
      // 사용자 의도 (인터럽트) 가 명확.
      if (blockingSurfaceCovers(e.target)) return;
      if (!ownsTarget(e.target)) return;
      e.preventDefault();
      handleImmediateInject();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleImmediateInject, ownsTarget]);

  // ⌘K = 가이드 호출. text 비어 있으면 noop. busy 와 무관 (idle 에서도 가이드 가능).
  useEffect(() => {
    if (!guide) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing) return;
      if (blockingSurfaceCovers(e.target)) return;
      const text = question.trim();
      if (text.length === 0) return;
      e.preventDefault();
      // Capture the gesture's one-shot intent now, inside the key handler, before any await.
      const intent = captureComposerKeyboardIntent();
      void (async () => {
        const result = await guide.inject(augmentFileReferenceMarkers(text, attachments), intent);
        if (result?.ok === true) {
          setQuestion("");
        } else if (result?.ok === false) {
          const message =
            result.error === "queue-full" ? t("chatView.guideErrorQueueFull") :
            result.error === "too-long" ? t("chatView.guideErrorTooLong") :
            result.error === "no-active-turn" ? t("chatView.guideErrorNoActiveTurn") :
            t("chatView.guideErrorFailed", { error: result.error });
          guide.onError(message);
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [question, attachments, guide, setQuestion, t]);

  return {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  };
}
