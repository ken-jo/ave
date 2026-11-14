import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import { hashHookCommandFiles } from "./hook-config-trust.js";
import { isResolvedPathWithin } from "../plugins/plugin-storage-containment.js";
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
  // What an approval of this hook covers; null when it cannot be determined.
  approvalDigest: string | null;
}

// Exact-generation trust records. A record names one generation; a new generation's hook is approved explicitly or carried forward by its approval digest.
export class PluginHookTrustStore implements ProjectionTrust<PreparedPluginHookProjection> {
  private readonly store: PluginContributionTrustStore;

  constructor(path?: string) {
    this.store = new PluginContributionTrustStore("hook", path);
  }

  approve(projection: PreparedPluginHookProjection, carriedFrom?: string): void {
    if (!this.definitionCurrent(projection)) throw new Error("Hook definition changed before approval");
    this.store.approve(projection.owner, projection.approvalDigest, carriedFrom);
  }

  isApproved(projection: PreparedPluginHookProjection): boolean {
    return this.definitionCurrent(projection) && this.store.isApproved(projection.owner);
  }

  record(projection: PreparedPluginHookProjection): Readonly<PluginContributionTrustRecord> | undefined {
    return this.definitionCurrent(projection) ? this.store.record(projection.owner) : undefined;
  }

  // Give an approval of this exact generation the digest of its running bytes, when it has none (version-2 migration).
  recordDigest(projection: PreparedPluginHookProjection): void {
    this.store.recordDigest(projection.owner, projection.approvalDigest);
  }

  revoke(projection: PreparedPluginHookProjection): void {
    this.store.revoke(projection.owner);
  }

  private definitionCurrent(projection: PreparedPluginHookProjection): boolean {
    let current = false;
    try {
      current = projection.entries.every((entry) => entry.validateTrust === undefined || entry.validateTrust() === true);
    } catch {
      // A failed revalidation never preserves a recorded approval.
    }
    if (!current) this.revoke(projection);
    return current;
  }
}

// Parse/fingerprint-only preparation. It performs no spawn or hook registration.
export function preparePluginHookGeneration(
  generation: ActivePluginGeneration,
  payloadRoot: string,
  dataDir: string,
  // Each hook's approval digest, by local id (`extensionComponentDigests`).
  approvalDigests: ReadonlyMap<string, string | null>,
): readonly PreparedPluginHookProjection[] {
  const projections: PreparedPluginHookProjection[] = [];
  for (const contribution of generation.contributions) {
    if (contribution.kind !== "hook") continue;
    if (contribution.files.length !== 1) {
      throw new Error(`plugin Hook '${contribution.localId}' must materialize exactly one config file`);
    }
    const configDir = realpathSync(dirname(resolve(payloadRoot, contribution.files[0].path)));
    if (!isResolvedPathWithin(realpathSync(payloadRoot), configDir)) {
      throw new Error(`plugin Hook '${contribution.localId}' configuration directory escapes its generation`);
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
      if (entry.handlerType === "http") {
        commandFingerprints.push(createHash("sha256").update(contribution.fingerprint).update(JSON.stringify(entry.http)).digest("hex"));
        anchoredEntries.push(Object.freeze({ ...entry, configDir }));
        continue;
      }
      const envEntries = Object.entries(entry.env ?? {});
      const resolved = resolveBundledArgv({
        generationRoot: payloadRoot,
        dataDir,
        argv: [...entry.command, ...envEntries.map(([, value]) => value)],
        baseFingerprint: contribution.fingerprint,
        label: `plugin Hook '${contribution.localId}'`,
        policy: "hook",
      });
      const command = [...resolved.argv.slice(0, entry.command.length)];
      Object.freeze(command);
      const checked = hashHookCommandFiles(command, configDir);
      if (checked.errors.length > 0) throw new Error(`plugin Hook '${contribution.localId}' has unreadable command files`);
      commandFingerprints.push(createHash("sha256").update(resolved.fingerprint).update(checked.hash).digest("hex"));
      anchoredEntries.push(Object.freeze({ ...entry, command, configDir, fileDependencies: Object.freeze(checked.files),
        validateTrust: () => {
          const current = hashHookCommandFiles(command, configDir);
          return current.errors.length === 0 && current.hash === checked.hash;
        },
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
    const approvalDigest = approvalDigests.get(contribution.localId);
    if (approvalDigest === undefined) throw new Error(`plugin Hook '${contribution.localId}' has no approval digest`);
    projections.push(Object.freeze({ owner, entries: Object.freeze(anchoredEntries.map((entry) => Object.freeze({ ...entry, reviewedHash: owner.fingerprint }))),
      confinement: Object.freeze({ kind: "bundled", pluginId: generation.pluginId, dataDir, generationRoot: payloadRoot }),
      approvalDigest: approvalDigest === null ? null : createHash("sha256").update(approvalDigest).update(owner.fingerprint).digest("hex"),
    }));
  }
  return Object.freeze(projections);
}
