import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../../__tests__/support/content-hash.js";
import { MxcIntegrityError, verifyMxcSdk } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import PINS from "../mxc-launcher-pins.json" with { type: "json" };

const roots: string[] = [];

function installation() {
  const directory = mkdtempSync(path.join(tmpdir(), "ave-sdk-integrity-")); roots.push(directory);
  const root = path.join(directory, "node_modules");
  const files: Record<string, string> = {};
  const versions = { "@microsoft/mxc-sdk": "1.0.1", koffi: "3.3.6", semver: "7.7.4", "node-pty": "1.1.0" };
  const put = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
    files[file] = contentHash(contents);
  };
  for (const [name, version] of Object.entries(versions)) put(`${name}/package.json`, JSON.stringify({ name, version }));
  put("@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll", "fixture-dll");
  put("@koromix/koffi-win32-x64/package.json", JSON.stringify({ name: "@koromix/koffi-win32-x64", main: "index.js" }));
  put("@koromix/koffi-win32-x64/index.js", "module.exports = {};");
  put("@koromix/koffi-win32-x64/win32_x64/koffi.node", "fixture-addon");
  return { root, pins: { sdk: { versions, files, architectures: { x64: {} } } } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed SDK integrity", () => {
  it("verifies pinned bytes and the exact package resolution", () => {
    const { root, pins } = installation();
    expect(verifyMxcSdk(root, "x64", pins, {}).nativeDirectories).toEqual([
      path.join(root, "@microsoft/mxc-sdk/bin/x64"), path.join(root, "@koromix/koffi-win32-x64/win32_x64"),
    ]);
  });

  it.each(["MXC_FFI_DIR", "mxc_ffi_dir", "NODE_OPTIONS", "NODE_PATH"])("rejects loader override %s", (key) => {
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
    expect(() => verifyMxcSdk(root, "x64", pins, {})).toThrow(/Unexpected native payload/);
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

  it("keeps runtime-relative SDK and addon paths unpacked and SDK imports external", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@microsoft/mxc-sdk"]).toBe(PINS.version);
    for (const rule of ["node_modules/@microsoft/mxc-sdk/**", "node_modules/koffi/**", "node_modules/semver/**", "node_modules/@koromix/koffi-win32-*/**", "node_modules/node-pty/**"]) expect(pkg.build.asarUnpack).toContain(rule);
    expect(readFileSync("scripts/lib/main-bundle-externals.mjs", "utf8")).toContain('"@microsoft/mxc-sdk"');
    expect(readFileSync("scripts/electron-before-pack.cjs", "utf8")).toContain("verifyMxcSdk(");
    expect(readFileSync("scripts/electron-after-pack.cjs", "utf8")).toContain("prunePackagedMxcSdk(");
    expect(readFileSync("scripts/smoke-packaged-app.mjs", "utf8")).toContain("assertPackagedMxcSdk(");
  });
});
