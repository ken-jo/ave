import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildMainBoundaryBundle, repositoryRoot } from "../../../plugins/isolation/__tests__/child-entry-bundle.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { CdpSession } from "../browser-action-guard.js";

const { runtime, decoder } = vi.hoisted(() => ({ runtime: { mainDir: "" }, decoder: { stalled: false } }));
vi.mock("../../main-paths.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  get mainDir() { return runtime.mainDir; },
}));
// A stall covers tile decoding wherever it runs: a tile read in this process never returns, and neither does the child entry.
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal<{ default: (...input: unknown[]) => unknown }>()).default;
  const never: Record<string, unknown> = { toBuffer: () => new Promise(() => {}) };
  for (const step of ["clone", "extract", "raw"]) never[step] = () => never;
  return { default: (input: unknown, options?: { ignoreIcc?: boolean }) => decoder.stalled && options?.ignoreIcc ? never : actual(input, options) };
});

import sharp from "sharp";
import { captureBrowserPage, captureBrowserViewport } from "../browser-capture.js";
import { getManagedChildProcessCount } from "../../managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

const ENTRY = "browser-capture-stitch-child.js";
const WIDTH = 4;
const VIEWPORT_HEIGHT = 4;
const CONTENT_HEIGHT = 10;
/** A reclaimed child frees its guest within this bound: the capture deadline is unchanged and release follows the confirmed exit. */
const RECOVERY_BOUND_MS = 5_000;
const STALLED_ENTRY = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n";

let cacheDir: string;
let builtDir: string | undefined;

function entryDir(program?: string): string {
  const dir = mkdtempSync(join(cacheDir, "case-"));
  if (program !== undefined) writeFileSync(join(dir, ENTRY), program);
  return dir;
}

async function builtEntryDir(): Promise<string> {
  if (builtDir) return builtDir;
  const outdir = entryDir();
  await buildMainBoundaryBundle({
    entryPoints: { "browser-capture-stitch-child": join(repositoryRoot(), "src/main/browser/browser-capture-stitch-child-main.ts") },
    outdir,
    splitting: true,
  });
  copyFileSync(join(outdir, "browser-capture-stitch-child.mjs"), join(outdir, ENTRY));
  builtDir = outdir;
  return outdir;
}

function rowShade(row: number): number {
  return 20 + row * 20;
}

async function tile(pageY: number): Promise<Buffer> {
  const pixels = Buffer.alloc(WIDTH * VIEWPORT_HEIGHT * 3);
  for (let row = 0; row < VIEWPORT_HEIGHT; row += 1) pixels.fill(rowShade(pageY + row), row * WIDTH * 3, (row + 1) * WIDTH * 3);
  return sharp(pixels, { raw: { width: WIDTH, height: VIEWPORT_HEIGHT, channels: 3 } }).png().toBuffer();
}

function tiledSession(captureTile: (pageY: number) => Promise<Buffer> = tile) {
  const initial = { x: 0, y: 2 };
  let pageY = initial.y;
  const restore = vi.fn(async ({ y }: { y: number }) => { pageY = y; });
  const sent: string[] = [];
  const cdp: CdpSession = {
    captureKey: {},
    fullPageTiling: true,
    restoreCaptureScroll: restore,
    onEvent: () => () => {},
    send: async (method, params) => {
      sent.push(method);
      if (method === "Page.getLayoutMetrics") return {
        cssContentSize: { x: 0, y: 0, width: WIDTH, height: CONTENT_HEIGHT },
        cssVisualViewport: { pageX: 0, pageY, clientWidth: WIDTH, clientHeight: VIEWPORT_HEIGHT },
      };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
      if (method === "Runtime.callFunctionOn") {
        const values = (params as { arguments: Array<{ value: unknown }> }).arguments;
        pageY = Math.min(Number(values[1]?.value), CONTENT_HEIGHT - VIEWPORT_HEIGHT);
        return {};
      }
      if (method === "Page.captureScreenshot") return { data: (await captureTile(pageY)).toString("base64") };
      throw new Error(`unexpected protocol call: ${method}`);
    },
  };
  const capture = (options: { fullPage?: boolean }, maxMs: number = TOOL_TIMEOUT_POLICY.browserCaptureMs, signal = new AbortController().signal) =>
    captureBrowserPage(cdp, signal, options, 1, maxMs, () => captureBrowserViewport({ getZoomFactor: () => 1 }, () => {}, 1, cdp));
  /** The first tile has been read back and checked, so its decode is owed. */
  const decoding = async (): Promise<void> => {
    await expect.poll(() => sent.slice(-2)).toEqual(["Page.captureScreenshot", "Page.getLayoutMetrics"]);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { capture, restore, initial, decoding, position: () => pageY };
}

/** Same-guest admission, probed with the viewport mode that needs no decoder of its own. */
async function recovered(session: ReturnType<typeof tiledSession>): Promise<number> {
  const start = performance.now();
  await expect.poll(() => session.capture({}).then(() => "captured", (error: { code?: string }) => error.code),
    { timeout: RECOVERY_BOUND_MS, interval: 20 }).toBe("captured");
  return performance.now() - start;
}

beforeAll(() => {
  mkdirSync(join(repositoryRoot(), ".cache"), { recursive: true });
  cacheDir = mkdtempSync(join(repositoryRoot(), ".cache", "browser-capture-stitch-"));
});
afterEach(() => { decoder.stalled = false; });
afterAll(async () => { await cleanupTmpDir(cacheDir); });

describe("browser capture stitch process", () => {
  it("frees a guest whose tile decode never returns once the capture deadline reclaims it", async () => {
    decoder.stalled = true;
    runtime.mainDir = entryDir(STALLED_ENTRY);
    const session = tiledSession();
    const start = performance.now();
    await expect(session.capture({ fullPage: true }, 400)).rejects.toMatchObject({ code: "screenshot-timeout" });
    expect(performance.now() - start).toBeLessThan(400 + 1_000);
    expect(session.restore).toHaveBeenCalledOnce();
    expect(session.position()).toBe(session.initial.y);
    // A retry is refused until the stalled work is reclaimed, so it never adds decodes beside it.
    await expect(session.capture({ fullPage: true }, 400)).rejects.toMatchObject({ code: "screenshot-busy" });
    expect(getManagedChildProcessCount()).toBeLessThanOrEqual(1);
    decoder.stalled = false;
    await recovered(session);
    await expect.poll(getManagedChildProcessCount).toBe(0);
    expect(session.restore).toHaveBeenCalledOnce();
  });

  it("frees a guest after cancellation with its tile decode still outstanding", async () => {
    runtime.mainDir = entryDir(STALLED_ENTRY);
    const session = tiledSession();
    const abort = new AbortController();
    const cancelled = session.capture({ fullPage: true }, undefined, abort.signal);
    await session.decoding();
    expect(getManagedChildProcessCount()).toBe(1);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await expect(session.capture({})).rejects.toMatchObject({ code: "screenshot-busy" });
    await recovered(session);
    expect(getManagedChildProcessCount()).toBe(0);
    expect(session.restore).toHaveBeenCalledOnce();
  });

  it("composes the page in the child and leaves no process behind", async () => {
    runtime.mainDir = await builtEntryDir();
    const session = tiledSession();
    const result = await session.capture({ fullPage: true });
    expect(result).toMatchObject({ width: WIDTH, height: CONTENT_HEIGHT, truncated: false, captureMethod: "scroll-and-stitch" });
    const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: WIDTH, height: CONTENT_HEIGHT, channels: 4 });
    for (let row = 0; row < CONTENT_HEIGHT; row += 1) {
      const shade = rowShade(row);
      expect([...decoded.data.subarray(row * WIDTH * 4, (row + 1) * WIDTH * 4)]).toEqual(Array.from({ length: WIDTH }, () => [shade, shade, shade, 255]).flat());
    }
    // A completed capture owes no decode, so an immediate retake is admitted.
    await expect(session.capture({ fullPage: true })).resolves.toMatchObject({ height: CONTENT_HEIGHT });
    await expect.poll(getManagedChildProcessCount).toBe(0);
  });

  it("reports the decode error of a corrupt tile and admits the next capture", async () => {
    runtime.mainDir = await builtEntryDir();
    let corrupt = true;
    const session = tiledSession(async (pageY) => {
      const png = await tile(pageY);
      if (corrupt) png.fill(0, png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
      return png;
    });
    const failure = await session.capture({ fullPage: true }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toBeTruthy();
    expect(failure).not.toMatchObject({ code: "screenshot-failed" });
    expect(session.restore).toHaveBeenCalledOnce();
    corrupt = false;
    await recovered(session);
    await expect(session.capture({ fullPage: true })).resolves.toMatchObject({ height: CONTENT_HEIGHT });
  });

  it.each([
    { name: "exits before answering", program: "process.exit(3);\n" },
    { name: "is missing", program: undefined },
    { name: "answers a request it was not sent", program: "process.stdout.write(Buffer.from([0, 0, 0, 8, 0, 0, 0, 0, ...Buffer.from('{\"id\":9}')]));\nsetInterval(() => {}, 1000);\n" },
  ])("fails the capture and frees the guest when the child entry $name", async ({ program }) => {
    runtime.mainDir = entryDir(program);
    const session = tiledSession();
    await expect(session.capture({ fullPage: true })).rejects.toMatchObject({ code: "screenshot-failed" });
    await recovered(session);
    await expect.poll(getManagedChildProcessCount).toBe(0);
    expect(session.restore).toHaveBeenCalledOnce();
  });

  it("ships the child entry as a root file of the main bundle", async () => {
    const { MAIN_ENTRY_POINTS } = await import("../../../../scripts/lib/main-entry-points.mjs");
    const budget = createRequire(import.meta.url)("../../../../scripts/lib/main-bundle-budget.mjs") as {
      MAIN_BUNDLE_ROOT_FILES: readonly string[]; isSafeMainBundleManifestPath(path: string): boolean;
    };
    expect(budget.MAIN_BUNDLE_ROOT_FILES).toContain(ENTRY);
    expect(budget.isSafeMainBundleManifestPath(ENTRY)).toBe(true);
    expect(MAIN_ENTRY_POINTS["browser-capture-stitch-child"]).toBe("src/main/browser/browser-capture-stitch-child-main.ts");
  });
});
