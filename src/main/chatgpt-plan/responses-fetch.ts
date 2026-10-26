import { CHATGPT_PLAN_RESPONSES_URL } from "./endpoints.js";

/**
 * Placeholder the SDK is configured with instead of a credential. The plan
 * fetch replaces it with the session's current access token on every request
 * and refuses any other Authorization value, so an API key can never reach
 * this route and the rotating token is never held by the SDK.
 */
export const CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER = "chatgpt-plan-session";

/** The namespace every host function tool is grouped under on this route. */
const CHATGPT_PLAN_TOOL_NAMESPACE = "ave";
const TOOL_NAMESPACE_DESCRIPTION = "Tools provided by the Ave host application.";

/** Request-body fields plan usage does not accept. */
export const CHATGPT_PLAN_UNSUPPORTED_REQUEST_FIELDS = Object.freeze([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
]);

const ALLOWED_TOOL_CHOICES = new Set(["auto", "none", "required"]);

class ChatGptPlanRequestContractError extends Error {
  constructor(readonly violation: string) {
    super(`chatgpt-plan request violates the plan-usage contract: ${violation}`);
    this.name = "ChatGptPlanRequestContractError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rewrite one Responses request body into the shape plan usage accepts, or
 * refuse it. `store` is forced to `false` (an explicit `true` is refused) and
 * `stream` must already be `true`. Unsupported fields are refused rather than
 * dropped so a caller that sets one finds out. System messages become
 * developer messages, the documented equivalent; function tools are grouped
 * under one namespace and replayed calls carry that namespace.
 */
export function enforceChatGptPlanRequestBody(body: unknown): JsonObject {
  if (!isObject(body)) throw new ChatGptPlanRequestContractError("body");
  if (body.stream !== true) throw new ChatGptPlanRequestContractError("stream");
  if (body.store !== undefined && body.store !== false) throw new ChatGptPlanRequestContractError("store");
  for (const field of CHATGPT_PLAN_UNSUPPORTED_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) throw new ChatGptPlanRequestContractError(field);
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new ChatGptPlanRequestContractError("model");
  }
  if (!Array.isArray(body.input)) throw new ChatGptPlanRequestContractError("input");

  const toolNames = new Set<string>();
  let tools: unknown[] | undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new ChatGptPlanRequestContractError("tools");
    const functions = body.tools.map((tool) => {
      if (!isObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
        throw new ChatGptPlanRequestContractError("tools");
      }
      toolNames.add(tool.name);
      return tool;
    });
    tools = functions.length === 0
      ? []
      : [{
          type: "namespace",
          name: CHATGPT_PLAN_TOOL_NAMESPACE,
          description: TOOL_NAMESPACE_DESCRIPTION,
          tools: functions,
        }];
  }
  if (body.tool_choice !== undefined
    && (typeof body.tool_choice !== "string" || !ALLOWED_TOOL_CHOICES.has(body.tool_choice))) {
    throw new ChatGptPlanRequestContractError("tool_choice");
  }

  const input = body.input.map((item) => {
    if (!isObject(item)) return item;
    if (item.role === "system" && (item.type === undefined || item.type === "message")) {
      return { ...item, role: "developer" };
    }
    if (item.type === "function_call" && typeof item.name === "string") {
      if (!toolNames.has(item.name)) return item;
      if (item.namespace !== undefined && item.namespace !== CHATGPT_PLAN_TOOL_NAMESPACE) {
        throw new ChatGptPlanRequestContractError("function_call.namespace");
      }
      return { ...item, namespace: CHATGPT_PLAN_TOOL_NAMESPACE };
    }
    return item;
  });

  return {
    ...body,
    input,
    ...(tools === undefined ? {} : { tools }),
    store: false,
    stream: true,
  };
}

/** What a failed plan-usage response told us, without its body text. */
export interface ChatGptPlanResponseFailure {
  /** Absent for a failure reported inside an open stream. */
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:\-]{1,120}$/.test(value) ? value : undefined;
}

/** Parse the status, structured `error.code`/`error.param` and request id of a failure. */
function readChatGptPlanFailure(status: number, headers: Headers, text: string): ChatGptPlanResponseFailure {
  let code: string | undefined;
  let param: string | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    const error = isObject(parsed) ? parsed.error : undefined;
    if (isObject(error)) {
      code = safeIdentifier(error.code);
      param = safeIdentifier(error.param);
    }
  } catch {
    // A pre-stream admission body ({"detail": ...}) has no stable code.
  }
  const requestId = safeIdentifier(headers.get("x-request-id"));
  return Object.freeze({
    status,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function headerRecord(headers: HeadersInit | undefined): Headers {
  return new Headers(headers ?? {});
}

/**
 * The fetch the SDK uses for plan-usage inference. It admits only
 * `POST /v1/responses`, swaps the placeholder credential for the session's
 * access token, enforces the request contract, and reports each failed
 * response's status and code to `onFailure` before the SDK reads it.
 */
export function createChatGptPlanResponsesFetch(input: {
  readonly fetch: typeof fetch;
  readonly accessToken: () => Promise<string>;
  readonly onFailure?: (failure: ChatGptPlanResponseFailure) => void;
}): typeof fetch {
  return (async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || url !== CHATGPT_PLAN_RESPONSES_URL) {
      throw new ChatGptPlanRequestContractError("endpoint");
    }
    const headers = headerRecord(init?.headers);
    if (headers.get("authorization") !== `Bearer ${CHATGPT_PLAN_SDK_CREDENTIAL_PLACEHOLDER}`) {
      throw new ChatGptPlanRequestContractError("authorization");
    }
    if (typeof init?.body !== "string") throw new ChatGptPlanRequestContractError("body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      throw new ChatGptPlanRequestContractError("body");
    }
    const body = enforceChatGptPlanRequestBody(parsed);
    headers.set("authorization", `Bearer ${await input.accessToken()}`);
    const response = await input.fetch(CHATGPT_PLAN_RESPONSES_URL, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.ok) return response;
    const text = await response.text();
    input.onFailure?.(readChatGptPlanFailure(response.status, response.headers, text));
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}
