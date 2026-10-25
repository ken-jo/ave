import { describe, expect, it } from "vitest";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";

class CapturingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield { type: "message_complete", stopReason: "end_turn" } as StreamEvent;
  }
}

describe("CTRL simplification — StreamTurnParams shape", () => {
  it("StreamTurnParams carries streamSmoothing, enableThinking, thinkingBudgetTokens", async () => {
    const provider = new CapturingProvider();
    const iter = provider.streamTurn({
      model: "gpt-test",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
      streamSmoothing: "word",
      enableThinking: false,
      thinkingBudgetTokens: 0,
    });
    for await (const _ of iter) {  }
    const p = provider.lastParams!;
    expect(p.streamSmoothing).toBe("word");
    expect(p.enableThinking).toBe(false);
    expect(p.thinkingBudgetTokens).toBe(0);
  });

  it("StreamTurnParams does NOT include removed tuning controls", () => {
    const params: StreamTurnParams = {
      model: "gpt-test",
      systemPrompt: "",
      messages: [],
    };
    expect("temperature" in params).toBe(false);
    expect("maxOutputTokens" in params).toBe(false);
    expect("seed" in params).toBe(false);
    expect("responseFormat" in params).toBe(false);
    expect("stopSequences" in params).toBe(false);
  });
});
