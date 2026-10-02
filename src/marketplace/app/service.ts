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
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
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
import { PACKAGE_KINDS, type AgentPluginComponents, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
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
  folderRungView,
  rungViews,
  runsCode,
  sourceStatus,
  versionViews,
  widensAuthority,
} from "./views.js";

/** An installed package named by its stored identity: the source id its install record holds, never a view's handle (§18.8). */
export interface StoredInstallKey {
  sourceId: string | null;
  kind: PackageKind;
  name: string;
}

type ContentPlan = PackagePlan & { kind: Exclude<PackageKind, "plugin" | "mcp"> };

/**
 * A folder package the plan captured (§18.4.2): its staging directory under
 * `workRoot`, read at execution through `access`, and what the folder holds
 * that is not installed. Removed when the plan is used or dropped.
 */
interface CapturedFolder {
  dir: string;
  access: RepositoryAccess;
  notInstalled: string[];
}

/**
 * The install a decision was made for (§18.6): the installed receipt's
 * stored source, version, origin commit and digest, or null when nothing is
 * installed. A decision made before its package lock holds under the lock
 * only while the package is still installed with this identity.
 */
type InstallIdentity = { sourceId: string | null; version: string | null; originCommit: string | null; digest: string | null } | null;

function installIdentity(record: InstalledRecord | null): InstallIdentity {
  return record ? { sourceId: record.sourceId, version: record.version, originCommit: record.originCommit, digest: record.digest ?? null } : null;
}

/**
 * A plan, and the digest of the policy it was made under (§18.6): executed
 * under another, it expires. So does a plan from a source whose package is
 * no longer installed as it was when the plan was made (`installed`): a
 * direct server.json binds nothing and replaces only an unbound server
 * (§8.1). `folder` is set for a plan from a folder source.
 */
type HeldPlan = { policyDigest: string; folder: CapturedFolder | null } & (
  /** `staged`: an update review staged the artifact (§18.7.3); execution installs exactly it and downloads nothing. */
  | { kind: "plugin"; plan: PluginInstallPlan; switchSource: boolean; installed: InstallIdentity; staged?: StagedPluginArtifact }
  | { kind: "content"; plan: ContentPlan; switchSource: boolean; adopt: boolean; installed: InstallIdentity; staged?: StagedContent }
  | { kind: "mcp"; resolved: ResolvedMcpServer; switchSource: boolean; installed: InstallIdentity }
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

/**
 * What an install's review decided (§18.7.3): the app version whose review
 * its receipt records — the current one for a reviewed or required install,
 * the previous receipt's for an automatic update, none otherwise — and, for
 * an automatic update, checkpoint two.
 */
/** What staging an update for its review read: its fingerprint, files, components and the files that declare its servers and hooks. */
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

/** What an installed package was accepted with (§18.7.3). */
interface InstalledBaseline {
  consent: ConsentFingerprint;
  /** The receipt's `reviewedAppVersion` (extensions); an automatic update keeps it. */
  reviewedAppVersion: string | null;
  enabled: boolean;
  /** The installed files, for the review's changed-file list; null when they cannot be read. */
  files: PayloadFile[] | null;
}

/**
 * Kinds whose whole consent fingerprint is in the catalog (`minAppVersion`
 * only): their update review needs no staging (§18.7.3).
 */
const CATALOG_COMPLETE_KINDS: ReadonlySet<PackageKind> = new Set(["skill", "agent", "theme", "font", "language"]);

/** An offered update and what decides whether it applies by itself (§18.7.2). */
export interface UpdateCandidate extends PackageUpdateOffer {
  facts: UpdateFacts;
  /** `origin.commit` of the install to the snapshot that offers the update: *What changed* (§15.6). */
  commitRange: { from: string | null; to: string };
  /** A required switch to the policy's source (§10.2). */
  switchSource: boolean;
  /** An extension's capabilities and required capabilities, for the apply order (§18.7.4). */
  provides: string[];
  needs: string[];
}

/**
 * What the switches and every view's required status resolve with
 * (§18.7.2): the policy's `autoUpdate` and `requiredInstalls`, the facts of
 * each source whose metadata reads, and every installed package bound to a
 * source, readable or not, so its switch can be set before it has an
 * update. Required-ness is {@link requiresPackage} of the policy's entries
 * and a package's identity alone.
 */
export interface AutoUpdateContext {
  policy: MarketplacePolicy["autoUpdate"];
  requiredInstalls: PackageKey[];
  /** Each required install not met now, and why (§10.2), for the Updates card. */
  unmetRequired: UnmetRequirementView[];
  sources: Array<{ id: string; label: string; origin: SourceOrigin; http: boolean; acknowledgedUnencryptedUpdates: boolean }>;
  installed: PackageKeyView[];
}

/**
 * What the apply queue asks the service to install: which update, never
 * whether it may apply. That is decided again when its turn comes, from what
 * is installed, offered and in force then (§18.7.4).
 */
export interface ApplyTarget {
  key: PackageKeyView;
  from: string;
  to: string;
  switchSource: boolean;
}

/**
 * Decides, under the operation and the package lock, whether an update
 * still applies by itself: the facts the service gathers now and the
 * organization's `autoUpdate` now, with the user's switches, skips and
 * failures as the caller reads them now (§18.7.2).
 */
/** A caller's hold of package locks (§18.6), passed down to an install or uninstall that runs under them. */
export type PackageLease = MutexLease;

export type ApplyDecision = (facts: UpdateFacts, policy: MarketplacePolicy["autoUpdate"]) => boolean;

/** An applied update re-read: still installed at its version, and in which state; null when it no longer is. */
export type AppliedState =
  | { state: "applied" | "applied-not-running" }
  | { state: "approval-pending"; pendingApproval: { installId: string; consentDelta: ConsentDelta; components: ReviewedComponentConsent[] } | null };

/** An installed version its own source revokes. */
type RevokedInstall = { record: InstalledRecord & { sourceId: string }; revocation: RevocationFeed["rules"][number] };

/** The sources installs are bound to, as a revocation feed reads them (§10.4): an install without one has none to read. */
function boundOf(records: readonly InstalledRecord[]): BoundInstall[] {
  return records.flatMap((item) => (item.sourceId !== null ? [{ kind: item.kind, name: item.name, sourceId: item.sourceId }] : []));
}

/** The installs whose installed version their own source's rules revoke (§10.4); one without a source or a readable version is revoked by none. */
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
  /** Exactly the confirmations the preview carried; *Add* stores them (§18.5). */
  acknowledged: SourceWarning[];
} & (
  | {
    transport: "git";
    /** The preview's scratch clone. */
    dir: string;
    url: NormalizedSourceUrl;
    ref: string | null;
    subdir: string | null;
    auth: SourceAuth;
    token: string | null;
  }
  /** A folder is read in place: nothing is copied for a preview (§18.4.2). */
  | { transport: "folder"; path: string; dev: bigint; ino: bigint; ancestors: FolderIdentity[] }
);

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
  /**
   * How folders are read (§18.4): every filesystem call through `fs`, paths
   * read for `platform`, `~` expanded to `home`, and the ceiling on one
   * package's files and bytes.
   */
  folders: { fs: FolderFs; platform: NodeJS.Platform; home: string; limits: ExportLimits };
  english: Readonly<Record<string, string>>;
  onSyncProgress?: (progress: SyncProgressView) => void;
  /** Called outside the operation that changed the catalog: work it starts enters an operation of its own. */
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

/** How long a folder source's network class stands for its badge before it is asked again (§18.4.8). */
const FOLDER_BADGE_TTL_MS = 60_000;

/**
 * A folder package's change at a version `updateFor` calls current or older
 * (§18.7.6): its tree digest differs from the installed one, so an equal
 * version is a refresh and a lower one a downgrade, offered by hand only.
 */
function folderChange(installed: InstalledRecord & { sourceId: string; version: string }, rows: readonly CatalogRow[]): { row: CatalogRow; version: string; change: UpdateChange } | null {
  const row = rows.find((item) => item.sourceId === installed.sourceId && item.kind === installed.kind && item.name === installed.name);
  if (!row || row.choice.state !== "candidate" || row.package.treeSha256 === undefined) return null;
  if (!installed.digest || installed.digest === row.package.treeSha256) return null;
  const version = row.choice.version.version;
  const order = compareVersions(version, installed.version);
  if (order > 0) return null;
  return { row, version, change: order === 0 ? "refresh" : "downgrade" };
}

/**
 * The approve boxes of an update review (§18.7.3): each bundled MCP server
 * and hook whose consent field changed and that the update still has. An
 * extension's by local id with the approval digest the review computed; an
 * agent plugin's by name or index with its declared digest.
 */
function reviewComponentsOf(kind: PackageKind, delta: ConsentDelta, staged: ConsentFingerprint | null, components: AgentPluginComponents | null): ReviewComponentView[] {
  const views: ReviewComponentView[] = [];
  for (const entry of delta) {
    const match = /^(mcpServer|hook):(.+)$/u.exec(entry.field);
    if (!match) continue;
    const component = match[1] as "mcpServer" | "hook";
    const id = match[2]!;
    // A component the update removes asks for nothing.
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

/** A source id from a name: lowercase, `-` for anything else, never reserved. */
function idFrom(raw: string): string | null {
  const id = raw.toLowerCase().replace(/\.git$/u, "").replace(/[^a-z0-9-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return isSourceId(id) && !isReservedSourceId(id) ? id : null;
}

/**
 * The confirmations a source holds: its entry's (custom, direct) or its
 * state's (official, managed), §18.5. A managed folder holds
 * `network-folder` through its policy entry (§18.6).
 */
function acknowledgedOf(source: ResolvedSource, state: SourceState | null): SourceWarning[] {
  if (source.transport === "folder" && source.origin === "managed") return ["network-folder"];
  return source.origin === "custom" || source.origin === "direct" ? [...(source.acknowledged ?? [])] : confirmationsFor(state?.acknowledged, sourceIdentity(source));
}

/**
 * A folder's one badge (§18.4.8): on this computer, or on another one — which
 * the source either holds `network-folder` for or does not, so the badge never
 * claims a consent the source lacks.
 */
function folderBadge(network: FolderNetwork, acknowledged: readonly SourceWarning[]): SourceBadge {
  if (!network.network) return "local-folder";
  return acknowledged.includes("network-folder") ? "network-folder" : "network-folder-unconfirmed";
}

/** A request naming a quarantined source, by its stored id or its handle (§18.8): only Remove (and Uninstall of what it installed) is served. */
function quarantineRefusal(): MarketplaceError {
  return new MarketplaceError("SOURCE_ID_INVALID", "this source's id looks like a password or token; remove it and add it again with another id", {
    detail: { reason: "stored-id-holds-credential" },
  });
}

/** The folder classifier could not run (§18.4.1): a state of its own, never a guessed class. */
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

/** The parts of a marketplace preview that come from its snapshot (§7.2 step 4). */
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
  /** Keys the handles of quarantined sources ({@link handleOf}): a handle cannot be derived from the id without it. */
  private readonly handleKey = randomBytes(32);
  /**
   * Each folder source's network class for its badge (§18.4.8), by path. A
   * Windows drive letter's mapping is asked of the helper at most once per
   * `FOLDER_BADGE_TTL_MS`; every read still classifies the folder itself.
   */
  private readonly folderClasses = new Map<string, { network: FolderNetwork; at: number }>();
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
  /**
   * The operation the current call belongs to, so its own nested calls neither re-check the policy
   * nor take the lock again. It is open only while that operation runs: work it left behind that
   * outlives it finds it closed and enters an operation of its own.
   */
  private readonly inOperation = new AsyncLocalStorage<{ open: boolean }>();
  /**
   * One install, uninstall or automatic update of a package at a time
   * (§18.7.4), taken inside the operation and before any plugin lock. An
   * automatic update reads what is installed under it, so a user install or
   * uninstall of the same package is either done before it, and the update
   * is `superseded`, or waits for it. A caller that holds a package lock and
   * runs another install or uninstall of it passes its lease down (§18.6).
   */
  private readonly packageLocks = new KeyedMutex();
  /** The policy refresh now reading or applying; refreshes run one at a time, in order (§12). */
  private refreshRunning: Promise<void> | null = null;
  /**
   * The one refresh waiting for the running one, shared by every operation that began meanwhile, with
   * the cancellation signal of each (none for a caller that cannot be cancelled).
   */
  private refreshQueued: { promise: Promise<void>; waiters: Array<AbortSignal | undefined> } | null = null;

  constructor(private readonly options: MarketplaceServiceOptions) {
    const now = () => (options.now?.() ?? new Date()).getTime();
    // An abandoned folder plan's captured copy is removed when it expires or is replaced (§18.4.2).
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

  /** The policy in force; an unreadable one restricts nothing here, the gate blocks every non-official target (§12). */
  private get policy(): MarketplacePolicy {
    const load = this.options.policy.load;
    return load.ok ? load.policy : EMPTY_MARKETPLACE_POLICY;
  }

  /**
   * Run one operation (§18.6): first wait for a policy refresh that began
   * after this operation did, then run under the shared lock with the policy
   * that refresh left in force. A call made inside an operation, while it
   * runs, is part of it.
   *
   * `signal` cancels the caller (the update scheduler's shutdown). Cancelled
   * before or while it waits, the operation starts no refresh of its own, and
   * its body never starts; the call rejects with the signal's reason. A
   * refresh another caller still waits for runs all the same.
   */
  /**
   * Run `fn` as the only install, uninstall or update of `kind`/`name` (see
   * {@link packageLocks}). The lock comes after the operation and before any
   * plugin lock (§18.6): taking it while this context holds a plugin lock
   * could wait for an install that holds it and waits for that plugin lock,
   * so it throws instead. A caller that already holds it passes its `lease`
   * and `fn` runs at once, under that lease; the lease adds no package.
   * `signal` (the scheduler's shutdown) cancels the wait: aborted before the
   * lock is free, `fn` never starts and the call rejects with its reason.
   */
  private async withPackage<T>(kind: PackageKind, name: string, fn: () => Promise<T>, options: { signal?: AbortSignal; lease?: PackageLease } = {}): Promise<T> {
    const key = keyOf(kind, name);
    if (options.lease) return this.packageLocks.within(options.lease, [key], fn);
    return this.withPackages([key], () => fn(), options.signal);
  }

  /** Take every package lock in `keys` as one request (see {@link KeyedMutex}). */
  private async withPackages<T>(keys: readonly string[], fn: (lease: PackageLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.packageLocks.run(keys, fn, {
      ...(signal ? { signal } : {}),
      beforeAcquire: (wanted) => {
        if (holdsAnyPluginInstallLock()) {
          throw new Error(`lock order: the package lock of ${wanted.join(", ")} was asked for while a plugin lock is held; the package lock comes first (§18.6)`);
        }
      },
    });
  }

  private async operation<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.inOperation.getStore()?.open) return fn();
    await this.refreshPolicy(signal);
    return this.lock.shared(async () => {
      // Cancelled while it waited for the policy or the lock.
      signal?.throwIfAborted();
      const scope = { open: true };
      try {
        return await this.inOperation.run(scope, fn);
      } finally {
        scope.open = false;
      }
    });
  }

  /**
   * Run `fn` as one marketplace operation, so every service call it makes is
   * part of that operation (§18.6 lock order). A caller that also takes plugin
   * lifecycle locks enters here first and takes them inside: the marketplace
   * operation always comes before any plugin lock. Taking a plugin lock first
   * and then calling the service could wait for a policy change's exclusive
   * lock while an install holds the shared lock and waits for that plugin lock.
   */
  async asOneOperation<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * With `packages`: also hold every one of their package locks, taken as one
   * request, for the whole of `fn`. An install or uninstall `fn` runs of one
   * of them passes the lease `fn` receives; there is no second request.
   */
  async asOneOperation<T>(fn: (lease: PackageLease) => Promise<T>, packages: ReadonlyArray<{ kind: PackageKind; name: string }>): Promise<T>;
  async asOneOperation<T>(fn: (lease: PackageLease) => Promise<T>, packages?: ReadonlyArray<{ kind: PackageKind; name: string }>): Promise<T> {
    if (packages === undefined) return this.operation(() => (fn as () => Promise<T>)());
    return this.operation(() => this.withPackages(packages.map((item) => keyOf(item.kind, item.name)), fn));
  }

  /**
   * Tell the caller the catalog changed, outside this operation: what it starts
   * (a background update check) is detached work and enters its own operation,
   * with a fresh policy refresh and the shared lock.
   */
  private catalogChanged(): void {
    const notify = this.options.onCatalogChanged;
    if (notify) this.inOperation.exit(() => this.packageLocks.detached(notify));
  }

  /**
   * A refresh that begins no earlier than now (§12). Refreshes run one at a
   * time: each reads the file, compares it with the policy in force and, when
   * it changed, applies it under the exclusive lock before the next begins, so
   * the latest read is always the last applied and no read can finish out of
   * order. A refresh already running began before this call and may have read
   * the file too early, so the caller waits for the next one; every caller
   * arriving meanwhile shares that one, so overlapping operations cost one
   * extra read between them and still see a change within it.
   *
   * A cancelled caller starts no refresh: it is refused on arrival, and a
   * queued refresh whose every caller was cancelled while it waited does not
   * start. One live caller is enough for it to run.
   */
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
    // The queue moves on whatever this refresh met; its own callers see its failure.
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

  /**
   * A changed policy always applies, whoever waits. What it says about an
   * unreadable file is for the callers that wait: once each was cancelled
   * (the app shuts down), it is not logged.
   */
  private applyPolicy(update: PolicyUpdate, waiters: ReadonlyArray<AbortSignal | undefined>): void {
    this.options.policy.apply(update);
    if (!update.load.ok && waiters.some((waiter) => !waiter?.aborted)) {
      this.options.log.warn(`marketplace policy unreadable; only the official source is reachable: ${update.load.error}`);
    }
    // Managed sources, blocks and required installs may all have changed.
    this.catalogChanged();
  }

  private source(id: string): ResolvedSource {
    const source = this.registry.get(id);
    if (source && !this.registry.isQuarantined(source)) return source;
    if (source || this.quarantinedByHandle(id)) throw quarantineRefusal();
    throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
  }

  /**
   * The id the Sources view gives a quarantined source (§18.8) in place of
   * its own, which the renderer would only see masked: `ave-legacy-` and
   * an HMAC of the stored id under a key this service drew. It is stable
   * while the service runs, names that one stored entry, and cannot be
   * derived from the token; `ave-` ids are reserved, so no added source
   * has one.
   */
  private handleOf(id: string): string {
    return `${QUARANTINE_HANDLE_PREFIX}${createHmac("sha256", this.handleKey).update(id).digest("hex").slice(0, 32)}`;
  }

  /**
   * The id a view carries for a stored source id: the id itself, or, when
   * it has a credential's shape, its handle ({@link handleOf}). The handle
   * depends on the id alone, so an installed package keeps a usable identity
   * after its source is removed (§18.8).
   */
  private viewSourceId(id: string): string {
    return holdsCredential(id) ? this.handleOf(id) : id;
  }

  /** The quarantined source a handle names, checked against the stored entries now; null for anything else. */
  private quarantinedByHandle(handle: string): ResolvedSource | null {
    if (!handle.startsWith(QUARANTINE_HANDLE_PREFIX)) return null;
    return this.registry.list().find((source) => this.registry.isQuarantined(source) && this.handleOf(source.id) === handle) ?? null;
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
      // A quarantined folder is not classified: nothing is asked about a source that is only removed (§18.8).
      badges: quarantined && source.transport === "folder" ? [] : await this.badgesOf(source, acknowledgedOf(source, state)),
    };
  }

  /**
   * What a source's row and cards show while it applies (§18.5): a git
   * source's plain http and each confirmed class; a folder's *Local folder*
   * or *Network folder* (§18.4.8). A classifier that cannot run marks only
   * that folder (`folder-unclassified`), so the list, its other rows and
   * every recovery control still show.
   */
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

  /**
   * The folder *Show in Finder* opens (§18.4.8), by source id; null for a git
   * source, which has no folder. The folder is judged exactly as a read
   * judges it (`openStoredFolder`): the policy, its network class and the
   * `network-folder` confirmation before anything touches it, the fenced
   * walk, and the same canonical path and recorded identity — a directory
   * recreated at the path is `moved`, as a refresh says.
   *
   * The shell takes a path string, so what it opens is whatever the path
   * means when it acts. The last step here classifies the path again and
   * checks the confirmation, so the caller hands it to the shell with no
   * filesystem call in between. A drive remapped after that check, by a
   * concurrent change on this computer, is not caught (§18.4.1, the residual
   * beside the concurrent-swap one).
   */
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

  /**
   * Sync one source. With `signal` (the update scheduler's shutdown), an
   * aborted signal starts no sync, and a sync that ends after the abort
   * sends no progress and rejects with the signal's reason: the fetch in
   * progress finishes, nothing after it runs.
   */
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
    this.catalogChanged();
    await this.syncOne(source.id);
    await this.enforceRevocations();
    return this.listSources();
  }

  /** Sync one source, or every source that is shown or has installed packages (§7.3). */
  async refresh(id?: string): Promise<SourceView[]> {
    return this.operation(() => this.refreshNow(id));
  }

  private async refreshNow(id?: string): Promise<SourceView[]> {
    if (id !== undefined) await this.syncAndEnforce([this.source(id).id]);
    else await this.syncAll();
    return this.listSources();
  }

  /**
   * The discovery of design §18.7.1: sync every source that syncs, enforce
   * the revocations, and say how far it got. `ok` when every source synced;
   * `offline` when every source failed SOURCE_UNREACHABLE reason `offline`;
   * `partial` otherwise, with `reached` naming the sources that synced. A
   * broken source (§18.8) is not synced and counts as not reached; it is not
   * offline, so a discovery with one is never `offline` — the result that
   * leads the user to Sources. A failure outside a sync result throws, as
   * from {@link refresh}. `signal` is the scheduler's shutdown: once it
   * aborts, no further stage starts and no progress is sent, and the call
   * rejects with its reason.
   */
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

  /** Every source that is shown or has installed packages; a broken one is counted, not synced. */
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
      // Checked before the syncer touches the repository, pin or snapshot: a quarantined source is refused untouched (§18.8).
      const source = this.source(id);
      const result = await this.options.syncer.acceptRewrite(source.id, commit);
      if (result.status === "failed") throw new MarketplaceError(result.code, result.message, result.detail ? { detail: result.detail } : undefined);
      return this.sourceView(this.source(source.id));
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
      this.catalogChanged();
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
    // A quarantined source is removed through the handle its row carries, and only removed (§18.8).
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
    // Sign-in over plain http: a credential must not leave before the user accepts that (§18.2.2).
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
      // Over http without token-unencrypted the helper is switched off for every call, so it never answers (§7.4).
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
      // A single package at the root or the given folder: a direct source (§7.2 step 4, §8.1).
      const read = await readDirectPackage({ tree, path: subdir ?? "", rootName: rootNameOf(url.path) });
      if (!read) throw new MarketplaceError("SOURCE_NOT_A_MARKETPLACE", `no marketplace and no package at ${subdir ?? "the repository root"}`);
      if (!read.ok) throw new MarketplaceError(read.code, read.error, read.detail ? { detail: read.detail } : undefined);
      // `allowDirectInstall: false`: packages install from marketplaces only (§12).
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
      // The host wants sign-in over plain http: asked for before any credential is sent (§18.2.2).
      if (isMarketplaceError(error) && error.code === "SOURCE_AUTH_REQUIRED" && error.detail?.reason === "token-unencrypted") {
        return askConfirmation([{ warning: "token-unencrypted", host: url.host, address: null }]);
      }
      throw error;
    }
  }

  /**
   * Preview a folder (§18.4.1): stage 1 already ran. A folder takes no ref,
   * subdir or sign-in. Stage 2 classifies it without touching it; stage 3
   * applies the policy and asks for `network-folder` — a block or a
   * confirmation ends here with no filesystem call on the path. Only then
   * stage 4 walks it, fenced: a path on another computer the walk reaches
   * asks for `network-folder` before it is touched. The canonical path is
   * judged again, policy and network both, and the folder is read in place
   * (fenced the same way): a marketplace, or a direct package (§18.4.7).
   */
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
    // The canonical path's class: what is read, and what the badge names.
    let network: FolderNetwork;
    try {
      this.options.gate.checkFolder(path, await classifyFolder(path, platform, fs), confirmed);
      root = await resolveFolderRoot(path, platform, fs, networkConsented);
      network = await classifyFolder(root.path, platform, fs);
      // A block, or a folder on another computer, found only now on the canonical path ends the preview (§18.4.1 stage 4).
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
    // A direct folder install is refused by `allowDirectInstall: false` too (§18.4.7).
    this.options.gate.checkDirectInstall(root.path);
    // The folder is its one package: a reading rule it breaks fails the preview with its reason,
    // where a marketplace's snapshot would drop that package with a diagnostic (§2.2).
    await tree.packageAt("", read.found.descriptor.kind);
    // The direct read's revision: the same files a sync of the added source reads.
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

  /**
   * Write the entry, then the state, then move the preview's repository into
   * place and sync (§7.2 step 6): a repo.git without a state reads as lost.
   * A folder is written with its identity and read (§18.4).
   */
  async addSource(request: SourceAddRequest): Promise<SourceView> {
    return this.operation(async () => {
      try {
        return await this.addSourceNow(request);
      } catch (error) {
        throw this.viewTaken(error);
      }
    });
  }

  /**
   * SOURCE_ID_TAKEN for a duplicate names the source it duplicates by the id
   * its row carries (§18.8): a quarantined one by its handle, so *Show <id>*
   * opens that row and the stored id never leaves main, not even masked.
   * Any other error is returned as it is.
   */
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
      // The policy may have changed since the preview (§18.6).
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
        // The sync fetches from scratch instead.
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

  /** *Add* for a folder preview: the policy again (it may have changed, §18.6), the identity checks, the entry, then a read. */
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
      // A quarantined source (§18.8) is served to no one, bound packages included.
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
          // A source id with a credential's shape goes out as its handle, which Uninstall takes back (§18.8).
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

  /** The rungs a plugin version would be tried on: a git source's ladder, or a folder's one rung (§18.4.2). */
  private async pluginRungViews(source: ResolvedSource, version: IndexVersion, packagePath: string): Promise<InstallPlanView["rungs"]> {
    if (source.transport === "folder") return [folderRungView(packagePath)];
    return rungViews(version.artifact!, packagePath, await this.treeDeclared(source.id, version, packagePath), source.url);
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
    // A handle outlives its removed source while a package installed from it stays (§18.8): the
    // detail is refused for the same reason as before the removal, so the sheet says why and offers Uninstall.
    if (key.sourceId.startsWith(QUARANTINE_HANDLE_PREFIX) && !this.registry.get(key.sourceId)) {
      const installed = await this.installed(key.kind, key.name);
      if (installed?.sourceId && holdsCredential(installed.sourceId) && this.handleOf(installed.sourceId) === key.sourceId) throw quarantineRefusal();
    }
    const source = this.source(key.sourceId);
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
        repository: source.transport === "git" ? source.url.url : null,
        folder: source.transport === "folder" ? { path: source.path, readAt: await this.folderReadAt(source.id, snapshot), contents: row.package.treeSha256 ?? null } : null,
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
      rungs: row.kind === "plugin" && shownVersion?.artifact ? await this.pluginRungViews(source, shownVersion, row.package.path) : [],
      versions: versionViews(row, effectiveRevocations(snapshot, context.appVersion), context, installedHere),
    };
  }

  /**
   * When the contents a folder package shows were last read (§18.4.8): the
   * last read when it succeeded; after a failed one, when the snapshot still
   * served was read.
   */
  private async folderReadAt(sourceId: string, snapshot: SourceSnapshot): Promise<string> {
    const last = (await this.registry.readState(sourceId)).lastSync;
    return last?.result === "ok" ? last.at : snapshot.fetchedAt;
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

  private repositoryAccess<T>(sourceId: string, fn: (access: RepositoryAccess) => Promise<T>): Promise<T> {
    return this.options.syncer.withRepository(sourceId, ({ source, repo, remote }) => fn(gitAccess(repo, remote, source.origin === "direct")));
  }

  /**
   * Read the folder again and copy one package into a staging directory under
   * `workRoot` for a plan (§18.4.2). Execution reads only this copy.
   */
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

  /** `adopt` (content only): the install records an activation the settings already hold (§16.3). */
  private async plan(request: InstallPlanRequest, adopt: boolean): Promise<InstallPlanView> {
    const planned = this.source(request.sourceId);
    // A folder package is captured first, from a fresh read; the row then comes from that read's snapshot (§18.4.2).
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
    // Refused at the plan, before the review asks to confirm, not at execution (§7.3).
    const source = this.source(row.sourceId);
    if (!this.registry.isEnabled(source, await this.registry.readState(source.id))) {
      throw new MarketplaceError("SOURCE_DISABLED", `source ${source.id} is hidden; show it again to install or update from it`);
    }
    // `allowDirectInstall: false` refuses installs from a direct source added before it (§12, §18.4.7).
    if (source.origin === "direct") this.options.gate.checkDirectInstall(source.transport === "git" ? source.url.url : source.path);
    // Another read published between the capture and now: what was captured is not what the row lists.
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
      // Resolved now so the review shows the command that will run.
      const resolve = (access: RepositoryAccess) => resolveMcpPackage(plan, { ...access, limits: this.options.mcpLimits, workRoot: this.options.workRoot });
      const resolved = captured ? await resolve(captured.access) : await this.repositoryAccess(row.sourceId, resolve);
      this.options.installers.mcp.admit(row.name, resolved.runtime);
      held = { kind: "mcp", resolved, switchSource, policyDigest, folder: captured, installed: installIdentity(installed) };
      mcp = mcpRuntimeView(resolved.runtime);
    } else {
      held = { kind: "content", plan: base as ContentPlan, switchSource, adopt, policyDigest, folder: captured, installed: installIdentity(installed) };
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
      notInstalled: captured?.notInstalled ?? [],
    };
  }

  /** The update review (§15.6): commit range, authority delta, and rewritten history pending review. */
  async planUpdate(key: PackageKeyView): Promise<UpdatePlanView> {
    return this.operation(() => this.planUpdateNow(key));
  }

  private async planUpdateNow(key: PackageKeyView): Promise<UpdatePlanView> {
    // The source first (§18.8): a handle or a quarantined id is refused for what it is, before any install list is read.
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
    // Checkpoint one, then the staged bytes: the review never offers approval with a field still pending (§18.7.3).
    const catalog = catalogDelta(baseline.consent, version);
    const staged = await this.stageForReview(this.plans.peek(plan.planId), plan.planId);
    let consentDelta = staged ? stagedDelta(baseline.consent, staged.consent, catalog) : catalog;
    if (staged?.files && baseline.files) consentDelta = withChangedFiles(consentDelta, baseline.files, staged.files, staged.declaring);
    let delta: UpdatePlanView["authorityDelta"] = null;
    let componentsDelta: UpdatePlanView["componentsDelta"] = null;
    if (key.kind === "plugin" && plan.authority) {
      // The baseline is what is installed, never the catalog's copy of that version (§18.7.3).
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
    };
  }

  /**
   * Stage a held update plan for its review (§18.7.3), so the review shows
   * the complete fingerprint and execution installs exactly these bytes.
   * Kinds whose fingerprint the catalog carries whole are not staged. Returns
   * the staged fingerprint, files and (agent plugin) components.
   */
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
    // A reviewed or required install records this app version's review in its receipt (§10.3).
    return this.operation(() => this.executeInstallNow(planId, componentConsents, { reviewedAppVersion: reviewedAuthority ? getAveAppVersion() : null }));
  }

  private async executeInstallNow(planId: string, componentConsents: readonly ComponentConsent[], review: InstallReview): Promise<InstallResultView> {
    const held = this.plans.take(planId);
    const target = heldTarget(held);
    try {
      return await this.withPackage(target.kind, target.name, () => this.executeHeld(planId, held, componentConsents, review));
    } finally {
      // A folder plan's captured copy is used once (§18.4.2).
      if (held.folder) await rm(held.folder.dir, { recursive: true, force: true });
    }
  }

  private async executeHeld(planId: string, held: HeldPlan, componentConsents: readonly ComponentConsent[], review: InstallReview): Promise<InstallResultView> {
    // Reviewed under another policy: what it allows may have changed, so the review reopens (§18.6).
    if (held.policyDigest !== this.options.policy.digest) {
      throw new MarketplaceError("PLAN_EXPIRED", `plan ${planId} was made under another marketplace policy`, { detail: { reason: "policy-changed" } });
    }
    // The gates must judge the new install by the source it is about to be bound to, not the one it leaves.
    const target = heldTarget(held);
    // Made before this package's lock (a review, a boot pass's required switch): what it decided, and what a
    // review showed, was judged against the install then. Another install or removal since leaves it stale (§18.6).
    if (held.kind !== "mcp-unbound" && !isDeepStrictEqual(installIdentity(await this.installed(target.kind, target.name)), held.installed)) {
      throw new MarketplaceError("PLAN_EXPIRED", `${target.kind} ${target.name} changed since plan ${planId} was made`, { detail: { reason: "package-changed" } });
    }
    const key = keyOf(target.kind, target.name);
    this.pendingBindings.set(key, target);
    try {
      await this.feedRevocations();
      const extension = componentConsents.filter((consent): consent is ExtensionComponentConsent => "kind" in consent && consent.kind === "extension");
      const agent = componentConsents.filter((consent) => !("kind" in consent) || consent.kind === "hook");
      // An extension's bundled components by local id, an agent plugin's by name or index (§18.7.3).
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

  /**
   * Stage an extension: the plan's captured folder copy (nothing is
   * downloaded, §18.4.2) or the source's ladder. `planId` is set while an
   * install runs, so its progress is reported.
   */
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
        // A reviewed update installs the bytes its review staged; nothing is downloaded again (§18.7.3).
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
        rungs: rungOutcomeViews(outcome.staged.rungs),
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
      // An MCP server's version is in its command: an automatic update of one never reaches here (§18.7.3).
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

  /** The source as its catalog's downloads are judged (§18.2.3); only a git source downloads. */
  private async catalogSource(source: GitSource): Promise<CatalogSource> {
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

  /**
   * Uninstall from a view (IPC): `request.sourceId` is the id the view
   * carried — the stored id, or the handle a credential-shaped one is shown
   * under (§18.8). It is resolved to the installed record's stored identity
   * here, once; the removal itself ({@link uninstallStoredNow}) only ever
   * sees that identity. Main-process callers that hold a stored identity
   * call {@link uninstallInstalled} instead.
   */
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

  /**
   * Uninstall by stored identity (§18.8): `key.sourceId` is the source id the
   * install record holds, as main-process state (the plugin registry, a
   * revocation feed) carries it — never a view's handle. Not an IPC entry.
   */
  async uninstallInstalled(
    key: StoredInstallKey,
    options?: { retain?: { reason: PluginConfigRetention["reason"] }; lease?: PackageLease },
  ): Promise<UninstallResultView> {
    // `lease`: the package lock of a caller that already holds it (§18.6), which this uninstall then runs under.
    const retain = options?.retain ? { retain: options.retain } : undefined;
    return this.operation(() => this.withPackage(key.kind, key.name, () => this.uninstallStoredNow(key, false, retain), options?.lease ? { lease: options.lease } : {}));
  }

  /** The removal both entries share; `key` is a stored identity, checked against the install record. */
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
    const last = record.name.slice(record.name.lastIndexOf("/") + 1);
    // The name is how the installed server is named back (§18.8); `idFrom` refuses that shape too.
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

  // ─── boot and periodic work (§7.3, §10.2) ─────────────────────────────────

  /** Installed packages whose bound source offers a newer version, or a folder's changed tree (§18.7.6), hidden sources included (§7.3). */
  async updates(signal?: AbortSignal): Promise<PackageUpdateOffer[]> {
    return this.operation(async () => (await this.offersNow()).map((item) => item.offer), signal);
  }

  /**
   * Every update an installed package's bound source offers (§7.3), with the
   * row and version it comes from. A folder package whose tree digest differs
   * from the installed one at the same version is a refresh, and at a lower
   * version a downgrade offered by hand only (§18.7.6).
   */
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

  /** What an installed package was accepted with (§18.7.3); null when it is not installed. */
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

  /**
   * The descriptor fields an install from before slice F did not store: the
   * index row of the installed version in the retained snapshot of the
   * commit it was installed from (§18.7.3). Null when that snapshot is not
   * kept, which makes the fields unknown.
   */
  private async installedDescriptor(kind: PackageKind, name: string, origin: { sourceId: string | null; commit: string | null; packagePath: string; version: string }): Promise<{ minAppVersion: string | null; hostProtocol: string | null } | null> {
    if (origin.sourceId === null || origin.commit === null) return null;
    const snapshot = await this.options.syncer.readRetainedSnapshot(origin.sourceId, origin.commit);
    const listed = snapshot?.packages.find((item) => item.kind === kind && item.name === name && item.path === origin.packagePath);
    const version = listed?.versions.find((item) => item.version === origin.version);
    return version ? { minAppVersion: version.minAppVersion, hostProtocol: version.hostProtocol ?? null } : null;
  }

  /** The bundled MCP servers and hooks of an installed package's running generation, with their approvals (§18.7.2). */
  private async componentApprovals(kind: PackageKind, name: string): Promise<ComponentApprovalState[]> {
    if (kind === "plugin") return this.options.installers.plugin.componentApprovals(name);
    if (kind === "agent-plugin") return this.options.installers.content.componentApprovals(name);
    return [];
  }

  /**
   * Every update the apply check classifies (§18.7.2), from the sources in
   * `reached`: the offers, each marked required when a `requiredInstalls`
   * entry names it from its source, and a required package installed from
   * another source as a switch to the policy's source. A required package
   * that is not installed is the boot pass's first install (§10.2).
   */
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
      // Not installed: a first install, on the boot path. Installed from the policy's source: an offer above, if any.
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
          // Approved, but with no approval digest to carry (§18.7.3, version-2 migration).
          unconfirmedApprovals: approvals.filter((component) => component.approved && component.recordDigest === null).map((component) => component.field),
        },
      });
    }
    return candidates;
  }

  /** The installed packages whose installed version their own source revokes (§10.4), by kind and name; read only. */
  private async revokedInstalls(installed: readonly InstalledRecord[]): Promise<Set<string>> {
    const feed = await revocationFeed(boundOf(installed), (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    return new Set(revokedAmong(installed, feed.rules).map(({ record }) => keyOf(record.kind, record.name)));
  }

  /** Whether the managed policy refuses installs from this source now: a direct source under `allowDirectInstall: false`, a folder it blocks (§18.6). */
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

  /**
   * Apply one update of the queue (§18.7.4) under the operation and the
   * package lock, so no user install, uninstall or other marketplace
   * operation of it runs beside it, and with the policy the operation's
   * refresh left in force. Nothing the update was queued with authorizes
   * it: its facts are gathered again here, and `decide` judges them with the
   * policy in force and the switches as they are now. An update whose
   * package, offer, required status or eligibility changed since it was
   * queued is `superseded` and nothing is done. An automatic update runs
   * checkpoint two against the installed baseline and keeps the previous
   * receipt's reviewed app version; one a `requiredInstalls` entry names now
   * is reviewed by the policy (this app version) and does not check consent.
   * What the install throws is classified (§18.7.4's table).
   */
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
    // The update as the policy and the source make it now: still offered at this version, the same kind of change, still automatic.
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
      // A later discovery offers another version: the next apply check classifies it.
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
    // A component that is unapproved now and was not unapproved with these bytes before: the update left it waiting (§18.7.2).
    const after = await this.componentApprovals(key.kind, key.name);
    const waiting = after.filter((component) => !component.approved
      && !before.some((prior) => prior.field === component.field && !prior.approved && prior.approvalDigest === component.approvalDigest));
    if (waiting.length > 0) return { state: "approval-pending" };
    if (key.kind === "plugin" && !this.options.installers.plugin.running(key.name)) return { state: "applied-not-running" };
    return { state: "applied" };
  }

  /**
   * An applied update read again (§18.7.5): null when the package is no
   * longer installed at `to` from its source; `approval-pending` while a
   * component of the installed generation is unapproved (with the agent
   * plugin's review payload); `applied-not-running` while an extension's
   * generation does not run; otherwise `applied`.
   */
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

  /** An agent plugin's `pendingApproval` (§18.9): its install id, and its unapproved components as the review shows them. */
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

  /** Whether a call of the agent plugin's running generation is in flight: the queue waits (§18.7.4). */
  async callsInFlight(name: string): Promise<boolean> {
    return this.options.installers.content.callsInFlight(name);
  }

  /**
   * What the automatic-update switches resolve with (§18.7.2): the
   * organization's `autoUpdate`, and each source with its label, origin,
   * whether it is read over http, and whether it holds
   * `unencrypted-updates`.
   */
  async autoUpdateContext(signal?: AbortSignal): Promise<AutoUpdateContext> {
    return this.operation(async () => {
      const sources: AutoUpdateContext["sources"] = [];
      const quarantined = new Set<string>();
      for (const source of this.registry.list()) {
        // A quarantined source (§18.8) is served to no one, its packages and its id included.
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

  /**
   * How each source a `requiredInstalls` entry names stands now
   * ({@link RequirementSourceState}): what its registry entry and its files
   * say, whatever a view shows. The boot pass and the Updates card judge
   * every requirement by this, so hiding a source never hides that a
   * requirement on it is not met.
   */
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

  /**
   * Each `requiredInstalls` entry not met now (§10.2): not installed from the
   * source it names, and that source cannot provide it. The judgement is the
   * boot pass's, over the same inputs: {@link requirementGap} with
   * {@link requiredSourceStates} and the rows of the sources the user sees.
   * One the source can provide is not listed: the boot pass installs it, or
   * the apply queue switches a same-named install to it.
   *
   * A same-named package installed from another source may stand in the
   * way, so it is named as its receipt binds it, whatever became of that
   * source: removed (its id), quarantined (the handle its Sources row
   * carries, §18.8), or still there. Its package sheet can open only while
   * that source's catalog lists it; otherwise the row uninstalls it directly.
   */
  private async unmetRequiredNow(installed: readonly InstalledRecord[]): Promise<UnmetRequirementView[]> {
    if (this.policy.requiredInstalls.length === 0) return [];
    const states = await this.requiredSourceStates();
    const { rows } = await this.rows();
    const others = installed.filter((item): item is InstalledRecord & { sourceId: string } => item.sourceId !== null
      && this.policy.requiredInstalls.some((key) => key.kind === item.kind && key.name === item.name && key.source !== item.sourceId));
    // The other sources' rows as a package sheet reads them: an installed package's hidden source included.
    const listed = await this.rows(new Set(others.map((item) => item.sourceId)));
    // A source's name as Sources shows it, whether it is shown or hidden; a removed one has only its id.
    // A source's name as Sources shows it, shown or hidden; a removed or quarantined one goes by the id its view carries.
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

  /** A same-named install from another source, as {@link UnmetRequirementInstall} describes it. */
  private async installedFromView(sourceId: string, key: PackageKey, rows: readonly CatalogRow[], label: (sourceId: string) => Promise<string>): Promise<UnmetRequirementInstall> {
    // `rows` hold no quarantined source's (§18.8), so a sheet opens only for a served source that lists the package.
    const sheet = rows.some((row) => row.sourceId === sourceId && row.kind === key.kind && row.name === key.name);
    // The id the receipt's stored id is viewed as, derived from that id alone: uninstall takes it back whether
    // the source is still there, quarantined or removed (§18.8).
    return { sourceId: this.viewSourceId(sourceId), label: await label(sourceId), removal: sheet ? "sheet" : "confirm" };
  }

  /**
   * Approve components of an `approval-pending` agent plugin (§18.7.5),
   * bound to the reviewed install: the store re-validates `installId` and
   * every approval digest under its install serialization, and fails
   * `PLAN_EXPIRED` reason `package-changed` on any mismatch.
   */
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

  /**
   * Default and required installs (§10.2), each through the normal plan: the
   * ladder, verification and receipt. Returns the report and the notice the
   * boot publishes (null when nothing changed).
   */
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
    // `signal` is the update scheduler's shutdown: each stage below starts only while it is not aborted.
    signal?.throwIfAborted();
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

  /**
   * Enforce the revocations the local snapshots carry (§10.4): feed the
   * gates, remove what a gate cannot hold, and queue what that did for the
   * next notice ({@link takeRevocationNotice}). Each outcome is queued once a
   * session. Runs on every sync and before the boot pass syncs, so a
   * revocation already on disk never waits for the network. With `signal`
   * (the update scheduler's shutdown), an aborted signal starts nothing, also
   * when it aborts while this enforcement waits behind another; an
   * enforcement already started finishes.
   */
  async enforceRevocations(signal?: AbortSignal): Promise<void> {
    return this.operation(() => this.enforceRevocationsNow(signal), signal);
  }

  private async enforceRevocationsNow(signal?: AbortSignal): Promise<void> {
    // Checked when its turn comes: an enforcement queued behind another is cancelled if the signal aborts while it waits.
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

  /** What enforcement did since the last notice, as a notice of its own; null when nothing. */
  takeRevocationNotice(): BootInstallNoticeView | null {
    const revoked = this.revokedUnreported.splice(0);
    return revoked.length === 0 ? null : { forYou: [], required: [], unmanaged: [], lostGrants: [], revoked, autoUpdated: [] };
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

  /**
   * Feed the gates, then remove what a gate cannot hold — every `uninstall`
   * revocation, and a `disable` one for a kind outside {@link GATED_KINDS}.
   * A package a `requiredInstalls` entry locks ({@link lockedByPolicy}) stays
   * (gated where its kind has a gate) and is reported.
   *
   * The feed judged each install before its package lock: under the lock
   * (§18.6) the decision holds only for the install it was made for
   * ({@link InstallIdentity}). One installed otherwise meanwhile (an update,
   * a reinstall) is judged again, by its own source's revocations as they
   * are now, and is removed only if they revoke it too; otherwise it stays
   * and the log says why.
   */
  private async applyRevocations(): Promise<RevokedPackageView[]> {
    const report: RevokedPackageView[] = [];
    for (const decided of await this.feedRevocations()) {
      const { kind, name } = decided.record;
      await this.withPackage(kind, name, async () => {
        const now = await this.installed(kind, name);
        const current = isDeepStrictEqual(installIdentity(now), installIdentity(decided.record)) ? decided : await this.revocationNow(now);
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

  /**
   * The revocation an install's own source carries for its version now
   * (§10.4), or why there is none to enforce: the reason a revocation
   * decided for an earlier install is skipped.
   */
  private async revocationNow(record: InstalledRecord | null): Promise<RevokedInstall | string> {
    if (!record) return "it was removed before its turn";
    const feed = await revocationFeed(boundOf([record]), (sourceId) => this.options.syncer.readRevocations(sourceId, this.options.versionContext().appVersion));
    const [revoked] = revokedAmong([record], feed.rules);
    return revoked ?? `it was replaced by ${record.version} ${record.sourceId === null ? "without a source" : `from ${this.viewSourceId(record.sourceId)}`}, which its own source's revocations do not cover`;
  }

  /** Enforce one revocation under its package's lock; null when a gate holds it (nothing to report). */
  private async enforceRevocation({ record, revocation }: RevokedInstall): Promise<RevokedPackageView | null> {
    if (revocation.action === "disable" && GATED_KINDS.has(record.kind)) return null;
    // The report is a view (the boot notice, its Uninstall button): it carries the view id (§18.8).
    const item = { key: { sourceId: this.viewSourceId(record.sourceId), kind: record.kind, name: record.name }, version: record.version!, reason: revocation.reason };
    try {
      const retaining = record.kind === "plugin" && revocation.action === "uninstall" && revocation.successors !== undefined;
      if (retaining) {
        await this.options.installers.plugin.retire(record.name, {
          reason: "revoked", sourceId: record.sourceId, successors: revocation.successors!,
        });
      }
      if (lockedByPolicy(this.policy, record.kind, record.name, record.sourceId)) return { ...item, outcome: "required" };
      // Stored identity: the record's source id as stored, never resolved as a view id (§18.8).
      await this.uninstallStoredNow({ sourceId: record.sourceId, kind: record.kind, name: record.name }, false,
        retaining ? { retain: { reason: "revoked" } } : undefined);
      return { ...item, outcome: "uninstalled" };
    } catch (error) {
      return { ...item, outcome: "failed", message: errorMessage(error) };
    }
  }

  /** Drop every preview clone and plan (shutdown). */
  close(): void {
    this.previews.clear();
    this.plans.clear();
  }
}
