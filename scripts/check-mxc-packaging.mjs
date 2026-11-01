// Explicit packaging integration check: actual collector, archive transforms,
// Windows runtime download and the production SDK after-pack finalizer.
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
      const dependencies = {};
      // Copy real installed trees, including the competing top-level semver,
      // so the collector sees the same nested resolution that production uses.
      for (const name of ["@microsoft/mxc-sdk", "koffi", "node-pty", "semver", "node-addon-api"]) {
        const directory = path.join(ROOT, "node_modules", name);
        const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        dependencies[name] = pkg.version;
        await cp(directory, path.join(modules, name), { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      await stageMxcSdkAddon({ arch, projectRoot: project });
      verifyMxcSdkSource(modules, arch, PINS, {});
      await cp(path.join(ROOT, "bun.lock"), path.join(project, "bun.lock"));
      await cp(path.join(ROOT, "resources/licenses/mxc"), path.join(project, "resources/licenses/mxc"), { recursive: true });
      await writeFile(path.join(project, "main.cjs"), "// Packaging entry only; this application is never executed.\n");
      await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "ave-native-payload-check", version: "1.0.0", main: "main.cjs", description: "Native payload packaging check", author: sourcePackage.author, dependencies }));
      const config = {
        appId: "test.ave.native-payload", productName: "Payload", extends: null,
        electronVersion: JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8")).version,
        electronDownload: { cache: electronCache },
        npmRebuild: false, nodeGypRebuild: false, asar: true,
        files: [...sourcePackage.build.files, "main.cjs"], asarUnpack: sourcePackage.build.asarUnpack,
        electronFuses: sourcePackage.build.electronFuses,
        directories: { output: path.join(project, "output") },
        win: { target: "dir", signAndEditExecutable: false, signExecutable: false,
          signExts: sourcePackage.build.win.signExts,
          extraResources: sourcePackage.build.win.extraResources.filter((entry) => entry.to === "licenses/mxc" || entry.to.startsWith("app.asar.unpacked/node_modules/")) },
        afterPack: require.resolve("./mxc-packaging-check-after-pack.cjs"),
      };
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
      verifyMxcSupervisorRuntime(path.join(appOut, "Payload.exe"), resources, arch);
      const unpacked = path.join(resources, "app.asar.unpacked/node_modules");
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
        nestedSemver: { path: PINS.sdk.packages.semver, version: semver.version }, debugSymbols, afterPackVerified: true });
    }
    result.passed = true;
  } catch (error) { result.error = error.message; }
  const observation = await finishPackagingCheck(work, result);
  if (!observation.passed) process.exitCode = 1;
  process.stdout.write(JSON.stringify(observation) + "\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
