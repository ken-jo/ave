import { stringifyHomeRedacted } from "./home-path-json.js";

const MAX_RUNTIME_AUDIT_OUTPUT_LENGTH = 500;
/** Keep ordinary payloads intact and make omitted content explicit in bounded, valid JSON. */
export function serializeRuntimeAuditData(data: unknown): string | undefined {
  let serialized: string | undefined;
  try { serialized = stringifyHomeRedacted(data); } catch { return '{"unserializable":true}'; }
  if (serialized === undefined || serialized.length <= MAX_RUNTIME_AUDIT_OUTPUT_LENGTH) return serialized;
  const marker = { truncated: true, originalLength: serialized.length, preview: "" };
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
