import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";

/** Keep an existing-directory control alive across empty mount-point cleanup. */
export function retainDirectoryFixture(root: string): () => Promise<void> {
  mkdirSync(root, { recursive: true });
  const holder = mkdtempSync(join(root, "ave-confinement-"));
  // Other suites or runtime consumers may own the parent and its contents.
  return () => cleanupTmpDir(holder);
}
