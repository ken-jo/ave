import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPreviewDocumentRuntime } from "../../__tests__/support/preview-document-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { cyclicWorkbook, offsetWorkbook } from "../../__tests__/support/table-document-fixtures.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewDocumentFormat } from "../../shared/preview-document.js";
import { asarCliPath } from "../../../test/scripts/gate-script-runner.js";

const { runtime } = vi.hoisted(() => ({ runtime: { mainDir: "" } }));
vi.mock("../../main/main-paths.js", () => ({ get mainDir() { return runtime.mainDir; } }));

import { acquireParseSlot } from "../preview-document-process.js";
import { DOCUMENT_PARSE_READY } from "../preview-document-protocol.js";
import * as managedChildren from "../../main/managed-child-processes.js";

const { getManagedChildProcessCount } = managedChildren;

let bundleDir: string;
let entry: string;
let original: string;
let ownerId = 0;

async function parseTableDocumentIsolated(bytes: Buffer, format: PreviewDocumentFormat, sheetIndex: number) {
  const slot = await acquireParseSlot(`document-test:${++ownerId}`);
  try {
    return await slot.parse(bytes, format, sheetIndex);
  } finally {
    slot.release();
  }
}

beforeAll(async () => {
  bundleDir = await buildPreviewDocumentRuntime();
  runtime.mainDir = bundleDir;
  entry = join(bundleDir, "preview-document-child-main.js");
  original = readFileSync(entry, "utf8");
});
afterEach(() => {
  runtime.mainDir = bundleDir;
  writeFileSync(entry, original);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await cleanupTmpDir(bundleDir);
  // The ordinary filesystem sees the archive as a file during removal.
  const originalFs = createRequire(import.meta.url)("original-fs") as typeof import("node:fs");
  originalFs.rmSync(`${bundleDir}.asar`, { force: true });
});

function childProgram(body: string): void {
  writeFileSync(entry, `process.stdout.write(${JSON.stringify(DOCUMENT_PARSE_READY)});\nfor await (const chunk of process.stdin) { /* Drain admitted bytes. */ }\n${body}`);
}

async function runProbe(program: string): Promise<Record<string, number>> {
  const child = spawn(process.execPath, [
    `--max-old-space-size=${PREVIEW_DOCUMENT_LIMITS.maxOldSpaceMb}`,
    "--input-type=module", "-e", program,
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs);
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) { reject(new Error(`Probe failed: ${signal ?? code}: ${stderr}`)); return; }
      resolve(JSON.parse(stdout) as Record<string, number>);
    });
  });
}

describe("isolated table parsing", () => {
  it("returns only the bounded display model from a real split child bundle", async () => {
    const document = await parseTableDocumentIsolated(Buffer.from("a,b\n1,2"), "csv", 0);
    expect(document.sheet.rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(Object.keys(document)).toEqual(["format", "sheetNames", "totalSheets", "sheetsTruncated", "sheet"]);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("kills cyclic sibling pointers and releases the parse slot", async () => {
    const before = getManagedChildProcessCount();
    const started = performance.now();
    let pulses = 0;
    const timer = setInterval(() => { pulses += 1; }, 20);
    try {
      await expect(parseTableDocumentIsolated(cyclicWorkbook(), "xls", 0)).rejects.toMatchObject({ code: "parse-limit" });
    } finally {
      clearInterval(timer);
    }
    expect(pulses).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
    expect(getManagedChildProcessCount()).toBe(before);
    expect((await parseTableDocumentIsolated(Buffer.from("still,responsive"), "csv", 0)).sheet.rows)
      .toEqual([["still", "responsive"]]);
  });

  it("reports a different sender's occupied slot as busy", async () => {
    const pending = parseTableDocumentIsolated(cyclicWorkbook(), "xls", 0);
    const refused = await parseTableDocumentIsolated(Buffer.from("a"), "csv", 0).catch((error: unknown) => error);
    await expect(pending).rejects.toMatchObject({ code: "parse-limit" });
    expect(refused).toMatchObject({ code: "busy" });
  });

  it("reports heap exhaustion clearly without retaining fatal diagnostics", async () => {
    childProgram("const retained=[]; for (;;) retained.push(new Array(4000000).fill('cell')); ");
    const spawned = vi.spyOn(managedChildren, "spawnManaged");
    const stopped = vi.spyOn(managedChildren, "forceKillManagedChildProcess");
    try {
      await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({
        code: "parse-limit", message: "Document parsing exceeded its resource budget.",
      });
      const child = spawned.mock.results[0]!.value;
      expect(child.spawnargs).toContain(`--max-old-space-size=${PREVIEW_DOCUMENT_LIMITS.maxOldSpaceMb}`);
      // A forced deadline kill would not prove heap-limit enforcement.
      expect(child.signalCode).not.toBe("SIGKILL");
      expect(stopped).not.toHaveBeenCalled();
      expect(spawned.mock.calls[0]![2].env).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      spawned.mockRestore();
      stopped.mockRestore();
    }
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("force-kills a non-allocating loop at the wall-clock deadline", async () => {
    childProgram("for (;;) {}");
    const stopped = vi.spyOn(managedChildren, "forceKillManagedChildProcess");
    const started = performance.now();
    try {
      await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "parse-limit" });
      expect(stopped).toHaveBeenCalled();
      expect(performance.now() - started).toBeGreaterThanOrEqual(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs);
      expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
      expect(getManagedChildProcessCount()).toBe(0);
    } finally {
      stopped.mockRestore();
    }
  });

  it("parses a newline-only file at the byte cap within the time and memory budgets", async () => {
    const parserUrl = pathToFileURL(join(bundleDir, "table-document-reader.mjs")).href;
    const limits = PREVIEW_DOCUMENT_LIMITS;
    const result = await runProbe(`
      import {parseTableDocument} from ${JSON.stringify(parserUrl)};
      const started = performance.now();
      const document = await parseTableDocument(Buffer.alloc(${limits.maxFileBytes}, 10), 'csv', 0);
      console.log(JSON.stringify({ elapsedMs: performance.now()-started,
        maxRssKiB: process.resourceUsage().maxRSS, rows: document.sheet.rows.length,
        totalRows: document.sheet.totalRows, truncated: Number(document.sheet.rowsTruncated) }));
    `);
    console.info("newline preview resource measurement", result);
    expect(result.elapsedMs).toBeLessThan(limits.parseTimeoutMs);
    expect(result.maxRssKiB).toBeLessThan(limits.maxOldSpaceMb * 1024);
    expect(result).toMatchObject({ rows: limits.maxRows, totalRows: limits.maxRows + 1, truncated: 1 });
    // Exercise the production transport as well as measuring the parser process.
    const document = await parseTableDocumentIsolated(Buffer.alloc(limits.maxFileBytes, 10), "csv", 0);
    expect(document.sheet.rows).toHaveLength(limits.maxRows);
  });

  it("preserves a late used range across the process boundary", async () => {
    const document = await parseTableDocumentIsolated(offsetWorkbook("xlsx"), "xlsx", 0);
    expect(document.sheet).toMatchObject({
      firstRow: 10_000, totalRows: 2, rows: [["late value", ""], ["", "42"]],
    });
  });

  it("maps an unterminated quoted field to a corruption error", async () => {
    await expect(parseTableDocumentIsolated(Buffer.from('a,b\n"unterminated,2'), "csv", 0))
      .rejects.toMatchObject({ code: "corrupt-document" });
  });

  it.each([
    "process.stdout.write('not-json')",
    "process.stdout.write(JSON.stringify({ok:true}))",
    "process.stdout.write(JSON.stringify({ok:false,error:'unauthorized'}))",
    "process.stdout.write(JSON.stringify({ok:false,error:'busy'}))",
    "process.stdout.write(JSON.stringify({ok:false,error:'superseded'}))",
    "process.stdout.write(JSON.stringify({ok:false,error:'corrupt-document',extra:1}))",
    "process.stdout.write(JSON.stringify({ok:true,document:{format:'csv',sheet:{rows:[['x']]}}}))",
  ])("refuses malformed child output: %s", async (body) => {
    childProgram(body);
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "read-failed" });
  });

  it("terminates a child that exceeds its response budget", async () => {
    childProgram(`process.stdout.write('x'.repeat(${PREVIEW_DOCUMENT_LIMITS.maxResponseBytes + 1}))`);
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "parse-limit" });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("rejects source bytes and sheet indices before spawning", async () => {
    await expect(parseTableDocumentIsolated(Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1), "csv", 0))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", Number.NaN))
      .rejects.toMatchObject({ code: "sheet-not-found" });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("reports a missing installed child as an internal startup failure", async () => {
    runtime.mainDir = join(bundleDir, "missing");
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "read-failed" });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("reports a missing imported chunk as a startup failure", async () => {
    writeFileSync(entry, "import './missing-document-chunk.js';");
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "read-failed" });
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("allows startup beyond the parse deadline and starts parsing after ready", async () => {
    writeFileSync(entry, `
      await new Promise(resolve => setTimeout(resolve, ${PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 150}));
      await import('./preview-document-child-main.mjs');
    `);
    const started = performance.now();
    const document = await parseTableDocumentIsolated(Buffer.from("a,b"), "csv", 0);
    expect(document.sheet.rows).toEqual([["a", "b"]]);
    expect(performance.now() - started).toBeGreaterThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs);
    expect(getManagedChildProcessCount()).toBe(0);
  }, PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs + 2_000);

  it("kills a child that never becomes ready with a startup error", async () => {
    writeFileSync(entry, "for (;;) {}");
    const started = performance.now();
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "read-failed" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs);
    expect(performance.now() - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs + 2_000);
    expect(getManagedChildProcessCount()).toBe(0);
  }, PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs + 2_000);

  it("recognizes a ready marker split across stdout chunks", async () => {
    const expected = await parseTableDocumentIsolated(Buffer.from("a"), "csv", 0);
    writeFileSync(entry, `
      for (const character of ${JSON.stringify(DOCUMENT_PARSE_READY)}) {
        process.stdout.write(character);
        await new Promise(resolve => setImmediate(resolve));
      }
      for await (const chunk of process.stdin) {}
      process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, document: expected }))});
    `);
    expect(await parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).toEqual(expected);
  });

  it("classifies abnormal exit after ready as a parsing resource error", async () => {
    childProgram("process.exit(1);");
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "parse-limit" });
  });

  it("refuses parsing through a released slot", async () => {
    const slot = await acquireParseSlot("released-document");
    slot.release();
    await expect(slot.parse(Buffer.from("a"), "csv", 0)).rejects.toMatchObject({ code: "read-failed" });
    expect(() => slot.release()).toThrow("internal contract");
  });

  it("loads the child and its split chunks from the packaged archive", async () => {
    const packed = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath,
      [asarCliPath(), "pack", bundleDir, `${bundleDir}.asar`], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8",
        timeout: PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs,
      });
    expect(packed.status, packed.stderr).toBe(0);
    runtime.mainDir = `${bundleDir}.asar`;
    const document = await parseTableDocumentIsolated(Buffer.from("packed,cells"), "csv", 0);
    expect(document.sheet.rows).toEqual([["packed", "cells"]]);
  });
});
