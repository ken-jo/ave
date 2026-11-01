import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeMxcRuntimePackage } from "../../src/__tests__/support/mxc-runtime-package.js";
import { verifyMxcSdk } from "../../scripts/lib/mxc-sdk-integrity.mjs";
// @ts-expect-error standalone packaging check has no declaration output
import { packagingCheckArchitectures } from "../../scripts/check-mxc-packaging.mjs";

const require = createRequire(import.meta.url);

describe("native payload packager integration", () => {
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
