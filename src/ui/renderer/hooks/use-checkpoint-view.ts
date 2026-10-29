import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import { SHORT_TOAST_TTL_MS } from "../constants.js";
import type { ViewModeState } from "../components/ViewModeBanner.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { AveApi } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";

export interface UseCheckpointViewParams {
  api: AveApi;
  currentSessionId: string;
  entries: ChatEntry[];
  streaming: boolean;
  hasActiveStreamingEntry: boolean;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  onContinueFromLastUser?: (sessionId: string, opts?: { userIntent?: UserKeyboardIntentSnapshot }) => void | Promise<void>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewModeState | null>>;
  scrollChatToBottom: (behavior?: ScrollBehavior) => void;
}

export interface UseCheckpointViewResult {
  forkToast: string | null;
  handleEnterView: (compactNum: number) => Promise<void>;
  handleExitView: () => Promise<void>;
  handleBranchFrom: (compactNum: number) => Promise<void>;
}

/** Keep viewMode at ChatView for transcript slicing and scroll suppression; this hook owns navigation and fork feedback. */
export function useCheckpointView({
  api,
  currentSessionId,
  entries,
  streaming,
  hasActiveStreamingEntry,
  onLoadSession,
  onContinueFromLastUser,
  setViewMode,
  scrollChatToBottom,
}: UseCheckpointViewParams): UseCheckpointViewResult {
  const { t } = useTranslation();
  const [forkToast, setForkToast] = useState<string | null>(null);
  const forkToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup fork toast timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    };
  }, []);

  const handleEnterView = useCallback(async (compactNum: number) => {
    const result = await api.chatEnterCheckpointView?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // Engine history counts do not map 1:1 to renderer entries; cap slices safely, accepting approximate ranges in tool-heavy
    // sessions.
    const slicedRangeEnd = Math.min(result.messageIndexAtCreation, entries.length);
    setViewMode({ compactNum, slicedRangeEnd });
    scrollChatToBottom("auto");
  }, [api, currentSessionId, entries.length, scrollChatToBottom, setViewMode]);

  const handleExitView = useCallback(async () => {
    await api.chatExitCheckpointView?.();
    setViewMode(null);
    scrollChatToBottom("auto");
  }, [api, scrollChatToBottom, setViewMode]);

  const handleBranchFrom = useCallback(async (compactNum: number) => {
    // The auto-continue runs after the fork and load awaits, outside the click; it replays the user's request with the click's intent.
    const userIntent = api.captureUserKeyboardIntent();
    if (streaming || hasActiveStreamingEntry) {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
      setForkToast(t("chatView.forkBusyToast"));
      forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS);
      return;
    }
    const result = await api.chatBranchFromCheckpoint?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // Exit view-mode before loading the new session so it opens in live mode.
    setViewMode(null);
    if (!onLoadSession) return;
    const loaded = await onLoadSession(result.newSessionId);
    if (loaded === false) return;
    if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    setForkToast(
      result.shouldAutoContinue
        ? t("chatView.forkSuccessAutoContinue", { compactNum })
        : t("chatView.forkSuccess", { compactNum }),
    );
    forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS);
    if (result.shouldAutoContinue) {
      await onContinueFromLastUser?.(result.newSessionId, { userIntent });
    }
  }, [api, currentSessionId, hasActiveStreamingEntry, onContinueFromLastUser, onLoadSession, streaming, setViewMode]);

  return { forkToast, handleEnterView, handleExitView, handleBranchFrom };
}
