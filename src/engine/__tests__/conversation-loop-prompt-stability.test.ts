// Keep the cached prompt stable; varying turn facts belong in request-only content.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";
import { makeBasicConversationLoopDeps } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "claude" as const;
  readonly requests: StreamTurnParams[] = [];

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(input);
    yield { type: "text_delta", text: `answer ${this.requests.length}` };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function makeLoop(provider: LLMProvider): { loop: ConversationLoop; builder: SystemPromptBuilder } {
  const builder = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource({
      getAgentsMd: () => "# Project rules",
      getPromptMemoryIndex: () => "- [Release](./release.md)",
      selectRelevantMemories: (query: string) => ({
        entries: [],
        context: query.length > 0 ? `note ranked for: ${query}` : "",
        usedTokens: 0,
      }),
    }),
    toolRegistry: new ToolRegistry(),
  });
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    systemPromptBuilder: builder,
    disableSessionPersistence: true,
  }));
  (loop as { provider: LLMProvider | null }).provider = provider;
  return { loop, builder };
}

function requestOnlyText(row: GenericMessage): string {
  const n = row.meta?.requestOnlyParts ?? 0;
  if (n === 0 || row.role !== "user" || typeof row.content === "string") return "";
  return row.content.slice(-n).map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

function withoutRequestOnly(row: GenericMessage): GenericMessage {
  const n = row.meta?.requestOnlyParts ?? 0;
  if (n === 0 || row.role !== "user" || typeof row.content === "string") return row;
  const { requestOnlyParts: _n, ...meta } = row.meta!;
  const own = row.content.slice(0, -n);
  return {
    ...row,
    content: own.length === 1 && own[0]!.type === "text" ? own[0]!.text : own,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  } as GenericMessage;
}

function expectAlternatingUserRows(messages: GenericMessage[]): void {
  for (let i = 1; i < messages.length; i++) {
    expect(messages[i - 1]!.role === "user" && messages[i]!.role === "user").toBe(false);
  }
}

describe("system prompt stability across turns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends identical system prompt bytes on two consecutive turns of one session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const { loop } = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { ...userKeyboardTurn() });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { ...userKeyboardTurn() });

    expect(provider.requests).toHaveLength(2);
    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    expect(Buffer.from(second.systemPrompt, "utf8").equals(Buffer.from(first.systemPrompt, "utf8"))).toBe(true);
    expect(first.systemPrompt).not.toContain("Time:");
    expect(first.systemPrompt).not.toContain("note ranked for");
    expect(first.systemPrompt).toContain("<environment>");
  });

  it("keeps the prompt identical when the title is set mid-session and on a staged-origin turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const { loop, builder } = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { ...userKeyboardTurn() });
    builder.setSessionTitle("Release planning");
    await loop.runTurn("now draft the changelog", undefined, undefined, { ...userKeyboardTurn() });
    await loop.runTurn("check the reminder", undefined, undefined, {
      ...userKeyboardTurn(),
      originSource: "overlay:test",
    });

    const [first, second, staged] = provider.requests as [StreamTurnParams, StreamTurnParams, StreamTurnParams];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(staged.systemPrompt).toBe(first.systemPrompt);
    expect(first.systemPrompt).not.toContain("Release planning");
    expect(first.systemPrompt).not.toContain("overlay-trigger-origin-guidance");
    expect(requestOnlyText(second.messages.at(-1)!)).toContain("Release planning");
    expect(requestOnlyText(second.messages.at(-1)!)).not.toContain("overlay-trigger-origin-guidance");
    expect(requestOnlyText(staged.messages.at(-1)!)).toContain("<overlay-trigger-origin-guidance");
    for (const request of provider.requests) expectAlternatingUserRows(request.messages);
  });

  it("carries the clock, environment and ranked notes as request-only parts of the user message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const { loop } = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { ...userKeyboardTurn() });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { ...userKeyboardTurn() });

    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    const firstUser = first.messages.at(-1)!;
    const secondUser = second.messages.at(-1)!;
    // Turn context belongs inside its user message, never in a separate user row.
    expect(firstUser.meta?.requestOnlyParts).toBe(1);
    expect(requestOnlyText(firstUser)).toContain("Time: ");
    expect(requestOnlyText(firstUser)).toContain("note ranked for: plan the release budget");
    expect(requestOnlyText(secondUser)).toContain("note ranked for: now draft the changelog");
    expect(requestOnlyText(firstUser)).toMatch(/Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} /);
    expectAlternatingUserRows(first.messages);
    expectAlternatingUserRows(second.messages);

    // Request-only text must not enter persisted history or alter its reusable prefix.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages.map(withoutRequestOnly));
    expect(loop.history.getMessages().some((m) => m.meta?.requestOnlyParts !== undefined)).toBe(false);
  });
});
