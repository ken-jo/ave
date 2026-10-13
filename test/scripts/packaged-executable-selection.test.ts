import { describe, expect, it } from "vitest";
import { linuxExecutablePreferenceSuffixes, pickBestByExactSuffix } from "../../scripts/lib/packaged-executable-selection.mjs";

/**
 * The installer smoke (scripts/smoke-packaged-app.mjs, run by
 * build-installers.yml) picks the Linux executable to launch with this module.
 * An unpacked tree can hold several candidates; launching the wrong one smokes
 * a binary that is not the one being shipped.
 */
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
