/**
 * The git marketplace as one service (design §6, §7, §8, §13, §15): what the
 * `ave:marketplace:*` channels do.
 *
 * Sources come from the registry and are read through the syncer's
 * snapshots; the catalog is the aggregate of the shown sources' snapshots
 * with each row's state against what is installed. An install is planned
 * first (single-use `planId`, bound to the row's snapshot commit and the
 * version's commit) and executed later by id, so what the user reviewed is
 * what installs. Each kind's installer is a port the host composition
 * provides; the service plans, stages the bytes and dispatches.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isAsrtSandboxActive } from "../../permissions/asrt-sandbox.js";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import type {
  BootInstallNoticeView,
  CatalogEntryView,
  CatalogQuery,
  CatalogView,
  DirectMcpPreviewRequest,
  DirectMcpPreviewView,
  InstallPlanRequest,
  InstallPlanView,
  InstallProgressView,
  InstallResultView,
  McpRuntimeView,
  ComponentConsent,
  PackageDetailView,
  PackageKeyView,
  PackageUpdateView,
  SourceAddRequest,
  SourcePreviewRequest,
  RevokedPackageView,
  SourceBadge,
  SourcePreviewResultView,
  SourceView,
  SourceWarning,
  SourceWarningView,
  SyncProgressView,
  UninstallRequest,
  UninstallResultView,
  UpdatePlanView,
} from "../../shared/git-marketplace.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { aggregateCatalog, findRevocation, versionExclusions, type CatalogRow, type VersionChoiceContext } from "../catalog/aggregate.js";
import { PACKAGE_KINDS, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { stageContentPackage } from "../content/store.js";
import { componentDelta } from "./component-delta.js";
import { errorMessage } from "../../shared/error-message.js";
import { ConfirmationRequiredError, MarketplaceError, isMarketplaceError, type EnteredTargetWarningView, type MarketplaceErrorDetail } from "../errors.js";
import { BareRepo } from "../git/repo.js";
import type { GitCommands, GitRemote } from "../git/run-git.js";
import type { CatalogSource, NetworkGate } from "../net/network-gate.js";
import { normalizeSourceHost, normalizeSourceUrl, type NormalizedSourceUrl } from "../net/source-url.js";
import { candidateVersion, planPackage, type PackagePlan } from "../resolve/descriptor.js";
import { classifyInstall, updateFor, type InstalledPackage } from "../resolve/identity.js";
import { assertMcpRuntimePinned, resolveMcpPackage, runtimeFromServerJson, type ResolvedMcpServer } from "../resolve/mcp.js";
import { planPluginVersion, runPluginLadder, type LadderDeps, type PluginInstallPlan } from "../resolve/plugin-ladder.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";
import { assertNotRequiredByPolicy, bootInstallNoticeFrom, lockedByPolicy, requiredByPolicy, runBootInstalls, type BootInstallReport } from "../boot-installs/run.js";
import type { LegacyContentKind, LegacyContentReport } from "../migration/legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "../migration/legacy-plugins.js";
import { runLegacyMigration } from "../migration/run.js";
import { readDirectPackage } from "../sources/direct-package.js";
import { isReservedSourceId, OFFICIAL_MARKETPLACE, SOURCE_ID_RE, type SourceAuth } from "../sources/official.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PackageKey, type PolicySource, type PolicyUpdate } from "../sources/policy.js";
import { confirmationsFor, type ResolvedSource, type SourceOrigin, type SourceRegistry, type SourceState } from "../sources/registry.js";
import { SnapshotBuilder, type SourceSnapshot } from "../sources/snapshot.js";
import { shouldSyncSource, type SourceSyncer } from "../sources/sync.js";
import type { PluginConfigRetention } from "../../plugins/retired-config.js";
import type { RetirementEntry, RetirementEntryLookup } from "./retirement-entry.js";
import { effectiveRevocations } from "../catalog/effective-revocations.js";
import { revocationFeed, type BoundInstall, type RevocationFeed } from "./revocations.js";
import { OperationLock } from "./operation-lock.js";
import { Tickets } from "./tickets.js";
import type { InstallerPorts, InstalledRecord, TokenStore } from "./ports.js";
import {
  authorityDelta,
  authorityView,
  brokenStatus,
  installActionView,
  rowState,
  rungOutcomeViews,
  rungViews,
  runsCode,
  sourceStatus,
  versionViews,
  widensAuthority,
} from "./views.js";

type ContentPlan = PackagePlan & { kind: Exclude<PackageKind, "plugin" | "mcp"> };

/** A plan, and the digest of the policy it was made under (§18.6): executed under another, it expires. */
type HeldPlan = { policyDigest: string } & (
  | { kind: "plugin"; plan: PluginInstallPlan; switchSource: boolean }
  | { kind: "content"; plan: ContentPlan; switchSource: boolean; adopt: boolean }
  | { kind: "mcp"; resolved: ResolvedMcpServer; switchSource: boolean }
  | { kind: "mcp-unbound"; name: string; runtime: McpRuntimeSpec }
);

/** The package a held plan installs and the source it binds it to (none for a direct MCP server). */
function heldTarget(held: HeldPlan): PendingBinding {
  switch (held.kind) {
    case "plugin":
      return { kind: "plugin", name: held.plan.name, sourceId: held.plan.sourceId };
    case "content":
      return { kind: held.plan.kind, name: held.plan.name, sourceId: held.plan.sourceId };
    case "mcp":
      return { kind: "mcp", name: held.resolved.plan.name, sourceId: held.resolved.plan.sourceId };
    case "mcp-unbound":
      return { kind: "mcp", name: held.name, sourceId: null };
  }
}

type PendingBinding = Omit<BoundInstall, "sourceId"> & { sourceId: string | null };

/** An installed version its own source revokes. */
type RevokedInstall = { record: InstalledRecord & { sourceId: string }; revocation: RevocationFeed["rules"][number] };

interface HeldPreview {
  sourceId: string;
  dir: string;
  url: NormalizedSourceUrl;
  ref: string | null;
  subdir: string | null;
  auth: SourceAuth;
  token: string | null;
  origin: "custom" | "direct";
  suggestedId: string;
  /** Exactly the confirmations the preview carried; *Add* stores them (§18.5). */
  acknowledged: SourceWarning[];
}

export interface MarketplaceServiceOptions {
  registry: SourceRegistry;
  syncer: SourceSyncer;
  /**
   * The runner every repository uses, whether an OS credential helper answers
   * for a host, and the address check of a remote without any git command
   * (the preview's confirmation step, §18.5).
   */
  git: { commands: GitCommands; credentialHelperFor(host: string): Promise<boolean>; preflight(remote: GitRemote): Promise<void> };
  gate: NetworkGate;
  /** `~/.ave/marketplaces`. */
  root: string;
  /** Scratch directory for exports and preview clones. */
  workRoot: string;
  /** Checked at the start of every operation; a change applies under the operation lock (§18.6). */
  policy: PolicySource;
  tokens: TokenStore;
  /** Tokens typed into the add dialog, by preview source id; read by the askpass lookup. */
  previewTokens: Map<string, string>;
  versionContext: () => VersionChoiceContext;
  installers: InstallerPorts;
  ladder: Pick<LadderDeps, "zip" | "limits" | "artifacts">;
  mcpLimits: LadderDeps["limits"];
  english: Readonly<Record<string, string>>;
  onSyncProgress?: (progress: SyncProgressView) => void;
  onCatalogChanged?: () => void;
  onInstallProgress?: (progress: InstallProgressView) => void;
  /** The first-boot migration of existing installs (design §16.3), run before the boot installs. */
  legacyMigration: {
    markerPath: string;
    plugins(officialPlugin: (name: string) => OfficialPlugin | null, applied: AppliedDefaults): Promise<LegacyPluginReport>;
    content(ports: {
      listed(kind: LegacyContentKind, name: string): boolean;
      installed(kind: LegacyContentKind, name: string): Promise<boolean>;
      adopt(kind: LegacyContentKind, name: string): Promise<void>;
    }): Promise<LegacyContentReport>;
  };
  /**
   * Where the revocation feed lands (§10.4): the registry the plugin and
   * content load gates read. Handed every rule and the sources whose snapshot
   * could not be read.
   */
  revocations: { apply(feed: RevocationFeed): Promise<void> };
  /** Where a failure that must not fail the finished operation is reported. */
  log: { warn(message: string): void };
  now?: () => Date;
}

/**
 * Kinds the host loads through a revocation gate: a `disable` revocation
 * keeps them installed and unloaded. The others take effect through their
 * configuration (an MCP server's config, provider and messaging settings),
 * so the boot pass removes them for `disable` too.
 */
const GATED_KINDS: ReadonlySet<PackageKind> = new Set(["plugin", "skill", "agent", "theme", "font", "language"]);

const PREVIEW_ID_PREFIX = "preview-";

function keyOf(kind: PackageKind, name: string): string {
  return `${kind}:${name}`;
}

function sourceLabel(source: ResolvedSource, snapshot: SourceSnapshot | null): string {
  return source.label ?? snapshot?.marketplace.displayName ?? source.id;
}

function mcpRuntimeView(runtime: McpRuntimeSpec): McpRuntimeView {
  if (runtime.transport === "http") {
    return {
      transport: "http",
      command: null,
      args: [],
      url: runtime.url,
      env: runtime.auth === "api-key" && runtime.apiKeyHeader ? [{ name: runtime.apiKeyHeader, secret: true, required: true }] : [],
      usesDataDir: false,
    };
  }
  const env = Object.keys(runtime.env ?? {}).map((name) => ({ name, secret: false, required: false }));
  if (runtime.apiKeyEnv) env.push({ name: runtime.apiKeyEnv, secret: true, required: true });
  const text = [runtime.command, ...(runtime.args ?? []), ...Object.values(runtime.env ?? {})].join("\n");
  return { transport: "stdio", command: runtime.command, args: [...(runtime.args ?? [])], url: null, env, usesDataDir: /\$DATA_DIR(?![A-Za-z0-9_])/u.test(text) };
}

/** A source id from a name: lowercase, `-` for anything else, never reserved. */
function idFrom(raw: string): string | null {
  const id = raw.toLowerCase().replace(/\.git$/u, "").replace(/[^a-z0-9-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return SOURCE_ID_RE.test(id) && !isReservedSourceId(id) ? id : null;
}

/** The confirmations a source holds: its entry's (custom, direct) or its state's (official, managed), §18.5. */
function acknowledgedOf(source: ResolvedSource, state: SourceState | null): SourceWarning[] {
  return source.origin === "custom" || source.origin === "direct" ? [...(source.acknowledged ?? [])] : confirmationsFor(state?.acknowledged, source.url);
}

/** What the source's row and cards show while it applies (§18.5): plain http, and each confirmed class. */
function badgesOf(url: NormalizedSourceUrl, acknowledged: readonly SourceWarning[]): SourceBadge[] {
  const badges: SourceBadge[] = [];
  if (url.scheme === "http") badges.push("unencrypted");
  for (const warning of ["internal-network", "this-computer", "internal-downloads"] as const) {
    if (acknowledged.includes(warning)) badges.push(warning);
  }
  return badges;
}

/** Each warning once, in the order first named. */
function uniqueWarnings<T extends SourceWarningView>(views: readonly T[]): T[] {
  const seen = new Set<SourceWarning>();
  const unique: T[] = [];
  for (const view of views) {
    if (seen.has(view.warning)) continue;
    seen.add(view.warning);
    unique.push(view);
  }
  return unique;
}

export class MarketplaceService implements RetirementEntryLookup {
  private readonly plans: Tickets<HeldPlan>;
  private readonly previews: Tickets<HeldPreview>;
  private readonly syncing = new Set<string>();
  /**
   * Installs in flight, by `kind:name`, and the source each is moving to:
   * every feed judges them by that source, not the one they leave (§10.4).
   */
  private readonly pendingBindings = new Map<string, PendingBinding>();
  /** Feeds run one after another, so an older feed never lands after a newer one. */
  private feedTail: Promise<unknown> = Promise.resolve();
  /** One enforcement pass at a time, so two passes never remove the same package. */
  private enforceTail: Promise<unknown> = Promise.resolve();
  /** Revocations enforced but not yet reported, and every one queued this session. */
  private readonly revokedUnreported: RevokedPackageView[] = [];
  private readonly revokedQueued = new Set<string>();
  /** Operations share it; a policy change takes it alone (§18.6). */
  private readonly lock = new OperationLock();
  /** Set while an operation runs, so its own nested calls neither re-check the policy nor take the lock again. */
  private readonly inOperation = new AsyncLocalStorage<true>();

  constructor(private readonly options: MarketplaceServiceOptions) {
    const now = () => (options.now?.() ?? new Date()).getTime();
    this.plans = new Tickets<HeldPlan>("install plan", now);
    this.previews = new Tickets<HeldPreview>("marketplace preview", now, undefined, (preview) => {
      options.previewTokens.delete(preview.sourceId);
      void rm(preview.dir, { recursive: true, force: true });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get registry(): SourceRegistry {
    return this.options.registry;
  }

  /** The policy in force; an unreadable one restricts nothing here, the gate blocks every non-official target (§12). */
  private get policy(): MarketplacePolicy {
    const load = this.options.policy.load;
    return load.ok ? load.policy : EMPTY_MARKETPLACE_POLICY;
  }

  /**
   * Run one operation (§18.6): first compare the policy file with the last
   * read and, when it changed, apply the new policy while no operation runs;
   * then run under the shared lock. A call made inside an operation runs as
   * part of it.
   */
  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inOperation.getStore()) return fn();
    if (await this.options.policy.check()) {
      // The read above only says the file changed. Read it again while no operation runs, so a
      // check that finished late can never put back a policy a newer one replaced.
      await this.lock.exclusive(async () => {
        const fresh = await this.options.policy.check();
        if (fresh) this.applyPolicy(fresh);
      });
    }
    return this.lock.shared(() => this.inOperation.run(true, fn));
  }

  private applyPolicy(update: PolicyUpdate): void {
    // A check that began after this read supersedes it; the policy in force stays.
    if (!this.options.policy.apply(update)) return;
    if (!update.load.ok) this.options.log.warn(`marketplace policy unreadable; only the official source is reachable: ${update.load.error}`);
    // Managed sources, blocks and required installs may all have changed.
    this.options.onCatalogChanged?.();
  }

  private source(id: string): ResolvedSource {
    const source = this.registry.get(id);
    if (!source) throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
    return source;
  }

  /**
   * A source's state and the snapshot at its pin. A state or snapshot file
   * that cannot be used is reported as the source's problem, never read as a
   * fresh source: the Sources view shows it with Repair, and the catalog
   * leaves the source out until it is repaired (or removed). Any other error
   * is a bug and propagates.
   */
  private async read(source: ResolvedSource): Promise<{ state: SourceState; snapshot: SourceSnapshot | null } | { problem: MarketplaceError }> {
    try {
      const state = await this.registry.readState(source.id);
      return { state, snapshot: await this.options.syncer.readSnapshot(source.id) };
    } catch (error) {
      if (isMarketplaceError(error) && error.code === "SOURCE_LOCAL_DATA_DAMAGED") return { problem: error };
      throw error;
    }
  }

  // ─── sources ──────────────────────────────────────────────────────────────

  private async sourceView(source: ResolvedSource): Promise<SourceView> {
    const read = await this.read(source);
    const state = "problem" in read ? null : read.state;
    const snapshot = "problem" in read ? null : read.snapshot;
    const reviewable = source.origin === "custom" || source.origin === "direct";
    const tokenHost = source.auth.kind === "token" ? source.auth.host : null;
    return {
      id: source.id,
      origin: source.origin,
      label: sourceLabel(source, snapshot),
      url: source.url.url,
      ref: source.ref ?? null,
      subdir: source.subdir ?? null,
      mirrors: source.mirrors.length,
      auth: source.auth.kind,
      tokenHost,
      tokenStored: tokenHost !== null && this.options.tokens.has(tokenHost),
      pinnedCommit: state?.pinnedCommit ?? null,
      lastSyncAt: state?.lastSync?.at ?? null,
      marketplace: snapshot
        ? {
            name: snapshot.marketplace.name,
            displayName: snapshot.marketplace.displayName,
            description: snapshot.marketplace.description ?? null,
            owner: snapshot.marketplace.owner?.name ?? null,
          }
        : null,
      packageCount: snapshot?.packages.length ?? 0,
      status: "problem" in read ? brokenStatus(read.problem) : sourceStatus(read.state, this.syncing.has(source.id), snapshot !== null, reviewable),
      enabled: state ? this.registry.isEnabled(source, state) : !this.registry.canDisable(source),
      canDisable: this.registry.canDisable(source),
      canRemove: reviewable,
      diagnostics: (snapshot?.diagnostics ?? []).map((item) => `${item.subject}: ${item.message}`),
      acknowledged: acknowledgedOf(source, state),
      badges: badgesOf(source.url, acknowledgedOf(source, state)),
    };
  }

  async listSources(): Promise<SourceView[]> {
    return this.operation(() => Promise.all(this.registry.list().map((source) => this.sourceView(source))));
  }

  private async syncOne(id: string): Promise<void> {
    this.syncing.add(id);
    this.options.onSyncProgress?.({ sourceId: id, state: "syncing" });
    try {
      const result = await this.options.syncer.sync(id);
      this.options.onSyncProgress?.({ sourceId: id, state: result.status === "ok" ? "done" : "failed" });
    } catch (error) {
      this.options.onSyncProgress?.({ sourceId: id, state: "failed" });
      throw error;
    } finally {
      this.syncing.delete(id);
    }
  }

  /**
   * Repair (design §18.8): move the source's downloaded copy aside and sync
   * it again, for every origin. Installed packages stay bound to it; tokens,
   * policy and `sources.json` are not touched. A failed move throws
   * SOURCE_LOCAL_DATA_DAMAGED `repair-failed`, a failed write of the kept
   * pin `repair-write-failed`; a failed sync is recorded like any other and
   * shown on the source.
   */
  async repairSource(id: string): Promise<SourceView[]> {
    return this.operation(() => this.repairSourceNow(id));
  }

  private async repairSourceNow(id: string): Promise<SourceView[]> {
    const source = this.source(id);
    await this.options.syncer.resetLocalData(source.id);
    this.options.onCatalogChanged?.();
    await this.syncOne(source.id);
    await this.enforceRevocations();
    return this.listSources();
  }

  /** Sync one source, or every source that is shown or has installed packages (§7.3). */
  async refresh(id?: string): Promise<SourceView[]> {
    return this.operation(() => this.refreshNow(id));
  }

  private async refreshNow(id?: string): Promise<SourceView[]> {
    let ids: string[];
    if (id !== undefined) {
      ids = [this.source(id).id];
    } else {
      const bound = new Set((await this.installedAll()).map((item) => item.sourceId).filter((sourceId): sourceId is string => sourceId !== null));
      ids = [];
      for (const source of this.registry.list()) {
        const read = await this.read(source);
        // A broken source is listed with its problem; syncing it would only fail again.
        if ("problem" in read) continue;
        if (shouldSyncSource(this.registry, source, read.state, bound.has(source.id))) ids.push(source.id);
      }
    }
    // Every source finishes; a failure outside a sync result (a bug, an unreadable file) is reported after.
    const settled = await Promise.allSettled(ids.map((sourceId) => this.syncOne(sourceId)));
    // A moved pin may carry new revocations; they take effect before anything else happens.
    await this.enforceRevocations();
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) throw failed.reason;
    return this.listSources();
  }

  async setEnabled(id: string, enabled: boolean): Promise<SourceView> {
    return this.operation(async () => {
      await this.registry.setEnabled(id, enabled);
      this.options.onCatalogChanged?.();
      return this.sourceView(this.source(id));
    });
  }

  async acceptRewrite(id: string, commit: string): Promise<SourceView> {
    return this.operation(async () => {
      const result = await this.options.syncer.acceptRewrite(id, commit);
      if (result.status === "failed") throw new MarketplaceError(result.code, result.message, result.detail ? { detail: result.detail } : undefined);
      return this.sourceView(this.source(id));
    });
  }

  /**
   * *Allow…* (§18.5): the source takes the confirmations its target now
   * needs, and syncs again under them. A sync that still fails is recorded
   * and shown on the row like any other.
   */
  async acknowledgeSource(id: string, warnings: readonly SourceWarning[]): Promise<SourceView> {
    return this.operation(async () => {
      const source = this.source(id);
      await this.registry.acknowledge(source.id, warnings);
      this.options.onCatalogChanged?.();
      await this.syncOne(source.id);
      await this.enforceRevocations();
      return this.sourceView(this.source(source.id));
    });
  }

  /** Remove a custom or direct source; its installed packages stay and are listed (§7.6). */
  async removeSource(id: string): Promise<{ orphanedPackages: PackageKeyView[] }> {
    return this.operation(() => this.removeSourceNow(id));
  }

  private async removeSourceNow(id: string): Promise<{ orphanedPackages: PackageKeyView[] }> {
    const source = this.source(id);
    if (source.origin === "official" || source.origin === "managed") {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the ${source.origin} source ${id} cannot be removed`);
    }
    const orphaned = (await this.installedAll()).filter((item) => item.sourceId === id).map((item) => ({ sourceId: id, kind: item.kind, name: item.name }));
    await this.options.syncer.removeSource(id);
    this.options.onCatalogChanged?.();
    return { orphanedPackages: orphaned };
  }

  async setToken(host: string, token: string): Promise<{ host: string }> {
    const normalized = normalizeSourceHost(host, host);
    if (token.length === 0 || /[\r\n]/u.test(token)) throw new MarketplaceError("SOURCE_AUTH_REQUIRED", "the token is empty or spans lines");
    await this.options.tokens.set(normalized, token);
    return { host: normalized };
  }

  async deleteToken(host: string): Promise<{ host: string }> {
    const normalized = normalizeSourceHost(host, host);
    await this.options.tokens.delete(normalized);
    return { host: normalized };
  }

  // ─── add (preview → confirm, §7.2) ─────────────────────────────────────

  private freeId(candidates: ReadonlyArray<string | null>): string {
    const taken = new Set(this.registry.list().map((source) => source.id));
    for (const candidate of candidates) {
      if (!candidate) continue;
      for (let suffix = 1; suffix < 100; suffix += 1) {
        const id = suffix === 1 ? candidate : `${candidate.slice(0, 60)}-${suffix}`;
        if (!taken.has(id)) return id;
      }
    }
    return `source-${randomBytes(3).toString("hex")}`;
  }

  async previewSource(request: SourcePreviewRequest): Promise<SourcePreviewResultView> {
    return this.operation(() => this.previewSourceNow(request));
  }

  /**
   * Preview an address (§7.2, §18.5): refusals and policy first, then every
   * warning the request does not carry is asked for — the lexical ones
   * (plain http, sign-in over it, a literal address's class) before any
   * lookup or git command, an address class found by the one lookup before
   * any git command — and only then the repository is read.
   */
  private async previewSourceNow(request: SourcePreviewRequest): Promise<SourcePreviewResultView> {
    const url = normalizeSourceUrl(request.input);
    if (request.auth === "ssh" && url.scheme !== "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "SSH sign-in needs an ssh:// or git@host:path address");
    if (request.auth !== "ssh" && url.scheme === "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "an ssh address needs SSH sign-in");
    const auth: SourceAuth = request.auth === "token" ? { kind: "token", host: url.host } : { kind: request.auth };
    const subdir = request.subdir?.trim() ? request.subdir.trim().replace(/^\/+|\/+$/gu, "") : null;
    const ref = request.ref?.trim() ? request.ref.trim() : null;
    const acknowledged = [...new Set(request.acknowledge ?? [])];
    const held = new Set(acknowledged);
    const confirm = (warnings: readonly EnteredTargetWarningView[]): SourcePreviewResultView => ({ type: "confirm", warnings: uniqueWarnings(warnings) });
    // Sign-in over plain http: a credential must not leave before the user accepts that (§18.2.2).
    const lexical: EnteredTargetWarningView[] = url.scheme === "http" && auth.kind === "token" && !held.has("token-unencrypted")
      ? [{ warning: "token-unencrypted", host: url.host, address: null }]
      : [];
    let verdict: ReturnType<NetworkGate["checkRemote"]>;
    try {
      verdict = this.options.gate.checkRemote(url, { official: false, acknowledged: held });
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) return confirm([...error.warnings, ...lexical]);
      throw error;
    }
    if (lexical.length > 0) return confirm(lexical);
    const sourceId = `${PREVIEW_ID_PREFIX}${randomBytes(9).toString("hex")}`;
    const remote: GitRemote = { url, sourceId, useToken: auth.kind === "token", ...verdict };
    try {
      // The address class a lookup finds is asked for before any git command runs.
      await this.options.git.preflight(remote);
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) return confirm(error.warnings);
      throw error;
    }
    const token = request.auth === "token" && request.token ? request.token : null;
    if (token) this.options.previewTokens.set(sourceId, token);
    const dir = join(this.options.root, ".previews", sourceId);
    const drop = async () => {
      this.options.previewTokens.delete(sourceId);
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const repo = await BareRepo.init(this.options.git.commands, join(dir, "repo.git"));
      const commit = await repo.fetchRef(remote, ref ?? undefined, "candidate");
      // Over http without token-unencrypted the helper is switched off for every call, so it never answers (§7.4).
      const credentialHelper = remote.credentialsAllowed && (await this.options.git.credentialHelperFor(url.host));
      const pathName = url.path.split("/").filter(Boolean).pop() ?? "";
      if (subdir === null) {
        const source: ResolvedSource = { id: sourceId, origin: "custom", url, mirrors: [], auth, ...(ref ? { ref } : {}) };
        const built = await new SnapshotBuilder(repo, remote, source, commit).build(this.now().toISOString());
        if (built.ok) {
          const counts: Partial<Record<PackageKind, number>> = {};
          for (const pkg of built.snapshot.packages) counts[pkg.kind] = (counts[pkg.kind] ?? 0) + 1;
          const suggestedId = this.freeId([idFrom(built.snapshot.marketplace.name), idFrom(pathName)]);
          const held = this.previews.issue({ sourceId, dir, url, ref, subdir: null, auth, token, origin: "custom", suggestedId, acknowledged });
          return {
            type: "marketplace",
            previewId: held.id,
            expiresAt: held.expiresAt,
            url: url.url,
            badges: badgesOf(url, acknowledged),
            ref,
            commit,
            marketplace: {
              name: built.snapshot.marketplace.name,
              displayName: built.snapshot.marketplace.displayName,
              description: built.snapshot.marketplace.description ?? null,
              owner: built.snapshot.marketplace.owner?.name ?? null,
            },
            counts,
            codeRunning: built.snapshot.packages.filter((pkg) => runsCode(pkg.kind, pkg.versions[0]?.components)).length,
            diagnostics: built.snapshot.diagnostics.map((item) => `${item.subject}: ${item.message}`),
            credentialHelper,
            suggestedId,
          };
        }
        if (built.code !== "SOURCE_NOT_A_MARKETPLACE") throw new MarketplaceError(built.code, built.message, built.detail ? { detail: built.detail } : undefined);
      }
      // A single package at the root or the given folder: a direct source (§7.2 step 4, §8.1).
      const read = await readDirectPackage({ repo, remote, commit, path: subdir ?? "" });
      if (!read) throw new MarketplaceError("SOURCE_NOT_A_MARKETPLACE", `no marketplace and no package at ${subdir ?? "the repository root"}`);
      if (!read.ok) throw new MarketplaceError(read.code, read.error);
      const { descriptor, detectedFrom, versionSynthesized } = read.found;
      const suggestedId = this.freeId([idFrom(descriptor.name), idFrom(pathName)]);
      const held = this.previews.issue({ sourceId, dir, url, ref, subdir, auth, token, origin: "direct", suggestedId, acknowledged });
      return {
        type: "package",
        previewId: held.id,
        expiresAt: held.expiresAt,
        url: url.url,
        badges: badgesOf(url, acknowledged),
        ref,
        subdir,
        commit,
        detectedFrom,
        kind: descriptor.kind,
        name: descriptor.name,
        displayName: descriptor.displayName ?? null,
        description: descriptor.description ?? null,
        version: descriptor.version,
        versionSynthesized,
        runsCode: runsCode(descriptor.kind, descriptor.kind === "agent-plugin" ? descriptor.payload.components as IndexVersion["components"] : undefined),
        credentialHelper,
        suggestedId,
      };
    } catch (error) {
      await drop();
      // Found at the connection (the address's class changed since the preflight): asked for the same way.
      if (error instanceof ConfirmationRequiredError) return confirm(error.warnings);
      // The host wants sign-in over plain http: asked for before any credential is sent (§18.2.2).
      if (isMarketplaceError(error) && error.code === "SOURCE_AUTH_REQUIRED" && error.detail?.reason === "token-unencrypted") {
        return confirm([{ warning: "token-unencrypted", host: url.host, address: null }]);
      }
      throw error;
    }
  }

  /**
   * Write the entry, then the state, then move the preview's repository into
   * place and sync (§7.2 step 6): a repo.git without a state reads as lost.
   */
  async addSource(request: SourceAddRequest): Promise<SourceView> {
    return this.operation(() => this.addSourceNow(request));
  }

  private async addSourceNow(request: SourceAddRequest): Promise<SourceView> {
    const preview = this.previews.take(request.previewId);
    try {
      // The policy may have changed since the preview (§18.6).
      this.options.gate.checkSourcePolicy(preview.url, { official: false });
      const id = request.id?.trim() || preview.suggestedId;
      await this.registry.add({
        id,
        origin: preview.origin,
        url: preview.url.url,
        ...(preview.ref ? { ref: preview.ref } : {}),
        ...(preview.subdir ? { subdir: preview.subdir } : {}),
        auth: preview.auth,
        ...(request.label?.trim() ? { label: request.label.trim() } : {}),
        acknowledged: preview.acknowledged,
      });
      if (preview.token && preview.auth.kind === "token") await this.options.tokens.set(preview.auth.host, preview.token);
      await this.registry.updateState(id, (state) => state);
      try {
        await renameDirectory(join(preview.dir, "repo.git"), join(this.options.root, id, "repo.git"));
      } catch (error) {
        // The sync fetches from scratch instead.
        if (!isMissingPathError(error)) throw error;
      }
      await this.syncOne(id);
      this.options.onCatalogChanged?.();
      return this.sourceView(this.source(id));
    } finally {
      this.options.previewTokens.delete(preview.sourceId);
      await rm(preview.dir, { recursive: true, force: true });
    }
  }

  // ─── catalog ──────────────────────────────────────────────────────────────

  private async installedAll(): Promise<InstalledRecord[]> {
    const [plugins, content, mcp] = await Promise.all([
      this.options.installers.plugin.list(),
      this.options.installers.content.list(),
      this.options.installers.mcp.list(),
    ]);
    return [...plugins, ...content, ...mcp];
  }

  /**
   * Rows of every shown source that has a snapshot, with the sources that have
   * one. `bound` adds hidden sources that installed packages are bound to: they
   * keep syncing, and their update notices keep reaching those packages (§7.3).
   */
  private async rows(bound?: ReadonlySet<string>): Promise<{ rows: CatalogRow[]; snapshots: Map<string, SourceSnapshot>; shown: ResolvedSource[]; badges: Map<string, SourceBadge[]> }> {
    const shown: ResolvedSource[] = [];
    const snapshots = new Map<string, SourceSnapshot>();
    const badges = new Map<string, SourceBadge[]>();
    for (const source of this.registry.list()) {
      const read = await this.read(source);
      // A source whose files cannot be read shows as broken in Sources and lists nothing.
      if ("problem" in read) continue;
      if (!this.registry.isEnabled(source, read.state) && !bound?.has(source.id)) continue;
      shown.push(source);
      badges.set(source.id, badgesOf(source.url, acknowledgedOf(source, read.state)));
      if (read.snapshot) snapshots.set(source.id, read.snapshot);
    }
    const rows = aggregateCatalog(
      shown.filter((source) => snapshots.has(source.id)).map((source) => ({ sourceId: source.id, sourceOrigin: source.origin, snapshot: snapshots.get(source.id)! })),
      this.options.versionContext(),
    );
    return { rows, snapshots, shown, badges };
  }

  private entry(row: CatalogRow, installed: InstalledPackage | null, rows: readonly CatalogRow[], sources: ReadonlySet<string>, label: string, badges: readonly SourceBadge[]): CatalogEntryView {
    return {
      key: { sourceId: row.sourceId, kind: row.kind, name: row.name },
      sourceOrigin: row.sourceOrigin,
      sourceLabel: label,
      displayName: row.package.displayName ?? row.name,
      description: row.package.description ?? "",
      keywords: [...(row.package.keywords ?? [])],
      state: rowState(row, installed, rows, sources),
      required: lockedByPolicy(this.policy, row.kind, row.name, row.sourceId) !== undefined,
      runsCode: runsCode(row.kind, (row.choice.state === "candidate" ? row.choice.version : row.package.versions[0])?.components),
      sourceBadges: [...badges],
    };
  }

  async catalog(query: CatalogQuery): Promise<CatalogView> {
    return this.operation(() => this.catalogNow(query));
  }

  private async catalogNow(query: CatalogQuery): Promise<CatalogView> {
    const installedAll = await this.installedAll();
    // The Installed view reads hidden sources its packages are bound to, so their updates show (§7.3).
    const bound = query.installedOnly ? new Set(installedAll.flatMap((item) => (item.sourceId === null ? [] : [item.sourceId]))) : undefined;
    const { rows, snapshots, shown, badges } = await this.rows(bound);
    const installed = new Map(installedAll.map((item) => [keyOf(item.kind, item.name), item]));
    const existing = new Set(this.registry.list().map((source) => source.id));
    const labels = new Map(shown.map((source) => [source.id, sourceLabel(source, snapshots.get(source.id) ?? null)]));
    const text = query.query?.trim().toLowerCase() ?? "";
    const matches = (entry: CatalogEntryView) =>
      (!query.sourceId || entry.key.sourceId === query.sourceId) &&
      (!text || [entry.key.name, entry.displayName, entry.description, ...entry.keywords].some((field) => field.toLowerCase().includes(text)));

    let entries = rows.map((row) => this.entry(row, installed.get(keyOf(row.kind, row.name)) ?? null, rows, existing, labels.get(row.sourceId) ?? row.sourceId, badges.get(row.sourceId) ?? []));
    if (query.installedOnly) {
      entries = entries.filter((entry) => {
        const item = installed.get(keyOf(entry.key.kind, entry.key.name));
        return item !== undefined && item.sourceId === entry.key.sourceId;
      });
      // Installed packages whose source is gone or shows no row (§7.6): listed so they can be uninstalled.
      const listed = new Set(entries.map((entry) => keyOf(entry.key.kind, entry.key.name)));
      for (const item of installed.values()) {
        if (listed.has(keyOf(item.kind, item.name))) continue;
        if (item.sourceId === null) {
          entries.push({
            key: { sourceId: null, kind: item.kind, name: item.name },
            sourceOrigin: null,
            sourceLabel: null,
            displayName: item.name,
            description: "",
            keywords: [],
            state: { state: "unbound", version: item.version },
            required: false,
            runsCode: runsCode(item.kind),
            sourceBadges: [],
          });
          continue;
        }
        entries.push({
          key: { sourceId: item.sourceId, kind: item.kind, name: item.name },
          sourceOrigin: this.registry.get(item.sourceId)?.origin ?? "custom",
          sourceLabel: labels.get(item.sourceId) ?? item.sourceId,
          displayName: item.name,
          description: "",
          keywords: [],
          state: existing.has(item.sourceId) ? { state: "installed", version: item.version } : { state: "source-removed", version: item.version },
          required: lockedByPolicy(this.policy, item.kind, item.name, item.sourceId) !== undefined,
          runsCode: runsCode(item.kind),
          sourceBadges: badges.get(item.sourceId) ?? [],
        });
      }
    }
    entries = entries.filter(matches);
    const counts = Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, 0])) as Record<PackageKind, number>;
    for (const entry of entries) counts[entry.key.kind] += 1;
    const syncedAt = [...snapshots.values()].map((snapshot) => snapshot.fetchedAt).sort().pop() ?? null;
    return {
      entries: query.kind ? entries.filter((entry) => entry.key.kind === query.kind) : entries,
      counts,
      sourceCount: shown.length,
      syncedAt,
    };
  }

  /**
   * The catalog row of `key`. A hidden source is read only for a package
   * installed from it: its update is offered (§7.3), so its detail opens.
   * A plan from a hidden source, install or update, is refused
   * (SOURCE_DISABLED) until the source is shown again.
   */
  private async row(key: PackageKeyView): Promise<{ row: CatalogRow; rows: CatalogRow[]; snapshot: SourceSnapshot; label: string; badges: SourceBadge[] }> {
    const installed = await this.installed(key.kind, key.name);
    const bound = installed?.sourceId === key.sourceId ? new Set([key.sourceId]) : undefined;
    const { rows, snapshots, shown, badges } = await this.rows(bound);
    const row = rows.find((item) => item.sourceId === key.sourceId && item.kind === key.kind && item.name === key.name);
    const snapshot = snapshots.get(key.sourceId);
    const source = shown.find((item) => item.id === key.sourceId);
    if (!row || !snapshot || !source) {
      throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${key.sourceId} does not list ${key.kind} ${key.name}`);
    }
    return { row, rows, snapshot, label: sourceLabel(source, snapshot), badges: badges.get(source.id) ?? [] };
  }

  private async installed(kind: PackageKind, name: string): Promise<InstalledRecord | null> {
    return (await this.installedAll()).find((item) => item.kind === kind && item.name === name) ?? null;
  }

  /** Whether the tree rung is declared: `artifact.tree`, or a plugin.json in the package directory (§6.2). */
  private async treeDeclared(sourceId: string, version: IndexVersion, packagePath: string): Promise<boolean> {
    if (version.artifact?.tree !== undefined) return true;
    const manifest = packagePath ? `${packagePath}/plugin.json` : "plugin.json";
    return this.options.syncer.withRepository(sourceId, async ({ repo }) =>
      (await repo.lsTree(version.commit, manifest, false)).some((entry) => entry.path === manifest && entry.type === "blob"),
    );
  }

  async detail(key: PackageKeyView): Promise<PackageDetailView> {
    return this.operation(() => this.detailNow(key));
  }

  private async detailNow(key: PackageKeyView): Promise<PackageDetailView> {
    const { row, rows, snapshot, label, badges } = await this.row(key);
    const installed = await this.installed(key.kind, key.name);
    const existing = new Set(this.registry.list().map((source) => source.id));
    const context = this.options.versionContext();
    const shownVersion = row.choice.state === "candidate" ? row.choice.version : row.package.versions[0] ?? null;
    const installedHere = installed?.sourceId === key.sourceId ? installed.version : null;
    return {
      entry: this.entry(row, installed, rows, existing, label, badges),
      provenance: {
        sourceLabel: label,
        repository: this.source(key.sourceId).url.url,
        path: row.package.path,
        snapshotCommit: row.snapshotCommit,
        versionCommit: shownVersion?.commit ?? null,
        publishedAt: shownVersion?.publishedAt ?? null,
      },
      compatibility: {
        minAppVersion: shownVersion?.minAppVersion ?? null,
        appVersion: context.appVersion,
        compatible: shownVersion ? appVersionSatisfiesMin(context.appVersion, shownVersion.minAppVersion) : false,
      },
      authority: shownVersion?.authority ? authorityView(shownVersion.authority) : null,
      components: shownVersion?.components ?? null,
      rungs:
        row.kind === "plugin" && shownVersion?.artifact
          ? rungViews(shownVersion.artifact, row.package.path, await this.treeDeclared(key.sourceId, shownVersion, row.package.path), this.source(key.sourceId).url)
          : [],
      versions: versionViews(row, effectiveRevocations(snapshot, context.appVersion), context, installedHere),
    };
  }

  // ─── plans and installs ─────────────────────────────────────────────────

  /** The version to install: the candidate, or a listed version the user chose (a rollback). */
  private chosenVersion(row: CatalogRow, snapshot: SourceSnapshot, requested: string | undefined): IndexVersion {
    if (requested === undefined) return candidateVersion(row);
    const version = row.package.versions.find((item) => item.version === requested);
    if (!version) throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.sourceId} does not list ${row.name} ${requested}`);
    const context = this.options.versionContext();
    const blocking = versionExclusions(row.sourceId, row.kind, row.name, version, effectiveRevocations(snapshot, context.appVersion), context)
      // Choosing a version by hand overrides the rollout and the pre-release opt-in, nothing else.
      .filter((reason) => reason !== "rollout" && reason !== "prerelease");
    if (blocking.includes("revoked")) throw new MarketplaceError("PACKAGE_REVOKED", `${row.name} ${requested} is revoked by ${row.sourceId}`);
    if (blocking.includes("yanked")) throw new MarketplaceError("PACKAGE_YANKED", `${row.name} ${requested} is yanked`);
    if (blocking.length > 0) {
      // The first exclusion in §6.1 order names the sentence; the message keeps all of them.
      const first = blocking[0]!;
      const detail: MarketplaceErrorDetail<"PACKAGE_INCOMPATIBLE"> | undefined =
        first === "min_app_version" ? { reason: first, name: row.name, version: version.minAppVersion }
          : first === "platform" ? { reason: first, name: row.name, platform: context.platform }
            : first === "host_protocol" ? { reason: first, name: row.name }
              : undefined;
      throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.name} ${requested} cannot be installed here (${blocking.join(", ")})`, detail ? { detail } : undefined);
    }
    return version;
  }

  private repositoryAccess<T>(sourceId: string, fn: (access: { repo: BareRepo; remote: GitRemote; direct: boolean }) => Promise<T>): Promise<T> {
    return this.options.syncer.withRepository(sourceId, ({ source, repo, remote }) => fn({ repo, remote, direct: source.origin === "direct" }));
  }

  async planInstall(request: InstallPlanRequest): Promise<InstallPlanView> {
    return this.operation(() => this.plan(request, false));
  }

  /** `adopt` (content only): the install records an activation the settings already hold (§16.3). */
  private async plan(request: InstallPlanRequest, adopt: boolean): Promise<InstallPlanView> {
    const { row, snapshot } = await this.row(request);
    // Refused at the plan, before the review asks to confirm, not at execution (§7.3).
    const source = this.source(row.sourceId);
    if (!this.registry.isEnabled(source, await this.registry.readState(source.id))) {
      throw new MarketplaceError("SOURCE_DISABLED", `source ${source.id} is hidden; show it again to install or update from it`);
    }
    const version = this.chosenVersion(row, snapshot, request.version);
    const installed = await this.installed(row.kind, row.name);
    const switchSource = request.switchSource === true;
    const required = requiredByPolicy(this.policy, row.kind, row.name);
    if (required && required.source !== row.sourceId && installed) {
      throw new MarketplaceError("PACKAGE_REQUIRED_BY_POLICY", `${row.kind} ${row.name} is required from ${required.source} by policy`);
    }
    const base = planPackage(row, version);
    const action = classifyInstall(base, installed, { switchSource });
    const policyDigest = this.options.policy.digest;
    let held: HeldPlan;
    let mcp: McpRuntimeView | null = null;
    let rungs: InstallPlanView["rungs"] = [];
    if (row.kind === "plugin") {
      const plan = planPluginVersion(row, version);
      held = { kind: "plugin", plan, switchSource, policyDigest };
      rungs = rungViews(plan.artifact, plan.packagePath, await this.treeDeclared(row.sourceId, version, row.package.path), source.url);
    } else if (row.kind === "mcp") {
      const plan = { ...base, kind: "mcp" as const };
      // Resolved now so the review shows the command that will run.
      const resolved = await this.repositoryAccess(row.sourceId, (access) =>
        resolveMcpPackage(plan, { ...access, limits: this.options.mcpLimits, workRoot: this.options.workRoot }),
      );
      this.options.installers.mcp.admit(row.name, resolved.runtime);
      held = { kind: "mcp", resolved, switchSource, policyDigest };
      mcp = mcpRuntimeView(resolved.runtime);
    } else {
      held = { kind: "content", plan: base as ContentPlan, switchSource, adopt, policyDigest };
    }
    // One live plan per package: planning again (another version, a source switch) drops the older one and its files.
    const ticket = this.plans.issue(held, `${row.sourceId}:${row.kind}:${row.name}`);
    return {
      planId: ticket.id,
      expiresAt: ticket.expiresAt,
      key: { sourceId: row.sourceId, kind: row.kind, name: row.name },
      displayName: row.package.displayName ?? row.name,
      version: version.version,
      snapshotCommit: row.snapshotCommit,
      versionCommit: version.commit,
      action: installActionView(action),
      runsCode: runsCode(row.kind, version.components),
      authority: version.authority ? authorityView(version.authority) : null,
      components: version.components ?? null,
      hookConfinement: isAsrtSandboxActive()
        ? process.platform === "win32" ? "unavailable" : "sandboxed"
        : "user-permissions",
      rungs,
      mcp,
    };
  }

  /** The update review (§15.6): commit range, authority delta, and rewritten history pending review. */
  async planUpdate(key: PackageKeyView): Promise<UpdatePlanView> {
    return this.operation(() => this.planUpdateNow(key));
  }

  private async planUpdateNow(key: PackageKeyView): Promise<UpdatePlanView> {
    const installed = await this.installed(key.kind, key.name);
    if (!installed || installed.sourceId !== key.sourceId) {
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is not installed from ${key.sourceId}`);
    }
    const state = await this.registry.readState(key.sourceId);
    const source = this.source(key.sourceId);
    const historyRewritten =
      state.pendingRewrite && (source.origin === "custom" || source.origin === "direct")
        ? { pinned: state.pinnedCommit, candidate: state.pendingRewrite.candidate }
        : null;
    const plan = await this.planInstall(key);
    let delta: UpdatePlanView["authorityDelta"] = null;
    let componentsDelta: UpdatePlanView["componentsDelta"] = null;
    if (key.kind === "plugin" && plan.authority) {
      const { row } = await this.row(key);
      const listed = row.package.versions.find((item) => item.version === installed.version)?.authority;
      const previous: PluginAuthority | null = listed ?? (await this.options.installers.plugin.installedAuthority(key.name));
      delta = authorityDelta(previous ? authorityView(previous) : authorityView({ capabilities: [] }), plan.authority);
    }
    if (key.kind === "agent-plugin" && plan.components) {
      const previous = await this.options.installers.content.installedComponents(key.name);
      componentsDelta = componentDelta(previous, plan.components);
    }
    return {
      ...plan,
      from: installed.version,
      commitRange: { from: installed.originCommit, to: plan.snapshotCommit },
      authorityDelta: delta,
      componentsDelta,
      historyRewritten,
      needsConfirmation: widensAuthority(delta) || historyRewritten !== null,
    };
  }

  private progress(planId: string, phase: InstallProgressView["phase"], rung: InstallProgressView["rung"] = null): void {
    this.options.onInstallProgress?.({ planId, phase, rung, bytes: null, total: null });
  }

  async executeInstall(planId: string, componentConsents: readonly ComponentConsent[] = [], reviewedAuthority = false): Promise<InstallResultView> {
    return this.operation(() => this.executeInstallNow(planId, componentConsents, reviewedAuthority));
  }

  private async executeInstallNow(planId: string, componentConsents: readonly ComponentConsent[], reviewedAuthority: boolean): Promise<InstallResultView> {
    const held = this.plans.take(planId);
    // Reviewed under another policy: what it allows may have changed, so the review reopens (§18.6).
    if (held.policyDigest !== this.options.policy.digest) {
      throw new MarketplaceError("PLAN_EXPIRED", `plan ${planId} was made under another marketplace policy`, { detail: { reason: "policy-changed" } });
    }
    // The gates must judge the new install by the source it is about to be bound to, not the one it leaves.
    const target = heldTarget(held);
    const key = keyOf(target.kind, target.name);
    this.pendingBindings.set(key, target);
    try {
      await this.feedRevocations();
      if (componentConsents.length > 0 && (held.kind !== "content" || held.plan.kind !== "agent-plugin")) {
        throw new Error("component consent applies only to an agent plugin install");
      }
      return await this.runInstall(planId, held, componentConsents, reviewedAuthority);
    } finally {
      if (this.pendingBindings.get(key) === target) this.pendingBindings.delete(key);
      await this.refeedAfter(`${target.kind} ${target.name} install`);
    }
  }

  private async runInstall(planId: string, held: HeldPlan, componentConsents: readonly ComponentConsent[], reviewedAuthority: boolean): Promise<InstallResultView> {
    this.progress(planId, "resolving");
    let result: InstallResultView;
    if (held.kind === "plugin") {
      const { plan } = held;
      const outcome = await this.options.installers.plugin.install(plan, {
        switchSource: held.switchSource,
        ...(reviewedAuthority ? { reviewedAppVersion: getAveAppVersion() } : {}),
        stage: (staged) =>
          this.options.syncer.withRepository(plan.sourceId, async ({ source, repo, remote }) => {
            this.progress(planId, "downloading");
            return runPluginLadder(staged, {
              repo,
              remote,
              direct: source.origin === "direct",
              sourceUrl: source.url,
              gate: this.options.gate,
              catalog: await this.catalogSource(source),
              sourceToken: this.tokenFor(source),
              tokenMissing: source.auth.kind === "token" && this.tokenFor(source) === null,
              zip: this.options.ladder.zip,
              limits: this.options.ladder.limits,
              workRoot: this.options.workRoot,
              artifacts: this.options.ladder.artifacts,
            });
          }).then((staged) => {
            this.progress(planId, "installing", staged.rung);
            return staged;
          }),
      });
      result = {
        key: { sourceId: plan.sourceId, kind: "plugin", name: plan.name },
        version: plan.version,
        action: installActionView(outcome.action),
        rungs: rungOutcomeViews(outcome.staged.rungs),
        connectionWarning: null,
      };
    } else if (held.kind === "content") {
      const { plan } = held;
      this.progress(planId, "downloading");
      const staged = await this.repositoryAccess(plan.sourceId, (access) =>
        stageContentPackage(plan, access, { workRoot: this.options.workRoot, english: this.options.english }),
      );
      this.progress(planId, "installing");
      const outcome = await this.options.installers.content.install(staged, { switchSource: held.switchSource, adopt: held.adopt, componentConsents });
      result = { key: { sourceId: plan.sourceId, kind: plan.kind, name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: null };
    } else if (held.kind === "mcp") {
      const { plan } = held.resolved;
      this.progress(planId, "installing");
      const outcome = await this.options.installers.mcp.install(held.resolved, { switchSource: held.switchSource });
      result = { key: { sourceId: plan.sourceId, kind: "mcp", name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: outcome.connectionWarning };
    } else {
      this.progress(planId, "installing");
      const { connectionWarning } = await this.options.installers.mcp.installUnbound(held.name, held.runtime);
      result = { key: { sourceId: null, kind: "mcp", name: held.name }, version: null, action: { action: "install" }, rungs: [], connectionWarning };
    }
    this.options.onCatalogChanged?.();
    return result;
  }

  /** The source as its catalog's downloads are judged (§18.2.3). */
  private async catalogSource(source: ResolvedSource): Promise<CatalogSource> {
    const snapshot = await this.options.syncer.readSnapshot(source.id);
    return { id: source.id, label: sourceLabel(source, snapshot), url: source.url, acknowledged: await this.registry.acknowledged(source) };
  }

  /** The stored token a token-auth source's release downloads go through the REST API with (§6.2), or null. */
  private tokenFor(source: ResolvedSource): string | null {
    return source.auth.kind === "token" ? this.options.tokens.get(source.auth.host) : null;
  }

  async getRetirementEntry(pluginId: string): Promise<RetirementEntry | null> {
    let found: RetirementEntry | null = null;
    const appVersion = this.options.versionContext().appVersion;
    for (const source of this.options.registry.list()) {
      const snapshot = await this.options.syncer.readSnapshot(source.id);
      if (!snapshot) continue;
      for (const entry of effectiveRevocations(snapshot, appVersion)) {
        if (entry.kind !== "plugin" || entry.name !== pluginId || !entry.successors) continue;
        if (found && (found.sourceId !== source.id || !isDeepStrictEqual(found.successors, entry.successors))) {
          throw new Error("Conflicting plugin retirement entries");
        }
        found = { sourceId: source.id, successors: structuredClone(entry.successors) };
      }
    }
    return found;
  }

  async uninstall(request: UninstallRequest, options?: { retain: { reason: PluginConfigRetention["reason"] } }): Promise<UninstallResultView> {
    return this.operation(() => this.uninstallNow(request, options));
  }

  private async uninstallNow(request: UninstallRequest, options?: { retain: { reason: PluginConfigRetention["reason"] } }): Promise<UninstallResultView> {
    if (request.removeData === true && request.kind !== "mcp" && request.kind !== "agent-plugin") {
      throw new Error("removeData applies only to server or agent plugin packages");
    }
    assertNotRequiredByPolicy(this.policy, request.kind, request.name, request.sourceId, "uninstall");
    const installed = await this.installed(request.kind, request.name);
    if (!installed || installed.sourceId !== request.sourceId) {
      const from = request.sourceId === null ? "without a source" : `from ${request.sourceId}`;
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${request.kind} ${request.name} is not installed ${from}`);
    }
    let keptDataDir: string | null = null;
    if (request.kind === "plugin") {
      let retain: PluginConfigRetention | undefined;
      if (options?.retain) {
        const entry = await this.getRetirementEntry(request.name);
        if (!entry || (request.sourceId !== null && entry.sourceId !== request.sourceId)) throw new Error("Plugin retirement entry is unavailable");
        retain = { reason: options.retain.reason, sourceId: request.sourceId, successors: entry.successors };
      }
      await this.options.installers.plugin.uninstall(request.name, retain);
    } else if (request.kind === "mcp") ({ keptDataDir } = await this.options.installers.mcp.uninstall(request.name, { removeData: request.removeData === true }));
    else await this.options.installers.content.uninstall(request.kind, request.name, { removeData: request.removeData === true });
    await this.refeedAfter(`${request.kind} ${request.name} uninstall`);
    this.options.onCatalogChanged?.();
    return { key: { sourceId: request.sourceId, kind: request.kind, name: request.name }, keptDataDir };
  }

  // ─── direct MCP input (§8.1) ─────────────────────────────────────────────

  previewDirectMcp(request: DirectMcpPreviewRequest): DirectMcpPreviewView {
    let document: unknown;
    try {
      document = parseStrictJson(request.serverJson);
    } catch (error) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `server.json does not parse: ${(error as Error).message}`);
    }
    const record = typeof document === "object" && document !== null && !Array.isArray(document) ? (document as Record<string, unknown>) : null;
    if (!record || typeof record.name !== "string" || typeof record.version !== "string") {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", "server.json needs a name and a version");
    }
    const name = idFrom(record.name.slice(record.name.lastIndexOf("/") + 1));
    if (!name) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `server.json name ${record.name} does not end in a usable name`);
    const runtime = runtimeFromServerJson(document, request.select);
    assertMcpRuntimePinned(name, runtime);
    this.options.installers.mcp.admit(name, runtime);
    const ticket = this.plans.issue({ kind: "mcp-unbound", name, runtime, policyDigest: this.options.policy.digest }, `unbound:mcp:${name}`);
    return {
      planId: ticket.id,
      expiresAt: ticket.expiresAt,
      name,
      version: record.version,
      runtime: mcpRuntimeView(runtime),
      options: {
        packages: Array.isArray(record.packages) ? record.packages.length : 0,
        remotes: Array.isArray(record.remotes) ? record.remotes.length : 0,
      },
    };
  }

  // ─── boot and periodic work (§7.3, §10.2) ─────────────────────────────────

  /** Installed packages whose bound source offers a newer version, hidden sources included (§7.3). */
  async updates(): Promise<PackageUpdateView[]> {
    return this.operation(() => this.updatesNow());
  }

  private async updatesNow(): Promise<PackageUpdateView[]> {
    const installed = await this.installedAll();
    const bound = new Set(installed.map((item) => item.sourceId).filter((sourceId): sourceId is string => sourceId !== null));
    const { rows } = await this.rows(bound);
    const existing = new Set(this.registry.list().map((source) => source.id));
    const updates: PackageUpdateView[] = [];
    for (const item of installed) {
      if (item.sourceId === null || item.version === null) continue;
      const state = updateFor({ ...item, version: item.version }, rows, existing);
      if (state.state !== "update") continue;
      updates.push({
        key: { sourceId: item.sourceId, kind: item.kind, name: item.name },
        displayName: state.row.package.displayName ?? item.name,
        from: item.version,
        to: state.version,
      });
    }
    return updates;
  }

  /**
   * Default and required installs (§10.2), each through the normal plan: the
   * ladder, verification and receipt. Returns the report and the notice the
   * boot publishes (null when nothing changed).
   */
  async applyBootInstalls(defaults: readonly PackageKey[], applied: AppliedDefaults): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }> {
    return this.operation(() => this.applyBootInstallsNow(defaults, applied));
  }

  private async applyBootInstallsNow(defaults: readonly PackageKey[], applied: AppliedDefaults): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }> {
    // First: a former admin install it binds is recorded as applied, so the defaults below leave it be.
    const legacy = await runLegacyMigration({
      markerPath: this.options.legacyMigration.markerPath,
      officialSnapshot: await this.options.syncer.readSnapshot(OFFICIAL_MARKETPLACE.id),
      plugins: (officialPlugin) => this.options.legacyMigration.plugins(officialPlugin, applied),
      content: (listed) =>
        this.options.legacyMigration.content({
          listed,
          installed: async (kind, name) => (await this.installed(kind, name)) !== null,
          adopt: async (kind, name) => {
            const plan = await this.plan({ sourceId: OFFICIAL_MARKETPLACE.id, kind, name }, true);
            await this.executeInstall(plan.planId);
          },
        }),
      now: () => this.now(),
    });
    await this.enforceRevocations();
    const revoked = this.revokedUnreported.splice(0);
    const { rows, snapshots, shown } = await this.rows();
    const synced = new Map<string, SourceOrigin>(shown.filter((source) => snapshots.has(source.id)).map((source) => [source.id, source.origin]));
    const report = await runBootInstalls({
      policy: this.policy,
      defaults,
      rows,
      synced,
      installed: (kind, name) => this.installed(kind, name),
      install: async (row, options) => {
        const plan = await this.planInstall({ sourceId: row.sourceId, kind: row.kind, name: row.name, ...(options.switchSource ? { switchSource: true } : {}) });
        await this.executeInstall(plan.planId, [], options.required);
      },
      applied,
      now: () => this.now(),
    });
    return { report, notice: bootInstallNoticeFrom(report, this.policy, legacy?.plugins ?? null, revoked) };
  }

  /**
   * Enforce the revocations the local snapshots carry (§10.4): feed the
   * gates, remove what a gate cannot hold, and queue what that did for the
   * next notice ({@link takeRevocationNotice}). Each outcome is queued once a
   * session. Runs on every sync and before the boot pass syncs, so a
   * revocation already on disk never waits for the network.
   */
  async enforceRevocations(): Promise<void> {
    return this.operation(() => this.enforceRevocationsNow());
  }

  private async enforceRevocationsNow(): Promise<void> {
    const run = this.enforceTail.then(() => this.applyRevocations(), () => this.applyRevocations());
    this.enforceTail = run.catch(() => undefined);
    for (const item of await run) {
      const id = `${item.key.sourceId}/${item.key.kind}/${item.key.name}@${item.version}:${item.outcome}`;
      if (this.revokedQueued.has(id)) continue;
      this.revokedQueued.add(id);
      this.revokedUnreported.push(item);
    }
  }

  /** What enforcement did since the last notice, as a notice of its own; null when nothing. */
  takeRevocationNotice(): BootInstallNoticeView | null {
    const revoked = this.revokedUnreported.splice(0);
    return revoked.length === 0 ? null : { forYou: [], required: [], unmanaged: [], lostGrants: [], revoked };
  }

  /**
   * Feed the gates again after an install or removal. The operation is done
   * either way, so a failed feed is logged rather than reported as its
   * failure; the gates keep the last feed until the next one.
   */
  private async refeedAfter(operation: string): Promise<void> {
    try {
      await this.feedRevocations();
    } catch (error) {
      this.options.log.warn(`revocation feed after ${operation} failed; the gates keep the previous feed: ${errorMessage(error)}`);
    }
  }

  /** Feed the gates (one feed at a time) and return the installed versions the feed revokes. */
  private feedRevocations(): Promise<RevokedInstall[]> {
    const run = this.feedTail.then(() => this.feedOnce(), () => this.feedOnce());
    this.feedTail = run.catch(() => undefined);
    return run;
  }

  /**
   * Feed the load gates each installed package's own source's revocations
   * (§10.4) — an install in flight counts as bound to the source it is moving
   * to — and return the settled installs they cover. An install in flight is
   * never returned: what it replaces is judged once it lands.
   */
  private async feedOnce(): Promise<RevokedInstall[]> {
    const installed = await this.installedAll();
    const pending = [...this.pendingBindings.entries()];
    const inFlight = new Set(pending.map(([key]) => key));
    const bound: BoundInstall[] = installed.flatMap((item) =>
      item.sourceId !== null && !inFlight.has(keyOf(item.kind, item.name)) ? [{ kind: item.kind, name: item.name, sourceId: item.sourceId }] : [],
    );
    for (const [, binding] of pending) {
      if (binding.sourceId !== null) bound.push({ kind: binding.kind, name: binding.name, sourceId: binding.sourceId });
    }
    const feed = await revocationFeed(bound, (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    await this.options.revocations.apply(feed);
    const revoked: RevokedInstall[] = [];
    for (const record of installed) {
      if (record.sourceId === null || record.version === null || inFlight.has(keyOf(record.kind, record.name))) continue;
      const sourceId = record.sourceId;
      const revocation = findRevocation(record.kind, record.name, record.version, feed.rules.filter((rule) => rule.sourceId === sourceId));
      if (revocation) revoked.push({ record: { ...record, sourceId }, revocation });
    }
    return revoked;
  }

  /**
   * Feed the gates, then remove what a gate cannot hold — every `uninstall`
   * revocation, and a `disable` one for a kind outside {@link GATED_KINDS}.
   * A package a `requiredInstalls` entry locks ({@link lockedByPolicy}) stays
   * (gated where its kind has a gate) and is reported.
   */
  private async applyRevocations(): Promise<RevokedPackageView[]> {
    const report: RevokedPackageView[] = [];
    for (const { record, revocation } of await this.feedRevocations()) {
      if (revocation.action === "disable" && GATED_KINDS.has(record.kind)) continue;
      const item = { key: { sourceId: record.sourceId, kind: record.kind, name: record.name }, version: record.version!, reason: revocation.reason };
      try {
        const retaining = record.kind === "plugin" && revocation.action === "uninstall" && revocation.successors !== undefined;
        if (retaining) {
          await this.options.installers.plugin.retire(record.name, {
            reason: "revoked", sourceId: record.sourceId, successors: revocation.successors!,
          });
        }
        if (lockedByPolicy(this.policy, record.kind, record.name, record.sourceId)) {
          report.push({ ...item, outcome: "required" });
          continue;
        }
        await this.uninstall({ sourceId: record.sourceId, kind: record.kind, name: record.name },
          retaining ? { retain: { reason: "revoked" } } : undefined);
        report.push({ ...item, outcome: "uninstalled" });
      } catch (error) {
        report.push({ ...item, outcome: "failed", message: errorMessage(error) });
      }
    }
    return report;
  }

  /** Drop every preview clone and plan (shutdown). */
  close(): void {
    this.previews.clear();
    this.plans.clear();
  }
}
