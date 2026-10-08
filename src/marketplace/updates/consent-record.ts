/**
 * The stored form of a consent fingerprint (design §18.7.3): the baseline a
 * receipt's `git`/`folder` record, a content ledger entry and an MCP install
 * record keep. Free of other imports, so every store that validates one can
 * read it without pulling in how a fingerprint is computed
 * (`consent.ts`).
 */
import { PACKAGE_KINDS, type PackageKind } from "../catalog/types.js";

type ConsentJson = null | boolean | number | string | ConsentJson[] | { [key: string]: ConsentJson };

/** What the user agreed to, field by field. `unknown` names the fields that could not be computed. */
export interface ConsentFingerprint {
  kind: PackageKind;
  fields: Record<string, ConsentJson>;
  unknown: string[];
}

const KINDS = new Set<string>(PACKAGE_KINDS);

function isConsentJson(value: unknown, depth = 0): value is ConsentJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isConsentJson(item, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every((item) => isConsentJson(item, depth + 1));
  return false;
}

/**
 * Read a stored fingerprint exactly: `kind`, `fields` and `unknown` and
 * nothing else. Throws on any other shape: a baseline is never guessed.
 */
export function parseConsentFingerprint(value: unknown, what: string): ConsentFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not a consent fingerprint`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "fields" && key !== "unknown")) throw new Error(`${what} has an unknown field`);
  if (typeof record.kind !== "string" || !KINDS.has(record.kind)) throw new Error(`${what}.kind is not a package kind`);
  if (typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields) || !isConsentJson(record.fields)) {
    throw new Error(`${what}.fields is not a JSON object`);
  }
  if (!Array.isArray(record.unknown) || !record.unknown.every((field) => typeof field === "string")) throw new Error(`${what}.unknown is not a list of fields`);
  return { kind: record.kind as PackageKind, fields: record.fields as Record<string, ConsentJson>, unknown: [...record.unknown as string[]] };
}
