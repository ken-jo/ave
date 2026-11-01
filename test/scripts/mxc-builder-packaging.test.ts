import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeMxcRuntimePackage } from "../../src/__tests__/support/mxc-runtime-package.js";
import { verifyMxcSdk } from "../../scripts/lib/mxc-sdk-integrity.mjs";
// @ts-expect-error standalone packaging check has no declaration output
import { finishPackagingCheck, packagingCheckArchitectures, packagingCheckCache } from "../../scripts/check-mxc-packaging.mjs";

const require = createRequire(import.meta.url);

describe("native payload packager integration", () => {
  it("uses the persistent runtime cache when configured and otherwise owns its cache", () => {
    const work = path.resolve(tmpdir(), "packaging-run"), cache = path.resolve(tmpdir(), "runtime-cache");
    expect(packagingCheckCache(work, {})).toBe(path.join(work, "cache", "electron"));
    expect(packagingCheckCache(work, { ELECTRON_CACHE: cache })).toBe(cache);
    expect(() => packagingCheckCache(work, { ELECTRON_CACHE: "" })).toThrow("absolute directory");
    expect(() => packagingCheckCache(work, { ELECTRON_CACHE: "relative" })).toThrow("absolute directory");
  });

  it("removes only successful work trees while retaining failed runs at the reported path", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ave-packaging-cleanup-"));
    try {
      const success = path.join(parent, "success"), failure = path.join(parent, "failure"), cache = path.join(parent, "cache");
      for (const directory of [success, failure, cache]) mkdirSync(directory);
      writeFileSync(path.join(cache, "archive.zip"), "cached");
      const completed = await finishPackagingCheck(success, { passed: true, work: success });
      expect(completed).toMatchObject({ passed: true, workRemoved: true, work: success });
      expect(existsSync(success)).toBe(false);
      expect(existsSync(path.join(cache, "archive.zip"))).toBe(true);
      const failed = await finishPackagingCheck(failure, { passed: false, work: failure, error: "verification failed" });
      expect(failed).toMatchObject({ passed: false, workRemoved: false, work: failure, resultFile: path.join(failure, "result.json") });
      expect(JSON.parse(readFileSync(failed.resultFile, "utf8"))).toEqual(failed);
      const missing = path.join(parent, "missing");
      const lostReport = await finishPackagingCheck(missing, { passed: false, work: missing, error: "verification failed" });
      expect(lostReport).toMatchObject({ passed: false, workRemoved: false, work: missing, error: "verification failed", retentionError: expect.any(String) });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("selects both target architectures by default and rejects ambiguous arguments", () => {
    expect(packagingCheckArchitectures([])).toEqual(["x64", "arm64"]);
    expect(packagingCheckArchitectures(["--arch", "arm64"])).toEqual(["arm64"]);
    expect(() => packagingCheckArchitectures(["--arch", "ia32"])).toThrow("Expected --arch");
    expect(() => packagingCheckArchitectures(["--arch", "x64", "--publish", "always"])).toThrow("Expected --arch");
  });

  it("accepts the installed packager's real manifest transformation while verifying runtime bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ave-package-transform-"));
    try {
      const resources = path.join(root, "resources");
      const pins = JSON.parse(readFileSync(writeMxcRuntimePackage(resources, path.join(root, "Payload.exe")), "utf8"));
      const modules = path.join(resources, "app.asar.unpacked", "node_modules");
      const { createTransformer } = require("app-builder-lib/out/fileTransformer.js");
      const transform = createTransformer(path.dirname(modules), {}, undefined);
      for (const relative of Object.keys({ ...pins.sdk.files, ...pins.sdk.architectures.x64 }).filter((file) => file.endsWith("/package.json"))) {
        const file = path.join(modules, relative), transformed = await transform(file);
        if (transformed !== null && transformed !== undefined) writeFileSync(file, transformed);
      }
      const sdkManifest = JSON.parse(readFileSync(path.join(modules, "@microsoft/mxc-sdk/package.json"), "utf8"));
      expect(sdkManifest.scripts).toBeUndefined();
      expect(sdkManifest.keywords).toBeUndefined();
      expect(() => verifyMxcSdk(modules, "x64", pins, {}, true)).not.toThrow();
      writeFileSync(path.join(modules, "@microsoft/mxc-sdk/dist/v1/index.js"), "tampered");
      expect(() => verifyMxcSdk(modules, "x64", pins, {}, true)).toThrow("Native payload hash mismatch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("declares the nested dependency copy and non-runtime debug-symbol exclusion", () => {
    const { build } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(build.win.extraResources).toContainEqual({
      from: "node_modules/@microsoft/mxc-sdk/node_modules/semver",
      to: "app.asar.unpacked/node_modules/@microsoft/mxc-sdk/node_modules/semver", filter: ["**/*"],
    });
    expect(build.files).toContain("!node_modules/node-pty/prebuilds/win32-*/**/*.pdb");
    expect(readFileSync("scripts/electron-after-pack.cjs", "utf8")).toContain("finalizePackagedMxcSdk(");
    expect(readFileSync("scripts/mxc-packaging-check-after-pack.cjs", "utf8")).toContain("finalizePackagedMxcSdk(");
  });
});
