/**
 * Prompt-prefix cache markers, read off the bytes the adapter hands to
 * `fetch`: where the breakpoints land, that request-only text is never inside
 * the cached prefix, that the count stays within the provider's limit, that
 * no vendor receives two consecutive user messages, and that the openai slots
 * receive the conversation key instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidAmbientFetch } from "../../../../__tests__/support/network-fetch-stubs.js";
import type { LLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { VercelUnifiedProvider } from "../adapter.js";
import type { GenericMessage, StreamTurnParams } from "../../types.js";
import { appendRequestOnlyText } from "../../../turn/request-only-text.js";

const TOOLS: NonNullable<StreamTurnParams["tools"]> = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  { name: "list_files", description: "List files", inputSchema: { type: "object", properties: {} } },
];

const TURN_CONTEXT = "<turn-context>\nTime: 2026-10-15T09:30+09:00\n</turn-context>";

const USER: GenericMessage = { role: "user", content: "Open the report." };

/** Round 0 of a turn: the user's message carries the turn context inside it. */
const OPENING_ROUND: GenericMessage[] = appendRequestOnlyText([USER], [TURN_CONTEXT]);

/** Round 1: the same user message, now without request-only text, then a tool round. */
const TOOL_ROUND: GenericMessage[] = [
  USER,
  { role: "assistant", content: "", toolCalls: [{ id: "toolu_01", name: "read_file", input: {} }] },
  { role: "tool_result", toolUseId: "toolu_01", toolName: "read_file", content: "report body" },
];

async function sentBody(
  vendor: LLMVendor,
  model: string,
  overrides: Partial<StreamTurnParams> = {},
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
  const provider = new VercelUnifiedProvider(vendor, "fixture-key", baseUrl, fetchResponse);
  for await (const _event of provider.streamTurn({
    model,
    systemPrompt: "Return the result.",
    messages: TOOL_ROUND,
    tools: TOOLS,
    enableThinking: false,
    promptCacheKey: "session-fixture",
    ...overrides,
  })) {
    // Drain: the stream ends with the refusal.
  }
  expect(fetchResponse).toHaveBeenCalled();
  return JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
}

type Block = Record<string, unknown>;

function messageBlocks(body: Record<string, unknown>): Block[][] {
  return (body.messages as Array<{ content: Block[] | string }>).map((m) =>
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
  );
}

function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countBreakpoints(v), 0);
  if (value === null || typeof value !== "object") return 0;
  let n = "cache_control" in value ? 1 : 0;
  for (const v of Object.values(value)) n += countBreakpoints(v);
  return n;
}

function roles(body: Record<string, unknown>): string[] {
  return (body.messages as Array<{ role: string }>).map((m) => m.role);
}

describe("prompt-prefix cache breakpoints", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the last tool, the system block and the last conversation row on a tool round", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5");
    const tools = body.tools as Block[];
    expect(tools.map((t) => t.cache_control)).toEqual([undefined, { type: "ephemeral" }]);
    const system = body.system as Block[];
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ text: "Return the result.", cache_control: { type: "ephemeral" } });

    const blocks = messageBlocks(body).flat();
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_01" });
    expect(countBreakpoints(body)).toBe(3);
  });

  it("carries no turn context on a tool round", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5");
    expect(JSON.stringify(body.messages)).not.toContain("<turn-context>");
  });

  it("puts the turn context inside the user message, after the breakpoint", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5", { messages: OPENING_ROUND });
    expect(roles(body)).toEqual(["user"]);
    const [blocks] = messageBlocks(body) as [Block[]];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "Open the report.", cache_control: { type: "ephemeral" } });
    expect(blocks[1]).toMatchObject({ type: "text", text: TURN_CONTEXT });
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("repeats the opening round's cached prefix byte-identical on the next round", async () => {
    const opening = await sentBody("claude", "claude-haiku-4-5", { messages: OPENING_ROUND });
    const next = await sentBody("claude", "claude-haiku-4-5");
    const [openingUser] = messageBlocks(opening) as [Block[]];
    const [nextUser] = messageBlocks(next) as [Block[]];
    // The block the opening round cached is the first block of the next round,
    // unchanged; the turn context that followed it is simply absent.
    const strip = ({ cache_control: _c, ...rest }: Block) => rest;
    expect(strip(nextUser[0]!)).toEqual(strip(openingUser[0]!));
    expect(opening.system).toEqual(next.system);
    expect(opening.tools).toEqual(next.tools);
  });

  it("marks the previous round too when one round adds more blocks than the lookback", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({ id: `toolu_${String(i).padStart(2, "0")}`, name: "read_file", input: {} }));
    const body = await sentBody("claude", "claude-haiku-4-5", {
      messages: [
        USER,
        { role: "assistant", content: "", toolCalls: calls },
        ...calls.map((c) => ({ role: "tool_result" as const, toolUseId: c.id, toolName: "read_file", content: "x" })),
      ],
    });
    const blocks = messageBlocks(body).flat();
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(marked[0]).toMatchObject({ type: "text", text: "Open the report." });
    expect(marked[1]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_11" });
    expect(countBreakpoints(body)).toBe(4);
  });

  it("adds no extra breakpoint while a round stays inside the lookback", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5");
    expect(countBreakpoints(body)).toBe(3);
  });

  it("marks a plain user turn when no request-only text follows", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5", {
      messages: [{ role: "user", content: "Hello." }],
      tools: undefined,
    });
    const blocks = messageBlocks(body).flat();
    expect(blocks[blocks.length - 1]).toMatchObject({ text: "Hello.", cache_control: { type: "ephemeral" } });
    expect(body.tools).toBeUndefined();
    expect(countBreakpoints(body)).toBe(2);
  });

  it("never puts a breakpoint on a trailing assistant row with reasoning", async () => {
    const body = await sentBody("claude", "claude-sonnet-4-5", {
      enableThinking: true,
      thinkingBudgetTokens: 2_000,
      outputTokenLimit: 8_000,
      messages: [
        { role: "user", content: "Continue the analysis." },
        {
          role: "assistant",
          content: "",
          thinkingBlocks: [{ thinking: "Working through it.", signature: "sig-fixture" }],
        },
      ],
    });
    const blocks = messageBlocks(body).flat();
    expect(blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
      .some((b) => b.cache_control !== undefined)).toBe(false);
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(marked).toEqual([expect.objectContaining({ type: "text", text: "Continue the analysis." })]);
  });

  it("puts no breakpoint on an empty system prompt", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5", { systemPrompt: "", tools: undefined });
    expect(countBreakpoints(body.system ?? [])).toBe(0);
  });
});

describe("request-only text never adds a consecutive user message", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const nudgedAfterReply: GenericMessage[] = appendRequestOnlyText(
    [USER, { role: "assistant", content: "Thinking it over." }],
    ["Continue."],
  );

  it.each([
    ["claude", "claude-haiku-4-5", undefined],
    ["openai", "gpt-4o", undefined],
    ["openai-compatible", "local-model", "https://provider.invalid/v1"],
  ] as const)("%s keeps roles alternating", async (vendor, model, baseUrl) => {
    for (const messages of [OPENING_ROUND, nudgedAfterReply, appendRequestOnlyText(OPENING_ROUND, ["Continue."])]) {
      const body = await sentBody(vendor, model, { messages, tools: undefined }, baseUrl);
      const sent = roles(body).filter((r) => r !== "system" && r !== "developer");
      for (let i = 1; i < sent.length; i++) {
        expect(sent[i - 1] === "user" && sent[i] === "user").toBe(false);
      }
    }
  });
});

describe("prompt cache key", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the conversation key and no breakpoints on the openai slot", async () => {
    const body = await sentBody("openai", "gpt-4o");
    expect(body.prompt_cache_key).toBe("session-fixture");
    expect(countBreakpoints(body)).toBe(0);
  });

  it("does not send the key to an openai-compatible server", async () => {
    const body = await sentBody("openai-compatible", "local-model", {}, "https://provider.invalid/v1");
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(countBreakpoints(body)).toBe(0);
  });

  it("omits the key when the caller has none", async () => {
    const body = await sentBody("openai", "gpt-4o", { promptCacheKey: undefined });
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});
