/** Try pinned release, archive, then tree at the planned commits; manifest mismatch stops all rungs.
 * Folder installs use only the captured built tree and never download. */
import AdmZip from "adm-zip";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MarketplaceArtifactLimits } from "../../plugins/marketplace-artifact-limits.js";
import type { RequiredMarketplaceRootTextFile } from "../../plugins/plugin-artifact-store.js";
import { ARTIFACT_RUNGS, FOLDER_RUNG, type PluginRung, type RungOutcome } from "../../plugins/plugin-install-receipt.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MARKETPLACE_DESCRIPTOR_FILE, type IndexVersion, type PluginArtifactPins, type PluginAuthority } from "../catalog/types.js";
import { MarketplaceError, isMarketplaceError, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../errors.js";
import type { BareRepo } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import type { CatalogSource, NetworkGate } from "../net/network-gate.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";
import { isFolderRevision, packageInstalls } from "../sources/source-tree.js";
import type { ArtifactCache } from "./artifact-cache.js";
import { candidateVersion, planPackage, readDescriptorAtVersion, repoPath, type PackagePlan, type RepositoryAccess } from "./descriptor.js";
import { downloadBounded } from "./download.js";
import { treeDigest } from "./tree-digest.js";
import { assertGitInstallManifest, expectedPluginOf } from "./manifest-rules.js";
import {
  hasProcessEntry,
  PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
  PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_MESSAGE,
} from "../../plugins/process-entry.js";

export interface PluginInstallPlan extends PackagePlan {
  kind: "plugin";
  authority: PluginAuthority;
  artifact: PluginArtifactPins;
}

export interface StagedPluginArtifact {
  plan: PluginInstallPlan;
  zipBuffer: Buffer;
  artifactSha256: string;
  rung: PluginRung;
  rungs: RungOutcome[];
  /** Actual downloads record plaintext redirect hops; cached bytes retain only declared transport. */
  unencrypted: boolean;
  manifestDocument: unknown;
  notInstalled: string[];
}

interface ZipInspector {
  readRequiredRootTextFiles(slug: string, zipBuffer: Buffer, requests: readonly RequiredMarketplaceRootTextFile[]): Readonly<Record<string, string>>;
}

export interface FolderLadderDeps extends RepositoryAccess {
  zip: ZipInspector;
  limits: Readonly<MarketplaceArtifactLimits>;
  workRoot: string;
}

export interface LadderDeps extends FolderLadderDeps {
  repo: BareRepo;
  remote: GitRemote;
  /** Releases without explicit URLs inherit the source web origin. */
  sourceUrl: NormalizedSourceUrl;
  gate: NetworkGate;
  catalog: CatalogSource;
  /** Token-authenticated release assets use the source token through the release API. */
  sourceToken: string | null;
  /** A hidden release asset without a stored source token requires sign-in. */
  tokenMissing: boolean;
  artifacts: ArtifactCache;
}

export class LadderError extends MarketplaceError {
  constructor(
    code: MarketplaceErrorCode,
    message: string,
    readonly rungs: readonly RungOutcome[],
    options?: { cause?: unknown; detail?: MarketplaceErrorDetail },
  ) {
    super(code, message, options);
    this.name = "LadderError";
  }
}

const MANIFEST_LIMIT = 1024 * 1024;
const RELEASE_METADATA_LIMIT = 1024 * 1024;
const RELEASE_REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/u;
const TREE_TOP_LEVEL_FILES = new Set(["plugin.json", MARKETPLACE_DESCRIPTOR_FILE]);
const TREE_TOP_LEVEL_DIRS = new Set(["dist", "assets"]);

export function planPluginInstall(row: CatalogRow): PluginInstallPlan {
  if (row.kind !== "plugin") throw new Error(`${row.kind} ${row.name} is not a plugin`);
  return planPluginVersion(row, candidateVersion(row));
}

export function planPluginVersion(row: CatalogRow, version: IndexVersion): PluginInstallPlan {
  if (row.kind !== "plugin") throw new Error(`${row.kind} ${row.name} is not a plugin`);
  if (!version.authority || !version.artifact) throw new Error(`${row.name}@${version.version} has no authority or artifact`);
  return { ...planPackage(row, version), kind: "plugin", authority: version.authority, artifact: version.artifact };
}

export { treeDigest };

function same(a: unknown, b: unknown): boolean {
  return (a === undefined) === (b === undefined) && (a === undefined || canonicalStringify(a) === canonicalStringify(b));
}

/** Read the authoritative descriptor at the planned version commit, not just the index copy. */
async function assertDescriptorAtVersion(plan: PluginInstallPlan, deps: RepositoryAccess): Promise<void> {
  const descriptor = await readDescriptorAtVersion(plan, deps);
  const payload = descriptor.payload as { authority?: unknown; artifact?: unknown };
  const differs = [!same(payload.authority, plan.authority) && "authority", !same(payload.artifact, plan.artifact) && "artifact"]
    .filter((field): field is string => typeof field === "string");
  if (differs.length > 0) {
    throw new MarketplaceError(
      "MANIFEST_MISMATCH",
      `plugin ${plan.name}@${plan.version} at ${plan.versionCommit}: the index copy differs from ${repoPath(plan.packagePath, MARKETPLACE_DESCRIPTOR_FILE)} in ${differs.join(", ")}`,
    );
  }
}

function stagedManifest(plan: PluginInstallPlan, zipBuffer: Buffer, deps: FolderLadderDeps, rungs: readonly RungOutcome[], rung: PluginRung): unknown {
  const stop = (code: MarketplaceErrorCode, message: string, cause?: unknown) =>
    new LadderError(code, message, [...rungs, { rung, outcome: "failed", code, message: code === PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE
      ? PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_MESSAGE
      : code === "PACKAGE_COMPAT_UNDECLARED" ? "plugin.json does not declare requires.minAppVersion" : "plugin.json differs from the descriptor" }], cause === undefined ? undefined : { cause });
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
    throw stop("MANIFEST_MISMATCH", `${plan.name}@${plan.version}: plugin.json does not parse: ${(error as Error).message}`, error);
  }
  // Process entries require a marketplace pinned release or archive; either direct-source marker refuses them.
  if (hasProcessEntry(document) && (plan.sourceOrigin === "direct" || deps.direct)) {
    throw stop(
      PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
      `${plan.name}@${plan.version}: a direct source serves a process entry, which is installed only from a marketplace release or archive pinned by sha256`,
    );
  }
  // Folder bytes cannot satisfy pinned-artifact process admission.
  if (rung === FOLDER_RUNG && hasProcessEntry(document)) {
    throw stop(
      PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
      `${plan.name}@${plan.version}: a folder serves a process entry, which is installed only from a marketplace release or archive pinned by sha256`,
    );
  }
  // Reject process entries on the final tree rung even if declared-pin validation was bypassed.
  if (rung === "tree" && hasProcessEntry(document)) {
    throw stop(
      PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
      `${plan.name}@${plan.version}: the tree rung staged a process entry, which is installed only from a release or archive pinned by sha256`,
    );
  }
  try {
    assertGitInstallManifest(document, expectedPluginOf(plan));
  } catch (error) {
    // Missing compatibility or manifest mismatch stops the entire ladder.
    throw stop(isMarketplaceError(error) ? error.code : "MANIFEST_MISMATCH", (error as Error).message, error);
  }
  return document;
}

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
  unencrypted: boolean;
}

class HopTransport {
  plainHttp = false;
  readonly onHop = (hop: string): void => {
    if (hop.startsWith("http:")) this.plainHttp = true;
  };
}

function downloadOptions(deps: LadderDeps, plan: PluginInstallPlan, hops: HopTransport, headers?: Record<string, string>) {
  return {
    gate: deps.gate,
    catalog: deps.catalog,
    official: plan.sourceOrigin === "official",
    maxBytes: deps.limits.maxCompressedBytes,
    onHop: hops.onHop,
    ...(headers ? { headers } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

function verifyPinned(zipBuffer: Buffer, pin: string, what: string, hops: HopTransport): RungBytes {
  const digest = sha256Hex(zipBuffer);
  if (digest !== pin.toLowerCase()) {
    throw new VerificationFailure("ARTIFACT_DIGEST_MISMATCH", `${what} hashes to ${digest}, the pin is ${pin.toLowerCase()}`);
  }
  return { zipBuffer, artifactSha256: digest, unencrypted: hops.plainHttp };
}

/** Tokenized release requests strip Authorization before cross-origin storage redirects. */
async function githubReleaseAsset(repo: string, tag: string, asset: string, token: string, plan: PluginInstallPlan, deps: LadderDeps, hops: HopTransport): Promise<Buffer> {
  await deps.gate.checkDownloadPolicy(
    `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
    { official: plan.sourceOrigin === "official" },
  );
  const auth = { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const metadata = await downloadBounded(releaseUrl, {
    ...downloadOptions(deps, plan, hops, { ...auth, accept: "application/vnd.github+json" }),
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
  return downloadBounded(`https://api.github.com/repos/${repo}/releases/assets/${found.id}`, downloadOptions(deps, plan, hops, { ...auth, accept: "application/octet-stream" }));
}

/** HTTP sources retain their origin; SSH sources use HTTPS without inheriting the SSH port. */
function releaseOrigin(url: NormalizedSourceUrl): string {
  if (url.scheme === "ssh") return `https://${url.host}`;
  return `${url.scheme}://${url.port === null ? url.host : `${url.host}:${url.port}`}`;
}

function declaredPlainHttp(plan: PluginInstallPlan, deps: LadderDeps, rung: "release" | "archive"): boolean {
  const url = rung === "archive" ? plan.artifact.archive!.url : plan.artifact.release!.url ?? releaseOrigin(deps.sourceUrl);
  return url.startsWith("http://");
}

async function releaseRung(plan: PluginInstallPlan, deps: LadderDeps, pin: string): Promise<RungBytes> {
  const release = plan.artifact.release!;
  const hops = new HopTransport();
  if (release.url) {
    return verifyPinned(await downloadBounded(release.url, downloadOptions(deps, plan, hops)), pin, "the release asset", hops);
  }
  // Only direct sources may default the release repository to their own repository.
  const repo = release.repo ?? deps.sourceUrl.path.replace(/^\//u, "").replace(/\.git$/u, "");
  if (!RELEASE_REPO.test(repo)) throw new VerificationFailure("SOURCE_INDEX_INVALID", `release repository "${repo}" is not owner/name`);
  const tag = release.tag ?? `v${plan.version}`;
  const asset = release.asset ?? `${plan.name}-${plan.version}.zip`;
  const bytes = deps.sourceUrl.host === "github.com" && deps.sourceToken
    ? await githubReleaseAsset(repo, tag, asset, deps.sourceToken, plan, deps, hops)
    : await downloadBounded(`${releaseOrigin(deps.sourceUrl)}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`, {
      ...downloadOptions(deps, plan, hops),
      tokenMissing: deps.tokenMissing,
    });
  return verifyPinned(bytes, pin, "the release asset", hops);
}

async function archiveRung(plan: PluginInstallPlan, deps: LadderDeps, pin: string): Promise<RungBytes> {
  const archive = plan.artifact.archive!;
  const hops = new HopTransport();
  return verifyPinned(await downloadBounded(archive.url, downloadOptions(deps, plan, hops)), pin, "the archive", hops);
}

function treePath(plan: PluginInstallPlan): string {
  return plan.artifact.tree ?? plan.packagePath;
}

async function treeDeclared(plan: PluginInstallPlan, deps: LadderDeps): Promise<boolean> {
  if (plan.artifact.tree !== undefined) return true;
  const manifest = repoPath(plan.packagePath, "plugin.json");
  const entries = await deps.repo.lsTree(plan.versionCommit, manifest, false);
  return entries.some((entry) => entry.path === manifest && entry.type === "blob");
}

function treeLayoutProblem(path: string): string | null {
  const [top, ...rest] = path.split("/");
  const allowed = rest.length === 0 ? TREE_TOP_LEVEL_FILES.has(top!) : TREE_TOP_LEVEL_DIRS.has(top!);
  return allowed ? null : `the tree may hold plugin.json, dist/ and assets/ only: ${path}`;
}

async function treeRung(plan: PluginInstallPlan, deps: LadderDeps): Promise<RungBytes> {
  // Reject invalid tree layout before downloading any blob.
  const root = treePath(plan);
  for (const entry of await deps.repo.lsTree(plan.versionCommit, root === "" ? null : root, true)) {
    if (entry.type !== "blob") continue;
    const problem = treeLayoutProblem(root === "" ? entry.path : entry.path.slice(root.length + 1));
    if (problem) throw new VerificationFailure("CONTENT_RULE_VIOLATION", problem);
  }
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
      const problem = treeLayoutProblem(file.path);
      if (problem) throw new VerificationFailure("CONTENT_RULE_VIOLATION", problem);
      if (file.path === MARKETPLACE_DESCRIPTOR_FILE) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 : 0o644);
    return { zipBuffer: zip.toBuffer(), artifactSha256: treeDigest(files), unencrypted: false };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

function failureCode(error: unknown): MarketplaceErrorCode {
  if (error instanceof VerificationFailure) return error.code;
  if (isMarketplaceError(error)) return error.code;
  return "SOURCE_UNREACHABLE";
}

export async function runPluginLadder(plan: PluginInstallPlan, deps: LadderDeps): Promise<StagedPluginArtifact> {
  if (isFolderRevision(plan.versionCommit)) throw new Error(`${plan.name}@${plan.version} is a folder package; it installs through the folder rung`);
  await assertDescriptorAtVersion(plan, deps);
  const rungs: RungOutcome[] = [];
  /** Preserve the first actionable missing-confirmation failure. */
  let confirmation: MarketplaceError | null = null;
  for (const rung of ARTIFACT_RUNGS) {
    deps.signal?.throwIfAborted();
    let pinned: string | undefined;
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
      pinned = pin.sha256;
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
    let kept = false;
    try {
      const keptZip = pinned === undefined ? null : await deps.artifacts.read(pinned);
      kept = keptZip !== null;
      bytes = keptZip !== null
        ? { zipBuffer: keptZip, artifactSha256: pinned!.toLowerCase(), unencrypted: rung !== "tree" && declaredPlainHttp(plan, deps, rung) }
        : pinned === undefined ? await treeRung(plan, deps) : rung === "release" ? await releaseRung(plan, deps, pinned) : await archiveRung(plan, deps, pinned);
    } catch (error) {
      deps.signal?.throwIfAborted();
      if (isMarketplaceError(error) && error.code === "SOURCE_CONFIRMATION_REQUIRED") confirmation ??= error;
      rungs.push({ rung, outcome: "failed", code: failureCode(error), message: (error as Error).message });
      continue;
    }
    let manifestDocument: unknown;
    try {
      manifestDocument = stagedManifest(plan, bytes.zipBuffer, deps, rungs, rung);
    } catch (error) {
      if (!(error instanceof VerificationFailure)) throw error;
      rungs.push({ rung, outcome: "failed", code: error.code, message: error.message });
      continue;
    }
    rungs.push({ rung, outcome: "used" });
    if (pinned !== undefined && !kept) await deps.artifacts.keep(bytes.artifactSha256, bytes.zipBuffer);
    return { plan, zipBuffer: bytes.zipBuffer, artifactSha256: bytes.artifactSha256, rung, rungs, unencrypted: bytes.unencrypted, manifestDocument, notInstalled: [] };
  }
  const summary = rungs.map((item) => `${item.rung}: ${item.outcome === "failed" ? `${item.code} (${item.message})` : item.outcome === "skipped" ? `skipped (${item.reason})` : "used"}`);
  // Prefer an actionable source-confirmation failure so the user can authorize and retry.
  if (confirmation !== null) {
    throw new LadderError("SOURCE_CONFIRMATION_REQUIRED", `${plan.name}@${plan.version}: ${confirmation.message} — ${summary.join("; ")}`, rungs, {
      cause: confirmation,
      ...(confirmation.detail ? { detail: confirmation.detail } : {}),
    });
  }
  // All rungs requesting sign-in must report authentication, not a missing artifact.
  const failed = rungs.filter((item) => item.outcome === "failed");
  const code = failed.length > 0 && failed.every((item) => item.code === "SOURCE_AUTH_REQUIRED") ? "SOURCE_AUTH_REQUIRED" : "NO_INSTALLABLE_ARTIFACT";
  throw new LadderError(code, `${plan.name}@${plan.version}: no rung produced an installable artifact — ${summary.join("; ")}`, rungs);
}

/** Use only captured plugin.json, dist and assets; skip declared downloads and list excluded entries. */
export async function runFolderRung(plan: PluginInstallPlan, deps: FolderLadderDeps, notInstalled: readonly string[]): Promise<StagedPluginArtifact> {
  if (!isFolderRevision(plan.versionCommit)) throw new Error(`${plan.name}@${plan.version} is not a folder package`);
  await assertDescriptorAtVersion(plan, deps);
  deps.signal?.throwIfAborted();
  const tree = deps.treeAt(plan.versionCommit);
  const fail = (code: MarketplaceErrorCode, message: string, detail?: MarketplaceErrorDetail, cause?: unknown): LadderError =>
    new LadderError(code, message, [{ rung: FOLDER_RUNG, outcome: "failed", code, message }], {
      ...(detail ? { detail } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  if ((await tree.readFile(repoPath(plan.packagePath, "plugin.json"), MANIFEST_LIMIT)) === null) {
    throw fail(
      "NO_INSTALLABLE_ARTIFACT",
      `${plan.name}@${plan.version}: the folder has no plugin.json — build the plugin into dist/, or add the git repository instead`,
      { reason: "folder-has-no-build", name: plan.name },
    );
  }
  const dest = await mkdtemp(join(deps.workRoot, "folder-"));
  let bytes: RungBytes;
  try {
    let exported;
    try {
      exported = await tree.exportPath(plan.packagePath, dest, { maxFiles: deps.limits.maxEntryCount, maxBytes: deps.limits.maxTotalUncompressedBytes });
    } catch (error) {
      throw fail(failureCode(error), (error as Error).message, isMarketplaceError(error) ? error.detail : undefined, error);
    }
    const files: Array<{ path: string; data: Buffer; executable: boolean }> = [];
    for (const file of exported) {
      const [top, ...rest] = file.path.split("/");
      if (!packageInstalls("plugin", top!, rest.length > 0)) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 : 0o644);
    bytes = { zipBuffer: zip.toBuffer(), artifactSha256: treeDigest(files), unencrypted: false };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
  let manifestDocument: unknown;
  try {
    manifestDocument = stagedManifest(plan, bytes.zipBuffer, deps, [], FOLDER_RUNG);
  } catch (error) {
    if (!(error instanceof VerificationFailure)) throw error;
    throw fail(error.code, error.message, undefined, error);
  }
  return {
    plan,
    zipBuffer: bytes.zipBuffer,
    artifactSha256: bytes.artifactSha256,
    rung: FOLDER_RUNG,
    rungs: [{ rung: FOLDER_RUNG, outcome: "used" }],
    unencrypted: false,
    manifestDocument,
    notInstalled: [...notInstalled],
  };
}
