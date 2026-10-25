/** Artifact storage owns atomic extraction, version snapshots and history for separate plugin-kind roots. */

import AdmZip from "adm-zip";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isResolvedPathWithin } from "./plugin-storage-containment.js";
import { assertPayloadOnlyPluginTree, carryPluginStateDirs, carryPluginSocketDirs } from "./plugin-storage-layout.js";
import { randomUUID } from "node:crypto";

import {
  canonicalZipEntryPathIdentity,
  sanitizeZipEntryPath,
} from "./zip-entry-path.js";
import { type PluginAccessSpec, type PluginRegistryEntryInstallSource } from "./types.js";
import { stripLegacyPluginToolGrants } from "./registry.js";
import { removePluginTreeNowOrAtBoot, tombstoneAndDeferredRemove } from "./installed-entry-fs.js";
import {
  buildInstallReceipt,
  restoreInstallReceiptRaw,
  type PluginInstallReceipt,
} from "./plugin-install-receipt.js";
import { createLogger } from "../lib/logger.js";
import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import {
  assertCompressedArtifactSize,
  MarketplaceArtifactLimitError,
  resolveMarketplaceArtifactLimits,
  type MarketplaceArtifactLimits,
} from "./marketplace-artifact-limits.js";
import { withMarketplaceArtifactResourceSlot } from "./marketplace-artifact-resource-gate.js";
import {
  isCommittedPluginGenerationPublicationError,
  type CommittedPluginGenerationPublicationError,
} from "./committed-generation-publication-error.js";
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
export { assertSafeArtifactSlug } from "./plugin-id.js";

const log = createLogger("plugin-artifact-store");

export interface ArtifactStoreHistoryEntry {
  version: string;
  installedAt: string;
}

export interface CachedRegistryEntrySnapshot {
  installSource?: PluginRegistryEntryInstallSource;
  manifestSha256?: string;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
}

export interface PreparedArtifactCommit<T> {
  /** Verified extraction root. It remains staged until durableCommit runs. */
  pluginRoot: string;
  files: readonly string[];
  /** Promote the payload and execute the caller's durable commit exactly once. */
  durableCommit(): Promise<T>;
}

export interface CoordinatedArtifactCommit<T> {
  result: T;
  /** Predecessor resources must drain before recovery backup cleanup. */
  retirement?: Promise<void>;
  /** Host lifecycle completion propagated for admitted self-updates. */
  completion?: Promise<void>;
  /** The caller owns the predecessor lease and must not await retirement inline. */
  retirementDeferred?: boolean;
}

export interface RequiredMarketplaceRootTextFile {
  filename: string;
  maxBytes: number;
  packageLabel: string;
}
export class ArtifactRollbackError extends AggregateError {
  readonly backupDir?: string;

  constructor(message: string, errors: unknown[], backupDir?: string) {
    super(errors, message);
    this.name = "ArtifactRollbackError";
    this.backupDir = backupDir;
  }
}

export interface ArtifactStoreOptions {
  /** Extraction root shared by consumers; each plugin kind supplies its own namespace. */
  installRoot: string;
  /** Per-ID history and version-snapshot root, separate from extraction. */
  cacheRoot: string;
  /** Resource ceilings shared by download, cache, and zip extraction. */
  artifactLimits?: Partial<MarketplaceArtifactLimits>;
}

export class PluginArtifactStore {
  private readonly installRoot: string;
  private readonly cacheRoot: string;
  private readonly artifactLimits: Readonly<MarketplaceArtifactLimits>;
  private readonly deferredCommitCleanups = new Set<Promise<void>>();

  constructor(options: ArtifactStoreOptions) {
    this.installRoot = options.installRoot;
    this.cacheRoot = options.cacheRoot;
    this.artifactLimits = resolveMarketplaceArtifactLimits(options.artifactLimits);
  }

  installDirFor(slug: string): string {
    const safeSlug = assertSafeArtifactSlug(slug);
    const installDir = resolve(this.installRoot, safeSlug);
    if (!isResolvedPathWithin(this.installRoot, installDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    return installDir;
  }

  /** Serialize the full download → inspect → extract lifetime across plugin kinds. */
  withArtifactResourceSlot<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withMarketplaceArtifactResourceSlot(operation, { signal });
  }

  /** Apply extraction preflight ceilings before reading selected archive text files. */
  readRequiredRootTextFiles(
    slug: string,
    zipBuffer: Buffer,
    requests: readonly RequiredMarketplaceRootTextFile[],
  ): Readonly<Record<string, string>> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const entries = this.parseAndPreflightZip(safeSlug, zipBuffer);
    const requested = new Map<string, RequiredMarketplaceRootTextFile>();
    for (const request of requests) {
      if (
        sanitizeZipEntryPath(safeSlug, request.filename) !== request.filename ||
        request.filename.includes("/") ||
        request.filename.includes("\\")
      ) {
        throw new Error(`required marketplace file must be a root filename: ${request.filename}`);
      }
      if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
        throw new RangeError(`required marketplace file cap must be a positive safe integer: ${request.filename}`);
      }
      requested.set(request.filename, request);
    }

    const result: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName)?.split("\\").join("/");
      if (!safeEntryPath) continue;
      const request = requested.get(safeEntryPath);
      if (!request) continue;
      if (Object.hasOwn(result, request.filename)) {
        throw new Error(`${request.packageLabel} package "${safeSlug}" contains duplicate ${request.filename}`);
      }
      if (entry.header.size > request.maxBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `${request.packageLabel} package ${request.filename} exceeds ${request.maxBytes} byte cap: ${entry.header.size} bytes`,
        );
      }
      const data = entry.getData();
      if (data.byteLength > request.maxBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `${request.packageLabel} package ${request.filename} extracted past ${request.maxBytes} byte cap`,
        );
      }
      result[request.filename] = data.toString("utf-8");
    }
    for (const request of requests) {
      if (!Object.hasOwn(result, request.filename)) {
        throw new Error(
          `${request.packageLabel} package "${safeSlug}" must contain ${request.filename} at the archive root`,
        );
      }
    }
    return Object.freeze(result);
  }

  /** Extract into a unique stage and swap atomically; validate every archive path before materialization. */
  async extractZip(slug: string, zipBuffer: Buffer): Promise<string[]> {
    return (await this.extractZipWithCommit(slug, zipBuffer, async () => undefined)).files;
  }

  /** Commit before deleting the predecessor; on failure restore it or remove the fresh install. */
  async extractZipWithCommit<T>(
    slug: string,
    zipBuffer: Buffer,
    commit: (installDir: string, files: string[]) => Promise<T>,
    options: {
      /** Run after extraction and before live renames. */
      beforePromote?: (recoveryBackupDir: string) => Promise<void>;
      onCommittedBackupResolved?: (obsoleteDir: string) => Promise<void>;
      coordinateCommit?: (
        prepared: PreparedArtifactCommit<T>,
      ) => Promise<CoordinatedArtifactCommit<T>>;
    } = {},
  ): Promise<{ files: string[]; result: T; predecessorRetired: boolean }> {
    const safeSlug = assertSafeArtifactSlug(slug);
    assertCompressedArtifactSize(
      zipBuffer.byteLength,
      this.artifactLimits.maxCompressedBytes,
      `marketplace zip ${safeSlug}`,
    );
    const installDir = this.installDirFor(safeSlug);
    const stageDir = resolve(this.installRoot, `.${safeSlug}.stage-${randomUUID()}`);
    if (!isResolvedPathWithin(this.installRoot, stageDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    // A fresh stage has no existing entries or confined grants.
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });
    const extractedFiles: string[] = [];

    try {
      const entries = this.parseAndPreflightZip(safeSlug, zipBuffer);
      let extractedUncompressedBytes = 0;
      for (const entry of entries) {
        const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName);
        if (!safeEntryPath) continue;
        const targetPath = resolve(stageDir, safeEntryPath);
        if (!isResolvedPathWithin(stageDir, targetPath)) {
          throw new Error(`"${safeSlug}" zip entry escapes install root: ${entry.entryName}`);
        }
        if (entry.isDirectory) {
          await mkdir(targetPath, { recursive: true });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const data = entry.getData();
        if (data.byteLength > this.artifactLimits.maxEntryUncompressedBytes) {
          throw new MarketplaceArtifactLimitError(
            "ARCHIVE_ENTRY_TOO_LARGE",
            `marketplace zip entry ${entry.entryName} extracted past ${this.artifactLimits.maxEntryUncompressedBytes} bytes`,
          );
        }
        extractedUncompressedBytes += data.byteLength;
        if (extractedUncompressedBytes > this.artifactLimits.maxTotalUncompressedBytes) {
          throw new MarketplaceArtifactLimitError(
            "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
            `marketplace zip ${safeSlug} extracted past ${this.artifactLimits.maxTotalUncompressedBytes} bytes`,
          );
        }
        await writeFile(targetPath, data);
        extractedFiles.push(safeEntryPath.split("\\").join("/"));
      }

      const oldDir = resolve(this.installRoot, `.${safeSlug}.old-${randomUUID()}`);
      let hadOldDir = false;
      const files = extractedFiles.sort();
      let durableCommitInvoked = false;
      let durableCommitCompleted = false;
      const durableCommit = async (): Promise<T> => {
        if (durableCommitInvoked) {
          throw new Error(`artifact durable commit invoked more than once: ${safeSlug}`);
        }
        durableCommitInvoked = true;
        await options.beforePromote?.(oldDir);
        try {
          await retryOnTransientFsLock(() => rename(installDir, oldDir), {
            onRetry: (attempt, code) =>
              log.warn({ safeSlug, attempt, code }, "retrying installDir->old swap under fs lock"),
          });
          hadOldDir = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
        }
        try {
          await retryOnTransientFsLock(() => rename(stageDir, installDir), {
            onRetry: (attempt, code) =>
              log.warn({ safeSlug, attempt, code }, "retrying stage->installDir promotion under fs lock"),
          });
        } catch (renameErr) {
          if (hadOldDir) {
            try {
              await retryOnTransientFsLock(() => rename(oldDir, installDir));
            } catch (restoreErr) {
              throw new ArtifactRollbackError(
                `artifact promotion and directory restore both failed: ${safeSlug}`,
                [renameErr, restoreErr],
                oldDir,
              );
            }
          }
          throw renameErr;
        }
        // Move state into the surviving root before removing the failed promoted root.
        const discardPromotedRoot = async (cause: unknown, failedStep: string): Promise<never> => {
          if (hadOldDir) {
            try {
              await retryOnTransientFsLock(() => carryPluginStateDirs(installDir, oldDir, { onConflict: "reject" }));
              // Complete an interrupted forward merge before reversing it to retain the original directory identity.
              if (existsSync(installDir)) await carryPluginSocketDirs(oldDir, installDir, { onConflict: "reject" });
              await carryPluginSocketDirs(installDir, oldDir, {
                onConflict: "reject",
                onRetry: (attempt, code) =>
                  log.warn({ safeSlug, attempt, code }, "retrying plugin socket-dir return to the restored root under fs lock"),
              });
            } catch (carryBackErr) {
              throw new ArtifactRollbackError(
                `${failedStep} and plugin data return both failed: ${safeSlug}`,
                [cause, carryBackErr],
                oldDir,
              );
            }
          }
          try {
            // The activated candidate may still have confinement access to this root.
            await removePluginTreeNowOrAtBoot(
              installDir,
              this.installRoot,
              (path) => retryOnTransientFsLock(() => rm(path, { recursive: true, force: true })),
            );
          } catch (cleanupErr) {
            throw new ArtifactRollbackError(
              `${failedStep} and promoted-directory cleanup both failed: ${safeSlug}`,
              [cause, cleanupErr],
              hadOldDir ? oldDir : undefined,
            );
          }
          if (hadOldDir) {
            try {
              await retryOnTransientFsLock(() => rename(oldDir, installDir));
            } catch (restoreErr) {
              throw new ArtifactRollbackError(
                `${failedStep} and directory restore both failed: ${safeSlug}`,
                [cause, restoreErr],
                oldDir,
              );
            }
          }
          throw cause;
        };
        if (hadOldDir) {
          // Carry predecessor data before the receipt commits; state must not remain in a backup scheduled for removal.
          try {
            await retryOnTransientFsLock(() => carryPluginStateDirs(oldDir, installDir, { onConflict: "reject" }), {
              onRetry: (attempt, code) =>
                log.warn({ safeSlug, attempt, code }, "retrying plugin data carry into promoted root under fs lock"),
            });
            // Carry sockets still granted to the candidate from the renamed root.
            await carryPluginSocketDirs(oldDir, installDir, {
              onConflict: "reject",
              onRetry: (attempt, code) =>
                log.warn({ safeSlug, attempt, code }, "retrying plugin socket-dir carry into promoted root under fs lock"),
            });
          } catch (carryErr) {
            return discardPromotedRoot(carryErr, "artifact data carry");
          }
        }
        try {
          const result = await commit(installDir, files);
          durableCommitCompleted = true;
          return result;
        } catch (commitErr) {
          return discardPromotedRoot(commitErr, "artifact commit");
        }
      };
      let committedPublicationError: CommittedPluginGenerationPublicationError | undefined;
      let coordinated: CoordinatedArtifactCommit<T>;
      try {
        coordinated = options.coordinateCommit
          ? await options.coordinateCommit(Object.freeze({
              pluginRoot: stageDir,
              files: Object.freeze([...files]),
              durableCommit,
            }))
          : { result: await durableCommit() };
      } catch (error) {
        if (!isCommittedPluginGenerationPublicationError(error) || !error.committed) {
          throw error;
        }
        committedPublicationError = error;
        coordinated = error.committed as CoordinatedArtifactCommit<T>;
      }
      if (!durableCommitCompleted) {
        throw new Error(`artifact commit coordinator returned before durable commit: ${safeSlug}`);
      }
      const cleanupCommittedBackup = async (): Promise<void> => {
        if (!hadOldDir) return;
        let cleanupResolved = false;
        try {
          await retryOnTransientFsLock(() => this.removeCommittedBackup(oldDir));
          cleanupResolved = true;
        } catch (cleanupErr) {
          try {
            const tombstone = await tombstoneAndDeferredRemove(oldDir, this.installRoot, {
              onDeferredRmError: (path, error) => {
                log.warn({ safeSlug, path, err: error }, "committed artifact tombstone retained for boot sweeper");
              },
            });
            log.warn(
              { safeSlug, oldDir, tombstone, err: cleanupErr },
              "installed artifact committed; routed obsolete directory to tombstone sweeper",
            );
            cleanupResolved = true;
          } catch (tombstoneErr) {
            log.warn(
              { safeSlug, oldDir, err: new AggregateError([cleanupErr, tombstoneErr]) },
              "installed artifact committed but obsolete directory cleanup and tombstoning failed",
            );
          }
        }
        if (cleanupResolved) {
          await options.onCommittedBackupResolved?.(oldDir).catch((err) => {
            log.warn({ safeSlug, oldDir, err }, "obsolete artifact cleanup ownership remains for boot retry");
          });
        }
      };
      let predecessorRetired = true;
      if (coordinated.retirement) {
        if (coordinated.retirementDeferred) {
          predecessorRetired = false;
          const deferredCleanup = coordinated.retirement.then(cleanupCommittedBackup);
          this.deferredCommitCleanups.add(deferredCleanup);
          void deferredCleanup.finally(() => {
            this.deferredCommitCleanups.delete(deferredCleanup);
          }).catch((error) => {
            log.error(
              { safeSlug, oldDir, err: error },
              "deferred predecessor retirement failed; retaining recovery backup",
            );
          });
        } else {
          try {
            await coordinated.retirement;
          } catch (error) {
            predecessorRetired = false;
            log.error(
              { safeSlug, oldDir, err: error },
              "predecessor generation retirement failed; retaining recovery backup",
            );
          }
        }
      }
      if (predecessorRetired) await cleanupCommittedBackup();
      if (committedPublicationError) throw committedPublicationError;
      return { files, result: coordinated.result, predecessorRetired };
    } catch (err) {
      if (existsSync(stageDir)) {
        try {
          await retryOnTransientFsLock(() => this.removeAbandonedStage(stageDir), {
            onRetry: (attempt, code) =>
              log.warn(
                { safeSlug, stageDir, attempt, code },
                "retrying failed artifact stage cleanup under fs lock",
              ),
          });
        } catch (cleanupErr) {
          try {
            const tombstone = await tombstoneAndDeferredRemove(
              stageDir,
              this.installRoot,
              {
                onDeferredRmError: (path, error) => {
                  log.warn(
                    { safeSlug, path, err: error },
                    "failed artifact stage tombstone retained for boot sweeper",
                  );
                },
              },
            );
            log.warn(
              { safeSlug, stageDir, tombstone, err: cleanupErr },
              "failed artifact stage routed to durable tombstone ownership",
            );
          } catch (tombstoneErr) {
            throw new ArtifactRollbackError(
              `artifact extraction and staged-directory cleanup both failed: ${safeSlug}`,
              [err, cleanupErr, tombstoneErr],
              stageDir,
            );
          }
        }
      }
      throw err;
    }
  }

  private parseAndPreflightZip(safeSlug: string, zipBuffer: Buffer): AdmZip.IZipEntry[] {
    assertCompressedArtifactSize(
      zipBuffer.byteLength,
      this.artifactLimits.maxCompressedBytes,
      `marketplace zip ${safeSlug}`,
    );
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new Error(`invalid zip format for "${safeSlug}": ${(err as Error).message}`);
    }
    const declaredEntryCount = zip.getEntryCount();
    if (declaredEntryCount > this.artifactLimits.maxEntryCount) {
      throw new MarketplaceArtifactLimitError(
        "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
        `marketplace zip ${safeSlug} has ${declaredEntryCount} entries; maximum allowed is ${this.artifactLimits.maxEntryCount}`,
      );
    }
    const entries = zip.getEntries();
    if (entries.length !== declaredEntryCount) {
      throw new Error(
        `marketplace zip ${safeSlug} entry count changed while parsing: declared=${declaredEntryCount} parsed=${entries.length}`,
      );
    }
    let totalUncompressedBytes = 0;
    const archiveMembers = new Set<string>();
    for (const entry of entries) {
      const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName);
      if (!safeEntryPath) continue;
      const memberKey = canonicalZipEntryPathIdentity(safeEntryPath);
      if (archiveMembers.has(memberKey)) {
        throw new Error(`"${safeSlug}" zip contains colliding entry: ${entry.entryName}`);
      }
      archiveMembers.add(memberKey);

      // Reject nonregular archive types from Unix mode bits before any root-file read or extraction.
      const unixMode = (entry.attr >>> 16) & 0xffff;
      const unixType = unixMode & 0o170000;
      const expectedType = entry.isDirectory ? 0o040000 : 0o100000;
      if (unixType !== 0 && unixType !== expectedType) {
        throw new Error(`"${safeSlug}" zip contains unsupported member kind: ${entry.entryName}`);
      }
      const declaredBytes = entry.header.size;
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error(`marketplace zip ${safeSlug} has an invalid entry size: ${entry.entryName}`);
      }
      if (declaredBytes > this.artifactLimits.maxEntryUncompressedBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `marketplace zip entry ${entry.entryName} is ${declaredBytes} bytes; maximum allowed is ${this.artifactLimits.maxEntryUncompressedBytes}`,
        );
      }
      const compressedBytes = entry.header.compressedSize;
      if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 0) {
        throw new Error(`marketplace zip ${safeSlug} has an invalid compressed entry size: ${entry.entryName}`);
      }
      const compressionRatio = declaredBytes === 0
        ? 0
        : compressedBytes === 0
          ? Number.POSITIVE_INFINITY
          : declaredBytes / compressedBytes;
      if (compressionRatio > this.artifactLimits.maxCompressionRatio) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
          `marketplace zip entry ${entry.entryName} compression ratio ${compressionRatio.toFixed(1)}:1 exceeds ${this.artifactLimits.maxCompressionRatio}:1`,
        );
      }
      totalUncompressedBytes += declaredBytes;
      if (totalUncompressedBytes > this.artifactLimits.maxTotalUncompressedBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
          `marketplace zip ${safeSlug} expands to more than ${this.artifactLimits.maxTotalUncompressedBytes} bytes`,
        );
      }
    }
    return entries;
  }

  /** Fingerprint verified archive files using the same extraction preflight and paths. */
  readZipPayloadFiles(slug: string, zipBuffer: Buffer): Array<{ path: string; data: Buffer }> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const files: Array<{ path: string; data: Buffer }> = [];
    for (const entry of this.parseAndPreflightZip(safeSlug, zipBuffer)) {
      const path = sanitizeZipEntryPath(safeSlug, entry.entryName);
      if (!path || entry.isDirectory) continue;
      files.push({ path, data: entry.getData() });
    }
    return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /** Local-development receipts have no artifact, signer or admission. */
  async prepareInstallReceipt(
    slug: string,
    pluginRoot: string,
    input: { version: string; files: string[]; installedAt?: string },
  ): Promise<{ receipt: PluginInstallReceipt; raw: string }> {
    return buildInstallReceipt(pluginRoot, {
      pluginId: assertSafeArtifactSlug(slug),
      ...input,
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
    });
  }

  persistPreparedInstallReceipt(slug: string, raw: string): Promise<void> {
    return restoreInstallReceiptRaw(this.cacheRoot, assertSafeArtifactSlug(slug), raw);
  }

  /** Snapshot the installed manifest before replacement; cache-hygiene failures warn without blocking install. */
  async cacheVersionFromManifest(
    slug: string,
    manifestPath: string,
    registryEntry?: CachedRegistryEntrySnapshot,
  ): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? "unknown";
      const dir = resolve(this.cacheRoot, safeSlug, version);
      await mkdir(dir, { recursive: true });
      await writeFileAtomicAtPath(resolve(dir, "plugin.json"), raw);
      if (registryEntry) {
        await writeFileAtomicAtPath(
          resolve(dir, "registry-entry.json"),
          `${JSON.stringify({
            installSource: registryEntry.installSource,
            manifestSha256: registryEntry.manifestSha256,
            bundleRefs: registryEntry.bundleRefs,
            approvedPluginAccess: stripLegacyPluginToolGrants(registryEntry.approvedPluginAccess).access,
          }, null, 2)}\n`,
        );
      }
    } catch (err) {
      log.warn(
        `cacheVersion failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  async readCachedRegistryEntrySnapshot(
    slug: string,
    version: string,
  ): Promise<CachedRegistryEntrySnapshot | null> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(resolve(this.cacheRoot, safeSlug, version, "registry-entry.json"), "utf-8");
      const parsed = JSON.parse(raw) as Partial<CachedRegistryEntrySnapshot>;
      const approvedPluginAccess = stripLegacyPluginToolGrants(parsed.approvedPluginAccess).access;
      return {
        ...(parsed.installSource ? { installSource: parsed.installSource } : {}),
        ...(typeof parsed.manifestSha256 === "string" ? { manifestSha256: parsed.manifestSha256 } : {}),
        ...(Array.isArray(parsed.bundleRefs) ? { bundleRefs: parsed.bundleRefs } : {}),
        ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      };
    } catch {
      return null;
    }
  }

  /** History is chronological and best-effort; rollback walks newest first. */
  async appendHistory(slug: string, entry: ArtifactStoreHistoryEntry): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const dir = resolve(this.cacheRoot, safeSlug);
      await mkdir(dir, { recursive: true });
      const entries = await this.readHistory(safeSlug);
      entries.push(entry);
      await writeFileAtomicAtPath(this.historyPath(safeSlug), `${JSON.stringify({ entries }, null, 2)}\n`);
    } catch (err) {
      log.warn(
        `appendHistory failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  async readHistory(slug: string): Promise<ArtifactStoreHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(slug), "utf-8");
      const parsed = JSON.parse(raw) as { entries?: ArtifactStoreHistoryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  /** Rollback skips the current version and unusable snapshots; malformed history versions are never replayable. */
  async findRollbackTarget(
    slug: string,
    currentVersion?: string,
  ): Promise<string | null> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const entries = await this.readHistory(safeSlug);
    if (entries.length === 0) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].version;
      if (!candidate || typeof candidate !== "string" || candidate.trim().length === 0) continue;
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, safeSlug, candidate, "plugin.json");
      try {
        const raw = await readFile(cachedManifest, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (!parsed.version) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private historyPath(slug: string): string {
    return resolve(this.cacheRoot, assertSafeArtifactSlug(slug), "history.json");
  }

  /** Only payload-only predecessors may be deleted immediately; leftover runtime directories require tombstoning. */
  private async removeCommittedBackup(path: string): Promise<void> {
    await assertPayloadOnlyPluginTree(path);
    await rm(path, { recursive: true, force: true });
  }

  /** Extraction stages are payload-only and granted to no confined process. */
  private async removeAbandonedStage(path: string): Promise<void> {
    await assertPayloadOnlyPluginTree(path);
    await rm(path, { recursive: true, force: true });
  }
}
