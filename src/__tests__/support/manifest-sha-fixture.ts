/**
 * The manifest digest an install receipt / rollback record carries:
 * sha256 over the canonical-JSON form, hex. Shared so the suites that compute
 * it do not drift from the canonical form.
 */
import { createHash } from "node:crypto";
import { canonicalJSON } from "../../plugins/secret-access/canonical-json.js";

export function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}
