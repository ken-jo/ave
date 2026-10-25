/** Binds single-use install plans to reviewed snapshot and version commits. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { isPluginWorkerConfinementActive } from "../../permissions/asrt-sandbox.js";
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
  PackageUpdateOffer,
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
  ReviewComponentView,
  ReviewedComponentConsent,
  ExtensionComponentConsent,
  ConsentDelta,
  UnmetRequirementInstall,
  UnmetRequirementView,
} from "../../shared/git-marketplace.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { AGENT_PLUGIN_DECLARATION_PATHS, extensionDeclarationPaths, type PayloadFile } from "../../plugins/contribution-approval-digest.js";
import { packageUpdateSkipKey } from "../../shared/skipped-plugin-updates.js";
import { aggregateCatalog, findRevocation, versionExclusions, type CatalogRow, type VersionChoiceContext } from "../catalog/aggregate.js";
import { hasVersionTree, PACKAGE_KINDS, type AgentPluginComponents, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { credentialRefusal } from "../catalog/validate.js";
import { stageContentPackage, stagedConsent, type StagedContent } from "../content/store.js";
import { componentDelta } from "./component-delta.js";
import { errorMessage } from "../../shared/error-message.js";
import { holdsCredential } from "../../shared/dlp.js";
import { ConfirmationRequiredError, MarketplaceError, isMarketplaceError, type EnteredTargetWarningView, type MarketplaceErrorDetail } from "../errors.js";
import { BareRepo, type ExportLimits } from "../git/repo.js";
import type { GitCommands, GitRemote } from "../git/run-git.js";
import type { CatalogSource, NetworkGate } from "../net/network-gate.js";
import { classifyFolder, normalizeSourceInput, resolveFolderRoot, type FolderIdentity, type FolderNetwork, type FolderRoot } from "../net/source-input.js";
import { normalizeSourceHost, type NormalizedSourceUrl } from "../net/source-url.js";
import { candidateVersion, planPackage, type PackagePlan, type RepositoryAccess } from "../resolve/descriptor.js";
import { classifyInstall, compareVersions, updateFor, type InstalledPackage } from "../resolve/identity.js";
import { assertMcpRuntimePinned, resolveMcpPackage, runtimeFromServerJson, type ResolvedMcpServer } from "../resolve/mcp.js";
import { planPluginVersion, runFolderRung, runPluginLadder, type LadderDeps, type PluginInstallPlan, type StagedPluginArtifact } from "../resolve/plugin-ladder.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";
import {
  assertNotRequiredByPolicy,
  bootInstallNoticeFrom,
  lockedByPolicy,
  requiredByPolicy,
  requirementGap,
  runBootInstalls,
  type BootInstallReport,
  type RequirementSourceState,
} from "../boot-installs/run.js";
import type { LegacyContentKind, LegacyContentReport } from "../migration/legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "../migration/legacy-plugins.js";
import { runLegacyMigration } from "../migration/run.js";
import { readDirectPackage } from "../sources/direct-package.js";
import { isReservedSourceId, isSourceId, OFFICIAL_MARKETPLACE, type SourceAuth } from "../sources/official.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PackageKey, type PolicySource, type PolicyUpdate } from "../sources/policy.js";
import type { FolderFs } from "../sources/folder-fs.js";
import { FolderTree } from "../sources/folder-tree.js";
import { confirmationsFor, sourceIdentity, type GitSource, type ResolvedSource, type SourceOrigin, type SourceRegistry, type SourceState } from "../sources/registry.js";
import { SnapshotBuilder, type SourceSnapshot } from "../sources/snapshot.js";
import { gitAccess, GitTree, rootNameOf, StagedTree, stagedAccess } from "../sources/source-tree.js";
import { openStoredFolder, shouldSyncSource, type SourceSyncer, type SyncResult } from "../sources/sync.js";
import type { SyncDiscovery } from "../updates/history.js";
import { catalogDelta, isCodeFreeChange, mcpConsent, pluginConsent, requireConsentEqual, stagedDelta, withChangedFiles, type ConsentFingerprint } from "../updates/consent.js";
import { classifyApplyError, type ApplyOutcome } from "../updates/apply.js";
import { requiresPackage, type UpdateChange, type UpdateFacts } from "../updates/eligibility.js";
import type { PluginConfigRetention } from "../../plugins/retired-config.js";
import { holdsAnyPluginInstallLock } from "../../plugins/install-lifecycle.js";
import type { RetirementEntry, RetirementEntryLookup } from "./retirement-entry.js";
import { effectiveRevocations } from "../catalog/effective-revocations.js";
import { revocationFeed, type BoundInstall, type RevocationFeed } from "./revocations.js";
import { OperationLock } from "./operation-lock.js";
import { KeyedMutex, type MutexLease } from "./keyed-mutex.js";
import { Tickets } from "./tickets.js";
import type { ComponentApprovalState, InstallerPorts, InstalledRecord, TokenStore } from "./ports.js";
import {
  authorityDelta,
  authorityView,
  brokenStatus,
  installActionView,
  rowState,
  rungOutcomeViews,
  stagedRungViews,
  folderRungView,
  rungViews,
  runsCode,
  sourceStatus,
  versionViews,
  widensAuthority,
} from "./views.js";

/** Stored source identity, never a view handle. */
export interface StoredInstallKey {
  sourceId: string | null;
  kind: PackageKind;
  name: string;
}

type ContentPlan = PackagePlan & { kind: Exclude<PackageKind, "plugin" | "mcp"> };

/** A folder plan owns a staged capture, removed when consumed or dropped. */
interface CapturedFolder {
  dir: string;
  access: RepositoryAccess;
  notInstalled: string[];
}

/** A pre-lock decision remains valid only while the installed receipt identity is unchanged. */
type InstallIdentity = { sourceId: string | null; version: string | null; originCommit: string | null; digest: string | null } | null;

/** Detail prefers the candidate, then the newest tree, then a legacy pin without a tree. */
function shownVersionOf(row: CatalogRow): IndexVersion | null {
  if (row.choice.state === "candidate") return row.choice.version;
  return row.package.versions.find(hasVersionTree) ?? row.package.versions[0] ?? null;
}

function installIdentity(record: InstalledRecord | null): InstallIdentity {
  return record ? { sourceId: record.sourceId, version: record.version, originCommit: record.originCommit, digest: record.digest ?? null } : null;
}

/** Plans expire on policy or installed-identity changes; direct servers replace only unbound servers. */
type HeldPlan = { policyDigest: string; folder: CapturedFolder | null } & (
  /** Execution reuses these reviewed bytes without another download. */
  | { kind: "plugin"; plan: PluginInstallPlan; switchSource: boolean; installed: InstallIdentity; staged?: StagedPluginArtifact }
  | { kind: "content"; plan: ContentPlan; switchSource: boolean; adopt: boolean; installed: InstallIdentity; staged?: StagedContent }
  | { kind: "mcp"; resolved: ResolvedMcpServer; switchSource: boolean; installed: InstallIdentity }
  | { kind: "mcp-unbound"; name: string; runtime: McpRuntimeSpec }
);

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

/** Reviewed and required installs record the current app version; automatic updates retain the baseline. */
interface StagedReview {
  consent: ConsentFingerprint;
  files: PayloadFile[] | null;
  components: AgentPluginComponents | null;
  declaring: ReadonlySet<string>;
}

interface InstallReview {
  reviewedAppVersion: string | null;
  assertConsent?: (consent: ConsentFingerprint) => void;
}

interface InstalledBaseline {
  consent: ConsentFingerprint;
  /** The receipt's `reviewedAppVersion` (extensions); an automatic update keeps it. */
  reviewedAppVersion: string | null;
  enabled: boolean;
  files: PayloadFile[] | null;
}

/** These kinds expose their full consent fingerprint in the catalog, so review needs no staging. */
const CATALOG_COMPLETE_KINDS: ReadonlySet<PackageKind> = new Set(["skill", "agent", "theme", "font", "language"]);

export interface UpdateCandidate extends PackageUpdateOffer {
  facts: UpdateFacts;
  commitRange: { from: string | null; to: string };
  switchSource: boolean;
  provides: string[];
  needs: string[];
}

/** Required status depends only on current policy and package identity, even for unreadable sources. */
export interface AutoUpdateContext {
  policy: MarketplacePolicy["autoUpdate"];
  requiredInstalls: PackageKey[];
  unmetRequired: UnmetRequirementView[];
  sources: Array<{ id: string; label: string; origin: SourceOrigin; http: boolean; acknowledgedUnencryptedUpdates: boolean }>;
  installed: PackageKeyView[];
}

/** Queue entries select an update; current state and policy must authorize it again at execution. */
export interface ApplyTarget {
  key: PackageKeyView;
  from: string;
  to: string;
  switchSource: boolean;
}

/** Rechecks automatic eligibility with current policy and user settings under both service locks. */
/** Nested installs and removals use this caller-owned package lease. */
export type PackageLease = MutexLease;

export type ApplyDecision = (facts: UpdateFacts, policy: MarketplacePolicy["autoUpdate"]) => boolean;

export type AppliedState =
  | { state: "applied" | "applied-not-running" }
  | { state: "approval-pending"; pendingApproval: { installId: string; consentDelta: ConsentDelta; components: ReviewedComponentConsent[] } | null };

type RevokedInstall = { record: InstalledRecord & { sourceId: string }; revocation: RevocationFeed["rules"][number] };

/** Unbound installs have no source revocations. */
function boundOf(records: readonly InstalledRecord[]): BoundInstall[] {
  return records.flatMap((item) => (item.sourceId !== null ? [{ kind: item.kind, name: item.name, sourceId: item.sourceId }] : []));
}

/** Only readable versions can be revoked, and only by their own source. */
function revokedAmong(records: readonly InstalledRecord[], rules: RevocationFeed["rules"]): RevokedInstall[] {
  return records.flatMap((record) => {
    if (record.sourceId === null || record.version === null) return [];
    const sourceId = record.sourceId;
    const revocation = findRevocation(record.kind, record.name, record.version, rules.filter((rule) => rule.sourceId === sourceId));
    return revocation ? [{ record: { ...record, sourceId }, revocation }] : [];
  });
}

type HeldPreview = {
  sourceId: string;
  origin: "custom" | "direct";
  suggestedId: string;
  /** Store exactly the preview confirmations, never infer additional consent. */
  acknowledged: SourceWarning[];
} & (
  | {
    transport: "git";
    dir: string;
    url: NormalizedSourceUrl;
    ref: string | null;
    subdir: string | null;
    auth: SourceAuth;
    token: string | null;
  }
  /** Preview reads folders in place without copying. */
  | { transport: "folder"; path: string; dev: bigint; ino: bigint; ancestors: FolderIdentity[] }
);

export interface MarketplaceServiceOptions {
  registry: SourceRegistry;
  syncer: SourceSyncer;
  /** Address preflight runs before any git command or credential-helper lookup. */
  git: { commands: GitCommands; credentialHelperFor(host: string): Promise<boolean>; preflight(remote: GitRemote): Promise<void> };
  gate: NetworkGate;
  root: string;
  workRoot: string;
  /** Refresh at every operation; apply changes under the operation lock. */
  policy: PolicySource;
  tokens: TokenStore;
  previewTokens: Map<string, string>;
  versionContext: () => VersionChoiceContext;
  installers: InstallerPorts;
  ladder: Pick<LadderDeps, "zip" | "limits" | "artifacts">;
  mcpLimits: LadderDeps["limits"];
  /** All folder reads use the supplied filesystem, platform, home and package ceilings. */
  folders: { fs: FolderFs; platform: NodeJS.Platform; home: string; limits: ExportLimits };
  english: Readonly<Record<string, string>>;
  onSyncProgress?: (progress: SyncProgressView) => void;
  /** Called outside the operation that changed the catalog: work it starts enters an operation of its own. */
  onCatalogChanged?: () => void;
  onInstallProgress?: (progress: InstallProgressView) => void;
  onPackageTransactionsIdle?: () => void;
  legacyMigration: {
    markerPath: string;
    plugins(officialPlugin: (name: string) => OfficialPlugin | null, applied: AppliedDefaults): Promise<LegacyPluginReport>;
    content(ports: {
      listed(kind: LegacyContentKind, name: string): boolean;
      installed(kind: LegacyContentKind, name: string): Promise<boolean>;
      adopt(kind: LegacyContentKind, name: string): Promise<void>;
    }): Promise<LegacyContentReport>;
  };
  /** Feeds rules and unreadable-source status to plugin and content load gates. */
  revocations: { apply(feed: RevocationFeed): Promise<void> };
  log: { warn(message: string): void };
  now?: () => Date;
}

/** Gated kinds remain installed but unloaded on disable; config-based kinds must be removed. */
const GATED_KINDS: ReadonlySet<PackageKind> = new Set(["plugin", "skill", "agent", "theme", "font", "language"]);

const PREVIEW_ID_PREFIX = "preview-";

const FOLDER_BADGE_TTL_MS = 60_000;

/** Changed folder bytes at an equal version offer a refresh; lower versions require manual downgrade. */
function folderChange(installed: InstalledRecord & { sourceId: string; version: string }, rows: readonly CatalogRow[]): { row: CatalogRow; version: string; change: UpdateChange } | null {
  const row = rows.find((item) => item.sourceId === installed.sourceId && item.kind === installed.kind && item.name === installed.name);
  if (!row || row.choice.state !== "candidate" || row.package.treeSha256 === undefined) return null;
  if (!installed.digest || installed.digest === row.package.treeSha256) return null;
  const version = row.choice.version.version;
  const order = compareVersions(version, installed.version);
  if (order > 0) return null;
  return { row, version, change: order === 0 ? "refresh" : "downgrade" };
}

/** Only retained components with changed consent need approval, bound to their approval digest. */
function reviewComponentsOf(kind: PackageKind, delta: ConsentDelta, staged: ConsentFingerprint | null, components: AgentPluginComponents | null): ReviewComponentView[] {
  const views: ReviewComponentView[] = [];
  for (const entry of delta) {
    const match = /^(mcpServer|hook):(.+)$/u.exec(entry.field);
    if (!match) continue;
    const component = match[1] as "mcpServer" | "hook";
    const id = match[2]!;
    if (!staged || !Object.hasOwn(staged.fields, entry.field)) continue;
    if (kind === "plugin") {
      const digest = staged.fields[entry.field];
      views.push({ kind: "extension", field: entry.field, consent: { kind: "extension", component, localId: id, approvalDigest: typeof digest === "string" ? digest : null } });
    } else if (kind === "agent-plugin" && components) {
      if (component === "mcpServer") {
        const server = Object.hasOwn(components.mcpServers, id) ? components.mcpServers[id] : undefined;
        if (server) views.push({ kind: "mcpServer", field: entry.field, consent: { name: id, digest: server.digest } });
      } else {
        const index = Number(id);
        const hook = components.hooks[index];
        if (hook) views.push({ kind: "hook", field: entry.field, consent: { kind: "hook", index, digest: hook.digest } });
      }
    }
  }
  return views;
}

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

/** The prefix of a quarantined source's handle; `ave-` ids are reserved, so it names no added source. */
const QUARANTINE_HANDLE_PREFIX = "ave-legacy-";

function idFrom(raw: string): string | null {
  const id = raw.toLowerCase().replace(/\.git$/u, "").replace(/[^a-z0-9-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return isSourceId(id) && !isReservedSourceId(id) ? id : null;
}

/** Custom sources store confirmations in entries; managed sources use state and folder policy. */
function acknowledgedOf(source: ResolvedSource, state: SourceState | null): SourceWarning[] {
  if (source.transport === "folder" && source.origin === "managed") return ["network-folder"];
  return source.origin === "custom" || source.origin === "direct" ? [...(source.acknowledged ?? [])] : confirmationsFor(state?.acknowledged, sourceIdentity(source));
}

/** Folder badges must reflect held network-folder consent, never imply a grant. */
function folderBadge(network: FolderNetwork, acknowledged: readonly SourceWarning[]): SourceBadge {
  if (!network.network) return "local-folder";
  return acknowledged.includes("network-folder") ? "network-folder" : "network-folder-unconfirmed";
}

/** Quarantined sources permit only removal and uninstall, whether addressed by id or handle. */
function quarantineRefusal(): MarketplaceError {
  return new MarketplaceError("SOURCE_ID_INVALID", "this source's id looks like a password or token; remove it and add it again with another id", {
    detail: { reason: "stored-id-holds-credential" },
  });
}

/** Classifier failure is an explicit state, never a guessed class. */
function classifierUnavailable(error: unknown): boolean {
  return isMarketplaceError(error) && error.code === "SOURCE_LOCAL_UNREADABLE" && error.detail?.reason === "classifier-unavailable";
}

function urlBadges(url: NormalizedSourceUrl, acknowledged: readonly SourceWarning[]): SourceBadge[] {
  const badges: SourceBadge[] = [];
  if (url.scheme === "http") badges.push("unencrypted");
  for (const warning of ["internal-network", "this-computer", "internal-downloads"] as const) {
    if (acknowledged.includes(warning)) badges.push(warning);
  }
  return badges;
}

function marketplacePreview(snapshot: SourceSnapshot, held: { id: string; expiresAt: string }, suggestedId: string) {
  const counts: Partial<Record<PackageKind, number>> = {};
  for (const pkg of snapshot.packages) counts[pkg.kind] = (counts[pkg.kind] ?? 0) + 1;
  return {
    type: "marketplace" as const,
    previewId: held.id,
    expiresAt: held.expiresAt,
    marketplace: {
      name: snapshot.marketplace.name,
      displayName: snapshot.marketplace.displayName,
      description: snapshot.marketplace.description ?? null,
      owner: snapshot.marketplace.owner?.name ?? null,
    },
    counts,
    codeRunning: snapshot.packages.filter((pkg) => runsCode(pkg.kind, pkg.versions[0]?.components)).length,
    diagnostics: snapshot.diagnostics.map((item) => `${item.subject}: ${item.message}`),
    suggestedId,
  };
}

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
  /** Keyed source handles cannot be derived from stored ids alone. */
  private readonly handleKey = randomBytes(32);
  /** Cache drive-mapping classifications only for badges; each actual read reclassifies the folder. */
  private readonly folderClasses = new Map<string, { network: FolderNetwork; at: number }>();
  /** In-flight installs are judged by their destination source, never the source being left. */
  private readonly pendingBindings = new Map<string, PendingBinding>();
  /** Feeds run one after another, so an older feed never lands after a newer one. */
  private feedTail: Promise<unknown> = Promise.resolve();
  /** One enforcement pass at a time, so two passes never remove the same package. */
  private enforceTail: Promise<unknown> = Promise.resolve();
  private readonly revokedUnreported: RevokedPackageView[] = [];
  private readonly revokedQueued = new Set<string>();
  private readonly lock = new OperationLock();
  /** Nested calls share only a live operation; continuations outliving it start a new one. */
  private readonly inOperation = new AsyncLocalStorage<{ open: boolean }>();
  /** Lock order is operation, package, then plugin; nested package work needs an explicit lease. */
  private readonly packageLocks = new KeyedMutex();

  /** Readers needing stable package state must wait until no package lock is held or queued. */
  get packageTransactionsIdle(): boolean {
    return this.packageLocks.idle;
  }
  /** Policy refreshes read and apply serially in order. */
  private refreshRunning: Promise<void> | null = null;
  /** Callers arriving during a refresh share one queued refresh with independent cancellation signals. */
  private refreshQueued: { promise: Promise<void>; waiters: Array<AbortSignal | undefined> } | null = null;

  constructor(private readonly options: MarketplaceServiceOptions) {
    const now = () => (options.now?.() ?? new Date()).getTime();
    // Expired or superseded folder plans release their captured bytes.
    this.plans = new Tickets<HeldPlan>("install plan", now, undefined, (held) => {
      if (held.folder) void rm(held.folder.dir, { recursive: true, force: true });
    });
    this.previews = new Tickets<HeldPreview>("marketplace preview", now, undefined, (preview) => {
      options.previewTokens.delete(preview.sourceId);
      if (preview.transport === "git") void rm(preview.dir, { recursive: true, force: true });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get registry(): SourceRegistry {
    return this.options.registry;
  }

  /** An unreadable policy blocks non-official targets at the gate. */
  private get policy(): MarketplacePolicy {
    const load = this.options.policy.load;
    return load.ok ? load.policy : EMPTY_MARKETPLACE_POLICY;
  }

  /** Waits for a fresh policy read before taking the shared operation lock.
     * Cancellation prevents entry; a refresh needed by another caller still runs. */
  /** Takes package locks after the operation and before plugin locks; existing holders pass a lease.
     * Cancellation while waiting prevents the callback from starting. */
  private async withPackage<T>(kind: PackageKind, name: string, fn: () => Promise<T>, options: { signal?: AbortSignal; lease?: PackageLease } = {}): Promise<T> {
    const key = keyOf(kind, name);
    if (options.lease) return this.packageLocks.within(options.lease, [key], fn);
    return this.withPackages([key], () => fn(), options.signal);
  }

  private async withPackages<T>(keys: readonly string[], fn: (lease: PackageLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await this.packageLocks.run(keys, fn, {
        ...(signal ? { signal } : {}),
        beforeAcquire: (wanted) => {
          if (holdsAnyPluginInstallLock()) {
            throw new Error(`lock order: the package lock of ${wanted.join(", ")} was asked for while a plugin lock is held; the package lock comes first (§18.6)`);
          }
        },
      });
    } finally {
      const settled = this.options.onPackageTransactionsIdle;
      // Notify outside both operation and lease contexts so callback work enters independently.
      if (settled && this.packageLocks.idle) this.inOperation.exit(() => this.packageLocks.detached(settled));
    }
  }

  private async operation<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.inOperation.getStore()?.open) return fn();
    await this.refreshPolicy(signal);
    return this.lock.shared(async () => {
      signal?.throwIfAborted();
      const scope = { open: true };
      try {
        return await this.inOperation.run(scope, fn);
      } finally {
        scope.open = false;
      }
    });
  }

  /** Enter the marketplace operation before taking any plugin lock to avoid lock-order cycles. */
  async asOneOperation<T>(fn: () => Promise<T>): Promise<T>;
  /** Takes all package locks together for the callback; nested work uses the supplied lease. */
  async asOneOperation<T>(fn: (lease: PackageLease) => Promise<T>, packages: ReadonlyArray<{ kind: PackageKind; name: string }>): Promise<T>;
  async asOneOperation<T>(fn: (lease: PackageLease) => Promise<T>, packages?: ReadonlyArray<{ kind: PackageKind; name: string }>): Promise<T> {
    if (packages === undefined) return this.operation(() => (fn as () => Promise<T>)());
    return this.operation(() => this.withPackages(packages.map((item) => keyOf(item.kind, item.name)), fn));
  }

  /** Notify outside the operation so callback work gets its own policy refresh and shared lock. */
  private catalogChanged(): void {
    const notify = this.options.onCatalogChanged;
    if (notify) this.inOperation.exit(() => this.packageLocks.detached(notify));
  }

  /** Serialize policy reads and application; callers arriving mid-read share the next refresh.
     * Skip a queued refresh only when every waiting caller has cancelled. */
  private refreshPolicy(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.refreshQueued) {
      this.refreshQueued.waiters.push(signal);
      return this.refreshQueued.promise;
    }
    if (!this.refreshRunning) return this.startRefresh([signal]);
    const waiters = [signal];
    const queued = {
      waiters,
      promise: this.refreshRunning.then(() => {
        if (waiters.some((waiter) => !waiter?.aborted)) return this.startRefresh(waiters);
        // Every caller was cancelled: nothing is read, and each refuses with its own reason when admitted.
        if (this.refreshQueued === queued) this.refreshQueued = null;
      }),
    };
    this.refreshQueued = queued;
    return queued.promise;
  }

  private startRefresh(waiters: ReadonlyArray<AbortSignal | undefined>): Promise<void> {
    // From here on this refresh is running: a caller arriving now must wait for a later one.
    this.refreshQueued = null;
    const running = this.refreshOnce(waiters);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.refreshRunning = settled;
    void settled.then(() => {
      if (this.refreshRunning === settled) this.refreshRunning = null;
    });
    return running;
  }

  private async refreshOnce(waiters: ReadonlyArray<AbortSignal | undefined>): Promise<void> {
    const update = await this.options.policy.check();
    if (!update) return;
    await this.lock.exclusive(() => this.applyPolicy(update, waiters));
  }

  /** Apply policy changes even if all callers cancel; suppress unreadable-file reports after cancellation. */
  private applyPolicy(update: PolicyUpdate, waiters: ReadonlyArray<AbortSignal | undefined>): void {
    this.options.policy.apply(update);
    if (!update.load.ok && waiters.some((waiter) => !waiter?.aborted)) {
      this.options.log.warn(`marketplace policy unreadable; only the official source is reachable: ${update.load.error}`);
    }
    this.catalogChanged();
  }

  private source(id: string): ResolvedSource {
    const source = this.registry.get(id);
    if (source && !this.registry.isQuarantined(source)) return source;
    if (source || this.quarantinedByHandle(id)) throw quarantineRefusal();
    throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
  }

  /** Session-stable HMAC handles hide credential-shaped ids; reserved ave- ids cannot collide. */
  private handleOf(id: string): string {
    return `${QUARANTINE_HANDLE_PREFIX}${createHmac("sha256", this.handleKey).update(id).digest("hex").slice(0, 32)}`;
  }

  /** Handles depend on stored ids alone so installed packages stay addressable after source removal. */
  private viewSourceId(id: string): string {
    return holdsCredential(id) ? this.handleOf(id) : id;
  }

  /** The quarantined source a handle names, checked against the stored entries now; null for anything else. */
  private quarantinedByHandle(handle: string): ResolvedSource | null {
    if (!handle.startsWith(QUARANTINE_HANDLE_PREFIX)) return null;
    return this.registry.list().find((source) => this.registry.isQuarantined(source) && this.handleOf(source.id) === handle) ?? null;
  }

  /** Report unusable state or snapshots as a repairable source problem; unexpected errors propagate. */
  private async read(source: ResolvedSource): Promise<{ state: SourceState; snapshot: SourceSnapshot | null } | { problem: MarketplaceError }> {
    try {
      const state = await this.registry.readState(source.id);
      return { state, snapshot: await this.options.syncer.readSnapshot(source.id) };
    } catch (error) {
      if (isMarketplaceError(error) && error.code === "SOURCE_LOCAL_DATA_DAMAGED") return { problem: error };
      throw error;
    }
  }

  private async sourceView(source: ResolvedSource): Promise<SourceView> {
    const read = await this.read(source);
    const state = "problem" in read ? null : read.state;
    const snapshot = "problem" in read ? null : read.snapshot;
    const reviewable = source.origin === "custom" || source.origin === "direct";
    const tokenHost = source.auth.kind === "token" ? source.auth.host : null;
    const git = source.transport === "git" ? source : null;
    const quarantined = this.registry.isQuarantined(source);
    return {
      id: this.viewSourceId(source.id),
      origin: source.origin,
      label: sourceLabel(source, snapshot),
      ...(source.transport === "git" ? { transport: "git" as const, url: source.url.url, path: null } : { transport: "folder" as const, url: null, path: source.path }),
      ref: git?.ref ?? null,
      subdir: git?.subdir ?? null,
      mirrors: git ? git.mirrors.length : 0,
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
      status: quarantined
        ? { state: "id-holds-credential" }
        : "problem" in read ? brokenStatus(read.problem) : sourceStatus(read.state, this.syncing.has(source.id), snapshot !== null, reviewable),
      enabled: quarantined ? false : state ? this.registry.isEnabled(source, state) : !this.registry.canDisable(source),
      canDisable: this.registry.canDisable(source),
      canRemove: reviewable,
      diagnostics: (snapshot?.diagnostics ?? []).map((item) => `${item.subject}: ${item.message}`),
      acknowledged: acknowledgedOf(source, state),
      // Removal-only quarantined sources must not trigger folder classification.
      badges: quarantined && source.transport === "folder" ? [] : await this.badgesOf(source, acknowledgedOf(source, state)),
    };
  }

  /** Folder classification failure affects only that row; recovery controls remain available. */
  private async badgesOf(source: ResolvedSource, acknowledged: readonly SourceWarning[]): Promise<SourceBadge[]> {
    if (source.transport === "git") return urlBadges(source.url, acknowledged);
    try {
      return [folderBadge(await this.folderClass(source.path), acknowledged)];
    } catch (error) {
      if (classifierUnavailable(error)) return ["folder-unclassified"];
      throw error;
    }
  }

  private async folderClass(path: string): Promise<FolderNetwork> {
    const now = this.now().getTime();
    const known = this.folderClasses.get(path);
    if (known && now - known.at < FOLDER_BADGE_TTL_MS) return known.network;
    const { fs, platform } = this.options.folders;
    const network = await classifyFolder(path, platform, fs);
    this.folderClasses.set(path, { network, at: now });
    return network;
  }

  /** Reveal uses the read fence and final policy/network checks before handing the path to the shell.
     * A concurrent remap after that check remains outside the fence. */
  async revealFolder(id: string): Promise<string | null> {
    return this.operation(async () => {
      const source = this.source(id);
      if (source.transport !== "folder") return null;
      const { fs, platform } = this.options.folders;
      await openStoredFolder(source, await this.registry.readState(source.id), { registry: this.registry, gate: this.options.gate, folders: this.options.folders });
      const acknowledged = await this.registry.acknowledged(source);
      this.options.gate.checkFolder(source.path, await classifyFolder(source.path, platform, fs), acknowledged);
      return source.path;
    });
  }

  async listSources(): Promise<SourceView[]> {
    return this.operation(() => Promise.all(this.registry.list().map((source) => this.sourceView(source))));
  }

  /** Abort prevents new sync work and progress; an in-flight fetch finishes before rejection. */
  private async syncOne(id: string, signal?: AbortSignal): Promise<SyncResult> {
    signal?.throwIfAborted();
    this.syncing.add(id);
    this.options.onSyncProgress?.({ sourceId: id, state: "syncing" });
    try {
      const result = await this.options.syncer.sync(id);
      signal?.throwIfAborted();
      this.options.onSyncProgress?.({ sourceId: id, state: result.status === "ok" ? "done" : "failed" });
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.options.onSyncProgress?.({ sourceId: id, state: "failed" });
      throw error;
    } finally {
      this.syncing.delete(id);
    }
  }

  /** Repair moves downloaded state aside and resyncs while preserving installed bindings and credentials. */
  async repairSource(id: string): Promise<SourceView[]> {
    return this.operation(() => this.repairSourceNow(id));
  }

  private async repairSourceNow(id: string): Promise<SourceView[]> {
    const source = this.source(id);
    await this.options.syncer.resetLocalData(source.id);
    this.catalogChanged();
    await this.syncOne(source.id);
    await this.enforceRevocations();
    return this.listSources();
  }

  async refresh(id?: string): Promise<SourceView[]> {
    return this.operation(() => this.refreshNow(id));
  }

  private async refreshNow(id?: string): Promise<SourceView[]> {
    if (id !== undefined) await this.syncAndEnforce([this.source(id).id]);
    else await this.syncAll();
    return this.listSources();
  }

  /** Offline means every source failed offline; broken or mixed sources make the result partial.
     * Abort prevents subsequent stages and progress; unexpected failures throw. */
  async discover(signal?: AbortSignal): Promise<SyncDiscovery> {
    return this.operation(() => this.discoverNow(signal), signal);
  }

  private async discoverNow(signal?: AbortSignal): Promise<SyncDiscovery> {
    const { results, broken } = await this.syncAll(signal);
    const reached = [...results].filter(([, result]) => result.status === "ok").map(([sourceId]) => sourceId);
    const failed = [...results.values()].filter((result) => result.status === "failed");
    if (failed.length === 0 && broken === 0) return { result: "ok", reached };
    const offline = broken === 0 && failed.length > 0 && failed.length === results.size
      && failed.every((result) => result.status === "failed" && result.code === "SOURCE_UNREACHABLE" && result.detail?.reason === "offline");
    return { result: offline ? "offline" : "partial", reached };
  }

  /** Broken sources count toward discovery status but are not synced. */
  private async syncAll(signal?: AbortSignal): Promise<{ results: Map<string, SyncResult>; broken: number }> {
    const bound = new Set((await this.installedAll()).map((item) => item.sourceId).filter((sourceId): sourceId is string => sourceId !== null));
    const ids: string[] = [];
    let broken = 0;
    for (const source of this.registry.list()) {
      const read = await this.read(source);
      // A broken source is listed with its problem; syncing it would only fail again.
      if ("problem" in read) {
        broken += 1;
        continue;
      }
      if (shouldSyncSource(this.registry, source, read.state, bound.has(source.id))) ids.push(source.id);
    }
    return { results: await this.syncAndEnforce(ids, signal), broken };
  }

  private async syncAndEnforce(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, SyncResult>> {
    // Every source finishes; a failure outside a sync result (a bug, an unreadable file) is reported after.
    const settled = await Promise.allSettled(ids.map((sourceId) => this.syncOne(sourceId, signal)));
    // A moved pin may carry new revocations; they take effect before anything else happens.
    await this.enforceRevocations(signal);
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) throw failed.reason;
    return new Map(ids.map((sourceId, index) => [sourceId, (settled[index] as PromiseFulfilledResult<SyncResult>).value]));
  }

  async setEnabled(id: string, enabled: boolean): Promise<SourceView> {
    return this.operation(async () => {
      const source = this.source(id);
      await this.registry.setEnabled(source.id, enabled);
      this.catalogChanged();
      return this.sourceView(this.source(source.id));
    });
  }

  async acceptRewrite(id: string, commit: string): Promise<SourceView> {
    return this.operation(async () => {
      // Refuse quarantined sources before touching the repository, pin or snapshot.
      const source = this.source(id);
      const result = await this.options.syncer.acceptRewrite(source.id, commit);
      if (result.status === "failed") throw new MarketplaceError(result.code, result.message, result.detail ? { detail: result.detail } : undefined);
      return this.sourceView(this.source(source.id));
    });
  }

  /** Records newly accepted confirmations and resyncs; further failures remain visible on the source. */
  async acknowledgeSource(id: string, warnings: readonly SourceWarning[]): Promise<SourceView> {
    return this.operation(async () => {
      const source = this.source(id);
      await this.registry.acknowledge(source.id, warnings);
      this.catalogChanged();
      await this.syncOne(source.id);
      await this.enforceRevocations();
      return this.sourceView(this.source(source.id));
    });
  }

  /** Removing a source preserves its installed packages for later uninstall. */
  async removeSource(id: string): Promise<{ orphanedPackages: PackageKeyView[] }> {
    return this.operation(() => this.removeSourceNow(id));
  }

  private async removeSourceNow(id: string): Promise<{ orphanedPackages: PackageKeyView[] }> {
    // Quarantined-source handles authorize removal only.
    const source = this.quarantinedByHandle(id) ?? this.source(id);
    if (source.origin === "official" || source.origin === "managed") {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the ${source.origin} source ${id} cannot be removed`);
    }
    const orphaned = (await this.installedAll()).filter((item) => item.sourceId === source.id).map((item) => ({ sourceId: this.viewSourceId(source.id), kind: item.kind, name: item.name }));
    await this.options.syncer.removeSource(source.id);
    this.catalogChanged();
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

  /** Require lexical consent before lookups, resolved-address consent before git, then read the repository. */
  private async previewSourceNow(request: SourcePreviewRequest): Promise<SourcePreviewResultView> {
    const { platform, home } = this.options.folders;
    const input = normalizeSourceInput(request.input, platform, home);
    if (input.kind === "folder") return this.previewFolder(request, input.path, input.input);
    const url = input.url;
    if (request.auth === "ssh" && url.scheme !== "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "SSH sign-in needs an ssh:// or git@host:path address");
    if (request.auth !== "ssh" && url.scheme === "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "an ssh address needs SSH sign-in");
    const auth: SourceAuth = request.auth === "token" ? { kind: "token", host: url.host } : { kind: request.auth };
    const subdir = request.subdir?.trim() ? request.subdir.trim().replace(/^\/+|\/+$/gu, "") : null;
    const ref = request.ref?.trim() ? request.ref.trim() : null;
    const acknowledged = [...new Set(request.acknowledge ?? [])];
    const held = new Set(acknowledged);
    const askConfirmation = (warnings: readonly EnteredTargetWarningView[]): SourcePreviewResultView => ({ type: "confirm", warnings: uniqueWarnings(warnings) });
    // Require plaintext sign-in consent before sending any credential.
    const lexical: EnteredTargetWarningView[] = url.scheme === "http" && auth.kind === "token" && !held.has("token-unencrypted")
      ? [{ warning: "token-unencrypted", host: url.host, address: null }]
      : [];
    let verdict: ReturnType<NetworkGate["checkRemote"]>;
    try {
      verdict = this.options.gate.checkRemote(url, { official: false, acknowledged: held });
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) return askConfirmation([...error.warnings, ...lexical]);
      throw error;
    }
    if (lexical.length > 0) return askConfirmation(lexical);
    const sourceId = `${PREVIEW_ID_PREFIX}${randomBytes(9).toString("hex")}`;
    const remote: GitRemote = { url, sourceId, useToken: auth.kind === "token", ...verdict };
    try {
      // The address class a lookup finds is asked for before any git command runs.
      await this.options.git.preflight(remote);
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) return askConfirmation(error.warnings);
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
      // Disable helpers for HTTP unless token-unencrypted consent is held.
      const credentialHelper = remote.credentialsAllowed && (await this.options.git.credentialHelperFor(url.host));
      const pathName = url.path.split("/").filter(Boolean).pop() ?? "";
      const tree = new GitTree(repo, remote, commit);
      if (subdir === null) {
        const built = await new SnapshotBuilder(tree, { id: sourceId, origin: "custom", rootName: rootNameOf(url.path) }).build(this.now().toISOString());
        if (built.ok) {
          const suggestedId = this.freeId([idFrom(built.snapshot.marketplace.name), idFrom(pathName)]);
          const held = this.previews.issue({ transport: "git", sourceId, dir, url, ref, subdir: null, auth, token, origin: "custom", suggestedId, acknowledged });
          return {
            ...marketplacePreview(built.snapshot, held, suggestedId),
            transport: "git",
            url: url.url,
            path: null,
            resolvedFrom: null,
            badges: urlBadges(url, acknowledged),
            ref,
            commit,
            credentialHelper,
          };
        }
        if (built.code !== "SOURCE_NOT_A_MARKETPLACE") throw new MarketplaceError(built.code, built.message, built.detail ? { detail: built.detail } : undefined);
      }
      const read = await readDirectPackage({ tree, path: subdir ?? "", rootName: rootNameOf(url.path) });
      if (!read) throw new MarketplaceError("SOURCE_NOT_A_MARKETPLACE", `no marketplace and no package at ${subdir ?? "the repository root"}`);
      if (!read.ok) throw new MarketplaceError(read.code, read.error, read.detail ? { detail: read.detail } : undefined);
      // Direct-install policy requires a marketplace source.
      this.options.gate.checkDirectInstall(url.url);
      const { descriptor, detectedFrom, versionSynthesized } = read.found;
      const suggestedId = this.freeId([idFrom(descriptor.name), idFrom(pathName)]);
      const held = this.previews.issue({ transport: "git", sourceId, dir, url, ref, subdir, auth, token, origin: "direct", suggestedId, acknowledged });
      return {
        type: "package",
        previewId: held.id,
        expiresAt: held.expiresAt,
        transport: "git",
        url: url.url,
        path: null,
        resolvedFrom: null,
        badges: urlBadges(url, acknowledged),
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
      if (error instanceof ConfirmationRequiredError) return askConfirmation(error.warnings);
      // Require plaintext sign-in consent even when discovered only at connection time.
      if (isMarketplaceError(error) && error.code === "SOURCE_AUTH_REQUIRED" && error.detail?.reason === "token-unencrypted") {
        return askConfirmation([{ warning: "token-unencrypted", host: url.host, address: null }]);
      }
      throw error;
    }
  }

  /** Classify and authorize before touching a folder; fence the walk and recheck its canonical path. */
  private async previewFolder(request: SourcePreviewRequest, path: string, typed: string): Promise<SourcePreviewResultView> {
    const { fs, platform, limits } = this.options.folders;
    if (request.ref?.trim() || request.subdir?.trim() || request.auth !== "none" || request.token) {
      throw new MarketplaceError("SOURCE_URL_REJECTED", "a folder has no branch, folder field or sign-in", { detail: { reason: "folder-options" } });
    }
    const acknowledged = [...new Set(request.acknowledge ?? [])];
    const confirmed = new Set(acknowledged);
    const networkConsented = confirmed.has("network-folder");
    // A policy block needs no classification: it ends the preview before any call at all.
    this.options.gate.checkFolderPolicy(path);
    let root: FolderRoot;
    let network: FolderNetwork;
    try {
      this.options.gate.checkFolder(path, await classifyFolder(path, platform, fs), confirmed);
      root = await resolveFolderRoot(path, platform, fs, networkConsented);
      network = await classifyFolder(root.path, platform, fs);
      // Canonical-path policy and network checks can still refuse the preview.
      this.options.gate.checkFolder(root.path, network, confirmed);
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) return { type: "confirm", warnings: uniqueWarnings(error.warnings) };
      throw error;
    }
    const resolvedFrom = root.path === path ? null : typed;
    const sourceId = `${PREVIEW_ID_PREFIX}${randomBytes(9).toString("hex")}`;
    const rootName = rootNameOf(root.path);
    const tree = new FolderTree({ fs, platform, root, readAt: this.now().toISOString(), limits, networkConsented });
    const built = await new SnapshotBuilder(tree, { id: sourceId, origin: "custom", rootName }).build(this.now().toISOString());
    if (built.ok) {
      const suggestedId = this.freeId([idFrom(built.snapshot.marketplace.name), idFrom(rootName)]);
      const held = this.previews.issue({ transport: "folder", sourceId, path: root.path, dev: root.dev, ino: root.ino, ancestors: root.ancestors, origin: "custom", suggestedId, acknowledged });
      return {
        ...marketplacePreview(built.snapshot, held, suggestedId),
        transport: "folder",
        url: null,
        path: root.path,
        resolvedFrom,
        badges: [folderBadge(network, [...confirmed])],
        ref: null,
        commit: built.snapshot.commit,
        credentialHelper: false,
      };
    }
    if (built.code !== "SOURCE_NOT_A_MARKETPLACE") throw new MarketplaceError(built.code, built.message, built.detail ? { detail: built.detail } : undefined);
    const read = await readDirectPackage({ tree, path: "", rootName });
    if (!read) throw new MarketplaceError("SOURCE_NOT_A_MARKETPLACE", `no marketplace and no package in ${root.path}`);
    if (!read.ok) throw new MarketplaceError(read.code, read.error, read.detail ? { detail: read.detail } : undefined);
    // Direct-install policy applies to folders too.
    this.options.gate.checkDirectInstall(root.path);
    // A direct package read fails the preview; a marketplace drops invalid packages with diagnostics.
    await tree.packageAt("", read.found.descriptor.kind);
    const direct = await new SnapshotBuilder(tree, { id: sourceId, origin: "direct", rootName }).build(this.now().toISOString());
    if (!direct.ok) throw new MarketplaceError(direct.code, direct.message, direct.detail ? { detail: direct.detail } : undefined);
    const { descriptor, detectedFrom, versionSynthesized } = read.found;
    const suggestedId = this.freeId([idFrom(descriptor.name), idFrom(rootName)]);
    const held = this.previews.issue({ transport: "folder", sourceId, path: root.path, dev: root.dev, ino: root.ino, ancestors: root.ancestors, origin: "direct", suggestedId, acknowledged });
    return {
      type: "package",
      previewId: held.id,
      expiresAt: held.expiresAt,
      transport: "folder",
      url: null,
      path: root.path,
      resolvedFrom,
      badges: [folderBadge(network, [...confirmed])],
      ref: null,
      subdir: null,
      commit: direct.snapshot.commit,
      detectedFrom,
      kind: descriptor.kind,
      name: descriptor.name,
      displayName: descriptor.displayName ?? null,
      description: descriptor.description ?? null,
      version: descriptor.version,
      versionSynthesized,
      runsCode: runsCode(descriptor.kind, descriptor.kind === "agent-plugin" ? descriptor.payload.components as IndexVersion["components"] : undefined),
      credentialHelper: false,
      suggestedId,
    };
  }

  /** Write entry and state before moving the repository; a repository without state is treated as lost. */
  async addSource(request: SourceAddRequest): Promise<SourceView> {
    return this.operation(async () => {
      try {
        return await this.addSourceNow(request);
      } catch (error) {
        throw this.viewTaken(error);
      }
    });
  }

  /** Duplicate-source errors use the view handle, never expose a quarantined stored id. */
  private viewTaken(error: unknown): unknown {
    if (!isMarketplaceError(error) || error.code !== "SOURCE_ID_TAKEN" || error.detail === undefined || !("existingId" in error.detail)) return error;
    const stored = error.detail.existingId;
    const shown = this.viewSourceId(stored);
    if (shown === stored) return error;
    return new MarketplaceError("SOURCE_ID_TAKEN", error.message.replaceAll(stored, shown), { detail: { ...error.detail, existingId: shown } });
  }

  private async addSourceNow(request: SourceAddRequest): Promise<SourceView> {
    const preview = this.previews.take(request.previewId);
    if (preview.transport === "folder") return this.addFolderNow(request, preview);
    try {
      this.options.gate.checkSourcePolicy(preview.url, { official: false });
      if (preview.origin === "direct") this.options.gate.checkDirectInstall(preview.url.url);
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
        if (!isMissingPathError(error)) throw error;
      }
      await this.syncOne(id);
      this.catalogChanged();
      return this.sourceView(this.source(id));
    } finally {
      this.options.previewTokens.delete(preview.sourceId);
      await rm(preview.dir, { recursive: true, force: true });
    }
  }

  /** Recheck policy and folder identity before recording and reading an accepted preview. */
  private async addFolderNow(request: SourceAddRequest, preview: HeldPreview & { transport: "folder" }): Promise<SourceView> {
    this.options.gate.checkFolderPolicy(preview.path);
    if (preview.origin === "direct") this.options.gate.checkDirectInstall(preview.path);
    const id = request.id?.trim() || preview.suggestedId;
    await this.registry.addFolder({
      id,
      origin: preview.origin,
      path: preview.path,
      dev: preview.dev,
      ino: preview.ino,
      ancestors: preview.ancestors,
      ...(request.label?.trim() ? { label: request.label.trim() } : {}),
      acknowledged: preview.acknowledged,
    });
    await this.syncOne(id);
    this.catalogChanged();
    return this.sourceView(this.source(id));
  }

  private async installedAll(): Promise<InstalledRecord[]> {
    const [plugins, content, mcp] = await Promise.all([
      this.options.installers.plugin.list(),
      this.options.installers.content.list(),
      this.options.installers.mcp.list(),
    ]);
    return [...plugins, ...content, ...mcp];
  }

  /** Hidden sources appear only for bound installs, retaining their sync and update notifications. */
  private async rows(bound?: ReadonlySet<string>): Promise<{ rows: CatalogRow[]; snapshots: Map<string, SourceSnapshot>; shown: ResolvedSource[]; badges: Map<string, SourceBadge[]> }> {
    const shown: ResolvedSource[] = [];
    const snapshots = new Map<string, SourceSnapshot>();
    const badges = new Map<string, SourceBadge[]>();
    for (const source of this.registry.list()) {
      const read = await this.read(source);
      // A source whose files cannot be read shows as broken in Sources and lists nothing.
      if ("problem" in read) continue;
      // Quarantined sources serve no packages, including bound installs.
      if (this.registry.isQuarantined(source)) continue;
      if (!this.registry.isEnabled(source, read.state) && !bound?.has(source.id)) continue;
      shown.push(source);
      badges.set(source.id, await this.badgesOf(source, acknowledgedOf(source, read.state)));
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
      // Keep orphaned installs listed so users can uninstall them.
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
          // Round-trip credential-shaped source ids through opaque handles for uninstall.
          key: { sourceId: this.viewSourceId(item.sourceId), kind: item.kind, name: item.name },
          sourceOrigin: this.registry.get(item.sourceId)?.origin ?? "custom",
          sourceLabel: labels.get(item.sourceId) ?? this.viewSourceId(item.sourceId),
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

  /** Hidden-source details serve bound installs, but all plans require the source to be shown. */
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

  private async pluginRungViews(source: ResolvedSource, version: IndexVersion, packagePath: string): Promise<InstallPlanView["rungs"]> {
    if (source.transport === "folder") return [folderRungView(packagePath)];
    return rungViews(version.artifact!, packagePath, await this.treeDeclared(source.id, version, packagePath), source.url);
  }

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
    // Removed-source handles still explain refusal and allow uninstall of bound packages.
    if (key.sourceId.startsWith(QUARANTINE_HANDLE_PREFIX) && !this.registry.get(key.sourceId)) {
      const installed = await this.installed(key.kind, key.name);
      if (installed?.sourceId && holdsCredential(installed.sourceId) && this.handleOf(installed.sourceId) === key.sourceId) throw quarantineRefusal();
    }
    const source = this.source(key.sourceId);
    const { row, rows, snapshot, label, badges } = await this.row(key);
    const installed = await this.installed(key.kind, key.name);
    const existing = new Set(this.registry.list().map((source) => source.id));
    const context = this.options.versionContext();
    const shownVersion = shownVersionOf(row);
    const shownTree = shownVersion !== null && hasVersionTree(shownVersion);
    const installedHere = installed?.sourceId === key.sourceId ? installed.version : null;
    return {
      entry: this.entry(row, installed, rows, existing, label, badges),
      provenance: {
        sourceLabel: label,
        repository: source.transport === "git" ? source.url.url : null,
        folder: source.transport === "folder" ? { path: source.path, readAt: await this.folderReadAt(source.id, snapshot), contents: row.package.treeSha256 ?? null } : null,
        path: row.package.path,
        snapshotCommit: row.snapshotCommit,
        versionCommit: shownTree ? shownVersion.commit : null,
        publishedAt: shownVersion?.publishedAt ?? null,
      },
      compatibility: {
        minAppVersion: shownVersion?.minAppVersion ?? null,
        appVersion: context.appVersion,
        compatible: shownVersion ? appVersionSatisfiesMin(context.appVersion, shownVersion.minAppVersion) : false,
      },
      authority: shownVersion?.authority ? authorityView(shownVersion.authority) : null,
      components: shownVersion?.components ?? null,
      // A legacy grant pin has no tree to inspect and no rung that would install it.
      rungs: row.kind === "plugin" && shownTree && shownVersion.artifact ? await this.pluginRungViews(source, shownVersion, row.package.path) : [],
      versions: versionViews(row, effectiveRevocations(snapshot, context.appVersion), context, installedHere),
    };
  }

  /** After a failed read, show the time of the snapshot still being served. */
  private async folderReadAt(sourceId: string, snapshot: SourceSnapshot): Promise<string> {
    const last = (await this.registry.readState(sourceId)).lastSync;
    return last?.result === "ok" ? last.at : snapshot.fetchedAt;
  }

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
      // The first exclusion determines the sentence; retain all exclusions in the message.
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

  private repositoryAccess<T>(sourceId: string, fn: (access: RepositoryAccess) => Promise<T>): Promise<T> {
    return this.options.syncer.withRepository(sourceId, ({ source, repo, remote }) => fn(gitAccess(repo, remote, source.origin === "direct")));
  }

  /** Execution reads only the package capture taken by this fresh folder read. */
  private async captureFolder(sourceId: string, kind: PackageKind, name: string): Promise<{ captured: CapturedFolder; revision: string }> {
    const dir = await mkdtemp(join(this.options.workRoot, "folder-plan-"));
    try {
      const { source, snapshot, capture } = await this.options.syncer.captureFolderPackage(sourceId, { kind, name }, dir);
      const tree = new StagedTree(dir, snapshot.commit, snapshot.fetchedAt, capture.executable);
      return {
        captured: { dir, access: stagedAccess(tree, source.origin === "direct", rootNameOf(source.path)), notInstalled: capture.notInstalled },
        revision: snapshot.commit,
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async planInstall(request: InstallPlanRequest): Promise<InstallPlanView> {
    return this.operation(() => this.plan(request, false));
  }

  private async plan(request: InstallPlanRequest, adopt: boolean): Promise<InstallPlanView> {
    const planned = this.source(request.sourceId);
    // Capture first, then derive the row from that same read.
    const folder = planned.transport === "folder" ? await this.captureFolder(planned.id, request.kind, request.name) : null;
    try {
      return await this.planFrom(request, adopt, folder);
    } catch (error) {
      if (folder) await rm(folder.captured.dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async planFrom(request: InstallPlanRequest, adopt: boolean, folder: { captured: CapturedFolder; revision: string } | null): Promise<InstallPlanView> {
    const { row, snapshot } = await this.row(request);
    // Refuse during planning so the user is not asked to review an unusable plan.
    const source = this.source(row.sourceId);
    if (!this.registry.isEnabled(source, await this.registry.readState(source.id))) {
      throw new MarketplaceError("SOURCE_DISABLED", `source ${source.id} is hidden; show it again to install or update from it`);
    }
    // Current direct-install policy also applies to sources added before it changed.
    if (source.origin === "direct") this.options.gate.checkDirectInstall(source.transport === "git" ? source.url.url : source.path);
    // A newer snapshot invalidates the capture if it no longer matches the row.
    if (folder && row.snapshotCommit !== folder.revision) {
      throw new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `${row.name} changed while it was read`, {
        detail: { reason: "changed-during-read", path: source.transport === "folder" ? source.path : row.sourceId },
      });
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
    const captured = folder?.captured ?? null;
    let held: HeldPlan;
    let mcp: McpRuntimeView | null = null;
    let rungs: InstallPlanView["rungs"] = [];
    if (row.kind === "plugin") {
      const plan = planPluginVersion(row, version);
      held = { kind: "plugin", plan, switchSource, policyDigest, folder: captured, installed: installIdentity(installed) };
      rungs = await this.pluginRungViews(source, version, row.package.path);
    } else if (row.kind === "mcp") {
      const plan = { ...base, kind: "mcp" as const };
      const resolve = (access: RepositoryAccess) => resolveMcpPackage(plan, { ...access, limits: this.options.mcpLimits, workRoot: this.options.workRoot });
      const resolved = captured ? await resolve(captured.access) : await this.repositoryAccess(row.sourceId, resolve);
      this.options.installers.mcp.admit(row.name, resolved.runtime);
      held = { kind: "mcp", resolved, switchSource, policyDigest, folder: captured, installed: installIdentity(installed) };
      mcp = mcpRuntimeView(resolved.runtime);
    } else {
      held = { kind: "content", plan: base as ContentPlan, switchSource, adopt, policyDigest, folder: captured, installed: installIdentity(installed) };
    }
    // Only one plan per package remains live; replacing it also drops its files.
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
      hookConfinement: isPluginWorkerConfinementActive()
        ? process.platform === "win32" ? "unavailable" : "sandboxed"
        : "user-permissions",
      rungs,
      mcp,
      notInstalled: captured?.notInstalled ?? [],
    };
  }

  async planUpdate(key: PackageKeyView): Promise<UpdatePlanView> {
    return this.operation(() => this.planUpdateNow(key));
  }

  private async planUpdateNow(key: PackageKeyView): Promise<UpdatePlanView> {
    // Refuse quarantined ids and handles before reading any install list.
    const source = this.source(key.sourceId);
    const installed = await this.installed(key.kind, key.name);
    if (!installed || installed.sourceId !== source.id) {
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is not installed from ${source.id}`);
    }
    const state = await this.registry.readState(source.id);
    const historyRewritten =
      state.pendingRewrite && (source.origin === "custom" || source.origin === "direct")
        ? { pinned: state.pinnedCommit, candidate: state.pendingRewrite.candidate }
        : null;
    const plan = await this.planInstall(key);
    const baseline = await this.baselineOf(key.kind, key.name);
    if (!baseline) throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is no longer installed`);
    const { row } = await this.row(key);
    const version = row.package.versions.find((item) => item.version === plan.version);
    if (!version) throw new Error(`${key.sourceId} no longer lists ${key.kind} ${key.name} ${plan.version}`);
    // Finish both consent checkpoints before offering approval.
    const catalog = catalogDelta(baseline.consent, version);
    const held = this.plans.peek(plan.planId);
    const staged = await this.stageForReview(held, plan.planId);
    // Delivery labels follow actual transport, including redirects from HTTPS to HTTP.
    const rungs = held.kind === "plugin" && held.staged ? stagedRungViews(plan.rungs, held.staged) : plan.rungs;
    let consentDelta = staged ? stagedDelta(baseline.consent, staged.consent, catalog) : catalog;
    if (staged?.files && baseline.files) consentDelta = withChangedFiles(consentDelta, baseline.files, staged.files, staged.declaring);
    let delta: UpdatePlanView["authorityDelta"] = null;
    let componentsDelta: UpdatePlanView["componentsDelta"] = null;
    if (key.kind === "plugin" && plan.authority) {
      // Consent baseline comes from installed bytes, never the catalog copy.
      const previous: PluginAuthority | null = await this.options.installers.plugin.installedAuthority(key.name);
      delta = authorityDelta(previous ? authorityView(previous) : authorityView({ capabilities: [] }), plan.authority);
    }
    const components = staged?.components ?? plan.components;
    if (key.kind === "agent-plugin" && components) {
      const previous = await this.options.installers.content.installedComponents(key.name);
      componentsDelta = componentDelta(previous, components);
    }
    return {
      ...plan,
      ...(components ? { components } : {}),
      from: installed.version,
      commitRange: { from: installed.originCommit, to: plan.snapshotCommit },
      authorityDelta: delta,
      componentsDelta,
      historyRewritten,
      needsConfirmation: widensAuthority(delta) || historyRewritten !== null,
      consentDelta,
      codeFreeChange: isCodeFreeChange(consentDelta),
      reviewComponents: reviewComponentsOf(key.kind, consentDelta, staged?.consent ?? null, components),
      rungs,
    };
  }

  /** Stage the complete consent fingerprint for review; execution reuses these exact bytes. */
  private async stageForReview(held: HeldPlan, planId: string): Promise<StagedReview | null> {
    if (held.kind === "plugin") {
      const artifact = await this.stagePlugin(null, held, held.plan);
      held.staged = artifact;
      const files = this.options.installers.plugin.stagedFiles(artifact);
      return { consent: pluginConsent(artifact.manifestDocument, files), files, components: null, declaring: new Set(extensionDeclarationPaths(artifact.manifestDocument)) };
    }
    if (held.kind === "content") {
      if (CATALOG_COMPLETE_KINDS.has(held.plan.kind)) return null;
      const staged = await this.stageContent(planId, held, false);
      held.staged = staged;
      const components = staged.content.kind === "agent-plugin" ? staged.content.components : null;
      return {
        consent: stagedConsent(staged),
        files: staged.files.map((file) => ({ path: file.path, data: file.data })),
        components,
        declaring: new Set(components ? AGENT_PLUGIN_DECLARATION_PATHS : []),
      };
    }
    if (held.kind === "mcp") return { consent: mcpConsent(held.resolved.runtime), files: null, components: null, declaring: new Set() };
    return null;
  }

  private progress(planId: string, phase: InstallProgressView["phase"], rung: InstallProgressView["rung"] = null): void {
    this.options.onInstallProgress?.({ planId, phase, rung, bytes: null, total: null });
  }

  async executeInstall(planId: string, componentConsents: readonly ComponentConsent[] = [], reviewedAuthority = false): Promise<InstallResultView> {
    return this.operation(() => this.executeInstallNow(planId, componentConsents, { reviewedAppVersion: reviewedAuthority ? getAveAppVersion() : null }));
  }

  private async executeInstallNow(planId: string, componentConsents: readonly ComponentConsent[], review: InstallReview): Promise<InstallResultView> {
    const held = this.plans.take(planId);
    const target = heldTarget(held);
    try {
      return await this.withPackage(target.kind, target.name, () => this.executeHeld(planId, held, componentConsents, review));
    } finally {
      if (held.folder) await rm(held.folder.dir, { recursive: true, force: true });
    }
  }

  private async executeHeld(planId: string, held: HeldPlan, componentConsents: readonly ComponentConsent[], review: InstallReview): Promise<InstallResultView> {
    // A changed policy requires a new review.
    if (held.policyDigest !== this.options.policy.digest) {
      throw new MarketplaceError("PLAN_EXPIRED", `plan ${planId} was made under another marketplace policy`, { detail: { reason: "policy-changed" } });
    }
    // The gates must judge the new install by the source it is about to be bound to, not the one it leaves.
    const target = heldTarget(held);
    // Recheck the installed identity under the package lock; pre-lock reviews can become stale.
    if (held.kind !== "mcp-unbound") {
      if (!isDeepStrictEqual(installIdentity(await this.installed(target.kind, target.name)), held.installed)) {
        throw new MarketplaceError("PLAN_EXPIRED", `${target.kind} ${target.name} changed since plan ${planId} was made`, { detail: { reason: "package-changed" } });
      }
      // Re-read revocations before installing; the policy digest was checked above.
      const { sourceId, version } = held.kind === "mcp" ? held.resolved.plan : held.plan;
      const feed = await revocationFeed([{ kind: target.kind, name: target.name, sourceId }], (id) => this.options.syncer.readRevocations(id, this.options.versionContext().appVersion));
      if (findRevocation(target.kind, target.name, version, feed.rules)) {
        throw new MarketplaceError("PACKAGE_REVOKED", `${target.name} ${version} was revoked by ${this.viewSourceId(sourceId)} since plan ${planId} was made`);
      }
    }
    const key = keyOf(target.kind, target.name);
    this.pendingBindings.set(key, target);
    try {
      await this.feedRevocations();
      const extension = componentConsents.filter((consent): consent is ExtensionComponentConsent => "kind" in consent && consent.kind === "extension");
      const agent = componentConsents.filter((consent) => !("kind" in consent) || consent.kind === "hook");
      if (extension.length > 0 && held.kind !== "plugin") throw new Error("extension component consent applies only to an extension install");
      if (agent.length > 0 && (held.kind !== "content" || held.plan.kind !== "agent-plugin")) {
        throw new Error("component consent applies only to an agent plugin install");
      }
      return await this.runInstall(planId, held, agent as Array<Exclude<ComponentConsent, ExtensionComponentConsent>>, extension, review);
    } finally {
      if (this.pendingBindings.get(key) === target) this.pendingBindings.delete(key);
      await this.refeedAfter(`${target.kind} ${target.name} install`);
    }
  }

  /** Stage captured folder bytes or use the source ladder; active plans receive progress. */
  private async stagePlugin(planId: string | null, held: HeldPlan & { kind: "plugin" }, plan: PluginInstallPlan): Promise<StagedPluginArtifact> {
    if (held.folder) {
      const folder = held.folder;
      const artifact = await runFolderRung(plan, {
        ...folder.access,
        zip: this.options.ladder.zip,
        limits: this.options.ladder.limits,
        workRoot: this.options.workRoot,
      }, folder.notInstalled);
      if (planId) this.progress(planId, "installing", artifact.rung);
      return artifact;
    }
    const staged = await this.options.syncer.withRepository(plan.sourceId, async ({ source, repo, remote }) => {
      if (planId) this.progress(planId, "downloading");
      return runPluginLadder(plan, {
        ...gitAccess(repo, remote, source.origin === "direct"),
        repo,
        remote,
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
    });
    if (planId) this.progress(planId, "installing", staged.rung);
    return staged;
  }

  private async stageContent(planId: string, held: HeldPlan & { kind: "content" }, report: boolean): Promise<StagedContent> {
    const { plan } = held;
    if (report) this.progress(planId, "downloading");
    const stage = (access: RepositoryAccess) => stageContentPackage(plan, access, { workRoot: this.options.workRoot, english: this.options.english });
    return held.folder ? stage(held.folder.access) : this.repositoryAccess(plan.sourceId, stage);
  }

  private async runInstall(
    planId: string,
    held: HeldPlan,
    componentConsents: ReadonlyArray<Exclude<ComponentConsent, ExtensionComponentConsent>>,
    extensionConsents: readonly ExtensionComponentConsent[],
    review: InstallReview,
  ): Promise<InstallResultView> {
    this.progress(planId, "resolving");
    let result: InstallResultView;
    if (held.kind === "plugin") {
      const { plan } = held;
      const reviewed = held.staged;
      const outcome = await this.options.installers.plugin.install(plan, {
        switchSource: held.switchSource,
        ...(review.reviewedAppVersion ? { reviewedAppVersion: review.reviewedAppVersion } : {}),
        ...(review.assertConsent ? { assertConsent: review.assertConsent } : {}),
        ...(extensionConsents.length > 0 ? { componentConsents: extensionConsents } : {}),
        // Install the reviewed staged bytes without another download.
        stage: reviewed
          ? async () => {
            this.progress(planId, "installing", reviewed.rung);
            return reviewed;
          }
          : (staged) => this.stagePlugin(planId, held, staged),
      });
      result = {
        key: { sourceId: plan.sourceId, kind: "plugin", name: plan.name },
        version: plan.version,
        action: installActionView(outcome.action),
        rungs: rungOutcomeViews(outcome.staged.rungs, outcome.staged.unencrypted),
        connectionWarning: null,
      };
    } else if (held.kind === "content") {
      const { plan } = held;
      const staged = held.staged ?? await this.stageContent(planId, held, true);
      this.progress(planId, "installing");
      const outcome = await this.options.installers.content.install(staged, {
        switchSource: held.switchSource,
        adopt: held.adopt,
        componentConsents,
        ...(review.assertConsent ? { assertConsent: review.assertConsent } : {}),
      });
      result = { key: { sourceId: plan.sourceId, kind: plan.kind, name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: null };
    } else if (held.kind === "mcp") {
      const { plan } = held.resolved;
      // MCP command versions are consent-bearing, so automatic updates cannot reach this path.
      if (review.assertConsent) review.assertConsent(mcpConsent(held.resolved.runtime));
      this.progress(planId, "installing");
      const outcome = await this.options.installers.mcp.install(held.resolved, { switchSource: held.switchSource });
      result = { key: { sourceId: plan.sourceId, kind: "mcp", name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: outcome.connectionWarning };
    } else {
      this.progress(planId, "installing");
      const { connectionWarning } = await this.options.installers.mcp.installUnbound(held.name, held.runtime);
      result = { key: { sourceId: null, kind: "mcp", name: held.name }, version: null, action: { action: "install" }, rungs: [], connectionWarning };
    }
    this.catalogChanged();
    return result;
  }

  private async catalogSource(source: GitSource): Promise<CatalogSource> {
    const snapshot = await this.options.syncer.readSnapshot(source.id);
    return { id: source.id, label: sourceLabel(source, snapshot), url: source.url, acknowledged: await this.registry.acknowledged(source) };
  }

  /** Null without token authentication; release downloads otherwise use the stored token. */
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

  /** Resolve a view id or handle to stored identity once; removal operates only on that identity. */
  async uninstall(request: UninstallRequest, options?: { retain: { reason: PluginConfigRetention["reason"] } }): Promise<UninstallResultView> {
    return this.operation(() => this.withPackage(request.kind, request.name, () => this.uninstallNow(request, options)));
  }

  private async uninstallNow(request: UninstallRequest, options?: { retain: { reason: PluginConfigRetention["reason"] } }): Promise<UninstallResultView> {
    if (request.removeData === true && request.kind !== "mcp" && request.kind !== "agent-plugin") {
      throw new Error("removeData applies only to server or agent plugin packages");
    }
    const installed = await this.installed(request.kind, request.name);
    const named = installed === null ? undefined : installed.sourceId === null ? null : this.viewSourceId(installed.sourceId);
    if (!installed || named !== request.sourceId) {
      const from = request.sourceId === null ? "without a source" : `from ${request.sourceId}`;
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${request.kind} ${request.name} is not installed ${from}`);
    }
    return this.uninstallStoredNow({ sourceId: installed.sourceId, kind: request.kind, name: request.name }, request.removeData === true, options);
  }

  /** Main-process entry accepts stored identity only, never a view handle. */
  async uninstallInstalled(
    key: StoredInstallKey,
    options?: { retain?: { reason: PluginConfigRetention["reason"] }; lease?: PackageLease },
  ): Promise<UninstallResultView> {
    const retain = options?.retain ? { retain: options.retain } : undefined;
    return this.operation(() => this.withPackage(key.kind, key.name, () => this.uninstallStoredNow(key, false, retain), options?.lease ? { lease: options.lease } : {}));
  }

  private async uninstallStoredNow(
    key: StoredInstallKey,
    removeData: boolean,
    options?: { retain: { reason: PluginConfigRetention["reason"] } },
  ): Promise<UninstallResultView> {
    const installed = await this.installed(key.kind, key.name);
    const viewed = key.sourceId === null ? null : this.viewSourceId(key.sourceId);
    if (!installed || installed.sourceId !== key.sourceId) {
      const from = viewed === null ? "without a source" : `from ${viewed}`;
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is not installed ${from}`);
    }
    const sourceId = key.sourceId;
    assertNotRequiredByPolicy(this.policy, key.kind, key.name, sourceId, "uninstall");
    let keptDataDir: string | null = null;
    if (key.kind === "plugin") {
      let retain: PluginConfigRetention | undefined;
      if (options?.retain) {
        const entry = await this.getRetirementEntry(key.name);
        if (!entry || (sourceId !== null && entry.sourceId !== sourceId)) throw new Error("Plugin retirement entry is unavailable");
        retain = { reason: options.retain.reason, sourceId, successors: entry.successors };
      }
      await this.options.installers.plugin.uninstall(key.name, retain);
    } else if (key.kind === "mcp") ({ keptDataDir } = await this.options.installers.mcp.uninstall(key.name, { removeData }));
    else await this.options.installers.content.uninstall(key.kind, key.name, { removeData });
    await this.refeedAfter(`${key.kind} ${key.name} uninstall`);
    this.catalogChanged();
    return { key: { sourceId: viewed, kind: key.kind, name: key.name }, keptDataDir };
  }

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
    const last = record.name.slice(record.name.lastIndexOf("/") + 1);
    // Reject credential-shaped names because the installed server name is returned to views.
    if (holdsCredential(last)) {
      const refusal = credentialRefusal("name", last);
      throw new MarketplaceError("SOURCE_INDEX_INVALID", `server.json: ${refusal.message}`, { detail: refusal.detail });
    }
    const name = idFrom(last);
    if (!name) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `server.json name ${record.name} does not end in a usable name`);
    const runtime = runtimeFromServerJson(document, request.select);
    assertMcpRuntimePinned(name, runtime);
    this.options.installers.mcp.admit(name, runtime);
    const ticket = this.plans.issue({ kind: "mcp-unbound", name, runtime, policyDigest: this.options.policy.digest, folder: null }, `unbound:mcp:${name}`);
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

  async updates(signal?: AbortSignal): Promise<PackageUpdateOffer[]> {
    return this.operation(async () => (await this.offersNow()).map((item) => item.offer), signal);
  }

  /** Folder digest changes offer an equal-version refresh or a manual lower-version downgrade. */
  private async offersNow(): Promise<Array<{ offer: PackageUpdateOffer; change: UpdateChange; row: CatalogRow; installed: InstalledRecord & { sourceId: string; version: string } }>> {
    const installed = await this.installedAll();
    const bound = new Set(installed.map((item) => item.sourceId).filter((sourceId): sourceId is string => sourceId !== null));
    const { rows } = await this.rows(bound);
    const existing = new Set(this.registry.list().map((source) => source.id));
    const offers: Array<{ offer: PackageUpdateOffer; change: UpdateChange; row: CatalogRow; installed: InstalledRecord & { sourceId: string; version: string } }> = [];
    for (const item of installed) {
      if (item.sourceId === null || item.version === null) continue;
      const record = { ...item, sourceId: item.sourceId, version: item.version };
      const state = updateFor(record, rows, existing);
      let found: { row: CatalogRow; version: string; change: UpdateChange } | null = null;
      if (state.state === "update") found = { row: state.row, version: state.version, change: "upgrade" };
      else if (state.state === "current") found = folderChange(record, rows);
      if (!found) continue;
      offers.push({
        offer: {
          key: { sourceId: item.sourceId, kind: item.kind, name: item.name },
          displayName: found.row.package.displayName ?? item.name,
          from: item.version,
          to: found.version,
        },
        change: found.change,
        row: found.row,
        installed: record,
      });
    }
    return offers;
  }

  private async baselineOf(kind: PackageKind, name: string): Promise<InstalledBaseline | null> {
    if (kind === "plugin") return this.options.installers.plugin.baseline(name);
    if (kind === "mcp") {
      const consent = await this.options.installers.mcp.baseline(name);
      return consent ? { consent, reviewedAppVersion: null, enabled: true, files: null } : null;
    }
    const consent = await this.options.installers.content.baseline(kind, name, (origin) => this.installedDescriptor(kind, name, origin));
    if (!consent) return null;
    return { consent, reviewedAppVersion: null, enabled: true, files: await this.options.installers.content.installedFiles(kind, name) };
  }

  /** Reconstruct legacy descriptor fields from the retained install snapshot; missing snapshots leave them unknown. */
  private async installedDescriptor(kind: PackageKind, name: string, origin: { sourceId: string | null; commit: string | null; packagePath: string; version: string }): Promise<{ minAppVersion: string | null; hostProtocol: string | null } | null> {
    if (origin.sourceId === null || origin.commit === null) return null;
    const snapshot = await this.options.syncer.readRetainedSnapshot(origin.sourceId, origin.commit);
    const listed = snapshot?.packages.find((item) => item.kind === kind && item.name === name && item.path === origin.packagePath);
    const version = listed?.versions.find((item) => item.version === origin.version);
    return version ? { minAppVersion: version.minAppVersion, hostProtocol: version.hostProtocol ?? null } : null;
  }

  private async componentApprovals(kind: PackageKind, name: string): Promise<ComponentApprovalState[]> {
    if (kind === "plugin") return this.options.installers.plugin.componentApprovals(name);
    if (kind === "agent-plugin") return this.options.installers.content.componentApprovals(name);
    return [];
  }

  /** Classify only reached-source offers and required source switches; absent packages use boot installation. */
  async updateCandidates(reached: ReadonlySet<string>, signal?: AbortSignal): Promise<UpdateCandidate[]> {
    return this.operation(() => this.updateCandidatesNow(reached), signal);
  }

  private async updateCandidatesNow(reached: ReadonlySet<string>, only?: PackageKeyView): Promise<UpdateCandidate[]> {
    const offers = await this.offersNow();
    const installed = await this.installedAll();
    const { rows } = await this.rows(new Set(installed.map((item) => item.sourceId).filter((id): id is string => id !== null)));
    const revoked = await this.revokedInstalls(installed);
    const found: Array<{ offer: PackageUpdateOffer; change: UpdateChange; row: CatalogRow; record: InstalledRecord; required: boolean }> = offers.map((item) => ({
      offer: item.offer,
      change: item.change,
      row: item.row,
      record: item.installed,
      required: requiresPackage(this.policy, item.offer.key),
    }));
    for (const key of this.policy.requiredInstalls) {
      const record = installed.find((item) => item.kind === key.kind && item.name === key.name);
      // First installs belong to boot; same-source upgrades were collected above.
      if (!record || record.sourceId === key.source) continue;
      const row = rows.find((item) => item.sourceId === key.source && item.kind === key.kind && item.name === key.name);
      if (!row || row.choice.state !== "candidate" || (row.sourceOrigin !== "official" && row.sourceOrigin !== "managed")) continue;
      found.push({
        offer: { key: { sourceId: key.source, kind: key.kind, name: key.name }, displayName: row.package.displayName ?? key.name, from: record.version ?? "", to: row.choice.version.version },
        change: "switch",
        row,
        record,
        required: requiresPackage(this.policy, { sourceId: key.source, kind: key.kind, name: key.name }),
      });
    }
    const candidates: UpdateCandidate[] = [];
    for (const item of found) {
      const { key } = item.offer;
      if (!reached.has(key.sourceId)) continue;
      if (only && (only.sourceId !== key.sourceId || only.kind !== key.kind || only.name !== key.name)) continue;
      const source = this.source(key.sourceId);
      const state = await this.registry.readState(source.id);
      const version = item.row.package.versions.find((entry) => entry.version === item.offer.to);
      if (!version) throw new Error(`${key.sourceId} offers ${key.kind} ${key.name} ${item.offer.to} without listing it`);
      const baseline = await this.baselineOf(key.kind, key.name);
      if (!baseline) continue;
      const approvals = await this.componentApprovals(key.kind, key.name);
      const http = source.transport === "git" && source.url.scheme === "http";
      candidates.push({
        ...item.offer,
        commitRange: { from: item.record.originCommit, to: item.row.snapshotCommit },
        switchSource: item.change === "switch",
        provides: key.kind === "plugin" ? [...(version.authority?.capabilities ?? [])] : [],
        needs: key.kind === "plugin" ? [...(version.authority?.requires?.capabilities ?? [])] : [],
        facts: {
          switchKey: packageUpdateSkipKey(key),
          to: item.offer.to,
          change: item.change,
          enabled: baseline.enabled && !revoked.has(keyOf(key.kind, key.name)),
          required: item.required,
          policyBlocked: this.policyBlocks(source),
          source: {
            id: source.id,
            origin: source.origin,
            http,
            acknowledgedUnencryptedUpdates: acknowledgedOf(source, state).includes("unencrypted-updates"),
            shown: this.registry.isEnabled(source, state),
            pendingRewrite: Boolean(state.pendingRewrite) && (source.origin === "custom" || source.origin === "direct"),
          },
          consent: catalogDelta(baseline.consent, version),
          // Legacy approvals without a digest cannot carry to new bytes.
          unconfirmedApprovals: approvals.filter((component) => component.approved && component.recordDigest === null).map((component) => component.field),
        },
      });
    }
    return candidates;
  }

  private async revokedInstalls(installed: readonly InstalledRecord[]): Promise<Set<string>> {
    const feed = await revocationFeed(boundOf(installed), (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    return new Set(revokedAmong(installed, feed.rules).map(({ record }) => keyOf(record.kind, record.name)));
  }

  /** Applies current direct-install and folder-source policy restrictions. */
  private policyBlocks(source: ResolvedSource): boolean {
    try {
      if (source.origin === "direct") this.options.gate.checkDirectInstall(source.transport === "git" ? source.url.url : source.path);
      if (source.transport === "folder") this.options.gate.checkFolderPolicy(source.path);
      return false;
    } catch (error) {
      if (isMarketplaceError(error) && error.code === "SOURCE_POLICY_BLOCKED") return true;
      throw error;
    }
  }

  /** Reauthorize queued updates under operation and package locks using current facts and settings.
     * Automatic updates check installed consent; required policy entries authorize their own review. */
  async applyUpdate(target: ApplyTarget, decide: ApplyDecision, signal?: AbortSignal): Promise<ApplyOutcome> {
    return this.operation(() => this.withPackage(target.key.kind, target.key.name, () => this.applyUpdateNow(target, decide), signal ? { signal } : {}), signal);
  }

  private async applyUpdateNow(target: ApplyTarget, decide: ApplyDecision): Promise<ApplyOutcome> {
    const { key } = target;
    const installed = await this.installed(key.kind, key.name);
    const bound = target.switchSource ? installed?.sourceId !== key.sourceId : installed?.sourceId === key.sourceId;
    if (!installed || (installed.version ?? "") !== target.from || !bound) return { state: "superseded" };
    const baseline = await this.baselineOf(key.kind, key.name);
    if (!baseline) return { state: "superseded" };
    // Recheck the offered version, change kind and automatic eligibility.
    const [current] = await this.updateCandidatesNow(new Set([key.sourceId]), key);
    if (!current || current.to !== target.to || current.from !== target.from || current.switchSource !== target.switchSource) return { state: "superseded" };
    if (!decide(current.facts, this.policy.autoUpdate)) return { state: "superseded" };
    const required = current.facts.required;
    const before = await this.componentApprovals(key.kind, key.name);
    let view: InstallPlanView;
    try {
      view = await this.plan({ sourceId: key.sourceId, kind: key.kind, name: key.name, ...(target.switchSource ? { switchSource: true } : {}) }, false);
    } catch (error) {
      return { state: "failed", error };
    }
    const held = this.plans.take(view.planId);
    try {
      if (view.version !== target.to) return { state: "superseded" };
      const review: InstallReview = required
        ? { reviewedAppVersion: getAveAppVersion() }
        : { reviewedAppVersion: baseline.reviewedAppVersion, assertConsent: requireConsentEqual(key.name, baseline.consent) };
      try {
        await this.executeHeld(view.planId, held, [], review);
      } catch (error) {
        const outcome = classifyApplyError(error);
        if (outcome.state !== "applied") return outcome;
      }
    } finally {
      if (held.folder) await rm(held.folder.dir, { recursive: true, force: true });
    }
    // Newly unapproved components leave the applied update waiting for review.
    const after = await this.componentApprovals(key.kind, key.name);
    const waiting = after.filter((component) => !component.approved
      && !before.some((prior) => prior.field === component.field && !prior.approved && prior.approvalDigest === component.approvalDigest));
    if (waiting.length > 0) return { state: "approval-pending" };
    if (key.kind === "plugin" && !this.options.installers.plugin.running(key.name)) return { state: "applied-not-running" };
    return { state: "applied" };
  }

  /** Re-read installed-generation state; null if the recorded source or version no longer matches. */
  async appliedState(key: PackageKeyView, to: string): Promise<AppliedState | null> {
    return this.operation(async () => {
      const installed = await this.installed(key.kind, key.name);
      if (!installed || installed.sourceId !== key.sourceId || installed.version !== to) return null;
      const unapproved = (await this.componentApprovals(key.kind, key.name)).filter((component) => !component.approved);
      if (unapproved.length > 0) {
        return { state: "approval-pending", pendingApproval: key.kind === "agent-plugin" ? await this.pendingApprovalOf(key.name, unapproved) : null };
      }
      if (key.kind === "plugin" && !this.options.installers.plugin.running(key.name)) return { state: "applied-not-running" };
      return { state: "applied" };
    });
  }

  private async pendingApprovalOf(name: string, unapproved: readonly ComponentApprovalState[]): Promise<NonNullable<Extract<AppliedState, { state: "approval-pending" }>["pendingApproval"]> | null> {
    const installId = await this.options.installers.content.installId("agent-plugin", name);
    // A legacy install has no install id to bind an approval to; it is reviewed by its next update.
    if (installId === null) return null;
    const components = await this.options.installers.content.installedComponents(name);
    const consents: ReviewedComponentConsent[] = [];
    const consentDelta: ConsentDelta = [];
    for (const component of unapproved) {
      const match = /^(mcpServer|hook):(.+)$/u.exec(component.field);
      if (!match) throw new Error(`unknown component field ${component.field}`);
      const id = match[2]!;
      if (match[1] === "mcpServer") {
        const server = Object.hasOwn(components.mcpServers, id) ? components.mcpServers[id] : undefined;
        if (!server) throw new Error(`agent plugin ${name} has no MCP server ${id}`);
        consents.push({ name: id, digest: server.digest, approvalDigest: component.approvalDigest });
      } else {
        const index = Number(id);
        const hook = components.hooks[index];
        if (!hook) throw new Error(`agent plugin ${name} has no hook ${id}`);
        consents.push({ kind: "hook", index, digest: hook.digest, approvalDigest: component.approvalDigest });
      }
      consentDelta.push({ field: component.field, checkpoint: "staged", before: null, after: component.approvalDigest });
    }
    return { installId, consentDelta, components: consents };
  }

  async callsInFlight(name: string): Promise<boolean> {
    return this.options.installers.content.callsInFlight(name);
  }

  /** Switches use current policy, source origin and plaintext-update consent. */
  async autoUpdateContext(signal?: AbortSignal): Promise<AutoUpdateContext> {
    return this.operation(async () => {
      const sources: AutoUpdateContext["sources"] = [];
      const quarantined = new Set<string>();
      for (const source of this.registry.list()) {
        // Never serve quarantined packages or expose their stored source id.
        if (this.registry.isQuarantined(source)) {
          quarantined.add(source.id);
          continue;
        }
        const read = await this.read(source);
        if ("problem" in read) continue;
        sources.push({
          id: source.id,
          label: sourceLabel(source, read.snapshot),
          origin: source.origin,
          http: source.transport === "git" && source.url.scheme === "http",
          acknowledgedUnencryptedUpdates: acknowledgedOf(source, read.state).includes("unencrypted-updates"),
        });
      }
      const all = await this.installedAll();
      // Every bound package, whatever its source's health: required-ness does not depend on it.
      const installed = all
        .filter((item): item is InstalledRecord & { sourceId: string } => item.sourceId !== null && !quarantined.has(item.sourceId))
        .map((item) => ({ sourceId: item.sourceId, kind: item.kind, name: item.name }));
      return {
        policy: this.policy.autoUpdate,
        requiredInstalls: structuredClone([...this.policy.requiredInstalls]),
        unmetRequired: await this.unmetRequiredNow(all),
        sources,
        installed,
      };
    }, signal);
  }

  /** Judge requirements from registry and files, so hiding a source cannot hide an unmet requirement. */
  private async requiredSourceStates(): Promise<Map<string, RequirementSourceState>> {
    const states = new Map<string, RequirementSourceState>();
    for (const id of new Set(this.policy.requiredInstalls.map((key) => key.source))) {
      const source = this.registry.get(id);
      if (!source || this.registry.isQuarantined(source)) {
        states.set(id, "missing");
        continue;
      }
      const read = await this.read(source);
      if ("problem" in read) states.set(id, "unreachable");
      else if (!this.registry.isEnabled(source, read.state)) states.set(id, "hidden");
      else states.set(id, read.snapshot ? "readable" : "unreachable");
    }
    return states;
  }

  /** Report requirements the source cannot provide; boot or the apply queue handles satisfiable ones.
     * Conflicting installs remain addressable for removal through their view identity. */
  private async unmetRequiredNow(installed: readonly InstalledRecord[]): Promise<UnmetRequirementView[]> {
    if (this.policy.requiredInstalls.length === 0) return [];
    const states = await this.requiredSourceStates();
    const { rows } = await this.rows();
    const others = installed.filter((item): item is InstalledRecord & { sourceId: string } => item.sourceId !== null
      && this.policy.requiredInstalls.some((key) => key.kind === item.kind && key.name === item.name && key.source !== item.sourceId));
    const listed = await this.rows(new Set(others.map((item) => item.sourceId)));
    // Removed or quarantined sources use their view id as the label.
    const label = async (sourceId: string) => {
      const source = this.registry.get(sourceId);
      if (!source || this.registry.isQuarantined(source)) return this.viewSourceId(sourceId);
      const read = await this.read(source);
      return sourceLabel(source, "problem" in read ? null : read.snapshot);
    };
    const unmet: UnmetRequirementView[] = [];
    for (const key of this.policy.requiredInstalls) {
      const current = installed.find((item) => item.kind === key.kind && item.name === key.name);
      if (current?.sourceId === key.source) continue;
      const state = states.get(key.source);
      if (state === undefined) throw new Error(`no state was read for required source ${key.source}`);
      const gap = requirementGap(key, state, rows);
      if (!gap) continue;
      unmet.push({
        key: { sourceId: key.source, kind: key.kind, name: key.name },
        sourceLabel: await label(key.source),
        reason: gap.reason,
        minAppVersion: gap.reason === "incompatible" ? gap.minAppVersion : null,
        installedFrom: current?.sourceId ? await this.installedFromView(current.sourceId, key, listed.rows, label) : null,
      });
    }
    return unmet;
  }

  private async installedFromView(sourceId: string, key: PackageKey, rows: readonly CatalogRow[], label: (sourceId: string) => Promise<string>): Promise<UnmetRequirementInstall> {
    // Quarantined catalogs cannot open package sheets.
    const sheet = rows.some((row) => row.sourceId === sourceId && row.kind === key.kind && row.name === key.name);
    // Derive the uninstall handle from the receipt even if its source no longer exists.
    return { sourceId: this.viewSourceId(sourceId), label: await label(sourceId), removal: sheet ? "sheet" : "confirm" };
  }

  /** Approval revalidates install id and every component digest under serialization; mismatches expire the plan. */
  async approveComponents(key: PackageKeyView, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void> {
    return this.operation(async () => {
      const installed = await this.installed(key.kind, key.name);
      if (key.kind !== "agent-plugin" || !installed || installed.sourceId !== key.sourceId) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is not an agent plugin installed from ${key.sourceId}`);
      }
      await this.options.installers.content.approveComponents(key.name, installId, consents);
      this.catalogChanged();
    });
  }

  async applyBootInstalls(
    defaults: readonly PackageKey[],
    applied: AppliedDefaults,
    signal?: AbortSignal,
  ): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }> {
    return this.operation(() => this.applyBootInstallsNow(defaults, applied, signal), signal);
  }

  private async applyBootInstallsNow(
    defaults: readonly PackageKey[],
    applied: AppliedDefaults,
    signal?: AbortSignal,
  ): Promise<{ report: BootInstallReport; notice: BootInstallNoticeView | null }> {
    signal?.throwIfAborted();
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
    await this.enforceRevocations(signal);
    signal?.throwIfAborted();
    const revoked = this.revokedUnreported.splice(0);
    const { rows, snapshots, shown } = await this.rows();
    const synced = new Map<string, SourceOrigin>(shown.filter((source) => snapshots.has(source.id)).map((source) => [source.id, source.origin]));
    const report = await runBootInstalls({
      policy: this.policy,
      defaults,
      rows,
      synced,
      requiredSources: await this.requiredSourceStates(),
      installed: (kind, name) => this.installed(kind, name),
      install: async (row, options) => {
        const plan = await this.planInstall({ sourceId: row.sourceId, kind: row.kind, name: row.name, ...(options.switchSource ? { switchSource: true } : {}) });
        await this.executeInstall(plan.planId, [], options.required);
      },
      applied,
      now: () => this.now(),
      ...(signal ? { signal } : {}),
    });
    return { report, notice: bootInstallNoticeFrom(report, this.policy, legacy?.plugins ?? null, revoked) };
  }

  /** Enforce persisted revocations before network work, reporting each outcome once per session.
     * Cancellation stops queued enforcement; an already-started pass finishes. */
  async enforceRevocations(signal?: AbortSignal): Promise<void> {
    return this.operation(() => this.enforceRevocationsNow(signal), signal);
  }

  private async enforceRevocationsNow(signal?: AbortSignal): Promise<void> {
    const start = () => {
      signal?.throwIfAborted();
      return this.applyRevocations();
    };
    const run = this.enforceTail.then(start, start);
    this.enforceTail = run.catch(() => undefined);
    for (const item of await run) {
      const id = `${item.key.sourceId}/${item.key.kind}/${item.key.name}@${item.version}:${item.outcome}`;
      if (this.revokedQueued.has(id)) continue;
      this.revokedQueued.add(id);
      this.revokedUnreported.push(item);
    }
  }

  takeRevocationNotice(): BootInstallNoticeView | null {
    const revoked = this.revokedUnreported.splice(0);
    return revoked.length === 0 ? null : { forYou: [], required: [], unmanaged: [], lostGrants: [], revoked, autoUpdated: [] };
  }

  /** A post-commit feed failure is logged; it cannot fail the completed operation or replace the last good feed. */
  private async refeedAfter(operation: string): Promise<void> {
    try {
      await this.feedRevocations();
    } catch (error) {
      this.options.log.warn(`revocation feed after ${operation} failed; the gates keep the previous feed: ${errorMessage(error)}`);
    }
  }

  private feedRevocations(): Promise<RevokedInstall[]> {
    const run = this.feedTail.then(() => this.feedOnce(), () => this.feedOnce());
    this.feedTail = run.catch(() => undefined);
    return run;
  }

  /** Feed destination-source rules for in-flight installs, but enforce only settled installs. */
  private async feedOnce(): Promise<RevokedInstall[]> {
    const pending = [...this.pendingBindings.entries()];
    const inFlight = new Set(pending.map(([key]) => key));
    const settled = (await this.installedAll()).filter((item) => !inFlight.has(keyOf(item.kind, item.name)));
    const bound = boundOf(settled);
    for (const [, binding] of pending) {
      if (binding.sourceId !== null) bound.push({ kind: binding.kind, name: binding.name, sourceId: binding.sourceId });
    }
    const feed = await revocationFeed(bound, (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    await this.options.revocations.apply(feed);
    return revokedAmong(settled, feed.rules);
  }

  /** Preserve policy-locked installs and recheck each revocation under the package lock before removal. */
  private async applyRevocations(): Promise<RevokedPackageView[]> {
    const report: RevokedPackageView[] = [];
    for (const decided of await this.feedRevocations()) {
      const { kind, name } = decided.record;
      await this.withPackage(kind, name, async () => {
        const now = await this.installed(kind, name);
        const current = await this.revocationNow(now, decided.record);
        if (typeof current === "string") {
          this.options.log.warn(`revocation of ${this.viewSourceId(decided.record.sourceId)}/${kind}/${name}@${decided.record.version} skipped: ${current}`);
          return;
        }
        const entry = await this.enforceRevocation(current);
        if (entry) report.push(entry);
      });
    }
    return report;
  }

  /** Re-read source revocations under the package lock against the identity judged by the feed. */
  private async revocationNow(record: InstalledRecord | null, decided: InstalledRecord): Promise<RevokedInstall | string> {
    if (!record) return "it was removed before its turn";
    const feed = await revocationFeed(boundOf([record]), (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    // Unreadable sources supply no rules; this does not count as withdrawing a revocation.
    if (feed.unreadable.length > 0) return "its source's revocation rules could not be read; it is kept until they can be";
    const [revoked] = revokedAmong([record], feed.rules);
    if (revoked) return revoked;
    return isDeepStrictEqual(installIdentity(record), installIdentity(decided))
      ? "its source no longer revokes it"
      : `it was replaced by ${record.version} ${record.sourceId === null ? "without a source" : `from ${this.viewSourceId(record.sourceId)}`}, which its own source's revocations do not cover`;
  }

  private async enforceRevocation({ record, revocation }: RevokedInstall): Promise<RevokedPackageView | null> {
    if (revocation.action === "disable" && GATED_KINDS.has(record.kind)) return null;
    const item = { key: { sourceId: this.viewSourceId(record.sourceId), kind: record.kind, name: record.name }, version: record.version!, reason: revocation.reason };
    try {
      const retaining = record.kind === "plugin" && revocation.action === "uninstall" && revocation.successors !== undefined;
      if (retaining) {
        await this.options.installers.plugin.retire(record.name, {
          reason: "revoked", sourceId: record.sourceId, successors: revocation.successors!,
        });
      }
      if (lockedByPolicy(this.policy, record.kind, record.name, record.sourceId)) return { ...item, outcome: "required" };
      await this.uninstallStoredNow({ sourceId: record.sourceId, kind: record.kind, name: record.name }, false,
        retaining ? { retain: { reason: "revoked" } } : undefined);
      return { ...item, outcome: "uninstalled" };
    } catch (error) {
      return { ...item, outcome: "failed", message: errorMessage(error) };
    }
  }

  close(): void {
    this.previews.clear();
    this.plans.clear();
  }
}
