import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMainBundleManifest,
  isSafeMainBundleManifestPath,
} from "../../scripts/lib/main-bundle-budget.mjs";
import { MAIN_ENTRY_POINTS } from "../../scripts/lib/main-entry-points.mjs";

describe("main bundle manifest", () => {
  it("allows every emitted main bundle entry in the package footprint", () => {
    const outdir = resolve("dist/src/main");
    const outputs = Object.fromEntries<{ bytes: number }>(
      Object.keys(MAIN_ENTRY_POINTS).map((entry) => [join(outdir, `${entry}.js`), { bytes: 1 }]),
    );
    const manifest = createMainBundleManifest({ outputs }, { outdir });

    expect(manifest.files.filter(({ path }) => !isSafeMainBundleManifestPath(path))).toStrictEqual([]);
  });
});
