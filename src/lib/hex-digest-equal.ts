/** Validate hex before constant-time comparison: decoding malformed strings truncates or yields empty buffers that can compare equal. */
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

/** Require 64 lowercase hex characters; normalize externally supplied case only at its boundary. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Reject invalid shape before comparison; it cannot match a locally minted digest and reveals no secret. */
export function timingSafeEqualHexDigest(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || !SHA256_HEX.test(left)) return false;
  if (typeof right !== "string" || !SHA256_HEX.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
