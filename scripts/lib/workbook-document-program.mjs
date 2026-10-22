import { build } from "esbuild";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/** Compile the data parser without host modules or runtime input in its source. */
export async function compileWorkbookDocumentProgram(repoRoot) {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [resolve(repoRoot, "src/tools/workbook-document-parser.ts")],
    platform: "browser", format: "iife", globalName: "workbookDocumentParser",
    bundle: true, write: false, metafile: true, minify: true,
    charset: "utf8", legalComments: "none", logLevel: "silent", preserveSymlinks: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  return { code: result.outputFiles[0].text, inputs,
    watchFiles: inputs.map(path => resolve(repoRoot, path)).filter(path => existsSync(path)) };
}

/** Recompile and watch the same source graph in one-shot and development builds. */
export function workbookDocumentProgramPlugin(repoRoot) {
  return {
    name: "workbook-document-program",
    setup(builder) {
      builder.onResolve({ filter: /\?document-program$/ }, args => {
        if (args.path !== "./workbook-document-parser.js?document-program") {
          return { errors: [{ text: "Unknown document program." }] };
        }
        return { path: "workbook-document-parser", namespace: "document-program" };
      });
      builder.onLoad({ filter: /.*/, namespace: "document-program" }, async () => {
        const compiled = await compileWorkbookDocumentProgram(repoRoot);
        return { contents: `export const WORKBOOK_DOCUMENT_PROGRAM = ${JSON.stringify(compiled.code)};`,
          loader: "js", watchFiles: compiled.watchFiles };
      });
    },
  };
}
