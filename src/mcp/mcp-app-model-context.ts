/** Each card owns one overwritten context slot, read only at the next prompt build.
 * Context is fenced untrusted data and cannot start a follow-up turn. */
import { t } from "../i18n/index.js";
import { neutralizeFenceClose } from "../shared/fence-sanitizer.js";
import { appMessageSource, isAppMessageOrigin } from "../shared/mcp-app-message-source.js";

/** Limit the serialized prompt body, not just the app input. */
export const MCP_APP_MODEL_CONTEXT_MAX_CHARS = 8_192;

/** Slot count bounds worst-case prompt and memory cost; evict the oldest insertion first. */
export const MCP_APP_MODEL_CONTEXT_MAX_SLOTS = 16;

export type McpUiModelContextOutcome =
  | { ok: true; disposition: "stored" | "cleared" }
  | { ok: false; error: string; message: string };

export interface McpAppModelContextUpdate {
  sessionId: string;
  serverId: string;
  cardId: string;
  content?: unknown;
  structuredContent?: unknown;
}

interface ModelContextSlot {
  sessionId: string;
  serverId: string;
  body: string;
}

/** Empty usable content clears the slot rather than failing. */
export function serializeAppContext(update: Pick<McpAppModelContextUpdate, "content" | "structuredContent">): string {
  const parts: string[] = [];

  if (Array.isArray(update.content)) {
    const text = update.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (text) parts.push(text);
  }

  const structured = update.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    try {
      const json = JSON.stringify(structured, null, 2);
      if (json && json !== "{}") parts.push("```json\n" + json + "\n```");
    } catch {
      // Unserializable structured content is omitted; protocol replies remain empty either way.
    }
  }

  // Bound app text before neutralizing fence closers; retain one excess character for overflow detection.
  const joined = parts.join("\n\n");
  return neutralizeFenceClose(
    joined.length > MCP_APP_MODEL_CONTEXT_MAX_CHARS
      ? joined.slice(0, MCP_APP_MODEL_CONTEXT_MAX_CHARS + 1)
      : joined,
    "mcp-app-context",
  );
}

/** Trusted card/session/server bindings prevent apps from overwriting another card or conversation. */
export class McpAppModelContextStore {
  private readonly slots = new Map<string, ModelContextSlot>();

  /** NUL-separated so no component can be crafted to collide with another triple. */
  private static key(sessionId: string, serverId: string, cardId: string): string {
    return [sessionId, serverId, cardId].join("\u0000");
  }

  /** Oversized updates preserve the prior slot and record refusal outside the empty protocol response. */
  update(request: McpAppModelContextUpdate): McpUiModelContextOutcome {
    const { sessionId, serverId, cardId } = request;
    if (!isAppMessageOrigin(appMessageSource(serverId))) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a valid MCP server id" };
    }
    if (typeof cardId !== "string" || cardId.length === 0 || cardId.length > 128) {
      return { ok: false, error: "invalid-card-id", message: "cardId must be a bounded non-empty string" };
    }

    const key = McpAppModelContextStore.key(sessionId, serverId, cardId);
    const body = serializeAppContext(request);

    if (body.length === 0) {
      this.slots.delete(key);
      return { ok: true, disposition: "cleared" };
    }
    if (body.length > MCP_APP_MODEL_CONTEXT_MAX_CHARS) {
      return {
        ok: false,
        error: "too-large",
        message: `model context exceeds ${MCP_APP_MODEL_CONTEXT_MAX_CHARS} characters`,
      };
    }

    // Replacing a slot retains insertion order so chatty cards cannot evade eviction.
    if (!this.slots.has(key) && this.slots.size >= MCP_APP_MODEL_CONTEXT_MAX_SLOTS) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined) this.slots.delete(oldest);
    }
    this.slots.set(key, { sessionId, serverId, body });
    return { ok: true, disposition: "stored" };
  }

  /** Pull session context at prompt-build time; no live slots means no prompt section. */
  buildSection(sessionId: string): string {
    const live = [...this.slots.values()].filter((slot) => slot.sessionId === sessionId);
    if (live.length === 0) return "";

    const lines: string[] = [
      '<mcp-app-context trust="untrusted-app-data">',
      t("be_systemPromptBuilder.appModelContextUntrusted"),
      t("be_systemPromptBuilder.appModelContextNoInstructions"),
      t("be_systemPromptBuilder.appModelContextNoFollowUp"),
    ];
    for (const slot of live) {
      lines.push("", `### app:${slot.serverId}`, slot.body);
    }
    lines.push("</mcp-app-context>");
    return lines.join("\n");
  }

  size(): number {
    return this.slots.size;
  }
}
