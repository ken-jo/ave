/**
 * The official marketplace and the source-id rules every origin shares
 * (design §2.1, §5.1).
 *
 * The official source is a build constant, never a `sources.json` entry, so
 * no file on disk can repoint it. Its repository must be publicly readable: the
 * constant carries `auth: { kind: "none" }`: a fresh profile reads the
 * catalog anonymously, and no stored token is ever offered to it, not even a
 * token stored for the same host by a private source the user added (sync
 * offers a token only to a source whose own auth is `token`).
 */
import { holdsCredential } from "../../shared/dlp.js";

export type SourceAuth = { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };

export interface OfficialMarketplace {
  id: string;
  url: string;
  /** Tried in order after the primary URL; any of them may supply the candidate (§7.3). */
  mirrors: readonly string[];
  auth: SourceAuth;
}

const OFFICIAL_SOURCE_ID = "ave";

export const OFFICIAL_MARKETPLACE: OfficialMarketplace = Object.freeze({
  id: OFFICIAL_SOURCE_ID,
  url: "https://github.com/ken-jo/agent-marketplace",
  mirrors: Object.freeze([]),
  auth: Object.freeze({ kind: "none" }),
});

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;

/**
 * A source id: the grammar, and no credential's shape. The renderer gets an
 * id through the scrubber and sends it back (§18.8), so an id the scrubber
 * would change could never be named again: it is refused where it enters.
 */
export function isSourceId(id: string): boolean {
  return SOURCE_ID_RE.test(id) && !holdsCredential(id);
}

/** `ave`, `official`, `ave-official` and every `ave-*` id; re-checked on every load. */
export function isReservedSourceId(id: string): boolean {
  return id === OFFICIAL_SOURCE_ID || id === "official" || id.startsWith(`${OFFICIAL_SOURCE_ID}-`);
}

const SOURCE_REF_RE = /^[^\u0000-\u0020\u007f~^:?*[\\]{1,200}$/u;

/** A branch or tag name safe to hand to git as a refspec side (repo.ts re-checks it). */
export function isSourceRef(value: unknown): value is string {
  return typeof value === "string" && SOURCE_REF_RE.test(value) && !value.includes("..");
}

const SOURCE_LABEL_RE = /^[^\u0000-\u001f\u007f]{1,100}$/u;

export function isSourceLabel(value: unknown): value is string {
  return typeof value === "string" && SOURCE_LABEL_RE.test(value);
}
