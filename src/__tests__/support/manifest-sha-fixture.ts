/** Receipts use a hex SHA-256 of canonical manifest JSON. */
import { createHash } from "node:crypto";
import { canonicalJSON } from "../../plugins/secret-access/canonical-json.js";

export function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}
