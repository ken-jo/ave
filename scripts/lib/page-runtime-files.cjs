const { readFileSync, statSync } = require("node:fs");
const { isAbsolute, join, relative } = require("node:path");

const CANVAS_TARGETS = Object.freeze({
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
});

function requireFile(path) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size === 0) throw new Error(`packaged page renderer file missing or empty: ${path}`);
  return path;
}

function packageFile(directory, path) {
  if (typeof path !== "string" || isAbsolute(path)) throw new Error("invalid page renderer package entry");
  const target = join(directory, path);
  if (relative(directory, target).startsWith("..")) throw new Error("page renderer package entry escaped its package");
  return requireFile(target);
}

/** The canvas package for an Ave target (`linux-x64` → `@napi-rs/canvas-linux-x64-gnu`). */
function canvasRuntimePackage(platform, arch) {
  const suffix = CANVAS_TARGETS[`${platform}-${arch}`];
  if (!suffix) throw new Error(`unsupported page renderer target: ${platform}-${arch}`);
  return `@napi-rs/canvas-${suffix}`;
}

/** Validate the unpacked canvas wrapper and the target's native binary without loading it. */
function assertCanvasRuntimeFiles(nodeModules, platform, arch) {
  const name = canvasRuntimePackage(platform, arch);
  const wrapper = join(nodeModules, "@napi-rs", "canvas");
  const wrapperPackage = JSON.parse(readFileSync(requireFile(join(wrapper, "package.json")), "utf8"));
  packageFile(wrapper, wrapperPackage.main);
  const native = join(nodeModules, name);
  const nativePackage = JSON.parse(readFileSync(requireFile(join(native, "package.json")), "utf8"));
  if (nativePackage.name !== name) throw new Error(`wrong page renderer package for ${platform}-${arch}`);
  if (nativePackage.version !== wrapperPackage.version) throw new Error(`page renderer native version ${nativePackage.version} does not match ${wrapperPackage.version}`);
  if (!/\.node$/.test(nativePackage.main ?? "")) throw new Error(`page renderer package has no native binding: ${name}`);
  packageFile(native, nativePackage.main);
}

const PDF_RUNTIME_ENTRIES = Object.freeze([
  "/node_modules/pdfjs-dist/package.json",
  "/node_modules/pdfjs-dist/LICENSE",
  "/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
]);
const PDF_RUNTIME_DIRECTORIES = Object.freeze([
  "/node_modules/pdfjs-dist/standard_fonts/",
  "/node_modules/pdfjs-dist/cmaps/",
  "/node_modules/pdfjs-dist/iccs/",
  "/node_modules/pdfjs-dist/wasm/",
]);
const PDF_RUNTIME_WASM = Object.freeze(["openjpeg.wasm", "qcms_bg.wasm", "jbig2.wasm"]);
const PDF_EXCLUDED_ENTRY = /^\/node_modules\/pdfjs-dist\/(?:wasm\/quickjs-eval\.|legacy\/build\/pdf\.sandbox)/;

/** Validate pdf.js entries inside app.asar (paths as `@electron/asar` lists them, `/`-separated). */
function assertPdfRuntimeEntries(entries) {
  const normalized = entries.map((entry) => entry.replace(/\\/g, "/")).map((entry) => (entry.startsWith("/") ? entry : `/${entry}`));
  const present = new Set(normalized);
  const missing = PDF_RUNTIME_ENTRIES.filter((entry) => !present.has(entry));
  for (const directory of PDF_RUNTIME_DIRECTORIES) {
    if (!normalized.some((entry) => entry.startsWith(directory) && entry.length > directory.length)) missing.push(directory);
  }
  for (const wasm of PDF_RUNTIME_WASM) {
    const entry = `/node_modules/pdfjs-dist/wasm/${wasm}`;
    if (!present.has(entry)) missing.push(entry);
  }
  if (!normalized.some((entry) => /^\/node_modules\/pdfjs-dist\/wasm\/LICENSE_/.test(entry))) missing.push("/node_modules/pdfjs-dist/wasm/LICENSE_*");
  if (missing.length > 0) throw new Error(`packaged PDF renderer entries missing: ${missing.join(", ")}`);
  const unexpected = normalized.filter((entry) => PDF_EXCLUDED_ENTRY.test(entry));
  if (unexpected.length > 0) throw new Error(`packaged PDF renderer includes script-evaluation files: ${unexpected.join(", ")}`);
}

/** Notices Ave ships for the externalized page renderer packages. */
const PAGE_RENDERER_LICENSE_NOTICES = Object.freeze(["LICENSE", "THIRD-PARTY-NOTICES.txt", "README.txt"]);

module.exports = {
  assertCanvasRuntimeFiles,
  assertPdfRuntimeEntries,
  PAGE_RENDERER_LICENSE_NOTICES,
};
