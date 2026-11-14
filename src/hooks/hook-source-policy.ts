import { isAdminPolicyFileAbsent, readAdminPolicyFile } from "../lib/admin-policy-file.js";
import { getAdminPolicyPath } from "../permissions/policy-store.js";
import { parsePolicyDocument } from "../shared/configuration-document.js";
import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import { bindHookConfigPaths, hashHookConfigDefinition, loadHookConfig } from "./hook-config-trust.js";
import { dirname } from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("hook-source-policy");

export type HookSourceKind = "user" | "system" | "project" | "managed";

export interface HookRuntimePolicy {
  allowManagedHooksOnly: boolean;
  allowedHttpHookUrls: string[];
  httpHookAllowedEnvVars: string[];
  managedHooks: HookConfigEntry[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

/** Only the administrator policy path can supply managed authority or network exceptions. */
export async function loadHookRuntimePolicy(adminPath = getAdminPolicyPath()): Promise<HookRuntimePolicy> {
  const closed: HookRuntimePolicy = {
    allowManagedHooksOnly: true, allowedHttpHookUrls: [], httpHookAllowedEnvVars: [], managedHooks: [],
  };
  let bytes: Buffer;
  try {
    bytes = await readAdminPolicyFile(adminPath);
  } catch (error) {
    return await isAdminPolicyFileAbsent(adminPath, error) ? { ...closed, allowManagedHooksOnly: false } : closed;
  }
  let raw: Record<string, unknown>;
  try { raw = parsePolicyDocument(bytes.toString("utf8")); }
  catch { return closed; }
  const parsed = parseHookConfig({ hooks: raw.hooks });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
    log.warn("Managed hook configuration is invalid; non-managed hooks are disabled");
    return closed;
  }
  try { bindHookConfigPaths(parsed.entries, dirname(adminPath)); }
  catch { return closed; }
  const { trustHash: policyHash, errors, fileDependencies } = hashHookConfigDefinition(bytes, parsed.entries);
  if (errors.length > 0) {
    log.warn("Managed hook configuration has unreadable script anchors; hooks are disabled");
    return closed;
  }
  return {
    allowManagedHooksOnly: raw.allowManagedHooksOnly === undefined ? false : raw.allowManagedHooksOnly !== false,
    allowedHttpHookUrls: stringList(raw.allowedHttpHookUrls),
    httpHookAllowedEnvVars: stringList(raw.httpHookAllowedEnvVars).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
    managedHooks: parsed.entries.map((entry) => ({ ...entry, hookSource: "managed", configPath: adminPath, reviewedHash: policyHash,
      fileDependencies: fileDependencies.get(entry.id),
      validateTrust: () => {
        try {
          const current = loadHookConfig(adminPath);
          return current.errors.length === 0 && current.trustHash === policyHash;
        }
        catch { return false; }
      },
    })),
  };
}
