/** Main-process only: identifier minters require crypto and must not enter renderer or preload bundles. */
import { randomUUID } from "node:crypto";
import { hasControlChars } from "./display-safe-text.js";
import { maskSensitiveData } from "./dlp.js";
import { UUID_PATTERN } from "./uuid.js";

const DLP_SAFE_UUID_MAX_ATTEMPTS = 8;
const STRUCTURAL_ID_MAX_LENGTH = 256;

/** Validate external ids before key use; exact host UUID forms are structural, while other tokens retain content DLP. */
export function isSafeStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= STRUCTURAL_ID_MAX_LENGTH
    && !hasControlChars(value)
    && (isStructuralUuid(value) || maskSensitiveData(value).detections.length === 0);
}

function isStructuralUuid(value: string): boolean {
  if (UUID_PATTERN.test(value)) return true;
  return value.at(-37) === "-"
    && HOST_UUID_PREFIX_PATTERN.test(value.slice(0, -37))
    && UUID_PATTERN.test(value.slice(-36));
}

/** Scan arbitrary candidates, permit null draws, and return null on exhaustion so callers choose domain errors. */
export function dlpSafeCandidate(
  makeCandidate: (attempt: number) => string | null,
  maxAttempts: number,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = makeCandidate(attempt);
    if (candidate === null) continue;
    if (maskSensitiveData(candidate).detections.length === 0) return candidate;
  }
  return null;
}

/** Structural UUIDs bypass content DLP; arbitrary prefixes and the final join still require scanning. */
export function createDlpSafeUuid(
  prefix = "",
  makeUuid: () => string = randomUUID,
): string {
  if (maskSensitiveData(prefix).detections.length > 0) {
    throw new Error("[dlp-safe-uuid-prefix-rejected] DLP rejected the identifier prefix");
  }
  for (let attempt = 0; attempt < DLP_SAFE_UUID_MAX_ATTEMPTS; attempt += 1) {
    const uuid = makeUuid();
    if (!UUID_PATTERN.test(uuid)) continue;
    const candidate = prefix ? `${prefix}-${uuid}` : uuid;
    if (isSafeStructuralId(candidate)) return candidate;
  }
  throw new Error("[dlp-safe-uuid-exhausted] Could not generate a DLP-safe UUID");
}

/** Derive validator namespaces from the minters so persisted session-id grammar cannot drift. */
export const SESSION_ID_NAMESPACE_KINDS = ["sub", "a2a-wire"] as const;
export type SessionIdNamespaceKind = (typeof SESSION_ID_NAMESPACE_KINDS)[number];
const HOST_UUID_PREFIX_PATTERN = new RegExp(`^(?:${SESSION_ID_NAMESPACE_KINDS.join("|")})-[0-9a-f]{8}$`);

/** Mint kind-tag-UUID sessions with a short hashed tag, never raw parent identity. */
export function createNamespacedSessionId(kind: SessionIdNamespaceKind, tag: string): string {
  if (!/^[a-z0-9]+$/.test(tag)) {
    throw new Error(`[session-id-tag-rejected] namespace tag must be [a-z0-9]+, got "${tag}"`);
  }
  return createDlpSafeUuid(`${kind}-${tag}`);
}
