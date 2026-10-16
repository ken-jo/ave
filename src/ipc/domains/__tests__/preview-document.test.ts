import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { makeAppIpcFrameInvoker } from "./test-helpers.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewReadDocumentResult } from "../../../shared/preview-document.js";
import { buildPreviewDocumentRuntime } from "../../../__tests__/support/preview-document-runtime.js";
import { cyclicWorkbook } from "../../../__tests__/support/table-document-fixtures.js";

const { handlers, additionalDirectories, childRuntime } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
  childRuntime: { mainDir: "" },
}));

vi.mock("../../../main/main-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../main/main-paths.js")>(),
  get mainDir() { return childRuntime.mainDir; },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: { additionalDirectories: additionalDirectories.value, pendingWorkspaceRootRemovals: [] },
  }),
}));

import { registerPreviewHandlers } from "../preview.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const auditLog = vi.fn();
const deps = { auditLogger: { log: auditLog } } as never;
const invoke = makeAppIpcFrameInvoker(handlers);
const OK_FRAME = "file:///app/index.html";
const EVIL_FRAME = "https://evil.example.com/x";
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let root: string;
let outside: string;

async function readDocument(frame: string, path: unknown, sheetIndex: unknown = 0) {
  return (await invoke(CHANNELS.preview.readDocument, frame, path, sheetIndex)) as PreviewReadDocumentResult;
}

beforeAll(async () => {
  childRuntime.mainDir = await buildPreviewDocumentRuntime();
  root = mkdtempSync(join(tmpdir(), "ave-preview-doc-"));
  outside = mkdtempSync(join(tmpdir(), "ave-preview-doc-outside-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "people.csv"), "name,age\nalice,30\nbob,41\n");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["q", "rev"], ["Q1", 10]]), "Sales");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["note"]]), "Notes");
  writeFileSync(join(root, "data", "book.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const bomb = new AdmZip();
  bomb.addFile("xl/sharedStrings.xml", Buffer.alloc(8 * 1024 * 1024, 0x41));
  writeFileSync(join(root, "data", "bomb.xlsx"), bomb.toBuffer());
  writeFileSync(join(root, "data", "broken.xlsx"), "this is not a workbook");
  writeFileSync(join(root, "data", "cyclic.xls"), cyclicWorkbook());
  writeFileSync(join(root, "data", "broken.csv"), 'a,b\n"unterminated,2');
  writeFileSync(join(root, "notes.txt"), "plain");
  writeFileSync(join(root, "data", "huge.csv"), "");
  truncateSync(join(root, "data", "huge.csv"), PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1);
  writeFileSync(join(outside, "secret.csv"), "k,v\napi,123\n");
  symlinkSync(outside, join(root, "link-out"), dirLinkType);
  registerPreviewHandlers(deps);
});

afterAll(async () => {
  await cleanupTmpDir(root);
  await cleanupTmpDir(outside);
  await cleanupTmpDir(childRuntime.mainDir);
});

beforeEach(() => {
  additionalDirectories.value = [root];
  auditLog.mockClear();
});

describe("preview:read-document handler", () => {
  it("returns a parsed table for a CSV inside the allow-list, never raw bytes", async () => {
    const res = await readDocument(OK_FRAME, join(root, "data", "people.csv"));
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect(res.document.format).toBe("csv");
    expect(res.document.sheet.rows).toEqual([["name", "age"], ["alice", "30"], ["bob", "41"]]);
    expect(JSON.stringify(res)).not.toContain("content");
  });

  it("returns the requested workbook sheet and the tab list", async () => {
    const res = await readDocument(OK_FRAME, join(root, "data", "book.xlsx"), 1);
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect(res.document.sheetNames).toEqual(["Sales", "Notes"]);
    expect(res.document.sheet).toMatchObject({ index: 1, name: "Notes", rows: [["note"]] });
  });

  it("audits a successful read with a redacted path", async () => {
    await readDocument(OK_FRAME, join(root, "data", "people.csv"));
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining(CHANNELS.preview.readDocument),
    }));
  });

  it("rejects a non-host frame", async () => {
    const res = await readDocument(EVIL_FRAME, join(root, "data", "people.csv"));
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("applies the read_file guard: outside the allow-list, through a symlink, sensitive paths, globs", async () => {
    expect(await readDocument(OK_FRAME, join(outside, "secret.csv"))).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(await readDocument(OK_FRAME, join(root, "link-out", "secret.csv"))).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(await readDocument(OK_FRAME, join(homedir(), ".ssh", "known_hosts.csv"))).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(await readDocument(OK_FRAME, "**/*.csv")).toMatchObject({ ok: false, error: "not-a-file" });
  });

  it("rejects bad arguments and non-table files", async () => {
    expect(await readDocument(OK_FRAME, "")).toMatchObject({ ok: false, error: "not-a-file" });
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"), -1)).toMatchObject({ ok: false, error: "sheet-not-found" });
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"), "0")).toMatchObject({ ok: false, error: "sheet-not-found" });
    expect(await readDocument(OK_FRAME, join(root, "notes.txt"))).toMatchObject({ ok: false, error: "unsupported-format" });
    expect(await readDocument(OK_FRAME, join(root, "data", "missing.csv"))).toMatchObject({ ok: false, error: "read-failed" });
    expect(await readDocument(OK_FRAME, join(root, "data"))).toMatchObject({ ok: false, error: "unsupported-format" });
  });

  it("refuses an over-size file from its stat, before reading it", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "huge.csv"))).toMatchObject({
      ok: false,
      error: "too-large",
      bytes: PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1,
    });
  });

  it("refuses a zip bomb and a corrupt workbook with distinct codes", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "bomb.xlsx"))).toMatchObject({ ok: false, error: "archive-too-large" });
    expect(await readDocument(OK_FRAME, join(root, "data", "broken.xlsx"))).toMatchObject({ ok: false, error: "corrupt-document" });
  });

  it("maps fatal delimited errors through the private document channel", async () => {
    expect(await readDocument(OK_FRAME, join(root, "data", "broken.csv")))
      .toMatchObject({ ok: false, error: "corrupt-document" });
  });

  it("keeps the host responsive and reaps a cyclic document at the deadline", async () => {
    let ticks = 0;
    const pulse = setInterval(() => { ticks += 1; }, 20);
    const started = performance.now();
    try {
      expect(await readDocument(OK_FRAME, join(root, "data", "cyclic.xls")))
        .toMatchObject({ ok: false, error: "parse-limit" });
    } finally {
      clearInterval(pulse);
    }
    expect(ticks).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
    expect(await readDocument(OK_FRAME, join(root, "data", "people.csv"))).toMatchObject({ ok: true });
  });
});
