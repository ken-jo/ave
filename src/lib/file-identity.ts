import type { BigIntStats } from "node:fs";

export type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

function hasExactIdentity(identity: FileIdentity): boolean {
  return typeof identity.dev === "bigint" && typeof identity.ino === "bigint";
}

/** Use bigint stats; numeric file identifiers may have already lost identity bits. */
export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasExactIdentity(left) && hasExactIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

export function fileIdentityKey(identity: FileIdentity): string {
  if (!hasExactIdentity(identity)) throw new TypeError("File identity requires bigint identifiers");
  return `${identity.dev}:${identity.ino}`;
}
