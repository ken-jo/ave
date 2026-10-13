/**
 * Whether the model catalog refresh may run (design `model-capability-catalog.md` §7).
 *
 * Kept apart from the refresh itself so the settings surface (over
 * `ave:llm:get-model-catalog`) can report who is deciding without pulling
 * the network path into the IPC layer.
 */
import { readFile } from "node:fs/promises";
import { isAdminPolicyFileAbsent } from "../../lib/admin-policy-file.js";
import { envForcedValueForSettingsPath } from "../../shared/env-backed-settings.js";
import { parseStrictJson } from "../../shared/strict-json.js";

/** The settings key of the switch, as the env-backed registry names it. */
const MODEL_CATALOG_REFRESH_SETTINGS_PATH = "llm.modelCatalogRefresh";

export type ModelCatalogRefreshSetting = "auto" | "off";

/** Why refresh is on or off for this launch. */
export type ModelCatalogRefreshDecision =
  | { enabled: true }
  | { enabled: false; decidedBy: "env" | "policy" | "setting" };

/**
 * The whole rule: a pinned catalog (`AVE_MODEL_CATALOG`) turns refresh off,
 * then an organization policy that says off (or cannot be read), then the
 * user's switch; the default is on (owner decision, 2026-10-12).
 */
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

/**
 * The `modelCatalog` section of the managed policy file: `"off"` when it says
 * `{ "refresh": "off" }`, null when the file or the section is absent.
 *
 * Fails closed: a file or a section that cannot be read exactly as written
 * reads as `"off"` — an administrator who meant to stop the request must not
 * have a typo send it.
 */
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
  // The one valid section is `{ "refresh": "off" }`; any other shape or value
  // is a typo or a value this build does not know, and reads as off.
  return (parsed as Record<string, unknown>).modelCatalog === undefined ? null : "off";
}
