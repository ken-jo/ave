/**
 * Host-secret grants (design §10.3): tier 3 of the secret gate
 * (`secret-gate.ts`). The app, not any marketplace, decides which plugin may
 * read which host secret beyond its own namespace; adding a plugin or a key
 * takes an app release.
 *
 * A grant applies only when the table lists the plugin and key and:
 *   1. the registry entry's origin is the official source;
 *   2. the running manifest's canonical sha256 equals the one recorded at
 *      install;
 *   3. the installed artifact is the one the official snapshot pins for that
 *      version: `origin.artifactSha256` (a `legacy` entry: its verified
 *      receipt's `artifactSha256`) equals the version's release or archive
 *      pin. A tree install never qualifies, since no one published those
 *      bytes as an artifact.
 *
 * The gate's tiers 2 and 4 add the rest of §10.3 condition 4: the key is in
 * the manifest's `hostSecrets.read` and names the active vendor.
 *
 * Being a default or required install gives no grant; only this table does.
 */
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

/**
 * What condition 3 reads from disk. Asked only after every cheaper condition
 * holds, so a plugin outside the table never causes a read.
 */
export interface HostSecretGrantEvidence {
  /** Every sha256 the official snapshot pins for `plugin@version`; empty when it lists none or has not synced. */
  officialPins(plugin: string, version: string): Promise<readonly string[]>;
  /** `artifactSha256` of the plugin's verified install receipt; null when there is none or it does not verify. */
  receiptArtifactSha256(): Promise<string | null>;
}

export interface HostSecretGrantInput {
  pluginId: string;
  key: string;
  /** The host-owned registry entry; undefined when the plugin has none. */
  entry: Pick<PluginRegistryEntry, "origin" | "manifestSha256"> | undefined;
  /** Canonical sha256 of the manifest that is running now. */
  runningManifestSha256: string;
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
  if (!recorded || recorded.toLowerCase() !== input.runningManifestSha256.toLowerCase()) {
    return { granted: false, reason: "manifest-sha-mismatch" };
  }
  let installed: string | null;
  let pins: readonly string[];
  try {
    installed = origin.rung === "legacy" ? await input.evidence.receiptArtifactSha256() : origin.artifactSha256;
    pins = await input.evidence.officialPins(input.pluginId, origin.version);
  } catch (error) {
    // Refused, not granted: a grant needs its evidence, and the next read tries again.
    log.error({ pluginId: input.pluginId, err: errorMessage(error) }, "host-secret grant evidence could not be read");
    return { granted: false, reason: "evidence-unreadable" };
  }
  if (!installed || !pins.some((pin) => pin.toLowerCase() === installed.toLowerCase())) {
    return { granted: false, reason: "artifact-not-pinned" };
  }
  return { granted: true };
}
