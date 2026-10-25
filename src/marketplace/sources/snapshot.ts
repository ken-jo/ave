/** Invalid packages are diagnosed and dropped; invalid index or revocations preserve the previous pin.
 * Folder snapshots offer only the installed tree version and derive their revision after all reads. */
import type {
  IndexVersion,
  MarketplaceIndex,
  PackageDescriptor,
  PackageKind,
  PluginArtifactPins,
  PluginAuthority,
  Revocation,
} from "../catalog/types.js";
import { MARKETPLACE_INDEX_FILE as INDEX_PATH, MARKETPLACE_DESCRIPTOR_FILE, type ConditionalRevocation } from "../catalog/types.js";
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
  path: string;
  displayName?: string;
  description?: string;
  keywords?: string[];
  icon?: string;
  latest?: string;
  /** Versions are newest first; descriptor and folder reads yield exactly one. */
  versions: IndexVersion[];
  /** Folder plans must capture bytes matching this payload digest. */
  treeSha256?: string;
}

export interface SourceSnapshot {
  /** Legacy snapshots may omit conditional policies. */
  formatVersion?: 1 | 2;
  conditionalRevocations?: ConditionalRevocation[];
  sourceId: string;
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

class Rejection extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    readonly detail?: MarketplaceErrorDetail,
  ) {
    super(message);
  }
}

export interface SnapshotSubject {
  id: string;
  origin: SourceOrigin;
  label?: string;
  subdir?: string;
  rootName: string;
}

/** Temporary folder commit marker never leaves the builder. */
const FOLDER_REVISION_PENDING = "local-pending";

function descriptorPath(packagePath: string): string {
  return packagePath ? `${packagePath}/${MARKETPLACE_DESCRIPTOR_FILE}` : MARKETPLACE_DESCRIPTOR_FILE;
}

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

/** Ambiguous identity or path claims drop every claimant. */
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
        // The folder version must match its index copy because only these files can install.
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
      listed.push({ ...fromFile, ...rest, latest: fromFile.latest!, versions: fromFile.versions });
    }
    const { name, displayName, description, owner } = index;
    return {
      identity: { name, displayName, ...(description !== undefined ? { description } : {}), ...(owner ? { owner } : {}) },
      packages: listed,
    };
  }

  private async fromDirect(): Promise<CatalogPackage[]> {
    const path = this.source.subdir ?? "";
    const read = await readDirectPackage({ tree: this.reader, path, rootName: this.source.rootName });
    if (!read) {
      throw new Rejection("SOURCE_NOT_A_MARKETPLACE", `no ${DIRECT_FILES.join(", ")} at ${path || (this.folder ? "the folder" : "the repository root")}`);
    }
    if (!read.ok) throw new Rejection(read.code, read.error, read.detail);
    return [packageFromDescriptor(read.found.descriptor, path, this.versionCommit, await this.reader.revisionTime())];
  }

  /** Digest folder payloads after validation, then replace temporary commit markers with the revision. */
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
    // Reject unreadable revocations so the previous pin retains the last good rules.
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
        // Preserve network and folder-read failures as sync outcomes with their original reason.
        if (error.code === "CONTENT_RULE_VIOLATION" && !error.detail) return { ok: false, code: "SOURCE_INDEX_INVALID", message: error.message };
        return { ok: false, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
      }
      throw error;
    }
  }
}

/** Host-secret grants compare receipt hashes against official release and archive pins. */
export function pinnedArtifactSha256s(snapshot: SourceSnapshot, name: string, version: string): string[] {
  const pkg = snapshot.packages.find((item) => item.kind === "plugin" && item.name === name);
  const listed = pkg?.versions.find((item) => item.version === version);
  const pins = [listed?.artifact?.release?.sha256, listed?.artifact?.archive?.sha256];
  return pins.filter((pin): pin is string => typeof pin === "string").map((pin) => pin.toLowerCase());
}
