import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_STITCH_CHILD_FILE } from "../../main/browser/browser-capture-stitch-protocol.js";
import { buildMainBoundaryBundle, repositoryRoot } from "../../plugins/isolation/__tests__/child-entry-bundle.js";

export async function buildBrowserCaptureStitchChild(outdir: string): Promise<void> {
  await buildMainBoundaryBundle({
    entryPoints: { "browser-capture-stitch-child": join(repositoryRoot(), "src/main/browser/browser-capture-stitch-child-main.ts") },
    outdir,
    splitting: true,
  });
  copyFileSync(join(outdir, "browser-capture-stitch-child.mjs"), join(outdir, CAPTURE_STITCH_CHILD_FILE));
}
