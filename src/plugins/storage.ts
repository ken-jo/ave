/** Storage operates in host-only storage/, outside confined child writes; every disk operation rechecks canonical containment. */
import type { SecretEncryption } from "../data/secret-document-store.js";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isPathWithin,
  PluginDataRootError,
  resolvePluginDataRoot,
  resolvePluginStoragePath,
  type PluginStorageRejectionLog,
} from "./plugin-storage-containment.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
  type PluginStorage,
} from "./types.js";
import { instrumentEffectsByPath } from "../permissions/hostapi-effect-recorder.js";
import { isMissingPathError } from "../lib/atomic-file.js";

// Create directories as 0o700 and files as 0o600; chmod at first creation because later writes preserve mode.
const PLUGIN_DIR_MODE = 0o700;
const PLUGIN_FILE_MODE = 0o600;

export type { PluginStorageRejectionLog };

/** Storage rejection audit sinks always write warn-level records through a narrowed transport. */
export type PluginStorageAuditLog = (
  level: "error",
  event: string,
  data: Record<string, unknown>,
) => void;

/** Share one rejection record across every production storage wiring; audit failure must not alter refusal. */
export function createPluginStorageAuditSink(
  pluginId: string,
  auditLog: PluginStorageAuditLog,
): PluginStorageRejectionLog {
  return (message, meta) => {
    try {
      auditLog("error", "plugin_storage_path_rejected", {
        // Write authoritative fields last so metadata cannot override plugin identity or reason.
        ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
        pluginId,
        reason: message,
      });
    } catch {
      /* audit must never break the refusal it is reporting */
    }
  };
}

/** Classify a missing pinned root consistently at construction and use; refuse root links before canonicalization. */
function canonicaliseStorageRoot(
  pluginId: string,
  storageDir: string,
  log?: PluginStorageRejectionLog,
): string {
  try {
    return resolvePluginDataRoot(`plugin '${pluginId}'`, storageDir);
  } catch (err) {
    if (err instanceof PluginDataRootError) {
      log?.(`storage: rejected a storage root that is not the host's directory`, {
        target: storageDir,
        root: storageDir,
        found: err.found,
      });
      throw new PluginStorageError(
        `plugin storage root is a ${err.found === "symlink" ? "symlink" : "non-directory"}, not the directory the host `
          + "created — refusing to follow it",
        pluginId,
        storageDir,
      );
    }
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    log?.(`storage: rejected operation against an absent storage root`, {
      target: storageDir,
      root: storageDir,
    });
    throw new PluginStorageError(
      "plugin storage root is absent — refusing to recreate it",
      pluginId,
      storageDir,
    );
  }
}

/** Pin the host-created root at construction and audit every guarded refusal; only isolated tests omit a sink. */
export function createPluginStorage(
  pluginId: string,
  storageDir: string,
  encryption: SecretEncryption,
  log?: PluginStorageRejectionLog,
): PluginStorage {
  // Canonicalize once synchronously; per-operation ancestor checks run asynchronously.
  const canonicalRoot = canonicaliseStorageRoot(pluginId, storageDir, log);

  /** Find the nearest existing ancestor and prove canonical containment using asynchronous filesystem checks. */
  async function realpathContainmentCheck(target: string): Promise<void> {
    let probe = target;
    // If the root itself is mid-move, classify unavailable storage rather than report a nonexistent escape.
    let storageRootAbsent = false;
    // Stop at the lexical or filesystem root and bound the climb.
    for (let depth = 0; depth < 4096; depth++) {
      try {
        const real = await realpath(probe);
        if (!isPathWithin(canonicalRoot, real)) {
          if (storageRootAbsent) {
            log?.(`storage: rejected operation against an absent storage root`, {
              target,
              root: canonicalRoot,
            });
            throw new PluginStorageError(
              "plugin storage root is absent — refusing to recreate it",
              pluginId,
              target,
            );
          }
          log?.(`storage: rejected symlink escape`, { target, probe, real });
          throw new PluginStorageError("symlink escapes plugin storage root", pluginId, target);
        }
        return;
      } catch (err) {
        if (err instanceof PluginStorageError) throw err;
        if (isMissingPathError(err)) {
          // Missing entries may climb; dangling links must fail closed because their future targets cannot be verified.
          try {
            const stats = await lstat(probe);
            if (stats.isSymbolicLink()) {
              log?.(`storage: rejected dangling symlink`, { target, probe });
              throw new PluginStorageError(
                "dangling symlink rejected (target unverifiable)",
                pluginId,
                target,
              );
            }
            // For nondirectory ancestors, climb until a directory can be canonicalized.
          } catch (lstatErr) {
            if (lstatErr instanceof PluginStorageError) throw lstatErr;
            if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
          }
          if (probe === canonicalRoot) storageRootAbsent = true;
          const parent = dirname(probe);
          if (parent === probe) {
            // No existing ancestor leaves only the already-proven lexical containment.
            return;
          }
          probe = parent;
          continue;
        }
        throw err;
      }
    }
    // Exhausting the ancestor bound must refuse.
    throw new PluginStorageError(
      "containment check exceeded max depth (4096) without resolving",
      pluginId,
      target,
    );
  }

  async function guard(rel: string): Promise<string> {
    const target = resolvePluginStoragePath(pluginId, canonicalRoot, [rel], log);
    // After lexical containment, validate existing ancestors so links cannot escape.
    await realpathContainmentCheck(target);
    return target;
  }

  async function ensureParent(absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true, mode: PLUGIN_DIR_MODE });
  }

  // Instrument storage effects at the shared HostApi factory boundary so UI and future methods receive the same ledger coverage.
  const raw: PluginStorage = {
    // resolve is lexical and synchronous; the following async operation must rerun full canonical guards.
    resolve: (...segments) => resolvePluginStoragePath(pluginId, canonicalRoot, segments, log),

    async read(rel) {
      const target = await guard(rel);
      return readFile(target);
    },

    async readText(rel, encoding = "utf-8") {
      const target = await guard(rel);
      return readFile(target, encoding);
    },

    async readJson<T = unknown>(rel: string): Promise<T | null> {
      const target = await guard(rel);
      try {
        const text = await readFile(target, "utf-8");
        return JSON.parse(text) as T;
      } catch (err) {
        if (isMissingPathError(err)) return null;
        throw err;
      }
    },

    async write(rel, data, encoding) {
      const target = await guard(rel);
      await ensureParent(target);
      if (typeof data === "string") {
        await writeFile(target, data, { encoding: encoding ?? "utf-8", mode: PLUGIN_FILE_MODE });
      } else {
        await writeFile(target, data, { mode: PLUGIN_FILE_MODE });
      }
    },

    async writeJson<T>(rel: string, value: T, indent = 2): Promise<void> {
      const target = await guard(rel);
      await ensureParent(target);
      await writeFile(target, JSON.stringify(value, null, indent), {
        encoding: "utf-8",
        mode: PLUGIN_FILE_MODE,
      });
    },

    async rm(rel, options) {
      const target = await guard(rel);
      // Recursive walks require the host-only root so no confined child can swap links midwalk.
      await rm(target, { recursive: options?.recursive ?? false, force: true });
    },

    async list(rel = ".") {
      const target = await guard(rel);
      try {
        return await readdir(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },

    async exists(rel) {
      const target = await guard(rel);
      try {
        await stat(target);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },

    async mkdir(rel) {
      const target = await guard(rel);
      await mkdir(target, { recursive: true, mode: PLUGIN_DIR_MODE });
    },

    // Require encryption before writes and use the same containment guard for ciphertext as plaintext.
    async writeEncrypted(rel, plaintext) {
      if (typeof plaintext !== "string") {
        throw new PluginStorageError(
          "writeEncrypted requires string plaintext",
          pluginId,
          String(rel),
        );
      }
      const target = await guard(rel);
      if (!encryption.isEncryptionAvailable()) {
        throw new PluginStorageEncryptionUnavailableError(pluginId);
      }
      if (encryption.getSelectedStorageBackend() === "external_key") {
        let existing: Buffer | undefined;
        try { existing = await readFile(target); } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
        if (existing !== undefined) encryption.decryptString(existing);
      }
      const ciphertext = encryption.encryptString(plaintext);
      await ensureParent(target);
      // Secret ciphertext also requires owner-only mode.
      await writeFile(target, ciphertext, { mode: PLUGIN_FILE_MODE });
    },

    async readEncrypted(rel) {
      const target = await guard(rel);
      if (!encryption.isEncryptionAvailable()) {
        throw new PluginStorageEncryptionUnavailableError(pluginId);
      }
      // Read raw ciphertext and preserve missing-file ENOENT behavior.
      const ciphertext = await readFile(target);
      return encryption.decryptString(Buffer.from(ciphertext));
    },
  };
  return instrumentEffectsByPath(raw, "storage");
}
