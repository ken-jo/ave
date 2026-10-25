import { CHATGPT_PLAN_MODELS_URL } from "./endpoints.js";

export interface ChatGptPlanModel {
  /** The `slug` sent as `model` in an inference request. */
  readonly id: string;
  /** The provider's `display_name`, shown in the picker. */
  readonly displayName: string;
}

class ChatGptPlanModelsError extends Error {
  constructor(readonly status?: number) {
    super(`chatgpt-plan model list failed${status ? ` [${status}]` : ""}`);
    this.name = "ChatGptPlanModelsError";
  }
}

const MAX_SLUG_LENGTH = 200;

/**
 * Parse the account's model catalog: the `models` array, kept to entries
 * meant for display (`visibility: "list"`), in the server's order. A body
 * without that shape is an error, never an empty catalog.
 */
export function parseChatGptPlanModels(body: unknown): ChatGptPlanModel[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new ChatGptPlanModelsError();
  const listed: ChatGptPlanModel[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;
    const { slug, display_name: displayName, visibility } = entry as Record<string, unknown>;
    if (visibility !== "list") continue;
    if (
      typeof slug !== "string" || slug.length === 0 || slug.length > MAX_SLUG_LENGTH
      || /[\u0000-\u001f\u007f]/.test(slug) || seen.has(slug)
    ) {
      continue;
    }
    seen.add(slug);
    listed.push(Object.freeze({
      id: slug,
      displayName: typeof displayName === "string" && displayName.trim().length > 0 ? displayName : slug,
    }));
  }
  return listed;
}

/** Request the selected account's model catalog with the token used for inference. */
export async function fetchChatGptPlanModels(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<ChatGptPlanModel[]> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_PLAN_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch {
    throw new ChatGptPlanModelsError();
  }
  if (response.status !== 200) {
    await response.text().catch(() => "");
    throw new ChatGptPlanModelsError(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ChatGptPlanModelsError(response.status);
  }
  return parseChatGptPlanModels(body);
}
