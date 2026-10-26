/** Keep source identities separate; each owns its versions, yanks and revocations. */
import { isDeepStrictEqual } from "node:util";
import { effectiveRevocations } from "./effective-revocations.js";
import { createHash } from "node:crypto";
import { appVersionSatisfiesMin, compareSemver } from "../../shared/semver-compare.js";
import { isServedHostProtocolVersion } from "../../plugins/isolation/host-api-wire.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { CatalogPackage, SourceSnapshot } from "../sources/snapshot.js";
import type { IndexVersion, PackageKind, Revocation } from "./types.js";
import { parseVersionRange, rangeIncludes } from "./version-range.js";

export interface VersionChoiceContext {
  appVersion: string;
  platform: NodeJS.Platform;
  canaryOptIn: boolean;
  installationId: string;
}

export type VersionExclusion = "min_app_version" | "host_protocol" | "yanked" | "platform" | "prerelease" | "rollout" | "revoked";

/** Pending versions may become eligible without an app change; withheld versions have other blockers. */
type UnavailableReason = "revoked" | "yanked" | "pending" | "withheld";

export type VersionChoice =
  | { state: "candidate"; version: IndexVersion }
  | { state: "upgrade_required"; minAppVersion: string }
  | { state: "unavailable"; reason: UnavailableReason };

export interface CatalogRow {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  /** Plans bind this snapshot commit. */
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

/** Stable per-installation rollout bucket from the first four SHA-256 bytes, modulo 100. */
export function rolloutBucket(installationId: string, sourceId: string, kind: PackageKind, name: string, version: string): number {
  const digest = createHash("sha256").update(`${installationId}:${sourceId}:${kind}:${name}:${version}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function isPrerelease(version: string): boolean {
  const core = version.split("+", 1)[0] ?? version;
  return core.includes("-");
}

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
  if (kind === "plugin" && !isServedHostProtocolVersion(version.hostProtocol)) reasons.push("host_protocol");
  if (version.yanked) reasons.push("yanked");
  if (version.platforms && !version.platforms.includes(context.platform as "darwin" | "win32" | "linux")) reasons.push("platform");
  if (isPrerelease(version.version) && !context.canaryOptIn) reasons.push("prerelease");
  if (version.rollout && rolloutBucket(context.installationId, sourceId, kind, name, version.version) >= version.rollout.percent) {
    reasons.push("rollout");
  }
  if (isRevoked(kind, name, version.version, revocations)) reasons.push("revoked");
  return reasons;
}

export function findRevocation<T extends Revocation>(kind: PackageKind, name: string, version: string, revocations: readonly T[]): T | undefined {
  // Invalid cached ranges must fail closed rather than silently ignore a revocation.
  const matches = revocations.filter((entry) => entry.kind === kind && entry.name === name && rangeIncludes(parseVersionRange(entry.versions), version));
  // Removal wins over disabling; retain successor metadata and input order for equal actions.
  const strongest = matches.find((entry) => entry.action === "uninstall") ?? matches[0];
  if (!strongest) return undefined;
  let successors: Revocation["successors"];
  for (const entry of matches) {
    if (!entry.successors) continue;
    if (successors && !isDeepStrictEqual(successors, entry.successors)) {
      throw new Error("Conflicting plugin retirement entries");
    }
    successors = entry.successors;
  }
  return successors ? { ...strongest, successors } : strongest;
}

function isRevoked(kind: PackageKind, name: string, version: string, revocations: readonly Revocation[]): boolean {
  return findRevocation(kind, name, version, revocations) !== undefined;
}

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
        choice: chooseVersion(sourceId, pkg, effectiveRevocations(snapshot, context.appVersion), context),
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
