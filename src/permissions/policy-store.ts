

import { join, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";
import { parsePolicyDocument } from "../shared/configuration-document.js";
import { checkAdminPolicyPath } from "../shared/ave-home-test-guard.js";
import type { AdminPolicyDiagnostic, PolicySource } from "../shared/policy-editability.js";
import { auditAdminPolicyFailure, isAdminPolicyFileAbsent, readAdminPolicyFile } from "../lib/admin-policy-file.js";
import { WindowsPolicyReadError } from "../shared/windows-admin-policy.js";
import { readAveHomeConfigurationFile, resolveConfigurationFile, withAveHomeConfigurationWrite } from "../shared/ave-home-configuration-access.js";
const log = createLogger("policy-store");

export const userPolicyPath = (home = aveHome()): string => resolve(aveHomeConfigurationDirectory(home), "policy.json");

export function getAdminPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/Ave/policy.json";
    case "win32": {
      const path = join(process.env.ProgramData ?? "C:\\ProgramData", "Ave", "policy.json");
      checkAdminPolicyPath(path);
      return path;
    }
    case "linux":
      return "/etc/ave/policy.json";
    default:

      return "/nonexistent/ave/policy.json";
  }
}

export interface PolicyFile {
  version: 1;

  requireExplicitApproval: boolean;

  managed: boolean;
  updatedAt: string;
}

export interface LoadedPolicy extends PolicyFile, AdminPolicyDiagnostic {
  source: PolicySource;

  adminOverrides?: string[];

  adminPath?: string;
}

function defaultPolicy(): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
  };
}

// Read (single file)

// The fields a policy file states, each checked; a field the file does not state is absent. The file is written by hand or by device management (the admin file also carries other sections, such as `marketplaces`), so nothing here trusts its shape: a safety field of the wrong type reads as its safe value, never as "off".
interface StatedPolicy {
  requireExplicitApproval?: boolean;
  managed?: boolean;
  updatedAt?: string;
}

type PolicyFileRead =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; fields: StatedPolicy };

// The safe value of each boolean safety field: explicit approval on, edits locked.
const SAFE_BOOLEANS = { requireExplicitApproval: true, managed: true } as const;

function statedPolicy(filePath: string, parsed: Record<string, unknown>): StatedPolicy {
  const stated: StatedPolicy = {};
  for (const field of Object.keys(SAFE_BOOLEANS) as Array<keyof typeof SAFE_BOOLEANS>) {
    const value = parsed[field];
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      stated[field] = value;
    } else {
      log.error(`${field} in ${filePath} is not a boolean — read as ${SAFE_BOOLEANS[field]}`);
      stated[field] = SAFE_BOOLEANS[field];
    }
  }
  if (typeof parsed.updatedAt === "string") stated.updatedAt = parsed.updatedAt;
  return stated;
}

// A whole policy: what the file states over the defaults, so an unstated requireExplicitApproval stays true.
function completePolicy(stated: StatedPolicy): PolicyFile {
  return { ...defaultPolicy(), ...stated, version: 1 };
}

async function readPolicyFile(filePath: string, administrative = false): Promise<PolicyFileRead> {
  const invalid = (cause: string, audit = true): PolicyFileRead => {
    const reason = `invalid policy file at ${filePath}: ${cause}`;
    log.error(reason);
    if (administrative && audit) auditAdminPolicyFailure(reason);
    return { status: "invalid", reason };
  };
  let raw: string;
  try {
    const bytes = administrative ? await readAdminPolicyFile(filePath) : readAveHomeConfigurationFile(filePath);
    if (bytes === undefined) return { status: "absent" };
    raw = bytes.toString("utf8");
  } catch (err: unknown) {
    if (err instanceof AveHomeConfigurationUntrustedError) throw err;
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (await isAdminPolicyFileAbsent(filePath, err)) return { status: "absent" };
    return invalid(err instanceof WindowsPolicyReadError ? err.message : `read failed (${typeof code === "string" ? code : "unknown error"})`, false);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parsePolicyDocument(raw);
  } catch (error) {
    return invalid((error as Error).message);
  }
  return { status: "valid", fields: statedPolicy(filePath, parsed) };
}

// Load policy. A valid admin file overrides only the fields it states. An invalid or unreadable admin file requires explicit approval and locks edits. Returned `source` field: - "defaults": no file exists, so defaults are used - "user": only the user file exists - "admin": only the admin file exists - "merged": both exist, with admin overriding user values @param userPath User policy file path (default: ~/.ave/config/policy.json) @param adminPath Admin policy file path (default: getAdminPolicyPath)
export async function loadPolicy(
  userPath = userPolicyPath(),
  adminPath = getAdminPolicyPath(),
): Promise<LoadedPolicy> {
  userPath = resolveConfigurationFile(userPath);
  const [userRead, adminRead] = await Promise.all([
    readPolicyFile(userPath),
    readPolicyFile(adminPath, true),
  ]);
  const userFile = userRead.status === "valid" ? userRead.fields : null;
  const diagnostic = adminRead.status === "invalid" ? { adminStatus: "invalid" as const, adminReason: adminRead.reason } : {};
  const adminFile: StatedPolicy | null = adminRead.status === "valid"
    ? adminRead.fields
    : adminRead.status === "invalid" ? SAFE_BOOLEANS : null;

  // case 1: neither exists, so use defaults.
  if (!userFile && !adminFile) {
    return { ...defaultPolicy(), source: "defaults" };
  }

  // case 2: only the user file exists.
  if (userFile && !adminFile) {
    return { ...completePolicy(userFile), source: "user" };
  }

  // case 3: only the admin file exists.
  if (!userFile && adminFile) {
    return { ...completePolicy(adminFile), source: "admin", adminPath, ...diagnostic };
  }

  // case 4: both exist, so merge with admin taking precedence over what it states.
  const base = completePolicy(userFile!);
  const overrides: string[] = [];
  const merged = { ...base };

  const adminFields = adminFile!;
  // requireExplicitApproval
  if (adminFields.requireExplicitApproval !== undefined &&
      adminFields.requireExplicitApproval !== base.requireExplicitApproval) {
    merged.requireExplicitApproval = adminFields.requireExplicitApproval;
    overrides.push("requireExplicitApproval");
  }
  // managed: admin true → always true
  if (adminFields.managed === true) {
    merged.managed = true;
    if (!base.managed) overrides.push("managed");
  }
  // updatedAt: use admin's timestamp when merged
  merged.updatedAt = adminFields.updatedAt ?? base.updatedAt;

  return {
    ...merged,
    version: 1,
    source: "merged",
    adminPath,
    adminOverrides: overrides,
    ...diagnostic,
  };
}

// Save policy to disk. Blocking conditions, in priority order: 1. admin-dir file is not absent, including read/validation failure → always throw 2. user file managed: true → throw the localized managed-policy error The managed flag itself cannot be changed via patch; it belongs to the IT Admin API.
export async function savePolicy(
  patch: Partial<Omit<PolicyFile, "version" | "managed" | "updatedAt">>,
  userPath = userPolicyPath(),
  adminPath = getAdminPolicyPath(),
): Promise<PolicyFile> {
  return withAveHomeConfigurationWrite(userPath, async (userPath) => {
    // Check admin-dir first.
    const adminFile = await readPolicyFile(adminPath, true);
    if (adminFile.status !== "absent") {
      throw new Error("Policy is managed by IT (admin-dir file exists)");
    }

    const userRead = await readPolicyFile(userPath);
    const existing = userRead.status === "valid" ? userRead.fields : null;

    // Check user managed: true, preserving the existing B1 behavior.
    if (existing?.managed === true) {
      throw new Error(t("be_policyStore.managedPolicyUserCannotChange"));
    }

    const current = existing ? completePolicy(existing) : defaultPolicy();
    const updated: PolicyFile = {
      ...current,
      ...patch,
      version: 1,
      managed: current.managed, // Users cannot change managed.
      updatedAt: new Date().toISOString(),
    };

    writeUtf8FileAtomicSync(userPath, `${JSON.stringify(updated, null, 2)}\n`, 0o600);

    return updated;
  });
}
