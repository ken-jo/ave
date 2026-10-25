/** Keep refresh policy separate so settings can report it without importing network code. */
import { readFile } from "node:fs/promises";
import { isAdminPolicyFileAbsent } from "../../lib/admin-policy-file.js";
import { envForcedValueForSettingsPath } from "../../shared/env-backed-settings.js";
import { parseStrictJson } from "../../shared/strict-json.js";

const MODEL_CATALOG_REFRESH_SETTINGS_PATH = "llm.modelCatalogRefresh";

export type ModelCatalogRefreshSetting = "auto" | "off";

export type ModelCatalogRefreshDecision =
  | { enabled: true }
  | { enabled: false; decidedBy: "env" | "policy" | "setting" };

/** Pins disable refresh, then managed policy, then the user switch; refresh defaults on. */
export function decideModelCatalogRefresh(args: {
  setting: ModelCatalogRefreshSetting | undefined;
  policy: "off" | null;
  env?: NodeJS.ProcessEnv;
}): ModelCatalogRefreshDecision {
  if (envForcedValueForSettingsPath(MODEL_CATALOG_REFRESH_SETTINGS_PATH, args.env) === "off") {
    return { enabled: false, decidedBy: "env" };
  }
  if (args.policy === "off") return { enabled: false, decidedBy: "policy" };
  if (args.setting === "off") return { enabled: false, decidedBy: "setting" };
  return { enabled: true };
}

const POLICY_LIMITS = { maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 200_000, maxObjectMembers: 10_000, maxArrayItems: 50_000 };

/** Absent managed policy permits user choice; unreadable or malformed policy disables refresh. */
export async function readModelCatalogRefreshPolicy(policyPath: string): Promise<"off" | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(policyPath);
  } catch (error) {
    return (await isAdminPolicyFileAbsent(policyPath, error)) ? null : "off";
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, POLICY_LIMITS);
  } catch {
    return "off";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "off";
  return (parsed as Record<string, unknown>).modelCatalog === undefined ? null : "off";
}
