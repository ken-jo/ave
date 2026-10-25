import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

export function withTempDirectory(
  prefix: string,
  run: (dir: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await cleanupTmpDir(dir);
    }
  };
}
