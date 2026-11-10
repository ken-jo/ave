import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getLocale, loadLocaleMessages, setLocale } from "../../../../i18n/index.js";
import { collectRoundStream } from "../../../../engine/turn/stream-collector.js";
import type { LLMProvider } from "../../../../engine/llm/types.js";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import { serializeHistoryMessage } from "../../../../shared/chat-history.js";
import { historyToEntries } from "../../utils/history.js";
import type { AveApi } from "../../types.js";
import { useChatState } from "../use-chat-state.js";
import { useSideChat } from "../use-side-chat.js";

const initialLocale = getLocale();
afterEach(() => setLocale(initialLocale));

const RAW_FAILURE = "Model test-chat-model is unavailable (request: model-availability).";
const CASES = (["en", "ko"] as const).flatMap(locale =>
  (["main", "side"] as const).flatMap(surface =>
    (["provider", "formatted-notice"] as const).map(source => ({ locale, surface, source })),
  ),
);

function renderChat(surface: "main" | "side") {
  const mainListeners = new Set<(event: ChatStreamEvent) => void>();
  const sideListeners = new Set<(event: ChatStreamEvent) => void>();
  let sideRequestId: string | undefined;
  const api = {
    onChatStream: (listener: (event: ChatStreamEvent) => void) => {
      mainListeners.add(listener);
      return () => {
        mainListeners.delete(listener);
      };
    },
    onChatFallback: () => () => {},
    onLogEntry: () => () => {},
    onPluginInstallProgress: () => () => {},
    onPluginInstallResult: () => () => {},
    onPluginUninstallResult: () => () => {},
    sideChat: {
      send: async (_text: string, _surface: unknown, _attachments: unknown, requestId: string) => {
        sideRequestId = requestId;
        return { ok: true, result: {} };
      },
      onStream: (listener: (event: ChatStreamEvent) => void) => {
        sideListeners.add(listener);
        return () => {
          sideListeners.delete(listener);
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as AveApi;
  const hook = surface === "main"
    ? renderHook(() => useChatState(api, () => {}))
    : renderHook(() => useSideChat(api));

  return {
    hook,
    begin: async () => {
      if (surface === "side") {
        await act(async () => {
          const state = hook.result.current;
          if ("send" in state) {
            await state.send("Check the model");
          }
        });
      }
    },
    requestId: () => sideRequestId,
    emit: (event: ChatStreamEvent) => act(() => {
      for (const listener of surface === "main" ? mainListeners : sideListeners) {
        listener(event);
      }
    }),
  };
}

describe("stream error message ownership", () => {
  it.each(CASES)(
    "preserves the complete $locale $source message on $surface and history replay",
    async ({ locale, surface, source }) => {
      await loadLocaleMessages(locale);
      setLocale(locale);
      const expected = source === "provider"
        ? `${locale === "ko" ? "오류가 발생했습니다" : "An error occurred"}: ${RAW_FAILURE}`
        : `${locale === "ko" ? "오류" : "Error"}: ${RAW_FAILURE}`;
      let message = expected;

      if (source === "provider") {
        const provider: LLMProvider = {
          vendor: "openai",
          async *streamTurn() {
            yield { type: "error" as const, error: RAW_FAILURE };
          },
        };
        const collected = await collectRoundStream({
          provider,
          model: "test-chat-model",
          systemPrompt: "",
          messages: [],
          toolSchemas: [],
          llmSettings: {
            streamSmoothing: "none",
            enableThinking: false,
            thinkingBudgetTokens: 0,
          },
        });
        expect(collected.kind).toBe("stream_error");
        if (collected.kind !== "stream_error") {
          throw new Error("Provider failure was not collected");
        }
        message = collected.userMessage;
        expect(message).toBe(expected);
      }

      const restored = historyToEntries([
        serializeHistoryMessage({
          role: "assistant",
          content: message,
          meta: { systemNotice: "stream-error" },
        }, 0),
      ]);
      const { hook, begin, requestId, emit } = renderChat(surface);
      await begin();
      emit({
        type: "user_message",
        streamId: 1,
        sessionId: "error-message-session",
        text: "Check the model",
        origin: "platform-bridge",
        sendRequestId: requestId(),
      });
      emit({
        type: "error",
        streamId: 1,
        sessionId: "error-message-session",
        error: message,
        systemNotice: "stream-error",
      });

      const liveNotice = hook.result.current.entries.at(-1);
      const restoredNotice = restored.at(-1);
      expect(liveNotice).toMatchObject({
        kind: "assistant",
        text: expected,
        systemNotice: "stream-error",
        terminalError: true,
      });
      expect(restoredNotice).toMatchObject({
        kind: "assistant",
        text: expected,
        systemNotice: "stream-error",
        restored: true,
      });
      if (liveNotice?.kind !== "assistant" || restoredNotice?.kind !== "assistant") {
        throw new Error("Error notices were not rendered");
      }
      expect(liveNotice.text).toBe(restoredNotice.text);
    },
  );
});
