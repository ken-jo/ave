import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, afterAll } from "vitest";
import type { parseTableDocument as readCompiledTableDocument, TableDocumentLimits } from "../../tools/table-document-reader.js";
import type { TableDocumentError as SourceDocumentError } from "../../tools/table-document-error.js";
import { buildPreviewDocumentRuntime } from "./preview-document-runtime.js";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";

export type { TableDocumentLimits };
export type TableDocumentError = SourceDocumentError;
export let TableDocumentError: typeof SourceDocumentError;
let reader: typeof readCompiledTableDocument;
let directory: string;

beforeAll(async () => {
  directory = await buildPreviewDocumentRuntime();
  const module = await import(pathToFileURL(join(directory, "table-document-reader.mjs")).href);
  reader = module.parseTableDocument;
  TableDocumentError = module.TableDocumentError;
});
afterAll(async () => { if (directory) await cleanupTmpDir(directory); });

/** Exercise the compiled parser program and runtime that the child actually ships. */
export function parseTableDocument(...args: Parameters<typeof readCompiledTableDocument>): ReturnType<typeof readCompiledTableDocument> {
  return reader(...args);
}
