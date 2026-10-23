



import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import type { PermissionRule } from "./permission-manager.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError } from "../lib/atomic-file.js";
import { PermissionRulesFileCorruptError, inertRulePatterns, invalidJsonDetail, validateRuleList } from "./rules/rule-files.js";



/** Location shared by the rules writer and sandbox write protection. */
export function permissionsFilePath(): string {
  return resolve(aveHome(), "permissions.json");
}

export interface PermissionsFile {
  version: 1;
  rules: PermissionRule[];
  mode: ExecutionMode;
  updatedAt: string;
}

// ─── in-process async mutex ──────────────

const permissionsLocks = new Map<string, Promise<void>>();

async function withPermissionsLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = permissionsLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());

  permissionsLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read ────────────────────────────────────────────

/**
 * Read Store A. Missing or empty (lock placeholder) → `null`.
 *
 * Corrupt content throws {@link PermissionRulesFileCorruptError} (issue #28):
 * it used to read as `null`, after which the next write replaced the file with
 * an empty rule list — every saved deny and allow silently lost. Because
 * {@link updatePermissionsFile} reads first, a corrupt file is now never
 * overwritten either.
 */
export async function readPermissionsFile(filePath: string): Promise<PermissionsFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PermissionRulesFileCorruptError(filePath, invalidJsonDetail(error, raw));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PermissionRulesFileCorruptError(filePath, "not an object");
  }
  const file = parsed as PermissionsFile;
  if (file.version !== 1) throw new PermissionRulesFileCorruptError(filePath, `unsupported version ${String(file.version)}`);
  file.rules = validateRuleList(filePath, file.rules, { sourceText: raw, keepNotAllowlisted: "all" });
  return file;
}

// ─── Write (atomic read-modify-write under lock) ─────

export async function updatePermissionsFile(
  filePath: string,
  mutator: (file: PermissionsFile) => void | Promise<void>,
): Promise<void> {
  await withPermissionsLock(filePath, async () => {
    await withFileLock(filePath, async () => {
      const existing = await readPermissionsFile(filePath);
      const file: PermissionsFile = existing ?? {
        version: 1,
        rules: [],
        mode: "default",
        updatedAt: new Date().toISOString(),
      };
      const inert = inertRulePatterns(existing?.rules);
      await mutator(file);
      validateRuleList(filePath, file.rules, { keepNotAllowlisted: inert });
      file.updatedAt = new Date().toISOString();
      writeUtf8FileAtomicSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
    });
  });
}
