import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSandboxHomesUnavailableForTest, getSandboxHomesUnavailable } from "../sandbox-capability.js";
import { assertIssuedContainerHomeInPlace, forgetIssuedContainerHome, isIssuedContainerHome, issuedContainerHome, liveIssuedContainerHome,
  recordIssuedContainerHome } from "../sandbox-home-registry.js";

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
      recordIssuedContainerHome(home, base);
    }
  });
  afterEach(() => {
    forgetIssuedContainerHome(own);
    forgetIssuedContainerHome(other);
    rmSync(base, { recursive: true, force: true });
    __resetSandboxHomesUnavailableForTest();
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

  it("is not its own name once the HOME is moved away and a link to it is left in its place", () => {
    const moved = `${own}.moved`;
    renameSync(own, moved);
    symlinkSync(moved, own, "junction");
    expect(isIssuedContainerHome(own, own)).toBe(false);
    expect(isIssuedContainerHome(moved, own)).toBe(false);
  });

  it("follows a link by the identity of its target: its own HOME, never another", () => {
    symlinkSync(own, join(base, "to-own"), "junction");
    symlinkSync(other, join(base, "to-other"), "junction");
    expect(isIssuedContainerHome(join(base, "to-own"), own)).toBe(true);
    expect(isIssuedContainerHome(join(base, "to-other"), own)).toBe(false);
  });

  it("is in place at a launch while nothing up to the root has moved", () => {
    expect(() => assertIssuedContainerHomeInPlace(own)).not.toThrow();
    expect(() => assertIssuedContainerHomeInPlace(undefined)).not.toThrow();
    expect(getSandboxHomesUnavailable()).toBe(false);
  });

  it.each([
    ["its own staging directory", () => join(base, "staging", "0123456789abcdef0123456789abcdef")],
    ["the staging parent", () => join(base, "staging")],
  ])("refuses a launch with the named reason once %s is moved away and a junction to it is left in its place", (_case, parent) => {
    const moved = `${parent()}.moved`;
    renameSync(parent(), moved);
    symlinkSync(moved, parent(), "junction");
    expect(isIssuedContainerHome(own, own)).toBe(false);
    expect(() => assertIssuedContainerHomeInPlace(own)).toThrow(expect.objectContaining({ code: "sandbox-home-unavailable" }));
    expect(getSandboxHomesUnavailable()).toBe(true);
  });

  it("holds one issuance across a launch's preparation: the same record, still in place, observed once", () => {
    const issued = issuedContainerHome(own);
    expect(issuedContainerHome(undefined)).toBeUndefined();
    expect(issuedContainerHome(join(own, "work"))).toBeUndefined();
    expect(liveIssuedContainerHome(undefined)).toBeUndefined();
    expect(liveIssuedContainerHome(issued)).toBe(own);
    // Issued again at the same name: the new issuance is not the one the launch holds.
    forgetIssuedContainerHome(own);
    expect(liveIssuedContainerHome(issued)).toBeUndefined();
    recordIssuedContainerHome(own, base);
    expect(liveIssuedContainerHome(issued)).toBeUndefined();
    expect(liveIssuedContainerHome(issuedContainerHome(own))).toBe(own);
    expect(getSandboxHomesUnavailable()).toBe(false);
  });

  it("refuses with the named reason once the HOME it holds is replaced", () => {
    const issued = issuedContainerHome(own);
    renameSync(own, `${own}.old`);
    mkdirSync(own);
    expect(() => liveIssuedContainerHome(issued)).toThrow(expect.objectContaining({ code: "sandbox-home-unavailable" }));
    expect(getSandboxHomesUnavailable()).toBe(true);
  });

  it("records no HOME outside the root, or below a link", () => {
    expect(() => recordIssuedContainerHome(own, join(base, "elsewhere"))).toThrow(/could not be recorded/);
    symlinkSync(join(base, "staging"), join(base, "via"), "junction");
    expect(() => recordIssuedContainerHome(join(base, "via", "0123456789abcdef0123456789abcdef", "home"), base)).toThrow(/could not be recorded/);
  });
});
