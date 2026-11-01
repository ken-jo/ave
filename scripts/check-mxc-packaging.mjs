// Explicit packaging integration check: actual collector, archive transforms,
// Windows runtime download and the production SDK after-pack finalizer.
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { stageMxcSdkAddon } from "./fetch-mxc.mjs";
import { verifyMxcSdkSource, verifyMxcSupervisorRuntime } from "./lib/mxc-sdk-integrity.mjs";
import { assertPackagedMxcSdk } from "./lib/mxc-sdk-packaging.mjs";
import PINS from "../src/permissions/mxc-launcher-pins.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

export function packagingCheckArchitectures(argv) {
  if (argv.length === 0) return ["x64", "arm64"];
  if (argv.length === 2 && argv[0] === "--arch" && ["x64", "arm64"].includes(argv[1])) return [argv[1]];
  throw new Error("Expected --arch x64|arm64, or no arguments for both");
}

export function packagingCheckCache(work, environment = process.env) {
  const configured = environment.ELECTRON_CACHE;
  if (configured !== undefined && (!configured || !path.isAbsolute(configured))) throw new Error("ELECTRON_CACHE must be an absolute directory");
  return configured ?? path.join(work, "cache", "electron");
}

// Keep production collection/filtering configuration intact. Only application
// assets, native-helper build hooks and signing are outside this payload check.
export function packagingCheckConfiguration(sourcePackage, { project, electronCache, electronVersion }) {
  const build = sourcePackage.build;
  return {
    ...build, extends: null, electronVersion,
    electronDownload: { ...build.electronDownload, cache: electronCache },
    npmRebuild: false, nodeGypRebuild: false,
    directories: { ...build.directories, output: path.join(project, "output"), buildResources: path.join(ROOT, "build") },
    beforePack: null, afterSign: null,
    afterPack: require.resolve("./mxc-packaging-check-after-pack.cjs"),
    extraResources: [],
    win: { ...build.win, target: "dir", signAndEditExecutable: false, signExecutable: false,
      extraResources: build.win.extraResources.filter((entry) => entry.to === "licenses/mxc" || entry.to.startsWith("app.asar.unpacked/node_modules/")) },
  };
}

export function assertNoPackagedBuildHeaders(resources) {
  const asar = require("@electron/asar");
  const previousNoAsar = process.noAsar;
  let names;
  process.noAsar = true;
  try { names = asar.listPackage(path.join(resources, "app.asar")); }
  finally { process.noAsar = previousNoAsar; }
  const unexpected = names.find((name) => /^[\\/]node_modules[\\/](?:node-pty[\\/]node_modules[\\/])?node-addon-api(?:[\\/]|$)/.test(name));
  if (unexpected) throw new Error(`Unexpected packaged build-only headers: ${unexpected}`);
  for (const relative of ["node-addon-api", "node-pty/node_modules/node-addon-api"]) {
    const directory = path.join(resources, "app.asar.unpacked", "node_modules", relative);
    if (existsSync(directory)) throw new Error(`Unexpected packaged build-only headers: ${directory}`);
  }
}

export async function assertPackagingStagePaths(modules, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported SDK addon architecture");
  const inspect = async (file, recursive = false) => {
    let entry;
    try { entry = await lstat(file); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (entry.isSymbolicLink() || await realpath(file) !== path.resolve(file)) throw new Error(`Packaging staging path redirected: ${file}`);
    if (recursive && entry.isDirectory()) for (const name of await readdir(file)) await inspect(path.join(file, name), true);
  };
  await inspect(modules);
  await inspect(path.join(modules, "@koromix"));
  await inspect(path.join(modules, "@koromix", `koffi-win32-${arch}`), true);
}

export async function finishPackagingCheck(work, result) {
  if (result.passed) {
    try {
      await rm(work, { recursive: true });
      return { ...result, workRemoved: true };
    } catch (error) { result = { ...result, passed: false, error: `Packaging cleanup failed: ${error.message}` }; }
  }
  const retained = { ...result, workRemoved: false, resultFile: path.join(work, "result.json") };
  try { await writeFile(retained.resultFile, JSON.stringify(retained, null, 2) + "\n"); }
  catch (error) { retained.retentionError = error.message; }
  return retained;
}

async function main() {
  const architectures = packagingCheckArchitectures(process.argv.slice(2));
  const work = await realpath(await mkdtemp(path.join(tmpdir(), "ave-mxc-package-check-")));
  const result = { check: "mxc-real-packaging", host: process.platform, work, nativeExecuted: false, passed: false, observations: [] };
  try {
    const sourcePackage = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    const electronCache = packagingCheckCache(work);
    for (const arch of architectures) {
      const project = path.join(work, arch), modules = path.join(project, "node_modules");
      await mkdir(modules, { recursive: true });
      // Preserve the complete installed graph and the production root manifest.
      // Adding synthetic direct dependencies changes collector hoisting decisions.
      await cp(path.join(ROOT, "node_modules"), modules, {
        recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      });
      const sourceHeaders = JSON.parse(await readFile(path.join(modules, "node-pty/node_modules/node-addon-api/package.json"), "utf8"));
      if (sourceHeaders.name !== "node-addon-api") throw new Error("Expected installed nested PTY build headers");
      await assertPackagingStagePaths(modules, arch);
      await stageMxcSdkAddon({ arch, projectRoot: project });
      verifyMxcSdkSource(modules, arch, PINS, {});
      await cp(path.join(ROOT, "bun.lock"), path.join(project, "bun.lock"));
      await cp(path.join(ROOT, "resources/licenses/mxc"), path.join(project, "resources/licenses/mxc"), { recursive: true });
      await mkdir(path.dirname(path.join(project, sourcePackage.main)), { recursive: true });
      await writeFile(path.join(project, sourcePackage.main), "// Packaging entry only; this application is never executed.\n");
      await writeFile(path.join(project, "package.json"), JSON.stringify(sourcePackage));
      const config = packagingCheckConfiguration(sourcePackage, { project, electronCache,
        electronVersion: JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8")).version });
      const configFile = path.join(project, "builder.json");
      await writeFile(configFile, JSON.stringify(config));
      const builder = require.resolve("electron-builder/cli.js");
      const args = [builder, "--win", "--dir", `--${arch}`, "--publish=never", "--config", configFile, "--projectDir", project];
      const build = spawnSync(process.execPath, args, {
        cwd: project, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CSC_IDENTITY_AUTO_DISCOVERY: "false",
          ELECTRON_CACHE: electronCache, ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? path.join(work, "cache", "builder") },
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      });
      await writeFile(path.join(project, "builder.log"), (build.stdout ?? "") + (build.stderr ?? ""));
      if (build.error) throw build.error;
      if (build.status !== 0) throw new Error(`Real ${arch} packaging failed (${build.status}); see ${path.join(project, "builder.log")}`);
      const appOut = path.join(project, "output", arch === "x64" ? "win-unpacked" : "win-arm64-unpacked");
      const resources = path.join(appOut, "resources");
      assertPackagedMxcSdk(resources, arch);
      verifyMxcSupervisorRuntime(path.join(appOut, `${sourcePackage.build.productName}.exe`), resources, arch);
      const unpacked = path.join(resources, "app.asar.unpacked/node_modules");
      assertNoPackagedBuildHeaders(resources);
      const debugSymbols = (await readdir(path.join(unpacked, "node-pty/prebuilds", `win32-${arch}`), { recursive: true })).filter((file) => file.endsWith(".pdb"));
      if (debugSymbols.length) throw new Error("Unexpected packaged debug symbols");
      const manifests = {};
      for (const name of ["@microsoft/mxc-sdk", "koffi", "node-pty"]) {
        const file = path.join(unpacked, name, "package.json"), bytes = await readFile(file);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        manifests[name] = { sha256, bytes: bytes.length, normalized: sha256 !== PINS.sdk.files[`${name}/package.json`] };
      }
      const semver = JSON.parse(await readFile(path.join(unpacked, PINS.sdk.packages.semver, "package.json"), "utf8"));
      result.observations.push({ arch, passed: true, appOut, builderArguments: args.slice(1), manifests,
        nestedSemver: { path: PINS.sdk.packages.semver, version: semver.version },
        buildHeaders: { sourcePresent: true, sourceVersion: sourceHeaders.version, packagedAbsent: true }, debugSymbols, afterPackVerified: true });
    }
    result.passed = true;
  } catch (error) { result.error = error.message; }
  const observation = await finishPackagingCheck(work, result);
  if (!observation.passed) process.exitCode = 1;
  process.stdout.write(JSON.stringify(observation) + "\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
