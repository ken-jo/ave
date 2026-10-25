import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalStringify } from "../shared/canonical-json.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";

export interface PersistedPolicyVersion {
  readonly filePath: string;
  readonly digest: string | null;
  readonly contentsDigest: string;
}

/** The exact written bytes and their parsed document must describe the same policy. */
export function persistedPolicyVersionForContent(filePath: string, raw: string | Uint8Array): PersistedPolicyVersion {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  return Object.freeze({
    filePath: resolve(filePath),
    digest: sha256Hex(raw),
    contentsDigest: sha256Hex(canonicalStringify(text.trim() ? JSON.parse(text) : null)),
  });
}

/** Absence and empty lock placeholders are versions; read and JSON errors are not. */
export function capturePersistedPolicyVersion(filePath: string): PersistedPolicyVersion | undefined {
  filePath = resolve(filePath);
  try {
    return persistedPolicyVersionForContent(filePath, readFileSync(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    // A dangling component must not masquerade as an absent rule store.
    for (let candidate = filePath; ; candidate = dirname(candidate)) {
      try {
        lstatSync(candidate);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        if (dirname(candidate) === candidate) return undefined;
        continue;
      }
      if (candidate === filePath) return undefined;
      try { if (!statSync(candidate).isDirectory()) return undefined; } catch { return undefined; }
      return Object.freeze({ filePath, digest: null, contentsDigest: sha256Hex("null") });
    }
  }
}

export function isPersistedPolicyVersionCurrent(version: PersistedPolicyVersion): boolean {
  const current = capturePersistedPolicyVersion(version.filePath);
  return current !== undefined && current.digest === version.digest;
}
