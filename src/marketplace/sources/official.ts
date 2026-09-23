/**
 * The official marketplace and the source-id rules every origin shares
 * (design §2.1, §5.1).
 *
 * The official source is a build constant, never a `sources.json` entry, so
 * no file on disk can repoint it. While this design is being built the
 * repository is private (decided 2026-09-23: the `former_org` organization
 * cannot host a new public repository or run CI), so the constant carries
 * token auth for github.com. Before the first public release built on this
 * design the repository becomes publicly readable or moves, and that
 * release's constant carries the public URL with `auth: { kind: "none" }`.
 */
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
  url: "https://github.com/ken-jo/ave-marketplace-index",
  mirrors: Object.freeze([]),
  auth: Object.freeze({ kind: "token", host: "github.com" }),
});

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;

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
