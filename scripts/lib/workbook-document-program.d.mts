import type { Plugin } from "esbuild";
export function compileWorkbookDocumentProgram(repoRoot: string): Promise<{
  code: string;
  inputs: string[];
  watchFiles: string[];
}>;
export function workbookDocumentProgramPlugin(repoRoot: string): Plugin;
