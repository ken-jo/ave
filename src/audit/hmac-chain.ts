/** Hash exact serialized rows without newlines; prevHash links predecessors and entryHash authenticates the tail. Store daily seals separately from their chains. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { SHA256_HEX } from "../lib/hex-digest-equal.js";
import { type SecretStore } from "../lib/protected-secret-store.js";
import { parseJsonlLines } from "./jsonl-reader.js";

export * from "../lib/protected-secret-store.js";
export { readStableRegularFileUtf8 } from "../lib/stable-regular-file.js";

export const GENESIS_MARKER = "genesis";
const AUDIT_HMAC_SECRET_NAME = "audit-hmac.key";
const SECRET_AUTHORITY_MAX_BYTES = 4 * 1024;

/** Reuse the persisted HMAC secret; failed storage must refuse chain startup rather than downgrade integrity. */
export function ensureAuditSecret(store: SecretStore): string {
  const existing = store.read(AUDIT_HMAC_SECRET_NAME, SECRET_AUTHORITY_MAX_BYTES);
  if (existing && existing.length >= 32) {
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  store.write(AUDIT_HMAC_SECRET_NAME, generated);
  return generated;
}

export function readExistingAuditSecret(store: SecretStore): string {
  const existing = store.read(AUDIT_HMAC_SECRET_NAME, SECRET_AUTHORITY_MAX_BYTES);
  if (!existing || existing.length < 32) {
    throw new Error("existing audit HMAC secret is unavailable");
  }
  return existing;
}

export function computeLineHmac(secret: string, line: string): string {
  return createHmac("sha256", secret).update(line).digest("hex");
}

/** Compare chain HMACs in constant time; the first row uses the genesis marker. */
export function verifyLineHmac(
  secret: string,
  previousLine: string,
  expectedPrevHash: string,
): boolean {
  const computed = computeLineHmac(secret, previousLine);
  if (!SHA256_HEX.test(expectedPrevHash) || computed.length !== expectedPrevHash.length) return false;
  return timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(expectedPrevHash, "hex"),
  );
}

export function buildChainedEntries<T extends Record<string, unknown>>(
  secret: string,
  entries: T[],
): Array<T & { prevHash: string; entryHash: string }> {
  const out: Array<T & { prevHash: string; entryHash: string }> = [];
  let prevSerialized = GENESIS_MARKER;
  for (const e of entries) {
    const linked = { ...e, prevHash: computeLineHmac(secret, prevSerialized) };
    const withHash = {
      ...linked,
      entryHash: computeLineHmac(secret, JSON.stringify(linked)),
    };
    out.push(withHash as T & { prevHash: string; entryHash: string });
    // Hash exactly the serialized form written to disk for the next predecessor link.
    prevSerialized = JSON.stringify(withHash);
  }
  return out;
}

export type ChainLineVerification =
  | { ok: true; selfAuthenticated: boolean }
  | { ok: false; reason: string };

export function verifyEntryHmac(secret: string, raw: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof parsed.entryHash !== "string") return false;
  const { entryHash, ...unsigned } = parsed;
  return verifyLineHmac(secret, JSON.stringify(unsigned), entryHash);
}

export function verifyChainLine(
  secret: string,
  raw: string,
  previousSerialized: string,
  requireEntryHash: boolean,
): ChainLineVerification {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "json-parse-error" };
  }
  if (typeof parsed.prevHash !== "string") {
    return { ok: false, reason: "missing-prevHash" };
  }
  if (!verifyLineHmac(secret, previousSerialized, parsed.prevHash)) {
    return { ok: false, reason: "hmac-mismatch" };
  }
  if (parsed.entryHash === undefined) {
    return requireEntryHash
      ? { ok: false, reason: "missing-entryHash-after-migration" }
      : { ok: true, selfAuthenticated: false };
  }
  if (typeof parsed.entryHash !== "string") {
    return { ok: false, reason: "invalid-entryHash" };
  }
  if (!verifyEntryHmac(secret, raw)) {
    return { ok: false, reason: "entry-hmac-mismatch" };
  }
  return { ok: true, selfAuthenticated: true };
}

/** Return the first invalid JSON or broken predecessor link, or null for an intact chain. */
export function verifyChain(
  secret: string,
  lines: string[],
): { ok: true } | { ok: false; firstBrokenLineIndex: number; reason: string } {
  let prevSerialized = GENESIS_MARKER;
  let authenticatedRowsStarted = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const result = verifyChainLine(secret, raw, prevSerialized, authenticatedRowsStarted);
    if (!result.ok) {
      return { ok: false, firstBrokenLineIndex: i, reason: result.reason };
    }
    authenticatedRowsStarted ||= result.selfAuthenticated;
    prevSerialized = raw;
  }
  return { ok: true };
}

/** Seal the final serialized row separately so tampering cannot mint a matching seal. */
export function computeDailySeal(secret: string, lastLine: string): string {
  return computeLineHmac(secret, lastLine);
}

export function sealKeyName(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`invalid ISO date for seal name: ${isoDate}`);
  }
  return `audit-seal-${isoDate}`;
}

/** Do not create a seal for a missing or empty file. */
export function sealDayFromFile(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
): string | null {
  if (!existsSync(filePath)) return null;
  const lines = parseJsonlLines(readFileSync(filePath, "utf-8"));
  if (lines.length === 0) return null;
  const seal = computeDailySeal(secret, lines[lines.length - 1]);
  store.write(sealKeyName(isoDate), seal);
  return seal;
}

/** Verify the entire chain before comparing its final seal; distinguish absent seals, broken links, and mismatches. */
export function verifyDailySeal(
  secret: string,
  store: SecretStore,
  filePath: string,
  isoDate: string,
):
  | { ok: true }
  | { ok: false; reason: "no-seal" }
  | { ok: false; reason: "chain-broken"; firstBrokenLineIndex: number }
  | { ok: false; reason: "seal-mismatch" }
  | { ok: false; reason: "no-file" } {
  if (!existsSync(filePath)) return { ok: false, reason: "no-file" };
  const stored = store.read(sealKeyName(isoDate), SECRET_AUTHORITY_MAX_BYTES);
  if (!stored) return { ok: false, reason: "no-seal" };
  const lines = parseJsonlLines(readFileSync(filePath, "utf-8"));
  const chain = verifyChain(secret, lines);
  if (!chain.ok) {
    return {
      ok: false,
      reason: "chain-broken",
      firstBrokenLineIndex: chain.firstBrokenLineIndex,
    };
  }
  const computed = computeDailySeal(secret, lines[lines.length - 1]);
  if (computed.length !== stored.length) return { ok: false, reason: "seal-mismatch" };
  const same = timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(stored, "hex"),
  );
  return same ? { ok: true } : { ok: false, reason: "seal-mismatch" };
}

/** Filter permission rows from mixed forensic logs; the hot path uses a dedicated permission channel. */
export function filterPermissionAuditLines(lines: string[]): string[] {
  return lines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      return typeof parsed.decision === "string" && typeof parsed.auditId === "string";
    } catch {
      return false;
    }
  });
}
