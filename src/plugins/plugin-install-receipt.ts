import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { PLUGIN_RUNTIME_DIR_NAMES } from "./plugin-storage-layout.js";
import { createLogger } from "../lib/logger.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";

const log = createLogger("plugin-install-receipt");

export interface InstallReceiptFile {
  path: string;
  sha256: string;
}

/**
 * Which signed admission catalog authorised a server-marketplace install.
 *
 * The server marketplace and its admission catalog are gone (design §16.2);
 * nothing writes this any more. A receipt written before the switch may carry
 * it, and it parses so that receipt keeps verifying.
 */
export interface PluginAdmissionRecord {
  /** `issuedAt` of the authorising catalog document. */
  issuedAt: string;
  /** Hex sha256 of that document's exact body bytes. */
  documentSha256: string;
  /** Who the distributor attributed the artifact to. */
  publisher: string;
}

/** The rungs of the git plugin artifact ladder (design §6.2), in the order tried. */
export const ARTIFACT_RUNGS = ["release", "archive", "tree"] as const;
export type ArtifactRung = (typeof ARTIFACT_RUNGS)[number];

/** What happened on one rung; every rung appears once, in ladder order. */
export type RungOutcome =
  | { rung: ArtifactRung; outcome: "used" }
  | { rung: ArtifactRung; outcome: "skipped"; reason: "NOT_DECLARED" | "ARTIFACT_NOT_PINNED" }
  | { rung: ArtifactRung; outcome: "failed"; code: string; message: string };

/**
 * Where a git install came from: the source, the two commits the plan was
 * bound to, and the ladder's outcome. The registry's `origin` names the same
 * install for lookups; the receipt is what proves the bytes.
 */
export interface GitInstallRecord {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  snapshotCommit: string;
  versionCommit: string;
  /** Package directory in the repository; "" is the root of a direct source. */
  packagePath: string;
  rung: ArtifactRung;
  rungs: RungOutcome[];
}

/**
 * Schema v3 — written by local-dev installs, which have no artifact, signer or
 * admission. A server-marketplace install from before the git marketplace kept
 * its v3 receipt (`installSource: "marketplace"`), which still verifies.
 * installSource is the authoritative trust signal.
 */
export interface SignedOrLocalInstallReceipt {
  schemaVersion: 3;
  pluginId: string;
  version: string;
  installSource: "marketplace" | "local-dev";
  artifactSha256: string | null;
  signerKeyId: string | null;
  admission: PluginAdmissionRecord | null;
  installedAt: string;
  files: InstallReceiptFile[];
}

/**
 * Schema v4 — written by git installs only (design §6.2), so a receipt of a
 * signed or local install keeps its v3 bytes. There is no signer and no
 * admission: `artifactSha256` is the pinned zip hash (release, archive) or
 * the tree digest (§6.4), and `git` records the plan and the ladder.
 */
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
  files: InstallReceiptFile[];
}

export type PluginInstallReceipt = SignedOrLocalInstallReceipt | GitInstallReceipt;

/**
 * On-disk shape of receipts written before schema v3. Normalised by
 * `verifyInstallReceiptRaw`; the only difference is the absent `admission`.
 */
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

/**
 * On-disk shape of receipts written before schema v2.
 * verifyInstallReceipt normalises these to PluginInstallReceipt internally.
 */
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
    files: await hashReceiptFiles(pluginRoot, input.files),
  };
  return { receipt, raw: serializeInstallReceipt(receipt) };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const COMMIT_HEX = /^[a-f0-9]{40}$/;
const SOURCE_ORIGINS = new Set(["official", "managed", "custom", "direct"]);
const RUNG_SKIP_REASONS = new Set(["NOT_DECLARED", "ARTIFACT_NOT_PINNED"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Why a git install record is malformed, or null when it is well formed. */
export function gitInstallRecordProblem(value: unknown): string | null {
  if (!isPlainRecord(value)) return "git record is not an object";
  if (!hasOnlyKeys(value, ["sourceId", "sourceOrigin", "snapshotCommit", "versionCommit", "packagePath", "rung", "rungs"])) {
    return "git record has unknown fields";
  }
  if (typeof value.sourceId !== "string" || value.sourceId.length === 0) return "git record sourceId is invalid";
  if (typeof value.sourceOrigin !== "string" || !SOURCE_ORIGINS.has(value.sourceOrigin)) return "git record sourceOrigin is invalid";
  if (typeof value.snapshotCommit !== "string" || !COMMIT_HEX.test(value.snapshotCommit)) return "git record snapshotCommit is invalid";
  if (typeof value.versionCommit !== "string" || !COMMIT_HEX.test(value.versionCommit)) return "git record versionCommit is invalid";
  if (typeof value.packagePath !== "string") return "git record packagePath is invalid";
  if (!(ARTIFACT_RUNGS as readonly unknown[]).includes(value.rung)) return "git record rung is invalid";
  const rungs = value.rungs;
  if (!Array.isArray(rungs) || rungs.length === 0 || rungs.length > ARTIFACT_RUNGS.length) return "git record rungs are invalid";
  let used = 0;
  for (const [index, item] of rungs.entries()) {
    if (!isPlainRecord(item) || item.rung !== ARTIFACT_RUNGS[index]) return "git record rungs are out of ladder order";
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

  // Normalise v1 → v2.
  // v1 receipts with signerKeyId starting with "dev:" were written by the
  // old installLocal sentinel — treat them as local-dev installs.
  let receipt: PluginInstallReceipt;
  if (candidate.schemaVersion === 1) {
    const v1 = candidate as unknown as PluginInstallReceiptV1;
    if (typeof v1.artifactSha256 !== "string") {
      return { ok: false, reason: "legacy install receipt has invalid artifactSha256" };
    }
    // Guard against corrupted receipts where signerKeyId is missing at runtime.
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
    // Runtime enum validation — JSON.parse+as-cast cannot enforce union literals.
    if (stored.installSource !== "marketplace" && stored.installSource !== "local-dev") {
      return { ok: false, reason: `invalid receipt installSource: ${String(stored.installSource)}` };
    }
    // v2 → v3: the absence of an admission record means no catalog authorised
    // this install, which is exactly what it says. Not a default that papers
    // over a missing value.
    receipt = {
      ...stored,
      schemaVersion: 3,
      admission: "admission" in stored ? stored.admission : null,
    };
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

  // marketplace receipts must carry a real signerKeyId.
  // The packaged-build gate for local-dev receipts lives in the caller
  // (runtime/index.ts verifyReceiptAndDevGuard) to keep this function a
  // pure integrity verifier — policy enforcement stays in the runtime layer.
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
    // Validate the INSTALLED PAYLOAD only. A plugin's writable data directory
    // (`<pluginRoot>/data`, created by ensurePluginDataDir — under the Ave
    // home, the sole writable area the sandbox grants the plugin inside its
    // root) holds runtime state the plugin legitimately creates/mutates at
    // runtime (index DBs, migration markers, workspace), and `<pluginRoot>/run`
    // holds host-allocated worker control sockets. Neither is part of the
    // signed install artifact, so scanning them makes the receipt fail the
    // moment the plugin runs. Skip them at the TOP level only — a nested
    // `dist/data/` would be shipped payload and stays validated.
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
      // Skip named directories at the ROOT level only (e.g. runtime `data/`);
      // deeper directories with the same name stay part of the scan.
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
        // Python bytecode cache (`**​/__pycache__/<name>.pyc|pyo`) is compiled
        // in-place by the interpreter from the validated `.py` sources, is never
        // part of the signed install artifact, and regenerates whenever the
        // plugin's Python runtime runs. Exclude it at ANY depth so a
        // Python-backed plugin's payload stays receipt-valid across runs. The
        // scope is deliberately tight — only `.pyc`/`.pyo` *inside* a
        // `__pycache__/` segment — so a non-bytecode file smuggled into a
        // `__pycache__/` directory is still listed and rejected as unlisted.
        // Tamper-safety: Python ignores a `.pyc` whose source hash/mtime does
        // not match, so an altered cache file is never executed while the
        // covered `.py` remains validated.
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

/**
 * True for Python bytecode cache files — `**​/__pycache__/<name>.pyc` (or
 * `.pyo`). These are compiled in-place from validated `.py` sources, never
 * shipped in the signed artifact, and regenerate at runtime; excluding them
 * from payload validation keeps Python-backed plugins receipt-valid without
 * weakening tamper detection of executed code (see `listFilesRecursive`).
 */
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
