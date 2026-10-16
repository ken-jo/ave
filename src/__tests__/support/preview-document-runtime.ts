import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  buildMainBoundaryBundle,
  repositoryRoot,
} from "../../plugins/isolation/__tests__/child-entry-bundle.js";

/** The same split bundle and runtime path relationship as the shipped child. */
export async function buildPreviewDocumentRuntime(): Promise<string> {
  const cache = join(repositoryRoot(), ".cache");
  mkdirSync(cache, { recursive: true });
  const outdir = mkdtempSync(join(cache, "preview-document-runtime-"));
  await buildMainBoundaryBundle({
    entryPoints: {
      "preview-document-child-main": join(repositoryRoot(), "src/tools/preview-document-child-main.ts"),
      "table-document-reader": join(repositoryRoot(), "src/tools/table-document-reader.ts"),
    },
    outdir,
    splitting: true,
  });
  copyFileSync(join(outdir, "preview-document-child-main.mjs"), join(outdir, "preview-document-child-main.js"));
  return outdir;
}
