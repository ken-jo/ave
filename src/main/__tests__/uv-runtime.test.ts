import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { aveHome } from "../../shared/ave-home.js";
import { currentUvTarget, resolveBundledUvBinaryPath } from "../uv-runtime.js";

describe("resolveBundledUvBinaryPath", () => {
  it("uses the canonical project resources directory for a split main chunk in development", () => {
    const projectRoot = resolve("uv-runtime-fixture");
    const target = currentUvTarget({ platform: "linux", arch: "x64" });

    expect(resolveBundledUvBinaryPath({
      defaultApp: true,
      requireDevBinary: false,
      projectRoot,
      platform: "linux",
      arch: "x64",
    })).toBe(join(projectRoot, "resources", "uv", target.dir, target.bin));
  });

  it("preserves an explicit module-directory seam for callers that supply one", () => {
    const moduleDir = resolve("uv-runtime-fixture", "dist", "src", "main");
    const target = currentUvTarget({ platform: "linux", arch: "x64" });

    expect(resolveBundledUvBinaryPath({
      defaultApp: true,
      requireDevBinary: false,
      moduleDir,
      platform: "linux",
      arch: "x64",
    })).toBe(join(moduleDir, "..", "..", "..", "resources", "uv", target.dir, target.bin));
  });
});

describe("materializing the packaged uv binary into the runtime boundary", () => {
  function packagedResources(): { resourcesPath: string; target: ReturnType<typeof currentUvTarget> } {
    const target = currentUvTarget();
    const resourcesPath = mkdtempSync(join(tmpdir(), "ave-uv-boundary-resources-"));
    const bytes = Buffer.from("uv-binary-fixture");
    mkdirSync(join(resourcesPath, "uv", target.dir), { recursive: true });
    writeFileSync(join(resourcesPath, "uv", target.dir, `${target.bin}.gz`), gzipSync(bytes));
    writeFileSync(join(resourcesPath, "uv", target.dir, "uv.meta.json"), JSON.stringify({ binarySha256: sha256Hex(bytes) }));
    return { resourcesPath, target };
  }

  it("refuses to recreate a missing runtime boundary instead of creating it with a recursive mkdir", () => {
    const { resourcesPath } = packagedResources();
    const runtime = join(aveHome(), "runtime");
    rmSync(runtime, { recursive: true, force: true });
    try {
      expect(() => resolveBundledUvBinaryPath({ resourcesPath })).toThrow(/missing, a link, or not protected; restart Ave to recreate it/);
      expect(existsSync(runtime)).toBe(false);
    } finally { rmSync(resourcesPath, { recursive: true, force: true }); }
  });

  it("materializes uv inside the runtime boundary boot created", () => {
    const { resourcesPath, target } = packagedResources();
    mkdirSync(join(aveHome(), "runtime"), { recursive: true, mode: 0o700 });
    try {
      const binary = resolveBundledUvBinaryPath({ resourcesPath });
      expect(binary.startsWith(join(aveHome(), "runtime", "uv", target.dir))).toBe(true);
      expect(readFileSync(binary, "utf8")).toBe("uv-binary-fixture");
    } finally { rmSync(resourcesPath, { recursive: true, force: true }); }
  });
});
