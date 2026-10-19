import type { BigIntStats } from "node:fs";

/** File identifiers must come from stats requested with `{ bigint: true }`. */
export type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

function hasExactIdentity(identity: FileIdentity): boolean {
  return typeof identity.dev === "bigint" && typeof identity.ino === "bigint";
}

/** Numeric identifiers may already have lost bits and cannot establish identity. */
export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasExactIdentity(left) && hasExactIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

/** Decimal components preserve all identifier bits in cache keys and records. */
export function fileIdentityKey(identity: FileIdentity): string {
  if (!hasExactIdentity(identity)) throw new TypeError("File identity requires bigint identifiers");
  return `${identity.dev}:${identity.ino}`;
}
