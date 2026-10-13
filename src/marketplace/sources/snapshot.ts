/**
 * Build the validated snapshot of one source at one revision (design §2.2,
 * §3, §4.2, §10.4, §18.4.2, §18.4.3).
 *
 * The snapshot is everything the catalog needs without reading the source
 * again: the marketplace identity, each package with its versions, the
 * source's own revocations and the per-package diagnostics. What is read,
 * through a {@link SourceTree}:
 *   - marketplace sources: `marketplace.json`; a package the index lists
 *     without `versions` is read from its descriptor;
 *   - direct sources: the one package at the subdir (or root), from its
 *     descriptor or synthesized from its own file (direct-package.ts);
 *   - every source: `policy/revocations.json` when present.
 * A package that fails validation is dropped with a diagnostic. An invalid
 * index or revocations file rejects the whole revision, so the caller keeps
 * its previous pin.
 *
 * A git source is read at a commit. A folder source is read as it is now
 * (§18.4.3): every package's descriptor is read, only the version in the
 * folder is offered (it must equal its index copy), each package carries the
 * tree digest of what it would install, and the pin is the revision those
 * reads name, computed once they are done.
 */
import type {
  IndexVersion,
  MarketplaceIndex,
  PackageDescriptor,
  PackageKind,
  PluginArtifactPins,
  PluginAuthority,
  Revocation,
} from "../catalog/types.js";
import { MARKETPLACE_INDEX_FILE as INDEX_PATH, type ConditionalRevocation } from "../catalog/types.js";
import { validateConditionalRevocationsText, validateDescriptorText, validateIndexText, validateRevocationsText, type CatalogDiagnostic } from "../catalog/validate.js";
import { isMarketplaceError, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../errors.js";
import { descriptorDiffersFromIndex } from "../resolve/descriptor.js";
import { DIRECT_FILES, readDirectPackage } from "./direct-package.js";
import { FolderTree } from "./folder-tree.js";
import type { SourceOrigin } from "./registry.js";
import { folderRevision, type GitTree, type SourceTree } from "./source-tree.js";

export interface CatalogPackage {
  kind: PackageKind;
  name: string;
  /** Package directory in the repository; "" is the root (a direct source without subdir). */
  path: string;
  displayName?: string;
  description?: string;
  keywords?: string[];
  /** Repository-relative image path, read from the git tree only. */
  icon?: string;
  latest?: string;
  /** Newest first. A package read from its descriptor, and every package of a folder source, has exactly one. */
  versions: IndexVersion[];
  /** Folder sources: the tree digest (§6.4) of the files this package installs, which a plan's capture must match. */
  treeSha256?: string;
}

export interface SourceSnapshot {
  /** Absent on snapshots written before conditional policies. */
  formatVersion?: 1 | 2;
  conditionalRevocations?: ConditionalRevocation[];
  sourceId: string;
  /** The pin: a commit, or a folder source's revision (§18.4.3). */
  commit: string;
  fetchedAt: string;
  marketplace: MarketplaceIdentity;
  packages: CatalogPackage[];
  revocations: Revocation[];
  diagnostics: CatalogDiagnostic[];
}

type MarketplaceIdentity = Pick<MarketplaceIndex, "name" | "displayName" | "description" | "owner">;

export type SnapshotResult =
  | { ok: true; snapshot: SourceSnapshot }
  | { ok: false; code: MarketplaceErrorCode; message: string; detail?: MarketplaceErrorDetail };

const SNAPSHOT_FILE_LIMITS = {
  index: 16 * 1024 * 1024,
  descriptor: 256 * 1024,
  revocations: 1024 * 1024,
} as const;

const REVOCATIONS_PATH = "policy/revocations.json";
const DESCRIPTOR_NAME = "ave-package.json";

class Rejection extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    readonly detail?: MarketplaceErrorDetail,
  ) {
    super(message);
  }
}

/** The source being read, as the builder needs it. */
export interface SnapshotSubject {
  id: string;
  origin: SourceOrigin;
  label?: string;
  /** A direct source's package path ("" is the root). */
  subdir?: string;
  /** The repository's or folder's own name, which names a direct package at the root that names none. */
  rootName: string;
}

/** A folder version's commit until the read is done and its revision is known; never leaves the builder. */
const FOLDER_REVISION_PENDING = "local-pending";

function descriptorPath(packagePath: string): string {
  return packagePath ? `${packagePath}/${DESCRIPTOR_NAME}` : DESCRIPTOR_NAME;
}

/** One catalog package from a descriptor read at `commit`; the icon becomes repository-relative. */
function packageFromDescriptor(descriptor: PackageDescriptor, path: string, commit: string, publishedAt: string): CatalogPackage {
  const plugin = descriptor.kind === "plugin"
    ? (descriptor.payload as { authority: PluginAuthority; artifact: PluginArtifactPins })
    : null;
  const agentComponents = descriptor.kind === "agent-plugin" ? descriptor.payload.components : undefined;
  const version: IndexVersion = {
    version: descriptor.version,
    commit,
    minAppVersion: descriptor.minAppVersion,
    ...(descriptor.hostProtocol ? { hostProtocol: descriptor.hostProtocol } : {}),
    ...(descriptor.platforms ? { platforms: descriptor.platforms } : {}),
    ...(plugin ? { authority: plugin.authority, artifact: plugin.artifact } : {}),
    ...(agentComponents ? { components: agentComponents as IndexVersion["components"] } : {}),
    publishedAt,
  };
  return {
    kind: descriptor.kind,
    name: descriptor.name,
    path,
    ...(descriptor.displayName !== undefined ? { displayName: descriptor.displayName } : {}),
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    ...(descriptor.icon !== undefined ? { icon: path ? `${path}/${descriptor.icon}` : descriptor.icon } : {}),
    latest: descriptor.version,
    versions: [version],
  };
}

function subjectOf(entry: { kind: string; name: string }): string {
  return `${entry.kind}/${entry.name}`;
}

/** Drop every package whose (kind, name) or path another package also claims (§4.2). */
function dropAmbiguous(packages: CatalogPackage[], diagnostics: CatalogDiagnostic[]): CatalogPackage[] {
  const byName = new Map<string, number>();
  const byPath = new Map<string, number>();
  for (const entry of packages) {
    byName.set(subjectOf(entry), (byName.get(subjectOf(entry)) ?? 0) + 1);
    byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1);
  }
  return packages.filter((entry) => {
    if ((byName.get(subjectOf(entry)) ?? 0) > 1) {
      diagnostics.push({ subject: subjectOf(entry), message: "more than one package declares this kind and name" });
      return false;
    }
    if ((byPath.get(entry.path) ?? 0) > 1) {
      diagnostics.push({ subject: subjectOf(entry), message: `another package uses the same path ${entry.path}` });
      return false;
    }
    return true;
  });
}

export class SnapshotBuilder {
  private readonly folder: FolderTree | null;

  constructor(
    private readonly tree: GitTree | FolderTree,
    private readonly source: SnapshotSubject,
  ) {
    this.folder = tree instanceof FolderTree ? tree : null;
  }

  /** The commit a version read here is at: the git commit, or the folder's revision once it is known. */
  private get versionCommit(): string {
    return this.folder ? FOLDER_REVISION_PENDING : (this.tree as GitTree).commit;
  }

  private get reader(): SourceTree {
    return this.tree;
  }

  private async read(path: string, maxBytes: number): Promise<string | null> {
    const bytes = await this.reader.readFile(path, maxBytes);
    return bytes === null ? null : bytes.toString("utf8");
  }

  private async ensure(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) await this.reader.ensure(paths);
  }

  /** Read and validate the descriptor at each path; failures become diagnostics. */
  private async descriptors(
    wanted: ReadonlyArray<{ path: string; expected?: { kind: PackageKind; name: string }; subject: string }>,
    diagnostics: CatalogDiagnostic[],
  ): Promise<Array<{ path: string; descriptor: PackageDescriptor }>> {
    await this.ensure(wanted.map((item) => descriptorPath(item.path)));
    const found: Array<{ path: string; descriptor: PackageDescriptor }> = [];
    for (const item of wanted) {
      let text: string | null;
      try {
        text = await this.read(descriptorPath(item.path), SNAPSHOT_FILE_LIMITS.descriptor);
      } catch (error) {
        if (!isMarketplaceError(error) || error.code !== "CONTENT_RULE_VIOLATION") throw error;
        diagnostics.push({ subject: item.subject, message: error.message });
        continue;
      }
      if (text === null) {
        diagnostics.push({ subject: item.subject, message: `${descriptorPath(item.path)} is missing` });
        continue;
      }
      const result = validateDescriptorText(text, { ...(item.expected ? { expected: item.expected } : {}), direct: false });
      if (!result.ok) {
        diagnostics.push({ subject: item.subject, message: result.error });
        continue;
      }
      found.push({ path: item.path, descriptor: result.value });
    }
    return found;
  }

  private async fromIndex(text: string, diagnostics: CatalogDiagnostic[]): Promise<{ identity: MarketplaceIdentity; packages: CatalogPackage[] }> {
    const validated = validateIndexText(text, { sourceId: this.source.id, official: this.source.origin === "official" });
    if (!validated.ok) throw new Rejection("SOURCE_INDEX_INVALID", validated.error);
    const { index } = validated.value;
    diagnostics.push(...validated.value.diagnostics);
    const publishedAt = await this.reader.revisionTime();
    const listed: CatalogPackage[] = [];
    // A folder holds one version of each package: its descriptor says which.
    const described = this.folder ? index.packages : index.packages.filter((entry) => !entry.versions);
    const read = await this.descriptors(
      described.map((entry) => ({ path: entry.path, expected: { kind: entry.kind, name: entry.name }, subject: subjectOf(entry) })),
      diagnostics,
    );
    const readByPath = new Map(read.map((item) => [item.path, item.descriptor]));
    for (const entry of index.packages) {
      const { versions, ...rest } = entry;
      if (versions && this.folder) {
        const descriptor = readByPath.get(entry.path);
        if (!descriptor) continue;
        // Only the version whose files are here installs; the index copy of it must say what the files say (§18.4.3).
        const here = versions.find((version) => version.version === descriptor.version);
        if (!here) {
          diagnostics.push({ subject: subjectOf(entry), message: `the folder holds ${descriptor.version}, which the index does not list` });
          continue;
        }
        const differs = descriptorDiffersFromIndex(descriptor, { kind: entry.kind, name: entry.name, ...here });
        if (differs.length > 0) {
          diagnostics.push({ subject: subjectOf(entry), message: `the index copy of ${here.version} differs from the folder in ${differs.join(", ")}` });
          continue;
        }
        listed.push({ ...rest, latest: here.version, versions: [{ ...here, commit: this.versionCommit, publishedAt }] });
        continue;
      }
      if (versions) {
        listed.push({ ...rest, versions });
        continue;
      }
      const descriptor = readByPath.get(entry.path);
      if (!descriptor) continue;
      const fromFile = packageFromDescriptor(descriptor, entry.path, this.versionCommit, publishedAt);
      // The index's own presentation fields win over the descriptor's.
      listed.push({ ...fromFile, ...rest, latest: fromFile.latest!, versions: fromFile.versions });
    }
    const { name, displayName, description, owner } = index;
    return {
      identity: { name, displayName, ...(description !== undefined ? { description } : {}), ...(owner ? { owner } : {}) },
      packages: listed,
    };
  }

  /** The one package at the source's path (design §8.1): a descriptor, or one synthesized from the package's own file. */
  private async fromDirect(): Promise<CatalogPackage[]> {
    const path = this.source.subdir ?? "";
    const read = await readDirectPackage({ tree: this.reader, path, rootName: this.source.rootName });
    if (!read) {
      throw new Rejection("SOURCE_NOT_A_MARKETPLACE", `no ${DIRECT_FILES.join(", ")} at ${path || (this.folder ? "the folder" : "the repository root")}`);
    }
    if (!read.ok) throw new Rejection(read.code, read.error, read.detail);
    return [packageFromDescriptor(read.found.descriptor, path, this.versionCommit, await this.reader.revisionTime())];
  }

  /**
   * A folder read is done: digest what each package installs (a package
   * that cannot be read under the folder rules is dropped with a
   * diagnostic), name the revision, and put it wherever a commit stands.
   */
  private async sealFolder(folder: FolderTree, packages: CatalogPackage[], diagnostics: CatalogDiagnostic[]): Promise<{ revision: string; packages: CatalogPackage[] }> {
    const sealed: CatalogPackage[] = [];
    const digests = new Map<string, string>();
    for (const entry of packages) {
      let treeSha256: string;
      try {
        treeSha256 = (await folder.packageAt(entry.path, entry.kind)).treeSha256;
      } catch (error) {
        if (!isMarketplaceError(error) || error.code !== "CONTENT_RULE_VIOLATION") throw error;
        diagnostics.push({ subject: subjectOf(entry), message: error.message });
        continue;
      }
      digests.set(entry.path, treeSha256);
      sealed.push({ ...entry, treeSha256 });
    }
    const revision = folderRevision(folder.reads, digests);
    return {
      revision,
      packages: sealed.map((entry) => ({
        ...entry,
        versions: entry.versions.map((version) => {
          if (version.commit !== FOLDER_REVISION_PENDING) throw new Error(`folder package ${entry.name} has a version at ${version.commit}`);
          return { ...version, commit: revision };
        }),
      })),
    };
  }

  private async revocations(): Promise<Revocation[]> {
    const text = await this.read(REVOCATIONS_PATH, SNAPSHOT_FILE_LIMITS.revocations);
    if (text === null) return [];
    const result = validateRevocationsText(text);
    // Accepting the rest of a commit whose revocations cannot be read would
    // silently drop a revocation; the previous pin keeps the last good list.
    if (!result.ok) throw new Rejection("SOURCE_INDEX_INVALID", result.error);
    return result.value.revocations;
  }

  async build(fetchedAt: string): Promise<SnapshotResult> {
    const diagnostics: CatalogDiagnostic[] = [];
    try {
      const direct = this.source.origin === "direct";
      await this.ensure(direct ? [REVOCATIONS_PATH] : [INDEX_PATH, REVOCATIONS_PATH]);
      let identity: MarketplaceIdentity;
      let packages: CatalogPackage[];
      const indexText = direct ? null : await this.read(INDEX_PATH, SNAPSHOT_FILE_LIMITS.index);
      if (indexText !== null) {
        ({ identity, packages } = await this.fromIndex(indexText, diagnostics));
      } else if (direct) {
        packages = await this.fromDirect();
        const only = packages[0]!;
        identity = { name: this.source.id, displayName: this.source.label ?? only.displayName ?? only.name };
      } else {
        throw new Rejection("SOURCE_NOT_A_MARKETPLACE", `no ${INDEX_PATH}`);
      }
      const revocations = await this.revocations();
      const conditionalPath = "policy/revocations-by-app.json";
      // ensureBlobs ignores absent paths; the sibling is never required.
      await this.ensure([conditionalPath]);
      const conditionalText = await this.read(conditionalPath, SNAPSHOT_FILE_LIMITS.revocations);
      const conditional = conditionalText === null ? null : validateConditionalRevocationsText(conditionalText);
      if (conditional && !conditional.ok) throw new Rejection("SOURCE_INDEX_INVALID", conditional.error);
      let kept = dropAmbiguous(packages, diagnostics);
      let commit: string;
      if (this.folder) {
        ({ revision: commit, packages: kept } = await this.sealFolder(this.folder, kept, diagnostics));
      } else {
        commit = (this.tree as GitTree).commit;
      }
      return {
        ok: true,
        snapshot: {
          formatVersion: 2,
          conditionalRevocations: conditional?.value.revocations ?? [],
          sourceId: this.source.id,
          commit,
          fetchedAt,
          marketplace: identity,
          packages: kept,
          revocations,
          diagnostics,
        },
      };
    } catch (error) {
      if (error instanceof Rejection) return { ok: false, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
      if (isMarketplaceError(error)) {
        // A blob fetch can still fail on the network, auth or a timeout; that
        // is the sync's result, not an exception past it. A folder's link or
        // file refusal keeps its reason, so the sentence names the file.
        if (error.code === "CONTENT_RULE_VIOLATION" && !error.detail) return { ok: false, code: "SOURCE_INDEX_INVALID", message: error.message };
        return { ok: false, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
      }
      throw error;
    }
  }
}

/**
 * Every artifact sha256 the snapshot pins for plugin `name@version` (release
 * and archive): the bytes that source published as that version. The
 * host-secret grant compares an install against the official snapshot's
 * pins (design §10.3 condition 2).
 */
export function pinnedArtifactSha256s(snapshot: SourceSnapshot, name: string, version: string): string[] {
  const pkg = snapshot.packages.find((item) => item.kind === "plugin" && item.name === name);
  const listed = pkg?.versions.find((item) => item.version === version);
  const pins = [listed?.artifact?.release?.sha256, listed?.artifact?.archive?.sha256];
  return pins.filter((pin): pin is string => typeof pin === "string").map((pin) => pin.toLowerCase());
}
