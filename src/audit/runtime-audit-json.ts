import { stringifyHomeRedacted } from "./home-path-json.js";

const MAX_RUNTIME_AUDIT_OUTPUT_LENGTH = 500;
/** Keep ordinary payloads intact and make omitted content explicit in bounded, valid JSON. */
export function serializeRuntimeAuditData(data: unknown): string | undefined {
  let serialized: string | undefined;
  try { serialized = stringifyHomeRedacted(data); } catch { return '{"unserializable":true}'; }
  if (serialized === undefined || serialized.length <= MAX_RUNTIME_AUDIT_OUTPUT_LENGTH) return serialized;
  const truncated = { truncated: true, originalLength: serialized.length, preview: "" };
  const { pluginId, reason } = (
    data !== null && typeof data === "object" ? data : {}
  ) as { pluginId?: unknown; reason?: unknown };
  const attributed = { ...truncated, pluginId, reason };
  const marker = typeof pluginId === "string" && typeof reason === "string"
    && JSON.stringify(attributed).length <= MAX_RUNTIME_AUDIT_OUTPUT_LENGTH ? attributed : truncated;
  for (const character of serialized) {
    const previous = marker.preview;
    marker.preview += character;
    if (JSON.stringify(marker).length > MAX_RUNTIME_AUDIT_OUTPUT_LENGTH) {
      marker.preview = previous;
      break;
    }
  }
  return JSON.stringify(marker);
}
