

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import type { PermissionRule } from "./permission-manager.js";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "../shared/permission-mode.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError } from "../lib/atomic-file.js";
import { PermissionRulesFileCorruptError, inertRulePatterns, invalidJsonDetail, validateRuleList } from "./rules/rule-files.js";
import { withShellPolicyMutation } from "./shell-policy-handoff.js";

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
  file.rules = validateRuleList(filePath, file.rules, { sourceText: raw, keepInertWildcards: "all" });
  return file;
}

// Write (atomic read-modify-write under lock)

export async function updatePermissionsFile(
  filePath: string,
  mutator: (file: PermissionsFile) => void | Promise<void>,
): Promise<void> {
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
      writeUtf8FileAtomicSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
    });
  }));
}
