import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asarCliPath, writeFixtureFile } from "../../../test/scripts/gate-script-runner.js";

/** pdf.js entries the packaged reader needs, as `@electron/asar` lists them. */
export const PDF_RUNTIME_FIXTURE_ENTRIES = Object.freeze([
  "/node_modules/pdfjs-dist/package.json",
  "/node_modules/pdfjs-dist/LICENSE",
  "/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  "/node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb",
  "/node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap",
  "/node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc",
  "/node_modules/pdfjs-dist/wasm/openjpeg.wasm",
  "/node_modules/pdfjs-dist/wasm/qcms_bg.wasm",
  "/node_modules/pdfjs-dist/wasm/jbig2.wasm",
  "/node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG",
]);

/** Fixture bytes model the canvas package layout; they are not executable addons. Returns the binding path. */
export function writeCanvasRuntimePackage(nodeModules: string, platform: string, arch = "x64", version = "1.0.10"): string {
  const abi = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  const name = `@napi-rs/canvas-${platform}-${arch}${abi}`;
  const binding = `skia.${platform}-${arch}${abi}.node`;
  writeFixtureFile(nodeModules, "@napi-rs/canvas/package.json", JSON.stringify({ name: "@napi-rs/canvas", version, main: "index.js" }));
  writeFixtureFile(nodeModules, "@napi-rs/canvas/index.js", "wrapper");
  writeFixtureFile(nodeModules, `${name}/package.json`, JSON.stringify({ name, version, main: binding }));
  writeFixtureFile(nodeModules, `${name}/${binding}`, "native addon fixture");
  return join(nodeModules, name, binding);
}

/** Writes an app.asar holding the pdf.js entries plus the page renderer notices beside it. */
export function writePageRuntimeResources(resources: string): void {
  const input = mkdtempSync(join(tmpdir(), "pdf-runtime-asar-"));
  try {
    for (const entry of PDF_RUNTIME_FIXTURE_ENTRIES) writeFixtureFile(input, entry.slice(1), "pdf runtime fixture");
    const pack = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [asarCliPath(), "pack", input, join(resources, "app.asar")], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    if (pack.status !== 0) throw new Error(`asar fixture pack failed: ${pack.stderr}`);
  } finally {
    rmSync(input, { recursive: true, force: true });
  }
  for (const entry of PDF_RUNTIME_FIXTURE_ENTRIES) {
    if (/\/pdfjs-dist\/(?:standard_fonts|cmaps|iccs|wasm)\//.test(entry)) writeFixtureFile(join(resources, "app.asar.unpacked"), entry.slice(1), "pdf runtime fixture");
  }
  for (const notice of ["LICENSE", "THIRD-PARTY-NOTICES.txt", "README.txt"]) {
    writeFixtureFile(resources, `licenses/canvas/${notice}`, "notice");
  }
}
