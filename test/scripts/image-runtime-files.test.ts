import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { writeImageRuntimePackage } from "../../src/__tests__/support/image-runtime-package.js";

const { assertImageRuntimeFiles } = createRequire(import.meta.url)("../../scripts/lib/image-runtime-files.cjs") as {
  assertImageRuntimeFiles(modules: string, platform: string, arch: string): void;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("packaged image decoder files", () => {
  it.each([["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]])("requires the %s %s target's own regular native files", (platform, arch) => {
    const root = mkdtempSync(join(tmpdir(), "image-package-")); roots.push(root);
    writeImageRuntimePackage(root, platform, arch);
    expect(() => assertImageRuntimeFiles(root, platform, arch)).not.toThrow();
    expect(() => assertImageRuntimeFiles(root, platform, arch === "arm64" ? "x64" : "arm64")).toThrow();
    writeFileSync(join(root, `@img/sharp-${platform}-${arch}/lib/runtime.node`), "");
    expect(() => assertImageRuntimeFiles(root, platform, arch)).toThrow("missing or empty");
  });

  it("requires the separate physical codec library", () => {
    const root = mkdtempSync(join(tmpdir(), "image-package-")); roots.push(root);
    writeImageRuntimePackage(root, "linux");
    rmSync(join(root, "@img/sharp-libvips-linux-x64/lib/runtime-library"));
    expect(() => assertImageRuntimeFiles(root, "linux", "x64")).toThrow("missing or empty");
  });
});
