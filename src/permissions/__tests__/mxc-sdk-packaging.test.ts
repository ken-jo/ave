import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../../__tests__/support/content-hash.js";
import { assertMxcSdkInventory, MxcIntegrityError, verifyMxcSdk } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import type { MxcSdkPins } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import PINS from "../mxc-launcher-pins.json" with { type: "json" };

const roots: string[] = [];

function installation() {
  const directory = mkdtempSync(path.join(tmpdir(), "ave-sdk-integrity-")); roots.push(directory);
  const root = path.join(directory, "node_modules");
  const files: Record<string, string> = {};
  const packageMetadata: MxcSdkPins["sdk"]["packageMetadata"] = {};
  const versions = { "@microsoft/mxc-sdk": "1.0.1", koffi: "3.3.6", semver: "7.7.4", "node-pty": "1.1.0" };
  const put = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
    files[file] = contentHash(contents);
  };
  for (const [name, version] of Object.entries(versions)) {
    const manifest = { name, version, exports: { ".": "./index.js" } };
    packageMetadata[`${name}/package.json`] = manifest;
    put(`${name}/package.json`, JSON.stringify({ ...manifest, scripts: { test: "unused" }, keywords: ["fixture"] }));
    put(`${name}/index.js`, "module.exports = {};\n");
  }
  put("@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll", "fixture-dll");
  const addonManifest = { name: "@koromix/koffi-win32-x64", version: "3.3.6", main: "index.js" };
  packageMetadata["@koromix/koffi-win32-x64/package.json"] = addonManifest;
  put("@koromix/koffi-win32-x64/package.json", JSON.stringify(addonManifest));
  put("@koromix/koffi-win32-x64/index.js", "module.exports = {};");
  put("@koromix/koffi-win32-x64/win32_x64/koffi.node", "fixture-addon");
  return { root, pins: { sdk: { versions, packages: Object.fromEntries(Object.keys(versions).map((name) => [name, name])), packageMetadata, files, architectures: { x64: {} } } } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed SDK integrity", () => {
  it("verifies executable bytes and the exact package resolution", () => {
    const { root, pins } = installation();
    expect(verifyMxcSdk(root, "x64", pins, {}).nativeDirectories).toEqual([
      path.join(root, "@microsoft/mxc-sdk/bin/x64"), path.join(root, "@koromix/koffi-win32-x64/win32_x64"),
    ]);
  });

  it("accepts removed build metadata while retaining source manifest byte pins", () => {
    const { root, pins } = installation();
    const file = "koffi/package.json";
    const rawPin = pins.sdk.files[file];
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    delete manifest.scripts;
    delete manifest.keywords;
    writeFileSync(path.join(root, file), JSON.stringify(manifest, null, 2));
    expect(contentHash(readFileSync(path.join(root, file)))).not.toBe(rawPin);
    expect(() => verifyMxcSdk(root, "x64", pins, {})).not.toThrow();
    expect(pins.sdk.files[file]).toBe(rawPin);
  });

  it.each(["name", "version", "main", "exports", "type", "imports"])("rejects runtime manifest changes to %s", (field) => {
    const { root, pins } = installation();
    const file = path.join(root, "koffi/package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest[field] = field === "exports" || field === "imports" ? { ".": "./other.js" } : "changed";
    writeFileSync(file, JSON.stringify(manifest));
    expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Runtime package metadata mismatch/);
  });

  it("rejects removed runtime fields, explicit nulls, and reordered export conditions", () => {
    for (const change of ["removed", "null", "reordered"]) {
      const { root, pins } = installation();
      const relative = "koffi/package.json";
      const manifest = { name: "koffi", version: "3.3.6", exports: { ".": { default: "./index.js", node: "./index.js" } } };
      pins.sdk.packageMetadata[relative] = structuredClone(manifest);
      const changed: Record<string, unknown> = structuredClone(manifest);
      if (change === "removed") delete changed.exports;
      else if (change === "null") changed.main = null;
      else changed.exports = { ".": { node: "./index.js", default: "./index.js" } };
      writeFileSync(path.join(root, relative), JSON.stringify(changed));
      expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Runtime package metadata mismatch/);
    }
  });

  it("requires every manifest's runtime metadata pin", () => {
    for (const missing of ["map", "manifest"]) {
      const { root, pins } = installation();
      if (missing === "map") Reflect.deleteProperty(pins.sdk, "packageMetadata");
      else delete pins.sdk.packageMetadata["@koromix/koffi-win32-x64/package.json"];
      expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Missing or invalid package metadata pin/);
    }
  });

  it.each(["MXC_FFI_DIR", "mxc_ffi_dir", "MXC_BIN_DIR", "mxc_bin_dir", "NODE_OPTIONS", "NODE_PATH"])("rejects loader override %s", (key) => {
    const { root, pins } = installation();
    expect(() => verifyMxcSdk(root, "x64", pins, { [key]: "" })).toThrow(MxcIntegrityError);
  });

  it("rejects mutated DLL, JS and addon bytes", () => {
    for (const file of ["@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll", "@koromix/koffi-win32-x64/index.js", "@koromix/koffi-win32-x64/win32_x64/koffi.node"]) {
      const { root, pins } = installation();
      writeFileSync(path.join(root, file), "tampered");
      expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/hash mismatch/);
    }
  });

  it("rejects a planted dependency without loading it", () => {
    const { root, pins } = installation();
    writeFileSync(path.join(root, "@microsoft/mxc-sdk/bin/x64/planted.dll"), "must never execute");
    expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Unexpected installed SDK file/);
  });

  it("rejects missing native bytes and unsupported architectures", () => {
    const { root, pins } = installation();
    rmSync(path.join(root, "@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll"));
    expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(MxcIntegrityError);
    expect(() => verifyMxcSdk(root, "ia32", pins, {})).toThrow(MxcIntegrityError);
  });
});

describe("SDK packaging source assertions", () => {
  it("pins the installed JS dependency graph and both SDK DLL architectures", () => {
    const modules = path.resolve("node_modules");
    for (const [relative, expected] of Object.entries(PINS.sdk.files)) {
      expect(contentHash(readFileSync(path.join(modules, relative))), relative).toBe(expected);
    }
    for (const arch of ["x64", "arm64"] as const) {
      for (const [relative, expected] of Object.entries(PINS.sdk.architectures[arch])) {
        if (relative.startsWith("@koromix/")) continue;
        expect(contentHash(readFileSync(path.join(modules, relative))), relative).toBe(expected);
      }
      expect(Object.hasOwn(PINS.sdk.architectures[arch], `@microsoft/mxc-sdk/bin/${arch}/wxc-exec.exe`)).toBe(false);
    }
  });

  it("records runtime semantics for every source-pinned package manifest", () => {
    const manifests = [...Object.keys(PINS.sdk.files), ...Object.values(PINS.sdk.architectures).flatMap(Object.keys)]
      .filter((file) => file.endsWith("/package.json"));
    expect(Object.keys(PINS.sdk.packageMetadata).sort()).toEqual(manifests.sort());
    const fields = ["name", "version", "main", "exports", "type", "imports"];
    for (const relative of Object.keys(PINS.sdk.files).filter((file) => file.endsWith("/package.json"))) {
      const manifest = JSON.parse(readFileSync(path.join("node_modules", relative), "utf8"));
      expect(PINS.sdk.packageMetadata[relative as keyof typeof PINS.sdk.packageMetadata]).toEqual(
        Object.fromEntries(fields.filter((field) => Object.hasOwn(manifest, field)).map((field) => [field, manifest[field]])),
      );
    }
    for (const arch of ["x64", "arm64"] as const) {
      expect(PINS.sdk.packageMetadata[`@koromix/koffi-win32-${arch}/package.json`]).toEqual({
        name: PINS.sdk.addons[arch].package, version: PINS.sdk.addons[arch].version, main: "./index.js",
      });
      expect(Object.keys(PINS.sdk.architectures[arch]).some((file) => file.endsWith(".pdb"))).toBe(false);
    }
    expect(PINS.sdk.excludedPayloads).toEqual([{
      category: "debug-symbols", pattern: "node-pty/prebuilds/win32-*/**/*.pdb",
      reason: "Debug symbols are not loaded by the runtime and are excluded from packaged native payloads.",
    }]);
  });

  it("keeps runtime-relative SDK and addon paths unpacked and SDK imports external", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@microsoft/mxc-sdk"]).toBe(PINS.version);
    for (const rule of ["node_modules/@microsoft/mxc-sdk/**", "node_modules/koffi/**", "node_modules/@koromix/koffi-win32-*/**", "node_modules/node-pty/**"]) expect(pkg.build.asarUnpack).toContain(rule);
    expect(pkg.build.asarUnpack).not.toContain("node_modules/semver/**");
    expect(readFileSync("scripts/lib/main-bundle-externals.mjs", "utf8")).toContain('"@microsoft/mxc-sdk"');
    expect(readFileSync("scripts/electron-before-pack.cjs", "utf8")).toContain("verifyMxcSdk(");
    expect(readFileSync("scripts/electron-after-pack.cjs", "utf8")).toContain("finalizePackagedMxcSdk(");
    expect(readFileSync("scripts/smoke-packaged-app.mjs", "utf8")).toContain("assertPackagedMxcSdk(");
  });
});

describe("strict bootstrap native directory inventory", () => {
  it("rejects every additional file, including a non-DLL, before bootstrap loading", () => {
    for (const name of ["planted.dll", "extra.txt"]) {
      const { root, pins } = installation();
      writeFileSync(path.join(root, "@microsoft/mxc-sdk/bin/x64", name), "unexpected");
      expect(() => verifyMxcSdk(root, "x64", pins, {}, true)).toThrow(MxcIntegrityError);
    }
  });
});

describe("packaged supervisor runtime byte inventory", () => {
  it("records target runtime bytes and rejects altered or newly planted DLLs", async () => {
    const { recordMxcSupervisorRuntime } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const { verifyMxcSupervisorRuntime } = await import("../../../scripts/lib/mxc-sdk-integrity.mjs");
    const root = mkdtempSync(path.join(tmpdir(), "ave-runtime-inventory-")); roots.push(root);
    const resources = path.join(root, "resources"), executable = path.join(root, "Ave.exe");
    writeFileSync(executable, "unit-runtime-bytes");
    writeFileSync(path.join(root, "runtime.dll"), "unit-dll-bytes");
    recordMxcSupervisorRuntime(resources, "x64", executable);
    expect(verifyMxcSupervisorRuntime(executable, resources, "x64")).toContain(executable);
    writeFileSync(path.join(root, "planted.dll"), "unexpected");
    expect(() => verifyMxcSupervisorRuntime(executable, resources, "x64")).toThrow(/Unexpected supervisor runtime DLL/);
    rmSync(path.join(root, "planted.dll"));
    writeFileSync(path.join(root, "runtime.dll"), "changed");
    expect(() => verifyMxcSupervisorRuntime(executable, resources, "x64")).toThrow(/runtime mismatch/);
  });

  it("keeps addon archive pins aligned with locked resolutions and verifies notice bytes", () => {
    const lock = readFileSync("bun.lock", "utf8");
    for (const arch of ["x64", "arm64"] as const) expect(lock).toContain(`sha512-${PINS.sdk.addons[arch].tarballSha512Base64}`);
    for (const [notice, expected] of Object.entries(PINS.sdk.notices)) {
      expect(contentHash(readFileSync(path.join("resources/licenses/mxc", notice))), notice).toBe(expected);
    }
    expect(readFileSync("scripts/electron-after-sign.cjs", "utf8")).toContain("recordMxcSupervisorRuntime(");
    expect(readFileSync("scripts/electron-before-pack.cjs", "utf8")).toContain("stageMxcSdkAddon(");
  });
});


describe("installed SDK import graph", () => {
  it("verifies an isolated copy of the real installed layout without modifying shared dependencies", () => {
    const installed = path.resolve("node_modules");
    expect(() => assertMxcSdkInventory(installed, PINS)).not.toThrow();
    const directory = mkdtempSync(path.join(tmpdir(), "ave-sdk-real-tree-")); roots.push(directory);
    const modules = path.join(directory, "node_modules");
    const pins = structuredClone(PINS);
    const entries = { ...pins.sdk.files, ...pins.sdk.architectures.x64 };
    const addonPrefix = "@koromix/koffi-win32-x64/";
    const substituted = !existsSync(path.join(installed, addonPrefix));
    // Copy actual installed JS and its nested dependency layout. Only absent
    // target-addon bytes are substituted, exclusively beneath this temp root.
    for (const relative of Object.keys(entries)) {
      if (substituted && relative.startsWith(addonPrefix)) continue;
      const file = path.join(modules, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync(path.join(installed, relative), file);
    }
    if (substituted) {
      const files = {
        "package.json": JSON.stringify(pins.sdk.packageMetadata["@koromix/koffi-win32-x64/package.json"]),
        "index.js": "throw new Error('Verification fixture must never execute');\n",
        "win32_x64/koffi.node": "native bytes are not loaded by integrity verification",
      };
      for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(modules, addonPrefix, relative);
        mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents);
        (pins.sdk.architectures.x64 as Record<string, string>)[addonPrefix + relative] = contentHash(contents);
      }
    }
    expect(verifyMxcSdk(modules, "x64", pins, {}).sdkRoot).toBe(path.join(modules, "@microsoft/mxc-sdk"));
    expect(pins.sdk.packages.semver).toBe("@microsoft/mxc-sdk/node_modules/semver");
    expect(JSON.parse(readFileSync(path.join(modules, pins.sdk.packages.semver, "package.json"), "utf8")).version).toBe(pins.sdk.versions.semver);
    expect(readFileSync("bun.lock", "utf8")).toContain(`"@microsoft/mxc-sdk/semver": ["semver@${pins.sdk.versions.semver}"`);
    writeFileSync(path.join(modules, pins.sdk.packages.semver, "index.js"), "tampered isolated entry");
    expect(() => verifyMxcSdk(modules, "x64", pins, {})).toThrow(/hash mismatch/);
    expect(contentHash(readFileSync(path.join(installed, pins.sdk.packages.semver, "index.js")))).toBe(pins.sdk.files["@microsoft/mxc-sdk/node_modules/semver/index.js"]);
  });

  it("records the actual spawn and probe import-condition graph without executing native code", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: ["node_modules/@microsoft/mxc-sdk/dist/v1/index.js"],
      bundle: true, write: false, metafile: true, platform: "node", format: "esm",
      conditions: ["node", "import"], mainFields: ["main"],
      // The only deferred package import is the separate PTY path. Optional
      // native addons are byte-verified separately, never executed here.
      external: ["node-pty", "@koromix/*"], logLevel: "silent",
    });
    const graph = Object.keys(result.metafile!.inputs).map((file) => file.replace(/^node_modules\//, ""));
    for (const file of graph) expect(Object.hasOwn(PINS.sdk.files, file), file).toBe(true);
    for (const file of ["koffi/index.js", "koffi/src/koffi/index.js", "koffi/src/koffi/src/static.js",
      "@microsoft/mxc-sdk/dist/bindings/streaming.js", "@microsoft/mxc-sdk/dist/bindings/probe.js",
      "@microsoft/mxc-sdk/node_modules/semver/index.js"]) expect(graph).toContain(file);
  });

  it("rejects an unpinned import-condition entry even when the require entry stays pinned", () => {
    const { root, pins } = installation();
    const manifest = JSON.stringify({ name: "koffi", version: "3.3.6", exports: { ".": { import: "./unverified.js", require: "./index.js" } } });
    writeFileSync(path.join(root, "koffi/package.json"), manifest);
    pins.sdk.files["koffi/package.json"] = contentHash(manifest);
    pins.sdk.packageMetadata["koffi/package.json"] = JSON.parse(manifest);
    writeFileSync(path.join(root, "koffi/unverified.js"), "throw new Error('Must not execute');");
    expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Runtime resolution redirected: koffi/);
  });
});

describe("native signing and supervisor prerequisites", () => {
  it("excludes every pinned executable and DLL from payload re-signing", () => {
    const config = JSON.parse(readFileSync("package.json", "utf8")).build;
    for (const arch of ["x64", "arm64"] as const) {
      for (const relative of [...Object.keys(PINS.sdk.files), ...Object.keys(PINS.sdk.architectures[arch]), `mxc/${arch}/wxc-exec.exe`]) {
        if (/\.(exe|dll)$/i.test(relative)) expect(config.win.signExts, relative).toContain("!" + path.basename(relative));
      }
    }
  });

  it("requires an enabled runtime node-mode fuse before packaging", async () => {
    const { assertMxcSupervisorFuse } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const config = JSON.parse(readFileSync("package.json", "utf8")).build;
    expect(() => assertMxcSupervisorFuse(config)).not.toThrow();
    expect(() => assertMxcSupervisorFuse({ ...config, electronFuses: { runAsNode: false } })).toThrow(/RunAsNode fuse/);
    expect(() => assertMxcSupervisorFuse({})).toThrow(/RunAsNode fuse/);
  });

  it("prunes a previous target addon from each subsequent architecture package idempotently", async () => {
    const { pruneMxcSdkAddonArchitectures } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const root = mkdtempSync(path.join(tmpdir(), "ave-addon-architecture-")); roots.push(root);
    for (const arch of ["x64", "arm64"] as const) {
      for (const installed of ["x64", "arm64"]) mkdirSync(path.join(root, "@koromix", `koffi-win32-${installed}`), { recursive: true });
      pruneMxcSdkAddonArchitectures(root, arch);
      pruneMxcSdkAddonArchitectures(root, arch);
      expect(readdirSync(path.join(root, "@koromix"))).toEqual([`koffi-win32-${arch}`]);
    }
  });
});


describe("packaged PTY native footprint", () => {
  it("excludes the real source-build native inventory while retaining runtime prebuilds", () => {
    const root = path.resolve(".");
    const config = JSON.parse(readFileSync("package.json", "utf8")).build;
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js");
    const filter = new FileMatcher(root, root, (value: string) => value, config.files).createFilter();
    const sources = path.join(root, "node_modules/node-pty/third_party");
    const files = readdirSync(sources, { recursive: true }).map(String).filter((file) => /\.(exe|dll)$/i.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const absolute = path.join(sources, file);
      expect(filter(absolute, statSync(absolute)), file).toBe(false);
    }
    for (const arch of ["x64", "arm64"]) {
      const file = path.join(root, "node_modules/node-pty/prebuilds", "win32-" + arch, "conpty/conpty.dll");
      expect(filter(file, statSync(file))).toBe(true);
    }
  });

  it("rejects leaked source-build payloads in the final unpacked tree", async () => {
    const { assertPackagedMxcSdk } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const root = mkdtempSync(path.join(tmpdir(), "ave-pty-package-")); roots.push(root);
    const directory = path.join(root, "app.asar.unpacked/node_modules/node-pty/third_party/conpty/win10-arm64");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "conpty.dll"), "unexpected foreign source-build bytes");
    expect(() => assertPackagedMxcSdk(root, "x64")).toThrow("Unexpected packaged PTY source-build payload");
  });
});


describe("runtime fuse defaults and signing order", () => {
  it("preserves every other installed runtime fuse default when enabling node mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ave-fuse-wire-")); roots.push(root);
    const previousCache = process.env.JITI_FS_CACHE;
    process.env.JITI_FS_CACHE = "false";
    try {
      const require = createRequire(import.meta.url);
      const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
      const { PlatformPackager } = builderRequire("app-builder-lib");
      const { getCurrentFuseWire, flipFuses } = builderRequire("@electron/fuses");
      const fuseRequire = createRequire(builderRequire.resolve("@electron/fuses"));
      const { SENTINEL, FuseState } = fuseRequire("./constants.js");
      const config = JSON.parse(readFileSync("package.json", "utf8")).build;
      expect(config.electronFuses).toEqual({ runAsNode: true });
      const defaults = await getCurrentFuseWire(require("electron"));
      const indices = Object.keys(defaults).filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
      expect(indices.length).toBeGreaterThanOrEqual(8);
      expect(defaults[0]).toBe(FuseState.ENABLE);
      const file = path.join(root, "runtime-wire.exe");
      // Exercise the installed fuse writer on a wire fixture initialized from the
      // real pristine runtime. No executable is launched or dependency modified.
      writeFileSync(file, Buffer.concat([Buffer.from(SENTINEL), Buffer.from([1, indices.length, ...indices.map((index) => defaults[index])])]));
      const generated = await PlatformPackager.prototype.generateFuseConfig.call({}, config.electronFuses);
      await flipFuses(file, generated);
      expect(await getCurrentFuseWire(file)).toEqual(defaults);
    } finally {
      if (previousCache === undefined) delete process.env.JITI_FS_CACHE;
      else process.env.JITI_FS_CACHE = previousCache;
    }
  });

  it("retains the installed builder's fuse, signing and notarization order", () => {
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
    const platform = readFileSync(builderRequire.resolve("app-builder-lib/out/platformPackager.js"), "utf8");
    const mac = readFileSync(builderRequire.resolve("app-builder-lib/out/macPackager.js"), "utf8");
    const fuses = platform.indexOf("await this.doAddElectronFuses(packContext)");
    const sign = platform.indexOf("await this.doSignAfterPack(", fuses);
    expect(fuses).toBeGreaterThan(0); expect(sign).toBeGreaterThan(fuses);
    const macSign = mac.indexOf("await this.doSign(signOptions,");
    expect(macSign).toBeGreaterThan(0);
    expect(mac.indexOf("await this.helper.notarizeIfProvided(appPath)", macSign)).toBeGreaterThan(macSign);
    expect(platform).toContain("this.generateFuseConfig(this.config.electronFuses)");
  });
});


describe("complete installed SDK inventory", () => {
  it("rejects extra executable JS and native files rather than copying only the pins", () => {
    for (const relative of ["dist/planted.js", "bin/x64/planted.dll", "bin/x64/unknown.exe", "extra.json", "node_modules/semver/planted.js", "node_modules/unexpected/package.json", "node_modules/.bin/planted.js"]) {
      const { root, pins } = installation();
      const file = path.join(root, "@microsoft/mxc-sdk", relative);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "unexpected");
      expect(() => assertMxcSdkInventory(root, pins)).toThrow(/Unexpected installed SDK file/);
    }
  });
});


it("permits only named package-manager command shims and excludes them from packaging", () => {
  const { root, pins } = installation();
  const directory = path.join(root, "@microsoft/mxc-sdk/node_modules/.bin");
  mkdirSync(directory, { recursive: true });
  for (const name of ["semver", "semver.cmd", "semver.ps1", "semver.exe", "semver.bunx"]) writeFileSync(path.join(directory, name), "package manager shim");
  expect(() => assertMxcSdkInventory(root, pins)).not.toThrow();
  expect(JSON.parse(readFileSync("package.json", "utf8")).build.files).toContain("!node_modules/@microsoft/mxc-sdk/node_modules/.bin{,/**/*}");
});

describe("packaging payload failures", () => {
  function packageRoot() {
    const root = mkdtempSync(path.join(tmpdir(), "ave-package-missing-"));
    roots.push(root);
    return root;
  }

  function expectMissingPayload(operation: () => unknown, file: string) {
    let caught: unknown;
    try { operation(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MxcIntegrityError);
    expect((caught as Error).message).toBe(`Native SDK packaging payload missing: ${file}`);
    let cause = (caught as Error).cause as NodeJS.ErrnoException;
    while (cause instanceof MxcIntegrityError) cause = cause.cause as NodeJS.ErrnoException;
    expect(cause).toMatchObject({ code: "ENOENT", path: file });
  }

  it("reports the missing unpacked modules path from packaged verification", async () => {
    const { assertPackagedMxcSdk } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const resources = packageRoot();
    mkdirSync(path.join(resources, "app.asar.unpacked"));
    expectMissingPayload(() => assertPackagedMxcSdk(resources, "x64"), path.join(resources, "app.asar.unpacked", "node_modules"));
  });

  it("reports the exact missing pinned file from packaged verification", async () => {
    const { assertPackagedMxcSdk } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const resources = packageRoot();
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    const file = path.join(modules, Object.keys(PINS.sdk.files)[0]!);
    mkdirSync(path.dirname(file), { recursive: true });
    expectMissingPayload(() => assertPackagedMxcSdk(resources, "x64"), file);
  });

  it.each(["scope", "bin", "architecture", "addon"] as const)("reports a missing %s directory while pruning the package", async (missing) => {
    const { prunePackagedMxcSdk } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const resources = packageRoot();
    const modules = path.join(resources, "app.asar.unpacked", "node_modules");
    const scope = path.join(modules, "@koromix");
    const addon = path.join(scope, "koffi-win32-x64", "win32_x64");
    const bin = path.join(modules, "@microsoft", "mxc-sdk", "bin");
    if (missing !== "scope") mkdirSync(path.dirname(addon), { recursive: true });
    if (["architecture", "addon"].includes(missing)) mkdirSync(bin, { recursive: true });
    if (missing === "addon") mkdirSync(path.join(bin, "x64"));
    const expected = { scope, bin, architecture: path.join(bin, "x64"), addon }[missing];
    expectMissingPayload(() => prunePackagedMxcSdk(resources, "x64"), expected);
  });

  it("reports a missing addon scope from the standalone architecture pruner", async () => {
    const { pruneMxcSdkAddonArchitectures } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const modules = packageRoot();
    expectMissingPayload(() => pruneMxcSdkAddonArchitectures(modules, "x64"), path.join(modules, "@koromix"));
  });

  it.each(["directory", "executable"] as const)("reports a missing runtime %s before recording pins", async (missing) => {
    const { recordMxcSupervisorRuntime } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const root = packageRoot();
    const directory = missing === "directory" ? path.join(root, "runtime") : root;
    const executable = path.join(directory, "Ave.exe");
    const resources = path.join(root, "resources");
    expectMissingPayload(() => recordMxcSupervisorRuntime(resources, "x64", executable), missing === "directory" ? directory : executable);
    expect(existsSync(path.join(resources, "mxc", "x64", "supervisor-runtime-pins.json"))).toBe(false);
  });

  it("preserves existing integrity errors unrelated to missing payloads", async () => {
    const { assertPackagedMxcSdk } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    expect(() => assertPackagedMxcSdk(packageRoot(), "ia32")).toThrow("Unsupported SDK installation or architecture");
    expect(() => assertPackagedMxcSdk(packageRoot(), "ia32")).toThrow(MxcIntegrityError);
  });

  it("preserves filesystem errors other than missing payloads", async () => {
    const { recordMxcSupervisorRuntime } = await import("../../../scripts/lib/mxc-sdk-packaging.mjs");
    const root = packageRoot();
    const executable = path.join(root, "Ave.exe");
    mkdirSync(executable);
    let caught: unknown;
    try { recordMxcSupervisorRuntime(path.join(root, "resources"), "x64", executable); } catch (error) { caught = error; }
    expect(caught).not.toBeInstanceOf(MxcIntegrityError);
    expect(caught).toMatchObject({ code: "EISDIR" });
  });
});
