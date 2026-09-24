/**
 * The aggregated catalog (design §6.1, §15.1).
 *
 * One row per `(sourceId, kind, name)`: the same name in two sources is two
 * rows, never merged, because each source decides its own versions, yanks and
 * revocations. For each row the version choice runs the six drops of §6.1 in
 * order and takes the highest remaining version as the candidate.
 */
import { createHash } from "node:crypto";
import { appVersionSatisfiesMin, compareSemver } from "../../shared/semver-compare.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { CatalogPackage, SourceSnapshot } from "../sources/snapshot.js";
import type { IndexVersion, PackageKind, Revocation } from "./types.js";
import { parseVersionRange, rangeIncludes } from "./version-range.js";

export interface VersionChoiceContext {
  /** The running app's version (package.json). */
  appVersion: string;
  platform: NodeJS.Platform;
  canaryOptIn: boolean;
  installationId: string;
}

/** Why a version is not offered, in the order of §6.1. */
export type VersionExclusion = "min_app_version" | "yanked" | "platform" | "prerelease" | "rollout" | "revoked";

/**
 * Why nothing is offered, when no version is held back by the app version
 * alone (design §14):
 *
 *   revoked   every version is revoked by its source (PACKAGE_REVOKED)
 *   yanked    every version is yanked or revoked, some yanked (PACKAGE_YANKED)
 *   pending   some version is held back only by its rollout or by being a
 *             pre-release: that can change without the app changing
 *   withheld  anything else: platform, or several reasons at once
 */
type UnavailableReason = "revoked" | "yanked" | "pending" | "withheld";

export type VersionChoice =
  | { state: "candidate"; version: IndexVersion }
  /** Nothing is offered, and some version is held back only by the app version. */
  | { state: "upgrade_required"; minAppVersion: string }
  | { state: "unavailable"; reason: UnavailableReason };

export interface CatalogRow {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  /** The snapshot commit the row was read from; an install plan binds it (§6.2). */
  snapshotCommit: string;
  kind: PackageKind;
  name: string;
  package: CatalogPackage;
  choice: VersionChoice;
}

export interface AggregateInput {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  snapshot: SourceSnapshot;
}

/** `uint32(sha256("${installationId}:${sourceId}:${kind}:${name}:${version}")[0..4]) % 100` (§6.1 step 5). */
export function rolloutBucket(installationId: string, sourceId: string, kind: PackageKind, name: string, version: string): number {
  const digest = createHash("sha256").update(`${installationId}:${sourceId}:${kind}:${name}:${version}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function isPrerelease(version: string): boolean {
  const core = version.split("+", 1)[0] ?? version;
  return core.includes("-");
}

/** Every reason a version is excluded; empty = offered. */
export function versionExclusions(
  sourceId: string,
  kind: PackageKind,
  name: string,
  version: IndexVersion,
  revocations: readonly Revocation[],
  context: VersionChoiceContext,
): VersionExclusion[] {
  const reasons: VersionExclusion[] = [];
  if (!appVersionSatisfiesMin(context.appVersion, version.minAppVersion)) reasons.push("min_app_version");
  if (version.yanked) reasons.push("yanked");
  if (version.platforms && !version.platforms.includes(context.platform as "darwin" | "win32" | "linux")) reasons.push("platform");
  if (isPrerelease(version.version) && !context.canaryOptIn) reasons.push("prerelease");
  if (version.rollout && rolloutBucket(context.installationId, sourceId, kind, name, version.version) >= version.rollout.percent) {
    reasons.push("rollout");
  }
  if (isRevoked(kind, name, version.version, revocations)) reasons.push("revoked");
  return reasons;
}

/** The source's own revocation covering this version, if any (§10.4). */
export function findRevocation<T extends Revocation>(kind: PackageKind, name: string, version: string, revocations: readonly T[]): T | undefined {
  // Ranges were parsed when the snapshot was validated; a failure here is a
  // snapshot that bypassed validation, which must not read as "not revoked".
  return revocations.find((entry) => entry.kind === kind && entry.name === name && rangeIncludes(parseVersionRange(entry.versions), version));
}

function isRevoked(kind: PackageKind, name: string, version: string, revocations: readonly Revocation[]): boolean {
  return findRevocation(kind, name, version, revocations) !== undefined;
}

/** §6.1: the highest version that survives every drop, or why there is none. */
export function chooseVersion(
  sourceId: string,
  pkg: CatalogPackage,
  revocations: readonly Revocation[],
  context: VersionChoiceContext,
): VersionChoice {
  let candidate: IndexVersion | undefined;
  let needsUpgrade: IndexVersion | undefined;
  let allRevoked = true;
  let allYankedOrRevoked = true;
  let pending = false;
  for (const version of pkg.versions) {
    const reasons = versionExclusions(sourceId, pkg.kind, pkg.name, version, revocations, context);
    if (reasons.length === 0) {
      if (!candidate || compareSemver(version.version, candidate.version) > 0) candidate = version;
    } else if (reasons.length === 1 && reasons[0] === "min_app_version") {
      if (!needsUpgrade || compareSemver(version.version, needsUpgrade.version) > 0) needsUpgrade = version;
    }
    if (!reasons.includes("revoked")) allRevoked = false;
    if (!reasons.includes("revoked") && !reasons.includes("yanked")) allYankedOrRevoked = false;
    if (reasons.length > 0 && reasons.every((reason) => reason === "rollout" || reason === "prerelease")) pending = true;
  }
  if (candidate) return { state: "candidate", version: candidate };
  if (needsUpgrade) return { state: "upgrade_required", minAppVersion: needsUpgrade.minAppVersion };
  const reason: UnavailableReason = allRevoked ? "revoked" : allYankedOrRevoked ? "yanked" : pending ? "pending" : "withheld";
  return { state: "unavailable", reason };
}

/** Rows for every package of every snapshot, sorted by kind, name, then source id. */
export function aggregateCatalog(inputs: readonly AggregateInput[], context: VersionChoiceContext): CatalogRow[] {
  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const { sourceId, sourceOrigin, snapshot } of inputs) {
    if (snapshot.sourceId !== sourceId) {
      throw new Error(`snapshot of ${snapshot.sourceId} passed as source ${sourceId}`);
    }
    for (const pkg of snapshot.packages) {
      const key = `${sourceId}\u0000${pkg.kind}\u0000${pkg.name}`;
      // Snapshot validation already refuses duplicate claimants; a second row
      // here would be two packages under one install identity.
      if (seen.has(key)) throw new Error(`source ${sourceId} lists ${pkg.kind} ${pkg.name} twice`);
      seen.add(key);
      rows.push({
        sourceId,
        sourceOrigin,
        snapshotCommit: snapshot.commit,
        kind: pkg.kind,
        name: pkg.name,
        package: pkg,
        choice: chooseVersion(sourceId, pkg, snapshot.revocations, context),
      });
    }
  }
  return rows.sort((a, b) =>
    a.kind === b.kind ? (a.name === b.name ? compareBytes(a.sourceId, b.sourceId) : compareBytes(a.name, b.name)) : compareBytes(a.kind, b.kind),
  );
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
