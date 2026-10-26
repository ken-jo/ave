import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import { supportsVision } from "../../../engine/llm/vendor-capabilities.js";
import {
  augmentFileReferenceMarkers,
  composeImportedTriggerOutgoing,
  composeOutgoing as composeOutgoingUtil,
} from "../utils/compose.js";
import type { getApi } from "../api-client.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntentSnapshot,
} from "../../../shared/chat-origin.js";
import type { Attachment } from "../types/attachments.js";
import type { useChatState } from "./use-chat-state.js";
import type { useCurrentSession } from "./use-sessions.js";
import type { useSettings } from "./use-settings.js";
import { subscriptionImageAttachmentLimitViolation } from "../utils/subscription-runtime-ui-policy.js";
import {
  SESSION_ID_PREFIX_LOOKUP_QUERY,
  findSessionByIdPrefix,
} from "../../../shared/session-lookup.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import { errorMessage } from "../../../shared/error-message.js";
import { imageInputRecoveryMessage } from "../../../shared/model-capability-settings.js";

type Api = ReturnType<typeof getApi>;
type ChatState = ReturnType<typeof useChatState>;
type Sessions = ReturnType<typeof useCurrentSession>;
type Settings = ReturnType<typeof useSettings>;
type ComposeOutgoingFn = (raw: string) => ReturnType<typeof composeOutgoingUtil>;

/**
 * The host answers a refused send with a resolved value, not a rejection:
 * `{ ok: false, error }` from the command port, or `{ error: "streaming-active" }`
 * when the lease is taken. A resolved value the caller does not read leaves
 * the user's bubble on screen and nothing behind it.
 */
function chatSendRefusal(result: unknown): { code: string; interrupted: boolean } | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const { ok, error, interrupted } = result as { ok?: unknown; error?: unknown; interrupted?: unknown };
  if (ok === true || typeof error !== "string") return undefined;
  return { code: error, interrupted: interrupted === true };
}

class ChatSendRefusedError extends Error {
  /** `interrupted`: the host had already stopped the running turn when it refused. */
  constructor(readonly code: string, readonly interrupted: boolean) {
    super(code);
    this.name = "ChatSendRefusedError";
  }
}

export interface UseSendMessageDeps {
  api: Api;
  t: TranslateFn;
  streaming: boolean;
  checkApiKey: () => Promise<boolean>;
  composeOutgoing: ComposeOutgoingFn;
  appendUserEntry: ChatState["appendUserEntry"];
  dropUserEntry: ChatState["dropUserEntry"];
  resetStreamAccumulators: ChatState["resetStreamAccumulators"];
  beginStreamingRequest: ChatState["beginStreamingRequest"];
  finishStreamingRequest: ChatState["finishStreamingRequest"];
  markLastAssistantInterrupted?: ChatState["markLastAssistantInterrupted"];
  unmarkLastAssistantInterrupted?: ChatState["unmarkLastAssistantInterrupted"];
  appendSystemEntry: ChatState["appendSystemEntry"];
  setErrorWithThought: ChatState["setErrorWithThought"];
  handleCompactCommand: ChatState["handleCompactCommand"];
  sessionLoad: Sessions["handleLoadSession"];
  applyLoadedSession: ChatState["applyLoadedSession"];
  refreshSessionId: Sessions["refreshSessionId"];
  refreshSessions: () => void | Promise<void>;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  llmVendor: Settings["llmVendor"];
  llmModel: Settings["llmModel"];
  /** The active route's input modalities, for the image gate. Optional: without them the catalog entry for the model's name decides. */
  llmRouteModalities?: Settings["llmRouteModalities"];
  llmReadyWithoutApiKey: Settings["llmReadyWithoutApiKey"];
  /** Main's active chat model; null until the first snapshot. `kind: "none"` blocks the send and opens provider setup — the
   * composer's own call to action — rather than handing the turn to a vendor default nobody chose. */
  activeChatModel: Settings["activeChatModel"];
  /** Canonical safe status and raw-image budget for the selected runtime. */
  subscriptionRuntimePolicy: Settings["subscriptionRuntimePolicy"];
  /** False until the active runtime selection has been read from settings. */
  settingsReady?: boolean;
  onOpenSettings: (tab?: string) => void;
  setQuestion: Dispatch<SetStateAction<string>>;
  /** Tile-owned forward-ref cycle bridge. This hook WRITES it (`handleAskRef.current = handleAsk`) each render so the tile's
   * MCP-prompt path can read the latest handleAsk. Do NOT inline-break the cycle — the ref is the seam. */
  handleAskRef: MutableRefObject<HandleAskRefFn>;
}

/**
 * Send modes. `trigger-import` (plugin overlay) and `app-message` (MCP App
 * `ui/message`) are the two STAGED, non-user-authored modes: both carry a provenance
 * envelope, both skip the user bubble, and both classify as a non-`user-keyboard`
 * trust origin in main.
 */
export type SendMode = "default" | "trigger-import" | "app-message" | "mcp-prompt" | "plugin-prompt";

/**
 * The forward-ref bridge this hook writes.
 *
 * The TILE owns the ref: this hook sets `ref.current = handleAsk` each render
 * and the tile's own MCP-prompt path reads it. It surfaces the first three
 * params only — its readers never pass the 4th `opts`.
 */
export type HandleAskRefFn = (
  q: string,
  mode?: SendMode,
  userIntent?: UserKeyboardIntentSnapshot,
) => Promise<void>;

/**
 * Send mode → turn-entry origin. A TOTAL map, not a ternary chain: the previous
 * chain fell through to `"user-keyboard"`, so a new staged mode that nobody
 * remembered to branch on would have sent actor-authored text as a fully
 * trusted, user-typed turn. `Record<SendMode, …>` makes omitting a mode a
 * compile error instead.
 */
export const SEND_MODE_ORIGIN: Record<SendMode, ChatSendInputOrigin> = {
  default: "user-keyboard",
  "trigger-import": "plugin-emitted",
  "app-message": "app-emitted",
  "mcp-prompt": "mcp-prompt-emitted",
  "plugin-prompt": "plugin-prompt-emitted",
};

export interface UseSendMessageResult {
  handleAsk: (
    q: string,
    mode?: SendMode,
    userIntent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => Promise<void>;
}

/** Keep the interrupt/stale-turn guard local and refresh handleAskRef each render for routine-overlay callbacks. */
export function useSendMessage(deps: UseSendMessageDeps): UseSendMessageResult {
  const {
    api, t, streaming, checkApiKey, composeOutgoing,
    appendUserEntry, dropUserEntry, resetStreamAccumulators, beginStreamingRequest, finishStreamingRequest,
    markLastAssistantInterrupted,
    unmarkLastAssistantInterrupted,
    appendSystemEntry,
    setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions, attachments, setAttachments,
    llmVendor, llmModel, llmRouteModalities, llmReadyWithoutApiKey, activeChatModel, subscriptionRuntimePolicy,
    settingsReady = true,
    onOpenSettings, setQuestion, handleAskRef,
  } = deps;

  const turnRequestRef = useRef(0);

  const handleAsk = useCallback(
    async (
      q: string,
      mode: SendMode = "default",
      userIntent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      // Cache the preload-fixed debug flag per send and skip diagnostic payload allocation when disabled.
      const debugStreamEnabled = isDebugStreamEnabled();
      if (debugStreamEnabled) debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const trimmed = q.trim();
      if (!trimmed) {
        if (debugStreamEnabled) debugLog("handleAsk", "skip:empty");
        return;
      }
      // Do not let a fast legacy-key probe race ahead of the authoritative runtime selection. Until settings resolves we cannot
      // know whether a subscription login, rather than an API-key provider, is selected.
      if (!settingsReady) return;
      // User sends interrupt in the same chatSend IPC so keyboard intent remains valid; staged and queue-auto sends never abort
      // a running turn.
      const interrupt = (mode === "default" || mode === "mcp-prompt" || mode === "plugin-prompt")
        && streaming
        && opts?.inputOrigin !== "queue-auto";
      // Renderer only performs UX-level shortcuts for typed composer input. Main owns the authoritative trust-origin
      // classification.

      if (mode === "default" && opts?.inputOrigin !== "queue-auto") {
        if (await handleCompactCommand(trimmed)) {
          if (debugStreamEnabled) debugLog("handleAsk", "skip:compact-command-handled");
          setQuestion("");
          return;
        }
        if (trimmed === "/load" || trimmed.startsWith("/load ")) {
          const requested = trimmed.slice("/load".length).trim();
          if (requested.length === 0) {
            setErrorWithThought(t("app.loadCommandUsage"));
            return;
          }
          // Ask the widest query the IPC honours — `/load` is scoped by the id
          // the user typed, not by recency or kind. Passing no options here
          // silently inherited the handler defaults (20 rows, kind "main") and
          // disagreed with the engine dispatcher's lookup.
          const listed = await api.chatSessions({ ...SESSION_ID_PREFIX_LOOKUP_QUERY });
          const match = findSessionByIdPrefix(listed.sessions, requested);
          if (!match) {
            setErrorWithThought(t("app.sessionNotFound", { requested }));
            return;
          }
          if (!(await sessionLoad(match.id, applyLoadedSession))) {
            setErrorWithThought(t("app.sessionLoadFailed", { requested }));
            return;
          }
          await refreshSessionId();
          await refreshSessions();
          if (debugStreamEnabled) debugLog("handleAsk", "load-session:handled", { sessionId: match.id });
          return;
        }
      }
      // No connected provider means no model: the draft stays put and the user lands where a provider is added.
      if (activeChatModel?.kind === "none") {
        onOpenSettings("llm");
        return;
      }
      // Once a subscription runtime is selected its verified chat capability is the only send gate. A stored API key belongs to
      // the inactive runtime and must never make this path sendable while login/verification is pending.
      if (subscriptionRuntimePolicy.subscriptionSelected && subscriptionRuntimePolicy.chatReady !== true) {
        onOpenSettings("llm");
        return;
      }
      if (!subscriptionRuntimePolicy.subscriptionSelected && !llmReadyWithoutApiKey && !(await checkApiKey())) {
        onOpenSettings("llm");
        return;
      }
      // Preserve the draft if the selected login runtime has not explicitly
      // verified the exact attachment flow in use. Image payloads are native
      // provider input; normal files retain Ave's governed read-tool flow.
      // Missing/pending capability projections fail closed rather than relying
      // on an inactive API-key vendor setting.
      const interactiveComposerSend = mode === "default" && opts?.inputOrigin !== "queue-auto";
      const hasImageAttachment = interactiveComposerSend
        && attachments.some((attachment) => attachment.kind === "image");
      const hasFileAttachment = interactiveComposerSend
        && attachments.some((attachment) => attachment.kind === "file");
      if (
        subscriptionRuntimePolicy.subscriptionSelected
        && (
          (hasImageAttachment && subscriptionRuntimePolicy.imagesReady !== true)
          || (hasFileAttachment && subscriptionRuntimePolicy.filesReady !== true)
          || (
            hasImageAttachment
            && subscriptionImageAttachmentLimitViolation(
              subscriptionRuntimePolicy.imageAttachmentLimits,
              attachments.filter((attachment) => attachment.kind === "image"),
            ) !== null
          )
        )
      ) {
        setErrorWithThought(t("app.subscriptionAttachmentUnsupported", {
          provider: subscriptionRuntimePolicy.provider ?? "subscription",
        }));
        return;
      }
      // Refuse unsupported image sends before acquiring turn state so drafts survive; keyboard sends need the same authoritative
      // gate as the disabled button.
      if (
        hasImageAttachment
        && !subscriptionRuntimePolicy.subscriptionSelected
        && !supportsVision(llmVendor, llmModel, llmRouteModalities)
      ) {
        setErrorWithThought(`${t("app.visionNotSupported", { llmModel })} ${imageInputRecoveryMessage(t)}`);
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      if (debugStreamEnabled) debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      // Snapshot BEFORE clearing. `setQuestion("")` commits, and the composer's
      // marker-sync effect reads that empty body, finds no `[...#N]` markers, and drops
      // every attachment — so by the time an awaited send is refused there is nothing
      // left to put back. Restoring only the text would leave the draft carrying
      // `[Resource #1]` with no attachment behind it: a dangling reference that resends
      // as a marker the model cannot resolve, silently.
      const draftAttachments = attachments;
      setQuestion("");
      // Staged modes send the enveloped text VERBATIM — composeOutgoing's composer affordances (attachment markers, persona
      // prompt) belong to typed input only.
      const composed = mode === "default"
        ? composeOutgoing(trimmed)
        : composeImportedTriggerOutgoing(trimmed);
      const outgoing = composed.text;
      const displayText = interactiveComposerSend ? augmentFileReferenceMarkers(trimmed, draftAttachments) : trimmed;

      const outgoingAttachments = opts?.inputOrigin === "queue-auto" ? [] : composed.attachments;
      // Staged modes skip only the user-bubble append. The imported_trigger marker
      // already represents the plugin-authored / app-authored prompt visibly, and
      // rendering the wrapped envelope as a user bubble would misattribute authorship.
      // The interrupted turn's closing frames still arrive after this point
      // and finalize their own entry with what they accumulated; only a
      // fresh turn starts from empty accumulators.
      if (interrupt) {
        // Marked here, not at entry: every gate above returns without a send, and a turn nothing interrupted must not wear the
        // badge. And before the new bubble: the mark walks back to the running turn's answer and stops at a user line.
        if (debugStreamEnabled) debugLog("handleAsk", "interrupt:send");
        markLastAssistantInterrupted?.();
      } else {
        resetStreamAccumulators();
      }
      if (mode === "default") {
        appendUserEntry(displayText, opts?.injectHint);
      }
      try {
        const result = await api.chatSend(
          outgoing,
          outgoingAttachments,
          opts?.inputOrigin === "queue-auto" ? "queue-auto" : SEND_MODE_ORIGIN[mode],

          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? userIntent : undefined,
          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? composed.personaPromptId : undefined,
          ...(interrupt ? [{ interrupt: true }] : []),
        );
        const refusal = chatSendRefusal(result);
        if (refusal !== undefined) throw new ChatSendRefusedError(refusal.code, refusal.interrupted);
        if (debugStreamEnabled) debugLog("handleAsk", "chatSend:resolved", { requestId });
        // After successful send, clear attachments — the textarea was already cleared by setQuestion(""). N counter persists
        // across turns so re-attached items get fresh numbers.
        if (outgoingAttachments.length > 0 || attachments.length > 0) {
          setAttachments([]);
        }
      } catch (err) {
        if (debugStreamEnabled) {
          debugLog("handleAsk", "chatSend:rejected", {
            requestId,
            err: (err as Error)?.message,
          });
        }
        // Recover wrapped IPC rejection codes for localization; preserve contextual localized framing for unmapped failures.
        const rawMessage = errorMessage(err);
        const code = err instanceof ChatSendRefusedError
          ? err.code
          : rawMessage.match(/(?:^|Error:\s*)([a-z][a-z0-9-]*)\s*$/)?.[1];
        // The generic sentence for this code speaks of permission changes; for a chat send the user needs to know their message
        // did not go.
        const mappedKey = code === "user-keyboard-required"
          ? "app.sendNeedsKeyboard"
          : resolveIpcErrorKey(code);
        const message = mappedKey ? t(mappedKey) : t("app.errorGeneric", { message: rawMessage });
        // On refusal remove the optimistic bubble before adding its notice and restore the draft because main recorded no turn.
        if (mode === "default") dropUserEntry(displayText);
        if (interrupt && err instanceof ChatSendRefusedError) {
          // The running turn is not closed here with an error: refused at admission it goes on untouched, and refused after the
          // abort its own closing frame finalizes it. Only the first case takes the badge back.
          if (!err.interrupted) unmarkLastAssistantInterrupted?.();
          appendSystemEntry(message);
        } else {
          setErrorWithThought(message);
        }
        if (mode === "default") {
          // Text AND attachments, together. They are one thing: the composer derives its
          // chips from the markers in the body, so a body restored without its
          // attachments is a draft with dangling references. Restored only when the
          // composer is still empty, so a draft started during the send wins.
          if (draftAttachments.length > 0) {
            setAttachments((current) => (current.length > 0 ? current : draftAttachments));
          }
          // Restore only user-authored drafts, never staged provenance envelopes; functional updates preserve text typed while the
          // send was in flight.
          setQuestion((current) => (current.length > 0 ? current : q));
        }
      } finally {
        const turnMatch = turnRequestRef.current === requestId;
        if (debugStreamEnabled) {
          debugLog("handleAsk", "finally", {
            requestId,
            currentTurnRef: turnRequestRef.current,
            turnMatch,
            willCallFinish: turnMatch,
          });
        }
        if (turnMatch) finishStreamingRequest(streamingRequestId);
      }
    },
    [
      api,
      streaming,
      checkApiKey,
      composeOutgoing,
      appendUserEntry,
      dropUserEntry,
      resetStreamAccumulators,
      beginStreamingRequest,
      finishStreamingRequest,
      setErrorWithThought,
      unmarkLastAssistantInterrupted,
      appendSystemEntry,
      handleCompactCommand,
      sessionLoad,
      applyLoadedSession,
      refreshSessionId,
      refreshSessions,
      // attachments is read directly at the post-send cleanup branch
      // (line ~260) and is also a transitive dep via composeOutgoing,
      // but listing it explicitly avoids stale-closure surprises if
      // composeOutgoing's deps drift. llmVendor/llmModel are read by
      // the supportsVision gate.
      attachments,
      llmVendor,
      llmModel,
      llmRouteModalities,
      llmReadyWithoutApiKey,
      activeChatModel,
      subscriptionRuntimePolicy,
      settingsReady,
      onOpenSettings,
      setAttachments,
      setQuestion,
      t,
    ],
  );
  // Keep ref in sync so handlePluginPrimaryAction can call handleAsk without a forward-declaration error (ref is populated
  // before first use).
  handleAskRef.current = handleAsk;

  return { handleAsk };
}
