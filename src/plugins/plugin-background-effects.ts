import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { normalizeHost, urlHostMatchesAllowList } from "../main/host-allow-list.js";
import { readAveHomeInputSync } from "../shared/ave-home-trust.js";
import { CAPABILITY_BACKGROUND_CALL_LLM, CAPABILITY_BACKGROUND_SPAWN_WORKER } from "./capabilities.js";
import { getDeclaredAlertKinds, getDeclaredSuggestionSources } from "./runtime/manifest-validation.js";
import type { PluginManifest, PluginRegistryTrust } from "./types.js";

const log = createLogger("plugin-background-effects");

/** What a plugin may do outside a tool call once approved; each target is already bounded by the host. */
export interface PluginBackgroundEffects {
  /** The plugin's own host storage folder. */
  readonly ownStorage: true;
  readonly networkDestinations: readonly string[];
  readonly alertKinds: readonly string[];
  readonly suggestionSources: readonly string[];
  readonly llm: boolean;
  readonly workers: boolean;
}

function canonicalList(values: readonly string[], normalize: (value: string) => string = (value) => value): string[] {
  return [...new Set(values.map(normalize).filter((value) => value.length > 0))].sort();
}

export function declaredBackgroundEffects(manifest: PluginManifest): PluginBackgroundEffects {
  return {
    ownStorage: true,
    networkDestinations: canonicalList(manifest.networkAccess?.allowedDomains ?? [], normalizeHost),
    alertKinds: canonicalList(getDeclaredAlertKinds(manifest, manifest.id).map((kind) => kind.id)),
    suggestionSources: canonicalList(getDeclaredSuggestionSources(manifest, manifest.id) ?? []),
    llm: manifest.capabilities?.includes(CAPABILITY_BACKGROUND_CALL_LLM) === true,
    workers: manifest.capabilities?.includes(CAPABILITY_BACKGROUND_SPAWN_WORKER) === true,
  };
}

/** A plugin that declares nothing beyond its own storage gets no card; it still writes that storage. */
function hasBackgroundEffects(effects: PluginBackgroundEffects): boolean {
  return effects.networkDestinations.length > 0 || effects.alertKinds.length > 0 || effects.suggestionSources.length > 0
    || effects.llm || effects.workers;
}

/** Hashes only the canonical declared set, so a version-only update keeps the approval and a scope change re-asks. */
export function backgroundEffectScopeSha256(effects: PluginBackgroundEffects): string {
  const canonical = {
    v: 1,
    storage: "own",
    network: canonicalList(effects.networkDestinations, normalizeHost),
    alerts: canonicalList(effects.alertKinds),
    suggestions: canonicalList(effects.suggestionSources),
    llm: effects.llm,
    workers: effects.workers,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The install source the host pinned in the registry; commit and version are left out so an update keeps it. */
function backgroundEffectSource(entry: PluginRegistryTrust | undefined): string | null {
  const origin = entry?.origin;
  if (origin) return JSON.stringify(["source", origin.sourceOrigin, origin.sourceId, origin.packagePath]);
  // A dev install pins no folder, only the manifest it installed, so each reinstalled manifest asks again.
  if (entry?.installSource === "local-dev" && entry.manifestSha256) return JSON.stringify(["local-dev", entry.manifestSha256]);
  return null;
}

/** The (plugin, install source, scope hash) an approval binds to; the IPC review and the gate derive it here alike. */
export interface PluginBackgroundEffectSubject {
  readonly pluginId: string;
  readonly source: string | null;
  readonly scopeSha256: string;
  readonly effects: PluginBackgroundEffects;
  readonly declared: boolean;
  /** Names the source and scope a card showed, so an approval binds only if both are still current. */
  readonly reviewSha256: string;
}

export function backgroundEffectSubject(manifest: PluginManifest, entry: PluginRegistryTrust | undefined): PluginBackgroundEffectSubject {
  const effects = declaredBackgroundEffects(manifest);
  const source = backgroundEffectSource(entry);
  const scopeSha256 = backgroundEffectScopeSha256(effects);
  return {
    pluginId: manifest.id,
    source,
    scopeSha256,
    effects,
    declared: hasBackgroundEffects(effects),
    reviewSha256: createHash("sha256").update(JSON.stringify([manifest.id, source, scopeSha256])).digest("hex"),
  };
}

/** Gated paths an approval opens outside a tool call; own-storage writes need none, every other gated path is denied. */
export function backgroundEffectPaths(manifest: PluginManifest): ReadonlySet<string> {
  const effects = declaredBackgroundEffects(manifest);
  return new Set<string>([
    ...(effects.networkDestinations.length > 0 ? ["hostFetch"] : []),
    ...(effects.alertKinds.length > 0 ? ["raiseAlert"] : []),
    ...(effects.suggestionSources.length > 0 ? ["triggerConversation"] : []),
    ...(effects.llm ? ["callLlm"] : []),
    ...(effects.workers ? ["spawnWorker"] : []),
  ]);
}

/** Whether a standalone effect's own target is one the manifest declares; the gate keeps own-storage writes inside that storage. */
export function withinBackgroundScope(effects: PluginBackgroundEffects, methodPath: string, target: string | undefined): boolean {
  switch (methodPath) {
    case "hostFetch": {
      if (typeof target !== "string") return false;
      try {
        return urlHostMatchesAllowList(new URL(target).hostname, effects.networkDestinations);
      } catch {
        return false;
      }
    }
    case "raiseAlert": return typeof target === "string" && effects.alertKinds.includes(target);
    case "triggerConversation": return typeof target === "string" && effects.suggestionSources.includes(target);
    case "callLlm": return effects.llm;
    case "spawnWorker": return effects.workers;
    default: return false;
  }
}

export function backgroundEffectApprovalsPath(cacheRoot: string): string {
  return resolve(cacheRoot, "plugin-contribution-trust", "background-effects.json");
}

interface ApprovalRecord {
  pluginId: string;
  source: string;
  scopeSha256: string;
}

interface ApprovalsFile {
  version: 2;
  approvals: ApprovalRecord[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseApprovals(value: unknown): Map<string, ApprovalRecord> | null {
  if (!isPlainObject(value) || value.version !== 2 || !Array.isArray(value.approvals)) return null;
  const approvals = new Map<string, ApprovalRecord>();
  for (const record of value.approvals) {
    if (!isPlainObject(record)) return null;
    const { pluginId, source, scopeSha256 } = record;
    if (typeof pluginId !== "string" || !pluginId || typeof source !== "string" || !source
      || typeof scopeSha256 !== "string" || !SHA256.test(scopeSha256)) return null;
    approvals.set(pluginId, { pluginId, source, scopeSha256 });
  }
  return approvals;
}

/** One approval per plugin, bound to its install source and declared scope; an unreadable file approves nothing and never stops boot. */
export class PluginBackgroundEffectApprovals {
  private approvals = new Map<string, ApprovalRecord>();
  private readonly subjects = new Map<string, Array<() => Promise<PluginBackgroundEffectSubject>>>();
  private readonly uninstalls = new Map<string, number>();

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const input = readAveHomeInputSync(path);
      if (input.status === "absent") return;
      if (input.status !== "trusted") {
        log.warn({ path, reason: input.reason }, "background effect approvals are not trusted; nothing is approved");
        return;
      }
      const approvals = parseApprovals(JSON.parse(input.bytes.toString("utf8")));
      if (!approvals) {
        log.warn({ path }, "background effect approvals are malformed; nothing is approved");
        return;
      }
      this.approvals = approvals;
    } catch (error) {
      log.warn({ path, err: error instanceof Error ? error.message : String(error) }, "background effect approvals are unreadable; nothing is approved");
    }
  }

  /** Each HostApi registers how its gate derives the subject, so the card review reads the newest live one; the returned call unbinds it. */
  bindSubject(pluginId: string, read: () => Promise<PluginBackgroundEffectSubject>): () => void {
    const reads = this.subjects.get(pluginId) ?? [];
    const own = () => read();
    this.subjects.set(pluginId, [...reads, own]);
    return () => {
      const rest = (this.subjects.get(pluginId) ?? []).filter((candidate) => candidate !== own);
      if (rest.length > 0) this.subjects.set(pluginId, rest);
      else this.subjects.delete(pluginId);
    };
  }

  async currentSubject(pluginId: string): Promise<PluginBackgroundEffectSubject | null> {
    const read = this.subjects.get(pluginId)?.at(-1);
    return read ? await read() : null;
  }

  /** The review a card names; each uninstall changes it, so a card dismissed before a reinstall from the same source shows again. */
  reviewSha256(subject: PluginBackgroundEffectSubject): string {
    const uninstalls = this.uninstalls.get(subject.pluginId) ?? 0;
    if (uninstalls === 0) return subject.reviewSha256;
    return createHash("sha256").update(JSON.stringify([subject.reviewSha256, uninstalls])).digest("hex");
  }

  isApproved(subject: PluginBackgroundEffectSubject): boolean {
    const record = this.approvals.get(subject.pluginId);
    return subject.declared && subject.source !== null
      && record?.source === subject.source && record.scopeSha256 === subject.scopeSha256;
  }

  approve(subject: PluginBackgroundEffectSubject): void {
    if (!subject.pluginId || !subject.declared || subject.source === null || !SHA256.test(subject.scopeSha256)) {
      throw new Error("A background effect approval needs a declared scope from a pinned install source");
    }
    const next = new Map(this.approvals).set(subject.pluginId, {
      pluginId: subject.pluginId, source: subject.source, scopeSha256: subject.scopeSha256,
    });
    this.persist(next);
    this.approvals = next;
  }

  /** Uninstall drops the approval and renames the review; a failed write is logged, and the next save or boot prune drops it on disk. */
  revoke(pluginId: string): void {
    this.uninstalls.set(pluginId, (this.uninstalls.get(pluginId) ?? 0) + 1);
    if (!this.approvals.has(pluginId)) return;
    const next = new Map(this.approvals);
    next.delete(pluginId);
    this.approvals = next;
    try {
      this.persist(next);
    } catch (error) {
      log.warn({ pluginId, err: error instanceof Error ? error.message : String(error) }, "background effect approval removal was not saved");
    }
  }

  /** Boot drops approvals for plugins the registry no longer names, so a removal whose write failed is not honoured on reinstall. */
  retain(pluginIds: ReadonlySet<string>): void {
    const next = new Map([...this.approvals].filter(([pluginId]) => pluginIds.has(pluginId)));
    if (next.size === this.approvals.size) return;
    this.approvals = next;
    try {
      this.persist(next);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, "background effect approval prune was not saved");
    }
  }

  private persist(approvals: ReadonlyMap<string, ApprovalRecord>): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: ApprovalsFile = { version: 2, approvals: [...approvals.values()] };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}
