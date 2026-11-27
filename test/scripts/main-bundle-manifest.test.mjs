import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createMainBundleManifest, isSafeMainBundleManifestPath } from "../../scripts/lib/main-bundle-budget.mjs";
import { MAIN_ENTRY_POINTS } from "../../scripts/lib/main-entry-points.mjs";

test("the package footprint accepts each emitted main bundle entry", () => {
  const outdir = resolve("dist/src/main");
  const outputs = Object.fromEntries(Object.keys(MAIN_ENTRY_POINTS).map((entry) => [
    join(outdir, `${entry}.js`),
    { bytes: 1 },
  ]));
  const manifest = createMainBundleManifest({ outputs }, { outdir });

  assert.deepEqual(manifest.files.filter(({ path }) => !isSafeMainBundleManifestPath(path)), []);
});
