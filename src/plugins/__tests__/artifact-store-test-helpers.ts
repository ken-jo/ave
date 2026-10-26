import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PluginArtifactStore,
  type ArtifactStoreOptions,
} from "../plugin-artifact-store.js";

export function makeStore(
  tmpDir: string,
  overrides: Partial<Pick<ArtifactStoreOptions, "artifactLimits">> = {},
): PluginArtifactStore {
  return new PluginArtifactStore({
    installRoot: resolve(tmpDir, "installed"),
    cacheRoot: resolve(tmpDir, "cache"),
    ...overrides,
  });
}

/** Throwaway temp dir; tear down with {@link cleanupTmpDir}, never a bare `rmSync`. */
export function makeTmpDir(prefix = "artifact-store-"): string {
  return mkdtempSync(join(process.cwd(), `.${prefix}`));
}

/** Retry transient Windows locks when removing a fixture directory. */
export { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
