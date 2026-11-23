import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMissingPathError, writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { readAveHomeInputSync } from "../shared/ave-home-trust.js";
import { getDeclaredAlertKinds, getDeclaredSuggestionSources } from "./runtime/manifest-validation.js";
import type { PluginManifest } from "./types.js";

/** What a plugin may do outside a tool call once approved; each target is already bounded by the host. */
export interface PluginBackgroundEffects {
  /** The plugin's own host storage folder. */
  readonly ownStorage: true;
  readonly networkDestinations: readonly string[];
  readonly alertKinds: readonly string[];
  readonly suggestionSources: readonly string[];
}

const OWN_STORAGE_WRITES = ["storage.write", "storage.writeJson", "storage.rm", "storage.mkdir", "storage.writeEncrypted"] as const;

export function declaredBackgroundEffects(manifest: PluginManifest): PluginBackgroundEffects {
  return {
    ownStorage: true,
    networkDestinations: [...(manifest.networkAccess?.allowedDomains ?? [])],
    alertKinds: getDeclaredAlertKinds(manifest, manifest.id).map((kind) => kind.id),
    suggestionSources: [...(getDeclaredSuggestionSources(manifest, manifest.id) ?? [])],
  };
}

/** Gated paths a standalone effect may take; every other gated path is denied outside a tool call. */
export function backgroundEffectPaths(manifest: PluginManifest): ReadonlySet<string> {
  const effects = declaredBackgroundEffects(manifest);
  return new Set<string>([
    ...OWN_STORAGE_WRITES,
    ...(effects.networkDestinations.length > 0 ? ["hostFetch"] : []),
    ...(effects.alertKinds.length > 0 ? ["raiseAlert"] : []),
    ...(effects.suggestionSources.length > 0 ? ["triggerConversation"] : []),
  ]);
}

export function backgroundEffectApprovalsPath(cacheRoot: string): string {
  return resolve(cacheRoot, "plugin-contribution-trust", "background-effects.json");
}

interface ApprovalsFile {
  version: 1;
  approvals: Array<{ pluginId: string; manifestSha256: string }>;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** One approval per plugin, bound to the manifest document it was given for; a malformed file approves nothing. */
export class PluginBackgroundEffectApprovals {
  private approvals = new Map<string, string>();

  constructor(private readonly path?: string) {
    if (!path) return;
    const input = readAveHomeInputSync(path);
    if (input.status !== "trusted") return;
    try {
      const parsed = JSON.parse(input.bytes.toString("utf8")) as Partial<ApprovalsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.approvals)) return;
      const approvals = new Map<string, string>();
      for (const record of parsed.approvals) {
        if (typeof record?.pluginId !== "string" || !record.pluginId
          || typeof record.manifestSha256 !== "string" || !SHA256.test(record.manifestSha256)) return;
        approvals.set(record.pluginId, record.manifestSha256);
      }
      this.approvals = approvals;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingPathError(error)) throw error;
    }
  }

  isApproved(pluginId: string, manifestSha256: string | null): boolean {
    return manifestSha256 !== null && this.approvals.get(pluginId) === manifestSha256;
  }

  approve(pluginId: string, manifestSha256: string): void {
    if (!pluginId || !SHA256.test(manifestSha256)) throw new Error("A background effect approval needs a plugin and its manifest hash");
    const next = new Map(this.approvals).set(pluginId, manifestSha256);
    this.persist(next);
    this.approvals = next;
  }

  private persist(approvals: ReadonlyMap<string, string>): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: ApprovalsFile = {
      version: 1,
      approvals: [...approvals].map(([pluginId, manifestSha256]) => ({ pluginId, manifestSha256 })),
    };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}
