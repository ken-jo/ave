/** Only explicit app-owned grants authorize host secrets; default or required installs gain no implicit access. */
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";
import type { PluginRegistryEntry } from "../types.js";

const log = createLogger("host-secret-grants");

export interface HostSecretGrant {
  plugin: string;
  keys: readonly string[];
}

const LLM_API_KEYS = [
  "llm.apiKey.openai",
  "llm.apiKey.claude",
  "llm.apiKey.gemini",
  "llm.apiKey.azure-foundry",
  "llm.apiKey.vertex-ai",
] as const;

export const HOST_SECRET_GRANTS: readonly HostSecretGrant[] = Object.freeze([
  Object.freeze({ plugin: "meeting", keys: LLM_API_KEYS }),
  Object.freeze({ plugin: "local-indexer", keys: LLM_API_KEYS }),
]);

const OFFICIAL_SOURCE_ID = "ave";

/** Read artifact evidence only after cheaper grant conditions pass. */
export interface HostSecretGrantEvidence {
  /** Official snapshot pins for this exact plugin/version; empty means no synced pin. */
  officialPins(plugin: string, version: string): Promise<readonly string[]>;
  /** Verified receipt artifact hash, or null without verified evidence. */
  receiptArtifactSha256(): Promise<string | null>;
}

export interface HostSecretGrantInput {
  pluginId: string;
  key: string;
  /** The host-owned registry entry; undefined when the plugin has none. */
  entry: Pick<PluginRegistryEntry, "origin" | "manifestSha256"> | undefined;
  /** Hash the authored plugin document; null never matches a registry pin. */
  runningManifestSha256: string | null;
  evidence: HostSecretGrantEvidence;
}

export type HostSecretGrantDenial =
  | "not-in-grant-table"
  | "not-official"
  | "tree-install"
  | "manifest-sha-mismatch"
  | "artifact-not-pinned"
  | "evidence-unreadable";

export type HostSecretGrantVerdict = { granted: true } | { granted: false; reason: HostSecretGrantDenial };

function hostSecretGrantFor(pluginId: string, key: string): boolean {
  return HOST_SECRET_GRANTS.some((grant) => grant.plugin === pluginId && grant.keys.includes(key));
}

export async function evaluateHostSecretGrant(input: HostSecretGrantInput): Promise<HostSecretGrantVerdict> {
  if (!hostSecretGrantFor(input.pluginId, input.key)) return { granted: false, reason: "not-in-grant-table" };
  const origin = input.entry?.origin;
  if (!origin || origin.sourceOrigin !== "official" || origin.sourceId !== OFFICIAL_SOURCE_ID) {
    return { granted: false, reason: "not-official" };
  }
  if (origin.rung === "tree") return { granted: false, reason: "tree-install" };
  const recorded = input.entry?.manifestSha256;
  if (!recorded || !input.runningManifestSha256 || recorded.toLowerCase() !== input.runningManifestSha256.toLowerCase()) {
    return { granted: false, reason: "manifest-sha-mismatch" };
  }
  let installed: string | null;
  let pins: readonly string[];
  try {
    installed = origin.rung === "legacy" ? await input.evidence.receiptArtifactSha256() : origin.artifactSha256;
    pins = await input.evidence.officialPins(input.pluginId, origin.version);
  } catch (error) {
    // Missing evidence refuses; the next read may retry.
    log.error({ pluginId: input.pluginId, err: errorMessage(error) }, "host-secret grant evidence could not be read");
    return { granted: false, reason: "evidence-unreadable" };
  }
  if (!installed || !pins.some((pin) => pin.toLowerCase() === installed.toLowerCase())) {
    return { granted: false, reason: "artifact-not-pinned" };
  }
  return { granted: true };
}
