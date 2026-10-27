import { createHash } from "node:crypto";

export function contentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
