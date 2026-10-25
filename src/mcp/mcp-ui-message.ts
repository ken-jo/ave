/** Classify bounded untrusted app input as notification or turn text; sinks own sanitization. */

/** Bound app text below the guidance-queue capacity. */
export const MCP_APP_MESSAGE_MAX_CHARS = 4096;

export const APP_NOTIFICATION_META_KEY = "ave/notification";

export type AppNotificationSeverity = "info" | "warning" | "critical";

/** App notifications cannot bypass focus policy or select urgency; severity is audit-only. */
export interface AppNotificationMeta {
  title: string;
  body: string;
  /** Audit-only claim, never a delivery-policy switch. */
  severity?: AppNotificationSeverity;
}

export type McpUiMessageIntent =
  | { kind: "notification"; notification: AppNotificationMeta }
  | { kind: "text"; text: string }
  | { kind: "invalid"; error: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whitelist title, body and severity so app fields cannot widen host delivery authority. */
function parseNotificationMeta(raw: unknown): AppNotificationMeta | null {
  const meta = asRecord(raw);
  if (!meta) return null;
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
  const record = asRecord(params);
  const content = record?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { kind: "invalid", error: "invalid-content", message: "content must be a non-empty array" };
  }

  for (const block of content) {
    const blockRecord = asRecord(block);
    if (!blockRecord) continue;
    const meta = asRecord(blockRecord._meta);
    if (!meta) continue;
    const notification = parseNotificationMeta(meta[APP_NOTIFICATION_META_KEY]);
    if (notification) return { kind: "notification", notification };
  }

  const text = content
    .map((block) => asRecord(block))
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
