// Release versions outrank prereleases; numeric prerelease identifiers compare numerically.
import { describe, it, expect } from "vitest";
import { compareSemver } from "../../shared/semver-compare.js";

describe("compareSemver", () => {
  it("orders plain numeric cores", () => {
    expect(Math.sign(compareSemver("1.0.0", "2.0.0"))).toBe(-1);
    expect(Math.sign(compareSemver("1.2.0", "1.10.0"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.1", "1.0.0"))).toBe(1);
    expect(Math.sign(compareSemver("1.0.0", "1.0.0"))).toBe(0);
  });

  it("ranks a release ABOVE its own pre-release (the bug)", () => {
    expect(Math.sign(compareSemver("1.0.0", "1.0.0-beta"))).toBe(1);
    expect(Math.sign(compareSemver("1.0.0-beta", "1.0.0"))).toBe(-1);
    expect(Math.sign(compareSemver("2.0.0-rc.1", "2.0.0"))).toBe(-1);
  });

  it("a pre-release of a higher core still beats a lower release", () => {
    expect(Math.sign(compareSemver("2.0.0-alpha", "1.9.9"))).toBe(1);
  });

  it("orders pre-release identifiers per semver precedence", () => {
    expect(Math.sign(compareSemver("1.0.0-alpha", "1.0.0-beta"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.0-1", "1.0.0-alpha"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.0-beta", "1.0.0-beta"))).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(Math.sign(compareSemver("1.0.0+build.9", "1.0.0+build.1"))).toBe(0);
    expect(Math.sign(compareSemver("1.0.0-beta+exp", "1.0.0-beta"))).toBe(0);
  });

  it("sorting a mixed list picks the final release as newest", () => {
    const versions = ["1.0.0-alpha", "1.0.0", "1.0.0-beta", "0.9.0", "1.0.0-rc.1"];
    const sorted = [...versions].sort((a, b) => compareSemver(a, b));
    expect(sorted[sorted.length - 1]).toBe("1.0.0");
    expect(sorted[0]).toBe("0.9.0");
  });
});
