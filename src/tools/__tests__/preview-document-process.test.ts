import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPreviewDocumentRuntime } from "../../__tests__/support/preview-document-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { cyclicWorkbook, offsetWorkbook } from "../../__tests__/support/table-document-fixtures.js";
import { pdfFixture, presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import type { PreviewPageFormat } from "../../shared/preview-page-document.js";
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
  try {
    originalFs.rmSync(`${bundleDir}.asar`, { force: true });
  } catch (error) {
    // Electron keeps an archive it has read open without share-delete for the
    // life of this worker, so Windows refuses the removal until it exits.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
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
  it("transports absolute windows to the isolated parser", async () => {
    const slot = await acquireParseSlot("window-transport");
    try {
      const document = await slot.parse(offsetWorkbook("xlsx"), "xlsx", 0,
        { rowOffset: 10001, columnOffset: 1, rowCount: 1, columnCount: 1 });
      expect(document.sheet).toMatchObject({ firstRow: 10001, firstColumn: 1, rows: [["42"]],
        sourceRange: { firstRow: 10000, firstColumn: 0 } });
    } finally { slot.release(); }
  });

  it("refuses malformed windows before spawning a child", async () => {
    const slot = await acquireParseSlot("invalid-window");
    const spawned = vi.spyOn(managedChildren, "spawnManaged");
    try {
      await expect(slot.parse(Buffer.from("a,b"), "csv", 0,
        { rowOffset: -1, rowCount: 1, columnCount: 1 })).rejects.toMatchObject({ code: "invalid-index" });
      expect(spawned).not.toHaveBeenCalled();
    } finally { spawned.mockRestore(); slot.release(); }
  });

  it.each([
    '{"rowCount":0,"columnCount":1}',
    '{"rowCount":1,"columnCount":1,"extra":true}',
    'not-json',
  ])("rejects malformed window arguments in the child: %s", (windowArg) => {
    const child = spawnSync(process.execPath, [entry, "csv", "0", "0", windowArg], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8",
      timeout: PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(JSON.stringify({ ok: false, error: "read-failed" }));
  });

  it("does not accept a default preview response for a window request", async () => {
    const expected = await parseTableDocumentIsolated(Buffer.from("a,b"), "csv", 0);
    childProgram(`process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, document: expected }))})`);
    const slot = await acquireParseSlot("mismatched-window");
    try {
      await expect(slot.parse(Buffer.from("a,b"), "csv", 0,
        { rowCount: 1, columnCount: 1 })).rejects.toMatchObject({ code: "read-failed" });
    } finally { slot.release(); }
  });

  it.each([["pptx", presentationFixture], ["pdf", pdfFixture]] as const)("loads a real %s page through the split child", async (format, fixture) => {
    const slot = await acquireParseSlot(`page-test:${format}`);
    try {
      const document = await slot.parse(fixture(), format as PreviewPageFormat, 0);
      expect(document).toMatchObject({ format, totalPages: 2, page: { index: 0 } });
      expect(document.page.paragraphs.join(" ")).toContain(format === "pdf" ? "First PDF page" : "First & safe");
    } finally { slot.release(); }
    expect(getManagedChildProcessCount()).toBe(0);
  });
  it("returns only the bounded display model from a real split child bundle", async () => {
    const document = await parseTableDocumentIsolated(Buffer.from("a,b\n1,2"), "csv", 0);
    expect(document.sheet.rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(Object.keys(document)).toEqual(["format", "sheetNames", "totalSheets", "sheetsTruncated", "sheet"]);
    expect(getManagedChildProcessCount()).toBe(0);
  });

  it("kills cyclic sibling pointers and releases the parse slot", async () => {
    const before = getManagedChildProcessCount();
    const started = performance.now();
    const realSpawn = managedChildren.spawnManaged;
    const realKill = managedChildren.forceKillManagedChildProcess;
    let readyAt: number | undefined;
    let stopAt: number | undefined;
    let exitAt: number | undefined;
    let exitCode: number | null | undefined;
    const spawned = vi.spyOn(managedChildren, "spawnManaged").mockImplementation((...args) => {
      const child = realSpawn(...args);
      child.once("close", (code) => { exitAt = performance.now(); exitCode = code; });
      let prefix = "";
      child.stdout!.on("data", (bytes: Buffer) => {
        if (readyAt !== undefined) return;
        prefix = (prefix + bytes.toString("utf8")).slice(0, DOCUMENT_PARSE_READY.length);
        if (prefix === DOCUMENT_PARSE_READY) readyAt = performance.now();
      });
      return child;
    });
    const stopped = vi.spyOn(managedChildren, "forceKillManagedChildProcess").mockImplementation((child, reason) => {
      stopAt ??= performance.now();
      return realKill(child, reason);
    });
    let pulses = 0;
    const timer = setInterval(() => { pulses += 1; }, 20);
    try {
      await expect(parseTableDocumentIsolated(cyclicWorkbook(), "xls", 0)).rejects.toMatchObject({ code: "parse-limit" });
      expect(pulses).toBeGreaterThan(10);
      expect(readyAt).toBeDefined();
      expect(exitAt).toBeDefined();
      // Startup and parsing have separate clocks; native tree termination finishes before settlement.
      expect(readyAt! - started).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.startupTimeoutMs + 2_000);
      if (stopAt !== undefined) {
        // The contract bounds the latest stop, not a scheduler-dependent minimum latency.
        expect(stopAt).toBeGreaterThanOrEqual(readyAt!);
        expect(stopAt - readyAt!).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
      } else {
        // A native heap refusal can finish before the wall-clock kill is needed.
        expect(exitCode).not.toBe(0);
        expect(exitAt! - readyAt!).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs + 2_000);
      }
      expect(getManagedChildProcessCount()).toBe(before);
    } finally {
      clearInterval(timer);
      spawned.mockRestore();
      stopped.mockRestore();
    }
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
    // Unboxed double arrays have no pointer slots for the collector to mark, so
    // V8 reaches its old-space limit in a fraction of the parse deadline. Arrays
    // of string pointers spent seconds in last-resort mark-compacts on slow
    // runners and lost the race to the deadline kill.
    childProgram("const retained=[]; for (;;) retained.push(new Array(100000).fill(0.5)); ");
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

  it("settles a stopped parse only after its kill completes, on every platform", async () => {
    childProgram(`process.stdout.write('x'.repeat(${PREVIEW_DOCUMENT_LIMITS.maxResponseBytes + 1}))`);
    const realSpawn = managedChildren.spawnManaged;
    const realKill = managedChildren.forceKillManagedChildProcess;
    let closed!: Promise<unknown>;
    let release!: () => void;
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const spawned = vi.spyOn(managedChildren, "spawnManaged").mockImplementation((...args) => {
      const child = realSpawn(...args);
      closed = once(child, "close");
      return child;
    });
    // POSIX kills complete synchronously; the latch stands in for a pending tree kill.
    const stopped = vi.spyOn(managedChildren, "forceKillManagedChildProcess").mockImplementation((child, reason) => {
      const done = realKill(child, reason);
      return latch.then(() => done);
    });
    try {
      let settled = false;
      const pending = parseTableDocumentIsolated(Buffer.from("a"), "csv", 0).finally(() => { settled = true; });
      pending.catch(() => {});
      await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      await expect(pending).rejects.toMatchObject({ code: "parse-limit" });
    } finally {
      release();
      spawned.mockRestore();
      stopped.mockRestore();
    }
  });

  it("rejects source bytes and sheet indices before spawning", async () => {
    await expect(parseTableDocumentIsolated(Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1), "csv", 0))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", Number.NaN))
      .rejects.toMatchObject({ code: "invalid-index" });
    await expect(parseTableDocumentIsolated(Buffer.from("a"), "csv", -1))
      .rejects.toMatchObject({ code: "invalid-index" });
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
