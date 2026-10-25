import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";

interface FlushableResource {
  flush(): Promise<void>;
}

export class PermissionTestResources {
  private readonly tmpDirs: string[] = [];
  private readonly flushables = new Set<FlushableResource>();

  constructor(
    private readonly cleanupDir: (dir: string) => Promise<void> = cleanupTmpDir,
  ) {}

  makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.tmpDirs.push(dir);
    return dir;
  }

  // Each path owns a fresh scratch directory; keep cleanup on this factory instance because suites can clean and allocate again mid-test.
  tmpFilePaths(prefix: string, fileName: string): () => string {
    const inFreshDir = this.tmpFileFactory(prefix);
    return () => inFreshDir(fileName);
  }

  // The same factory for a suite that names more than one file. A permissions store, a verdict cache and a deferred queue are three files under one subject, and three more suites wrapped `makeTmpDir` + `join` locally to say so; only the file name varies per call, and it stays at the call site.
  tmpFileFactory(prefix: string): (fileName: string) => string {
    return (fileName) => join(this.makeTmpDir(prefix), fileName);
  }

  trackFlushable<T extends FlushableResource>(resource: T): T {
    this.flushables.add(resource);
    return resource;
  }

  makeVerdictCache(path: string): VerdictCache {
    return this.trackFlushable(new VerdictCache(path));
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    let flushFailed = false;

    for (const resource of [...this.flushables]) {
      try {
        await resource.flush();
        this.flushables.delete(resource);
      } catch (error) {
        flushFailed = true;
        errors.push(error);
      }
    }

    const cleanedDirs: string[] = [];
    for (const dir of [...this.tmpDirs]) {
      try {
        await this.cleanupDir(dir);
        cleanedDirs.push(dir);
      } catch (error) {
        errors.push(error);
      }
    }

    if (!flushFailed) {
      for (const dir of cleanedDirs) {
        const index = this.tmpDirs.indexOf(dir);
        if (index >= 0) this.tmpDirs.splice(index, 1);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to clean up permission test resources");
    }
  }
}
