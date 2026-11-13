import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Configuration, Stats } from "webpack";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const loader = require("../../scripts/loaders/bundled-font-resource-loader.cjs") as (
  this: { cacheable(): void; emitFile(name: string, bytes: Buffer): void }, source: string,
) => string;
const webpack = require("webpack") as typeof import("webpack");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function font(signature = "wOFF", headerBytes = 44): Buffer {
  const bytes = Buffer.alloc(headerBytes + 4);
  bytes.write(signature);
  bytes.writeUInt32BE(bytes.length, 8);
  return bytes;
}

function transform(source: string) {
  const files = new Map<string, Buffer>();
  const cacheable = vi.fn();
  const emitFile = vi.fn((name: string, bytes: Buffer) => { files.set(name, bytes); });
  const output = loader.call({ cacheable, emitFile }, source);
  return { output, files, cacheable, emitFile };
}

function installedFontResources() {
  const source = readFileSync(require.resolve("eruda"), "utf8");
  const uris = source.match(/data:application\/x-font-woff;charset=utf-8;base64,[A-Za-z0-9+/=]+/g);
  if (!uris?.length) throw new Error("Development bundle fonts are missing");
  const files = new Map<string, Buffer>();
  let output = source;
  for (const uri of uris) {
    const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
    const filename = `renderer/fonts/${createHash("sha256").update(bytes).digest("hex")}.woff`;
    files.set(filename, bytes);
    output = output.replaceAll(uri, `./${filename}`);
  }
  return { source, output, files };
}

async function compile(configuration: Configuration): Promise<Stats> {
  const compiler = webpack(configuration);
  return new Promise((resolveBuild, rejectBuild) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return rejectBuild(error ?? closeError);
        if (!stats || stats.hasErrors()) return rejectBuild(new Error(stats?.toString("errors-only") ?? "Build statistics are missing"));
        resolveBuild(stats);
      });
    });
  });
}

describe("bundled font resources", () => {
  it.each([
    ["application/x-font-woff", "wOFF", "woff", 44],
    ["font/woff2", "wOF2", "woff2", 48],
  ] as const)("emits %s bytes unchanged under their content hash", (mime, signature, extension, headerBytes) => {
    const bytes = font(signature, headerBytes);
    const uri = `data:${mime};charset=utf-8;base64,${bytes.toString("base64")}`;
    const source = `/* retained */ const css = "@font-face{src:url('${uri}')}";`;
    const result = transform(source);
    const filename = `renderer/fonts/${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
    expect(result.output).toBe(source.replace(uri, `./${filename}`));
    expect(result.files.get(filename)).toEqual(bytes);
    expect(result.cacheable).toHaveBeenCalledOnce();
    expect(result.emitFile).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated font bytes without changing other data resources", () => {
    const uri = `data:font/woff;base64,${font().toString("base64")}`;
    const image = "data:image/png;base64,aGVsbG8=";
    const result = transform(`const css = "url('${uri}') url('${uri}') url('${image}')";`);
    expect(result.emitFile).toHaveBeenCalledOnce();
    expect(result.output.match(/\.\/renderer\/fonts\//g)).toHaveLength(2);
    expect(result.output).toContain(image);
  });

  it("preserves a script without embedded font data", () => {
    const source = "/* license */ export const value = 1;\n";
    const result = transform(source);
    expect(result.output).toBe(source);
    expect(result.emitFile).not.toHaveBeenCalled();
  });

  it.each([
    "data:font/ttf;base64,d09GRg==",
    "data:font/woff;base64,%%%",
    "data:font/woff;base64,",
    `data:font/woff;base64,${font("wOF2").toString("base64")}`,
    `data:font/woff;base64,${font().subarray(0, 44).toString("base64")}`,
  ])("rejects unsupported or malformed font data (%s)", (uri) => {
    expect(() => transform(`const css = "url('${uri}')";`)).toThrow(/embedded font data/);
  });

  it("rewrites the installed development bundle without changing other source", () => {
    const expected = installedFontResources();
    const result = transform(expected.source);
    expect(result.output).toBe(expected.output);
    expect(result.files).toEqual(expected.files);
    expect(result.emitFile).toHaveBeenCalledTimes(expected.files.size);
    expect(result.output).not.toContain("data:application/x-font-woff");
  });

  it("includes the local font in the real renderer compiler output", async () => {
    const configurations = require("../../webpack.config.cjs") as Configuration[];
    const renderer = configurations.find(configuration => configuration.name === "renderer");
    if (!renderer) throw new Error("Renderer build configuration is missing");
    const output = mkdtempSync(join(tmpdir(), "ave-font-resource-"));
    roots.push(output);
    const stats = await compile({
      ...renderer,
      mode: "none",
      cache: false,
      entry: require.resolve("eruda"),
      output: { ...renderer.output, path: output, filename: "entry.js", clean: false },
      optimization: { minimize: false, splitChunks: false },
    });
    expect(stats.hasErrors()).toBe(false);
    const expected = installedFontResources();
    const fonts = readdirSync(join(output, "renderer/fonts"));
    expect(fonts.map(filename => `renderer/fonts/${filename}`).sort()).toEqual([...expected.files.keys()].sort());
    const script = readFileSync(join(output, "entry.js"), "utf8");
    for (const [filename, bytes] of expected.files) {
      expect(readFileSync(join(output, filename))).toEqual(bytes);
      expect(script).toContain(`./${filename}`);
    }
    expect(script).not.toContain("data:application/x-font-woff");
    const html = readFileSync(resolve("src/index.html"), "utf8");
    expect(html).toContain("font-src 'self' ave-content:");
    expect(html).not.toContain("font-src 'self' data:");
  });
});
