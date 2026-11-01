import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../../src/__tests__/support/content-hash.js";
// @ts-expect-error — plain .mjs script without declarations
import { generateMxcPins, serializeMxcPins, updateMxcPins } from "../../scripts/update-mxc-pins.mjs";

const roots: string[] = [];
const pinPath = "src/permissions/mxc-launcher-pins.json";
function put(root: string, relative: string, value: string) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mxc-pin-test-"));
  roots.push(root);
  const manifest = { name: "fixture", version: "1.0.0", exports: { default: "./default.js", node: "./node.js" }, imports: { "#entry": { default: "./default.js", node: "./node.js" } } };
  for (const directory of ["koffi", "node-pty/lib", "node-pty/scripts", "node-pty/node_modules/node-addon-api"]) {
    put(root, "node_modules/" + directory + "/index.js", "module.exports = 1;\n");
  }
  put(root, "node_modules/koffi/package.json", JSON.stringify(manifest));
  put(root, "node_modules/node-pty/node_modules/node-addon-api/package.json", JSON.stringify({ name: "node-addon-api", version: "1.0.0" }));
  put(root, "node_modules/node-pty/node_modules/node-addon-api/package-support.json", "{}");
  put(root, "resources/licenses/mxc/LICENSE.md", "license");
  put(root, "resources/licenses/mxc/notice.txt", "notice");
  for (const arch of ["x64", "arm64"]) put(root, `node_modules/node-pty/prebuilds/win32-${arch}/pty.node`, arch);
  const pins = {
    package: "fixture", version: "1.0.0", tarballSha512Base64: "archive-anchor", licenseSha256: contentHash("license"),
    wxcExecSha256: { x64: "launcher-anchor", arm64: "launcher-anchor" },
    sdk: {
      files: { "koffi/package.json": "stale" }, versions: { fixture: "1.0.0" }, packages: { fixture: "koffi" }, packageMetadata: {},
      notices: { "notice.txt": "stale" },
      architectures: Object.fromEntries(["x64", "arm64"].map((arch) => [arch, {
        [`@koromix/koffi-win32-${arch}/package.json`]: "stale", [`@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`]: "stale",
      }])),
      addons: Object.fromEntries(["x64", "arm64"].map((arch) => [arch, { package: `@koromix/koffi-win32-${arch}`, version: "1.0.0", tarballSha512Base64: "addon-anchor" }])),
    },
  };
  put(root, pinPath, serializeMxcPins(pins));
  const stagedRoots: string[] = [];
  const stageAddon = async ({ arch, projectRoot }: { arch: string; projectRoot: string }) => {
    stagedRoots.push(projectRoot);
    put(projectRoot, `node_modules/@koromix/koffi-win32-${arch}/package.json`, JSON.stringify({ name: `@koromix/koffi-win32-${arch}`, version: "1.0.0" }));
    put(projectRoot, `node_modules/@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`, arch);
    put(projectRoot, `node_modules/@koromix/koffi-win32-${arch}/index.js`, "module.exports = {};\n");
  };
  return { projectRoot: root, stageAddon, announce: () => {}, stagedRoots };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("SDK pin generation", () => {
  it("is deterministic, observes both native targets, and preserves reviewed anchors", async () => {
    const options = fixture();
    const first = await generateMxcPins(options);
    const second = await generateMxcPins(options);
    expect(serializeMxcPins(first)).toBe(serializeMxcPins(second));
    expect(first.tarballSha512Base64).toBe("archive-anchor");
    expect(first.sdk.versions.fixture).toBe("1.0.0");
    for (const arch of ["x64", "arm64"]) {
      expect(first.sdk.addons[arch].tarballSha512Base64).toBe("addon-anchor");
      expect(first.sdk.architectures[arch][`@koromix/koffi-win32-${arch}/win32_${arch}/koffi.node`]).toBe(contentHash(arch));
    }
    expect(options.stagedRoots.every((root) => !existsSync(root))).toBe(true);
    expect(existsSync(path.join(options.projectRoot, "node_modules/@koromix"))).toBe(false);
  });

  it("records semantic field absence and conditional declaration order", async () => {
    const options = fixture();
    const generated = await generateMxcPins(options);
    const metadata = generated.sdk.packageMetadata["koffi/package.json"];
    expect(Object.keys(metadata.exports)).toEqual(["default", "node"]);
    expect(Object.keys(metadata.imports["#entry"])).toEqual(["default", "node"]);
    expect(Object.hasOwn(metadata, "type")).toBe(false);
    expect(Object.hasOwn(metadata, "main")).toBe(false);
    expect(generated.sdk.packageMetadata["node-pty/node_modules/node-addon-api/package.json"].name).toBe("node-addon-api");
  });

  it("discovers shipped code and omits excluded test and build code", async () => {
    const options = fixture();
    for (const relative of ["koffi/extra.mjs", "koffi/extra.cjs", "koffi/src/runtime.js", "node-pty/scripts/new.js", "node-pty/lib/new.js"]) put(options.projectRoot, "node_modules/" + relative, "code");
    for (const relative of ["koffi/tests/extra.js", "koffi/build/extra.js", "node-pty/lib/new.test.js"]) put(options.projectRoot, "node_modules/" + relative, "test");
    const generated = await generateMxcPins(options);
    expect(generated.sdk.files["koffi/extra.mjs"]).toBe(contentHash("code"));
    expect(generated.sdk.files["koffi/extra.cjs"]).toBe(contentHash("code"));
    expect(generated.sdk.files["koffi/src/runtime.js"]).toBe(contentHash("code"));
    expect(generated.sdk.files["node-pty/scripts/new.js"]).toBe(contentHash("code"));
    expect(Object.keys(generated.sdk.files).some((name) => name.includes("extra.js") || name.includes("new.test.js"))).toBe(false);
  });

  it("restores deleted manifest, code and native pins from installed inventories", async () => {
    const options = fixture();
    const root = options.projectRoot;
    const pins = JSON.parse(readFileSync(path.join(root, pinPath), "utf8"));
    pins.package = "@microsoft/mxc-sdk";
    pins.sdk.packages[pins.package] = "@microsoft/mxc-sdk";
    pins.sdk.packages.semver = "@microsoft/mxc-sdk/node_modules/semver";
    put(root, "node_modules/@microsoft/mxc-sdk/node_modules/semver/package.json", JSON.stringify({ name: "semver", version: "1.0.0" }));
    put(root, "node_modules/@microsoft/mxc-sdk/node_modules/semver/functions/valid.js", "semver code");
    put(root, "node_modules/@microsoft/mxc-sdk/package.json", JSON.stringify({ name: pins.package, version: "1.0.0" }));
    put(root, "node_modules/@microsoft/mxc-sdk/dist/index.js", "sdk code");
    for (const arch of ["x64", "arm64"]) {
      put(root, `node_modules/@microsoft/mxc-sdk/bin/${arch}/runtime.dll`, arch);
      put(root, `node_modules/node-pty/prebuilds/win32-${arch}/symbols.pdb`, "symbols");
    }
    put(root, pinPath, serializeMxcPins(pins));
    await updateMxcPins(options);
    const complete = readFileSync(path.join(root, pinPath), "utf8");
    const incomplete = JSON.parse(complete);
    delete incomplete.sdk.files["koffi/package.json"];
    delete incomplete.sdk.files["koffi/index.js"];
    delete incomplete.sdk.files["node-pty/lib/index.js"];
    delete incomplete.sdk.files["node-pty/node_modules/node-addon-api/index.js"];
    delete incomplete.sdk.files["@microsoft/mxc-sdk/dist/index.js"];
    delete incomplete.sdk.files["@microsoft/mxc-sdk/node_modules/semver/functions/valid.js"];
    delete incomplete.sdk.architectures.x64["node-pty/prebuilds/win32-x64/pty.node"];
    delete incomplete.sdk.architectures.arm64["@microsoft/mxc-sdk/bin/arm64/runtime.dll"];
    delete incomplete.sdk.architectures.arm64["@koromix/koffi-win32-arm64/index.js"];
    delete incomplete.sdk.architectures.arm64["@koromix/koffi-win32-arm64/package.json"];
    delete incomplete.sdk.architectures.arm64["@koromix/koffi-win32-arm64/win32_arm64/koffi.node"];
    put(root, pinPath, serializeMxcPins(incomplete));
    await expect(updateMxcPins({ ...options, check: true })).rejects.toThrow(/drifted/);
    await updateMxcPins(options);
    expect(readFileSync(path.join(root, pinPath), "utf8")).toBe(complete);
    expect(complete).not.toContain("symbols.pdb");
    delete incomplete.sdk.addons.arm64.tarballSha512Base64;
    put(root, pinPath, serializeMxcPins(incomplete));
    await expect(updateMxcPins(options)).rejects.toThrow(/Missing reviewed addon archive integrity: arm64/);
  });

  it("check detects newly shipped root code and update records its bytes", async () => {
    const options = fixture();
    await updateMxcPins(options);
    const before = readFileSync(path.join(options.projectRoot, pinPath), "utf8");
    for (const name of ["entry.js", "entry.cjs", "entry.mjs"]) put(options.projectRoot, "node_modules/node-pty/" + name, name);
    put(options.projectRoot, "node_modules/node-pty/node_modules/unlisted/index.js", "unlisted");
    for (const directory of ["test", "tests", "build", "deps", "src", "prebuilds", "third_party", "vendor"]) {
      put(options.projectRoot, `node_modules/node-pty/${directory}/excluded.js`, "excluded");
    }
    await expect(updateMxcPins({ ...options, check: true })).rejects.toThrow(/drifted/);
    expect(readFileSync(path.join(options.projectRoot, pinPath), "utf8")).toBe(before);
    expect(await updateMxcPins(options)).toBe(true);
    const generated = JSON.parse(readFileSync(path.join(options.projectRoot, pinPath), "utf8"));
    for (const name of ["entry.js", "entry.cjs", "entry.mjs"]) expect(generated.sdk.files["node-pty/" + name]).toBe(contentHash(name));
    expect(Object.keys(generated.sdk.files).some((name) => name.includes("excluded.js") || name.includes("unlisted"))).toBe(false);
    expect(await updateMxcPins({ ...options, check: true })).toBe(false);
  });

  it("check detects raw file and metadata drift without writing", async () => {
    const options = fixture();
    await updateMxcPins(options);
    const before = readFileSync(path.join(options.projectRoot, pinPath), "utf8");
    expect(await updateMxcPins({ ...options, check: true })).toBe(false);
    put(options.projectRoot, "node_modules/koffi/index.js", "changed");
    await expect(updateMxcPins({ ...options, check: true })).rejects.toThrow(/drifted/);
    expect(readFileSync(path.join(options.projectRoot, pinPath), "utf8")).toBe(before);
    put(options.projectRoot, "node_modules/koffi/package.json", JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }));
    await expect(updateMxcPins({ ...options, check: true })).rejects.toThrow(/drifted/);
    expect(readFileSync(path.join(options.projectRoot, pinPath), "utf8")).toBe(before);
  });

  it("rejects redirected code and missing native files instead of retaining old pins", async () => {
    const options = fixture();
    const code = path.join(options.projectRoot, "node_modules/koffi/index.js");
    rmSync(code);
    symlinkSync("package.json", code);
    await expect(generateMxcPins(options)).rejects.toThrow(/redirected/);
    rmSync(code);
    writeFileSync(code, "code");
    const stageAddon = async (input: { arch: string; projectRoot: string }) => {
      await options.stageAddon(input);
      rmSync(path.join(input.projectRoot, `node_modules/@koromix/koffi-win32-${input.arch}/win32_${input.arch}/koffi.node`));
    };
    await expect(generateMxcPins({ ...options, stageAddon })).rejects.toThrow();
    expect(options.stagedRoots.every((root) => !existsSync(root))).toBe(true);
  });

  it("fails on absent targets without download and cleans failed staging", async () => {
    const options = fixture();
    await expect(generateMxcPins({ ...options, allowDownload: false })).rejects.toThrow(/Missing x64 addon/);
    let temporary = "";
    await expect(generateMxcPins({ ...options, stageAddon: async ({ projectRoot }: { projectRoot: string }) => {
      temporary = projectRoot;
      throw new Error("archive refused");
    } })).rejects.toThrow(/archive refused/);
    expect(temporary).not.toBe("");
    expect(existsSync(temporary)).toBe(false);
  });
});
