/**
 * Main-process only — the minters below pull `node:crypto` for `randomUUID`,
 * which the renderer and preload bundles do not have. Neither of those
 * processes should import this module.
 *
 * `isSafeStructuralId`'s control-character class (C0/DEL plus C1
 * U+0080–U+009F and the line separators U+2028/2029) is what actually
 * narrowed for two existing call paths: `src/api/a2a-remote-client.ts`
 * (~line 796, the remote task projection) and
 * `src/api/a2a-exact-replay-store.ts` (~line 115, the replay task-shape
 * check), both by way of `canonicalizeA2ARemoteTask` in
 * `src/api/a2a-task-store.ts`. A remote task id carrying one of those
 * characters now fails canonicalization instead of being accepted.
 */
import { randomUUID } from "node:crypto";
import { hasControlChars } from "./display-safe-text.js";
import { maskSensitiveData } from "./dlp.js";
import { UUID_PATTERN } from "./uuid.js";

const DLP_SAFE_UUID_MAX_ATTEMPTS = 8;
const STRUCTURAL_ID_MAX_LENGTH = 256;

/**
 * Is `value` fit to be a structural identifier — an A2A context, task or
 * artifact id, or the parent/child session ids a subagent address names?
 *
 * The read-side twin of the minters below: every id arriving from outside (the A2A
 * wire, a persisted task record, a subagent message address) has to pass
 * before it is used as a key. Three modules validate the same ids off the same
 * wire and store, so they must reject the same strings — which is why the
 * predicate lives here rather than beside any one of them.
 *
 * Exact UUIDs and host-namespaced UUIDs are structural keys, so their digit
 * groups are not content to redact. Other opaque tokens retain content DLP
 * checks. Every form has a length bound and rejects control characters.
 * "Control characters" is the
 * display-safe class — C0 and DEL, and also C1 (U+0080–U+009F) and the Unicode
 * line separators (U+2028/2029) — because an id that would render as a line
 * break in a log or a transcript is no more an id than one carrying a NUL.
 */
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

/**
 * Draw candidate identifiers until one survives the DLP scanner, or give up.
 *
 * Arbitrary candidate strings retain content DLP checks. Typed UUID minters
 * use their structural contract instead; this helper does not exempt content.
 *
 * `makeCandidate` receives the attempt number so a deterministic generator can
 * vary its input, and may return `null` to reject a draw outright (a malformed
 * uuid, a name already taken) without spending the scan.
 *
 * Returns `null` on exhaustion so callers can report their own domain error.
 */
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

/**
 * Create a structurally safe UUID identifier. Complete host UUID forms do not
 * undergo content DLP; arbitrary prefixes still pass the content scanner,
 * including the final prefix/UUID boundary.
 */
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

/**
 * The namespaces a persisted session id may carry, named by the code that
 * mints them: `sub` for a sub-agent child session (`~/.ave/subagent/`),
 * `a2a-wire` for the internal origin an A2A wire handler runs under. The
 * validator in `memory/memory-manager.ts` builds its regex from this list, so
 * a new namespace exists only where an id is minted — the rule cannot drift
 * from the minting code.
 */
export const SESSION_ID_NAMESPACE_KINDS = ["sub", "a2a-wire"] as const;
export type SessionIdNamespaceKind = (typeof SESSION_ID_NAMESPACE_KINDS)[number];
const HOST_UUID_PREFIX_PATTERN = new RegExp(`^(?:${SESSION_ID_NAMESPACE_KINDS.join("|")})-[0-9a-f]{8}$`);

/**
 * Mint `<kind>-<tag>-<uuid>`: a bare session UUID namespaced by a kind from
 * {@link SESSION_ID_NAMESPACE_KINDS} and a lowercase alphanumeric tag (a
 * short hash of the parent, never a raw slice of it). Every session id in the
 * app is either a bare `createDlpSafeUuid()` or this.
 */
export function createNamespacedSessionId(kind: SessionIdNamespaceKind, tag: string): string {
  if (!/^[a-z0-9]+$/.test(tag)) {
    throw new Error(`[session-id-tag-rejected] namespace tag must be [a-z0-9]+, got "${tag}"`);
  }
  return createDlpSafeUuid(`${kind}-${tag}`);
}
