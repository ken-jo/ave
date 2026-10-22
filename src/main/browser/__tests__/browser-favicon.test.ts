import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { buildImagePreparationEntry, imageFixturePath } from "../../../__tests__/support/image-preparation-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { BROWSER_FAVICON_LIMITS, isBrowserFaviconDataUrl } from "../../../shared/browser-surface.js";

const runtime = vi.hoisted(() => ({ directory: "" }));
const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({ promises: { lookup } }));
vi.mock("../../main-paths.js", async (original) => ({
  ...await original<typeof import("../../main-paths.js")>(),
  get mainDir() { return runtime.directory; },
}));
import { loadBrowserFavicon } from "../browser-favicon.js";

beforeAll(async () => { runtime.directory = await buildImagePreparationEntry("browser-favicon-runtime"); });
afterAll(async () => { await cleanupTmpDir(runtime.directory); });
beforeEach(() => { lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]); });

function request(bytes: Uint8Array, status = 200) {
  return vi.fn(async () => new Response(bytes as BodyInit, { status })) as unknown as typeof fetch;
}
const signal = () => new AbortController().signal;

describe("bounded browser favicon loading", () => {
  it("fetches through the injected public transport and emits a capped PNG with no metadata", async () => {
    const source = await sharp(await readFile(imageFixturePath("grid.jpeg"))).resize(256, 256).jpeg().toBuffer();
    const transport = request(source);
    const icon = await loadBrowserFavicon("https://example.test/icon.jpeg", transport, signal());
    expect(transport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ credentials: "omit", redirect: "manual", signal: expect.anything() }));
    expect(isBrowserFaviconDataUrl(icon)).toBe(true);
    expect(icon!.length).toBeLessThanOrEqual(BROWSER_FAVICON_LIMITS.dataUrlBytes);
    const metadata = await sharp(Buffer.from(icon!.split(",")[1]!, "base64")).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(BROWSER_FAVICON_LIMITS.dimension);
    expect(metadata.height).toBeLessThanOrEqual(BROWSER_FAVICON_LIMITS.dimension);
    expect(metadata.exif).toBeUndefined();
  });

  it("derives already-loaded raster data icons in main without a network request", async () => {
    const bytes = await readFile(imageFixturePath("grid.png"));
    const transport = request(bytes);
    const icon = await loadBrowserFavicon(`data:image/png;base64,${bytes.toString("base64")}`, transport, signal());
    expect(isBrowserFaviconDataUrl(icon)).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects oversized streams and encoded input before decoding", async () => {
    const bytes = Buffer.alloc(BROWSER_FAVICON_LIMITS.sourceBytes + 1);
    expect(await loadBrowserFavicon("https://example.test/large", request(bytes), signal())).toBeNull();
    const transport = request(bytes);
    expect(await loadBrowserFavicon(`data:image/png;base64,${bytes.toString("base64")}`, transport, signal())).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects active vectors, unsupported icon bytes, malformed rasters and unsuccessful responses", async () => {
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from("not an image")]) {
      expect(await loadBrowserFavicon("https://example.test/icon", request(bytes), signal())).toBeNull();
    }
    expect(await loadBrowserFavicon("data:image/svg+xml;base64,PHN2Zy8+", request(Buffer.alloc(0)), signal())).toBeNull();
    expect(await loadBrowserFavicon("https://example.test/missing", request(Buffer.alloc(0), 404), signal())).toBeNull();
  });

  it("rejects private addresses and redirects to them without granting local network access", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/icon" } })) as unknown as typeof fetch;
    expect(await loadBrowserFavicon("http://127.0.0.1/icon", transport, signal())).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect(await loadBrowserFavicon("https://example.test/icon", transport, signal())).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending stream when the owning document is replaced", async () => {
    const cancel = vi.fn();
    const transport = vi.fn(async () => new Response(new ReadableStream({ cancel }))) as unknown as typeof fetch;
    const controller = new AbortController();
    const loading = loadBrowserFavicon("https://example.test/icon", transport, controller.signal);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    controller.abort();
    expect(await loading).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
