// Keep turn context and nudges request-only; extend user parts to preserve role alternation.
// Record appended part counts so cache markers exclude them; never extend tool-result rows.
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
