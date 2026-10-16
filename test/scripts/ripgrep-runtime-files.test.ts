import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RIPGREP_PLATFORM_PACKAGES } from "../../src/tools/ripgrep-executable.js";

const { assertRipgrepRuntimeFiles } = createRequire(import.meta.url)(
  "../../scripts/lib/ripgrep-runtime-files.cjs",
) as {
  assertRipgrepRuntimeFiles(nodeModules: string, platform: string, arch: string): string;
};

const repoRoot = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
/** Every installer target: the three desktop platforms times afterPack's arch enum table. */
const RELEASE_TARGETS = ["darwin", "linux", "win32"].flatMap((platform) =>
  ["x64", "arm64"].map((arch) => ({ platform, arch })));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function nodeModulesWith(platform: string, arch: string, binary: string | null, mode = 0o755): string {
  const root = mkdtempSync(join(tmpdir(), "ripgrep-package-")); roots.push(root);
  const packageName = RIPGREP_PLATFORM_PACKAGES[`${platform}-${arch}` as keyof typeof RIPGREP_PLATFORM_PACKAGES]
    ?? `@vscode/ripgrep-${platform}-${arch}`;
  const packageDir = join(root, ...packageName.split("/"));
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName }));
  if (binary !== null) {
    const path = join(packageDir, "bin", platform === "win32" ? "rg.exe" : "rg");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, binary);
    chmodSync(path, mode);
  }
  return root;
}

describe("ripgrep ships for every release target", () => {
  it("covers exactly the release targets in the runtime resolver", () => {
    expect(Object.keys(RIPGREP_PLATFORM_PACKAGES).sort())
      .toEqual(RELEASE_TARGETS.map(({ platform, arch }) => `${platform}-${arch}`).sort());
  });

  it.each(RELEASE_TARGETS)("pins a lockfile package selected for $platform-$arch", ({ platform, arch }) => {
    const packageName = RIPGREP_PLATFORM_PACKAGES[`${platform}-${arch}` as keyof typeof RIPGREP_PLATFORM_PACKAGES];
    expect(packageName).toBe(`@vscode/ripgrep-${platform}-${arch}`);
    const lock = read("bun.lock");
    const entry = lock.split("\n").find((line) => line.trimStart().startsWith(`"${packageName}": [`));
    expect(entry, `${packageName} missing from bun.lock`).toBeDefined();
    expect(entry).toContain(`"os": "${platform}"`);
    expect(entry).toContain(`"cpu": "${arch}"`);
    const pinned = JSON.parse(read("package.json")).dependencies["@vscode/ripgrep"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry).toContain(`"${packageName}@${pinned}"`);
  });

  it("unpacks the binaries and asserts the packed target in every packaging gate", () => {
    const manifest = JSON.parse(read("package.json"));
    expect(manifest.build.asarUnpack).toContain("node_modules/@vscode/ripgrep*/**");
    expect(read("scripts/electron-after-pack.cjs")).toMatch(/assertRipgrepRuntimeFiles\(join\(electronResourcesDir\(context\), "app\.asar\.unpacked", "node_modules"\)/);
    expect(read("scripts/check-package-footprint.mjs")).toContain("assertRipgrepRuntimeFiles(resolve(unpackedDir, \"node_modules\")");
    expect(read("scripts/build-installers.mjs")).toContain("(arch) => `@vscode/ripgrep-linux-${arch}`");
  });

  it.each(RELEASE_TARGETS)("packaging resolves $platform-$arch to the runtime resolver's package", ({ platform, arch }) => {
    // The fixture is named after the runtime table, so the packaging table
    // must name the same package for this target to pass.
    const modules = nodeModulesWith(platform, arch, "rg");
    expect(assertRipgrepRuntimeFiles(modules, platform, arch)).toMatch(/[\\/]bin[\\/]rg(\.exe)?$/);
    const otherArch = arch === "x64" ? "arm64" : "x64";
    expect(() => assertRipgrepRuntimeFiles(modules, platform, otherArch)).toThrow("packaged ripgrep package missing");
  });

  it("rejects an empty, non-executable or unsupported binary", () => {
    expect(() => assertRipgrepRuntimeFiles(nodeModulesWith("linux", "x64", ""), "linux", "x64")).toThrow("missing or empty");
    expect(() => assertRipgrepRuntimeFiles(nodeModulesWith("linux", "x64", null), "linux", "x64")).toThrow("missing or empty");
    if (process.platform !== "win32") {
      expect(() => assertRipgrepRuntimeFiles(nodeModulesWith("linux", "x64", "rg", 0o644), "linux", "x64")).toThrow("not executable");
    }
    expect(() => assertRipgrepRuntimeFiles(nodeModulesWith("linux", "x64", "rg"), "linux", "ia32")).toThrow("unsupported ripgrep target");
  });
});
