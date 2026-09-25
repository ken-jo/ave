/**
 * Unit tests for the shared semver comparator + the plugin↔app minimum-version
 * gate predicate (`appVersionSatisfiesMin`).
 */
import { describe, it, expect } from "vitest";
import {
  compareSemver,
  appVersionSatisfiesMin,
  isSemver,
  isTwoMinorReleasesBehind,
  SEMVER_CORE_PATTERN,
} from "../semver-compare.js";

describe("compareSemver", () => {
  it("orders plain numeric cores numerically (not lexically)", () => {
    expect(Math.sign(compareSemver("1.0.0", "2.0.0"))).toBe(-1);
    expect(Math.sign(compareSemver("1.2.0", "1.10.0"))).toBe(-1);
    expect(Math.sign(compareSemver("1.0.1", "1.0.0"))).toBe(1);
    expect(Math.sign(compareSemver("1.0.0", "1.0.0"))).toBe(0);
  });

  it("ranks a release above its own pre-release", () => {
    expect(Math.sign(compareSemver("1.0.0", "1.0.0-beta"))).toBe(1);
    expect(Math.sign(compareSemver("2.0.0-rc.1", "2.0.0"))).toBe(-1);
  });
});

describe("appVersionSatisfiesMin — plugin↔app gate", () => {
  it("allows when app version > min", () => {
    expect(appVersionSatisfiesMin("1.5.0", "1.4.0")).toBe(true);
    expect(appVersionSatisfiesMin("2.0.0", "1.9.9")).toBe(true);
    expect(appVersionSatisfiesMin("1.4.10", "1.4.2")).toBe(true);
  });

  it("allows when app version == min (>= semantics)", () => {
    expect(appVersionSatisfiesMin("1.4.0", "1.4.0")).toBe(true);
  });

  it("blocks when app version < min", () => {
    expect(appVersionSatisfiesMin("1.3.0", "1.4.0")).toBe(false);
    expect(appVersionSatisfiesMin("1.4.1", "1.4.2")).toBe(false);
    expect(appVersionSatisfiesMin("0.9.0", "1.0.0")).toBe(false);
  });

  it("fails closed on an unresolvable app version (the 'unknown' sentinel)", () => {
    expect(appVersionSatisfiesMin("unknown", "1.0.0")).toBe(false);
    expect(appVersionSatisfiesMin("", "1.0.0")).toBe(false);
  });

  it("fails closed when min is missing/empty", () => {
    expect(appVersionSatisfiesMin("1.0.0", "")).toBe(false);
  });
});

describe("SEMVER_CORE_PATTERN", () => {
  it("requires a numeric major.minor.patch prefix and tolerates a suffix", () => {
    expect(SEMVER_CORE_PATTERN.test("1.2.3")).toBe(true);
    expect(SEMVER_CORE_PATTERN.test("1.2.3-beta.1+build")).toBe(true);
    expect(SEMVER_CORE_PATTERN.test("1.2")).toBe(false);
    expect(SEMVER_CORE_PATTERN.test("v1.2.3")).toBe(false);
  });
});

describe("isTwoMinorReleasesBehind", () => {
  it("counts minors within a major and ignores patch and pre-release", () => {
    expect(isTwoMinorReleasesBehind("0.12.0", "0.13.9")).toBe(false);
    expect(isTwoMinorReleasesBehind("0.12.9", "0.14.0")).toBe(true);
    expect(isTwoMinorReleasesBehind("0.12.0", "0.14.0-beta.1")).toBe(true);
    expect(isTwoMinorReleasesBehind("0.12.0", "0.12.5")).toBe(false);
  });

  it("treats any higher running major as behind, and a lower one as not", () => {
    expect(isTwoMinorReleasesBehind("0.12.0", "1.0.0")).toBe(true);
    expect(isTwoMinorReleasesBehind("0.99.0", "1.0.0")).toBe(true);
    expect(isTwoMinorReleasesBehind("1.0.0", "0.14.0")).toBe(false);
  });

  it("is false when either version has no stable core, so nothing is dropped", () => {
    expect(isTwoMinorReleasesBehind("0.12.0", "unknown")).toBe(false);
    expect(isTwoMinorReleasesBehind("0.12.0", "")).toBe(false);
    expect(isTwoMinorReleasesBehind("unknown", "1.0.0")).toBe(false);
  });
});

describe("isSemver", () => {
  it("accepts complete versions with pre-release and build metadata", () => {
    for (const v of ["0.12.0", "0.12.0-beta.1", "0.12.0-beta.1+build.2", "1.0.0+20260926", "1.0.0-0.3.7"]) {
      expect(isSemver(v), v).toBe(true);
    }
  });

  it("rejects partial, padded, zero-led and empty-identifier versions", () => {
    for (const v of ["0.12", "v1.0.0", "01.0.0", "1.0.0-01", "0.12.0-..", "0.12.0-", "0.12.0+", " 1.0.0", "unknown"]) {
      expect(isSemver(v), v).toBe(false);
    }
    expect(isSemver(`1.0.0-${"x".repeat(130)}`)).toBe(false);
  });
});
