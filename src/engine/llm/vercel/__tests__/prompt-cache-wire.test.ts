/**
 * Prompt-prefix cache markers, read off the bytes the adapter hands to
 * `fetch`: where the breakpoints land, that the request-only tail is never
 * inside the cached prefix, that the count stays within the provider's limit,
 * and that the openai slots receive the conversation key instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidAmbientFetch } from "../../../../__tests__/support/network-fetch-stubs.js";
import type { LLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { VercelUnifiedProvider } from "../adapter.js";
import type { GenericMessage, StreamTurnParams } from "../../types.js";

const TOOLS: NonNullable<StreamTurnParams["tools"]> = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  { name: "list_files", description: "List files", inputSchema: { type: "object", properties: {} } },
];

const CONVERSATION: GenericMessage[] = [
  { role: "user", content: "Open the report." },
  { role: "assistant", content: "", toolCalls: [{ id: "toolu_01", name: "read_file", input: {} }] },
  { role: "tool_result", toolUseId: "toolu_01", toolName: "read_file", content: "report body" },
];

const TURN_CONTEXT: GenericMessage = {
  role: "user",
  content: "<turn-context>\nTime: 2026-10-15T09:30+09:00\n</turn-context>",
  meta: { requestOnly: true },
};

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
    messages: [...CONVERSATION, TURN_CONTEXT],
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

describe("prompt-prefix cache breakpoints", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the last tool, the system block and the last conversation row", async () => {
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
    expect(countBreakpoints(body)).toBeLessThanOrEqual(4);
  });

  it("leaves the request-only tail after the breakpoint, unmarked", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5");
    const blocks = messageBlocks(body).flat();
    const tail = blocks[blocks.length - 1]!;
    expect(tail).toMatchObject({ type: "text" });
    expect(String(tail.text)).toContain("<turn-context>");
    expect(tail.cache_control).toBeUndefined();
    const markedIndex = blocks.findIndex((b) => b.cache_control !== undefined);
    expect(markedIndex).toBeLessThan(blocks.length - 1);
  });

  it("marks a plain user turn when no tail follows", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5", {
      messages: [{ role: "user", content: "Hello." }],
      tools: undefined,
    });
    const blocks = messageBlocks(body).flat();
    expect(blocks[blocks.length - 1]).toMatchObject({ text: "Hello.", cache_control: { type: "ephemeral" } });
    expect(body.tools).toBeUndefined();
    expect(countBreakpoints(body)).toBe(2);
  });

  it("keeps the conversation prefix byte-identical between two rounds of one turn", async () => {
    const first = await sentBody("claude", "claude-haiku-4-5");
    const second = await sentBody("claude", "claude-haiku-4-5", {
      messages: [
        ...CONVERSATION,
        { role: "assistant", content: "The report says hello." },
        { role: "user", content: "Thanks." },
        { ...TURN_CONTEXT, content: "<turn-context>\nTime: 2026-10-15T09:31+09:00\n</turn-context>" },
      ],
    });
    const strip = (blocks: Block[]) => blocks.map(({ cache_control: _c, ...rest }) => rest);
    const firstBlocks = strip(messageBlocks(first).flat());
    const secondBlocks = strip(messageBlocks(second).flat());
    // Everything up to and including the first round's breakpoint is repeated
    // verbatim: the old turn context is gone, not rewritten in place.
    const firstMarked = messageBlocks(first).flat().findIndex((b) => b.cache_control !== undefined);
    expect(secondBlocks.slice(0, firstMarked + 1)).toEqual(firstBlocks.slice(0, firstMarked + 1));
    expect(first.system).toEqual(second.system);
    expect(first.tools).toEqual(second.tools);
  });

  it("puts no breakpoint on an empty system prompt", async () => {
    const body = await sentBody("claude", "claude-haiku-4-5", { systemPrompt: "", tools: undefined });
    expect(countBreakpoints(body.system ?? [])).toBe(0);
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
