/**
 * Build the validated snapshot of one source at one commit (design §2.2, §3,
 * §4.2, §10.4).
 *
 * The snapshot is everything the catalog needs without touching git again:
 * the marketplace identity, each package with its versions, the source's own
 * revocations and the per-package diagnostics. What is read:
 *   - marketplace sources: `marketplace.json`, or, without it, the
 *     conventional layout (`<kind dir>/<name>/ave-package.json`, one level
 *     deep); a package the index lists without `versions` is read from its
 *     descriptor at this commit;
 *   - direct sources: the one package at the subdir (or root), from its
 *     descriptor or synthesized from its own file (direct-package.ts);
 *   - every source: `policy/revocations.json` when present.
 * A package that fails validation is dropped with a diagnostic. An invalid
 * index or revocations file rejects the whole commit, so the caller keeps its
 * previous pin.
 */
import { assertRepoPath, type BareRepo } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import type {
  IndexVersion,
  MarketplaceIndex,
  PackageDescriptor,
  PackageKind,
  PluginArtifactPins,
  PluginAuthority,
  Revocation,
} from "../catalog/types.js";
import type { ConditionalRevocation } from "../catalog/types.js";
import { validateConditionalRevocationsText, validateDescriptorText, validateIndexText, validateRevocationsText, type CatalogDiagnostic } from "../catalog/validate.js";
import { isMarketplaceError, type MarketplaceErrorCode } from "../errors.js";
import { DIRECT_FILES, readDirectPackage } from "./direct-package.js";
import type { ResolvedSource } from "./registry.js";

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
  /** Newest first. A package read from its descriptor has exactly one. */
  versions: IndexVersion[];
}

export interface SourceSnapshot {
  /** Absent on snapshots written before conditional policies. */
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

export type SnapshotResult = { ok: true; snapshot: SourceSnapshot } | { ok: false; code: MarketplaceErrorCode; message: string };

const SNAPSHOT_FILE_LIMITS = {
  index: 16 * 1024 * 1024,
  descriptor: 256 * 1024,
  revocations: 1024 * 1024,
} as const;

const INDEX_PATH = "marketplace.json";
const REVOCATIONS_PATH = "policy/revocations.json";
const DESCRIPTOR_NAME = "ave-package.json";

/** Conventional layout directories and the kind each one holds (§3.3). */
const CONVENTIONAL_DIRS: ReadonlyArray<readonly [string, PackageKind]> = [
  ["plugins", "plugin"],
  ["mcp", "mcp"],
  ["skills", "skill"],
  ["agents", "agent"],
  ["themes", "theme"],
  ["fonts", "font"],
  ["languages", "language"],
  ["providers", "provider"],
  ["messaging", "messaging-connection"],
];

class Rejection extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function descriptorPath(packagePath: string): string {
  return packagePath ? `${packagePath}/${DESCRIPTOR_NAME}` : DESCRIPTOR_NAME;
}

/** One catalog package from a descriptor read at `commit`; the icon becomes repository-relative. */
function packageFromDescriptor(descriptor: PackageDescriptor, path: string, commit: string, publishedAt: string): CatalogPackage {
  const plugin = descriptor.kind === "plugin"
    ? (descriptor.payload as { authority: PluginAuthority; artifact: PluginArtifactPins })
    : null;
  const version: IndexVersion = {
    version: descriptor.version,
    commit,
    minAppVersion: descriptor.minAppVersion,
    ...(descriptor.platforms ? { platforms: descriptor.platforms } : {}),
    ...(plugin ? { authority: plugin.authority, artifact: plugin.artifact } : {}),
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
  constructor(
    private readonly repo: BareRepo,
    private readonly remote: GitRemote,
    private readonly source: ResolvedSource,
    private readonly commit: string,
    private readonly signal?: AbortSignal,
  ) {}

  private async read(path: string, maxBytes: number): Promise<string | null> {
    const bytes = await this.repo.readFile(this.commit, path, maxBytes);
    return bytes === null ? null : bytes.toString("utf8");
  }

  private async ensure(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) await this.repo.ensureBlobs(this.remote, this.commit, paths, this.signal);
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
    const publishedAt = await this.repo.commitTime(this.commit);
    const listed: CatalogPackage[] = [];
    const unversioned = index.packages.filter((entry) => !entry.versions);
    const read = await this.descriptors(
      unversioned.map((entry) => ({ path: entry.path, expected: { kind: entry.kind, name: entry.name }, subject: subjectOf(entry) })),
      diagnostics,
    );
    const readByPath = new Map(read.map((item) => [item.path, item.descriptor]));
    for (const entry of index.packages) {
      const { versions, ...rest } = entry;
      if (versions) {
        listed.push({ ...rest, versions });
        continue;
      }
      const descriptor = readByPath.get(entry.path);
      if (!descriptor) continue;
      const fromFile = packageFromDescriptor(descriptor, entry.path, this.commit, publishedAt);
      // The index's own presentation fields win over the descriptor's.
      listed.push({ ...fromFile, ...rest, latest: fromFile.latest!, versions: fromFile.versions });
    }
    const { name, displayName, description, owner } = index;
    return {
      identity: { name, displayName, ...(description !== undefined ? { description } : {}), ...(owner ? { owner } : {}) },
      packages: listed,
    };
  }

  private async fromConventionalLayout(diagnostics: CatalogDiagnostic[]): Promise<CatalogPackage[]> {
    const wanted: Array<{ path: string; kind: PackageKind; subject: string }> = [];
    for (const [dir, kind] of CONVENTIONAL_DIRS) {
      for (const entry of await this.repo.lsTree(this.commit, dir, true)) {
        const segments = entry.path.split("/");
        if (segments.length === 3 && segments[2] === DESCRIPTOR_NAME && entry.type === "blob") {
          const path = `${dir}/${segments[1]}`;
          try {
            assertRepoPath(path);
          } catch (error) {
            // One unusable directory name drops that package, not the source.
            diagnostics.push({ subject: path, message: (error as Error).message });
            continue;
          }
          wanted.push({ path, kind, subject: path });
        }
      }
    }
    if (wanted.length === 0) {
      throw new Rejection("SOURCE_NOT_A_MARKETPLACE", "no marketplace.json and no package descriptor in the conventional directories");
    }
    const read = await this.descriptors(wanted, diagnostics);
    const publishedAt = await this.repo.commitTime(this.commit);
    const kindOf = new Map(wanted.map((item) => [item.path, item.kind]));
    const packages: CatalogPackage[] = [];
    for (const { path, descriptor } of read) {
      if (descriptor.kind !== kindOf.get(path)) {
        diagnostics.push({ subject: path, message: `declares kind ${descriptor.kind} inside ${path.split("/")[0]}/` });
        continue;
      }
      packages.push(packageFromDescriptor(descriptor, path, this.commit, publishedAt));
    }
    return packages;
  }

  /** The one package at the source's path (design §8.1): a descriptor, or one synthesized from the package's own file. */
  private async fromDirect(): Promise<CatalogPackage[]> {
    const path = this.source.subdir ?? "";
    const read = await readDirectPackage({ repo: this.repo, remote: this.remote, commit: this.commit, path, ...(this.signal ? { signal: this.signal } : {}) });
    if (!read) {
      throw new Rejection("SOURCE_NOT_A_MARKETPLACE", `no ${DIRECT_FILES.join(", ")} at ${path || "the repository root"}`);
    }
    if (!read.ok) throw new Rejection(read.code, read.error);
    return [packageFromDescriptor(read.found.descriptor, path, this.commit, await this.repo.commitTime(this.commit))];
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
        packages = await this.fromConventionalLayout(diagnostics);
        identity = { name: this.source.id, displayName: this.source.label ?? this.source.id };
      }
      const revocations = await this.revocations();
      const conditionalPath = "policy/revocations-by-app.json";
      // ensureBlobs ignores absent paths; the sibling is never required.
      await this.ensure([conditionalPath]);
      const conditionalText = await this.read(conditionalPath, SNAPSHOT_FILE_LIMITS.revocations);
      const conditional = conditionalText === null ? null : validateConditionalRevocationsText(conditionalText);
      if (conditional && !conditional.ok) throw new Rejection("SOURCE_INDEX_INVALID", conditional.error);
      return {
        ok: true,
        snapshot: {
          formatVersion: 2,
          conditionalRevocations: conditional?.value.revocations ?? [],
          sourceId: this.source.id,
          commit: this.commit,
          fetchedAt,
          marketplace: identity,
          packages: dropAmbiguous(packages, diagnostics),
          revocations,
          diagnostics,
        },
      };
    } catch (error) {
      if (error instanceof Rejection) return { ok: false, code: error.code, message: error.message };
      if (isMarketplaceError(error)) {
        // A blob fetch can still fail on the network, auth or a timeout; that
        // is the sync's result, not an exception past it.
        return { ok: false, code: error.code === "CONTENT_RULE_VIOLATION" ? "SOURCE_INDEX_INVALID" : error.code, message: error.message };
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
