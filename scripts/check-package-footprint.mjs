#!/usr/bin/env node
// Packaged apps need compiled assets and runtime dependencies, without development source or maps.

import * as asar from "@electron/asar";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { assertImageRuntimeFiles } from "./lib/image-runtime-files.cjs";
import { assertRipgrepRuntimeFiles, RIPGREP_LICENSE_NOTICES } from "./lib/ripgrep-runtime-files.cjs";
import { assertCanvasRuntimeFiles, assertPdfRuntimeEntries, assertPdfUnpackedData, PAGE_RENDERER_LICENSE_NOTICES } from "./lib/page-runtime-files.cjs";

const { assertGraphicsRuntimeFiles } = createRequire(import.meta.url)(
  "./lib/graphics-runtime-files.cjs",
);
const { assertSandboxRuntimeFiles } = createRequire(import.meta.url)(
  "./lib/sandbox-runtime-files.cjs",
);
import { resolveBuildAssets } from "./lib/build-assets.mjs";
import {
  findUnexpectedMainBundleRootScripts,
  isSafeMainBundleManifestPath,
} from "./lib/main-bundle-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const fallbackAppAsar = resolve(root, "release", "linux-arm64-unpacked", "resources", "app.asar");
const maxAppAsarMb = Number(process.env.AVE_MAX_APP_ASAR_MB ?? "100");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const DEFAULT_PACKAGED_ELECTRON_LANGUAGES = Object.freeze(["en-US"]);

function configuredElectronLanguages() {
  const languages = packageJson?.build?.electronLanguages;
  if (!Array.isArray(languages) || languages.length === 0) return [...DEFAULT_PACKAGED_ELECTRON_LANGUAGES];
  return languages.filter((language) => typeof language === "string" && language.length > 0);
}

function macLocaleBundleNames(language) {
  if (language === "en-US") return ["en.lproj"];
  if (language === "zh-CN") return ["zh_CN.lproj", "zh-Hans.lproj"];
  return [`${language.split("-")[0]}.lproj`];
}

const configuredLanguages = configuredElectronLanguages();
const unexpectedConfiguredLanguages = configuredLanguages.filter(
  (language) => !DEFAULT_PACKAGED_ELECTRON_LANGUAGES.includes(language),
);
const missingConfiguredLanguages = DEFAULT_PACKAGED_ELECTRON_LANGUAGES.filter(
  (language) => !configuredLanguages.includes(language),
);
if (unexpectedConfiguredLanguages.length > 0 || missingConfiguredLanguages.length > 0) {
  fail("desktop app must package only the default Electron language; ship UI languages as marketplace language packs", [
    ...missingConfiguredLanguages.map((language) => `missing:${language}`),
    ...unexpectedConfiguredLanguages.map((language) => `unexpected:${language}`),
  ]);
}
const requiredPakLocales = new Set(DEFAULT_PACKAGED_ELECTRON_LANGUAGES.map((language) => `${language}.pak`));
const allowedPakLocales = new Set(configuredLanguages.map((language) => `${language}.pak`));
const requiredMacLocales = new Set(DEFAULT_PACKAGED_ELECTRON_LANGUAGES.flatMap(macLocaleBundleNames));
const allowedMacLocales = new Set(configuredLanguages.flatMap(macLocaleBundleNames));

function fail(message, samples = []) {
  process.stderr.write(`[package-footprint] ERROR: ${message}\n`);
  for (const sample of samples.slice(0, 20)) {
    process.stderr.write(`  - ${sample}\n`);
  }
  process.exit(1);
}

function collectAppAsarCandidates() {
  const releaseDir = resolve(root, "release");
  if (!existsSync(releaseDir)) return [];

  const candidates = [];
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const releaseChildDir = resolve(releaseDir, entry.name);
    const unpackedAppAsar = resolve(releaseChildDir, "resources", "app.asar");
    if (existsSync(unpackedAppAsar)) candidates.push(unpackedAppAsar);

    for (const child of readdirSync(releaseChildDir, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.endsWith(".app")) continue;
      const macAppAsar = resolve(releaseChildDir, child.name, "Contents", "Resources", "app.asar");
      if (existsSync(macAppAsar)) candidates.push(macAppAsar);
    }
  }

  return [...new Set(candidates)];
}

function isCurrentPlatformCandidate(candidate) {
  const normalized = candidate.replaceAll("\\", "/");
  if (process.platform === "darwin") {
    return /\/[^/]+\.app\/Contents\/Resources\/app\.asar$/.test(normalized);
  }
  if (process.platform === "win32") {
    return /\/win-unpacked\/resources\/app\.asar$/.test(normalized);
  }
  if (process.platform === "linux") {
    return /\/(?:linux-unpacked|linux-.+-unpacked)\/resources\/app\.asar$/.test(normalized);
  }
  return false;
}

function defaultAppAsarPath() {
  const candidates = collectAppAsarCandidates();
  const platformCandidates = candidates.filter(isCurrentPlatformCandidate);
  if (platformCandidates.length === 1) return platformCandidates[0];
  if (platformCandidates.length > 1) {
    fail("multiple current-platform app.asar candidates found; pass the target path explicitly", platformCandidates);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    fail("multiple app.asar candidates found; pass the target path explicitly", candidates);
  }
  return fallbackAppAsar;
}

function normalizeAsarEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function asarList(archivePath) {
  try {
    return asar.listPackage(archivePath).map(normalizeAsarEntry).filter(Boolean);
  } catch (err) {
    fail(`failed to list app.asar: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Archive extraction uses stored OS separators; normalize lookup paths to match them.
function extractAsarFile(archivePath, posixPath) {
  return asar.extractFile(archivePath, posixPath.split("/").join(sep));
}

function isMacAppPackage() {
  return basename(appOutDir) === "Contents" && basename(dirname(appOutDir)).endsWith(".app");
}

function isLinuxUnpackedPackage() {
  return basename(appOutDir) === "linux-unpacked" || /^linux-.+-unpacked$/.test(basename(appOutDir));
}

function isWinUnpackedPackage() {
  return basename(appOutDir) === "win-unpacked";
}

function validateMacElectronLocales() {
  const localeResourcesDir = resolve(
    appOutDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  );
  if (!existsSync(localeResourcesDir)) {
    fail(`Electron framework locale resources directory missing: ${localeResourcesDir}`);
  }

  const localeDirs = readdirSync(localeResourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
    .map((entry) => entry.name);
  const missingLocales = [...requiredMacLocales].filter(
    (entry) => !existsSync(resolve(localeResourcesDir, entry, "locale.pak")),
  );
  if (missingLocales.length > 0) fail("required Electron locale bundles missing", missingLocales);
  const unexpectedLocales = localeDirs.filter((entry) => !allowedMacLocales.has(entry));
  if (unexpectedLocales.length > 0) fail("unexpected Electron locale bundles leaked into package", unexpectedLocales);
  return localeDirs.length;
}

function validatePakElectronLocales() {
  const localesDir = resolve(appOutDir, "locales");
  if (!existsSync(localesDir)) fail(`Electron locales directory missing: ${localesDir}`);
  const localeFiles = readdirSync(localesDir).filter((entry) => entry.endsWith(".pak"));
  const missingLocales = [...requiredPakLocales].filter((entry) => !localeFiles.includes(entry));
  if (missingLocales.length > 0) fail("required Electron locale files missing", missingLocales);
  const unexpectedLocales = localeFiles.filter((entry) => !allowedPakLocales.has(entry));
  if (unexpectedLocales.length > 0) fail("unexpected Electron locale files leaked into package", unexpectedLocales);
  return localeFiles.length;
}

const appAsar = process.argv[2] ? resolve(root, process.argv[2]) : defaultAppAsarPath();
const resourcesDir = dirname(appAsar);
const appOutDir = dirname(resourcesDir);

if (!existsSync(appAsar)) fail(`app.asar not found: ${appAsar}`);

const stat = statSync(appAsar);
const appAsarMb = stat.size / 1024 / 1024;
if (appAsarMb > maxAppAsarMb) {
  fail(`app.asar is ${appAsarMb.toFixed(1)} MB, expected <= ${maxAppAsarMb} MB`);
}

const entries = asarList(appAsar);
const entrySet = new Set(entries);
const distRuntimeScriptEntries = resolveBuildAssets(root, "runtime-script")
  .map((asset) => `/${asset.out.slice(root.length + 1).replace(/\\/g, "/")}`);

const requiredEntries = [
  "/dist/src/main/main.js",
  "/dist/src/main/bundle-manifest.json",
  "/dist/src/renderer.js",
  "/dist/src/preload.cjs",
  ...distRuntimeScriptEntries,
  "/package.json",
];
const missingRequired = requiredEntries.filter((entry) => !entrySet.has(entry));
if (missingRequired.length > 0) fail("required runtime entries missing from app.asar", missingRequired);

let mainBundleManifest;
try {
  mainBundleManifest = JSON.parse(
    extractAsarFile(appAsar, "dist/src/main/bundle-manifest.json").toString("utf8"),
  );
} catch (error) {
  fail(`main bundle manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`);
}
if (mainBundleManifest.schemaVersion !== 1 || mainBundleManifest.entry !== "main.js"
    || !Array.isArray(mainBundleManifest.files)) {
  fail("main bundle manifest has an unsupported shape");
}
const mainBundleFiles = new Map();
for (const file of mainBundleManifest.files) {
  const safePath = isSafeMainBundleManifestPath(file?.path) ? file.path
    : null;
  if (!safePath || !Number.isInteger(file.bytes) || file.bytes < 0) {
    fail("main bundle manifest contains an invalid file entry", [JSON.stringify(file)]);
  }
  if (mainBundleFiles.has(safePath)) {
    fail("main bundle manifest contains a duplicate file entry", [safePath]);
  }
  mainBundleFiles.set(safePath, file.bytes);
}
if (!mainBundleFiles.has(mainBundleManifest.entry)) {
  fail("main bundle manifest does not list its declared entry", [mainBundleManifest.entry]);
}
const expectedMainBundleEntries = [...mainBundleFiles.keys()]
  .map((path) => `/dist/src/main/${path}`);
const missingMainBundleEntries = expectedMainBundleEntries.filter((entry) => !entrySet.has(entry));
if (missingMainBundleEntries.length > 0) {
  fail("main-process lazy chunks missing from app.asar", missingMainBundleEntries);
}
for (const [path, expectedBytes] of mainBundleFiles) {
  const actualBytes = extractAsarFile(appAsar, `dist/src/main/${path}`).byteLength;
  if (actualBytes !== expectedBytes) {
    fail("main bundle packaged byte count differs from build manifest", [
      `${path}: expected=${expectedBytes} actual=${actualBytes}`,
    ]);
  }
}
const packagedMainChunkEntries = entries.filter(
  (entry) => /^\/dist\/src\/main\/chunks\/[a-zA-Z0-9_-]+\.js$/.test(entry),
);
const unexpectedMainChunks = packagedMainChunkEntries.filter(
  (entry) => !mainBundleFiles.has(entry.slice("/dist/src/main/".length)),
);
if (unexpectedMainChunks.length > 0) {
  fail("stale main-process chunks leaked into app.asar", unexpectedMainChunks);
}

const packagedMainRootScripts = entries
  .filter((entry) => entry.startsWith("/dist/src/main/"))
  .map((entry) => entry.slice("/dist/src/main/".length));
const unexpectedMainRootScripts = findUnexpectedMainBundleRootScripts(
  packagedMainRootScripts,
  mainBundleFiles.keys(),
);
if (unexpectedMainRootScripts.length > 0) {
  fail(
    "stale main-process root entrypoints leaked into app.asar",
    unexpectedMainRootScripts.map((path) => `/dist/src/main/${path}`),
  );
}

// Missing lazy chunks degrade silently, so assert archive membership at build time.
// Match content-hashed names by pattern.
const LAZY_RENDERER_CHUNKS = [
  { name: "mermaid", pattern: /^\/dist\/src\/renderer\/chunks\/mermaid\.[0-9a-f]{8}\.js$/ },
  // Missing highlighting chunks silently degrade to plain text; assert membership here.
  { name: "highlight", pattern: /^\/dist\/src\/renderer\/chunks\/highlight\.[0-9a-f]{8}\.js$/ },
  { name: "hljs-typescript", pattern: /^\/dist\/src\/renderer\/chunks\/hljs-typescript\.[0-9a-f]{8}\.js$/ },
];
const missingLazyChunks = LAZY_RENDERER_CHUNKS.filter(
  (chunk) => !entries.some((entry) => chunk.pattern.test(entry)),
);
if (missingLazyChunks.length > 0) {
  fail(
    "required lazy renderer chunks missing from app.asar",
    missingLazyChunks.map((chunk) => chunk.name),
  );
}

const rootDevPattern = /^\/(?:\.github|docs|fixtures|release|resources|scripts|src|test)(?:\/|$)/;
const rootDevEntries = entries.filter((entry) => rootDevPattern.test(entry));
if (rootDevEntries.length > 0) fail("root development files leaked into app.asar", rootDevEntries);

const distDevPattern =
  /^\/dist\/.*(?:\/(?:__tests__|__probes__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\.(?:js|cjs|mjs)$)/;
const distDevEntries = entries.filter((entry) => distDevPattern.test(entry));
if (distDevEntries.length > 0) fail("compiled development artifacts leaked into app.asar", distDevEntries);

const redundantRendererSourcePattern = /^\/dist\/src\/(?:components|ui)(?:\/|$)/;
const redundantRendererSourceEntries = entries.filter((entry) => redundantRendererSourcePattern.test(entry));
if (redundantRendererSourceEntries.length > 0) {
  fail("bundled renderer source modules leaked into app.asar", redundantRendererSourceEntries);
}

const allowedDistScriptEntries = new Set([
  "/dist/scripts",
  ...distRuntimeScriptEntries,
]);
const unexpectedDistScripts = entries.filter(
  (entry) => entry.startsWith("/dist/scripts/") && !allowedDistScriptEntries.has(entry),
);
if (unexpectedDistScripts.length > 0) fail("unexpected dist scripts leaked into app.asar", unexpectedDistScripts);

const dependencyDevPattern =
  /^\/node_modules\/(?:(?:@[^/]+\/[^/]+|[^/]+)\/(?:docs?|tests?|__tests__|examples?|benchmarks?|coverage)(?:\/|$)|.*(?:\/(?:browser-test|system-test|[^/]+-test|test-[^/]+)(?:\/|$)|\.(?:map|ts|tsx|mts|cts|md|markdown)$|\.(?:test|spec)\.(?:js|cjs|mjs)$))/;
const dependencyDevEntries = entries.filter((entry) => dependencyDevPattern.test(entry));
if (dependencyDevEntries.length > 0) {
  fail("dependency development artifacts leaked into app.asar", dependencyDevEntries);
}

const buildOnlyPackagePattern =
  /^\/node_modules\/(?:@tailwindcss|tailwindcss|postcss|lightningcss(?:-.+)?|baseline-browser-mapping|caniuse-lite)(?:\/|$)/;
const buildOnlyEntries = entries.filter((entry) => buildOnlyPackagePattern.test(entry));
if (buildOnlyEntries.length > 0) {
  fail("build-only packages leaked into app.asar", buildOnlyEntries);
}

const rendererOnlyPackagePattern =
  /^\/node_modules\/(?:@radix-ui|@azure\/msal-(?:node|common)|react|react-dom|react-day-picker|react-markdown|remark-gfm|lowlight|highlight\.js|cmdk|lucide-react|class-variance-authority|clsx|tailwind-merge|date-fns|eruda)(?:\/|$)/;
const rendererOnlyEntries = entries.filter((entry) => rendererOnlyPackagePattern.test(entry));
if (rendererOnlyEntries.length > 0) {
  fail("renderer-only packages leaked into app.asar", rendererOnlyEntries);
}

const installTimeOnlyPattern = /^\/node_modules\/(?:prebuild-install|napi-build-utils|node-abi)(?:\/|$)/;
const installTimeOnlyEntries = entries.filter((entry) => installTimeOnlyPattern.test(entry));
if (installTimeOnlyEntries.length > 0) {
  fail("install-time-only packages leaked into app.asar", installTimeOnlyEntries);
}

const betterSqliteSourceLeakPattern = /^\/node_modules\/better-sqlite3\/(?:src|binding\.gyp)(?:\/|$)/;
const betterSqliteSourceLeakEntries = entries.filter((entry) => betterSqliteSourceLeakPattern.test(entry));
if (betterSqliteSourceLeakEntries.length > 0) {
  fail("better-sqlite3 build sources leaked into app.asar", betterSqliteSourceLeakEntries);
}

// Derive the native prebuild target from the artifact platform and output-directory architecture.
function resolveBetterSqlitePrebuildTarget() {
  const platformPrefix = isMacAppPackage()
    ? "darwin"
    : isWinUnpackedPackage()
      ? "win32"
      : isLinuxUnpackedPackage()
        ? "linux"
        : process.platform === "darwin"
          ? "darwin"
          : process.platform === "win32"
            ? "win32"
            : "linux";
  const arch = /(?:^|[/\\-])arm64(?:$|[/\\-])/.test(appOutDir) ? "arm64" : "x64";
  return `${platformPrefix}-${arch}`;
}

const unpackedDir = resolve(resourcesDir, "app.asar.unpacked");
const betterSqliteNativeBinding = resolve(
  unpackedDir,
  "node_modules",
  "better-sqlite3",
  "prebuilds",
  `${resolveBetterSqlitePrebuildTarget()}.node`,
);
if (!existsSync(betterSqliteNativeBinding)) {
  fail(`better-sqlite3 native binding missing: ${betterSqliteNativeBinding}`);
}
if (statSync(betterSqliteNativeBinding).size === 0) {
  fail(`better-sqlite3 native binding is empty: ${betterSqliteNativeBinding}`);
}
const betterSqliteBuildSources = resolve(unpackedDir, "node_modules", "better-sqlite3", "deps");
if (existsSync(betterSqliteBuildSources)) {
  fail(`better-sqlite3 build sources leaked into app.asar.unpacked: ${betterSqliteBuildSources}`);
}

const uvDir = resolve(resourcesDir, "uv");
if (!existsSync(uvDir)) fail(`packaged uv resource missing: ${uvDir}`);
const uvTargets = readdirSync(uvDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (uvTargets.length !== 1) fail("packaged uv resource must contain exactly one target", uvTargets);

const uvTargetDir = resolve(uvDir, uvTargets[0]);
const uvFiles = new Set(readdirSync(uvTargetDir));
const uvBin = uvTargets[0].startsWith("win32-") ? "uv.exe" : "uv";
if (uvFiles.has(uvBin)) fail("raw packaged uv binary leaked; expected compressed archive", [...uvFiles]);
if (!uvFiles.has(`${uvBin}.gz`)) fail("compressed packaged uv binary missing", [...uvFiles]);
if (!uvFiles.has("uv.meta.json")) fail("packaged uv metadata missing", [...uvFiles]);

const uvMetaPath = resolve(uvTargetDir, "uv.meta.json");
const uvCompressedBin = resolve(uvTargetDir, `${uvBin}.gz`);
const uvMeta = JSON.parse(readFileSync(uvMetaPath, "utf8"));
if (typeof uvMeta.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(uvMeta.binarySha256)) {
  fail(`packaged uv metadata has invalid binarySha256: ${uvMetaPath}`);
}
const actualUvBinarySha256 = sha256Hex(gunzipSync(readFileSync(uvCompressedBin)));
if (actualUvBinarySha256 !== uvMeta.binarySha256) {
  fail(`packaged uv binary SHA mismatch: expected ${uvMeta.binarySha256}, got ${actualUvBinarySha256}`, [
    uvCompressedBin,
  ]);
}

const uvLicense = resolve(resourcesDir, "licenses", "uv", "LICENSE-MIT");
if (!existsSync(uvLicense)) fail(`uv license notice missing: ${uvLicense}`);
// The bundled model catalog is models.dev data (MIT); its notice ships beside it.
const modelCatalogLicense = resolve(resourcesDir, "licenses", "models.dev", "LICENSE-MIT");
if (!existsSync(modelCatalogLicense)) fail(`models.dev license notice missing: ${modelCatalogLicense}`);
// The packaged rg binary: ripgrep (MIT option), its statically linked PCRE2,
// and the @vscode/ripgrep wrapper each need their notice beside it.
for (const notice of RIPGREP_LICENSE_NOTICES) {
  const path = resolve(resourcesDir, "licenses", "ripgrep", notice);
  if (!existsSync(path)) fail(`ripgrep license notice missing: ${path}`);
}
// The PDF page renderer: canvas wrapper (MIT) and the Skia and third-party code in its binary.
for (const notice of PAGE_RENDERER_LICENSE_NOTICES) {
  const path = resolve(resourcesDir, "licenses", "canvas", notice);
  if (!existsSync(path)) fail(`page renderer license notice missing: ${path}`);
}

const localeCount = isMacAppPackage() ? validateMacElectronLocales() : validatePakElectronLocales();

if (isMacAppPackage()) {
  const libraryDirectory = resolve(
    appOutDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Libraries",
  );
  assertGraphicsRuntimeFiles(libraryDirectory, "darwin");
} else if (isLinuxUnpackedPackage()) {
  assertGraphicsRuntimeFiles(appOutDir, "linux");
} else if (isWinUnpackedPackage()) {
  assertGraphicsRuntimeFiles(appOutDir, "win32");
} else {
  fail(`unrecognized graphics runtime package: ${appOutDir}`);
}

assertSandboxRuntimeFiles(
  resolve(resourcesDir, "app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor"),
  isMacAppPackage() ? "darwin" : isLinuxUnpackedPackage() ? "linux" : "win32",
);

const [imagePlatform, imageArch] = resolveBetterSqlitePrebuildTarget().split("-");
assertImageRuntimeFiles(resolve(unpackedDir, "node_modules"), imagePlatform, imageArch);
assertRipgrepRuntimeFiles(resolve(unpackedDir, "node_modules"), imagePlatform, imageArch);
assertCanvasRuntimeFiles(resolve(unpackedDir, "node_modules"), imagePlatform, imageArch);
assertPdfRuntimeEntries(entries);
assertPdfUnpackedData(resolve(unpackedDir, "node_modules"));

process.stdout.write(
  [
    `[package-footprint] OK`,
    `app.asar=${appAsarMb.toFixed(1)} MB`,
    `entries=${entries.length}`,
    `uvTarget=${uvTargets[0]}`,
    `locales=${localeCount}`,
  ].join(" ") + "\n",
);

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
