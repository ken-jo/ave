/**
 * The system prompt is a reusable prefix: two consecutive turns of one session
 * send it byte-for-byte identical, even though the clock moved, the input
 * changed, and the memory notes ranked against that input differ. What does
 * change per turn travels as a request-only row after the conversation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";

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
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: builder,
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return { loop, builder };
}

/** The request-only text a row carries: its trailing `requestOnlyParts` parts. */
function requestOnlyText(row: GenericMessage): string {
  const n = row.meta?.requestOnlyParts ?? 0;
  if (n === 0 || row.role !== "user" || typeof row.content === "string") return "";
  return row.content.slice(-n).map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

/** The row as the next request repeats it: request-only parts removed. */
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

    await loop.runTurn("plan the release budget", undefined, undefined, { inputOrigin: "user-keyboard" });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.requests).toHaveLength(2);
    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    expect(Buffer.from(second.systemPrompt, "utf8").equals(Buffer.from(first.systemPrompt, "utf8"))).toBe(true);
    expect(first.systemPrompt).not.toContain("Time:");
    expect(first.systemPrompt).not.toContain("note ranked for");
    // Stable host facts stay in the cached prompt; only the clock moved out.
    expect(first.systemPrompt).toContain("<environment>");
  });

  it("keeps the prompt identical when the title is set mid-session and on a staged-origin turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const { loop, builder } = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { inputOrigin: "user-keyboard" });
    builder.setSessionTitle("Release planning");
    await loop.runTurn("now draft the changelog", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("check the reminder", undefined, undefined, {
      inputOrigin: "user-keyboard",
      originSource: "overlay:test",
    });

    const [first, second, staged] = provider.requests as [StreamTurnParams, StreamTurnParams, StreamTurnParams];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(staged.systemPrompt).toBe(first.systemPrompt);
    expect(first.systemPrompt).not.toContain("Release planning");
    expect(first.systemPrompt).not.toContain("overlay-trigger-origin-guidance");
    // Both now ride in the turn context of the turn they belong to.
    expect(requestOnlyText(second.messages.at(-1)!)).toContain("Release planning");
    expect(requestOnlyText(second.messages.at(-1)!)).not.toContain("overlay-trigger-origin-guidance");
    expect(requestOnlyText(staged.messages.at(-1)!)).toContain("<overlay-trigger-origin-guidance");
    for (const request of provider.requests) expectAlternatingUserRows(request.messages);
  });

  it("carries the clock, environment and ranked notes in a trailing request-only row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:30:05Z"));
    const provider = new RecordingProvider();
    const { loop } = makeLoop(provider);

    await loop.runTurn("plan the release budget", undefined, undefined, { inputOrigin: "user-keyboard" });
    vi.setSystemTime(new Date("2026-10-15T09:41:47Z"));
    await loop.runTurn("now draft the changelog", undefined, undefined, { inputOrigin: "user-keyboard" });

    const [first, second] = provider.requests as [StreamTurnParams, StreamTurnParams];
    const firstUser = first.messages.at(-1)!;
    const secondUser = second.messages.at(-1)!;
    // The turn context is extra content inside the turn's own user message,
    // never a row of its own.
    expect(firstUser.meta?.requestOnlyParts).toBe(1);
    expect(requestOnlyText(firstUser)).toContain("Time: ");
    expect(requestOnlyText(firstUser)).toContain("note ranked for: plan the release budget");
    expect(requestOnlyText(secondUser)).toContain("note ranked for: now draft the changelog");
    // Minute precision: no seconds field before the offset.
    expect(requestOnlyText(firstUser)).toMatch(/Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} /);
    expectAlternatingUserRows(first.messages);
    expectAlternatingUserRows(second.messages);

    // The first request, without its request-only text, is an exact prefix of
    // the second: the per-turn text never entered history.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages.map(withoutRequestOnly));
    expect(loop.history.getMessages().some((m) => m.meta?.requestOnlyParts !== undefined)).toBe(false);
  });
});
