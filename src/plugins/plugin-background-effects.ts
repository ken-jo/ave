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
  /** The registry stamp of this install; a reinstall writes a new one, and so does an update. */
  readonly installedAt: string | null;
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
    installedAt: entry?.origin?.installedAt ?? null,
  };
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
  installedAt?: string;
}

interface ApprovalsFile {
  version: 2;
  approvals: ApprovalRecord[];
  upgradeReviewed?: true;
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
    const { pluginId, source, scopeSha256, installedAt } = record;
    if (typeof pluginId !== "string" || !pluginId || typeof source !== "string" || !source
      || typeof scopeSha256 !== "string" || !SHA256.test(scopeSha256)
      || (installedAt !== undefined && (typeof installedAt !== "string" || !installedAt))) return null;
    approvals.set(pluginId, approvalRecord(pluginId, source, scopeSha256, installedAt ?? null));
  }
  return approvals;
}

function approvalRecord(pluginId: string, source: string, scopeSha256: string, installedAt: string | null): ApprovalRecord {
  return { pluginId, source, scopeSha256, ...(installedAt === null ? {} : { installedAt }) };
}

/**
 * One approval per plugin, bound to its install source, declared scope and the install it was given for; an unreadable file
 * approves nothing and never stops boot. A removal whose write failed leaves the old record on disk, and its older install stamp
 * keeps it from approving a reinstall.
 */
export class PluginBackgroundEffectApprovals {
  private approvals = new Map<string, ApprovalRecord>();
  private readonly subjects = new Map<string, Array<() => Promise<PluginBackgroundEffectSubject>>>();
  private readonly uninstalls = new Map<string, number>();
  private unsaved = false;
  private upgradeReviewed = false;
  /** Plugins whose record this process gave or matched to a live install, so an update may move it to the new stamp. */
  private readonly current = new Set<string>();

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const input = readAveHomeInputSync(path);
      if (input.status === "absent") return;
      if (input.status !== "trusted") {
        log.warn({ path, reason: input.reason }, "background effect approvals are not trusted; nothing is approved");
        return;
      }
      const value: unknown = JSON.parse(input.bytes.toString("utf8"));
      const approvals = parseApprovals(value);
      if (!approvals) {
        log.warn({ path }, "background effect approvals are malformed; nothing is approved");
        return;
      }
      this.approvals = approvals;
      this.upgradeReviewed = isPlainObject(value) && value.upgradeReviewed === true;
    } catch (error) {
      log.warn({ path, err: error instanceof Error ? error.message : String(error) }, "background effect approvals are unreadable; nothing is approved");
    }
  }

  /** Each HostApi registers how its gate derives the subject, so the card review reads the newest live one; the returned call unbinds it. */
  bindSubject(pluginId: string, read: () => Promise<PluginBackgroundEffectSubject>): () => void {
    if (this.unsaved) this.save(this.approvals, "background effect approvals were not saved");
    const reads = this.subjects.get(pluginId) ?? [];
    const own = () => read();
    this.subjects.set(pluginId, [...reads, own]);
    void this.carry(pluginId, own);
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

  /** Another install stamp is approved only for a record this process already matched, so an update is not denied before it moves. */
  isApproved(subject: PluginBackgroundEffectSubject): boolean {
    const record = this.approvals.get(subject.pluginId);
    return subject.declared && subject.source !== null
      && record?.source === subject.source && record.scopeSha256 === subject.scopeSha256
      && (record.installedAt === (subject.installedAt ?? undefined) || this.current.has(subject.pluginId));
  }

  approve(subject: PluginBackgroundEffectSubject): void {
    if (!subject.pluginId || !subject.declared || subject.source === null || !SHA256.test(subject.scopeSha256)) {
      throw new Error("A background effect approval needs a declared scope from a pinned install source");
    }
    const next = new Map(this.approvals).set(subject.pluginId,
      approvalRecord(subject.pluginId, subject.source, subject.scopeSha256, subject.installedAt));
    this.persist(next);
    this.approvals = next;
    this.unsaved = false;
    this.current.add(subject.pluginId);
  }

  /** Uninstall drops the approval and renames the review; a failed write is logged and retried at the next save, bind or boot prune. */
  revoke(pluginId: string): void {
    this.uninstalls.set(pluginId, (this.uninstalls.get(pluginId) ?? 0) + 1);
    this.current.delete(pluginId);
    if (!this.approvals.has(pluginId)) return;
    const next = new Map(this.approvals);
    next.delete(pluginId);
    this.approvals = next;
    this.save(next, "background effect approval removal was not saved");
  }

  /** Whether an interactive launch still owes the one card listing every unapproved plugin; boot never answers it. */
  upgradeReviewOwed(): boolean {
    return !this.upgradeReviewed;
  }

  /** The card was answered; a failed write is retried like a failed removal, and a restart before then shows the card again. */
  finishUpgradeReview(): void {
    if (this.upgradeReviewed) return;
    this.upgradeReviewed = true;
    this.save(this.approvals, "background effect first-launch review was not saved");
  }

  /** Boot keeps only approvals for the install each plugin id has now (id -> install stamp); the kept ones may follow an update. */
  retain(installs: ReadonlyMap<string, string | null>): void {
    const next = new Map([...this.approvals].filter(([pluginId, record]) =>
      installs.has(pluginId) && record.installedAt === (installs.get(pluginId) ?? undefined)));
    for (const pluginId of next.keys()) this.current.add(pluginId);
    if (next.size === this.approvals.size) return;
    this.approvals = next;
    this.save(next, "background effect approval prune was not saved");
  }

  /** An update writes a new install stamp; a record this process matched moves to it, one only read from disk never does. */
  private async carry(pluginId: string, read: () => Promise<PluginBackgroundEffectSubject>): Promise<void> {
    let subject: PluginBackgroundEffectSubject;
    try {
      subject = await read();
    } catch {
      return;
    }
    if (this.subjects.get(pluginId)?.at(-1) !== read) return;
    const record = this.approvals.get(subject.pluginId);
    if (!record || record.source !== subject.source || record.scopeSha256 !== subject.scopeSha256) return;
    if (record.installedAt === (subject.installedAt ?? undefined)) {
      this.current.add(subject.pluginId);
      return;
    }
    if (!this.current.has(subject.pluginId)) return;
    const next = new Map(this.approvals).set(subject.pluginId,
      approvalRecord(record.pluginId, record.source, record.scopeSha256, subject.installedAt));
    this.approvals = next;
    this.save(next, "background effect approval was not moved to the updated install");
  }

  /** A write that failed is retried when a plugin next binds, so a reinstall before restart cannot revive a removed approval. */
  private save(approvals: ReadonlyMap<string, ApprovalRecord>, failure: string): void {
    try {
      this.persist(approvals);
      this.unsaved = false;
    } catch (error) {
      this.unsaved = true;
      log.warn({ err: error instanceof Error ? error.message : String(error) }, failure);
    }
  }

  private persist(approvals: ReadonlyMap<string, ApprovalRecord>): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: ApprovalsFile = { version: 2, approvals: [...approvals.values()], ...(this.upgradeReviewed ? { upgradeReviewed: true } : {}) };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}
