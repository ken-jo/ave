// Public chat actions share gesture tokens; mutating permission and policy operations remain internal.
import type { RewindMode, RewindResult } from "../shared/code-rewind.js";
import type { TurnReviewResult } from "../shared/turn-change-review.js";
import type { ShellTask, ShellTaskAction, ShellTaskActionResult } from "../shared/shell-tasks.js";
import { ipcRenderer } from "electron";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../contract/app-contract.js";
import {
  captureUserKeyboardIntent,
  consumeUserKeyboardIntent,
} from "./gesture-intent.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntentSnapshot,
} from "../shared/chat-origin.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../shared/subagent-transcript.js";
import type { SessionFamily, SessionListKindFilter, SessionListRow } from "../shared/session-lookup.js";
import type { ChatStreamEvent } from "../lib/chat-stream-state.js";
import type { AveApi } from "../ui/renderer/types.js";

/** Every per-conversation channel names its group; see docs/design/tiled-chat-groups.md. */
/** Forward only exactly matching group labels and drop unlabelled frames; broadcasting would leak one tile's conversation into others. */
function subscribeForChatGroup<T>(
  channel: string,
  chatGroupId: string,
  handler: (payload: T) => void,
): () => void {
  const listener = (_event: unknown, payload: T) => {
    const frameGroup = (payload as { chatGroupId?: unknown }).chatGroupId;
    if (frameGroup !== chatGroupId) return;
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function buildSurfaceForChatGroup(chatGroupId: string) {
  return {
  chatHasProvider: async () => ipcRenderer.invoke(CHANNELS.chat.hasProvider, chatGroupId) as Promise<boolean>,
  chatListCustomCommands: async () =>
    ipcRenderer.invoke(CHANNELS.chat.listCustomCommands, chatGroupId) as Promise<{
      commands: import("../shared/custom-command.js").CustomCommandEntry[];
    }>,
  chatGroupRelease: async () =>
    ipcRenderer.invoke(CHANNELS.chat.groupRelease, chatGroupId) as Promise<{ ok: boolean; released?: boolean; error?: string }>,
  captureUserKeyboardIntent,
  chatSend: async (
    input: string,
    attachments: unknown[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: UserKeyboardIntentSnapshot,
    personaPromptId?: string,
    options?: { interrupt?: boolean },
  ) =>
    ipcRenderer.invoke(CHANNELS.chat.send, {
      input,
      attachments,
      inputOrigin,
      ...(personaPromptId ? { personaPromptId } : {}),
      // One Enter gesture authorizes abort-and-send together; consume its intent once.
      ...(options?.interrupt === true ? { interrupt: true } : {}),
      ...(inputOrigin === "user-keyboard"
        ? { userActivation: consumeUserKeyboardIntent(userIntent) }
        : {}),
    }, chatGroupId),
  // The same one-shot keyboard intent chatSend consumes; a guide without one (a queue flush) carries none, so main treats it as another principal's.
  chatGuide: async (input: string, userIntent?: UserKeyboardIntentSnapshot) => ipcRenderer.invoke(CHANNELS.chat.guide, input, chatGroupId, {
    inputOrigin: "user-keyboard",
    userActivation: consumeUserKeyboardIntent(userIntent),
  }),
  chatNew: async (opts?: { projectRoot?: string; projectName?: string }) => ipcRenderer.invoke(CHANNELS.chat.new, opts, chatGroupId),
  chatSessions: async (opts?: { kind?: SessionListKindFilter; families?: SessionFamily[]; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) =>
    ipcRenderer.invoke(CHANNELS.chat.sessions, opts) as Promise<{
      current: string;
      sessions: SessionListRow[];
    }>,
  chatGetHistory: async () =>
    ipcRenderer.invoke(CHANNELS.chat.getHistory, chatGroupId) as Promise<{
      sessionId: string;
      sessionTitle?: string;
      sessionKind: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      projectRoot?: string;
      projectName?: string;
      projectIsDefault?: boolean;
      /** Rebuild child rows from persisted metadata because live events do not survive restart. */
      restoredSubAgents?: Array<{
        spawnId: string;
        childSessionId: string;
        title: string;
        modifiedAt: string;
        taskState?: string;
        toolUseId?: string;
      }>;
      messages: SerializedHistoryMessage[];
    }>,
  chatMainActiveState: async () =>
    ipcRenderer.invoke(CHANNELS.chat.mainActiveState) as Promise<{
      mainActiveSessionId: string | null;
      mainActiveMode: "resume" | "fresh";
      updatedAt: string;
    } | null>,
  chatSessionHistory: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionHistory, sessionId) as Promise<{
      ok: boolean;
      sessionTitle?: string;
      sessionKind?: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      routineFiredAt?: string;
      projectRoot?: string;
      projectName?: string;
      /** Rebuild child rows from persisted metadata because live events do not survive restart. */
      restoredSubAgents?: Array<{
        spawnId: string;
        childSessionId: string;
        title: string;
        modifiedAt: string;
        taskState?: string;
        toolUseId?: string;
      }>;
      messages: SerializedHistoryMessage[];
      preambleChars?: number;
    }>,
  // Replays re-run the user's own request, so each carries the click's single-use gesture intent; main refuses one without it.
  chatEditResend: async (messageId: string, newText: string, userIntent?: UserKeyboardIntentSnapshot) =>
    ipcRenderer.invoke(CHANNELS.chat.editResend, messageId, newText, chatGroupId, {
      inputOrigin: "user-keyboard",
      userActivation: consumeUserKeyboardIntent(userIntent),
    }),
  chatRewindTo: async (messageId: string, mode: RewindMode = "conversation") =>
    ipcRenderer.invoke(CHANNELS.chat.rewindTo, messageId, chatGroupId, mode) as Promise<RewindResult>,
  chatGetTurnReview: async (expectedSessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getTurnReview, expectedSessionId, chatGroupId) as Promise<TurnReviewResult>,
  chatFork: async (messageId?: string) => ipcRenderer.invoke(CHANNELS.chat.fork, messageId, chatGroupId),
  chatContinueLastUser: async (sessionId: string, userIntent?: UserKeyboardIntentSnapshot) =>
    ipcRenderer.invoke(CHANNELS.chat.continueLastUser, {
      sessionId,
      intent: { inputOrigin: "user-keyboard", userActivation: consumeUserKeyboardIntent(userIntent) },
    }, chatGroupId) as Promise<{ ok: boolean; error?: string }>,
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }, userIntent?: UserKeyboardIntentSnapshot) =>
    ipcRenderer.invoke(CHANNELS.chat.retryEffort, opts, chatGroupId, {
      inputOrigin: "user-keyboard",
      userActivation: consumeUserKeyboardIntent(userIntent),
    }),
  // An explicit session id shares another conversation; omission targets the loaded one.
  chatExport: async (format: "markdown" | "json", sessionId?: string) =>
    ipcRenderer.invoke(CHANNELS.chat.export, format, sessionId),
  chatSessionUpdate: async (payload: {
    sessionId: string;
    title?: string;
    archived?: boolean;
    unread?: boolean;
  }) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionUpdate, payload) as Promise<
      { ok: true } | { ok: false; error?: string }
    >,
  chatSessionDelete: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionDelete, { sessionId }) as Promise<
      { ok: true; wasLoaded: boolean } | { ok: false; error?: string }
    >,
  // Chat import remains internal even though export is on this surface.
  chatImport: async () =>
    ipcRenderer.invoke(CHANNELS.chat.import) as Promise<
      { ok: true; sessionId: string; messageCount: number } | { ok: false; error?: string; canceled?: boolean }
    >,
  chatCompact: async (focus?: string) => ipcRenderer.invoke(CHANNELS.chat.compact, chatGroupId, focus),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke(CHANNELS.chat.sessionResume, sessionId, chatGroupId),
  chatEnterCheckpointView: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.enterCheckpointView, { sessionId, compactNum }, chatGroupId) as Promise<
      { messageIndexAtCreation: number } | { error: string }
    >,
  chatExitCheckpointView: async () =>
    ipcRenderer.invoke(CHANNELS.chat.exitCheckpointView, chatGroupId) as Promise<{ ok: boolean }>,
  chatBranchFromCheckpoint: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.branchFromCheckpoint, { sessionId, compactNum }, chatGroupId) as Promise<
      {
        newSessionId: string;
        lastMessageRole: "user" | "assistant" | "tool_result" | null;
        shouldAutoContinue: boolean;
      } | { error: string }
    >,
  chatAbort: async () => ipcRenderer.invoke(CHANNELS.chat.abort, chatGroupId) as Promise<{ ok: boolean }>,
  chatListShellTasks: async (expectedSessionId: string) => ipcRenderer.invoke(CHANNELS.chat.listShellTasks, chatGroupId, expectedSessionId) as Promise<ShellTask[]>,
  chatControlShellTask: async (expectedSessionId: string, action: ShellTaskAction, shellId?: string) =>
    ipcRenderer.invoke(CHANNELS.chat.controlShellTask, chatGroupId, expectedSessionId, action, shellId) as Promise<ShellTaskActionResult>,
  chatGetVerbatimToolResult: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getVerbatimToolResult, { sessionId, toolUseId }, chatGroupId) as Promise<
      { content: string; lineCount: number } | null
    >,
  chatGetSubAgentTranscript: async (opts: SubAgentTranscriptRequest) =>
    ipcRenderer.invoke(CHANNELS.chat.getSubAgentTranscript, opts, chatGroupId) as Promise<SubAgentTranscriptResult>,
  // Load full write-file diffs lazily when they exceed the preview cap.
  chatGetWriteDiff: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getWriteDiff, { sessionId, toolUseId }) as Promise<
      { before: string; after: string } | null
    >,
  starredList: async () => ipcRenderer.invoke(CHANNELS.starred.list),
  starredAdd: async (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) =>
    ipcRenderer.invoke(CHANNELS.starred.add, entry),
  starredRemove: async (opts: { id?: string; sessionId?: string; messageIndex?: number }) =>
    ipcRenderer.invoke(CHANNELS.starred.remove, opts),
  onChatStream: (handler: (event: ChatStreamEvent) => void) =>
    subscribeForChatGroup<ChatStreamEvent>(CHANNELS.chat.stream, chatGroupId, handler),
  // Filter provider-fallback banners by the same group label as stream frames.
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) =>
    subscribeForChatGroup(CHANNELS.chat.fallback, chatGroupId, handler),
  listPluginCards: async () => ipcRenderer.invoke(CHANNELS.plugins.cards),
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke(CHANNELS.plugins.perfStats),
  },

  getUsageSummary: async (days?: number) => ipcRenderer.invoke(CHANNELS.usage.summary, days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke(CHANNELS.usage.range, opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke(CHANNELS.usage.exportCsv, rows),
  };
}

export function buildPublicSurface() {
  const surface = buildSurfaceForChatGroup(MAIN_CHAT_GROUP_ID);
  return {
    ...surface,
    /** Bind each tile's surface once so downstream calls cannot address another conversation. */
    chatGroup: (chatGroupId: string) => buildSurfaceForChatGroup(chatGroupId),
  } satisfies Partial<AveApi>;
}
