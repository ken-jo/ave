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
 * A pinned zip already kept under its digest is read back instead of
 * downloaded, and a downloaded one that the rung used is kept.
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
import { MarketplaceError, isMarketplaceError, type MarketplaceErrorCode } from "../errors.js";
import type { NetworkGate } from "../net/network-gate.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";
import type { ArtifactCache } from "./artifact-cache.js";
import { candidateVersion, DESCRIPTOR_NAME, planPackage, readDescriptorAtVersion, repoPath, type PackagePlan, type RepositoryAccess } from "./descriptor.js";
import { downloadBounded } from "./download.js";
import { assertGitInstallManifest } from "./manifest-rules.js";

export interface PluginInstallPlan extends PackagePlan {
  kind: "plugin";
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
interface ZipInspector {
  readRequiredRootTextFiles(slug: string, zipBuffer: Buffer, requests: readonly RequiredMarketplaceRootTextFile[]): Readonly<Record<string, string>>;
}

export interface LadderDeps extends RepositoryAccess {
  /** The source URL: release assets without `url` live on its host. */
  sourceUrl: NormalizedSourceUrl;
  gate: NetworkGate;
  fetchImpl: typeof fetch;
  /** The stored token for the source host when the source uses token auth; GitHub release assets then go through the REST API. */
  sourceToken: string | null;
  /** The source uses token auth and no token is stored for its host: a hidden (404) release asset needs sign-in. */
  tokenMissing: boolean;
  zip: ZipInspector;
  limits: Readonly<MarketplaceArtifactLimits>;
  /** Scratch directory for the tree export; removed before the ladder returns. */
  workRoot: string;
  /** Pinned zips kept from earlier downloads, by digest. */
  artifacts: ArtifactCache;
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

const MANIFEST_LIMIT = 1024 * 1024;
const RELEASE_METADATA_LIMIT = 1024 * 1024;
/** `owner/name`; neither segment may be `.` or `..`. */
const RELEASE_REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/u;
/** Top-level entries a tree-rung directory may hold (design §5.2); the descriptor is not installed. */
const TREE_TOP_LEVEL_FILES = new Set(["plugin.json", DESCRIPTOR_NAME]);
const TREE_TOP_LEVEL_DIRS = new Set(["dist", "assets"]);

/** A plan for the row's candidate version (design §6.1). */
export function planPluginInstall(row: CatalogRow): PluginInstallPlan {
  if (row.kind !== "plugin") throw new Error(`${row.kind} ${row.name} is not a plugin`);
  return planPluginVersion(row, candidateVersion(row));
}

/** A plan for one listed version of the row: the candidate, or an older version chosen to roll back. */
export function planPluginVersion(row: CatalogRow, version: IndexVersion): PluginInstallPlan {
  if (row.kind !== "plugin") throw new Error(`${row.kind} ${row.name} is not a plugin`);
  // Snapshot validation requires both for every plugin version.
  if (!version.authority || !version.artifact) throw new Error(`${row.name}@${version.version} has no authority or artifact`);
  return { ...planPackage(row, version), kind: "plugin", authority: version.authority, artifact: version.artifact };
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
  const descriptor = await readDescriptorAtVersion(plan, deps);
  const payload = descriptor.payload as { authority?: unknown; artifact?: unknown };
  const differs = [!same(payload.authority, plan.authority) && "authority", !same(payload.artifact, plan.artifact) && "artifact"]
    .filter((field): field is string => typeof field === "string");
  if (differs.length > 0) {
    throw new MarketplaceError(
      "MANIFEST_MISMATCH",
      `plugin ${plan.name}@${plan.version} at ${plan.versionCommit}: the index copy differs from ${repoPath(plan.packagePath, DESCRIPTOR_NAME)} in ${differs.join(", ")}`,
    );
  }
}

/** Read and check plugin.json from a zip that passed the preflight. */
function stagedManifest(plan: PluginInstallPlan, zipBuffer: Buffer, deps: LadderDeps, rungs: readonly RungOutcome[], rung: ArtifactRung): unknown {
  const stop = (code: MarketplaceErrorCode, message: string, cause: unknown) =>
    new LadderError(code, message, [...rungs, { rung, outcome: "failed", code, message: code === "PACKAGE_COMPAT_UNDECLARED" ? "plugin.json does not declare requires.minAppVersion" : "plugin.json differs from the descriptor" }], { cause });
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
  try {
    assertGitInstallManifest(document, { name: plan.name, version: plan.version, minAppVersion: plan.minAppVersion, hostProtocol: plan.hostProtocol, authority: plan.authority });
  } catch (error) {
    // PACKAGE_COMPAT_UNDECLARED or MANIFEST_MISMATCH; either stops the ladder.
    throw stop(isMarketplaceError(error) ? error.code : "MANIFEST_MISMATCH", (error as Error).message, error);
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
  // The request goes to api.github.com; the repository's own rules still apply.
  await deps.gate.checkDownloadPolicy(
    `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
    { official: plan.sourceOrigin === "official" },
  );
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

/**
 * The web origin release assets are served from. An http(s) source serves
 * them from its own origin; an ssh source's host serves them over https on
 * the default port (its ssh port says nothing about the web server).
 */
function releaseOrigin(url: NormalizedSourceUrl): string {
  if (url.scheme === "ssh") return `https://${url.host}`;
  return `${url.scheme}://${url.port === null ? url.host : `${url.host}:${url.port}`}`;
}

async function releaseRung(plan: PluginInstallPlan, deps: LadderDeps, pin: string): Promise<RungBytes> {
  const release = plan.artifact.release!;
  if (release.url) {
    return verifyPinned(await downloadBounded(release.url, downloadOptions(deps, plan)), pin, "the release asset");
  }
  // Validation allows an absent repo only for a direct source: the source repository itself.
  const repo = release.repo ?? deps.sourceUrl.path.replace(/^\//u, "").replace(/\.git$/u, "");
  if (!RELEASE_REPO.test(repo)) throw new VerificationFailure("SOURCE_INDEX_INVALID", `release repository "${repo}" is not owner/name`);
  const tag = release.tag ?? `v${plan.version}`;
  const asset = release.asset ?? `${plan.name}-${plan.version}.zip`;
  const bytes = deps.sourceUrl.host === "github.com" && deps.sourceToken
    ? await githubReleaseAsset(repo, tag, asset, deps.sourceToken, plan, deps)
    : await downloadBounded(`${releaseOrigin(deps.sourceUrl)}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`, {
      ...downloadOptions(deps, plan),
      tokenMissing: deps.tokenMissing,
    });
  return verifyPinned(bytes, pin, "the release asset");
}

async function archiveRung(plan: PluginInstallPlan, deps: LadderDeps, pin: string): Promise<RungBytes> {
  const archive = plan.artifact.archive!;
  return verifyPinned(await downloadBounded(archive.url, downloadOptions(deps, plan)), pin, "the archive");
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

function treeLayoutProblem(path: string): string | null {
  const [top, ...rest] = path.split("/");
  const allowed = rest.length === 0 ? TREE_TOP_LEVEL_FILES.has(top!) : TREE_TOP_LEVEL_DIRS.has(top!);
  return allowed ? null : `the tree may hold plugin.json, dist/ and assets/ only: ${path}`;
}

async function treeRung(plan: PluginInstallPlan, deps: LadderDeps): Promise<RungBytes> {
  // The layout is known from the tree alone: refuse it before any blob is
  // downloaded (a direct source at the repository root exports every file).
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
      if (file.path === DESCRIPTOR_NAME) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 : 0o644);
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
        ? { zipBuffer: keptZip, artifactSha256: pinned!.toLowerCase() }
        : pinned === undefined ? await treeRung(plan, deps) : rung === "release" ? await releaseRung(plan, deps, pinned) : await archiveRung(plan, deps, pinned);
    } catch (error) {
      deps.signal?.throwIfAborted();
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
    return { plan, zipBuffer: bytes.zipBuffer, artifactSha256: bytes.artifactSha256, rung, rungs, manifestDocument };
  }
  const summary = rungs.map((item) => `${item.rung}: ${item.outcome === "failed" ? `${item.code} (${item.message})` : item.outcome === "skipped" ? `skipped (${item.reason})` : "used"}`);
  // Every rung that was tried wanted sign-in: that, not a missing artifact, is what to fix.
  const failed = rungs.filter((item) => item.outcome === "failed");
  const code = failed.length > 0 && failed.every((item) => item.code === "SOURCE_AUTH_REQUIRED") ? "SOURCE_AUTH_REQUIRED" : "NO_INSTALLABLE_ARTIFACT";
  throw new LadderError(code, `${plan.name}@${plan.version}: no rung produced an installable artifact — ${summary.join("; ")}`, rungs);
}
