import { CHATGPT_PLAN_MODELS_URL } from "./endpoints.js";

interface ChatGptPlanModel {
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

/** One read of the account's catalog: the picker's rows, and what the whole list proves about inference. */
export interface ChatGptPlanCatalog {
  /** Entries meant for display (`visibility: "list"`), in the server's order. */
  readonly models: ChatGptPlanModel[];
  /**
   * Every slug the catalog names, whatever its visibility. Present only when each row could be read and at least one
   * was named: a hidden row is still served, and a list with an unreadable row cannot prove that a slug is gone.
   */
  readonly inferenceSlugs?: ReadonlySet<string>;
}

function readSlug(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const { slug } = entry as Record<string, unknown>;
  return typeof slug === "string" && slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && !/[\u0000-\u001f\u007f]/.test(slug)
    ? slug
    : undefined;
}

/**
 * Parse the account's model catalog: the `models` array. A body without that shape is an error, never an empty
 * catalog. The picker keeps only displayable entries; retirement evidence needs the complete list.
 */
export function parseChatGptPlanCatalog(body: unknown): ChatGptPlanCatalog {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new ChatGptPlanModelsError();
  const listed: ChatGptPlanModel[] = [];
  const slugs = new Set<string>();
  const seen = new Set<string>();
  let complete = models.length > 0;
  for (const entry of models) {
    const slug = readSlug(entry);
    if (slug === undefined) {
      complete = false;
      continue;
    }
    slugs.add(slug);
    const { display_name: displayName, visibility } = entry as Record<string, unknown>;
    if (visibility !== "list" || seen.has(slug)) continue;
    seen.add(slug);
    listed.push(Object.freeze({
      id: slug,
      displayName: typeof displayName === "string" && displayName.trim().length > 0 ? displayName : slug,
    }));
  }
  return { models: listed, ...(complete ? { inferenceSlugs: slugs } : {}) };
}

/** Request the selected account's model catalog with the token used for inference. */
export async function fetchChatGptPlanCatalog(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<ChatGptPlanCatalog> {
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
  return parseChatGptPlanCatalog(body);
}
