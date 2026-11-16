

import { join, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { isPlainRecord } from "../shared/is-record.js";
import { aveHome, aveHomeConfigurationDirectory, AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";
import { parsePolicyDocument } from "../shared/configuration-document.js";
import { checkAdminPolicyPath } from "../shared/ave-home-test-guard.js";
import type { AdminPolicyDiagnostic, PolicySource } from "../shared/policy-editability.js";
import { DEFAULT_REQUIRE_EXPLICIT_APPROVAL } from "../shared/policy-editability.js";
import { auditAdminPolicyFailure, isAdminPolicyFileAbsent, readAdminPolicyFile } from "../lib/admin-policy-file.js";
import { WindowsPolicyReadError } from "../shared/windows-admin-policy.js";
import { readAveHomeConfigurationFile, readAveHomeRestrictionSource, resolveConfigurationFile, withAveHomeConfigurationWrite } from "../shared/ave-home-configuration-access.js";
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

export type PolicyPatch = Partial<Pick<PolicyFile, "requireExplicitApproval">>;

export class PolicyWriteError extends Error {
  constructor(readonly code: "managed" | "invalid-patch", message: string) {
    super(message);
    this.name = "PolicyWriteError";
  }
}

export function validatePolicyPatch(patch: unknown): PolicyPatch {
  if (!isPlainRecord(patch)
    || Object.keys(patch).some((key) => key !== "requireExplicitApproval")) {
    throw new PolicyWriteError("invalid-patch", "Policy patch contains unsupported fields.");
  }
  const value = patch.requireExplicitApproval;
  if (value !== undefined && typeof value !== "boolean") {
    throw new PolicyWriteError("invalid-patch", "Explicit approval must be a boolean.");
  }
  return value === undefined ? {} : { requireExplicitApproval: value };
}

export interface LoadedPolicy extends PolicyFile, AdminPolicyDiagnostic {
  source: PolicySource;

  adminOverrides?: string[];

  adminPath?: string;
}

function defaultPolicy(): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: DEFAULT_REQUIRE_EXPLICIT_APPROVAL,
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

// The closed restriction overlay of a user policy that reads as absent (a refused home's unverified root file): only the safety
// booleans, and only when they make Ave stricter. Anything else in the file, and a file that does not parse, applies nothing.
function restrictionOverlay(userPath: string): StatedPolicy {
  const bytes = readAveHomeRestrictionSource(userPath);
  if (bytes === undefined) return {};
  let stated: StatedPolicy;
  try { stated = statedPolicy(userPath, parsePolicyDocument(bytes.toString("utf8"))); }
  catch { return {}; }
  const overlay: StatedPolicy = {};
  for (const field of Object.keys(SAFE_BOOLEANS) as Array<keyof typeof SAFE_BOOLEANS>) {
    if (stated[field] === true) overlay[field] = true;
  }
  return overlay;
}

// Load policy. A valid admin file overrides only the fields it states. An invalid or unreadable admin file requires explicit approval and locks edits. Returned `source` field: - "defaults": no file exists, so defaults are used - "user": only the user file exists - "admin": only the admin file exists - "merged": both exist, with admin overriding user values @param userPath User policy file path (default: ~/.ave/config/policy.json) @param adminPath Admin policy file path (default: getAdminPolicyPath)
export async function loadPolicy(
  userPath = userPolicyPath(),
  adminPath = getAdminPolicyPath(),
): Promise<LoadedPolicy> {
  userPath = resolveConfigurationFile(userPath);
  const loaded = await loadPolicySources(userPath, adminPath);
  const overlay = restrictionOverlay(userPath);
  return {
    ...loaded,
    requireExplicitApproval: loaded.requireExplicitApproval || overlay.requireExplicitApproval === true,
    managed: loaded.managed || overlay.managed === true,
  };
}

async function loadPolicySources(userPath: string, adminPath: string): Promise<LoadedPolicy> {
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

// User writes accept only policy preferences. Administrative files, including unreadable files,
// and managed user policies keep editing locked.
export async function savePolicy(
  patch: PolicyPatch,
  userPath = userPolicyPath(),
  adminPath = getAdminPolicyPath(),
): Promise<PolicyFile> {
  const validated = validatePolicyPatch(patch);
  return withAveHomeConfigurationWrite(userPath, async (userPath) => {
    // Check admin-dir first.
    const adminFile = await readPolicyFile(adminPath, true);
    if (adminFile.status !== "absent") {
      throw new PolicyWriteError("managed", "Policy is managed by IT (admin-dir file exists)");
    }

    const userRead = await readPolicyFile(userPath);
    const existing = userRead.status === "valid" ? userRead.fields : null;

    // A user policy marked managed remains read-only.
    if (existing?.managed === true) {
      throw new PolicyWriteError("managed", "Managed policy cannot be changed by the user.");
    }

    const current = existing ? completePolicy(existing) : defaultPolicy();
    const updated: PolicyFile = {
      ...current,
      ...validated,
      version: 1,
      managed: current.managed, // Users cannot change managed.
      updatedAt: new Date().toISOString(),
    };

    writeUtf8FileAtomicSync(userPath, `${JSON.stringify(updated, null, 2)}\n`, 0o600);

    return updated;
  });
}
