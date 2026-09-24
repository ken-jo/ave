/**
 * Host-secret grants (design §10.3). The app, not any marketplace, decides
 * which plugin may read which host secret beyond its own namespace; adding a
 * plugin or a key takes an app release.
 *
 * A grant applies only when all four hold:
 *   1. the registry entry's origin is the official source;
 *   2. the installed artifact is the one the official snapshot pins for that
 *      version: `origin.artifactSha256` (a `legacy` entry: its receipt's
 *      `artifactSha256`) equals the version's release or archive pin. A tree
 *      install never qualifies, since no one published those bytes as an
 *      artifact;
 *   3. the running manifest's canonical sha256 equals the one recorded at
 *      install;
 *   4. the key is in the manifest's `hostSecrets.read` and names the active
 *      vendor.
 *
 * Being a default or required install gives no grant; only this table does.
 */
import type { PluginRegistryEntry } from "../types.js";

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

export interface HostSecretGrantInput {
  pluginId: string;
  key: string;
  entry: Pick<PluginRegistryEntry, "origin" | "manifestSha256">;
  /** Canonical sha256 of the manifest that is running now. */
  runningManifestSha256: string;
  /** `artifactSha256` of the install receipt; read for a `legacy` origin only. */
  receiptArtifactSha256: string | null;
  /** Every sha256 the official snapshot pins for the installed version (release, archive); empty when it lists none. */
  officialPins: readonly string[];
  /** `hostSecrets.read` of the running manifest. */
  allowlist: readonly string[];
  /** `settings.llm.provider`. */
  activeProvider: string;
}

export type HostSecretGrantVerdict =
  | { granted: true }
  | {
      granted: false;
      reason:
        | "not-in-grant-table"
        | "not-official"
        | "tree-install"
        | "artifact-not-pinned"
        | "manifest-sha-mismatch"
        | "not-allowlisted"
        | "vendor-mismatch";
    };

function hostSecretGrantFor(pluginId: string, key: string): boolean {
  return HOST_SECRET_GRANTS.some((grant) => grant.plugin === pluginId && grant.keys.includes(key));
}

export function evaluateHostSecretGrant(input: HostSecretGrantInput): HostSecretGrantVerdict {
  if (!hostSecretGrantFor(input.pluginId, input.key)) return { granted: false, reason: "not-in-grant-table" };
  const origin = input.entry.origin;
  if (!origin || origin.sourceOrigin !== "official" || origin.sourceId !== OFFICIAL_SOURCE_ID) {
    return { granted: false, reason: "not-official" };
  }
  if (origin.rung === "tree") return { granted: false, reason: "tree-install" };
  const installed = origin.rung === "legacy" ? input.receiptArtifactSha256 : origin.artifactSha256;
  if (!installed || !input.officialPins.some((pin) => pin.toLowerCase() === installed.toLowerCase())) {
    return { granted: false, reason: "artifact-not-pinned" };
  }
  if (!input.entry.manifestSha256 || input.entry.manifestSha256 !== input.runningManifestSha256) {
    return { granted: false, reason: "manifest-sha-mismatch" };
  }
  if (!input.allowlist.includes(input.key)) return { granted: false, reason: "not-allowlisted" };
  if (input.key !== `llm.apiKey.${input.activeProvider}`) return { granted: false, reason: "vendor-mismatch" };
  return { granted: true };
}
