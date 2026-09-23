/**
 * The plugin artifact ladder (design §6.2, §6.4).
 *
 * A plan is fixed at plan time: the snapshot commit the catalog row came
 * from and the version's own commit. Execution reads only those, so a sync
 * that moves the pin between plan and execute cannot change what is
 * installed. The ladder tries release → archive → tree:
 *
 *   - release and archive are used only with a sha256 pin stored in git;
 *   - a transport or verification failure moves on to the next rung;
 *   - a staged plugin.json that differs from the descriptor stops the ladder
 *     (MANIFEST_MISMATCH): the package is inconsistent, and another rung
 *     would only hide that.
 *
 * The result is a zip in memory with its hash and the outcome of every rung.
 * The tree rung packs the exported files into a zip too, so every rung goes
 * through the same zip preflight and the same install pipeline.
 */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MarketplaceArtifactLimits } from "../../plugins/marketplace-artifact-limits.js";
import type { RequiredMarketplaceRootTextFile } from "../../plugins/plugin-artifact-store.js";
import { ARTIFACT_RUNGS, type ArtifactRung, type RungOutcome } from "../../plugins/plugin-install-receipt.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import type { IndexVersion, PluginArtifactPins, PluginAuthority } from "../catalog/types.js";
import { validateDescriptorText } from "../catalog/validate.js";
import { MarketplaceError, isMarketplaceError, type MarketplaceErrorCode } from "../errors.js";
import type { BareRepo } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import type { NetworkGate } from "../net/network-gate.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";
import type { SourceOrigin } from "../sources/registry.js";
import { downloadBounded } from "./download.js";
import { assertGitInstallManifest } from "./manifest-rules.js";

export interface PluginInstallPlan {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  snapshotCommit: string;
  versionCommit: string;
  /** Package directory in the repository; "" is the root of a direct source. */
  packagePath: string;
  name: string;
  version: string;
  minAppVersion: string;
  platforms?: IndexVersion["platforms"];
  authority: PluginAuthority;
  artifact: PluginArtifactPins;
}

export interface StagedPluginArtifact {
  plan: PluginInstallPlan;
  zipBuffer: Buffer;
  /** Zip sha256 (release, archive) or tree digest (tree). */
  artifactSha256: string;
  rung: ArtifactRung;
  rungs: RungOutcome[];
  /** The staged plugin.json document, already checked against the descriptor. */
  manifestDocument: unknown;
}

/** The part of the artifact store the ladder uses: the zip preflight and a bounded root read. */
export interface ZipInspector {
  readRequiredRootTextFiles(slug: string, zipBuffer: Buffer, requests: readonly RequiredMarketplaceRootTextFile[]): Readonly<Record<string, string>>;
}

export interface LadderDeps {
  repo: BareRepo;
  /** Remote for blobs the partial clone does not hold yet (descriptor, tree). */
  remote: GitRemote;
  /** The source URL: release assets without `url` live on its host. */
  sourceUrl: NormalizedSourceUrl;
  direct: boolean;
  gate: NetworkGate;
  fetchImpl: typeof fetch;
  /** The stored token for the source host when the source uses token auth; GitHub release assets then go through the REST API. */
  sourceToken: string | null;
  zip: ZipInspector;
  limits: Readonly<MarketplaceArtifactLimits>;
  /** Scratch directory for the tree export; removed before the ladder returns. */
  workRoot: string;
  signal?: AbortSignal;
}

/** Ladder failure that carries every rung outcome so far (for the plan view and diagnostics). */
export class LadderError extends MarketplaceError {
  constructor(
    code: MarketplaceErrorCode,
    message: string,
    readonly rungs: readonly RungOutcome[],
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = "LadderError";
  }
}

const DESCRIPTOR_NAME = "ave-package.json";
const DESCRIPTOR_LIMIT = 256 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;
const RELEASE_METADATA_LIMIT = 1024 * 1024;
const RELEASE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
/** Top-level entries a tree-rung directory may hold (design §5.2); the descriptor is not installed. */
const TREE_TOP_LEVEL_FILES = new Set(["plugin.json", DESCRIPTOR_NAME]);
const TREE_TOP_LEVEL_DIRS = new Set(["dist", "assets"]);

/** A plan for the row's candidate version (design §6.1). */
export function planPluginInstall(row: CatalogRow): PluginInstallPlan {
  if (row.kind !== "plugin") throw new Error(`${row.kind} ${row.name} is not a plugin`);
  if (row.choice.state === "upgrade_required") {
    throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.name} needs Ave ${row.choice.minAppVersion} or newer`);
  }
  if (row.choice.state !== "candidate") {
    throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `no version of ${row.name} from ${row.sourceId} is offered to this installation`);
  }
  return planForVersion(row, row.choice.version);
}

/** A plan for one listed version of the row. */
export function planForVersion(row: CatalogRow, version: IndexVersion): PluginInstallPlan {
  if (!row.package.versions.includes(version)) throw new Error(`${row.name}@${version.version} is not a version of this row`);
  // Snapshot validation requires both for every plugin version.
  if (!version.authority || !version.artifact) throw new Error(`${row.name}@${version.version} has no authority or artifact`);
  return {
    sourceId: row.sourceId,
    sourceOrigin: row.sourceOrigin,
    snapshotCommit: row.snapshotCommit,
    versionCommit: version.commit,
    packagePath: row.package.path,
    name: row.name,
    version: version.version,
    minAppVersion: version.minAppVersion,
    ...(version.platforms ? { platforms: version.platforms } : {}),
    authority: version.authority,
    artifact: version.artifact,
  };
}

function repoPath(dir: string, file: string): string {
  return dir === "" ? file : `${dir}/${file}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Tree digest (design §6.4): sha256 over `"<mode> <sha256(file)> <path>\n"`
 * for every installed file, sorted by path bytes.
 */
export function treeDigest(files: ReadonlyArray<{ path: string; data: Buffer; executable: boolean }>): string {
  const lines = files
    .map((file) => ({ key: Buffer.from(file.path, "utf8"), line: `${file.executable ? "100755" : "100644"} ${sha256(file.data)} ${file.path}\n` }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  for (const { line } of lines) hash.update(line, "utf8");
  return hash.digest("hex");
}

function same(a: unknown, b: unknown): boolean {
  return (a === undefined) === (b === undefined) && (a === undefined || canonicalStringify(a) === canonicalStringify(b));
}

/**
 * The descriptor at the version's commit must say what the index copy says:
 * that commit is what the plan is bound to, and the index is only a copy.
 */
async function assertDescriptorAtVersion(plan: PluginInstallPlan, deps: LadderDeps): Promise<void> {
  const path = repoPath(plan.packagePath, DESCRIPTOR_NAME);
  await deps.repo.ensureBlobs(deps.remote, plan.versionCommit, [path], deps.signal);
  const bytes = await deps.repo.readFile(plan.versionCommit, path, DESCRIPTOR_LIMIT);
  const fail = (why: string) => new LadderError("MANIFEST_MISMATCH", `${plan.name}@${plan.version} at ${plan.versionCommit}: ${why}`, []);
  if (!bytes) throw fail(`${path} is missing`);
  const checked = validateDescriptorText(bytes.toString("utf8"), { direct: deps.direct });
  if (!checked.ok) throw fail(`${path} is invalid: ${checked.error}`);
  const descriptor = checked.value;
  const payload = descriptor.payload as { authority?: unknown; artifact?: unknown };
  const differs = [
    descriptor.kind !== "plugin" && "kind",
    descriptor.name !== plan.name && "name",
    descriptor.version !== plan.version && "version",
    descriptor.minAppVersion !== plan.minAppVersion && "minAppVersion",
    !same(descriptor.platforms, plan.platforms) && "platforms",
    !same(payload.authority, plan.authority) && "authority",
    !same(payload.artifact, plan.artifact) && "artifact",
  ].filter((field): field is string => typeof field === "string");
  if (differs.length > 0) throw fail(`the index copy differs from ${path} in ${differs.join(", ")}`);
}

/** Read and check plugin.json from a zip that passed the preflight. */
function stagedManifest(plan: PluginInstallPlan, zipBuffer: Buffer, deps: LadderDeps, rungs: RungOutcome[]): unknown {
  let text: string;
  try {
    text = deps.zip.readRequiredRootTextFiles(plan.name, zipBuffer, [{ filename: "plugin.json", maxBytes: MANIFEST_LIMIT, packageLabel: "plugin" }])["plugin.json"]!;
  } catch (error) {
    throw new VerificationFailure("CONTENT_RULE_VIOLATION", (error as Error).message, error);
  }
  let document: unknown;
  try {
    document = parseStrictJson(text);
  } catch (error) {
    throw new LadderError("MANIFEST_MISMATCH", `${plan.name}@${plan.version}: plugin.json does not parse: ${(error as Error).message}`, rungs, { cause: error });
  }
  try {
    assertGitInstallManifest(document, { name: plan.name, version: plan.version, minAppVersion: plan.minAppVersion, authority: plan.authority });
  } catch (error) {
    throw new LadderError("MANIFEST_MISMATCH", (error as Error).message, rungs, { cause: error });
  }
  return document;
}

/** A rung failure the ladder moves past. */
class VerificationFailure extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

interface RungBytes {
  zipBuffer: Buffer;
  artifactSha256: string;
}

function downloadOptions(deps: LadderDeps, plan: PluginInstallPlan, headers?: Record<string, string>) {
  return {
    gate: deps.gate,
    fetchImpl: deps.fetchImpl,
    official: plan.sourceOrigin === "official",
    maxBytes: deps.limits.maxCompressedBytes,
    ...(headers ? { headers } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

function verifyPinned(zipBuffer: Buffer, pin: string, what: string): RungBytes {
  const digest = sha256(zipBuffer);
  if (digest !== pin.toLowerCase()) {
    throw new VerificationFailure("ARTIFACT_DIGEST_MISMATCH", `${what} hashes to ${digest}, the pin is ${pin.toLowerCase()}`);
  }
  return { zipBuffer, artifactSha256: digest };
}

/**
 * A GitHub release asset through the REST API, which serves private
 * repositories to a token; the asset request redirects to a storage host, and
 * the gate drops `Authorization` on that cross-origin hop.
 */
async function githubReleaseAsset(repo: string, tag: string, asset: string, token: string, plan: PluginInstallPlan, deps: LadderDeps): Promise<Buffer> {
  const auth = { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const metadata = await downloadBounded(releaseUrl, {
    ...downloadOptions(deps, plan, { ...auth, accept: "application/vnd.github+json" }),
    maxBytes: RELEASE_METADATA_LIMIT,
  });
  let release: unknown;
  try {
    release = JSON.parse(metadata.toString("utf8"));
  } catch (error) {
    throw new MarketplaceError("SOURCE_UNREACHABLE", `api.github.com returned an unreadable release for ${repo}@${tag}`, { cause: error });
  }
  const assets = (release as { assets?: unknown }).assets;
  const found = Array.isArray(assets)
    ? assets.find((item): item is { id: number; name: string } => typeof item === "object" && item !== null && (item as { name?: unknown }).name === asset)
    : undefined;
  if (!found || !Number.isSafeInteger(found.id)) {
    throw new MarketplaceError("SOURCE_UNREACHABLE", `release ${repo}@${tag} has no asset ${asset}`);
  }
  return downloadBounded(`https://api.github.com/repos/${repo}/releases/assets/${found.id}`, downloadOptions(deps, plan, { ...auth, accept: "application/octet-stream" }));
}

async function releaseRung(plan: PluginInstallPlan, deps: LadderDeps): Promise<RungBytes> {
  const release = plan.artifact.release!;
  if (release.url) {
    return verifyPinned(await downloadBounded(release.url, downloadOptions(deps, plan)), release.sha256, "the release asset");
  }
  // Validation allows an absent repo only for a direct source: the source repository itself.
  const repo = release.repo ?? deps.sourceUrl.path.replace(/^\//u, "").replace(/\.git$/u, "");
  if (!RELEASE_REPO.test(repo)) throw new VerificationFailure("SOURCE_INDEX_INVALID", `release repository "${repo}" is not owner/name`);
  const tag = release.tag ?? `v${plan.version}`;
  const asset = release.asset ?? `${plan.name}-${plan.version}.zip`;
  const bytes = deps.sourceUrl.host === "github.com" && deps.sourceToken
    ? await githubReleaseAsset(repo, tag, asset, deps.sourceToken, plan, deps)
    : await downloadBounded(
      `${deps.sourceUrl.scheme}://${deps.sourceUrl.port === null ? deps.sourceUrl.host : `${deps.sourceUrl.host}:${deps.sourceUrl.port}`}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
      downloadOptions(deps, plan),
    );
  return verifyPinned(bytes, release.sha256, "the release asset");
}

async function archiveRung(plan: PluginInstallPlan, deps: LadderDeps): Promise<RungBytes> {
  const archive = plan.artifact.archive!;
  return verifyPinned(await downloadBounded(archive.url, downloadOptions(deps, plan)), archive.sha256, "the archive");
}

function treePath(plan: PluginInstallPlan): string {
  return plan.artifact.tree ?? plan.packagePath;
}

/** The tree rung is declared by `artifact.tree`, or by a plugin.json in the package directory (its default). */
async function treeDeclared(plan: PluginInstallPlan, deps: LadderDeps): Promise<boolean> {
  if (plan.artifact.tree !== undefined) return true;
  const manifest = repoPath(plan.packagePath, "plugin.json");
  const entries = await deps.repo.lsTree(plan.versionCommit, manifest, false);
  return entries.some((entry) => entry.path === manifest && entry.type === "blob");
}

async function treeRung(plan: PluginInstallPlan, deps: LadderDeps): Promise<RungBytes> {
  const dest = await mkdtemp(join(deps.workRoot, "tree-"));
  try {
    const exported = await deps.repo.exportPath(
      deps.remote,
      plan.versionCommit,
      treePath(plan),
      dest,
      { maxFiles: deps.limits.maxEntryCount, maxBytes: deps.limits.maxTotalUncompressedBytes },
      deps.signal,
    );
    const files: Array<{ path: string; data: Buffer; executable: boolean }> = [];
    for (const file of exported) {
      const [top, ...rest] = file.path.split("/");
      if (rest.length === 0 ? !TREE_TOP_LEVEL_FILES.has(top!) : !TREE_TOP_LEVEL_DIRS.has(top!)) {
        throw new VerificationFailure("CONTENT_RULE_VIOLATION", `the tree may hold plugin.json, dist/ and assets/ only: ${file.path}`);
      }
      if (file.path === DESCRIPTOR_NAME) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 << 16 : 0o644 << 16);
    return { zipBuffer: zip.toBuffer(), artifactSha256: treeDigest(files) };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

function failureCode(error: unknown): MarketplaceErrorCode {
  if (error instanceof VerificationFailure) return error.code;
  if (isMarketplaceError(error)) return error.code;
  return "SOURCE_UNREACHABLE";
}

/** Run the ladder for `plan`: the first rung that yields a verified, matching artifact wins. */
export async function runPluginLadder(plan: PluginInstallPlan, deps: LadderDeps): Promise<StagedPluginArtifact> {
  await assertDescriptorAtVersion(plan, deps);
  const rungs: RungOutcome[] = [];
  for (const rung of ARTIFACT_RUNGS) {
    deps.signal?.throwIfAborted();
    if (rung === "release" || rung === "archive") {
      const pin = plan.artifact[rung];
      if (!pin) {
        rungs.push({ rung, outcome: "skipped", reason: "NOT_DECLARED" });
        continue;
      }
      if (!pin.sha256) {
        rungs.push({ rung, outcome: "skipped", reason: "ARTIFACT_NOT_PINNED" });
        continue;
      }
    } else {
      let declared: boolean;
      try {
        declared = await treeDeclared(plan, deps);
      } catch (error) {
        deps.signal?.throwIfAborted();
        rungs.push({ rung, outcome: "failed", code: failureCode(error), message: (error as Error).message });
        continue;
      }
      if (!declared) {
        rungs.push({ rung, outcome: "skipped", reason: "NOT_DECLARED" });
        continue;
      }
    }
    let bytes: RungBytes;
    try {
      bytes = rung === "release" ? await releaseRung(plan, deps) : rung === "archive" ? await archiveRung(plan, deps) : await treeRung(plan, deps);
    } catch (error) {
      deps.signal?.throwIfAborted();
      rungs.push({ rung, outcome: "failed", code: failureCode(error), message: (error as Error).message });
      continue;
    }
    let manifestDocument: unknown;
    try {
      manifestDocument = stagedManifest(plan, bytes.zipBuffer, deps, [...rungs, { rung, outcome: "failed", code: "MANIFEST_MISMATCH", message: "plugin.json differs from the descriptor" }]);
    } catch (error) {
      if (!(error instanceof VerificationFailure)) throw error;
      rungs.push({ rung, outcome: "failed", code: error.code, message: error.message });
      continue;
    }
    rungs.push({ rung, outcome: "used" });
    return { plan, zipBuffer: bytes.zipBuffer, artifactSha256: bytes.artifactSha256, rung, rungs, manifestDocument };
  }
  const summary = rungs.map((item) => `${item.rung}: ${item.outcome === "failed" ? `${item.code} (${item.message})` : item.outcome === "skipped" ? `skipped (${item.reason})` : "used"}`);
  throw new LadderError("NO_INSTALLABLE_ARTIFACT", `${plan.name}@${plan.version}: no rung produced an installable artifact — ${summary.join("; ")}`, rungs);
}
