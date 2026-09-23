/**
 * Package identity across sources (design §15.1, §14).
 *
 * An installed package is identified by `(kind, name)` and bound to the
 * source it came from. The same name in another source is a different row,
 * never an update: installing it replaces the installed package only as an
 * explicit source switch, and updates are offered from the bound source
 * only. An install with no source binding (a local build, or a catalog
 * install from before this design) is replaced only by a switch as well.
 */
import { compareSemver } from "../../shared/semver-compare.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import type { PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import type { PackagePlan } from "./descriptor.js";

export interface InstalledPackage {
  kind: PackageKind;
  name: string;
  /** Null when the installed manifest cannot be read (a stale registry row). */
  version: string | null;
  /** The bound source, or null when the install has none. */
  sourceId: string | null;
}

export type InstallAction =
  | { action: "install" }
  /** Same source: `direction` compares the plan with the installed version; `repair` when that is unreadable. */
  | { action: "replace"; direction: "upgrade" | "reinstall" | "downgrade" | "repair"; from: string | null }
  | { action: "switch"; fromSource: string | null; from: string | null };

/** What installing `plan` over `installed` is; another source without `switchSource` is PACKAGE_ID_CONFLICT. */
export function classifyInstall(plan: PackagePlan, installed: InstalledPackage | null, options: { switchSource?: boolean } = {}): InstallAction {
  if (!installed) return { action: "install" };
  if (installed.kind !== plan.kind || installed.name !== plan.name) {
    throw new Error(`installed ${installed.kind} ${installed.name} is not ${plan.kind} ${plan.name}`);
  }
  if (installed.sourceId === plan.sourceId) {
    if (installed.version === null) return { action: "replace", direction: "repair", from: null };
    const order = compareSemver(plan.version, installed.version);
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
  /** The bound source still exists but no longer lists the package. */
  | { state: "not_listed" }
  /** The bound source is gone (removed, or no snapshot yet). */
  | { state: "source_removed" }
  /** No source binding: nothing can update it. */
  | { state: "unbound" };

/**
 * The update for an installed package: only its bound source's row counts,
 * whatever other sources list under the same name.
 */
export function updateFor(installed: InstalledPackage & { version: string }, rows: readonly CatalogRow[], sources: ReadonlySet<string>): UpdateState {
  if (installed.sourceId === null) return { state: "unbound" };
  if (!sources.has(installed.sourceId)) return { state: "source_removed" };
  const row = rows.find((item) => item.sourceId === installed.sourceId && item.kind === installed.kind && item.name === installed.name);
  if (!row) return { state: "not_listed" };
  if (row.choice.state === "candidate") {
    const version = row.choice.version.version;
    return compareSemver(version, installed.version) > 0 ? { state: "update", row, version } : { state: "current" };
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
