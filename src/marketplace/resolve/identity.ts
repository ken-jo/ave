/** Only the bound source offers updates; another source or an unbound install requires an explicit switch. */
import { compareSemver } from "../../shared/semver-compare.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import type { PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import { isSynthesizedVersion } from "../sources/direct-package.js";
import type { PackagePlan } from "./descriptor.js";

/** Commit-version pins use distinct build metadata as newer because pins move only to descendants. */
export function compareVersions(a: string, b: string): number {
  if (isSynthesizedVersion(a) && isSynthesizedVersion(b)) return a === b ? 0 : 1;
  return compareSemver(a, b);
}

export interface InstalledPackage {
  kind: PackageKind;
  name: string;
  version: string | null;
  sourceId: string | null;
}

export type InstallAction =
  | { action: "install" }
  | { action: "replace"; direction: "upgrade" | "reinstall" | "downgrade" | "repair"; from: string | null }
  | { action: "switch"; fromSource: string | null; from: string | null };

export function classifyInstall(plan: Pick<PackagePlan, "kind" | "name" | "version"> & { sourceId: string | null }, installed: InstalledPackage | null, options: { switchSource?: boolean } = {}): InstallAction {
  if (!installed) return { action: "install" };
  if (installed.kind !== plan.kind || installed.name !== plan.name) {
    throw new Error(`installed ${installed.kind} ${installed.name} is not ${plan.kind} ${plan.name}`);
  }
  if (installed.sourceId === plan.sourceId) {
    if (installed.version === null) return { action: "replace", direction: "repair", from: null };
    const order = compareVersions(plan.version, installed.version);
    return { action: "replace", direction: order > 0 ? "upgrade" : order === 0 ? "reinstall" : "downgrade", from: installed.version };
  }
  if (!options.switchSource) {
    const from = installed.sourceId === null ? "without a source" : `from ${installed.sourceId}`;
    throw new MarketplaceError(
      "PACKAGE_ID_CONFLICT",
      `${plan.kind} ${plan.name} is installed ${from}; installing it from ${plan.sourceId} switches its source`,
    );
  }
  return { action: "switch", fromSource: installed.sourceId, from: installed.version };
}

export type UpdateState =
  | { state: "current" }
  | { state: "update"; row: CatalogRow; version: string }
  | { state: "upgrade_required"; minAppVersion: string }
  | { state: "not_listed" }
  | { state: "source_removed" }
  /** Unbound installs cannot receive source updates. */
  | { state: "unbound" };

/** Same-named rows from other sources never update the bound install. */
export function updateFor(installed: InstalledPackage & { version: string }, rows: readonly CatalogRow[], sources: ReadonlySet<string>): UpdateState {
  if (installed.sourceId === null) return { state: "unbound" };
  if (!sources.has(installed.sourceId)) return { state: "source_removed" };
  const row = rows.find((item) => item.sourceId === installed.sourceId && item.kind === installed.kind && item.name === installed.name);
  if (!row) return { state: "not_listed" };
  if (row.choice.state === "candidate") {
    const version = row.choice.version.version;
    return compareVersions(version, installed.version) > 0 ? { state: "update", row, version } : { state: "current" };
  }
  if (row.choice.state === "upgrade_required") {
    const newest = row.package.versions.reduce<string | null>(
      (best, item) => (best === null || compareSemver(item.version, best) > 0 ? item.version : best),
      null,
    );
    if (newest !== null && compareSemver(newest, installed.version) > 0) return { state: "upgrade_required", minAppVersion: row.choice.minAppVersion };
  }
  return { state: "current" };
}
