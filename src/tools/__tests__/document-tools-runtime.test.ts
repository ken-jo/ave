import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPreviewDocumentRuntime } from "../../__tests__/support/preview-document-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { ReadDocumentTool } from "../file-tools.js";
import { toolResultContentReachesWire, prepareMarkedToolResultsForWire } from "../../engine/wire-serialize.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { genericToModelMessages } from "../../engine/llm/vercel/adapter.js";

const runtime = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../main/main-paths.js", async (original) => ({
  ...await original<typeof import("../../main/main-paths.js")>(),
  get mainDir() { return runtime.directory; },
}));
let directory: string;
beforeAll(async () => {
  runtime.directory = await buildPreviewDocumentRuntime();
  directory = mkdtempSync(join(tmpdir(), "ave-document-runtime-"));
});
afterAll(async () => { await cleanupTmpDir(directory); await cleanupTmpDir(runtime.directory); });
const context = () => ({ cwd: directory, extraAllowedDirectories: [], headless: true, metadata: { sessionId: "document-runtime" } });

describe("registered document reader child integration", () => {
  it.each([{ suffix: "😀tail", clipped: true }, { suffix: "…", clipped: false }])(
    "retains cell clipping provenance through the actual child ($clipped)", async ({ suffix, clipped }) => {
      const path = join(directory, "clipping.csv");
      writeFileSync(path, `h\n${"a".repeat(1999)}${suffix}`);
      const result = await new ReadDocumentTool().execute({ path, selection: {
        kind: "sheet", rowOffset: 1, columnOffset: 0, rowCount: 1, columnCount: 1,
      } }, context());
      expect(result.isError).toBe(false);
      const value = JSON.parse(result.output);
      expect(value.truncation.clippedCells).toEqual(clipped ? [{ row: 1, column: 0 }] : []);
    });
  it("reads a distant delimited window through the child and preserves complete model context", async () => {
    const path = join(directory, "records.csv");
    writeFileSync(path, Array.from({ length: 10020 }, (_, row) => `${row},"cell,${row}"`).join("\n"));
    const result = await new ReadDocumentTool().execute({ path, selection: {
      kind: "sheet", rowOffset: 10001, columnOffset: 1, rowCount: 2, columnCount: 1,
    } }, context());
    expect(result.isError, result.output).toBe(false);
    const value = JSON.parse(result.output);
    expect(value.cells).toEqual([["cell,10001"], ["cell,10002"]]);
    expect(value.usedRange.totalsExact).toBe(false);
    const message = { role: "tool_result", toolUseId: "document-window", toolName: "read_document",
      content: result.output } as GenericMessage;
    expect(toolResultContentReachesWire(message.meta)).toBe(true);
    expect(prepareMarkedToolResultsForWire([message])[0]?.content).toBe(result.output);
  });

  it("returns presentation info and page text without image data", async () => {
    const path = join(directory, "outline.pptx");
    writeFileSync(path, presentationFixture());
    const tool = new ReadDocumentTool();
    const info = await tool.execute({ path, selection: { kind: "info" } }, context());
    expect(info.isError, info.output).toBe(false);
    expect(JSON.parse(info.output).totalPages).toBe(2);
    const page = await tool.execute({ path, selection: { kind: "page", page: 2 } }, context());
    expect(page.isError, page.output).toBe(false);
    expect(JSON.parse(page.output).text).toContain("Last slide");
    expect(page.image).toBeUndefined();
  });

  it("returns a validated existing page PNG only when requested", async () => {
    const path = join(directory, "pages.pdf");
    writeFileSync(path, pdfFixture());
    const tool = new ReadDocumentTool();
    const text = await tool.execute({ path }, context());
    expect(text.isError, text.output).toBe(false);
    expect(text.image).toBeUndefined();
    const visual = await tool.execute({ path, selection: { kind: "page", includeImage: true } }, context());
    expect(visual.isError, visual.output).toBe(false);
    expect(visual.image?.mimeType).toBe("image/png");
    expect(visual.image?.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.from(visual.image!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(visual.output).not.toContain(visual.image!.data);
    expect(JSON.parse(visual.output).text).toContain("First PDF page");
    const messages = genericToModelMessages([{ role: "tool_result", toolUseId: "document-image",
      toolName: "read_document", content: visual.output, image: visual.image }], "claude");
    expect(messages[0]).toMatchObject({ role: "tool", content: [{ output: { type: "content",
      value: expect.arrayContaining([expect.objectContaining({ type: "file", mediaType: "image/png" })]) } }] });
  });
});
