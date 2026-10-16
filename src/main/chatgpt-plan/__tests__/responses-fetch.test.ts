import { describe, expect, it } from "vitest";
import { VercelUnifiedProvider } from "../../../engine/llm/vercel/adapter.js";
import type { StreamEvent } from "../../../engine/llm/types.js";
import { CHATGPT_PLAN_API_BASE_URL, CHATGPT_PLAN_RESPONSES_URL } from "../endpoints.js";
import {
  CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER,
  CHATGPT_PLAN_UNSUPPORTED_REQUEST_FIELDS,
  createChatGptPlanResponsesFetch,
  enforceChatGptPlanRequestBody,
  type ChatGptPlanResponseFailure,
} from "../responses-fetch.js";

const BASE_BODY = { model: "gpt-6.1-sol", input: [{ role: "user", content: "hi" }], stream: true };

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("plan-usage request contract", () => {
  it("forces store:false and requires stream:true", () => {
    expect(enforceChatGptPlanRequestBody(BASE_BODY)).toMatchObject({ store: false, stream: true });
    expect(enforceChatGptPlanRequestBody({ ...BASE_BODY, store: false }).store).toBe(false);
    expect(() => enforceChatGptPlanRequestBody({ ...BASE_BODY, store: true })).toThrow(/store/);
    expect(() => enforceChatGptPlanRequestBody({ ...BASE_BODY, stream: false })).toThrow(/stream/);
    expect(() => enforceChatGptPlanRequestBody({ model: "m", input: [] })).toThrow(/stream/);
  });

  it.each(CHATGPT_PLAN_UNSUPPORTED_REQUEST_FIELDS)("refuses the unsupported field %s", (field) => {
    expect(() => enforceChatGptPlanRequestBody({ ...BASE_BODY, [field]: 1 })).toThrow(field);
  });

  it("turns system messages into developer messages", () => {
    const body = enforceChatGptPlanRequestBody({
      ...BASE_BODY,
      input: [{ role: "system", content: "rules" }, { type: "message", role: "system", content: "more" }, { role: "user", content: "hi" }],
    });
    expect((body.input as { role?: string }[]).map((item) => item.role)).toEqual(["developer", "developer", "user"]);
  });

  it("groups function tools in one namespace and tags replayed calls with it", () => {
    const body = enforceChatGptPlanRequestBody({
      ...BASE_BODY,
      input: [
        { type: "function_call", call_id: "c0", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c0", output: "x" },
      ],
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }],
      tool_choice: "auto",
    });
    expect(body.tools).toEqual([{
      type: "namespace",
      name: "ave",
      description: expect.any(String),
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }],
    }]);
    expect((body.input as Record<string, unknown>[])[0]).toMatchObject({ type: "function_call", namespace: "ave" });
  });

  it("refuses hosted tools and forced tool choices", () => {
    for (const type of ["web_search", "file_search", "image_generation", "code_interpreter", "computer_use", "mcp", "tool_search"]) {
      expect(() => enforceChatGptPlanRequestBody({ ...BASE_BODY, tools: [{ type }] })).toThrow(/tools/);
    }
    expect(() => enforceChatGptPlanRequestBody({ ...BASE_BODY, tool_choice: { type: "function", name: "x" } })).toThrow(/tool_choice/);
  });
});

describe("plan-usage responses fetch", () => {
  const placeholderInit = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { authorization: `Bearer ${CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("swaps the placeholder for the session token and sends the enforced body", async () => {
    const sent: { authorization: string | null; body: Record<string, unknown> }[] = [];
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent.push({ authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
        return sse([]);
      }) as typeof fetch,
      accessToken: async () => "session-access-token",
    });
    await planFetch(CHATGPT_PLAN_RESPONSES_URL, placeholderInit(BASE_BODY));
    expect(sent[0]!.authorization).toBe("Bearer session-access-token");
    expect(sent[0]!.body.store).toBe(false);
  });

  it("refuses any other credential and any other endpoint", async () => {
    let calls = 0;
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: (async () => { calls += 1; return sse([]); }) as typeof fetch,
      accessToken: async () => "t",
    });
    await expect(planFetch(CHATGPT_PLAN_RESPONSES_URL, {
      ...placeholderInit(BASE_BODY),
      headers: { authorization: "Bearer sk-api-key" },
    })).rejects.toThrow(/authorization/);
    await expect(planFetch("https://api.openai.com/v1/chat/completions", placeholderInit(BASE_BODY))).rejects.toThrow(/endpoint/);
    expect(calls).toBe(0);
  });

  it("reports a failure's status, code and request id but not its text", async () => {
    const failures: ChatGptPlanResponseFailure[] = [];
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: (async () => new Response(JSON.stringify({
        error: { code: "subscription_sharing_usage_limit_exceeded", param: null, message: "limit for user@example.com" },
      }), { status: 429, headers: { "x-request-id": "req_123" } })) as typeof fetch,
      accessToken: async () => "t",
      onFailure: (failure) => failures.push(failure),
    });
    const response = await planFetch(CHATGPT_PLAN_RESPONSES_URL, placeholderInit(BASE_BODY));
    expect(response.status).toBe(429);
    expect(failures).toEqual([{ status: 429, code: "subscription_sharing_usage_limit_exceeded", requestId: "req_123" }]);
    expect(JSON.stringify(failures)).not.toContain("user@example.com");
  });

  it("carries a real SDK turn: Responses wire, namespaced tools, and a namespaced call back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse([
          { type: "response.created", response: { id: "r1", created_at: 1, model: "gpt-6.1-sol" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file", namespace: "ave", arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, delta: "{\"path\":\"a\"}" },
          { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file", namespace: "ave", arguments: "{\"path\":\"a\"}", status: "completed" } },
          { type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
        ]);
      }) as typeof fetch,
      accessToken: async () => "session-access-token",
    });
    const provider = new VercelUnifiedProvider(
      "openai",
      CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER,
      CHATGPT_PLAN_API_BASE_URL,
      planFetch,
      { openaiWire: "responses" },
    );
    const events: StreamEvent[] = [];
    for await (const event of provider.streamTurn({
      model: "gpt-6.1-sol",
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "read_file", input: { path: "b" } }] },
        { role: "tool_result", toolUseId: "call_0", toolName: "read_file", content: "x" },
      ],
      tools: [{ name: "read_file", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    })) events.push(event);
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    expect(events).toContainEqual({ type: "tool_call", id: "call_1", name: "read_file", input: { path: "a" } });
    const body = bodies[0]!;
    expect(body).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.tools).toEqual([expect.objectContaining({ type: "namespace", name: "ave" })]);
    const input = body.input as Record<string, unknown>[];
    expect(input.some((item) => item.role === "system")).toBe(false);
    expect(input.find((item) => item.type === "function_call")).toMatchObject({ namespace: "ave" });
  });

  it("needs the Responses pin: an unpinned model id outside the known families reaches Chat Completions and is refused", async () => {
    let sent = 0;
    const planFetch = createChatGptPlanResponsesFetch({
      fetch: (async () => { sent += 1; return sse([]); }) as typeof fetch,
      accessToken: async () => "t",
    });
    const unpinned = new VercelUnifiedProvider("openai", CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER, CHATGPT_PLAN_API_BASE_URL, planFetch);
    const events: StreamEvent[] = [];
    for await (const event of unpinned.streamTurn({
      model: "gpt-6.1-sol",
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    })) events.push(event);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(sent).toBe(0);
  });
});
