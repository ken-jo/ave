import { describe, expect, it } from "vitest";
import type { CatalogRow } from "../../catalog/aggregate.js";
import type { IndexVersion } from "../../catalog/types.js";
import type { PackagePlan } from "../descriptor.js";
import { classifyInstall, updateFor, type InstalledPackage } from "../identity.js";

const AT = "2026-09-23T00:00:00Z";

const plan = (patch: Partial<PackagePlan> = {}): PackagePlan => ({
  sourceId: "acme",
  sourceOrigin: "custom",
  snapshotCommit: "a".repeat(40),
  versionCommit: "b".repeat(40),
  packagePath: "skills/notes",
  kind: "skill",
  name: "notes",
  version: "1.2.0",
  minAppVersion: "0.12.0",
  ...patch,
});

const installed = (patch: Partial<InstalledPackage> = {}): InstalledPackage => ({ kind: "skill", name: "notes", version: "1.1.0", sourceId: "acme", ...patch });

const version = (v: string, minAppVersion = "0.12.0"): IndexVersion => ({ version: v, commit: "c".repeat(40), minAppVersion, publishedAt: AT });

function row(sourceId: string, choice: CatalogRow["choice"], versions: IndexVersion[] = []): CatalogRow {
  return {
    sourceId,
    sourceOrigin: "custom",
    snapshotCommit: "d".repeat(40),
    kind: "skill",
    name: "notes",
    package: { kind: "skill", name: "notes", path: "skills/notes", versions },
    choice,
  };
}

describe("classifyInstall", () => {
  it("installs fresh, and replaces within the bound source in either direction", () => {
    expect(classifyInstall(plan(), null)).toEqual({ action: "install" });
    expect(classifyInstall(plan(), installed())).toEqual({ action: "replace", direction: "upgrade", from: "1.1.0" });
    expect(classifyInstall(plan({ version: "1.1.0" }), installed())).toEqual({ action: "replace", direction: "reinstall", from: "1.1.0" });
    expect(classifyInstall(plan({ version: "1.0.0" }), installed())).toEqual({ action: "replace", direction: "downgrade", from: "1.1.0" });
    expect(classifyInstall(plan(), installed({ version: null }))).toEqual({ action: "replace", direction: "repair", from: null });
  });

  it("treats the same name from another source, or an unbound install, as PACKAGE_ID_CONFLICT unless switching", () => {
    expect(() => classifyInstall(plan(), installed({ sourceId: "ave" }))).toThrow(expect.objectContaining({ code: "PACKAGE_ID_CONFLICT" }));
    expect(() => classifyInstall(plan(), installed({ sourceId: null }))).toThrow("installed without a source");
    expect(classifyInstall(plan(), installed({ sourceId: "ave" }), { switchSource: true })).toEqual({ action: "switch", fromSource: "ave", from: "1.1.0" });
    expect(classifyInstall(plan(), installed({ sourceId: null }), { switchSource: true })).toEqual({ action: "switch", fromSource: null, from: "1.1.0" });
  });

  it("keeps kinds apart: the caller passes the install of the same kind", () => {
    expect(() => classifyInstall(plan(), installed({ kind: "theme" }))).toThrow("is not skill notes");
  });
});

describe("updateFor (update binding)", () => {
  const sources = new Set(["acme", "ave"]);

  it("offers an update from the bound source only, whatever other sources list", () => {
    const rows = [row("ave", { state: "candidate", version: version("9.0.0") }), row("acme", { state: "candidate", version: version("1.2.0") })];
    expect(updateFor({ ...installed(), version: "1.1.0" }, rows, sources)).toMatchObject({ state: "update", version: "1.2.0", row: { sourceId: "acme" } });
    expect(updateFor({ ...installed(), version: "1.2.0" }, rows, sources)).toEqual({ state: "current" });
    expect(updateFor({ ...installed(), version: "1.1.0" }, [rows[0]!], sources)).toEqual({ state: "not_listed" });
  });

  it("reports a removed source, an unbound install and an update that needs a newer app", () => {
    expect(updateFor({ ...installed({ sourceId: "gone" }), version: "1.1.0" }, [], sources)).toEqual({ state: "source_removed" });
    expect(updateFor({ ...installed({ sourceId: null }), version: "1.1.0" }, [], sources)).toEqual({ state: "unbound" });
    const blocked = row("acme", { state: "upgrade_required", minAppVersion: "0.20.0" }, [version("2.0.0", "0.20.0")]);
    expect(updateFor({ ...installed(), version: "1.1.0" }, [blocked], sources)).toEqual({ state: "upgrade_required", minAppVersion: "0.20.0" });
    expect(updateFor({ ...installed(), version: "2.0.0" }, [blocked], sources)).toEqual({ state: "current" });
    expect(updateFor({ ...installed(), version: "1.1.0" }, [row("acme", { state: "unavailable", reason: "withheld" })], sources)).toEqual({ state: "current" });
  });
});
