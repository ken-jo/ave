/**
 * What every install plan shares (design §6.1, §6.2): the source, the
 * snapshot commit the catalog row came from, the version's own commit and
 * the package path. Execution reads only those commits.
 *
 * Only plugin versions carry their payload in the index (authority and
 * artifact pins); every other kind reads its payload from the descriptor at
 * the version's commit, which must still name the planned package.
 */
import type { CatalogRow } from "../catalog/aggregate.js";
import type { IndexVersion, PackageDescriptor, PackageKind } from "../catalog/types.js";
import { validateDescriptorText } from "../catalog/validate.js";
import { MarketplaceError } from "../errors.js";
import type { BareRepo } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import type { SourceOrigin } from "../sources/registry.js";

export interface PackagePlan {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  snapshotCommit: string;
  versionCommit: string;
  /** Package directory in the repository; "" is the root of a direct source. */
  packagePath: string;
  kind: PackageKind;
  name: string;
  version: string;
  minAppVersion: string;
  platforms?: IndexVersion["platforms"];
}

export interface RepositoryAccess {
  repo: BareRepo;
  /** Remote for blobs the partial clone does not hold yet. */
  remote: GitRemote;
  direct: boolean;
  signal?: AbortSignal;
}

export const DESCRIPTOR_NAME = "ave-package.json";
const DESCRIPTOR_LIMIT = 256 * 1024;

/**
 * The row's candidate version (design §6.1). Without one: PACKAGE_REVOKED or
 * PACKAGE_YANKED when that is why every version is dropped, else
 * PACKAGE_INCOMPATIBLE (design §14).
 */
export function candidateVersion(row: CatalogRow): IndexVersion {
  const { choice } = row;
  if (choice.state === "candidate") return choice.version;
  if (choice.state === "upgrade_required") {
    throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.name} needs Ave ${choice.minAppVersion} or newer`);
  }
  switch (choice.reason) {
    case "revoked":
      throw new MarketplaceError("PACKAGE_REVOKED", `every version of ${row.name} is revoked by ${row.sourceId}`);
    case "yanked":
      throw new MarketplaceError("PACKAGE_YANKED", `every version of ${row.name} from ${row.sourceId} is yanked or revoked`);
    case "pending":
      throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `no version of ${row.name} from ${row.sourceId} is offered to this installation yet (rollout or pre-release)`);
    case "withheld":
      throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `no version of ${row.name} from ${row.sourceId} is offered to this installation`);
  }
}

/** The plan fields every kind shares, for one listed version of the row. */
export function planPackage(row: CatalogRow, version: IndexVersion): PackagePlan {
  if (!row.package.versions.includes(version)) throw new Error(`${row.name}@${version.version} is not a version of this row`);
  return {
    sourceId: row.sourceId,
    sourceOrigin: row.sourceOrigin,
    snapshotCommit: row.snapshotCommit,
    versionCommit: version.commit,
    packagePath: row.package.path,
    kind: row.kind,
    name: row.name,
    version: version.version,
    minAppVersion: version.minAppVersion,
    ...(version.platforms ? { platforms: version.platforms } : {}),
  };
}

export function repoPath(dir: string, file: string): string {
  return dir === "" ? file : `${dir}/${file}`;
}

/**
 * The descriptor at the version's commit, validated, naming the planned
 * package. Anything else is MANIFEST_MISMATCH: the index said one thing and
 * the commit it points at says another.
 */
export async function readDescriptorAtVersion(plan: PackagePlan, access: RepositoryAccess): Promise<PackageDescriptor> {
  const path = repoPath(plan.packagePath, DESCRIPTOR_NAME);
  const fail = (why: string) => new MarketplaceError("MANIFEST_MISMATCH", `${plan.kind} ${plan.name}@${plan.version} at ${plan.versionCommit}: ${why}`);
  await access.repo.ensureBlobs(access.remote, plan.versionCommit, [path], access.signal);
  const bytes = await access.repo.readFile(plan.versionCommit, path, DESCRIPTOR_LIMIT);
  if (!bytes) throw fail(`${path} is missing`);
  const checked = validateDescriptorText(bytes.toString("utf8"), { direct: access.direct });
  if (!checked.ok) throw fail(`${path} is invalid: ${checked.error}`);
  const descriptor = checked.value;
  const differs = [
    descriptor.kind !== plan.kind && "kind",
    descriptor.name !== plan.name && "name",
    descriptor.version !== plan.version && "version",
    descriptor.minAppVersion !== plan.minAppVersion && "minAppVersion",
    JSON.stringify(descriptor.platforms ?? null) !== JSON.stringify(plan.platforms ?? null) && "platforms",
  ].filter((field): field is string => typeof field === "string");
  if (differs.length > 0) throw fail(`the index copy differs from ${path} in ${differs.join(", ")}`);
  return descriptor;
}
