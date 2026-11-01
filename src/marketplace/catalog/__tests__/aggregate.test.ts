import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogPackage, SourceSnapshot } from "../../sources/snapshot.js";
import { aggregateCatalog, chooseVersion, rolloutBucket, versionExclusions, type VersionChoiceContext } from "../aggregate.js";
import { loadInstallationId } from "../installation-id.js";
import type { IndexVersion, Revocation } from "../types.js";

const AT = "2026-09-23T00:00:00Z";
const INSTALLATION = "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b";

const context = (patch: Partial<VersionChoiceContext> = {}): VersionChoiceContext => ({
  appVersion: "0.14.0",
  platform: "darwin",
  canaryOptIn: false,
  installationId: INSTALLATION,
  ...patch,
});

function version(v: string, patch: Partial<IndexVersion> = {}): IndexVersion {
  return { version: v, commit: v.replace(/\D/gu, "").padEnd(40, "0").slice(0, 40), minAppVersion: "0.12.0", publishedAt: AT, ...patch };
}

function pkg(versions: IndexVersion[], name = "alpha"): CatalogPackage {
  return { kind: "skill", name, path: `skills/${name}`, versions };
}

function plugin(versions: IndexVersion[]): CatalogPackage {
  return { kind: "plugin", name: "alpha", path: "plugins/alpha", versions };
}

function revocation(versions: string, patch: Partial<Revocation> = {}): Revocation {
  return { kind: "skill", name: "alpha", versions, reason: "bad", at: AT, action: "disable", ...patch };
}

function versionInBucket(below: boolean, threshold: number): string {
  for (let n = 0; n < 1000; n++) {
    const v = `1.0.${n}`;
    const bucket = rolloutBucket(INSTALLATION, "acme", "skill", "alpha", v);
    if (below ? bucket < threshold : bucket >= threshold) return v;
  }
  throw new Error("no version in bucket");
}

describe("chooseVersion (design §6.1)", () => {
  it("offers only a served host protocol for code plugins", () => {
    const current = version("1.0.0", { hostProtocol: "4" });
    const retired = version("2.0.0", { hostProtocol: "2" });
    const undeclared = version("3.0.0");
    expect(versionExclusions("acme", "plugin", "alpha", retired, [], context())).toEqual(["host_protocol"]);
    expect(versionExclusions("acme", "plugin", "alpha", undeclared, [], context())).toEqual(["host_protocol"]);
    expect(versionExclusions("acme", "plugin", "alpha", current, [], context())).toEqual([]);
    expect(chooseVersion("acme", plugin([retired, undeclared, current]), [], context())).toMatchObject({
      state: "candidate", version: { version: "1.0.0" },
    });
    expect(chooseVersion("acme", plugin([retired, undeclared]), [], context())).toEqual({ state: "unavailable", reason: "withheld" });
    expect(versionExclusions("acme", "skill", "alpha", undeclared, [], context())).toEqual([]);
    expect(versionExclusions("acme", "agent-plugin", "alpha", undeclared, [], context())).toEqual([]);
  });

  it("still offers a legacy protocol-3 version", () => {
    const legacy = version("1.5.0", { hostProtocol: "3" });
    expect(versionExclusions("acme", "plugin", "alpha", legacy, [], context())).toEqual([]);
    expect(chooseVersion("acme", plugin([legacy]), [], context())).toMatchObject({
      state: "candidate", version: { version: "1.5.0" },
    });
  });

  it("takes the highest version that survives every drop, whatever the listing order", () => {
    const choice = chooseVersion("acme", pkg([version("1.2.0"), version("1.10.0"), version("1.9.0")]), [], context());
    expect(choice).toEqual({ state: "candidate", version: expect.objectContaining({ version: "1.10.0" }) });
  });

  it.each([
    ["minAppVersion above the app", { minAppVersion: "0.15.0" }, "min_app_version"],
    ["yanked", { yanked: { reason: "broken", at: AT } }, "yanked"],
    ["another platform", { platforms: ["win32", "linux"] as IndexVersion["platforms"] }, "platform"],
  ])("drops a version for %s", (_label, patch, reason) => {
    const newest = version("2.0.0", patch);
    expect(versionExclusions("acme", "skill", "alpha", newest, [], context())).toEqual([reason]);
    const choice = chooseVersion("acme", pkg([newest, version("1.0.0")]), [], context());
    expect(choice).toEqual({ state: "candidate", version: expect.objectContaining({ version: "1.0.0" }) });
  });

  it("keeps a process-entry version from a 0.12.x app and from Windows, and offers it on darwin 0.13.0 (§9.7 P4)", () => {
    const processVersion = version("2.0.0", { minAppVersion: "0.13.0", hostProtocol: "4", platforms: ["darwin", "linux"] });
    const entryVersion = version("1.0.0", { hostProtocol: "4", platforms: ["darwin", "win32", "linux"] });
    const old = context({ appVersion: "0.12.4" });
    const windows = context({ appVersion: "0.13.0", platform: "win32" });
    const mac = context({ appVersion: "0.13.0", platform: "darwin" });
    expect(versionExclusions("acme", "plugin", "alpha", processVersion, [], old)).toEqual(["min_app_version"]);
    expect(versionExclusions("acme", "plugin", "alpha", processVersion, [], windows)).toEqual(["platform"]);
    expect(versionExclusions("acme", "plugin", "alpha", processVersion, [], mac)).toEqual([]);
    const both = plugin([processVersion, entryVersion]);
    expect(chooseVersion("acme", both, [], old)).toEqual({ state: "candidate", version: entryVersion });
    expect(chooseVersion("acme", both, [], windows)).toEqual({ state: "candidate", version: entryVersion });
    expect(chooseVersion("acme", both, [], mac)).toEqual({ state: "candidate", version: processVersion });
  });

  it("offers a pre-release only with canaryOptIn, and a release still outranks its own pre-release", () => {
    const versions = [version("2.0.0-beta.1"), version("1.0.0")];
    expect(chooseVersion("acme", pkg(versions), [], context())).toMatchObject({ state: "candidate", version: { version: "1.0.0" } });
    expect(chooseVersion("acme", pkg(versions), [], context({ canaryOptIn: true }))).toMatchObject({ state: "candidate", version: { version: "2.0.0-beta.1" } });
    expect(chooseVersion("acme", pkg([version("2.0.0-rc.1"), version("2.0.0")]), [], context({ canaryOptIn: true }))).toMatchObject({
      version: { version: "2.0.0" },
    });
    // Build metadata is not a pre-release.
    expect(versionExclusions("acme", "skill", "alpha", version("1.0.0+build.7"), [], context())).toEqual([]);
  });

  it("buckets rollouts by sha256 of installation, source, kind, name and version", () => {
    const expected = createHash("sha256").update(`${INSTALLATION}:acme:skill:alpha:1.0.0`).digest().readUInt32BE(0) % 100;
    expect(rolloutBucket(INSTALLATION, "acme", "skill", "alpha", "1.0.0")).toBe(expected);

    const inside = versionInBucket(true, 30);
    const outside = versionInBucket(false, 30);
    expect(versionExclusions("acme", "skill", "alpha", version(inside, { rollout: { percent: 30 } }), [], context())).toEqual([]);
    expect(versionExclusions("acme", "skill", "alpha", version(outside, { rollout: { percent: 30 } }), [], context())).toEqual(["rollout"]);
    expect(versionExclusions("acme", "skill", "alpha", version(outside, { rollout: { percent: 100 } }), [], context())).toEqual([]);
  });

  it("drops versions the same source revokes, by range", () => {
    const versions = [version("1.3.0"), version("1.2.0"), version("1.1.0")];
    const revocations = [revocation(">=1.2.0 <1.4.0"), revocation("*", { name: "beta" })];
    expect(chooseVersion("acme", pkg(versions), revocations, context())).toMatchObject({ version: { version: "1.1.0" } });
    expect(chooseVersion("acme", pkg(versions), [revocation("*")], context())).toEqual({ state: "unavailable", reason: "revoked" });
    expect(chooseVersion("acme", pkg(versions), [revocation("*", { kind: "theme" })], context())).toMatchObject({ version: { version: "1.3.0" } });
  });

  it("reports upgrade_required with the newest held-back version's minAppVersion", () => {
    const choice = chooseVersion(
      "acme",
      pkg([version("3.0.0", { minAppVersion: "0.20.0" }), version("2.0.0", { minAppVersion: "0.16.0" })]),
      [],
      context(),
    );
    expect(choice).toEqual({ state: "upgrade_required", minAppVersion: "0.20.0" });
  });

  it("is unavailable, not upgrade_required, when a held-back version is also excluded for another reason", () => {
    const tooNewAndYanked = version("3.0.0", { minAppVersion: "0.20.0", yanked: { reason: "x", at: AT } });
    const tooNewPrerelease = version("4.0.0-beta.1", { minAppVersion: "0.20.0" });
    expect(chooseVersion("acme", pkg([tooNewAndYanked, tooNewPrerelease, version("1.0.0", { yanked: { reason: "x", at: AT } })]), [], context())).toEqual({
      state: "unavailable",
      reason: "withheld",
    });
  });

  it("says why nothing is offered: revoked, yanked, pending a rollout or release, or withheld (design §14)", () => {
    const yanked = { yanked: { reason: "x", at: AT } };
    expect(chooseVersion("acme", pkg([version("1.1.0", yanked), version("1.0.0")]), [revocation("1.0.0")], context())).toEqual({ state: "unavailable", reason: "yanked" });
    expect(chooseVersion("acme", pkg([version("2.0.0-rc.1"), version("1.0.0", yanked)]), [], context())).toEqual({ state: "unavailable", reason: "pending" });
    const outside = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].find((digit) => rolloutBucket(INSTALLATION, "acme", "skill", "alpha", `1.0.${digit}`) >= 1)!;
    expect(chooseVersion("acme", pkg([version(`1.0.${outside}`, { rollout: { percent: 1 } })]), [], context())).toEqual({ state: "unavailable", reason: "pending" });
    const otherPlatform = process.platform === "win32" ? "linux" : "win32";
    expect(chooseVersion("acme", pkg([version("1.0.0", { platforms: [otherPlatform] })]), [], context())).toEqual({ state: "unavailable", reason: "withheld" });
  });

  it("fails closed on an app version it cannot read", () => {
    expect(versionExclusions("acme", "skill", "alpha", version("1.0.0"), [], context({ appVersion: "unknown" }))).toEqual(["min_app_version"]);
  });
});

describe("aggregateCatalog", () => {
  const snapshot = (sourceId: string, packages: CatalogPackage[], revocations: Revocation[] = []): SourceSnapshot => ({
    sourceId,
    commit: sourceId.charCodeAt(0).toString(16).repeat(20).slice(0, 40),
    fetchedAt: AT,
    marketplace: { name: sourceId, displayName: sourceId },
    packages,
    revocations,
    diagnostics: [],
  });

  it("keeps one row per (source, kind, name) and applies each source's own revocations only", () => {
    const rows = aggregateCatalog(
      [
        { sourceId: "zeta", sourceOrigin: "custom", snapshot: snapshot("zeta", [pkg([version("1.0.0")])], [revocation("*")]) },
        { sourceId: "ave", sourceOrigin: "official", snapshot: snapshot("ave", [pkg([version("2.0.0")]), { ...pkg([version("1.0.0")]), kind: "theme" }]) },
      ],
      context(),
    );
    expect(rows.map((row) => [row.kind, row.name, row.sourceId, row.choice.state])).toEqual([
      ["skill", "alpha", "ave", "candidate"],
      ["skill", "alpha", "zeta", "unavailable"],
      ["theme", "alpha", "ave", "candidate"],
    ]);
    expect(rows[0]).toMatchObject({ sourceOrigin: "official", snapshotCommit: snapshot("ave", []).commit });
  });

  it("refuses a snapshot passed under another source id and a package listed twice", () => {
    expect(() => aggregateCatalog([{ sourceId: "a", sourceOrigin: "custom", snapshot: snapshot("b", []) }], context())).toThrow(/passed as source/u);
    expect(() =>
      aggregateCatalog([{ sourceId: "a", sourceOrigin: "custom", snapshot: snapshot("a", [pkg([version("1.0.0")]), pkg([version("2.0.0")])]) }], context()),
    ).toThrow(/twice/u);
  });
});

describe("loadInstallationId", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates a UUID once and reads the same one back; concurrent first reads agree", async () => {
    dir = await mkdtemp(join(tmpdir(), "ave-installation-id-"));
    const file = join(dir, "installation-id");
    const [a, b] = await Promise.all([loadInstallationId(file), loadInstallationId(file)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ created: true, replacedInvalid: false });
    expect(await loadInstallationId(file)).toEqual({ id: a.id, created: false });
    expect((await readFile(file, "utf8")).trim()).toBe(a.id);
  });

  it("replaces a file that is not a UUID", async () => {
    dir = await mkdtemp(join(tmpdir(), "ave-installation-id-"));
    const file = join(dir, "installation-id");
    await writeFile(file, "not-an-id\n");
    const load = await loadInstallationId(file);
    expect(load).toMatchObject({ created: true, replacedInvalid: true });
    expect(load.id).not.toBe("not-an-id");
  });
});
