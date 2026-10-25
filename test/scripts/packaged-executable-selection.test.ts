import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPackagedExecutable,
  linuxExecutablePreferenceSuffixes,
  pickBestByExactSuffix,
} from "../../scripts/lib/packaged-executable-selection.mjs";

// Selecting the wrong executable can make a packaged smoke pass against another artifact.
describe("Linux packaged executable selection", () => {
  const preferences: string[] = linuxExecutablePreferenceSuffixes("arm64", "/");

  it("lists native-architecture suffixes before the generic unpacked directory", () => {
    expect(preferences).toEqual([
      "/linux-arm64-unpacked/Ave",
      "/linux-arm64-unpacked/ave",
      "/linux-unpacked/Ave",
      "/linux-unpacked/ave",
    ]);
    expect(linuxExecutablePreferenceSuffixes("x64", "\\")[0]).toBe("\\linux-x64-unpacked\\Ave");
  });

  it("prefers the native-architecture directory over a generic or foreign one", () => {
    expect(pickBestByExactSuffix([
      "/release/linux-unpacked/ave",
      "/release/linux-x64-unpacked/Ave",
      "/release/linux-arm64-unpacked/ave",
    ], preferences)).toBe("/release/linux-arm64-unpacked/ave");
  });

  it("within one directory, prefers the product name in preference order", () => {
    expect(pickBestByExactSuffix([
      "/release/linux-arm64-unpacked/ave",
      "/release/linux-arm64-unpacked/Ave",
    ], preferences)).toBe("/release/linux-arm64-unpacked/Ave");
  });

  it("matches an exact path suffix, not a substring buried deeper in the tree", () => {
    expect(pickBestByExactSuffix([
      "/release/linux-x64-unpacked/resources/notlinux-arm64-unpacked/Ave",
      "/release/linux-unpacked/Ave",
    ], preferences)).toBe("/release/linux-unpacked/Ave");
  });

  it("returns null when there is no candidate", () => {
    expect(pickBestByExactSuffix([], preferences)).toBeNull();
  });
});

// Derive the executable name from the artifact product metadata.
describe("Windows packaged executable selection", () => {
  let releaseDir: string;

  beforeEach(() => {
    releaseDir = mkdtempSync(join(tmpdir(), "packaged-exe-selection-"));
  });

  afterEach(() => {
    rmSync(releaseDir, { recursive: true, force: true });
  });

  function touch(...segments: string[]): string {
    const file = join(releaseDir, ...segments);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
    return file;
  }

  it("selects the executable named after build.productName", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { build: { productName: string } };
    const productName = packageJson.build.productName;
    const exe = touch("win-unpacked", `${productName}.exe`);
    touch("win-unpacked", "resources", "elevate.exe");
    expect(findPackagedExecutable("win", releaseDir)).toBe(exe);
  });

  it("returns null when win-unpacked holds no product executable", () => {
    touch("win-unpacked", "resources", "elevate.exe");
    expect(findPackagedExecutable("win", releaseDir)).toBeNull();
  });
});
