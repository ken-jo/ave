import { createHash } from "node:crypto";
import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import type { PluginHookOwner } from "./hook-registry.js";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";
import { resolveBundledArgv } from "../plugins/resolve-bundled-argv.js";
import {
  PluginContributionTrustStore,
  type PluginContributionTrustRecord,
  type ProjectionTrust,
} from "../plugins/plugin-contribution-trust.js";

export interface PreparedPluginHookProjection {
  owner: PluginHookOwner;
  entries: readonly HookConfigEntry[];
  confinement: { kind: "bundled"; pluginId: string; dataDir: string; generationRoot: string };
  /** What an approval of this hook covers (design §18.7.3); null when it cannot be determined. */
  approvalDigest: string | null;
}

/**
 * Exact-generation trust records. A record names one generation; a new
 * generation's hook is approved explicitly or carried forward by its
 * approval digest (design §18.7.3).
 */
export class PluginHookTrustStore implements ProjectionTrust<PreparedPluginHookProjection> {
  private readonly store: PluginContributionTrustStore;

  constructor(path?: string) {
    this.store = new PluginContributionTrustStore("hook", path);
  }

  approve(projection: PreparedPluginHookProjection, carriedFrom?: string): void {
    this.store.approve(projection.owner, projection.approvalDigest, carriedFrom);
  }

  isApproved(projection: PreparedPluginHookProjection): boolean {
    return this.store.isApproved(projection.owner);
  }

  record(projection: PreparedPluginHookProjection): Readonly<PluginContributionTrustRecord> | undefined {
    return this.store.record(projection.owner);
  }

  /** Give an approval of this exact generation the digest of its running bytes, when it has none (version-2 migration). */
  recordDigest(projection: PreparedPluginHookProjection): void {
    this.store.recordDigest(projection.owner, projection.approvalDigest);
  }

  revoke(projection: PreparedPluginHookProjection): void {
    this.store.revoke(projection.owner);
  }
}

/** Parse/fingerprint-only preparation. It performs no spawn or hook registration. */
export function preparePluginHookGeneration(
  generation: ActivePluginGeneration,
  payloadRoot: string,
  dataDir: string,
  /** Each hook's approval digest, by local id (`extensionComponentDigests`). */
  approvalDigests: ReadonlyMap<string, string | null>,
): readonly PreparedPluginHookProjection[] {
  const projections: PreparedPluginHookProjection[] = [];
  for (const contribution of generation.contributions) {
    if (contribution.kind !== "hook") continue;
    if (contribution.files.length !== 1) {
      throw new Error(`plugin Hook '${contribution.localId}' must materialize exactly one config file`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contribution.files[0].content) as unknown;
    } catch (error) {
      throw new Error(`plugin Hook '${contribution.localId}' is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = parseHookConfig(raw, { bundled: true });
    if (parsed.errors.length > 0 || parsed.warnings.length > 0) {
      throw new Error(`plugin Hook '${contribution.localId}' is invalid: ${[...parsed.errors, ...parsed.warnings].join("; ")}`);
    }
    const anchoredEntries: HookConfigEntry[] = [];
    const commandFingerprints: string[] = [];
    for (const entry of parsed.entries) {
      const envEntries = Object.entries(entry.env ?? {});
      const resolved = resolveBundledArgv({
        generationRoot: payloadRoot,
        dataDir,
        argv: [...entry.command, ...envEntries.map(([, value]) => value)],
        baseFingerprint: contribution.fingerprint,
        label: `plugin Hook '${contribution.localId}'`,
        policy: "hook",
      });
      commandFingerprints.push(resolved.fingerprint);
      anchoredEntries.push(Object.freeze({ ...entry, command: [...resolved.argv.slice(0, entry.command.length)],
        ...(entry.env ? { env: Object.fromEntries(envEntries.map(([key], index) => [key, resolved.argv[entry.command.length + index]!])) } : {}),
      }));
    }
    const owner: PluginHookOwner = Object.freeze({
      pluginId: generation.pluginId,
      pluginVersion: generation.pluginVersion,
      activationId: generation.generationId,
      generationId: generation.artifactGenerationId,
      localId: contribution.localId,
      fingerprint: commandFingerprints.length === 0
        ? contribution.fingerprint
        : createHash("sha256").update(commandFingerprints.sort().join("\0")).digest("hex"),
    });
    if (!approvalDigests.has(contribution.localId)) throw new Error(`plugin Hook '${contribution.localId}' has no approval digest`);
    projections.push(Object.freeze({ owner, entries: Object.freeze(anchoredEntries),
      confinement: Object.freeze({ kind: "bundled", pluginId: generation.pluginId, dataDir, generationRoot: payloadRoot }),
      approvalDigest: approvalDigests.get(contribution.localId)!,
    }));
  }
  return Object.freeze(projections);
}
