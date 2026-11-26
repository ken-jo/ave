import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { repositoryRoot } from "../../../plugins/isolation/__tests__/child-entry-bundle.js";
import { buildBrowserCaptureStitchChild } from "../../../__tests__/support/browser-capture-stitch-bundle.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { CdpSession } from "../browser-action-guard.js";

const { runtime, decoder, termination } = vi.hoisted(() => ({
  runtime: { mainDir: "", child: undefined as ChildProcess | undefined }, decoder: { stalled: false },
  termination: { hold: undefined as ((child: ChildProcess) => Promise<void>) | undefined },
}));
vi.mock("../../main-paths.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  get mainDir() { return runtime.mainDir; },
}));
vi.mock("../../managed-child-processes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../managed-child-processes.js")>();
  return {
    ...actual,
    launchManagedNodeChild: (...args: Parameters<typeof actual.launchManagedNodeChild>) => runtime.child ?? actual.launchManagedNodeChild(...args),
    forceKillManagedChildProcess: (...args: Parameters<typeof actual.forceKillManagedChildProcess>) => {
      const held = termination.hold?.(args[0]);
      if (args[0] === runtime.child) return held;
      return held ? held.then(() => actual.forceKillManagedChildProcess(...args)) : actual.forceKillManagedChildProcess(...args);
    },
  };
});
// A stall covers tile decoding wherever it runs: a tile read in this process never returns, and neither does the child entry.
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal<{ default: (...input: unknown[]) => unknown }>()).default;
  const never: Record<string, unknown> = { toBuffer: () => new Promise(() => {}) };
  for (const step of ["clone", "extract", "raw"]) never[step] = () => never;
  return { default: (input: unknown, options?: { ignoreIcc?: boolean }) => decoder.stalled && options?.ignoreIcc ? never : actual(input, options) };
});

import sharp from "sharp";
import { captureBrowserPage, captureBrowserViewport } from "../browser-capture.js";
import { startCaptureStitcher } from "../browser-capture-stitch-process.js";
import { captureStitchFrames, type CaptureStitchRequest } from "../browser-capture-stitch-protocol.js";
import { getManagedChildProcessCount } from "../../managed-child-processes.js";
import { BROWSER_CAPTURE_LIMITS } from "../../../shared/browser-capture.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

const ENTRY = "browser-capture-stitch-child.js";
const WIDTH = 4;
const VIEWPORT_HEIGHT = 4;
const CONTENT_HEIGHT = 10;
const PNG_HEADER_BYTES = 33;
const PNG_IMAGE_DATA_OFFSET = PNG_HEADER_BYTES + 21;
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

function mockStitchChild(pid?: number): ChildProcess {
  const child = Object.assign(new ChildProcess(), {
    pid, stdin: new PassThrough(), stdout: new PassThrough(),
  });
  runtime.mainDir = entryDir("");
  runtime.child = child;
  return child;
}

function observeStitcherCompletion(pid?: number) {
  const child = mockStitchChild(pid);
  const onFault = vi.fn<(error: Error, closed: Promise<void>) => void>();
  const stitcher = startCaptureStitcher(WIDTH, CONTENT_HEIGHT, onFault);
  const events: string[] = [];
  const job = stitcher.encode().catch((error: unknown) => { events.push("job"); return error; });
  // A protocol fault is the public boundary that exposes the close promise.
  child.stdout?.emit("data", replyFrame({ id: 99 }));
  const closed = onFault.mock.calls[0]?.[1];
  if (!closed) throw new Error("the protocol fault did not report completion");
  void closed.then(() => { events.push("closed"); });
  return { child, events, job, closed };
}

function replyFrame(message: unknown, payload: Buffer = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(json.length, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, json, payload]);
}

function replyEntry(frame: Buffer, { later, payloadBytes = 0 }: { later?: Buffer; payloadBytes?: number } = {}): string {
  const write = (bytes: Buffer): string => `process.stdout.write(Buffer.from("${bytes.toString("base64")}", "base64"));`;
  return `process.stdin.once("data", () => {
  ${write(frame)}
  ${payloadBytes ? `process.stdout.write(Buffer.alloc(${payloadBytes}));` : ""}
  ${later ? `process.stdin.once("data", () => { ${write(later)} });` : ""}
});
setInterval(() => {}, 1000);
`;
}

function withIhdrByte(png: Buffer, offset: number, value: number): Buffer {
  png[offset] = value;
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function splitImageData(png: Buffer, separateWithDensity = false): Buffer {
  const imageOffset = PNG_IMAGE_DATA_OFFSET;
  const dataEnd = imageOffset + 8 + png.readUInt32BE(imageOffset);
  const data = png.subarray(imageOffset + 8, dataEnd);
  const midpoint = Math.floor(data.length / 2);
  const density = png.subarray(PNG_HEADER_BYTES, imageOffset);
  return Buffer.concat([
    png.subarray(0, separateWithDensity ? PNG_HEADER_BYTES : imageOffset),
    pngChunk("IDAT", data.subarray(0, midpoint)),
    ...(separateWithDensity ? [density] : []),
    pngChunk("IDAT", data.subarray(midpoint)),
    png.subarray(dataEnd + 4),
  ]);
}

function withImageData(png: Buffer, alter: (data: Buffer) => Buffer): Buffer {
  const dataStart = PNG_IMAGE_DATA_OFFSET + 8;
  const dataEnd = dataStart + png.readUInt32BE(PNG_IMAGE_DATA_OFFSET);
  return Buffer.concat([
    png.subarray(0, PNG_IMAGE_DATA_OFFSET),
    pngChunk("IDAT", alter(png.subarray(dataStart, dataEnd))),
    png.subarray(dataEnd + 4),
  ]);
}

function fixtureBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let seed = 1;
  for (let offset = 0; offset < length; offset += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[offset] = seed >>> 24;
  }
  return bytes;
}

function encodeTestPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(WIDTH * CONTENT_HEIGHT * 4, 255);
  return sharp(pixels, { raw: { width: WIDTH, height: CONTENT_HEIGHT, channels: 4 } })
    .png({ adaptiveFiltering: true }).toBuffer();
}

async function builtEntryDir(): Promise<string> {
  if (builtDir) return builtDir;
  const outdir = entryDir();
  await buildBrowserCaptureStitchChild(outdir);
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
afterEach(() => { decoder.stalled = false; runtime.child = undefined; });
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

  it("accepts consecutive IDAT chunks from the production child", async () => {
    runtime.mainDir = await builtEntryDir();
    const width = 128;
    const height = 128;
    const pixels = fixtureBytes(width * height * 4);
    const tilePng = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const stitcher = startCaptureStitcher(width, height);
    try {
      await stitcher.decode(tilePng, { pixelWidth: width, pixelHeight: height, scale: 1, skip: 0, copied: 0, rows: height });
      const png = await stitcher.encode();
      expect(png.toString("latin1", PNG_HEADER_BYTES + 4, PNG_HEADER_BYTES + 8)).toBe("pHYs");
      const secondChunk = PNG_IMAGE_DATA_OFFSET + png.readUInt32BE(PNG_IMAGE_DATA_OFFSET) + 12;
      expect(png.toString("latin1", secondChunk + 4, secondChunk + 8)).toBe("IDAT");
      expect((await sharp(png, { failOn: "warning" }).raw().toBuffer()).equals(pixels)).toBe(true);
    } finally {
      stitcher.stop();
      await expect.poll(getManagedChildProcessCount).toBe(0);
    }
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

  it("settles a tile with an unconvertible error message when the child closes", async () => {
    runtime.mainDir = entryDir(replyEntry(replyFrame({ id: 0, error: { message: { toString: null } } })));
    const session = tiledSession();
    const failure = await session.capture({ fullPage: true }, 2_000).catch((error: unknown) => error);
    await expect.poll(getManagedChildProcessCount).toBe(0);
    expect(failure).toMatchObject({ code: "screenshot-failed" });
    expect(session.restore).toHaveBeenCalledOnce();
    await recovered(session);
  });

  it.each([
    { name: "false error", frame: replyFrame({ id: 0, error: false }) },
    { name: "tile payload", frame: replyFrame({ id: 0 }, Buffer.from([1])) },
    { name: "unconvertible error message", frame: replyFrame({ id: 0, error: { message: { toString: null } } }) },
    { name: "numeric error code", frame: replyFrame({ id: 0, error: { message: "failed", code: 42 } }) },
    { name: "error with payload", frame: replyFrame({ id: 0, error: { message: "failed" } }, Buffer.from([1])) },
    { name: "non-object reply", frame: replyFrame([]) },
    { name: "string request id", frame: replyFrame({ id: "0" }) },
  ])("drains a protocol fault with $name before readmitting the tab", async ({ frame }) => {
    const healthyEntry = await builtEntryDir();
    runtime.mainDir = entryDir(replyEntry(frame, { later: replyFrame({ id: 0 }) }));
    const session = tiledSession();
    const release = deferred<void>();
    let sentLateReply = false;
    termination.hold = (child) => {
      child.stdout?.once("data", () => { sentLateReply = true; });
      child.stdin?.write("send late reply");
      return release.promise;
    };
    try {
      await expect(session.capture({ fullPage: true }, 2_000)).rejects.toMatchObject({ code: "screenshot-failed" });
      expect(session.restore).toHaveBeenCalledOnce();
      expect(session.position()).toBe(session.initial.y);
      await expect.poll(() => sentLateReply).toBe(true);
      expect(getManagedChildProcessCount()).toBe(1);
      await expect(session.capture({})).rejects.toMatchObject({ code: "screenshot-busy" });
    } finally {
      termination.hold = undefined;
      release.resolve();
      await expect.poll(getManagedChildProcessCount).toBe(0);
    }
    await recovered(session);
    expect(session.restore).toHaveBeenCalledOnce();
    runtime.mainDir = healthyEntry;
    await expect(session.capture({ fullPage: true })).resolves.toMatchObject({ height: CONTENT_HEIGHT });
    await expect.poll(getManagedChildProcessCount).toBe(0);
  });

  it.each([0, BROWSER_CAPTURE_LIMITS.bytes + 1])("rejects an encode acknowledgement with %i payload bytes", async (payloadBytes) => {
    const frame = replyFrame({ id: 0 });
    frame.writeUInt32BE(payloadBytes, 4);
    runtime.mainDir = entryDir(replyEntry(frame, { payloadBytes }));
    const stitcher = startCaptureStitcher(WIDTH, CONTENT_HEIGHT);
    try {
      const reply = await stitcher.encode().then((payload) => ({ bytes: payload.length }), (error: unknown) => error);
      expect(reply).toMatchObject({ code: "screenshot-failed" });
    } finally {
      stitcher.stop();
      await expect.poll(getManagedChildProcessCount).toBe(0);
    }
  });

  it.each<[string, (png: Buffer) => Buffer]>([
    ["missing IEND", (png) => png.subarray(0, -12)],
    ["wrong width", (png) => withIhdrByte(png, 19, WIDTH + 1)],
    ["wrong height", (png) => withIhdrByte(png, 23, CONTENT_HEIGHT + 1)],
    ["bad IDAT CRC", (png) => { png[png.length - 13] ^= 1; return png; }],
    ["trailing bytes", (png) => Buffer.concat([png, Buffer.from([0])])],
    ["invalid IHDR bit depth", (png) => withIhdrByte(png, 24, 16)],
    ["invalid IHDR color type", (png) => withIhdrByte(png, 25, 2)],
    ["invalid IHDR compression", (png) => withIhdrByte(png, 26, 1)],
    ["invalid IHDR filter", (png) => withIhdrByte(png, 27, 1)],
    ["invalid IHDR interlace", (png) => withIhdrByte(png, 28, 1)],
    ["noncontiguous IDAT", (png) => splitImageData(png, true)],
    ["empty IDAT", (png) => Buffer.concat([png.subarray(0, -12), pngChunk("IDAT"), png.subarray(-12)])],
    ["unexpected critical chunk", (png) => Buffer.concat([
      png.subarray(0, PNG_HEADER_BYTES), pngChunk("ABCD"), png.subarray(PNG_HEADER_BYTES),
    ])],
    ["unexpected ancillary chunk", (png) => Buffer.concat([
      png.subarray(0, PNG_HEADER_BYTES), pngChunk("tEXt", Buffer.from("note\0example")), png.subarray(PNG_HEADER_BYTES),
    ])],
    ["unexpected density", (png) => Buffer.concat([
      png.subarray(0, PNG_HEADER_BYTES), pngChunk("pHYs", Buffer.alloc(9)), png.subarray(PNG_IMAGE_DATA_OFFSET),
    ])],
    ["missing pHYs", (png) => Buffer.concat([
      png.subarray(0, PNG_HEADER_BYTES), png.subarray(PNG_IMAGE_DATA_OFFSET),
    ])],
    ["corrupt zlib header", (png) => withImageData(png, (data) => { data[0] = 0; return data; })],
    ["truncated zlib stream", (png) => withImageData(png, (data) => data.subarray(0, -1))],
    ["bad zlib checksum", (png) => withImageData(png, (data) => { data[data.length - 1] ^= 1; return data; })],
    ["short inflated length", (png) => withImageData(png, (data) => deflateSync(inflateSync(data).subarray(0, -1)))],
    ["long inflated length", (png) => withImageData(png, (data) => deflateSync(Buffer.concat([inflateSync(data), Buffer.alloc(1)])))],
    ["bad scanline filter", (png) => withImageData(png, (data) => {
      const scanlines = inflateSync(data);
      scanlines[(CONTENT_HEIGHT - 1) * (1 + WIDTH * 4)] = 5;
      return deflateSync(scanlines);
    })],
    ["trailing zlib data", (png) => withImageData(png, (data) => Buffer.concat([data, Buffer.alloc(1)]))],
    ["second zlib stream", (png) => withImageData(png, (data) => Buffer.concat([data, deflateSync(Buffer.alloc(0))]))],
  ])(
    "drains an invalid encode PNG with %s before readmitting the tab", async (_fault, alter) => {
      const healthyEntry = await builtEntryDir();
      const png = alter(await encodeTestPng());
      const child = mockStitchChild(42);
      child.stdin?.on("data", captureStitchFrames((message) => {
        const { id, tile } = message as CaptureStitchRequest;
        child.stdout?.emit("data", replyFrame({ id }, tile ? undefined : png));
      }));
      const session = tiledSession();
      const release = deferred<void>();
      const kill = vi.fn(() => release.promise);
      termination.hold = kill;
      try {
        const result = await session.capture({ fullPage: true }, 2_000).then(
          (image) => ({ image }), (error: unknown) => ({ error }),
        );
        expect(result).toEqual({ error: expect.objectContaining({ code: "screenshot-failed" }) });
        expect(session.restore).toHaveBeenCalledOnce();
        expect(session.position()).toBe(session.initial.y);
        expect(kill).toHaveBeenCalledExactlyOnceWith(child);
        await expect(session.capture({ fullPage: true })).rejects.toMatchObject({ code: "screenshot-busy" });
        child.emit("close", 1, null);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(session.capture({ fullPage: true })).rejects.toMatchObject({ code: "screenshot-busy" });
      } finally {
        termination.hold = undefined;
        release.resolve();
        child.emit("close", 1, null);
        runtime.child = undefined;
      }
      await recovered(session);
      expect(session.restore).toHaveBeenCalledOnce();
      runtime.mainDir = healthyEntry;
      await expect(session.capture({ fullPage: true })).resolves.toMatchObject({
        mimeType: "image/png", width: WIDTH, height: CONTENT_HEIGHT, data: expect.any(String),
      });
      await expect.poll(getManagedChildProcessCount).toBe(0);
    },
  );

  it("rejects an encode PNG with an understated zlib window", async () => {
    const stride = 1 + WIDTH * 4;
    const block = fixtureBytes(30 * stride);
    for (let offset = 0; offset < block.length; offset += stride) block[offset] = 0;
    const scanlines = Buffer.concat([block, block, block]);
    const height = scanlines.length / stride;
    const pixels = Buffer.alloc(WIDTH * height * 4, 255);
    const template = await sharp(pixels, { raw: { width: WIDTH, height, channels: 4 } }).png().toBuffer();
    const compressed = deflateSync(scanlines);
    // The repeated block uses a 510-byte back-reference. Keep FCHECK valid while declaring a 256-byte window.
    compressed.set([0x08, 0x1d]);
    const png = withImageData(template, () => compressed);
    const child = mockStitchChild(42);
    const onFault = vi.fn();
    const stitcher = startCaptureStitcher(WIDTH, height, onFault);
    const result = stitcher.encode().catch((error: unknown) => error);
    try {
      child.stdout?.emit("data", replyFrame({ id: 0 }, png));
      expect(onFault).toHaveBeenCalledOnce();
    } finally {
      child.emit("close", 1, null);
    }
    await expect(result).resolves.toMatchObject({ code: "screenshot-failed" });
  });

  it.each(["tile acknowledgement", "encode acknowledgement", "error reply"])(
    "retains ownership while settling a valid %s", async (kind) => {
      const png = splitImageData(await encodeTestPng());
      const frame = kind === "error reply" ? replyFrame({ id: 0, error: { message: "decode failed" } })
        : replyFrame({ id: 0 }, kind === "encode acknowledgement" ? png : undefined);
      const child = mockStitchChild();
      const stitcher = startCaptureStitcher(WIDTH, CONTENT_HEIGHT);
      const result = kind === "encode acknowledgement" ? stitcher.encode() : stitcher.decode(png, {
        pixelWidth: WIDTH, pixelHeight: CONTENT_HEIGHT, scale: 1, skip: 0, copied: 0, rows: CONTENT_HEIGHT,
      });
      const ownership: boolean[] = [];
      let jobs: Map<unknown, unknown> | undefined;
      const get = Map.prototype.get;
      const lookup = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        const entry: unknown = get.call(this, key);
        const job = entry as { expectsPayload?: boolean; resolve(payload: Buffer): void; reject(error: Error): void } | undefined;
        if (key !== 0 || typeof job?.expectsPayload !== "boolean") return entry;
        jobs = this;
        return {
          ...job,
          resolve: (payload: Buffer) => { ownership.push(this.has(key)); job.resolve(payload); },
          reject: (error: Error) => { ownership.push(this.has(key)); job.reject(error); },
        };
      });
      try {
        child.stdout?.emit("data", frame);
      } finally {
        lookup.mockRestore();
      }
      const pending = jobs?.has(0);
      child.emit("close", 0, null);
      if (kind === "error reply") await expect(result).rejects.toThrow("decode failed");
      else await expect(result).resolves.toEqual(kind === "encode acknowledgement" ? png : undefined);
      expect(ownership).toEqual([true]);
      expect(pending).toBe(false);
    },
  );

  it("completes the stitcher lifecycle on a no-PID spawn error before close", async () => {
    const { child, events, job } = observeStitcherCompletion();
    try {
      child.emit("error", new Error("spawn failed"));
      await expect(job).resolves.toMatchObject({ code: "screenshot-failed" });
      expect(events).toEqual(["job", "closed"]);
    } finally {
      child.emit("close", 1, null);
    }
  });

  it.each([true, false])("completes a live stitcher lifecycle after close and tree kill (close first: %s)", async (closeFirst) => {
    const kill = deferred<void>();
    const hold = vi.fn(() => kill.promise);
    termination.hold = hold;
    try {
      const { child, events, job, closed } = observeStitcherCompletion(42);
      child.emit("error", new Error("child error"));
      expect(hold).toHaveBeenCalledExactlyOnceWith(child);
      const close = () => { child.emit("close", 1, null); };
      const first = closeFirst ? close : kill.resolve;
      const second = closeFirst ? kill.resolve : close;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);
      first();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);
      second();
      await expect(job).resolves.toMatchObject({ code: "screenshot-failed" });
      await closed;
      expect(events).toEqual(["job", "closed"]);
    } finally {
      termination.hold = undefined;
      kill.resolve();
    }
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
