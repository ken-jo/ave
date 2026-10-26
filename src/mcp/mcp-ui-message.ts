/** Classify bounded untrusted app input as notification or turn text; sinks own sanitization. */
import { isRecord } from "../shared/is-record.js";

/** Bound app text below the guidance-queue capacity. */
const MCP_APP_MESSAGE_MAX_CHARS = 4096;

const APP_NOTIFICATION_META_KEY = "ave/notification";

type AppNotificationSeverity = "info" | "warning" | "critical";

/** App notifications cannot bypass focus policy or select urgency; severity is audit-only. */
interface AppNotificationMeta {
  title: string;
  body: string;
  /** Audit-only claim, never a delivery-policy switch. */
  severity?: AppNotificationSeverity;
}

export type McpUiMessageIntent =
  | { kind: "notification"; notification: AppNotificationMeta }
  | { kind: "text"; text: string }
  | { kind: "invalid"; error: string; message: string };

/** Whitelist title, body and severity so app fields cannot widen host delivery authority. */
function parseNotificationMeta(raw: unknown): AppNotificationMeta | null {
  if (!isRecord(raw)) return null;
  const meta = raw;
  const { title, body } = meta;
  if (typeof title !== "string" || typeof body !== "string") return null;
  const severity = meta.severity;
  return {
    title,
    body,
    ...(severity === "info" || severity === "warning" || severity === "critical"
      ? { severity }
      : {}),
  };
}

/** Any notification metadata selects notifications exclusively; only plain text reaches the turn path. */
export function parseUiMessageIntent(params: unknown): McpUiMessageIntent {
  const content = isRecord(params) ? params.content : undefined;
  if (!Array.isArray(content) || content.length === 0) {
    return { kind: "invalid", error: "invalid-content", message: "content must be a non-empty array" };
  }

  for (const block of content) {
    if (!isRecord(block)) continue;
    const meta = block._meta;
    if (!isRecord(meta)) continue;
    const notification = parseNotificationMeta(meta[APP_NOTIFICATION_META_KEY]);
    if (notification) return { kind: "notification", notification };
  }

  const text = content
    .map((block) => isRecord(block) ? block : null)
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();

  if (text.length === 0) {
    return { kind: "invalid", error: "empty-message", message: "message has no text content" };
  }
  if (text.length > MCP_APP_MESSAGE_MAX_CHARS) {
    return {
      kind: "invalid",
      error: "message-too-long",
      message: `message exceeds ${MCP_APP_MESSAGE_MAX_CHARS} characters`,
    };
  }
  return { kind: "text", text };
}

/** Return an outcome without conversation content; disposition stays host-side. */
export type McpUiMessageOutcome =
  | { ok: true; disposition: "notified" | "queued" | "staged" }
  | { ok: false; error: string; message?: string };
