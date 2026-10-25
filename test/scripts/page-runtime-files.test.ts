import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFixtureFile } from "./gate-script-runner.js";
import { PDF_RUNTIME_FIXTURE_ENTRIES, writeCanvasRuntimePackage, writePageRuntimeResources } from "../../src/__tests__/support/page-runtime-package.js";

const { assertCanvasRuntimeFiles, assertPdfRuntimeEntries, assertPdfUnpackedData, PAGE_RENDERER_LICENSE_NOTICES } = createRequire(import.meta.url)(
  "../../scripts/lib/page-runtime-files.cjs",
) as {
  assertCanvasRuntimeFiles(modules: string, platform: string, arch: string): void;
  assertPdfRuntimeEntries(entries: readonly string[]): void;
  assertPdfUnpackedData(modules: string): void;
  PAGE_RENDERER_LICENSE_NOTICES: readonly string[];
};
const repo = process.cwd();
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PDF_ENTRIES = [...PDF_RUNTIME_FIXTURE_ENTRIES];

describe("packaged PDF page renderer files", () => {
  it.each([["darwin", "x64"], ["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["win32", "arm64"]] as const)(
    "requires the %s-%s canvas binding", (platform, arch) => {
      const root = mkdtempSync(join(tmpdir(), "canvas-package-")); roots.push(root);
      const binding = writeCanvasRuntimePackage(root, platform, arch);
      expect(() => assertCanvasRuntimeFiles(root, platform, arch)).not.toThrow();
      const other = arch === "x64" ? "arm64" : "x64";
      expect(() => assertCanvasRuntimeFiles(root, platform, other)).toThrow();
      writeFileSync(binding, "");
      expect(() => assertCanvasRuntimeFiles(root, platform, arch)).toThrow("missing or empty");
    });

  it("refuses a native package whose version differs from the wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "canvas-package-")); roots.push(root);
    writeCanvasRuntimePackage(root, "linux", "x64");
    writeFixtureFile(root, "@napi-rs/canvas/package.json", JSON.stringify({ name: "@napi-rs/canvas", version: "1.0.11", main: "index.js" }));
    expect(() => assertCanvasRuntimeFiles(root, "linux", "x64")).toThrow("does not match");
  });

  it("requires pdf.js fonts, wasm decoders and notices, and refuses the script sandbox", () => {
    expect(() => assertPdfRuntimeEntries(PDF_ENTRIES)).not.toThrow();
    expect(() => assertPdfRuntimeEntries(PDF_ENTRIES.map((entry) => entry.slice(1).replaceAll("/", "\\")))).not.toThrow();
    for (const removed of ["standard_fonts/", "wasm/openjpeg.wasm", "legacy/build/pdf.worker.min.mjs", "wasm/LICENSE_"]) {
      expect(() => assertPdfRuntimeEntries(PDF_ENTRIES.filter((entry) => !entry.includes(removed))), removed).toThrow("missing");
    }
    expect(() => assertPdfRuntimeEntries([...PDF_ENTRIES, "/node_modules/pdfjs-dist/wasm/quickjs-eval.wasm"])).toThrow("script-evaluation");
  });

  it("requires the pdf.js data unpacked beside the archive", () => {
    const resources = mkdtempSync(join(tmpdir(), "pdf-data-")); roots.push(resources);
    writePageRuntimeResources(resources);
    const modules = join(resources, "app.asar.unpacked", "node_modules");
    expect(() => assertPdfUnpackedData(modules)).not.toThrow();
    rmSync(join(modules, "pdfjs-dist", "wasm", "openjpeg.wasm"));
    expect(() => assertPdfUnpackedData(modules)).toThrow("missing or empty");
    rmSync(join(modules, "pdfjs-dist", "cmaps"), { recursive: true });
    expect(() => assertPdfUnpackedData(modules)).toThrow("data missing");
  });

  it("wires the checks into packaging and the Linux cross-build", () => {
    expect(read("scripts/build-installers.mjs")).toContain("(arch) => `@napi-rs/canvas-linux-${arch}-gnu`");
    for (const script of ["scripts/electron-after-pack.cjs", "scripts/check-package-footprint.mjs"]) {
      expect(read(script)).toContain("assertCanvasRuntimeFiles(");
      expect(read(script)).toContain("assertPdfRuntimeEntries(");
      expect(read(script)).toContain("assertPdfUnpackedData(");
      expect(read(script)).toContain("PAGE_RENDERER_LICENSE_NOTICES");
    }
    const build = JSON.parse(read("package.json")).build as { files: string[]; asarUnpack: string[]; extraResources: unknown[] };
    expect(build.asarUnpack).toContain("node_modules/@napi-rs/**");
    expect(build.files).toContain("!node_modules/pdfjs-dist/wasm/{quickjs-eval.js,quickjs-eval.wasm,jbig2_nowasm_fallback.js,openjpeg_nowasm_fallback.js}");
    expect(build.asarUnpack).toContain("node_modules/pdfjs-dist/{standard_fonts,cmaps,iccs,wasm}/**");
    expect(build.extraResources).toContainEqual({ from: "resources/licenses/canvas", to: "licenses/canvas" });
    // No pdf.js exclusion may drop its notices or the data the reader loads.
    const pdfExclusions = build.files.filter((pattern) => pattern.startsWith("!node_modules/pdfjs-dist"));
    expect(pdfExclusions.filter((pattern) => /LICENSE|standard_fonts|cmaps|iccs|pdf\.worker\.min\.mjs|\/wasm\/(?!\{quickjs)/.test(pattern))).toEqual([]);
  });

  it("ships the canvas wrapper, Skia and third-party notices", () => {
    for (const notice of PAGE_RENDERER_LICENSE_NOTICES) expect(read(`resources/licenses/canvas/${notice}`).length).toBeGreaterThan(0);
    expect(read("resources/licenses/canvas/LICENSE")).toBe(read("node_modules/@napi-rs/canvas/LICENSE"));
    const notices = read("resources/licenses/canvas/THIRD-PARTY-NOTICES.txt");
    for (const component of ["Skia (google/skia@", "freetype (", "harfbuzz (", "libpng (", "zlib (", "libaom (", "Rust crate libavif-sys", "Rust crate cssparser 0.38.0"]) {
      expect(notices, component).toContain(component);
    }
    // pdf.js keeps its own notices inside the package, which the asar check requires.
    expect(read("node_modules/pdfjs-dist/LICENSE")).toContain("Apache License");
    expect(read("node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG").length).toBeGreaterThan(0);
  });
});
