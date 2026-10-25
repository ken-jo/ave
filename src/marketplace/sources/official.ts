/** The official endpoint is a build constant and never receives stored source tokens.
 * OS credential helpers may still answer for its host. */
import { holdsCredential } from "../../shared/dlp.js";

export type SourceAuth = { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };

export interface OfficialMarketplace {
  id: string;
  url: string;
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

/** Reject credential-shaped ids at admission so scrubbing cannot break their round trip. */
export function isSourceId(id: string): boolean {
  return SOURCE_ID_RE.test(id) && !holdsCredential(id);
}

export function isReservedSourceId(id: string): boolean {
  return id === OFFICIAL_SOURCE_ID || id === "official" || id.startsWith(`${OFFICIAL_SOURCE_ID}-`);
}

const SOURCE_REF_RE = /^[^\u0000-\u0020\u007f~^:?*[\\]{1,200}$/u;

export function isSourceRef(value: unknown): value is string {
  return typeof value === "string" && SOURCE_REF_RE.test(value) && !value.includes("..");
}

const SOURCE_LABEL_RE = /^[^\u0000-\u001f\u007f]{1,100}$/u;

export function isSourceLabel(value: unknown): value is string {
  return typeof value === "string" && SOURCE_LABEL_RE.test(value);
}
