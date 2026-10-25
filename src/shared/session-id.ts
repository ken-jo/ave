import { SESSION_ID_NAMESPACE_KINDS } from "./dlp-safe-id.js";

/** The minting grammar bounds IDs and makes them safe filename components; namespace kinds must derive from the minting list. */
const SESSION_ID_CORE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_REGEX = new RegExp(
  `^(?:(?:${SESSION_ID_NAMESPACE_KINDS.join("|")})-[a-z0-9]+-)?${SESSION_ID_CORE}$`,
);

/** Resume callers must reject unsafe IDs before loading metadata, using this shared validator. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_REGEX.test(id);
}
