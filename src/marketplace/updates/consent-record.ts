/** Import-free persisted consent shape shared by receipt and ledger validators. */
import { PACKAGE_KINDS, type PackageKind } from "../catalog/types.js";

type ConsentJson = null | boolean | number | string | ConsentJson[] | { [key: string]: ConsentJson };

/** Unknown fields cannot establish consent. */
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

/** Reject extra or malformed fingerprint fields rather than guess a baseline. */
function parseFingerprint(value: unknown, what: string): { kind: string; fields: ConsentFingerprint["fields"]; unknown: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not a consent fingerprint`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "fields" && key !== "unknown")) throw new Error(`${what} has an unknown field`);
  if (typeof record.kind !== "string") throw new Error(`${what}.kind is not a package kind`);
  if (typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields) || !isConsentJson(record.fields)) {
    throw new Error(`${what}.fields is not a JSON object`);
  }
  if (!Array.isArray(record.unknown) || !record.unknown.every((field) => typeof field === "string")) throw new Error(`${what}.unknown is not a list of fields`);
  return { kind: record.kind, fields: record.fields as Record<string, ConsentJson>, unknown: [...record.unknown as string[]] };
}

/** Current callers never accept retired consent as install authority. */
export function parseConsentFingerprint(value: unknown, what: string): ConsentFingerprint {
  const fingerprint = parseFingerprint(value, what);
  if (!KINDS.has(fingerprint.kind)) throw new Error(`${what}.kind is not a package kind`);
  return { ...fingerprint, kind: fingerprint.kind as PackageKind };
}

/** Validate the released fingerprint before its containing retired ledger entry is removed. */
export function assertRetiredThemeConsent(value: unknown, what: string): void {
  const fingerprint = parseFingerprint(value, what);
  if (fingerprint.kind !== "theme") throw new Error(`${what}.kind is not a package kind`);
}
