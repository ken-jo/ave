// Regenerate payload observations while preserving separately reviewed archive trust anchors.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageMxcSdkAddon } from "./fetch-mxc.mjs";
import { PACKAGE_RUNTIME_FIELDS, PTY_SOURCE_BUILD_DIRECTORIES } from "./lib/mxc-sdk-integrity.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_PATH = "src/permissions/mxc-launcher-pins.json";
const EXCLUDED_DIRECTORIES = new Set(["test", "tests", "__tests__", "build", "third_party", "third-party", "vendor", "node_modules", "deps", "prebuilds"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const orderedEntries = (object) => Object.entries(object).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

function discoverCode(root, relative, entries) {
  const directory = path.join(root, relative);
  if (realpathSync(directory) !== directory) throw new Error(`Pin source path redirected: ${relative}`);
  for (const name of readdirSync(directory).sort()) {
    const child = relative + "/" + name;
    const entry = lstatSync(path.join(root, child));
    if (entry.isSymbolicLink()) throw new Error(`Pin source path redirected: ${child}`);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(name)
        && !(relative === "node-pty" && PTY_SOURCE_BUILD_DIRECTORIES.includes(name))) discoverCode(root, child, entries);
    } else if (/\.(?:js|cjs|mjs)$/.test(name) && !/(?:^|[.\/_-])test(?:[.\/_-]|$)/.test(child)) entries.add(child);
  }
}

function discoverNativeFiles(root, relative, entries, extensions) {
  const directory = path.join(root, relative);
  if (realpathSync(directory) !== directory) throw new Error(`Pin source path redirected: ${relative}`);
  for (const name of readdirSync(directory).sort()) {
    const child = relative + "/" + name;
    const entry = lstatSync(path.join(root, child));
    if (entry.isSymbolicLink()) throw new Error(`Pin source path redirected: ${child}`);
    if (entry.isDirectory()) discoverNativeFiles(root, child, entries, extensions);
    else if (extensions.has(path.extname(name).toLowerCase())) entries.add(child);
  }
}

function sourceBytes(root, relative) {
  const file = path.join(root, relative);
  if (realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error(`Invalid pin source: ${relative}`);
  return readFileSync(file);
}

export function serializeMxcPins(pins) {
  return JSON.stringify(pins, null, 2) + "\n";
}

export async function generateMxcPins({ projectRoot = PROJECT_ROOT, pins, allowDownload = true, stageAddon = stageMxcSdkAddon, announce = (message) => process.stderr.write(message + "\n") } = {}) {
  projectRoot = realpathSync(projectRoot);
  const original = pins ?? JSON.parse(readFileSync(path.join(projectRoot, PIN_PATH), "utf8"));
  const result = structuredClone(original);
  // Install the lockfile dependency tree first; nested dependency paths are intentional.
  const modules = path.join(projectRoot, "node_modules");
  // Header/build tooling is not loaded by prebuilt native addons. It may be
  // hoisted or omitted by dependency collection and has no runtime pins.
  const paths = new Set(Object.keys(original.sdk.files).filter((relative) => !relative.startsWith("node-pty/node_modules/node-addon-api/")));
  const sdkRoot = original.sdk.packages["@microsoft/mxc-sdk"];
  for (const relative of Object.values(original.sdk.packages)) paths.add(relative + "/package.json");
  if (sdkRoot) discoverCode(modules, sdkRoot + "/dist", paths);
  if (original.sdk.packages.semver) discoverCode(modules, original.sdk.packages.semver, paths);
  discoverCode(modules, "koffi", paths);
  discoverCode(modules, "node-pty", paths);
  result.sdk.files = {};
  result.sdk.packageMetadata = {};
  const observe = (root, relative) => {
    const bytes = sourceBytes(root, relative);
    if (relative.endsWith("/package.json")) {
      const manifest = JSON.parse(bytes.toString("utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error(`Invalid package manifest: ${relative}`);
      // Preserve conditional export/import insertion order and absent fields.
      result.sdk.packageMetadata[relative] = Object.fromEntries(PACKAGE_RUNTIME_FIELDS.filter((field) => Object.hasOwn(manifest, field)).map((field) => [field, manifest[field]]));
    }
    return sha256(bytes);
  };
  for (const relative of [...paths].sort()) result.sdk.files[relative] = observe(modules, relative);
  let temporary;
  try {
    // Preserve reviewed archive trust anchors while discovering native observations.
    // The staging helper checks both archive SHA512 and the existing addon byte pins.
    for (const arch of ["x64", "arm64"]) {
      const addon = original.sdk.addons[arch];
      if (!addon || typeof addon.tarballSha512Base64 !== "string" || !addon.tarballSha512Base64) {
        throw new Error(`Missing reviewed addon archive integrity: ${arch}`);
      }
      const entries = new Set(Object.keys(original.sdk.architectures[arch] ?? {}));
      const addonPrefix = addon.package + "/";
      let addonModules = modules;
      if (!existsSync(path.join(modules, original.sdk.addons[arch].package))) {
        if (!allowDownload) throw new Error(`Missing ${arch} addon; rerun without --no-download to stage its verified archive`);
        temporary ??= realpathSync(mkdtempSync(path.join(tmpdir(), "ave-mxc-pin-sources-")));
        announce(`update-mxc-pins: staging verified ${arch} addon archive in an isolated temporary directory`);
        await stageAddon({ arch, projectRoot: temporary });
        addonModules = path.join(temporary, "node_modules");
      }
      entries.add(addonPrefix + "package.json");
      discoverCode(addonModules, addon.package, entries);
      discoverNativeFiles(addonModules, addonPrefix + `win32_${arch}`, entries, new Set([".node", ".dll"]));
      discoverNativeFiles(modules, `node-pty/prebuilds/win32-${arch}`, entries, new Set([".node", ".dll", ".exe"]));
      if (sdkRoot) {
        discoverNativeFiles(modules, sdkRoot + `/bin/${arch}`, entries, new Set([".dll"]));
      }
      result.sdk.architectures[arch] = Object.fromEntries([...entries].sort().map((relative) => [relative, observe(relative.startsWith(addonPrefix) ? addonModules : modules, relative)]));
      // A source install normally includes launchers; a reduced install retains the
      // reviewed anchor and cannot replace it with a newly observed value.
      const launcher = `@microsoft/mxc-sdk/bin/${arch}/wxc-exec.exe`;
      if (existsSync(path.join(modules, launcher)) && sha256(sourceBytes(modules, launcher)) !== original.wxcExecSha256[arch]) {
        throw new Error(`Launcher trust anchor mismatch: ${arch}; review the archive and launcher pins explicitly`);
      }
    }
    result.sdk.versions = Object.fromEntries(orderedEntries(original.sdk.packages).map(([name, relative]) => {
      const metadata = result.sdk.packageMetadata[relative + "/package.json"];
      if (metadata?.name !== name) throw new Error(`Package identity mismatch: ${name}`);
      return [name, metadata.version];
    }));
    const license = path.join(projectRoot, "resources/licenses/mxc/LICENSE.md");
    if (sha256(readFileSync(license)) !== original.licenseSha256) throw new Error("License trust anchor mismatch; review the archive and license pins explicitly");
    result.sdk.notices = Object.fromEntries(orderedEntries(original.sdk.notices).map(([name]) => [name, sha256(readFileSync(path.join(projectRoot, "resources/licenses/mxc", name)))]));
    result.sdk.packageMetadata = Object.fromEntries(orderedEntries(result.sdk.packageMetadata));
    return result;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

// Check mode performs the same verified staging as update mode; --no-download
// requires both target addon packages to be present in the installed tree.
export async function updateMxcPins({ projectRoot = PROJECT_ROOT, check = false, ...options } = {}) {
  const target = path.join(projectRoot, PIN_PATH);
  const before = readFileSync(target, "utf8");
  const after = serializeMxcPins(await generateMxcPins({ projectRoot, ...options }));
  if (check && before !== after) throw new Error("MXC pins have drifted; run node scripts/update-mxc-pins.mjs and review the changes");
  if (!check && before !== after) writeFileSync(target, after);
  return before !== after;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--check", "--no-download"].includes(arg))) throw new Error("Usage: update-mxc-pins.mjs [--check] [--no-download]");
    const changed = await updateMxcPins({ check: args.includes("--check"), allowDownload: !args.includes("--no-download") });
    process.stdout.write(`update-mxc-pins: ${changed ? "updated" : "current"}\n`);
  } catch (error) {
    process.stderr.write(`update-mxc-pins: ${error.message}\n`);
    process.exitCode = 1;
  }
}
