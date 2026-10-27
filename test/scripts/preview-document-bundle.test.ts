import { build } from "esbuild";
import { existsSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_BUNDLE_EXTERNALS } from "../../scripts/lib/main-bundle-externals.mjs";

const { MAIN_BUNDLE_ROOT_FILES, isSafeMainBundleManifestPath } = createRequire(import.meta.url)(
  "../../scripts/lib/main-bundle-budget.mjs",
) as { MAIN_BUNDLE_ROOT_FILES: readonly string[]; isSafeMainBundleManifestPath(path: string): boolean };

describe("document child bundle boundary", () => {
  it("ships a separate child entry and keeps workbook parsers out of the host graph", async () => {
    const root = process.cwd();
    const result = await build({
      absWorkingDir: root,
      entryPoints: {
        host: "src/ipc/domains/preview.ts",
        "preview-document-child-main": "src/tools/preview-document-child-main.ts",
      },
      outdir: ".cache/document-bundle-probe", write: false, metafile: true,
      bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
      preserveSymlinks: true, external: [...MAIN_BUNDLE_EXTERNALS], logLevel: "silent",
      chunkNames: "chunks/[name]-[hash]",
    });
    const inputs = result.metafile!.inputs;
    const pending = ["src/ipc/domains/preview.ts"];
    const visited = new Set<string>();
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      for (const imported of inputs[path]?.imports ?? []) {
        if (!imported.external) pending.push(imported.path);
      }
    }
    const forbidden = /(?:table-document-reader|page-document-reader|structured-document|workbook-container|zip-inflate-guard)\.ts$|node_modules\/(?:xlsx|papaparse|jszip|fast-xml-parser)\//;
    expect([...visited].filter((path) => forbidden.test(path))).toEqual([]);
    expect(Object.keys(inputs).some((path) => /node_modules\/xlsx\//.test(path))).toBe(true);
    expect(Object.keys(inputs)).toContain("src/observation/structured-document.ts");
    expect(Object.keys(inputs).some((path) => /node_modules\/fast-xml-parser\//.test(path))).toBe(true);
    expect(MAIN_BUNDLE_ROOT_FILES).toContain("preview-document-child-main.js");
    const child = Object.entries(result.metafile!.outputs)
      .find(([, output]) => output.entryPoint === "src/tools/preview-document-child-main.ts");
    expect(child?.[0]).toBeDefined();
    expect(isSafeMainBundleManifestPath("preview-document-child-main.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("unexpected-document-child-main.js")).toBe(false);
    expect(resolve(root, child![0])).toMatch(/preview-document-child-main\.js$/);

    // Every package bundled into the page reader ships its notice with the app.
    const pageReader = new Set<string>();
    const pagePending = ["src/tools/page-document-reader.ts"];
    while (pagePending.length) {
      const path = pagePending.pop()!;
      if (pageReader.has(path)) continue;
      pageReader.add(path);
      for (const imported of inputs[path]?.imports ?? []) {
        if (!imported.external) pagePending.push(imported.path);
      }
    }
    const bundledPackages = new Set([...pageReader].flatMap((path) => {
      const name = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
      return name ? [name] : [];
    }));
    expect(bundledPackages).toContain("fast-xml-parser");
    const notices = readdirSync(resolve(root, "resources/licenses/document-preview"));
    const missing = [...bundledPackages].filter((name) => {
      const prefix = `${name.replace(/^@/, "").replace("/", "-")}-`;
      return !notices.some((notice) => notice.startsWith(prefix));
    });
    expect(missing).toEqual([]);

    // Externalized runtime packages ship as files; each needs a packaged notice.
    const externals = new Set([...pageReader].flatMap((path) => (inputs[path]?.imports ?? [])
      .filter((imported) => imported.external && !imported.path.startsWith("node:") && !builtinModules.includes(imported.path))
      .map((imported) => /^((?:@[^/]+\/)?[^/]+)/.exec(imported.path)![1]!)));
    expect([...externals].sort()).toEqual(["@napi-rs/canvas", "pdfjs-dist"]);
    const externalNotices: Record<string, string[]> = {
      "@napi-rs/canvas": ["resources/licenses/canvas/LICENSE", "resources/licenses/canvas/THIRD-PARTY-NOTICES.txt"],
      "pdfjs-dist": ["node_modules/pdfjs-dist/LICENSE", "node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG", "node_modules/pdfjs-dist/wasm/LICENSE_QCMS", "node_modules/pdfjs-dist/wasm/LICENSE_JBIG2"],
    };
    for (const name of externals) {
      for (const notice of externalNotices[name] ?? [""]) expect(existsSync(resolve(root, notice)), `${name}: ${notice}`).toBe(true);
    }
  });
});
