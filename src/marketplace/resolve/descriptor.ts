/** Execution reads only the planned snapshot and version commits.
 * Non-plugin payloads come from the version descriptor, which must match the planned identity. */
import type { CatalogRow } from "../catalog/aggregate.js";
import { hasVersionTree, MARKETPLACE_DESCRIPTOR_FILE, type AgentPluginComponents, type IndexVersion, type PackageDescriptor, type PackageKind } from "../catalog/types.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { validateDescriptorText } from "../catalog/validate.js";
import { readDirectPackage } from "../sources/direct-package.js";
import { MarketplaceError } from "../errors.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { RepositoryAccess } from "../sources/source-tree.js";

export type { RepositoryAccess };

export interface PackagePlan {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  snapshotCommit: string;
  versionCommit: string;
  packagePath: string;
  kind: PackageKind;
  name: string;
  version: string;
  minAppVersion: string;
  hostProtocol?: string;
  platforms?: IndexVersion["platforms"];
  components?: AgentPluginComponents;
}

const DESCRIPTOR_LIMIT = 256 * 1024;

/** Distinguish fully revoked or yanked rows from other incompatibility when no candidate exists. */
export function candidateVersion(row: CatalogRow): IndexVersion {
  const { choice } = row;
  if (choice.state === "candidate") return choice.version;
  if (choice.state === "upgrade_required") {
    throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.name} needs Ave ${choice.minAppVersion} or newer`, {
      detail: { reason: "min_app_version", name: row.name, version: choice.minAppVersion },
    });
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

export function planPackage(row: CatalogRow, version: IndexVersion): PackagePlan {
  if (!row.package.versions.includes(version)) throw new Error(`${row.name}@${version.version} is not a version of this row`);
  // Legacy grant pins are evidence only and have no installable tree.
  if (!hasVersionTree(version)) {
    throw new MarketplaceError("PACKAGE_YANKED", `${row.name}@${version.version} is a legacy grant pin and cannot be installed`);
  }
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
    ...(version.hostProtocol ? { hostProtocol: version.hostProtocol } : {}),
    ...(version.platforms ? { platforms: version.platforms } : {}),
    ...(version.components ? { components: version.components } : {}),
  };
}

export function repoPath(dir: string, file: string): string {
  return dir === "" ? file : `${dir}/${file}`;
}

/** Validate the version descriptor against the plan; synthesize direct-source descriptors as at snapshot read. */
export async function readDescriptorAtVersion(plan: PackagePlan, access: RepositoryAccess): Promise<PackageDescriptor> {
  const path = repoPath(plan.packagePath, MARKETPLACE_DESCRIPTOR_FILE);
  const fail = (why: string) => new MarketplaceError("MANIFEST_MISMATCH", `${plan.kind} ${plan.name}@${plan.version} at ${plan.versionCommit}: ${why}`);
  let descriptor: PackageDescriptor;
  const tree = access.treeAt(plan.versionCommit);
  if (access.direct) {
    const read = await readDirectPackage({ tree, path: plan.packagePath, rootName: access.rootName });
    if (!read) throw fail(`no package file at ${plan.packagePath || "the repository root"}`);
    if (!read.ok) throw fail(read.error);
    descriptor = read.found.descriptor;
  } else {
    await tree.ensure([path]);
    const bytes = await tree.readFile(path, DESCRIPTOR_LIMIT);
    if (!bytes) throw fail(`${path} is missing`);
    const checked = validateDescriptorText(bytes.toString("utf8"), { direct: false });
    if (!checked.ok) throw fail(`${path} is invalid: ${checked.error}`);
    descriptor = checked.value;
  }
  const differs = descriptorDiffersFromIndex(descriptor, plan);
  if (differs.length > 0) throw fail(`the index copy differs from the package at ${plan.packagePath || "the root"} in ${differs.join(", ")}`);
  return descriptor;
}

export type IndexedVersionFields = Pick<PackagePlan, "kind" | "name" | "version" | "minAppVersion" | "hostProtocol" | "platforms" | "components">;

export function descriptorDiffersFromIndex(descriptor: PackageDescriptor, indexed: IndexedVersionFields): string[] {
  return [
    descriptor.kind !== indexed.kind && "kind",
    descriptor.name !== indexed.name && "name",
    descriptor.version !== indexed.version && "version",
    descriptor.minAppVersion !== indexed.minAppVersion && "minAppVersion",
    descriptor.hostProtocol !== indexed.hostProtocol && "hostProtocol",
    JSON.stringify(descriptor.platforms ?? null) !== JSON.stringify(indexed.platforms ?? null) && "platforms",
    descriptor.kind === "agent-plugin" && canonicalStringify(descriptor.payload.components) !== canonicalStringify(indexed.components) && "components",
  ].filter((field): field is string => typeof field === "string");
}
