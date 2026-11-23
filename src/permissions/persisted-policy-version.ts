import { resolve } from "node:path";
import { canonicalStringify } from "../shared/canonical-json.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { readAveHomeInputSync } from "../shared/ave-home-trust.js";

export const STALE_PERMISSION_POLICY = { code: "policy-changed", reason: "Permission policy changed before execution." } as const;

export class StalePermissionPolicyError extends Error {
  constructor() {
    super(STALE_PERMISSION_POLICY.reason);
    this.name = "StalePermissionPolicyError";
  }
}

export interface PersistedPolicyVersion {
  readonly filePath: string;
  readonly digest: string | null;
  readonly contentsDigest: string;
}

// The exact written bytes and their parsed document must describe the same policy.
export function persistedPolicyVersionForContent(filePath: string, raw: string | Uint8Array): PersistedPolicyVersion {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  return Object.freeze({
    filePath: resolve(filePath),
    digest: sha256Hex(raw),
    contentsDigest: sha256Hex(canonicalStringify(text.trim() ? JSON.parse(text) : null)),
  });
}

// Absence and empty lock placeholders are versions; read and JSON errors are not.
export function capturePersistedPolicyVersion(filePath: string): PersistedPolicyVersion | undefined {
  filePath = resolve(filePath);
  try {
    const input = readAveHomeInputSync(filePath, { requireRegularFile: true });
    if (input.status === "untrusted") return undefined;
    if (input.status === "trusted") return persistedPolicyVersionForContent(filePath, input.bytes);
    return Object.freeze({ filePath, digest: null, contentsDigest: sha256Hex("null") });
  } catch {
    return undefined;
  }
}

// Verify the loaded digest against the same trust verdict used by the covered-input loader.
export function isPersistedPolicyVersionCurrent({ filePath, digest }: Pick<PersistedPolicyVersion, "filePath" | "digest">): boolean {
  try {
    const input = readAveHomeInputSync(filePath, { requireRegularFile: true });
    return input.status === "absent" ? digest === null
      : input.status === "trusted" && sha256Hex(input.bytes) === digest;
  } catch {
    return false;
  }
}
