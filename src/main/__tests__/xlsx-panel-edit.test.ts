import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XlsxPanelEditService } from "../xlsx-panel-edit.js";
import { editWorkbookFile, inspectWorkbookCell } from "../../skills/xlsx-edit.js";
import { readPreviewDocumentSnapshot } from "../../tools/preview-document-input.js";
import { parseTableDocument } from "../../tools/table-document-reader.js";
import type { PreviewTableSheet } from "../../shared/preview-document.js";
import { XLSX_EDIT_LIMITS } from "../../shared/xlsx-panel-edit.js";
import { requireSymlinkCapability } from "../../__tests__/support/symlink-capability.js";

const SHEET: PreviewTableSheet = { index: 0, name: "Budget", rows: [["Budget", "12"]], firstRow: 0, firstColumn: 0,
  totalRows: 1, totalColumns: 2, rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [] };
function workbook(value = 12): Buffer {
  const result = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet([["Budget", value]]), "Budget");
  return XLSX.write(result, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
let directory: string;
let path: string;
let current: boolean;
const runtime = {
  checkAvailable: vi.fn<() => void | Promise<void>>(),
  run: vi.fn(async (root: string, operation: "edit" | "inspect") => {
    expect(root === realpathSync(root)).toBe(true);
    const input = join(root, "workbook.xlsx");
    const request: unknown = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
    const result = operation === "inspect" ? inspectWorkbookCell(readFileSync(input), request) : await editWorkbookFile(input, request);
    return { stdout: JSON.stringify(result) };
  }),
};
const execute = runtime.run.getMockImplementation()!;
let service: XlsxPanelEditService;
async function bind(target = path, owner = "frame-one") {
  const revision = service.beginRead(owner);
  const token = service.bind(owner, revision, target, await readPreviewDocumentSnapshot(target), SHEET,
    () => current, () => () => {})!;
  return token;
}
async function save(token: string, value = 84) {
  return service.handle("frame-one", { action: "save", token, row: 0, column: 1, value });
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-panel-edit-")));
  path = join(directory, "budget.xlsx");
  writeFileSync(path, workbook());
  current = true;
  runtime.checkAvailable.mockReset(); runtime.run.mockReset(); runtime.run.mockImplementation(execute);
  service = new XlsxPanelEditService(runtime);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("user workbook edit authority", () => {
  it("inspects raw values and saves the opened workbook directly through the shared writer", async () => {
    const { editToken } = await bind();
    expect(await service.handle("frame-one", { action: "cell", token: editToken, row: 0, column: 1 }))
      .toEqual({ ok: true, action: "cell", value: 12, formula: false });
    expect(await save(editToken)).toEqual({ ok: true, action: "save" });
    const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
    expect(document.sheet.rows).toEqual([["Budget", "84"]]);
    expect(document.needsRecalculation).toBe(true);
    expect(existsSync(path + ".ave-bak")).toBe(false);
    expect(await save(editToken, 85)).toEqual({ ok: false, error: "expired" });
  });

  it.each(["path", "script", "backup", "environment"])("refuses a renderer-selected %s field", async (key) => {
    const { editToken } = await bind();
    const before = readFileSync(path);
    expect(await service.handle("frame-one", { action: "save", token: editToken, row: 0, column: 1, value: 84,
      [key]: join(directory, "other.xlsx") })).toEqual({ ok: false, error: "invalid-request" });
    expect(runtime.run).not.toHaveBeenCalled();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses another frame and a replaced preview identity", async () => {
    const { editToken } = await bind();
    expect(await service.handle("frame-two", { action: "cell", token: editToken, row: 0, column: 1 })).toEqual({ ok: false, error: "expired" });
    service.beginRead("frame-one");
    expect(await save(editToken)).toEqual({ ok: false, error: "expired" });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("refuses unsupported cells outside the displayed source rectangle", async () => {
    const { editToken } = await bind();
    expect(await service.handle("frame-one", { action: "save", token: editToken, row: 1, column: 1, value: 84 }))
      .toEqual({ ok: false, error: "unsupported-cell" });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("refuses stale disk bytes before running or creating a backup", async () => {
    const { editToken } = await bind();
    writeFileSync(path, workbook(77));
    expect(await save(editToken)).toEqual({ ok: false, error: "stale-file" });
    expect(runtime.run).not.toHaveBeenCalled();
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Budget", "77"]]);
    expect(existsSync(path + ".ave-bak")).toBe(false);
  });

  it("retains bytes when viewer scope is lost", async () => {
    const { editToken } = await bind(); const before = readFileSync(path);
    current = false;
    expect(await save(editToken)).toEqual({ ok: false, error: "expired" });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses an external change made while the confined edit runs", async () => {
    const { editToken } = await bind();
    runtime.run.mockImplementationOnce(async (root, operation) => {
      const result = await execute(root, operation);
      writeFileSync(path, workbook(77));
      return result;
    });
    expect(await save(editToken)).toEqual({ ok: false, error: "stale-file" });
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Budget", "77"]]);
    expect(existsSync(path + ".ave-bak")).toBe(false);
  });

  it("refuses unavailable confinement or integrity before editing", async () => {
    const { editToken } = await bind();
    runtime.checkAvailable.mockImplementation(() => { throw Object.assign(new Error("unavailable"),
      { name: "BundledScriptExecutionError", code: "integrity" }); });
    expect(await save(editToken))
      .toEqual({ ok: false, error: "edit-unavailable" });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("an expired operation cannot revoke the next preview's token", async () => {
    const first = await bind();
    let resume!: () => void;
    runtime.checkAvailable.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    const pending = save(first.editToken);
    await Promise.resolve();
    const second = await bind();
    resume();
    expect(await pending).toEqual({ ok: false, error: "expired" });
    expect(await save(second.editToken)).toEqual({ ok: true, action: "save" });
  });

  it("requires a fresh host-bound revision after each save or reload", async () => {
    const first = await bind();
    expect(await save(first.editToken)).toEqual({ ok: true, action: "save" });
    const second = await bind();
    expect(second.editToken).not.toBe(first.editToken);
    expect(await save(first.editToken, 85)).toEqual({ ok: false, error: "expired" });
    expect(await save(second.editToken, 85)).toEqual({ ok: true, action: "save" });
    service.beginRead("frame-one");
    const third = await bind();
    expect(third.editToken).not.toBe(second.editToken);
    expect(await save(third.editToken, 86)).toEqual({ ok: true, action: "save" });
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Budget", "86"]]);
  });

  it("cannot use the old token to edit a newly opened workbook", async () => {
    const first = await bind();
    expect(await save(first.editToken)).toEqual({ ok: true, action: "save" });
    const other = join(directory, "other.xlsx"); writeFileSync(other, workbook());
    const next = await bind(other);
    expect(next.editToken).not.toBe(first.editToken);
    expect(await save(first.editToken)).toEqual({ ok: false, error: "expired" });
    expect(readFileSync(other).equals(workbook())).toBe(true);
  });

  it.each(["invalid package", "different scalar"])("refuses child output containing %s before publication", async (kind) => {
    const before = readFileSync(path);
    const { editToken } = await bind();
    runtime.run.mockImplementationOnce(async (root) => {
      writeFileSync(join(root, "workbook.xlsx"), kind === "invalid package" ? Buffer.from("invalid") : workbook(99));
      return { stdout: JSON.stringify({ editedCells: 1, needsRecalculation: true, backup: null }) };
    });
    expect(await save(editToken)).toEqual({ ok: false, error: "edit-failed" });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  for (const kind of ["symlink", "hardlink"] as const) it(`recreates a child-replaced request ${kind} without writing its target`, async (context) => {
    if (kind === "symlink") requireSymlinkCapability(directory, "file", context.skip);
    const { editToken } = await bind();
    let victim: string | undefined;
    runtime.run.mockImplementationOnce(async (root, operation) => {
      const result = await execute(root, operation);
      victim = join(dirname(root), `${basename(root)}-victim.txt`);
      writeFileSync(victim, "keep");
      const request = join(root, "request.json");
      unlinkSync(request);
      if (kind === "symlink") symlinkSync(victim, request);
      else linkSync(victim, request);
      return result;
    });
    try {
      expect(await save(editToken)).toEqual({ ok: true, action: "save" });
      expect(readFileSync(victim!, "utf8")).toBe("keep");
      expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Budget", "84"]]);
    } finally { if (victim) unlinkSync(victim); }
  });

  it("creates an exact original backup above the shared threshold and leaves sibling files untouched", async () => {
    const zip = await JSZip.loadAsync(workbook());
    zip.file("xl/media/generated.bin", randomBytes(XLSX_EDIT_LIMITS.backupBytes));
    const before = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    writeFileSync(path, before);
    const sibling = join(directory, "sibling.txt"); writeFileSync(sibling, "keep");
    const { editToken } = await bind();
    expect(await save(editToken)).toEqual({ ok: true, action: "save" });
    expect(readFileSync(path + ".ave-bak").equals(before)).toBe(true);
    expect(readFileSync(sibling, "utf8")).toBe("keep");
    expect((await parseTableDocument(readFileSync(path), "xlsx", 0)).sheet.rows).toEqual([["Budget", "84"]]);
    const next = await bind();
    expect(await save(next.editToken, 85)).toEqual({ ok: false, error: "backup-exists" });
    expect(readFileSync(path + ".ave-bak").equals(before)).toBe(true);
  });
});
