/**
 * Side-chat domain IPC handlers (workspace rail) — a SECOND, independently-
 * streaming chat session that never touches the main chat's ConversationLoop.
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `ave:sidechat:send`  invoke  renderer→main → TurnResult | { ok:false, error }
 *   `ave:sidechat:new`   invoke  → { ok, sessionId }
 *   `ave:sidechat:load`  invoke  (sessionId) → { ok, sessionId, messages }
 *   `ave:sidechat:abort` invoke { sendRequestId } → { ok }
 *   `ave:sidechat:stream`   event  main→renderer  { streamId, ...frame }
 *   `ave:sidechat:fallback` event  main→renderer  { from, to }
 *
 * ISOLATION (No-Fallback): this module NEVER imports or touches the main
 * `conversationLoop`. It drives `deps.sideChatConversationLoop` — a distinct
 * ConversationLoop with its own history/sessionId and an isolated MemoryManager
 * rooted at `~/.ave/side-chat/`. It owns its OWN `activeSideStreamTurn` /
 * `nextSideStreamId` module state so a main-chat abort never cancels a side turn
 * (and vice versa). It reuses the transport-agnostic `runStreamedTurn` but
 * passes the DEDICATED `CHANNELS.sidechat.*` channel pair, so the main
 * renderer's `onChatStream` subscriber never receives a side-chat frame — the
 * two streams are isolated by wire channel, not by a session discriminator on a
 * shared channel.
 *
 * TRUST BOUNDARY: side chat runs arbitrary tools like the main chat, so every
 * invoke gates on {@link validateHostRendererSender} and the channels are absent from
 * PUBLIC_CHANNELS (fail-closed `isPublicChannel`). Error contract: kebab-case
 * English `error` (project CLAUDE.md — IPC English / UI Korean).
 */
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWebContents } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import { createLegacyChatStreamEventSink } from "../../api/platform-conversation-legacy-adapter.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { TurnResult } from "../../engine/conversation-loop.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ConversationStreamEventSink,
} from "../handlers/chat-stream.js";
import { isValidSessionId } from "../../memory/memory-manager.js";

import { sanitizeOutgoingTurnContent, validateUserContentParts } from "../handlers/chat.js";
import type { IpcDeps } from "../types.js";
import type { SubAgentTranscriptResult } from "../../shared/subagent-transcript.js";

const MAX_SEND_REQUEST_ID_LENGTH = 256;
const log = createLogger("sidechat");

export function registerSideChatHandlers(deps: IpcDeps): void {
  const { sideChatConversationLoop, auditLogger, getMainWindow, settingsService } = deps;

  ipcMain.handle(CHANNELS.sidechat.getSubAgentTranscript, (e, payload: unknown): SubAgentTranscriptResult => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sidechat.getSubAgentTranscript, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    // Production reuses one side-chat loop while its active session changes.
    // Resolve that session for each read and refuse an unavailable loop.
    const currentLoop = deps.sideChatConversationLoop;
    if (!currentLoop) return { ok: false, error: "side-chat-unavailable" };
    const p = (payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {}) as Record<string, unknown>;
    const originSessionId = p.originSessionId;
    if (typeof originSessionId !== "string" || !isValidSessionId(originSessionId)) {
      return { ok: false, error: "invalid-origin-session-id" };
    }
    if (currentLoop.isSessionTransitioning() || originSessionId !== currentLoop.getSessionId()) {
      return { ok: false, error: "origin-session-not-active" };
    }
    const childSessionId = p.childSessionId;
    if (typeof childSessionId !== "string" || !isValidSessionId(childSessionId)) {
      return { ok: false, error: "invalid-child-session-id" };
    }
    const runner = deps.getSubAgentRunner?.();
    if (!runner) return { ok: false, error: "sub-agent-runner-unavailable" };
    // Only the host-written child metadata establishes ownership here; a
    // parent tool result cannot substitute for the child's persisted origin.
    if (runner.isPersistedSpawnOfOrigin(originSessionId, childSessionId) !== true) {
      return { ok: false, error: "sub-agent-reference-not-found" };
    }
    return runner.getPersistedTranscript({ originSessionId, childSessionId });
  });

  // A side-chat loop is only wired in production boot. When absent (test
  // fixtures that boot only the main loop), every handler fails closed with a
  // stable `error` so the renderer surface degrades to a disabled state rather
  // than throwing.
  if (!sideChatConversationLoop) {
    const unavailable = () => ({ ok: false as const, error: "side-chat-unavailable" });
    ipcMain.handle(CHANNELS.sidechat.send, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    ipcMain.handle(CHANNELS.sidechat.new, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    ipcMain.handle(CHANNELS.sidechat.load, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return UNAUTHORIZED_FRAME; }
      return { ok: false as const, error: "side-chat-unavailable", messages: [] };
    });
    ipcMain.handle(CHANNELS.sidechat.abort, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.abort, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    return;
  }

  const loop = sideChatConversationLoop;

  // Side-chat-OWNED stream-turn tracking — deliberately NOT shared with the main
  // chat's `activeStreamTurn`. A main abort must never cancel a side turn.
  let activeSideStreamTurn: Promise<TurnResult> | null = null;
  let activeSideSendRequestId: string | null = null;
  let activeSideSenderId: number | null = null;
  const originWritesBySession = new Map<string, Promise<void>>();
  let nextSideStreamId = 0;

  const buildSink = (wc: WebContents | undefined): ((channel: string, payload: unknown) => void) =>
    (channel, payload) => sendToWebContents(wc, channel, payload, log);

  // Abort + await any in-flight side turn before mutating the shared side loop
  // (new / load). Without this, `newConversation()` / `loadSession()` would run
  // while a prior turn is still streaming into the SAME loop, and that turn's
  // remaining frames would leak into the fresh/loaded transcript (cross-session
  // leak). Mirrors the abort handler below and the main chat.ts abort pattern.
  const abortActiveSideTurn = async (): Promise<void> => {
    // Always signal the loop (idempotent when idle); await the tracked promise
    // only when a turn is actually in flight so callers see it fully settled.
    loop.abortCurrentTurn();
    if (!activeSideStreamTurn) return;
    try {
      await activeSideStreamTurn;
    } catch {
      // expected: interrupted turns may reject
    }
  };

  ipcMain.handle(CHANNELS.sidechat.send, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
    const p = (payload ?? {}) as { input?: unknown; attachments?: unknown; originSessionId?: unknown; sendRequestId?: unknown };
    if (typeof p.input !== "string") {
      return { ok: false as const, error: "invalid-input" };
    }
    if (p.sendRequestId !== undefined && (
      typeof p.sendRequestId !== "string"
      || p.sendRequestId.trim().length === 0
      || p.sendRequestId.length > MAX_SEND_REQUEST_ID_LENGTH
    )) {
      return { ok: false as const, error: "invalid-input" };
    }
    const attachments = validateUserContentParts(p.attachments);
    // An attachment-only send is a whole turn: a screenshot with no caption is
    // the question. Main chat accepts it (`parseChatSendPayload` requires the
    // input to be a string, never a non-empty one), and the shared composer now
    // offers the same gesture on this surface, so the only send refused here is
    // one carrying NOTHING — no text and no usable content part.
    if (p.input.trim().length === 0 && (attachments?.length ?? 0) === 0) {
      return { ok: false as const, error: "empty-text" };
    }
    // One turn at a time on the side loop. This handler calls `runStreamedTurn`
    // directly, with no turn lease around it, so a second send arriving while a
    // turn is in flight would run a CONCURRENT turn on the same
    // ConversationLoop and the two would interleave into one history. Main chat
    // refuses the same case with `streaming-active` (its lease returns null);
    // the renderer's interrupt path aborts and awaits the turn first, so a user
    // gesture still goes through.
    if (activeSideStreamTurn || loop.isSessionTransitioning()) {
      return { ok: false as const, error: "streaming-active" };
    }
    const win = getMainWindow();
    const streamId = ++nextSideStreamId;
    // Bind the first turn's renderer ownership before tools can publish events.
    const turnSideChatSessionId = loop.getSessionId();
    const sink: ConversationStreamEventSink = createLegacyChatStreamEventSink(
      buildSink(win?.webContents),
      {
        streamId,
        sessionId: turnSideChatSessionId,
        ...(typeof p.sendRequestId === "string" ? { sendRequestId: p.sendRequestId } : {}),
        streamChannel: CHANNELS.sidechat.stream,
        fallbackChannel: CHANNELS.sidechat.fallback,
      },
    );
    // Side chat reaches the provider through the same loop as main chat, so it
    // needs the same DLP boundary. It did not have one: `p.input` went out raw
    // while `privacy.piiRedactEnabled` was on. Redaction lives at the send
    // sites rather than inside the loop, so a new send site is a new hole —
    // this was one.
    const sanitized = sanitizeOutgoingTurnContent(
      settingsService,
      sink,
      p.input as string,
      attachments,
    );
    const turnPromise = (async () => {
      return runStreamedTurn(
        loop,
        sanitized.input,
        sink,
        {
          ...STREAM_TURN_OPTIONS,
          ...(sanitized.attachments && sanitized.attachments.length > 0
            ? { attachments: sanitized.attachments }
            : {}),
        },
      );
    })().finally(async () => {
      if (activeSideStreamTurn === turnPromise) {
        activeSideStreamTurn = null;
        activeSideSendRequestId = null;
        activeSideSenderId = null;
      }
      // After the turn, never before it. The turn is what gives this side chat
      // a file, and an await between the streaming guard above and the
      // `activeSideStreamTurn` assignment below would open exactly the window
      // that guard exists to close.
      // Execution may finish before its origin write. Serialize that session's
      // read/write so a following turn cannot replace the first recorded parent.
      const previousOriginWrite = originWritesBySession.get(turnSideChatSessionId) ?? Promise.resolve();
      const originWrite = previousOriginWrite.then(() => recordSideChatOrigin(
        deps.sideChatMemoryManager,
        turnSideChatSessionId,
        p.originSessionId,
      ));
      originWritesBySession.set(turnSideChatSessionId, originWrite);
      try {
        await originWrite;
      } finally {
        if (originWritesBySession.get(turnSideChatSessionId) === originWrite) originWritesBySession.delete(turnSideChatSessionId);
      }
    });
    activeSideStreamTurn = turnPromise;
    activeSideSendRequestId = typeof p.sendRequestId === "string" ? p.sendRequestId : null;
    activeSideSenderId = e.sender.id;
    // A reloaded or crashed renderer loses the request id that scoped abort
    // requires, and page unload skips the hook's teardown cancel. Its document
    // was the turn's only owner, so its departure cancels the turn; otherwise
    // the reloaded view could neither stop it nor send until it finished.
    // Departure is the committed main-frame document change (`did-navigate`),
    // not `did-start-navigation`: that fires for every attempt, including a
    // link click the main window's `will-navigate` policy cancels and opens
    // externally, which leaves the owning document alive and still streaming.
    // A main-frame load that fails (a reload while index.html is unreadable)
    // commits an error page in place of the document without `did-navigate`.
    // Electron raises `did-fail-provisional-load` only for such a committed
    // error page; `did-fail-load` also fires while the document stays: for a
    // `loadURL` it refuses as invalid (-300) and for a committed document's
    // own load failing or being stopped (-354, -3).
    const owner = e.sender;
    const cancelOrphanedTurn = (): void => {
      if (activeSideStreamTurn === turnPromise) void abortActiveSideTurn();
    };
    const onOwnerLoadFailure = (_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame && errorCode !== -3 /* ERR_ABORTED */) cancelOrphanedTurn();
    };
    owner.on("did-navigate", cancelOrphanedTurn);
    owner.on("did-fail-provisional-load", onOwnerLoadFailure);
    owner.on("render-process-gone", cancelOrphanedTurn);
    owner.on("destroyed", cancelOrphanedTurn);
    try {
      const result = await turnPromise;
      return { ok: true as const, result };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    } finally {
      owner.removeListener("did-navigate", cancelOrphanedTurn);
      owner.removeListener("did-fail-provisional-load", onOwnerLoadFailure);
      owner.removeListener("render-process-gone", cancelOrphanedTurn);
      owner.removeListener("destroyed", cancelOrphanedTurn);
    }
  });

  ipcMain.handle(CHANNELS.sidechat.new, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
    if (loop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active" };
    // Abort any in-flight turn first so its remaining frames never leak into the
    // fresh session (mirrors abort handler; contrast the prior unguarded call).
    return loop.runSessionTransition("sidechat-new", async (lease) => {
      await abortActiveSideTurn();
      await loop.newConversation("main", undefined, lease);
      return { ok: true as const, sessionId: loop.getSessionId() };
    });
  });

  ipcMain.handle(CHANNELS.sidechat.load, async (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return { ok: false as const, error: "unauthorized-frame", messages: [] }; }
    if (!isValidSessionId(sessionId)) {
      return { ok: false as const, error: "invalid-session-id", messages: [] };
    }
    if (loop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active", messages: [] };
    // Abort any in-flight turn first so its remaining frames never leak into the
    // loaded session's transcript (same concurrency hazard as `new`).
    return loop.runSessionTransition("sidechat-load", async (lease) => {
      await abortActiveSideTurn();
      const loaded = await loop.loadSession(sessionId, lease);
      if (!loaded) {
        return { ok: false as const, error: "session-not-found", messages: [] };
      }
      const messages = loop.getHistory().getMessages() as GenericMessage[];
      return {
        ok: true as const,
        sessionId: loop.getSessionId(),
        messages: messages.map(serializeHistoryMessage),
      };
    });
  });

  ipcMain.handle(CHANNELS.sidechat.abort, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.abort, e); return UNAUTHORIZED_FRAME; }
    const sendRequestId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).sendRequestId
      : undefined;
    if (typeof sendRequestId !== "string" || sendRequestId.trim().length === 0 || sendRequestId.length > MAX_SEND_REQUEST_ID_LENGTH) {
      return { ok: false as const, error: "invalid-send-request-id" };
    }
    // Neither another renderer nor an unaccepted or finished request owns this turn.
    if (sendRequestId !== activeSideSendRequestId || e.sender.id !== activeSideSenderId) return { ok: true as const };
    await abortActiveSideTurn();
    return { ok: true as const };
  });
}

/**
 * Record which conversation a side chat belongs to — once, at its first turn.
 *
 * The sidebar draws a side chat under its conversation, and nothing else in the
 * app knew that relation: the rail's loop is window-wide and its store is
 * isolated, so the link has to be written down when it is still observable. The
 * renderer supplies the conversation its tile was holding when the turn was
 * sent; the host validates the SHAPE and stores it under the name it already
 * has — `originSessionId`, the field a sub-agent child records its spawning
 * parent in and the one the list row carries.
 *
 * Existence is deliberately not checked. A conversation that has not taken a
 * turn yet has no file, and a side chat started beside it belongs to it all the
 * same; the value is a grouping key the sidebar matches against rows it already
 * has, never a path or an authority, so its id shape is the whole guard.
 *
 * Written once: a side chat is not re-parented by being used later beside a
 * different conversation. The rail's New-session button is how a new one — and
 * so a new parent — begins.
 */
async function recordSideChatOrigin(
  sideChatMemoryManager: IpcDeps["sideChatMemoryManager"],
  sideChatSessionId: string,
  originSessionId: unknown,
): Promise<void> {
  if (!sideChatMemoryManager || !isValidSessionId(originSessionId)) return;
  try {
    const current = sideChatMemoryManager.loadSessionMetadata(sideChatSessionId);
    if (current?.originSessionId !== undefined) return;
    await sideChatMemoryManager.saveSessionMetadata(sideChatSessionId, {
      ...(current ?? {}),
      originSessionId,
    });
  } catch (err) {
    // A side chat that cannot record its parent is still a side chat: it lists
    // at the top level instead of under one. Failing the turn would trade a
    // working conversation for a sidebar detail.
    log.warn("side-chat origin not recorded: %s", err);
  }
}
