import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_ASSET_CUSTOM_SCHEME, parseContentAssetUrl, respondToContentAsset } from "../content-asset-protocol.js";

/** A request from the app's own window: a `file:` page, whose origin is opaque. */
const APP = { origin: "null", referrer: "" };
const TOKEN = "0123456789abcdef0123456789abcdef";
const base = `ave-content://${TOKEN}`;

describe("ave-content asset scheme (design §5.4)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is a standard, secure, CORS-enabled scheme", () => {
    expect(CONTENT_ASSET_CUSTOM_SCHEME).toEqual({ scheme: "ave-content", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } });
  });

  it("parses the token, kind, package and path, and refuses traversal, queries and malformed escapes", () => {
    expect(parseContentAssetUrl(`${base}/font/harbor-sans/files/Harbor%20Sans.woff2`)).toEqual({ token: TOKEN, kind: "font", name: "harbor-sans", path: "files/Harbor Sans.woff2" });
    // URL parsing resolves dot segments first; what is left is looked up exactly, never joined to a path.
    expect(parseContentAssetUrl(`${base}/font/harbor-sans/files/%2e%2e/x`)).toEqual({ token: TOKEN, kind: "font", name: "harbor-sans", path: "x" });
    expect(parseContentAssetUrl(`${base}/font/harbor-sans/files%2Fx`)).toBeNull();
    expect(parseContentAssetUrl(`${base}/font/harbor-sans/a.woff2?x=1`)).toBeNull();
    expect(parseContentAssetUrl(`${base}/font/harbor-sans/%E0%A4%A`)).toBeNull();
    expect(parseContentAssetUrl("ave-plugin://asset/x")).toBeNull();
    expect(parseContentAssetUrl(`${base}/font/only-name`)).toBeNull();
  });

  it("serves only what the resolver lists, with its type and nosniff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-content-asset-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.woff2"), "wOF2data");
    const resolve = (kind: string, name: string, path: string) =>
      kind === "font" && name === "harbor-sans" && path === "files/a.woff2" ? { path: join(dir, "a.woff2"), contentType: "font/woff2" } : null;
    const ok = await respondToContentAsset(`${base}/font/harbor-sans/files/a.woff2`, TOKEN, resolve, APP);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("font/woff2");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    // Only the app's own file: pages (an opaque origin) may read it cross-origin.
    expect(ok.headers.get("access-control-allow-origin")).toBe("null");
    expect(await ok.text()).toBe("wOF2data");
    expect((await respondToContentAsset(`${base}/font/harbor-sans/files/b.woff2`, TOKEN, resolve, APP)).status).toBe(404);
    const gone = (_k: string, _n: string, _p: string) => ({ path: join(dir, "missing.woff2"), contentType: "font/woff2" });
    expect((await respondToContentAsset(`${base}/font/harbor-sans/files/a.woff2`, TOKEN, gone, APP)).status).toBe(404);
  });

  it("refuses a request from a web page, by origin or by referrer", async () => {
    const resolve = () => ({ path: "/nonexistent", contentType: "font/woff2" });
    const url = `${base}/font/harbor-sans/files/a.woff2`;
    expect((await respondToContentAsset(url, TOKEN, resolve, { origin: "https://evil.example", referrer: "" })).status).toBe(403);
    expect((await respondToContentAsset(url, TOKEN, resolve, { origin: null, referrer: "http://localhost:8080/page" })).status).toBe(403);
    // The app's own requests reach the resolver (404 here: the listed file does not exist).
    expect((await respondToContentAsset(url, TOKEN, resolve, APP)).status).toBe(404);
    expect((await respondToContentAsset(url, TOKEN, resolve, { origin: null, referrer: "" })).status).toBe(404);
  });

  it("answers 404 to a URL without this launch's token, whoever asks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-content-asset-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.png"), "png");
    const resolve = () => ({ path: join(dir, "a.png"), contentType: "image/png" });
    // A web page that strips its origin and referrer still cannot name a file.
    const stripped = { origin: null, referrer: "" };
    expect((await respondToContentAsset("ave-content://theme/harbor/preview.png", TOKEN, resolve, stripped)).status).toBe(404);
    expect((await respondToContentAsset(`ave-content://${"f".repeat(32)}/theme/harbor/preview.png`, TOKEN, resolve, stripped)).status).toBe(404);
    expect((await respondToContentAsset(`${base}/theme/harbor/preview.png`, TOKEN, resolve, stripped)).status).toBe(200);
  });
});
