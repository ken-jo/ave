/**
 * The tree digest (design §6.4): sha256 over `"<mode> <sha256(file)> <path>\n"`
 * for every installed file, sorted by path bytes. A tree-rung plugin, a
 * folder package and installed content are all named by it.
 */
import { createHash } from "node:crypto";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function treeDigest(files: ReadonlyArray<{ path: string; data: Buffer; executable: boolean }>): string {
  const lines = files
    .map((file) => ({ key: Buffer.from(file.path, "utf8"), line: `${file.executable ? "100755" : "100644"} ${sha256(file.data)} ${file.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return hash.digest("hex");
}
