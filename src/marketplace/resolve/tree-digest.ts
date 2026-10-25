/** SHA-256 of mode, file hash and path lines sorted by path bytes names every installed tree. */
import { createHash } from "node:crypto";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

export function treeDigest(files: ReadonlyArray<{ path: string; data: Buffer; executable: boolean }>): string {
  const lines = files
    .map((file) => ({ key: Buffer.from(file.path, "utf8"), line: `${file.executable ? "100755" : "100644"} ${sha256Hex(file.data)} ${file.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return hash.digest("hex");
}
