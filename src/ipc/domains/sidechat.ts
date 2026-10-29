// Side chat owns independent loops and streams; never mutate the main conversation.
import { ipcMain } from "electron";
import { controlShellTask, listShellTasks } from "../../tools/shell-tools.js";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWebContents } from "../safe-send.js";
import { mainWindowForContents, setSideChatOwnerContents } from "../../main/app-state.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { parseActiveSurface } from "./browser.js";
import { terminalTabOwnerWindow } from "../../main/terminal/pty-manager.js";
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
import type { SideChatOperationFailure } from "../../shared/side-chat-operation.js";

import { sanitizeOutgoingTurnContent, validateUserContentParts } from "../handlers/chat.js";
import type { IpcDeps } from "../types.js";
import type { SubAgentTranscriptResult } from "../../shared/subagent-transcript.js";

const MAX_SEND_REQUEST_ID_LENGTH = 256;
const MAX_PANE_TAB_ID_LENGTH = 256;
const log = createLogger("sidechat");

export function registerSideChatHandlers(deps: IpcDeps): void {
  const { sideChatConversationLoop, paneChatLoops, auditLogger, settingsService } = deps;
  let railShellOwnerId: number | undefined;
  const shellTaskSession = (sender: WebContents, expectedSessionId: unknown): string | null => {
    if (typeof expectedSessionId !== "string" || !isValidSessionId(expectedSessionId)) return null;
    if (sideChatConversationLoop?.getSessionId() === expectedSessionId) {
      return railShellOwnerId === sender.id && !sideChatConversationLoop.isSessionTransitioning() ? expectedSessionId : null;
    }
    const held = paneChatLoops?.holding(expectedSessionId);
    const owner = mainWindowForContents(sender);
    return held && owner?.id === held.windowId && held.loop.getSessionId() === expectedSessionId && !held.loop.isSessionTransitioning()
      ? expectedSessionId : null;
  };
  ipcMain.handle(CHANNELS.sidechat.listShellTasks, (e, expectedSessionId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.listShellTasks, e); return []; }
    const sessionId = shellTaskSession(e.sender, expectedSessionId);
    return sessionId === null ? [] : listShellTasks(sessionId);
  });
  ipcMain.handle(CHANNELS.sidechat.controlShellTask, (e, expectedSessionId: unknown, action: unknown, shellId?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.controlShellTask, e); return UNAUTHORIZED_FRAME; }
    if ((action !== "background" && action !== "stop") ||
        (shellId !== undefined && (typeof shellId !== "string" || shellId.length === 0 || shellId.length > 128))) return { ok: false, error: "invalid-shell-action" };
    const sessionId = shellTaskSession(e.sender, expectedSessionId);
    if (sessionId === null) return { ok: false, error: "session-changed" };
    const result = controlShellTask(sessionId, action, shellId as string | undefined);
    auditLogger.log({ timestamp: new Date().toISOString(), sessionId, type: "info", input: JSON.stringify({ event: "shell_task_control", action, ok: result.ok }) });
    return result;
  });

  ipcMain.handle(CHANNELS.sidechat.getSubAgentTranscript, (e, payload: unknown): SubAgentTranscriptResult => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sidechat.getSubAgentTranscript, e);
      return { ok: false, error: "unauthorized-frame" };
    }
    // Resolve the origin's current session holder on every read.
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

  // Absent side-chat wiring returns stable disabled errors instead of throwing.
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
  const paneOwnershipRefusal = (sessionId: string, windowId: number): SideChatOperationFailure | undefined => {
    const holder = panes.holding(sessionId);
    if (!holder) return undefined;
    const paneTabId = holder.windowId === windowId && parseTabId(holder.tabId) !== null ? holder.tabId : undefined;
    return { ok: false, error: "session-open-in-pane", ...(paneTabId === undefined ? {} : { paneTabId }) };
  };
  const approvalOwnerWindow = (event: IpcMainInvokeEvent) => {
    const owner = mainWindowForContents(event.sender);
    return owner && !owner.isDestroyed() && !event.sender.isDestroyed()
      && owner.webContents === event.sender && event.senderFrame === event.sender.mainFrame
      ? owner : null;
  };
  const registerApprovalOwner = (loop: ConversationLoop, contents: WebContents): void => {
    updateApprovalSurface({ kind: "attach", sessionId: loop.getSessionId(), surface: contents });
  };

  // Keep turn bookkeeping per loop so pane and rail turns cannot block or cancel one another.
  interface LoopTurns {
    active: Promise<TurnResult> | null;
    sendRequestId: string | null;
    senderId: number | null;
    sessionId: string | null;
    // Reserve from send admission through session loading until turn tracking is published.
    reserved: boolean;
    restored: boolean;
    // If the agent closes its own pane, defer ending the chat until its turn finishes.
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

  // Abort and await prior work before session mutation so remaining frames cannot enter the new transcript.
  const abortTurnOf = async (loop: ConversationLoop): Promise<void> => {
    // Always signal abort; await only a tracked turn to guarantee settlement.
    loop.abortCurrentTurn();
    const active = turnsOf(loop).active;
    if (!active) return;
    try {
      await active;
    } catch {
    }
  };

  const storedPaneSession = (windowId: number, tabId: string): string | undefined => {
    const sessionId = browserTabRegistry.paneConversation(windowId, tabId);
    if (sessionId !== undefined || browserTabRegistry.isConversationSurfaceKnown(windowId, tabId)) return sessionId;
    return store?.findPaneSession(tabId);
  };

  const watchedWindows = new Set<number>();
  const watchPaneWindow = (sender: WebContents, windowId: number): void => {
    if (watchedWindows.has(sender.id)) return;
    watchedWindows.add(sender.id);
    const releaseAll = (): void => {
      watchedWindows.delete(sender.id);
      sender.removeListener("did-navigate", releaseAll);
      sender.removeListener("destroyed", releaseAll);
      for (const { tabId, loop } of panes.inWindow(windowId)) {
        updateApprovalSurface({ kind: "release", sessionId: loop.getSessionId() });
        panes.release(windowId, tabId);
      }
      browserTabRegistry.releaseWindow(windowId);
    };
    sender.on("did-navigate", releaseAll);
    sender.on("destroyed", releaseAll);
  };

  const closePaneChat = async (windowId: number, tabId: string): Promise<string | undefined> => {
    const loop = panes.get(windowId, tabId);
    const sessionId = loop && turnsOf(loop).restored ? loop.getSessionId() : storedPaneSession(windowId, tabId);
    if (loop) {
      updateApprovalSurface({ kind: "release", sessionId: loop.getSessionId() });
      panes.release(windowId, tabId);
      await abortTurnOf(loop);
    }
    browserTabRegistry.releasePaneConversation(windowId, tabId, true);
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
    const senderWindow = approvalOwnerWindow(e);
    if (!senderWindow) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
    const p = (payload ?? {}) as { input?: unknown; attachments?: unknown; originSessionId?: unknown; sendRequestId?: unknown; surface?: unknown; sessionId?: unknown };
    if (typeof p.input !== "string") {
      return { ok: false as const, error: "invalid-input" };
    }
    if (p.sessionId !== undefined && !isValidSessionId(p.sessionId)) {
      return { ok: false as const, error: "invalid-session-id" };
    }
    const surface = p.surface === undefined ? null : parseActiveSurface(p.surface);
    if (surface === undefined) return { ok: false as const, error: "invalid-surface" };
    if (surface !== null && !senderWindow) return { ok: false as const, error: "invalid-surface" };
    if (p.sendRequestId !== undefined && (
      typeof p.sendRequestId !== "string"
      || p.sendRequestId.trim().length === 0
      || p.sendRequestId.length > MAX_SEND_REQUEST_ID_LENGTH
    )) {
      return { ok: false as const, error: "invalid-input" };
    }
    const attachments = validateUserContentParts(p.attachments);
    // Attachment-only input is a valid turn, matching the shared composer.
    if (p.input.trim().length === 0 && (attachments?.length ?? 0) === 0) {
      return { ok: false as const, error: "empty-text" };
    }
    const pane = surface === null ? null : { windowId: senderWindow!.id, tabId: surface.tabId };
    if (pane === null && typeof p.sessionId === "string") {
      const refusal = paneOwnershipRefusal(p.sessionId, senderWindow.id);
      if (refusal) return refusal;
    }
    const loop = pane === null ? railLoop : panes.resolve(pane.windowId, pane.tabId);
    const turns = turnsOf(loop);
    // Refuse concurrent turns on the same loop; interleaving would corrupt one history.
    if (turns.active || turns.reserved || loop.isSessionTransitioning()) {
      return { ok: false as const, error: "streaming-active" };
    }
    // Reserve before awaiting session resolution so another send cannot race the load.
    const target = pane !== null
      ? (turns.restored ? undefined : { load: storedPaneSession(pane.windowId, pane.tabId) })
      : (p.sessionId !== undefined && p.sessionId !== loop.getSessionId() ? { load: p.sessionId as string } : undefined);
    if (target !== undefined) {
      turns.reserved = true;
      try {
        await loop.runSessionTransition("sidechat-turn-session", async (lease) => {
          if (target.load !== undefined && await loop.loadSession(target.load, lease)) return;
          if (target.load !== undefined || pane === null) await loop.newConversation("main", undefined, lease);
        });
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      } finally {
        turns.reserved = false;
      }
      // Pane closure during session loading must prevent both binding and execution.
      if (pane !== null && panes.get(pane.windowId, pane.tabId) !== loop) {
        return { ok: false as const, error: "pane-chat-ended" };
      }
      if (pane !== null) turns.restored = true;
    }
    const streamId = ++nextSideStreamId;
    // Bind the first turn's renderer ownership before tools can publish events.
    const turnSideChatSessionId = loop.getSessionId();
    // Bind pane identity before tools run; rail turns leave pane bindings unchanged.
    if (surface !== null) {
      const binding = browserTabRegistry.bindConversationSurface(turnSideChatSessionId, { windowId: senderWindow!.id, surface });
      if (!binding.ok) {
        panes.release(senderWindow!.id, surface.tabId);
        return binding;
      }
      watchPaneWindow(e.sender, senderWindow!.id);
    }
    registerApprovalOwner(loop, senderWindow.webContents);
    if (pane === null) { setSideChatOwnerContents(e.sender); railShellOwnerId = e.sender.id; }
    const streamTarget = e.sender;
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
    // Apply the main-chat DLP boundary at this send site too.
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
      // Persist row facts after the turn creates a session file; no await may split admission from active-turn tracking.
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
    // Cancel on owning-document replacement or death; a reloaded view loses the request id needed to abort.
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

  const paneTabId = (payload: unknown): string | undefined => {
    const tabId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).tabId
      : undefined;
    return typeof tabId === "string" && tabId.length <= MAX_PANE_TAB_ID_LENGTH && parseTabId(tabId) !== null ? tabId : undefined;
  };

  // Reject tabs held by another window; an unheld restored pane may still be read by its owner.
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
    const loop = panes.get(senderWindow.id, tabId);
    if (loop && turnsOf(loop).restored) {
      const messages = loop.getHistory().getMessages() as GenericMessage[];
      return { ok: true as const, sessionId: loop.getSessionId(), messages: messages.map(serializeHistoryMessage) };
    }
    const sessionId = storedPaneSession(senderWindow.id, tabId);
    if (sessionId === undefined) return { ok: true as const, sessionId: null, messages: [] };
    const messages = (store?.loadSession(sessionId) ?? []) as GenericMessage[];
    return { ok: true as const, sessionId, messages: messages.map(serializeHistoryMessage) };
  });

  ipcMain.handle(CHANNELS.sidechat.endPaneChat, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.endPaneChat, e); return UNAUTHORIZED_FRAME; }
    const tabId = paneTabId(payload);
    const reason = payload && typeof payload === "object" ? (payload as Record<string, unknown>).reason : undefined;
    const senderWindow = approvalOwnerWindow(e);
    if (!senderWindow) { auditUnauthorized(auditLogger, CHANNELS.sidechat.endPaneChat, e); return UNAUTHORIZED_FRAME; }
    if (tabId === undefined || !senderWindow) return { ok: false as const, error: "invalid-surface" };
    if (heldByAnotherWindow(senderWindow.id, tabId)) return { ok: false as const, error: "invalid-surface" };
    if (reason !== "new" && reason !== "closed") return { ok: false as const, error: "invalid-input" };
    const windowId = senderWindow.id;
    const loop = panes.get(windowId, tabId);
    if (reason === "closed") {
      if (loop && turnsOf(loop).active && browserTabRegistry.isClosedByAgent(windowId, tabId)) {
        turnsOf(loop).endAfterTurn = { windowId, tabId };
        return { ok: true as const, sessionId: loop.getSessionId() };
      }
      return { ok: true as const, sessionId: await closePaneChat(windowId, tabId) ?? null };
    }
    const previous = loop && turnsOf(loop).restored ? loop.getSessionId() : storedPaneSession(windowId, tabId);
    if (loop) {
      const turns = turnsOf(loop);
      if (turns.reserved || loop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active" };
      // Keep reset reserved across abort and new-session creation so sends cannot enter between them.
      turns.reserved = true;
      try {
        await abortTurnOf(loop);
        await loop.runSessionTransition("sidechat-pane-new", (lease) => loop.newConversation("main", undefined, lease));
        registerApprovalOwner(loop, senderWindow.webContents);
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
    const senderWindow = approvalOwnerWindow(e);
    if (!senderWindow) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
    if (railLoop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active" };
    return railLoop.runSessionTransition("sidechat-new", async (lease) => {
      await abortTurnOf(railLoop);
      await railLoop.newConversation("main", undefined, lease);
      registerApprovalOwner(railLoop, senderWindow.webContents);
      return { ok: true as const, sessionId: railLoop.getSessionId() };
    });
  });

  ipcMain.handle(CHANNELS.sidechat.load, async (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return { ok: false as const, error: "unauthorized-frame", messages: [] }; }
    const senderWindow = approvalOwnerWindow(e);
    if (!senderWindow) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return { ...UNAUTHORIZED_FRAME, messages: [] }; }
    if (!isValidSessionId(sessionId)) {
      return { ok: false as const, error: "invalid-session-id", messages: [] };
    }
    if (railLoop.isSessionTransitioning()) return { ok: false as const, error: "streaming-active", messages: [] };
    const refusal = paneOwnershipRefusal(sessionId, senderWindow.id);
    if (refusal) return { ...refusal, messages: [] };
    return railLoop.runSessionTransition("sidechat-load", async (lease) => {
      await abortTurnOf(railLoop);
      const loaded = await railLoop.loadSession(sessionId, lease);
      if (!loaded) {
        return { ok: false as const, error: "session-not-found", messages: [] };
      }
      registerApprovalOwner(railLoop, senderWindow.webContents);
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
    const paneOfLoop = loop === railLoop ? undefined : panes.holding(loop.getSessionId());
    if (turnsOf(loop).endAfterTurn !== null
      || (paneOfLoop !== undefined && browserTabRegistry.isClosedByAgent(paneOfLoop.windowId, paneOfLoop.tabId))) {
      return { ok: true as const };
    }
    await abortTurnOf(loop);
    return { ok: true as const };
  });
}

// Persist originSessionId at first turn and pane row facts host-side without exposing renderer write authority.
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
    // Row metadata failure must not fail an otherwise working turn; restored panes may start fresh.
    log.warn("side-chat row not recorded: %s", err);
  }
}
