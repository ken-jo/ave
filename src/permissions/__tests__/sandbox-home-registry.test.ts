import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetIssuedContainerHome, isIssuedContainerHome, recordIssuedContainerHome } from "../sandbox-home-registry.js";

describe("the container HOME a launch was issued", () => {
  let base = "";
  let own = "";
  let other = "";
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "issued-home-")));
    own = join(base, "staging", "0123456789abcdef0123456789abcdef", "home");
    other = join(base, "staging", "fedcba9876543210fedcba9876543210", "home");
    for (const home of [own, other]) {
      mkdirSync(join(home, "work"), { recursive: true });
      recordIssuedContainerHome(home);
    }
  });
  afterEach(() => {
    forgetIssuedContainerHome(own);
    forgetIssuedContainerHome(other);
    rmSync(base, { recursive: true, force: true });
  });

  it("is that launch's own HOME itself", () => {
    expect(isIssuedContainerHome(own, own)).toBe(true);
  });

  it.each([
    ["another launch's HOME", () => other],
    ["the staging parent", () => join(base, "staging")],
    ["its own staging directory", () => join(base, "staging", "0123456789abcdef0123456789abcdef")],
    ["a directory below it", () => join(own, "work")],
    ["a path that does not exist", () => join(own, "missing")],
  ])("is not %s", (_case, cwd) => {
    expect(isIssuedContainerHome(cwd(), own)).toBe(false);
  });

  it("is never a HOME that was not issued, or no longer is", () => {
    expect(isIssuedContainerHome(own, undefined)).toBe(false);
    expect(isIssuedContainerHome(join(own, "work"), join(own, "work"))).toBe(false);
    forgetIssuedContainerHome(own);
    expect(isIssuedContainerHome(own, own)).toBe(false);
  });

  it("is not the same name once the directory is replaced", () => {
    // Renamed away, not removed, so the issued directory's identity cannot be reused by the new one.
    renameSync(own, `${own}.old`);
    mkdirSync(own);
    expect(isIssuedContainerHome(own, own)).toBe(false);
  });

  it("follows a link by the identity of its target: its own HOME, never another", () => {
    symlinkSync(own, join(base, "to-own"), "junction");
    symlinkSync(other, join(base, "to-other"), "junction");
    expect(isIssuedContainerHome(join(base, "to-own"), own)).toBe(true);
    expect(isIssuedContainerHome(join(base, "to-other"), own)).toBe(false);
  });
});
