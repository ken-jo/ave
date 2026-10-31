/** Resource bound rationale lives in docs/development/README.md#mcp-resource-consumption-policy; keep contracts process-neutral. */
import { hasInvisibleOrReorderingChars } from "./display-safe-text.js";

export const MCP_RESOURCE_MAX_PER_SERVER = 200;
export const MCP_RESOURCE_MAX_CHARS = 32 * 1024;
export const MCP_RESOURCE_MAX_BLOCKS = 32;
export const MCP_RESOURCE_URI_MAX_CHARS = 2_048;
export const MCP_RESOURCE_NAME_MAX_CHARS = 128;
export const MCP_RESOURCE_DESCRIPTION_MAX_CHARS = 512;
/** Main bounds attachments per turn; each mention can carry a full read’s worth of server text. */
export const MCP_RESOURCE_ATTACHMENTS_PER_TURN = 8;

/** Builders and turn-entry counting share this tag so attachments cannot become uncounted. */
export const MCP_RESOURCE_FENCE_OPEN = '<mcp-resource trust="untrusted-server-data"';

/** Count fence occurrences in attachment parts, not part count or user text. Mentions must remain attachment parts; imported replay is outside this bound. */
export function countResourceAttachmentFences(
  parts?: ReadonlyArray<{ type?: unknown; text?: unknown }>,
): number {
  let count = 0;
  for (const part of parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") count += occurrences(part.text);
  }
  return count;
}

/** Scan rather than split to avoid copying large attachment parts. */
function occurrences(text: string): number {
  let count = 0;
  for (
    let at = text.indexOf(MCP_RESOURCE_FENCE_OPEN);
    at !== -1;
    at = text.indexOf(MCP_RESOURCE_FENCE_OPEN, at + MCP_RESOURCE_FENCE_OPEN.length)
  ) {
    count += 1;
  }
  return count;
}

/** Bounded page walk so a hostile `nextCursor` loop cannot hang the handshake. */
export const MCP_RESOURCE_MAX_PAGES = 20;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Reject raw RFC-excluded characters before they can break provenance attributes, audit lines, or labels. */
const URI_EXCLUDED_CHARS_RE = /[\s"<>\\^`{}|]/;

/** Share URI character checks; whitespace and default-ignorable classes have distinct coverage. The explicit control arm remains redundant cross-module defense. */
export function hasUnsafeUriChars(value: string): boolean {
  return CONTROL_CHARS_RE.test(value)
    || URI_EXCLUDED_CHARS_RE.test(value)
    || hasInvisibleOrReorderingChars(value);
}

/** Carry resource URIs opaquely; reserve UI and renderer-dangerous schemes, and list HTTPS without authorizing host fetch. */
const ALLOWED_URI_SCHEMES = Object.freeze([
  "file:",
  "git:",
  "https:",
  "resource:",
  "schema:",
  "issue:",
  "doc:",
  "note:",
]);

/** Custom schemes follow the narrow URI grammar and cannot contain slashes. */
const CUSTOM_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}:/;
const RESERVED_SCHEMES = Object.freeze([
  "ui:",
  "javascript:",
  "data:",
  "blob:",
  "vbscript:",
  "about:",
  "file-loopback:",
]);

export function isUsableResourceUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;
  // Percent-encoded forms remain usable; ordinary non-ASCII paths are allowed, invisible selectors are not.
  if (hasUnsafeUriChars(value)) return false;
  const lowered = value.toLowerCase();
  if (RESERVED_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return false;
  if (ALLOWED_URI_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return true;
  return CUSTOM_SCHEME_RE.test(lowered);
}

/** Refuse HTTPS resource reads rather than fetching a server-chosen URL from the host. */
export function isHostFetchRefusedUri(uri: string): boolean {
  return uri.toLowerCase().startsWith("https:");
}

/** Bounded display string, or undefined when the wire value is unusable. */
export function usableResourceText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || CONTROL_CHARS_RE.test(trimmed)) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}
