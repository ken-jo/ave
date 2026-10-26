import { describe, it, expect } from "vitest";

import { VercelUnifiedProvider } from "../../src/engine/llm/vercel/adapter.js";
import { LLM_VENDOR_DEFAULTS } from "../../src/shared/llm-vendor-defaults.js";
import type { StreamEvent } from "../../src/engine/llm/types.js";
import { collectAsyncIterable } from "../../src/__tests__/test-helpers.js";

// Live calls incur charges and require AVE_SMOKE_OPENROUTER_KEY.
// The launcher decrypts the configured key in the app runtime and passes it through the environment.

const apiKey = process.env.AVE_SMOKE_OPENROUTER_KEY?.trim() || null;
const live = !!apiKey;


function provider(): VercelUnifiedProvider {
  return new VercelUnifiedProvider(
    "openrouter",
    apiKey as string,
    LLM_VENDOR_DEFAULTS.openrouter.baseUrl,
  );
}

const MODEL = "openrouter/auto";

describe.skipIf(!live)("live model smoke (OpenRouter)", () => {
  it("streams a real completion", async () => {
    const events = await collectAsyncIterable<StreamEvent>(
      provider().streamTurn({
        model: MODEL,
        systemPrompt: "Answer with the single word: pong",
        messages: [{ role: "user", content: "ping" }],
      }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    // A cleanly ended empty stream is still a failure.
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it("emits a tool call when given a tool", async () => {
    const events = await collectAsyncIterable<StreamEvent>(
      provider().streamTurn({
        model: MODEL,
        systemPrompt:
          "You must call the `get_weather` tool to answer. Do not answer from memory.",
        messages: [{ role: "user", content: "What is the weather in Seoul?" }],
        tools: [
          {
            name: "get_weather",
            description: "Look up the current weather for a city.",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    // Real calls verify tool schema encoding and streamed tool-call events across the provider boundary.
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(live)("live model smoke (skipped)", () => {
  it("records that it did not run", () => {
    // A skipped live suite must not appear to pass.
    expect(live).toBe(false);
    expect(process.env.AVE_SMOKE_OPENROUTER_KEY ?? "").toBe("");
  });
});
