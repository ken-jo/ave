/**
 * Host text a single request carries after the conversation: the turn
 * context and round nudges. None of it is persisted.
 *
 * When the round starts from a user message the text becomes extra content
 * parts INSIDE that message, after its own content. A separate row would put
 * two user messages in a row, which chat templates that assert role
 * alternation reject, and on a tool round would land in the tool-result
 * message. The count of appended parts is recorded so a transport that marks
 * the reusable prefix ends it before them.
 *
 * After an assistant or tool-result row there is no user message to extend,
 * so the text is one request-only user row of its own, which still alternates.
 */
import type { GenericMessage, UserContentPart } from "../llm/types.js";

export function appendRequestOnlyText(rows: GenericMessage[], texts: string[]): GenericMessage[] {
  const parts = texts.filter((text) => text.length > 0);
  if (parts.length === 0) return rows;
  const last = rows[rows.length - 1];
  if (last?.role === "user") {
    const own: UserContentPart[] = typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];
    return [
      ...rows.slice(0, -1),
      {
        ...last,
        content: [...own, ...parts.map((text) => ({ type: "text" as const, text }))],
        meta: { ...(last.meta ?? {}), requestOnlyParts: (last.meta?.requestOnlyParts ?? 0) + parts.length },
      },
    ];
  }
  return [...rows, { role: "user", content: parts.join("\n\n"), meta: { requestOnly: true } }];
}
