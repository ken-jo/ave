import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { PLUGIN_RUNTIME_DIR_NAMES } from "./plugin-storage-layout.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isSemver } from "../shared/semver-compare.js";
import { parseConsentFingerprint, type ConsentFingerprint } from "../marketplace/updates/consent-record.js";
import { isRecord } from "../shared/is-record.js";

const log = createLogger("plugin-install-receipt");

export interface InstallReceiptFile {
  path: string;
  sha256: string;
}

/** Legacy receipts retain signed-catalog admission metadata so their integrity still verifies. */
export interface PluginAdmissionRecord {
  /** `issuedAt` of the authorising catalog document. */
  issuedAt: string;
  /** Hex sha256 of that document's exact body bytes. */
  documentSha256: string;
  /** Who the distributor attributed the artifact to. */
  publisher: string;
}

/** Git artifact ladder rungs in attempted order. */
export const ARTIFACT_RUNGS = ["release", "archive", "tree"] as const;
export type ArtifactRung = (typeof ARTIFACT_RUNGS)[number];

/** Folder artifacts grant neither process entry nor host-secret access. */
export const FOLDER_RUNG = "folder";
export type PluginRung = ArtifactRung | typeof FOLDER_RUNG;

/** What happened on one rung; every rung appears once, in ladder order (a folder install has only `folder`). */
export type RungOutcome =
  | { rung: PluginRung; outcome: "used" }
  | { rung: PluginRung; outcome: "skipped"; reason: "NOT_DECLARED" | "ARTIFACT_NOT_PINNED" }
  | { rung: PluginRung; outcome: "failed"; code: string; message: string };

/** Receipt provenance proves source, bound commits and rung outcomes; registry origin supports lookups. */
export interface GitInstallRecord {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  snapshotCommit: string;
  versionCommit: string;
  /** Package directory in the repository; "" is the root of a direct source. */
  packagePath: string;
  rung: ArtifactRung;
  rungs: RungOutcome[];
  /** Hash of the authority reviewed when this artifact was installed. */
  authoritySha256?: string;
  /** Optional accepted consent baseline; older receipts may omit it. */
  consent?: ConsentFingerprint;
}

/** Folder provenance pins the installed tree, never a release artifact; it grants neither process entry nor host secrets. */
export interface FolderInstallRecord {
  sourceId: string;
  /** Folder sources are added by the user or provisioned by the policy; the official source is never a folder. */
  sourceOrigin: "managed" | "custom" | "direct";
  /** Folder revisions use local-<sha256>. */
  revision: string;
  /** Package directory in the folder; "" is the root of a direct source. */
  packagePath: string;
  /** Installed tree digest, equal to artifactSha256. */
  treeSha256: string;
  /** Hash of the authority reviewed when this artifact was installed. */
  authoritySha256: string;
  /** Optional accepted consent baseline; older receipts may omit it. */
  consent?: ConsentFingerprint;
}

// v3 local-dev receipts have no signer or admission; legacy signed receipts retain their verified bytes.
// installSource remains the authoritative trust signal.
export interface SignedOrLocalInstallReceipt {
  schemaVersion: 3;
  pluginId: string;
  version: string;
  installSource: "marketplace" | "local-dev";
  artifactSha256: string | null;
  signerKeyId: string | null;
  admission: PluginAdmissionRecord | null;
  installedAt: string;
  reviewedAppVersion?: string;
  files: InstallReceiptFile[];
}

/** v4 git receipts record pinned artifact or tree hashes and ladder provenance without signer or admission. */
export interface GitInstallReceipt {
  schemaVersion: 4;
  pluginId: string;
  version: string;
  installSource: "git";
  artifactSha256: string;
  signerKeyId: null;
  admission: null;
  git: GitInstallRecord;
  installedAt: string;
  reviewedAppVersion?: string;
  files: InstallReceiptFile[];
}

/** v4 folder receipts record the tree digest and folder provenance without signer or admission. */
export interface FolderInstallReceipt {
  schemaVersion: 4;
  pluginId: string;
  version: string;
  installSource: "folder";
  artifactSha256: string;
  signerKeyId: null;
  admission: null;
  folder: FolderInstallRecord;
  installedAt: string;
  reviewedAppVersion?: string;
  files: InstallReceiptFile[];
}

export type PluginInstallReceipt = SignedOrLocalInstallReceipt | GitInstallReceipt | FolderInstallReceipt;

/** Pre-v3 receipts omit admission and are normalized during raw verification. */
interface PluginInstallReceiptV2 {
  schemaVersion: 2;
  pluginId: string;
  version: string;
  installSource: "marketplace" | "local-dev";
  artifactSha256: string | null;
  signerKeyId: string | null;
  installedAt: string;
  files: InstallReceiptFile[];
}

/** Pre-v2 receipts normalize to PluginInstallReceipt during verification. */
interface PluginInstallReceiptV1 {
  schemaVersion: 1;
  pluginId: string;
  version: string;
  artifactSha256: string;
  signerKeyId: string;
  installedAt: string;
  files: InstallReceiptFile[];
}

export function installReceiptPath(cacheRoot: string, pluginId: string): string {
  return resolve(cacheRoot, pluginId, "install-receipt.json");
}

export async function hashReceiptFiles(
  pluginRoot: string,
  files: string[],
): Promise<InstallReceiptFile[]> {
  const unique = [...new Set(files.map(normalizeReceiptPath).filter(Boolean))].sort();
  const out: InstallReceiptFile[] = [];
  for (const relPath of unique) {
    const absPath = resolve(pluginRoot, relPath);
    if (!isContained(pluginRoot, absPath)) {
      throw new Error(`receipt file escapes plugin root: ${relPath}`);
    }
    const bytes = await readFile(absPath);
    out.push({
      path: relPath,
      sha256: sha256Hex(bytes),
    });
  }
  return out;
}

export async function writeInstallReceipt(
  cacheRoot: string,
  receipt: PluginInstallReceipt,
): Promise<void> {
  const path = installReceiptPath(cacheRoot, receipt.pluginId);
  const content = serializeInstallReceipt(receipt);
  await writeInstallReceiptContent(path, receipt.pluginId, content);
}

function serializeInstallReceipt(receipt: PluginInstallReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function buildInstallReceipt(
  pluginRoot: string,
  input: {
    pluginId: string;
    version: string;
    installSource: "marketplace" | "local-dev";
    artifactSha256: string | null;
    signerKeyId: string | null;
    admission?: PluginAdmissionRecord | null;
    files: string[];
    installedAt?: string;
    reviewedAppVersion?: string;
  },
): Promise<{ receipt: SignedOrLocalInstallReceipt; raw: string }> {
  const receipt: SignedOrLocalInstallReceipt = {
    schemaVersion: 3,
    pluginId: input.pluginId,
    version: input.version,
    installSource: input.installSource,
    artifactSha256: input.artifactSha256,
    signerKeyId: input.signerKeyId,
    admission: input.admission ?? null,
    installedAt: input.installedAt ?? new Date().toISOString(),
    ...(input.reviewedAppVersion ? { reviewedAppVersion: input.reviewedAppVersion } : {}),
    files: await hashReceiptFiles(pluginRoot, input.files),
  };
  return { receipt, raw: serializeInstallReceipt(receipt) };
}

export async function buildGitInstallReceipt(
  pluginRoot: string,
  input: {
    pluginId: string;
    version: string;
    artifactSha256: string;
    git: GitInstallRecord;
    files: string[];
    installedAt?: string;
    reviewedAppVersion?: string;
  },
): Promise<{ receipt: GitInstallReceipt; raw: string }> {
  const problem = gitInstallRecordProblem(input.git);
  if (problem) throw new Error(`git install receipt for ${input.pluginId}: ${problem}`);
  if (!SHA256_HEX.test(input.artifactSha256)) throw new Error(`git install receipt for ${input.pluginId}: artifactSha256 is not a sha256`);
  const receipt: GitInstallReceipt = {
    schemaVersion: 4,
    pluginId: input.pluginId,
    version: input.version,
    installSource: "git",
    artifactSha256: input.artifactSha256,
    signerKeyId: null,
    admission: null,
    git: input.git,
    installedAt: input.installedAt ?? new Date().toISOString(),
    ...(input.reviewedAppVersion ? { reviewedAppVersion: input.reviewedAppVersion } : {}),
    files: await hashReceiptFiles(pluginRoot, input.files),
  };
  return { receipt, raw: serializeInstallReceipt(receipt) };
}

export async function buildFolderInstallReceipt(
  pluginRoot: string,
  input: {
    pluginId: string;
    version: string;
    folder: FolderInstallRecord;
    files: string[];
    installedAt?: string;
    reviewedAppVersion?: string;
  },
): Promise<{ receipt: FolderInstallReceipt; raw: string }> {
  const problem = folderInstallRecordProblem(input.folder);
  if (problem) throw new Error(`folder install receipt for ${input.pluginId}: ${problem}`);
  const receipt: FolderInstallReceipt = {
    schemaVersion: 4,
    pluginId: input.pluginId,
    version: input.version,
    installSource: "folder",
    artifactSha256: input.folder.treeSha256,
    signerKeyId: null,
    admission: null,
    folder: input.folder,
    installedAt: input.installedAt ?? new Date().toISOString(),
    ...(input.reviewedAppVersion ? { reviewedAppVersion: input.reviewedAppVersion } : {}),
    files: await hashReceiptFiles(pluginRoot, input.files),
  };
  return { receipt, raw: serializeInstallReceipt(receipt) };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const COMMIT_HEX = /^[a-f0-9]{40}$/;
const FOLDER_REVISION = /^local-[a-f0-9]{64}$/;
const SOURCE_ORIGINS = new Set(["official", "managed", "custom", "direct"]);
const FOLDER_SOURCE_ORIGINS = new Set(["managed", "custom", "direct"]);

function folderInstallRecordProblem(value: unknown): string | null {
  if (!isRecord(value)) return "folder record is not an object";
  if (!hasOnlyKeys(value, ["sourceId", "sourceOrigin", "revision", "packagePath", "treeSha256", "authoritySha256", "consent"])) {
    return "folder record has unknown fields";
  }
  const consent = consentProblem(value.consent, "folder");
  if (consent) return consent;
  if (typeof value.sourceId !== "string" || value.sourceId.length === 0) return "folder record sourceId is invalid";
  if (typeof value.sourceOrigin !== "string" || !FOLDER_SOURCE_ORIGINS.has(value.sourceOrigin)) return "folder record sourceOrigin is invalid";
  // Folder pins use local revisions, never commit hashes.
  if (typeof value.revision !== "string" || !FOLDER_REVISION.test(value.revision)) return "folder record revision is invalid";
  if (typeof value.packagePath !== "string") return "folder record packagePath is invalid";
  if (typeof value.treeSha256 !== "string" || !SHA256_HEX.test(value.treeSha256)) return "folder record treeSha256 is invalid";
  if (typeof value.authoritySha256 !== "string" || !SHA256_HEX.test(value.authoritySha256)) return "folder record authoritySha256 is invalid";
  return null;
}
const RUNG_SKIP_REASONS = new Set(["NOT_DECLARED", "ARTIFACT_NOT_PINNED"]);

/** Consent baselines must have the extension fingerprint shape. */
function consentProblem(value: unknown, record: "git" | "folder"): string | null {
  if (value === undefined) return null;
  try {
    if (parseConsentFingerprint(value, `${record} record consent`).kind !== "plugin") return `${record} record consent is not an extension's`;
  } catch (error) {
    return error instanceof Error ? error.message : `${record} record consent is invalid`;
  }
  return null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function gitInstallRecordProblem(value: unknown): string | null {
  if (!isRecord(value)) return "git record is not an object";
  if (!hasOnlyKeys(value, ["sourceId", "sourceOrigin", "snapshotCommit", "versionCommit", "packagePath", "rung", "rungs", "authoritySha256", "consent"])) {
    return "git record has unknown fields";
  }
  const consent = consentProblem(value.consent, "git");
  if (consent) return consent;
  if (typeof value.sourceId !== "string" || value.sourceId.length === 0) return "git record sourceId is invalid";
  if (typeof value.sourceOrigin !== "string" || !SOURCE_ORIGINS.has(value.sourceOrigin)) return "git record sourceOrigin is invalid";
  if (typeof value.snapshotCommit !== "string" || !COMMIT_HEX.test(value.snapshotCommit)) return "git record snapshotCommit is invalid";
  if (typeof value.versionCommit !== "string" || !COMMIT_HEX.test(value.versionCommit)) return "git record versionCommit is invalid";
  if (typeof value.packagePath !== "string") return "git record packagePath is invalid";
  if (value.authoritySha256 !== undefined && (typeof value.authoritySha256 !== "string" || !SHA256_HEX.test(value.authoritySha256))) return "git record authoritySha256 is invalid";
  if (!(ARTIFACT_RUNGS as readonly unknown[]).includes(value.rung)) return "git record rung is invalid";
  const rungs = value.rungs;
  if (!Array.isArray(rungs) || rungs.length === 0 || rungs.length > ARTIFACT_RUNGS.length) return "git record rungs are invalid";
  let used = 0;
  for (const [index, item] of rungs.entries()) {
    if (!isRecord(item) || item.rung !== ARTIFACT_RUNGS[index]) return "git record rungs are out of ladder order";
    if (item.outcome === "used") {
      if (!hasOnlyKeys(item, ["rung", "outcome"]) || item.rung !== value.rung || index !== rungs.length - 1) return "git record used rung is invalid";
      used += 1;
    } else if (item.outcome === "skipped") {
      if (!hasOnlyKeys(item, ["rung", "outcome", "reason"]) || !RUNG_SKIP_REASONS.has(item.reason as string)) return "git record skipped rung is invalid";
    } else if (item.outcome === "failed") {
      if (!hasOnlyKeys(item, ["rung", "outcome", "code", "message"]) || typeof item.code !== "string" || typeof item.message !== "string") {
        return "git record failed rung is invalid";
      }
    } else {
      return "git record rung outcome is invalid";
    }
  }
  return used === 1 ? null : "git record must end with the used rung";
}

/** Restore an already-validated receipt snapshot without changing its bytes. */
export async function restoreInstallReceiptRaw(
  cacheRoot: string,
  pluginId: string,
  content: string,
): Promise<void> {
  await writeInstallReceiptContent(installReceiptPath(cacheRoot, pluginId), pluginId, content);
}

async function writeInstallReceiptContent(
  path: string,
  pluginId: string,
  content: string,
): Promise<void> {
  try {
    writeUtf8FileAtomicSync(path, content, 0o600);
  } catch (error) {
    if (!(error instanceof Error) || (error as { committed?: unknown }).committed !== true) throw error;
    const persisted = await readFile(path, "utf-8");
    if (persisted !== content) throw error;
    log.warn(
      `install receipt atomic rename committed for '${pluginId}'; exact bytes verified after parent directory sync failure`,
    );
  }
}

export async function verifyInstallReceipt(
  cacheRoot: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(installReceiptPath(cacheRoot, pluginId), "utf-8");
  } catch (err) {
    return { ok: false, reason: `install receipt missing or unreadable: ${(err as Error).message}` };
  }
  return verifyInstallReceiptRaw(raw, pluginId, pluginRoot);
}

/** Verify an exact durable receipt snapshot against every covered payload file. */
export async function verifyInstallReceiptRaw(
  raw: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { ok: false, reason: `install receipt unreadable: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "install receipt must be a JSON object" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.pluginId !== "string"
    || typeof candidate.version !== "string"
    || candidate.version.length === 0
    || typeof candidate.installedAt !== "string"
    || !Array.isArray(candidate.files)
    || candidate.files.length === 0) {
    return { ok: false, reason: "install receipt has invalid required fields" };
  }
  for (const file of candidate.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || typeof (file as Record<string, unknown>).path !== "string"
      || typeof (file as Record<string, unknown>).sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test((file as Record<string, unknown>).sha256 as string)) {
      return { ok: false, reason: "install receipt has invalid file hash entries" };
    }
  }

  // Normalize dev:-prefixed v1 signers to local-dev source.
  let receipt: PluginInstallReceipt;
  if (candidate.schemaVersion === 1) {
    const v1 = candidate as unknown as PluginInstallReceiptV1;
    if (typeof v1.artifactSha256 !== "string") {
      return { ok: false, reason: "legacy install receipt has invalid artifactSha256" };
    }
    const rawSigner = (v1 as { signerKeyId?: unknown }).signerKeyId;
    const installSource: "marketplace" | "local-dev" =
      typeof rawSigner === "string" && rawSigner.startsWith("dev:") ? "local-dev" : "marketplace";
    receipt = {
      schemaVersion: 3,
      pluginId: v1.pluginId,
      version: v1.version,
      installSource,
      artifactSha256: installSource === "local-dev" ? null : v1.artifactSha256,
      signerKeyId: installSource === "local-dev" ? null : (typeof rawSigner === "string" ? rawSigner : null),
      admission: null,
      installedAt: v1.installedAt,
      files: v1.files,
    };
  } else if (candidate.schemaVersion === 2 || candidate.schemaVersion === 3) {
    const stored = candidate as unknown as PluginInstallReceiptV2 | PluginInstallReceipt;
    // Runtime JSON validation must enforce union literals.
    if (stored.installSource !== "marketplace" && stored.installSource !== "local-dev") {
      return { ok: false, reason: `invalid receipt installSource: ${String(stored.installSource)}` };
    }
    // Absent admission means no catalog authorized the install; normalize it to null.
    receipt = {
      ...stored,
      schemaVersion: 3,
      admission: "admission" in stored ? stored.admission : null,
    };
  } else if (candidate.schemaVersion === 4 && candidate.installSource === "folder") {
    const stored = candidate as unknown as FolderInstallReceipt;
    if (!hasOnlyKeys(candidate, ["schemaVersion", "pluginId", "version", "installSource", "artifactSha256", "signerKeyId", "admission", "folder", "installedAt", "reviewedAppVersion", "files"])) {
      return { ok: false, reason: "folder receipt has unknown fields" };
    }
    if (stored.signerKeyId !== null || stored.admission !== null) {
      return { ok: false, reason: "folder receipt must not carry a signer or an admission" };
    }
    const problem = folderInstallRecordProblem(stored.folder);
    if (problem) return { ok: false, reason: `folder receipt: ${problem}` };
    if (stored.artifactSha256 !== stored.folder.treeSha256) {
      return { ok: false, reason: "folder receipt artifactSha256 is not its tree digest" };
    }
    receipt = stored;
  } else if (candidate.schemaVersion === 4) {
    const stored = candidate as unknown as GitInstallReceipt;
    if (stored.installSource !== "git") {
      return { ok: false, reason: `invalid receipt installSource: ${String(stored.installSource)}` };
    }
    if (stored.signerKeyId !== null || stored.admission !== null) {
      return { ok: false, reason: "git receipt must not carry a signer or an admission" };
    }
    if (typeof stored.artifactSha256 !== "string" || !SHA256_HEX.test(stored.artifactSha256)) {
      return { ok: false, reason: "git receipt has invalid artifactSha256" };
    }
    const problem = gitInstallRecordProblem(stored.git);
    if (problem) return { ok: false, reason: `git receipt: ${problem}` };
    receipt = stored;
  } else {
    return { ok: false, reason: `unsupported install receipt schema: ${String(candidate.schemaVersion)}` };
  }

  if (receipt.pluginId !== pluginId) {
    return { ok: false, reason: `install receipt plugin mismatch: expected ${pluginId}, got ${receipt.pluginId}` };
  }
  if (receipt.reviewedAppVersion !== undefined && (
    typeof receipt.reviewedAppVersion !== "string"
    || !isSemver(receipt.reviewedAppVersion)
  )) return { ok: false, reason: "invalid reviewed app version in install receipt" };

  // Signed marketplace receipts require a signer; packaged local-dev policy stays in runtime, not integrity verification.
  if (receipt.installSource === "marketplace") {
    if (typeof receipt.signerKeyId !== "string" || receipt.signerKeyId.length === 0) {
      return { ok: false, reason: "marketplace receipt missing or empty signerKeyId" };
    }
  }

  if (!Array.isArray(receipt.files) || receipt.files.length === 0) {
    return { ok: false, reason: "install receipt has no file hashes" };
  }
  const receiptPaths = new Set<string>();
  for (const file of receipt.files) {
    const relPath = normalizeReceiptPath(file.path);
    if (!relPath || relPath !== file.path) {
      return { ok: false, reason: `invalid receipt path: ${String(file.path)}` };
    }
    if (receiptPaths.has(relPath)) {
      return { ok: false, reason: `duplicate receipt path: ${relPath}` };
    }
    receiptPaths.add(relPath);
    const absPath = resolve(pluginRoot, relPath);
    if (!isContained(pluginRoot, absPath)) {
      return { ok: false, reason: `receipt file escapes plugin root: ${relPath}` };
    }
    let actual: string;
    try {
      const bytes = await readFile(absPath);
      actual = sha256Hex(bytes);
    } catch (err) {
      return { ok: false, reason: `receipt file unreadable: ${relPath}: ${(err as Error).message}` };
    }
    if (actual !== file.sha256) {
      return { ok: false, reason: `receipt hash mismatch: ${relPath}` };
    }
  }
  let actualPaths: string[];
  try {
    // Validate payload only, excluding runtime directories at the root but retaining nested same-named payload.
    actualPaths = await listFilesRecursive(pluginRoot, PLUGIN_RUNTIME_DIR_NAMES);
  } catch (err) {
    return { ok: false, reason: `installed payload unreadable: ${(err as Error).message}` };
  }
  if (actualPaths.length !== receiptPaths.size
    || actualPaths.some((path) => !receiptPaths.has(path))) {
    const unexpected = actualPaths.find((path) => !receiptPaths.has(path));
    return { ok: false, reason: unexpected
      ? `installed payload contains unlisted file: ${unexpected}`
      : "install receipt file set does not match installed payload" };
  }
  return { ok: true, receipt };
}

export async function listFilesRecursive(
  root: string,
  skipTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Runtime exclusions apply only at the root.
      if (dir === root && entry.isDirectory() && skipTopLevel?.has(entry.name as string)) {
        continue;
      }
      const abs = resolve(dir, entry.name as string);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        throw new Error(`installed payload contains symbolic link: ${relative(root, abs).split(sep).join("/")}`);
      }
      if (info.isDirectory()) {
        await walk(abs);
      } else if (info.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (info.nlink > 1) {
          throw new Error(`installed payload contains hard link: ${rel}`);
        }
        // Ignore interpreter-generated bytecode caches only because execution rechecks covered source freshness.
        if (isPythonBytecodeCacheFile(rel)) continue;
        out.push(rel);
      } else {
        throw new Error(`installed payload contains unsupported entry: ${relative(root, abs).split(sep).join("/")}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

/** Interpreter-generated bytecode caches are not shipped payload; exclusion relies on source freshness checks. */
function isPythonBytecodeCacheFile(relPath: string): boolean {
  return /(?:^|\/)__pycache__\/[^/]+\.(?:pyc|pyo)$/.test(relPath);
}

function normalizeReceiptPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || isAbsolute(normalized)) return "";
  return normalized;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
