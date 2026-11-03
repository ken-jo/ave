

import { resolve } from "node:path";
import { aveHome, AveHomeConfigurationRefusedWriteError, isInRefusedAveHome } from "../shared/ave-home.js";
import type { PermissionRule } from "./permission-manager.js";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "../shared/permission-mode.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, replaceUtf8FileAtomicSyncIf } from "../lib/atomic-file.js";
import { PermissionRulesFileCorruptError, inertRulePatterns, invalidJsonDetail, unverifiedDenyRules, validateRuleList } from "./rules/rule-files.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
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
// The same holds while the file is pending review in the home content trust manifest: it was changed outside Ave or cannot be vouched for.
export async function readPermissionsFile(filePath: string): Promise<PermissionsFile | null> {
  const input = await readAveHomeInput(filePath);
  if (input.status === "untrusted") return readUnverifiedPermissionsFile(input.bytes);
  if (input.status === "absent") return null;
  const raw = input.bytes.toString("utf-8");
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
function readUnverifiedPermissionsFile(bytes: Buffer): PermissionsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
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
