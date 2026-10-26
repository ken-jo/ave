import {
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_JWKS_URL,
  CHATGPT_PLAN_MODELS_URL,
  CHATGPT_PLAN_RESPONSES_URL,
  CHATGPT_PLAN_REVOCATION_URL,
  CHATGPT_PLAN_TOKEN_URL,
} from "./endpoints.js";

/**
 * Every request the plan connection may make, by exact method and URL. Query
 * strings and fragments are refused: none of these requests carries one, and
 * a token must never travel in a URL.
 */
const ALLOWED_REQUESTS: ReadonlySet<string> = new Set([
  `GET ${CHATGPT_PLAN_DISCOVERY_URL}`,
  `GET ${CHATGPT_PLAN_JWKS_URL}`,
  `POST ${CHATGPT_PLAN_TOKEN_URL}`,
  `POST ${CHATGPT_PLAN_REVOCATION_URL}`,
  `GET ${CHATGPT_PLAN_MODELS_URL}`,
  `POST ${CHATGPT_PLAN_RESPONSES_URL}`,
]);

export class ChatGptPlanEgressError extends Error {
  constructor(readonly method: string, readonly origin: string) {
    super(`chatgpt-plan egress refused: ${method} ${origin}`);
    this.name = "ChatGptPlanEgressError";
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

/** Whether `method url` is one of the plan connection's documented requests. */
export function isAllowedChatGptPlanRequest(method: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  return ALLOWED_REQUESTS.has(`${method.toUpperCase()} ${parsed.origin}${parsed.pathname}`);
}

/**
 * The plan connection's only network path. It refuses any request outside the
 * documented set before it leaves the process, never follows a redirect, and
 * runs on the host's network stack so the machine's proxy and trust store
 * apply. The refusal names only the method and origin, never a path or body.
 */
export function createChatGptPlanFetch(networkFetch: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (!isAllowedChatGptPlanRequest(method, url)) {
      let origin = "invalid-url";
      try {
        origin = new URL(url).origin;
      } catch {
        // Keep the fixed placeholder.
      }
      throw new ChatGptPlanEgressError(method, origin);
    }
    return networkFetch(input, { ...(init ?? {}), redirect: "error" });
  }) as typeof fetch;
}
