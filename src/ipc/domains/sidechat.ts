/**
 * Side-chat domain IPC handlers (workspace rail) — a SECOND, independently-
 * streaming chat session that never touches the main chat's ConversationLoop.
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `ave:sidechat:send`  invoke  renderer→main → TurnResult | { ok:false, error }
 *                        payload `surface` (optional): the pane tab a pane's own
 *                        chat is bound to (`browserTabRegistry` bound conversation);
 *                        `sessionId` (optional): the side chat the sending view shows
 *   `ave:sidechat:new`   invoke  → { ok, sessionId }
 *   `ave:sidechat:load`  invoke  (sessionId) → { ok, sessionId, messages }
 *   `ave:sidechat:abort` invoke { sendRequestId } → { ok }
 *   `ave:sidechat:pane-history` invoke { tabId } → { ok, sessionId|null, messages }
 *   `ave:sidechat:end-pane-chat` invoke { tabId, reason } → { ok, sessionId|null }
 *
 * PANE CHATS: a terminal or web pane's own chat is its own conversation on
 * its own ConversationLoop (`deps.paneChatLoops`, keyed by window and tab), so
 * pane chats and the rail stream concurrently and never share a session. A
 * send that names `surface` runs on that pane's loop; one that does not runs
 * on the rail loop, in the session the sending view shows (`sessionId`). A
 * pane's conversation is written to its session metadata (`paneTabId`), so a
 * pane restored after a restart reopens on it. Reading a pane's history never
 * touches a running turn. Ending a pane chat stops only its own turn — except
 * when an agent's own `browser_tab_close` closed the pane: then the turn ends
 * normally and the pane chat ends after it.
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
import { mainWindowForContents, setSideChatOwnerContents } from "../../main/app-state.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { parseActiveSurface } from "./browser.js";
import { terminalTabOwnerWindow } from "../../main/terminal/terminal-blocks.js";
import { parseTabId } from "../../shared/tab-id.js";
import { createLogger } from "../../lib/logger.js";
import { createLegacyChatStreamEventSink } from "../../api/platform-conversation-legacy-adapter.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
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
const MAX_PANE_TAB_ID_LENGTH = 256;
const log = createLogger("sidechat");

export function registerSideChatHandlers(deps: IpcDeps): void {
  const { sideChatConversationLoop, paneChatLoops, auditLogger, getMainWindow, settingsService } = deps;

  ipcMain.handle(CHANNELS.sidechat.getSubAgentTranscript, (e, payload: unknown): SubAgentTranscriptResult => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sidechat.getSubAgentTranscript, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    // The rail loop and the pane chats' loops change sessions over time.
    // Resolve the origin's holder for each read and refuse an unavailable loop.
    const railLoop = deps.sideChatConversationLoop;
    if (!railLoop) return { ok: false, error: "side-chat-unavailable" };
    const p = (payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {}) as Record<string, unknown>;
    const originSessionId = p.originSessionId;
    if (typeof originSessionId !== "string" || !isValidSessionId(originSessionId)) {
      return { ok: false, error: "invalid-origin-session-id" };
    }
    const holder = originSessionId === railLoop.getSessionId()
      ? railLoop
      : deps.paneChatLoops?.holding(originSessionId)?.loop;
    if (!holder || holder.isSessionTransitioning() || holder.getSessionId() !== originSessionId) {
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
  if (!sideChatConversationLoop || !paneChatLoops) {
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
    ipcMain.handle(CHANNELS.sidechat.paneHistory, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.paneHistory, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    ipcMain.handle(CHANNELS.sidechat.endPaneChat, (e) => {
      if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.endPaneChat, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    return;
  }

  const railLoop = sideChatConversationLoop;
  const panes = paneChatLoops;
  const store = deps.sideChatMemoryManager;

  /**
   * One loop's turn bookkeeping — the rail's and each pane chat's apart, so a
   * turn in one never blocks, cancels or relabels a turn in another. Never
   * shared with the main chat's `activeStreamTurn` either.
   */
  interface LoopTurns {
    active: Promise<TurnResult> | null;
    sendRequestId: string | null;
    senderId: number | null;
    sessionId: string | null;
    // Held from an accepted send's guard until its turn is tracked, across
    // the session load the turn may need first.
    reserved: boolean;
    // A pane loop has been put on its pane's stored conversation (or found none).
    restored: boolean;
    // The pane closed while this turn ran from the agent's own tab close:
    // end the pane chat when the turn is over.
    endAfterTurn: { windowId: number; tabId: string } | null;
  }
  const turnsByLoop = new WeakMap<ConversationLoop, LoopTurns>();
  const turnsOf = (loop: ConversationLoop): LoopTurns => {
    let turns = turnsByLoop.get(loop);
    if (!turns) {
      turns = { active: null, sendRequestId: null, senderId: null, sessionId: null, reserved: false, restored: false, endAfterTurn: null };
      turnsByLoop.set(loop, turns);
    }
    return turns;
  };
  const originWritesBySession = new Map<string, Promise<void>>();
  let nextSideStreamId = 0;

  const buildSink = (wc: WebContents | undefined): ((channel: string, payload: unknown) => void) =>
    (channel, payload) => sendToWebContents(wc, channel, payload, log);

  // Abort + await `loop`'s in-flight turn before mutating that loop (new /
  // load / end). Without this, `newConversation()` / `loadSession()` would run
  // while a prior turn is still streaming into the SAME loop, and that turn's
  // remaining frames would leak into the fresh/loaded transcript (cross-session
  // leak). Mirrors the abort handler below and the main chat.ts abort pattern.
  const abortTurnOf = async (loop: ConversationLoop): Promise<void> => {
    // Always signal the loop (idempotent when idle); await the tracked promise
    // only when a turn is actually in flight so callers see it fully settled.
    loop.abortCurrentTurn();
    const active = turnsOf(loop).active;
    if (!active) return;
    try {
      await active;
    } catch {
      // expected: interrupted turns may reject
    }
  };

  /** The stored conversation of the pane chat for `tabId`, if one is unarchived. */
  const storedPaneSession = (tabId: string): string | undefined => store?.findPaneSession(tabId);

  /** Every pane chat of a window ends when the window navigates away or closes. */
  const watchedWindows = new Set<number>();
  const watchPaneWindow = (sender: WebContents, windowId: number): void => {
    if (watchedWindows.has(sender.id)) return;
    watchedWindows.add(sender.id);
    const releaseAll = (): void => {
      watchedWindows.delete(sender.id);
      sender.removeListener("did-navigate", releaseAll);
      sender.removeListener("destroyed", releaseAll);
      for (const { tabId } of panes.inWindow(windowId)) panes.release(windowId, tabId);
      browserTabRegistry.releaseWindow(windowId);
    };
    sender.on("did-navigate", releaseAll);
    sender.on("destroyed", releaseAll);
  };

  /**
   * End the pane chat of `tabId`: drop its loop (stopping its turn), unbind
   * its tab, and keep its conversation archived.
   */
  const closePaneChat = async (windowId: number, tabId: string): Promise<string | undefined> => {
    const loop = panes.get(windowId, tabId);
    const sessionId = loop && turnsOf(loop).restored ? loop.getSessionId() : storedPaneSession(tabId);
    if (loop) {
      panes.release(windowId, tabId);
      await abortTurnOf(loop);
    }
    browserTabRegistry.releasePaneConversation(windowId, tabId);
    if (sessionId !== undefined && store?.hasSessionTranscript(sessionId)) {
      try {
        await store.updateSessionRowFields(sessionId, { archivedAt: new Date().toISOString() });
      } catch (err) {
        log.warn("pane chat not archived: %s", err);
      }
    }
    return sessionId;
  };

  ipcMain.handle(CHANNELS.sidechat.send, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
    const p = (payload ?? {}) as { input?: unknown; attachments?: unknown; originSessionId?: unknown; sendRequestId?: unknown; surface?: unknown; sessionId?: unknown };
    if (typeof p.input !== "string") {
      return { ok: false as const, error: "invalid-input" };
    }
    if (p.sessionId !== undefined && !isValidSessionId(p.sessionId)) {
      return { ok: false as const, error: "invalid-session-id" };
    }
    // A chat in a terminal or web pane's own panel names that pane's tab on
    // every turn; a chat anywhere else names none.
    const surface = p.surface === undefined ? null : parseActiveSurface(p.surface);
    if (surface === undefined) return { ok: false as const, error: "invalid-surface" };
    const senderWindow = mainWindowForContents(e.sender);
    if (surface !== null && !senderWindow) return { ok: false as const, error: "invalid-surface" };
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
    // A pane's own chat runs on that pane's loop; everything else on the rail's.
    const pane = surface === null ? null : { windowId: senderWindow!.id, tabId: surface.tabId };
    // The rail view names the side chat it shows; a pane chat holds it.
    if (pane === null && p.sessionId !== undefined && panes.holding(p.sessionId)) {
      return { ok: false as const, error: "session-open-in-pane" };
    }
    const loop = pane === null ? railLoop : panes.resolve(pane.windowId, pane.tabId);
    const turns = turnsOf(loop);
    // One turn at a time on a loop. This handler calls `runStreamedTurn`
    // directly, with no turn lease around it, so a second send arriving while a
    // turn is in flight would run a CONCURRENT turn on the same
    // ConversationLoop and the two would interleave into one history. Main chat
    // refuses the same case with `streaming-active` (its lease returns null);
    // the renderer's interrupt path aborts and awaits the turn first, so a user
    // gesture still goes through. Other loops are unaffected.
    if (turns.active || turns.reserved || loop.isSessionTransitioning()) {
      return { ok: false as const, error: "streaming-active" };
    }
    // Put the loop on the session this turn belongs to: a pane loop on its
    // pane's stored conversation the first time; the rail on the session the
    // sending view shows. Awaited, so the turn is reserved first and the guard
    // above refuses any send that arrives meanwhile.
    const target = pane !== null
      ? (turns.restored ? undefined : { load: storedPaneSession(pane.tabId) })
      : (p.sessionId !== undefined && p.sessionId !== loop.getSessionId() ? { load: p.sessionId as string } : undefined);
    if (target !== undefined) {
      turns.reserved = true;
      try {
        await loop.runSessionTransition("sidechat-turn-session", async (lease) => {
          if (target.load !== undefined && await loop.loadSession(target.load, lease)) return;
          // No stored conversation (a pane's first chat), or the view's session
          // never reached a file: a fresh one.
          if (target.load !== undefined || pane === null) await loop.newConversation("main", undefined, lease);
        });
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      } finally {
        turns.reserved = false;
      }
      // The pane chat ended (its pane closed, its window went) while the loop
      // was being put on its session: nothing is bound and no turn runs.
      if (pane !== null && panes.get(pane.windowId, pane.tabId) !== loop) {
        return { ok: false as const, error: "pane-chat-ended" };
      }
      if (pane !== null) turns.restored = true;
    }
    const streamId = ++nextSideStreamId;
    // Bind the first turn's renderer ownership before tools can publish events.
    const turnSideChatSessionId = loop.getSessionId();
    // A pane's turn binds its session to the pane before any tool can run, so
    // the pane's tab is what its tools act on. Rail turns leave bindings alone.
    if (surface !== null) {
      browserTabRegistry.bindConversationSurface(turnSideChatSessionId, { windowId: senderWindow!.id, surface });
      watchPaneWindow(e.sender, senderWindow!.id);
    }
    // A pane chat's frames go to its own window; the rail's to the main one.
    const streamTarget = pane !== null ? senderWindow!.webContents : getMainWindow()?.webContents;
    const sink: ConversationStreamEventSink = createLegacyChatStreamEventSink(
      buildSink(streamTarget),
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
      if (turns.active === turnPromise) {
        turns.active = null;
        turns.sendRequestId = null;
        turns.senderId = null;
        turns.sessionId = null;
      }
      // After the turn, never before it. The turn is what gives this side chat
      // a file, and an await between the streaming guard above and the
      // `turns.active` assignment below would open exactly the window that
      // guard exists to close.
      // Execution may finish before its row write. Serialize that session's
      // read/write so a following turn cannot replace the first recorded parent.
      const previousWrite = originWritesBySession.get(turnSideChatSessionId) ?? Promise.resolve();
      const rowWrite = previousWrite.then(() => recordSideChatRow(
        store,
        turnSideChatSessionId,
        p.originSessionId,
        pane?.tabId,
      ));
      originWritesBySession.set(turnSideChatSessionId, rowWrite);
      try {
        await rowWrite;
      } finally {
        if (originWritesBySession.get(turnSideChatSessionId) === rowWrite) originWritesBySession.delete(turnSideChatSessionId);
      }
      // The agent closed this pane's own page during the turn: the pane chat
      // ends now that the turn has.
      const ending = turns.endAfterTurn;
      if (ending !== null) {
        turns.endAfterTurn = null;
        await closePaneChat(ending.windowId, ending.tabId);
      }
    });
    turns.active = turnPromise;
    turns.sendRequestId = typeof p.sendRequestId === "string" ? p.sendRequestId : null;
    turns.senderId = e.sender.id;
    turns.sessionId = turnSideChatSessionId;
    // The window the rail's turn was typed in is the one its terminal/browser
    // tools reach; a pane chat reaches its own pane's window (`paneChatLoops`).
    if (pane === null) setSideChatOwnerContents(e.sender);
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
      if (turns.active === turnPromise) void abortTurnOf(loop);
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

  /** `{ tabId }` from a pane-chat request, or undefined when malformed or not a workspace tab id. */
  const paneTabId = (payload: unknown): string | undefined => {
    const tabId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).tabId
      : undefined;
    return typeof tabId === "string" && tabId.length <= MAX_PANE_TAB_ID_LENGTH && parseTabId(tabId) !== null ? tabId : undefined;
  };

  /**
   * True when a window other than `windowId` holds tab `tabId` now — its
   * terminal, its page, or its pane chat — so a request naming it from
   * `windowId` reaches into another window. A tab no window holds yet (a
   * restored pane before its terminal or page is back) is the sender's to
   * ask about.
   */
  const heldByAnotherWindow = (windowId: number, tabId: string): boolean => {
    const terminalOwner = terminalTabOwnerWindow(tabId);
    if (terminalOwner !== undefined && terminalOwner !== windowId) return true;
    return browserTabRegistry.windowsHoldingTab(tabId).some((holder) => holder !== windowId);
  };

  ipcMain.handle(CHANNELS.sidechat.paneHistory, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.paneHistory, e); return UNAUTHORIZED_FRAME; }
    const tabId = paneTabId(payload);
    const senderWindow = mainWindowForContents(e.sender);
    if (tabId === undefined || !senderWindow) return { ok: false as const, error: "invalid-surface" };
    if (heldByAnotherWindow(senderWindow.id, tabId)) return { ok: false as const, error: "invalid-surface" };
    // The pane's live loop once it holds the pane's conversation; before that
    // (a reopened window, a restart) the conversation the store keeps for it.
    const loop = panes.get(senderWindow.id, tabId);
    if (loop && turnsOf(loop).restored) {
      const messages = loop.getHistory().getMessages() as GenericMessage[];
      return { ok: true as const, sessionId: loop.getSessionId(), messages: messages.map(serializeHistoryMessage) };
    }
    const sessionId = storedPaneSession(tabId);
    if (sessionId === undefined) return { ok: true as const, sessionId: null, messages: [] };
    const messages = (store?.loadSession(sessionId) ?? []) as GenericMessage[];
    return { ok: true as const, sessionId, messages: messages.map(serializeHistoryMessage) };
  });

  ipcMain.handle(CHANNELS.sidechat.endPaneChat, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.endPaneChat, e); return UNAUTHORIZED_FRAME; }
    const tabId = paneTabId(payload);
    const reason = payload && typeof payload === "object" ? (payload as Record<string, unknown>).reason : undefined;
    const senderWindow = mainWindowForContents(e.sender);
    if (tabId === undefined || !senderWindow) return { ok: false as const, error: "invalid-surface" };
    if (heldByAnotherWindow(senderWindow.id, tabId)) return { ok: false as const, error: "invalid-surface" };
    if (reason !== "new" && reason !== "closed") return { ok: false as const, error: "invalid-input" };
    const windowId = senderWindow.id;
    const loop = panes.get(windowId, tabId);
    if (reason === "closed") {
      // The agent's own tab close: its turn finishes, then the chat ends.
      if (loop && turnsOf(loop).active && browserTabRegistry.isClosedByAgent(windowId, tabId)) {
        turnsOf(loop).endAfterTurn = { windowId, tabId };
        return { ok: true as const, sessionId: loop.getSessionId() };
      }
      return { ok: true as const, sessionId: await closePaneChat(windowId, tabId) ?? null };
    }
    // "new": the pane keeps its loop on a fresh conversation; the last one is
    // no longer the pane's (it stays listed, unarchived).
    const previous = loop && turnsOf(loop).restored ? loop.getSessionId() : storedPaneSession(tabId);
    if (loop) {
      const turns = turnsOf(loop);
      if (turns.reserved || loop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active" };
      // Reserved across both awaits: a send arriving once the aborted turn has
      // settled, before the fresh conversation exists, is refused instead of
      // starting a turn the session swap would run under.
      turns.reserved = true;
      try {
        await abortTurnOf(loop);
        await loop.runSessionTransition("sidechat-pane-new", (lease) => loop.newConversation("main", undefined, lease));
      } finally {
        turns.reserved = false;
      }
      turns.restored = true;
    }
    browserTabRegistry.releasePaneConversation(windowId, tabId);
    if (previous !== undefined) await recordSideChatRow(store, previous, undefined, null);
    return { ok: true as const, sessionId: previous ?? null };
  });

  ipcMain.handle(CHANNELS.sidechat.new, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
    if (railLoop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active" };
    // Abort any in-flight turn first so its remaining frames never leak into the
    // fresh session (mirrors abort handler; contrast the prior unguarded call).
    return railLoop.runSessionTransition("sidechat-new", async (lease) => {
      await abortTurnOf(railLoop);
      await railLoop.newConversation("main", undefined, lease);
      return { ok: true as const, sessionId: railLoop.getSessionId() };
    });
  });

  ipcMain.handle(CHANNELS.sidechat.load, async (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return { ok: false as const, error: "unauthorized-frame", messages: [] }; }
    if (!isValidSessionId(sessionId)) {
      return { ok: false as const, error: "invalid-session-id", messages: [] };
    }
    if (railLoop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active", messages: [] };
    // A pane chat's conversation is shown in its pane, never run in the rail too.
    if (panes.holding(sessionId)) return { ok: false as const, error: "session-open-in-pane", messages: [] };
    // Abort any in-flight turn first so its remaining frames never leak into the
    // loaded session's transcript (same concurrency hazard as `new`).
    return railLoop.runSessionTransition("sidechat-load", async (lease) => {
      await abortTurnOf(railLoop);
      const loaded = await railLoop.loadSession(sessionId, lease);
      if (!loaded) {
        return { ok: false as const, error: "session-not-found", messages: [] };
      }
      const messages = railLoop.getHistory().getMessages() as GenericMessage[];
      return {
        ok: true as const,
        sessionId: railLoop.getSessionId(),
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
    // Neither another renderer nor an unaccepted or finished request owns a turn.
    const loop = [railLoop, ...panes.all()].find((candidate) => {
      const turns = turnsOf(candidate);
      return turns.sendRequestId === sendRequestId && turns.senderId === e.sender.id;
    });
    if (!loop) return { ok: true as const };
    // The pane's view went with the page the agent's own turn closed; that
    // turn finishes (the close is marked before the renderer hears of it).
    const paneOfLoop = loop === railLoop ? undefined : panes.holding(loop.getSessionId());
    if (turnsOf(loop).endAfterTurn !== null
      || (paneOfLoop !== undefined && browserTabRegistry.isClosedByAgent(paneOfLoop.windowId, paneOfLoop.tabId))) {
      return { ok: true as const };
    }
    await abortTurnOf(loop);
    return { ok: true as const };
  });
}

/**
 * Record a side chat's row facts, host-side, read-modify-write.
 *
 * `originSessionId`: which conversation a side chat belongs to — once, at its
 * first turn. The sidebar draws a side chat under its conversation, and nothing
 * else in the app knew that relation: the rail's loop is window-wide and its
 * store is isolated, so the link has to be written down when it is still
 * observable. The renderer supplies the conversation its tile was holding when
 * the turn was sent; the host validates the SHAPE and stores it under the name
 * it already has — the field a sub-agent child records its spawning parent in
 * and the one the list row carries. Existence is deliberately not checked: the
 * value is a grouping key the sidebar matches against rows it already has,
 * never a path or an authority, so its id shape is the whole guard. Written
 * once: a side chat is not re-parented by being used later beside a different
 * conversation.
 *
 * `paneTabId`: the pane whose own chat this is (a string), no longer any pane's
 * (`null`, its chat was started afresh), or unchanged (`undefined`). It is what
 * reopens a restored pane on its conversation.
 */
async function recordSideChatRow(
  sideChatMemoryManager: IpcDeps["sideChatMemoryManager"],
  sideChatSessionId: string,
  originSessionId: unknown,
  paneTabId: string | null | undefined,
): Promise<void> {
  if (!sideChatMemoryManager) return;
  const recordOrigin = isValidSessionId(originSessionId);
  if (!recordOrigin && paneTabId === undefined) return;
  try {
    const current = sideChatMemoryManager.loadSessionMetadata(sideChatSessionId);
    const next = { ...(current ?? {}) };
    let changed = false;
    if (recordOrigin && current?.originSessionId === undefined) {
      next.originSessionId = originSessionId;
      changed = true;
    }
    if (paneTabId === null && next.paneTabId !== undefined) {
      delete next.paneTabId;
      changed = true;
    } else if (typeof paneTabId === "string" && next.paneTabId !== paneTabId) {
      next.paneTabId = paneTabId;
      changed = true;
    }
    if (changed) await sideChatMemoryManager.saveSessionMetadata(sideChatSessionId, next);
  } catch (err) {
    // A side chat that cannot record its row facts is still a side chat: it
    // lists at the top level, and a restored pane starts its chat afresh.
    // Failing the turn would trade a working conversation for a sidebar detail.
    log.warn("side-chat row not recorded: %s", err);
  }
}
