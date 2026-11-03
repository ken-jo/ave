

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aveHome, AveHomeConfigurationRefusedWriteError, isInRefusedAveHome } from "../shared/ave-home.js";
import type { PermissionRule } from "./permission-manager.js";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "../shared/permission-mode.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, replaceUtf8FileAtomicSyncIf, isMissingPathError } from "../lib/atomic-file.js";
import { PermissionRulesFileCorruptError, inertRulePatterns, invalidJsonDetail, readUnverifiedStoreText, unverifiedDenyRules, validateRuleList } from "./rules/rule-files.js";
import { withShellPolicyMutation } from "./shell-policy-handoff.js";

import { refreshApprovalPersistence, type ApprovalPersistenceGuard } from "./approval-persistence-guard.js";

// Location shared by the rules writer and sandbox write protection.
export function permissionsFilePath(): string {
  return resolve(aveHome(), "permissions.json");
}

export interface PermissionsFile {
  version: 1;
  rules: PermissionRule[];
  mode: ExecutionMode;
  updatedAt: string;
}

// in-process async mutex

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

// Read

// Missing or empty lock placeholders return null; corrupt data throws so read-before-write cannot erase saved rules.
// In a home refused at boot the file is unverified, so it reads as absent apart from its deny rules (R2 restriction overlay).
export async function readPermissionsFile(filePath: string): Promise<PermissionsFile | null> {
  if (isInRefusedAveHome(filePath)) return readUnverifiedPermissionsFile(filePath);
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
  file.rules = validateRuleList(filePath, file.rules, { sourceText: raw, keepInertWildcards: "all" });
  return file;
}

// The overlay view of an unverified file: its deny rules and nothing else. The mode is the default, and bytes that do not
// parse read as absent instead of a corrupt store, so planted content can neither widen authority nor stop the boot.
async function readUnverifiedPermissionsFile(filePath: string): Promise<PermissionsFile | null> {
  const raw = readUnverifiedStoreText(filePath);
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rules = unverifiedDenyRules(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { rules?: unknown }).rules : undefined);
  return rules.length === 0 ? null : { version: 1, rules, mode: DEFAULT_EXECUTION_MODE, updatedAt: "" };
}

// Write (atomic read-modify-write under lock)

export async function updatePermissionsFile(
  filePath: string,
  mutator: (file: PermissionsFile) => void | Promise<void>,
  authority?: ApprovalPersistenceGuard,
): Promise<void> {
  // The store reads as absent in a refused home; rewriting it from that view would erase the user's file.
  if (isInRefusedAveHome(filePath)) throw new AveHomeConfigurationRefusedWriteError(filePath);
  // Probe before the global policy queue and cross-process lock; inside them only the synchronous fence below guards the commit.
  await refreshApprovalPersistence(authority);
  await withShellPolicyMutation(() => withPermissionsLock(filePath, async () => {
    await withFileLock(filePath, async () => {
      const existing = await readPermissionsFile(filePath);
      const file: PermissionsFile = existing ?? {
        version: 1,
        rules: [],
        mode: DEFAULT_EXECUTION_MODE,
        updatedAt: new Date().toISOString(),
      };
      const inert = inertRulePatterns(existing?.rules);
      await mutator(file);
      validateRuleList(filePath, file.rules, { keepInertWildcards: inert });
      file.updatedAt = new Date().toISOString();
      if (authority) {
        if (!replaceUtf8FileAtomicSyncIf(filePath, `${JSON.stringify(file, null, 2)}\n`, authority.isCurrent)) throw new Error("Approval authority is unavailable");
      } else {
        writeUtf8FileAtomicSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
      }
    });
  }));
}
