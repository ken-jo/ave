import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../__tests__/fixtures/mixed-host-protocols.json" with { type: "json" };
import { admitSnapshotPackages, validateCachedSnapshotText, validateIndexText } from "../validate.js";
import type { SourceSnapshot } from "../../sources/snapshot.js";
import { chooseVersion } from "../aggregate.js";

const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../log.js", () => ({ createMarketplaceLogger: () => log }));

const context = { sourceId: "ave", official: true };
const check = (document: unknown) => validateIndexText(JSON.stringify(document), context);
const document = () => structuredClone(fixture);
beforeEach(() => vi.clearAllMocks());

describe("catalog host protocol admission", () => {
  it("keeps and offers the current version while diagnosing the foreign authority before validation", () => {
    const result = check(document());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages).toHaveLength(1);
    const entry = result.value.index.packages[0]!;
    expect(entry.versions?.map((version) => version.version)).toEqual(["0.10.3"]);
    expect(result.value.diagnostics).toEqual([]);
    expect(result.value.excluded).toEqual([{ packageId: "plugin/meeting", versionIndex: 1, version: "0.10.2", hostProtocol: "3", reason: "foreign-host-protocol", package: {
      kind: "plugin", name: "meeting", path: "plugins/meeting",
    } }]);
    expect(chooseVersion("ave", { ...entry, versions: entry.versions! }, [], {
      appVersion: "0.14.0", platform: "darwin", canaryOptIn: false, installationId: "catalog-test",
    })).toMatchObject({ state: "candidate", version: { version: "0.10.3" } });
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ versionsSkipped: 1, packagesDropped: 0 }, "Catalog foreign-host-protocol versions skipped");
  });

  it("drops packages with no remaining versions and aggregates one counts-only log", () => {
    const input = document();
    input.packages[0]!.versions.shift();
    input.packages[0]!.latest = "0.10.2";
    input.packages.push({ ...structuredClone(input.packages[0]!), name: "calendar", path: "plugins/calendar" });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics).toEqual([]);
    expect(result.ok && result.value.excluded.map(({ packageId, version, reason }) => ({ packageId, version, reason }))).toEqual([
      { packageId: "plugin/meeting", version: "0.10.2", reason: "foreign-host-protocol" },
      { packageId: "plugin/calendar", version: "0.10.2", reason: "foreign-host-protocol" },
    ]);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ versionsSkipped: 2, packagesDropped: 2 }, "Catalog foreign-host-protocol versions skipped");
  });

  it.each(["5", undefined, null, 3, "", "unknown"])("strictly validates an invalid authority with protocol %j", (protocol) => {
    const input = document();
    const current = input.packages[0]!.versions[0]!;
    Object.assign(current, { hostProtocol: protocol });
    Object.assign(current.authority, { pluginAccess: input.packages[0]!.versions[1]!.authority.pluginAccess });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics.some((diagnostic) => diagnostic.message.includes("additional properties"))).toBe(true);
  });

  it("validates a missing declaration instead of taking the authority's foreign protocol", () => {
    const input = document();
    const old = input.packages[0]!.versions[1]!;
    Reflect.deleteProperty(old, "hostProtocol");
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics).toEqual([{ subject: "plugin/meeting", message: expect.stringContaining("additional properties") }]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each(["x".repeat(10000), "1.2.3-" + "x".repeat(128), "<script>alert(1)</script>", 123, null, {}])("bounds the display label of an unvalidated foreign version %j", (version) => {
    const input = document();
    Object.assign(input.packages[0]!.versions[1]!, { version });
    const result = check(input);
    expect(result.ok && result.value.excluded[0]).toMatchObject({ version: "versions[1]", versionIndex: 1 });
    expect(result.ok && result.value.diagnostics).toEqual([]);
  });

  it("preserves strict package metadata and duplicate admission for foreign-only packages", () => {
    const input = document();
    input.packages[0]!.versions.shift();
    input.packages[0]!.path = "../outside";
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { excluded: [], index: { packages: [] } } });
    expect(result.ok && result.value.diagnostics).toHaveLength(1);
    input.packages[0]!.path = "plugins/meeting";
    input.packages.push(structuredClone(input.packages[0]!));
    expect(check(input)).toMatchObject({ ok: true, value: { excluded: [], index: { packages: [] } } });
  });

  it("round trips exclusion-only snapshots while refusing authority and unsafe metadata in the exclusion channel", () => {
    const input = document();
    input.packages[0]!.versions.shift();
    const result = check(input);
    if (!result.ok) throw new Error(result.error);
    const snapshot: SourceSnapshot = {
      formatVersion: 2, sourceId: "ave", commit: "a".repeat(40), fetchedAt: "2026-11-06T00:00:00Z",
      marketplace: { name: "ave", displayName: "Catalog" }, packages: [], revocations: [], conditionalRevocations: [],
      diagnostics: result.value.diagnostics, excluded: result.value.excluded,
    };
    expect(validateCachedSnapshotText(JSON.stringify(snapshot))).toEqual({ ok: true, value: snapshot });
    expect(admitSnapshotPackages(snapshot).excluded).toEqual(result.value.excluded);
    Object.assign(snapshot.excluded![0]!.package, { authority: { capabilities: [] } });
    expect(validateCachedSnapshotText(JSON.stringify(snapshot)).ok).toBe(false);
    expect(admitSnapshotPackages(snapshot).excluded).toEqual([]);
  });

  it.each(["packageId", "hostProtocol", "name", "path"] as const)("refuses a cached exclusion with an unsafe %s", (field) => {
    const result = check(document());
    if (!result.ok) throw new Error(result.error);
    const snapshot: SourceSnapshot = {
      formatVersion: 2, sourceId: "ave", commit: "a".repeat(40), fetchedAt: "2026-11-06T00:00:00Z",
      marketplace: { name: "ave", displayName: "Catalog" }, packages: [], revocations: [], conditionalRevocations: [],
      diagnostics: [], excluded: result.value.excluded,
    };
    const exclusion = snapshot.excluded![0]!;
    if (field === "packageId") exclusion.packageId = "plugin/another";
    if (field === "hostProtocol") exclusion.hostProtocol = "5";
    if (field === "name") {
      exclusion.package.name = `glp${"at-"}${"abcd1234".repeat(3)}`;
      exclusion.packageId = `plugin/${exclusion.package.name}`;
    }
    if (field === "path") exclusion.package.path = "../outside";
    expect(admitSnapshotPackages(snapshot).excluded).toEqual([]);
  });

  it("admits a schema-valid undeclared version while install compatibility still withholds it", () => {
    const input = document();
    input.packages[0]!.versions.pop();
    const current = input.packages[0]!.versions[0]!;
    Reflect.deleteProperty(current, "hostProtocol");
    Reflect.deleteProperty(current.authority.requires, "hostProtocol");
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    if (!result.ok) return;
    const entry = result.value.index.packages[0]!;
    expect(chooseVersion("ave", { ...entry, versions: entry.versions! }, [], {
      appVersion: "0.14.0", platform: "darwin", canaryOptIn: false, installationId: "catalog-test",
    })).toEqual({ state: "unavailable", reason: "withheld" });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("removes only a latest hint that names an excluded version", () => {
    const input = document();
    input.packages[0]!.versions[0]!.hostProtocol = "6";
    Object.assign(input.packages[0]!.versions[1]!, structuredClone(fixture.packages[0]!.versions[0]!), { version: "0.10.2" });
    const result = check(input);
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [{ versions: [{ version: "0.10.2" }] }] } } });
    expect(result.ok && result.value.index.packages[0]!.latest).toBeUndefined();
    input.packages[0]!.latest = "9.0.0";
    expect(check(input)).toMatchObject({ ok: true, value: { index: { packages: [] } } });
  });
});
