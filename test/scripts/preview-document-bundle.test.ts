import { build } from "esbuild";
import { createRequire } from "node:module";
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
    const forbidden = /(?:table-document-reader|workbook-container|zip-inflate-guard)\.ts$|node_modules\/(?:xlsx|papaparse)\//;
    expect([...visited].filter((path) => forbidden.test(path))).toEqual([]);
    expect(Object.keys(inputs).some((path) => /node_modules\/xlsx\//.test(path))).toBe(true);
    expect(MAIN_BUNDLE_ROOT_FILES).toContain("preview-document-child-main.js");
    const child = Object.entries(result.metafile!.outputs)
      .find(([, output]) => output.entryPoint === "src/tools/preview-document-child-main.ts");
    expect(child?.[0]).toBeDefined();
    expect(isSafeMainBundleManifestPath("preview-document-child-main.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("unexpected-document-child-main.js")).toBe(false);
    expect(resolve(root, child![0])).toMatch(/preview-document-child-main\.js$/);
  });
});
