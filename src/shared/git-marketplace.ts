/** Renderer-safe marketplace wire contracts share kind and error vocabularies with main. */
import { PACKAGE_KINDS, type AgentPluginComponents, type PackageKind } from "../marketplace/catalog/types.js";
import type { ComponentDelta } from "../marketplace/app/component-delta.js";
import { MARKETPLACE_ERROR_CODES, parseMarketplaceErrorDetail, type EnteredTargetWarningView, type MarketplaceErrorCode, type MarketplaceErrorDetail } from "../marketplace/errors.js";
import type { DirectDetectedFile } from "../marketplace/sources/direct-package.js";
import type { SourceWarning, SourceWarningView } from "../marketplace/sources/warnings.js";
import { isRecord } from "./is-record.js";

export type { EnteredTargetWarningView, MarketplaceErrorDetail, PackageKind, SourceWarning, SourceWarningView };
export { parseMarketplaceErrorDetail };

/** Show confirmed transport and address-class warnings as text plus tooltips, never color alone. */
export type SourceBadge =
  | "unencrypted"
  | "internal-network"
  | "this-computer"
  | "internal-downloads"
  | "local-folder"
  | "network-folder"
  | "network-folder-unconfirmed"
  | "folder-unclassified";

export type SourceOriginKind = "official" | "managed" | "custom" | "direct";

const SOURCE_ORIGIN_KINDS: readonly SourceOriginKind[] = ["official", "managed", "custom", "direct"];

export interface PackageKeyView {
  sourceId: string;
  kind: PackageKind;
  name: string;
}

/** Null source means an installed package is bound to none. */
export interface InstalledKeyView {
  sourceId: string | null;
  kind: PackageKind;
  name: string;
}

export type SourceStatusView =
  | { state: "up-to-date" }
  | { state: "syncing" }
  | { state: "never-synced" }
  /** Cached means the pinned snapshot is still served after sync failure. */
  | { state: "unreachable"; code: MarketplaceErrorCode; detail?: MarketplaceErrorDetail; cached: boolean }
  | { state: "auth-required"; detail?: MarketplaceErrorDetail<"SOURCE_AUTH_REQUIRED">; cached: boolean }
  /** Custom and direct sources require review; official and managed sources retain the pin. */
  | { state: "history-rewritten"; candidate: string; reviewable: boolean }
  /** Unusable downloaded copies offer repair; scrubbed English diagnostics are copy-only. */
  | { state: "broken"; message: string; detail?: MarketplaceErrorDetail<"SOURCE_LOCAL_DATA_DAMAGED"> }
  /** Credential-shaped ids are quarantined behind host-issued handles; removal is the only action. */
  | { state: "id-holds-credential" };

export type SourceView = SourceViewFields & (
  | { transport: "git"; url: string; path: null }
  | { transport: "folder"; url: null; path: string }
);

interface SourceViewFields {
  id: string;
  origin: SourceOriginKind;
  /** Label precedence is user label, marketplace name, then id. */
  label: string;
  ref: string | null;
  subdir: string | null;
  mirrors: number;
  auth: "none" | "token" | "ssh";
  /** Token storage is keyed by host. */
  tokenHost: string | null;
  tokenStored: boolean;
  pinnedCommit: string | null;
  lastSyncAt: string | null;
  marketplace: { name: string; displayName: string; description: string | null; owner: string | null } | null;
  packageCount: number;
  status: SourceStatusView;
  enabled: boolean;
  canDisable: boolean;
  canRemove: boolean;
  diagnostics: string[];
  acknowledged: SourceWarning[];
  badges: SourceBadge[];
}

export interface SourcePreviewRequest {
  /** Folder addresses accept no branch, package subdirectory, token, or sign-in. */
  input: string;
  ref?: string;
  subdir?: string;
  auth: "none" | "token" | "ssh";
  /** Preview tokens persist by host only when adding the source. */
  token?: string;
  /** Require missing address confirmations before any network or git traffic; store exactly what was confirmed. */
  acknowledge?: SourceWarning[];
}

/** Picker handles identify host-held selections; scrubbed display paths are text, never request addresses. */
export interface FolderPickView {
  pick: string;
  display: string;
}

/** Main resolves picker handles; folder previews take no branch, package folder, or sign-in. */
export type SourcePreviewAsk = SourcePreviewRequest | { pick: string; auth: "none"; acknowledge?: SourceWarning[] };

/** Return confirmation requirements before contacting the address. */
interface SourceConfirmView {
  type: "confirm";
  warnings: EnteredTargetWarningView[];
}

export interface MarketplacePreviewView {
  type: "marketplace";
  previewId: string;
  expiresAt: string;
  transport: "git" | "folder";
  url: string | null;
  path: string | null;
  /** Show the typed path when canonicalization changes it. */
  resolvedFrom: string | null;
  badges: SourceBadge[];
  ref: string | null;
  /** Git uses commits; folders use local-sha256 revisions. */
  commit: string;
  marketplace: { name: string; displayName: string; description: string | null; owner: string | null };
  counts: Partial<Record<PackageKind, number>>;
  /** Plugins and MCP servers can execute local code. */
  codeRunning: number;
  diagnostics: string[];
  credentialHelper: boolean;
  suggestedId: string;
}

interface DirectPackagePreviewView {
  type: "package";
  previewId: string;
  expiresAt: string;
  transport: "git" | "folder";
  url: string | null;
  path: string | null;
  resolvedFrom: string | null;
  badges: SourceBadge[];
  ref: string | null;
  subdir: string | null;
  commit: string;
  detectedFrom: DirectDetectedFile;
  kind: PackageKind;
  name: string;
  displayName: string | null;
  description: string | null;
  version: string;
  /** Synthesize versions from commit or tree digest only when the package declares none. */
  versionSynthesized: boolean;
  runsCode: boolean;
  credentialHelper: boolean;
  suggestedId: string;
}

export type SourcePreviewView = MarketplacePreviewView | DirectPackagePreviewView;

export type SourcePreviewResultView = SourcePreviewView | SourceConfirmView;

export interface SourceAddRequest {
  previewId: string;
  id?: string;
  label?: string;
}

export type PackageStateView =
  | { state: "install"; version: string }
  | { state: "installed"; version: string | null }
  | { state: "update"; from: string; to: string }
  | { state: "requires-app"; minAppVersion: string }
  | { state: "yanked" }
  | { state: "revoked" }
  | { state: "unavailable" }
  /** Same-name installs from another or no source require switching. */
  | { state: "installed-elsewhere"; sourceId: string | null; version: string | null }
  /** Removed-source installs receive no updates. */
  | { state: "source-removed"; version: string | null }
  /** Unbound installs have no automatic update source. */
  | { state: "unbound"; version: string | null };

export interface CatalogEntryView {
  /** Null source is valid only for installed-only packages bound to none. */
  key: InstalledKeyView;
  sourceOrigin: SourceOriginKind | null;
  sourceLabel: string | null;
  displayName: string;
  description: string;
  keywords: string[];
  state: PackageStateView;
  /** Required installs cannot be uninstalled or disabled. */
  required: boolean;
  runsCode: boolean;
  /** Unbound packages carry no source badges. */
  sourceBadges: SourceBadge[];
}

export interface CatalogQuery {
  kind?: PackageKind;
  sourceId?: string;
  query?: string;
  installedOnly?: boolean;
}

export interface CatalogView {
  entries: CatalogEntryView[];
  /** Count entries before applying the kind filter. */
  counts: Record<PackageKind, number>;
  sourceCount: number;
  syncedAt: string | null;
}

export type VersionExclusionView = "min_app_version" | "host_protocol" | "yanked" | "platform" | "prerelease" | "rollout" | "revoked";

export interface VersionView {
  version: string;
  /** Legacy grant pins carry no commit. */
  commit: string | null;
  /** Digest evidence that keeps an existing install's grant; never installable. */
  legacyPin: boolean;
  publishedAt: string;
  minAppVersion: string;
  excluded: VersionExclusionView[];
  yankedReason: string | null;
  rolloutPercent: number | null;
  installed: boolean;
  candidate: boolean;
}

export interface AuthorityView {
  capabilities: string[];
  networkHosts: string[];
  secrets: string[];
  pluginAccess: string[];
  dependencies: string[];
  filesystem: Array<{ access: "read" | "write"; target: string; why: string }>;
}

/** Folder installs have one rung: their built tree read in place. */
type RungKindView = "release" | "archive" | "tree" | "folder";

export interface RungView {
  rung: RungKindView;
  declared: boolean;
  /** Release and archive rungs need a pinned digest; tree rungs do not. */
  pinned: boolean;
  detail: string | null;
  /** Plain HTTP downloads rely only on pinned digest verification. */
  unencrypted: boolean;
}

export type RungOutcomeView =
  /** Unencrypted includes any plain-HTTP redirect hop. */
  | { rung: RungKindView; outcome: "used"; unencrypted: boolean }
  | { rung: RungKindView; outcome: "skipped"; reason: string }
  | { rung: RungKindView; outcome: "failed"; code: string; message: string };

export interface McpRuntimeView {
  transport: "stdio" | "http";
  /** Keep variable names unsubstituted in the command preview. */
  command: string | null;
  args: string[];
  url: string | null;
  env: Array<{ name: string; secret: boolean; required: boolean }>;
  usesDataDir: boolean;
}

export interface PackageDetailView {
  entry: CatalogEntryView;
  provenance: {
    sourceLabel: string;
    /** Null for folder sources. */
    repository: string | null;
    /** Folder details include path, last read time, and installed tree digest; git has none. */
    folder: { path: string; readAt: string; contents: string | null } | null;
    path: string;
    snapshotCommit: string;
    versionCommit: string | null;
    publishedAt: string | null;
  };
  compatibility: { minAppVersion: string | null; appVersion: string; compatible: boolean };
  authority: AuthorityView | null;
  components: AgentPluginComponents | null;
  rungs: RungView[];
  versions: VersionView[];
}

export interface InstallPlanRequest extends PackageKeyView {
  version?: string;
  /** Source switches preserve plugin data. */
  switchSource?: boolean;
}

export type InstallActionView =
  | { action: "install" }
  | { action: "replace"; direction: "upgrade" | "reinstall" | "downgrade" | "repair"; from: string | null }
  | { action: "switch"; fromSource: string | null; from: string | null };

export interface InstallPlanView {
  planId: string;
  expiresAt: string;
  key: PackageKeyView;
  displayName: string;
  version: string;
  snapshotCommit: string;
  versionCommit: string;
  action: InstallActionView;
  runsCode: boolean;
  authority: AuthorityView | null;
  components: AgentPluginComponents | null;
  /** Confinement observed by the host when this review plan was issued. */
  hookConfinement: "sandboxed" | "user-permissions" | "unavailable";
  rungs: RungView[];
  mcp: McpRuntimeView | null;
  /** Show excluded top-level folder entries; git has no exclusions here. */
  notInstalled: string[];
}

export type ConsentJson = null | boolean | number | string | ConsentJson[] | { [key: string]: ConsentJson };

/** Checkpoint distinguishes catalog and staged-byte evidence; null after means removal, added means a new component. Changed paths are display-only. */
export interface ConsentDeltaEntry {
  field: string;
  checkpoint: "catalog" | "staged";
  before: ConsentJson | "unknown";
  after: ConsentJson;
  changedFiles?: { code: string[]; nonCode: string[] };
}

export type ConsentDelta = ConsentDeltaEntry[];

export interface UpdatePlanView extends InstallPlanView {
  from: string | null;
  commitRange: { from: string | null; to: string };
  authorityDelta: { added: AuthorityView; removed: AuthorityView } | null;
  componentsDelta: ComponentDelta | null;
  /** Custom and direct history rewrites wait for explicit review. */
  historyRewritten: { pinned: string | null; candidate: string } | null;
  /** New authority or rewritten history requires an explicit decision. */
  needsConfirmation: boolean;
  /** Resolved review deltas come from staged bytes where available and contain no pending fields. */
  consentDelta: ConsentDelta;
  /** Digest-only changes with no code files permit the single-row update review. */
  codeFreeChange: boolean;
  /** Return only reviewed bundled component identities and their displayed approval digests. */
  reviewComponents: ReviewComponentView[];
}

export type ReviewComponentView =
  | { kind: "mcpServer"; consent: McpComponentConsent; field: string }
  | { kind: "hook"; consent: HookComponentConsent; field: string }
  | { kind: "extension"; consent: ExtensionComponentConsent; field: string };

type InstallPhaseView = "resolving" | "downloading" | "verifying" | "installing" | "activating";

export interface InstallProgressView {
  planId: string;
  phase: InstallPhaseView;
  rung: RungKindView | null;
  bytes: number | null;
  total: number | null;
}

export interface InstallResultView {
  /** Null source means a pasted server configuration is unbound. */
  key: { sourceId: string | null; kind: PackageKind; name: string };
  /** Pasted server configurations have no recorded version. */
  version: string | null;
  action: InstallActionView;
  rungs: RungOutcomeView[];
  /** Connection failure does not undo an installed server configuration. */
  connectionWarning: string | null;
}

export interface UninstallRequest extends InstalledKeyView {
  /** Server removal may also delete its data directory. */
  removeData?: boolean;
}

export interface UninstallResultView {
  key: InstalledKeyView;
  keptDataDir: string | null;
}

export type DirectMcpPreviewRequest = { serverJson: string; select?: { package?: number; remote?: number } };

export interface DirectMcpPreviewView {
  planId: string;
  expiresAt: string;
  name: string;
  version: string;
  runtime: McpRuntimeView;
  options: { packages: number; remotes: number };
}

/** Deep links open confirmation UI only; they cannot install, remove, or add sources themselves. */
export type GitMarketplaceDeepLink =
  | { action: "install" | "uninstall"; key: PackageKeyView }
  | { action: "add"; url: string }
  /** Links cannot select folders; open an empty dialog with the refusal reason. */
  | { action: "add-refused"; reason: "deep-link-path" };

/** Skipped versions are omitted rather than represented as update states. */
export const UPDATE_PACKAGE_STATES = [
  "automatic",
  "waiting",
  "needs-review",
  "manual",
  "failed",
  "applied",
  "applied-not-running",
  "approval-pending",
] as const;
export type UpdatePackageState = (typeof UPDATE_PACKAGE_STATES)[number];

/** Manual updates count only when notices are enabled; main filters them otherwise. */
export function updateNeedsUser(state: UpdatePackageState): boolean {
  switch (state) {
    case "needs-review":
    case "manual":
    case "failed":
    case "applied-not-running":
    case "approval-pending":
      return true;
    case "automatic":
    case "waiting":
    case "applied":
      return false;
  }
  const unhandled: never = state;
  throw new Error(`unknown update state ${String(unhandled)}`);
}

export interface PackageUpdateView {
  key: PackageKeyView;
  displayName: string;
  from: string;
  to: string;
  state: UpdatePackageState;
  /** Stale means the last discovery missed this source; preserve its earlier classification. */
  stale?: true;
  reasons?: UpdateReason[];
  /** Pre-commit failure records code, diagnostic, and attempts at this version. */
  failure?: { code: GitMarketplaceErrorCode; detail?: MarketplaceErrorDetail; message?: string; attempts: number };
  appliedAt?: string;
  commitRange?: { from: string | null; to: string };
  /** Agent component approvals bind to the installed generation; extension reviews use plugin trust rows. */
  pendingApproval?: { installId: string; consentDelta: ConsentDelta; components: ReviewedComponentConsent[] };
  autoUpdate?: AutoUpdateSwitchView;
  /** After 30 busy minutes, waiting updates count in the toolbar and offer apply now. */
  escalated?: true;
  /** Required updates ignore switches and skipped versions and must remain visible. */
  required?: true;
}

/** Count states needing user input and escalated waiting updates. */
export function updateViewNeedsUser(update: Pick<PackageUpdateView, "state" | "escalated">): boolean {
  return updateNeedsUser(update.state) || (update.state === "waiting" && update.escalated === true);
}

/** Automatic updates require enabled policy, trusted history and consent, a known baseline, and no active calls; repeated failure needs user action. */
export type UpdateReason =
  | "disabled"
  | "source-hidden"
  | "history-rewritten"
  | "not-an-upgrade"
  | "unencrypted-updates"
  | "switched-off"
  | "consent-changed"
  | "baseline-unknown"
  | "approval-unconfirmed"
  | "failed-three-times"
  | "calls-in-flight"
  | "policy-blocked";

/** Expose the explicit override, resolved value, and managed-policy lock. */
export interface AutoUpdateSwitchView {
  effective: boolean;
  override: "on" | "off" | null;
  lockedByPolicy: boolean;
  /** Required package updates are on and locked; source switches are never required. */
  required: boolean;
}

export type PackageUpdateOffer = Omit<PackageUpdateView, "state" | "stale" | "reasons" | "failure" | "appliedAt" | "commitRange" | "pendingApproval" | "autoUpdate" | "escalated" | "required">;

export type UpdateDiscoveryResult = "ok" | "partial" | "offline" | "error";

/** Discovery refreshes reached sources, retains missed sources as stale, and omits skipped versions. Reset history changes only check times. */
export interface UpdateStatusView {
  discovery: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    result: UpdateDiscoveryResult | null;
    nextAt: string;
  };
  applyCheckAt: string | null;
  running: boolean;
  historyReset: boolean;
  /** Null when the apply queue is not waiting for an idle conversation. */
  waitingSince: string | null;
  escalated: boolean;
  /** Report effective global, source, and installed-package switches, including managed locks. */
  autoUpdate: {
    enabled: boolean;
    lockedByPolicy: "on" | "off" | null;
    sources: Array<{ id: string; label: string; origin: SourceOriginKind; switch: AutoUpdateSwitchView; needsUnencryptedUpdates: boolean }>;
    packages: Array<{ key: PackageKeyView; switch: AutoUpdateSwitchView }>;
  };
  packages: PackageUpdateView[];
  unmetRequired: UnmetRequirementView[];
}

/** Required-install reasons distinguish missing, hidden, unreachable, absent, incompatible, rollout-held, and otherwise unavailable packages. */
const UNMET_REQUIREMENT_REASONS = [
  "source-missing",
  "source-hidden",
  "source-unreachable",
  "not-in-catalog",
  "incompatible",
  "rollout-held",
  "not-offered",
] as const;
export type UnmetRequirementReason = (typeof UNMET_REQUIREMENT_REASONS)[number];

/** Set required app version only for incompatibility; same-name installs from another source do not satisfy policy. */
export interface UnmetRequirementView {
  key: PackageKeyView;
  sourceLabel: string;
  reason: UnmetRequirementReason;
  minAppVersion: string | null;
  installedFrom: UnmetRequirementInstall | null;
}

/** Derive removal handles from receipt source ids so they survive source deletion; use direct uninstall when no package sheet can load. */
export interface UnmetRequirementInstall {
  sourceId: string;
  label: string;
  removal: "sheet" | "confirm";
}

/** Accumulate boot installs, switches, and migrations until dismissal. */
/** Remove revoked packages when requested or when their kind lacks a disable-time load gate. */
export interface RevokedPackageView {
  key: PackageKeyView;
  version: string;
  reason: string;
  /** Required packages stay; failed removals retain the uninstall diagnostic. */
  outcome: "uninstalled" | "required" | "failed";
  message?: string;
}

export interface BootInstallNoticeView {
  /** Default installs belong to the user and remain uninstallable. */
  forYou: PackageKeyView[];
  required: PackageKeyView[];
  /** Unlisted administrator installs lose locks and have no updates. */
  unmanaged: string[];
  /** Host-secret access stays disabled until these plugins update. */
  lostGrants: Array<{ plugin: string; keys: string[] }>;
  revoked: RevokedPackageView[];
  /** Include automatic and policy-applied updates since the last dismissal. */
  autoUpdated: AutoUpdatedView[];
}

export interface AutoUpdatedView {
  key: PackageKeyView;
  displayName: string;
  from: string;
  to: string;
  /** Record before and after commits for change inspection. */
  commitRange: { from: string | null; to: string | null };
  /** Required means managed policy applied the update. */
  required: boolean;
  state: "applied" | "applied-not-running" | "approval-pending";
}

/** Append undismissed notice lists; repeated updates replace the earlier entry for that package. */
export function mergeBootInstallNotices(held: BootInstallNoticeView | null, next: BootInstallNoticeView): BootInstallNoticeView {
  if (!held) return next;
  const sameKey = (left: PackageKeyView, right: PackageKeyView) => left.sourceId === right.sourceId && left.kind === right.kind && left.name === right.name;
  return {
    forYou: [...held.forYou, ...next.forYou],
    required: [...held.required, ...next.required],
    unmanaged: [...held.unmanaged, ...next.unmanaged],
    lostGrants: [...held.lostGrants, ...next.lostGrants],
    revoked: [...held.revoked, ...next.revoked],
    autoUpdated: [...held.autoUpdated.filter((item) => !next.autoUpdated.some((entry) => sameKey(entry.key, item.key))), ...next.autoUpdated],
  };
}

export function bootInstallNoticeIsEmpty(notice: BootInstallNoticeView): boolean {
  return notice.forYou.length + notice.required.length + notice.unmanaged.length + notice.lostGrants.length + notice.revoked.length + notice.autoUpdated.length === 0;
}

export type GitMarketplaceErrorCode = MarketplaceErrorCode | "invalid-request" | "unauthorized-frame" | "unavailable";

/** Render localized text from code and matching detail; scrubbed English messages are copy-only. */
export interface GitMarketplaceFailure {
  code: GitMarketplaceErrorCode;
  message: string;
  detail?: MarketplaceErrorDetail;
}

export type GitMarketplaceResult<T> = { ok: true; value: T } | ({ ok: false } & GitMarketplaceFailure);

export interface SyncProgressView {
  sourceId: string;
  state: "syncing" | "done" | "failed";
}

/** Consent for one exact reviewed server component; the installed tree must match its digest. */
export interface McpComponentConsent {
  name: string;
  digest: string;
}

export interface HookComponentConsent {
  kind: "hook";
  index: number;
  digest: string;
}

/** Approve extension components only by local id and the exact reviewed digest. */
export interface ExtensionComponentConsent {
  kind: "extension";
  component: "hook" | "mcpServer";
  localId: string;
  approvalDigest: string | null;
}

export type ComponentConsent = McpComponentConsent | HookComponentConsent | ExtensionComponentConsent;

/** Bind agent component approval to the installed generation and displayed digest. */
export type ReviewedComponentConsent = (McpComponentConsent | HookComponentConsent) & { approvalDigest: string | null };

export interface GitMarketplaceApi {
  listSources(): Promise<GitMarketplaceResult<SourceView[]>>;
  previewSource(request: SourcePreviewAsk): Promise<GitMarketplaceResult<SourcePreviewResultView>>;
  addSource(request: SourceAddRequest): Promise<GitMarketplaceResult<SourceView>>;
  acknowledgeSource(id: string, warnings: readonly SourceWarning[]): Promise<GitMarketplaceResult<SourceView>>;
  /** Return a host-held folder selection or null on cancellation. */
  pickFolder(): Promise<GitMarketplaceResult<FolderPickView | null>>;
  revealSource(id: string): Promise<GitMarketplaceResult<null>>;
  removeSource(id: string): Promise<GitMarketplaceResult<{ orphanedPackages: PackageKeyView[] }>>;
  setSourceEnabled(id: string, enabled: boolean): Promise<GitMarketplaceResult<SourceView>>;
  refreshSources(id?: string): Promise<GitMarketplaceResult<SourceView[]>>;
  /** Repair discards only damaged downloaded state, then resyncs. */
  repairSource(id: string): Promise<GitMarketplaceResult<SourceView[]>>;
  acceptRewrite(id: string, commit: string): Promise<GitMarketplaceResult<SourceView>>;
  setToken(host: string, token: string): Promise<GitMarketplaceResult<{ host: string }>>;
  deleteToken(host: string): Promise<GitMarketplaceResult<{ host: string }>>;
  listCatalog(query: CatalogQuery): Promise<GitMarketplaceResult<CatalogView>>;
  packageDetail(key: PackageKeyView): Promise<GitMarketplaceResult<PackageDetailView>>;
  planInstall(request: InstallPlanRequest): Promise<GitMarketplaceResult<InstallPlanView>>;
  planUpdate(key: PackageKeyView): Promise<GitMarketplaceResult<UpdatePlanView>>;
  executeInstall(planId: string, componentConsents?: readonly ComponentConsent[]): Promise<GitMarketplaceResult<InstallResultView>>;
  uninstall(request: UninstallRequest): Promise<GitMarketplaceResult<UninstallResultView>>;
  previewDirectMcp(request: DirectMcpPreviewRequest): Promise<GitMarketplaceResult<DirectMcpPreviewView>>;
  onSyncProgress(listener: (progress: SyncProgressView) => void): () => void;
  onCatalogChanged(listener: () => void): () => void;
  onInstallProgress(listener: (progress: InstallProgressView) => void): () => void;
  /** The deep link waiting to be opened, cleared by this read. */
  takeDeepLink(): Promise<GitMarketplaceResult<GitMarketplaceDeepLink | null>>;
  onDeepLink(listener: () => void): () => void;
  bootInstallNotice(): Promise<GitMarketplaceResult<BootInstallNoticeView | null>>;
  dismissBootInstallNotice(): Promise<GitMarketplaceResult<null>>;
  onBootInstallsApplied(listener: () => void): () => void;
  updateStatus(): Promise<GitMarketplaceResult<UpdateStatusView>>;
  /** Join in-flight discovery and resolve after its apply check ends. */
  checkUpdates(): Promise<GitMarketplaceResult<UpdateStatusView>>;
  /** Explicit apply skips waiting for the conversation to pause. */
  applyUpdatesNow(): Promise<GitMarketplaceResult<UpdateStatusView>>;
  /** Reject approvals when the installed generation changed since review. */
  approveComponents(key: PackageKeyView, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<GitMarketplaceResult<UpdateStatusView>>;
  onUpdateStatus(listener: (status: UpdateStatusView) => void): () => void;
}

const ENVELOPE_CODES = new Set<string>([...MARKETPLACE_ERROR_CODES, "invalid-request", "unauthorized-frame", "unavailable"]);

/** Check envelope shape and code/detail consistency; values are trusted main projections and malformed answers are unavailable. */
export function parseGitMarketplaceResult<T>(value: unknown): GitMarketplaceResult<T> {
  if (isRecord(value)) {
    if (value.ok === true && "value" in value) return { ok: true, value: value.value as T };
    if (value.ok === false && typeof value.code === "string" && ENVELOPE_CODES.has(value.code) && typeof value.message === "string") {
      const detail = value.detail === undefined ? undefined : parseMarketplaceErrorDetail(value.code, value.detail);
      return { ok: false, code: value.code as GitMarketplaceErrorCode, message: value.message, ...(detail ? { detail } : {}) };
    }
  }
  return { ok: false, code: "unavailable", message: "the marketplace did not answer" };
}

export function isPackageKind(value: unknown): value is PackageKind {
  return typeof value === "string" && (PACKAGE_KINDS as readonly string[]).includes(value);
}

export function parseSyncProgress(value: unknown): SyncProgressView | null {
  return isRecord(value) && typeof value.sourceId === "string" && (value.state === "syncing" || value.state === "done" || value.state === "failed")
    ? { sourceId: value.sourceId, state: value.state }
    : null;
}

const DISCOVERY_RESULTS = new Set<string>(["ok", "partial", "offline", "error"]);

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isUpdatePackage(value: unknown): value is PackageUpdateView {
  if (!isRecord(value) || !isRecord(value.key)) return false;
  const { key } = value;
  return typeof key.sourceId === "string" && isPackageKind(key.kind) && typeof key.name === "string"
    && typeof value.displayName === "string" && typeof value.from === "string" && typeof value.to === "string"
    && (UPDATE_PACKAGE_STATES as readonly unknown[]).includes(value.state)
    && (value.stale === undefined || value.stale === true)
    && (value.reasons === undefined || (Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === "string")))
    && (value.failure === undefined || (isRecord(value.failure) && typeof value.failure.code === "string" && ENVELOPE_CODES.has(value.failure.code)
      && typeof value.failure.attempts === "number"))
    && (value.appliedAt === undefined || isTime(value.appliedAt))
    && (value.commitRange === undefined || (isRecord(value.commitRange) && (value.commitRange.from === null || typeof value.commitRange.from === "string")
      && typeof value.commitRange.to === "string"))
    && (value.autoUpdate === undefined || isSwitchView(value.autoUpdate))
    && (value.escalated === undefined || value.escalated === true)
    && (value.required === undefined || value.required === true)
    && (value.pendingApproval === undefined || (isRecord(value.pendingApproval) && typeof value.pendingApproval.installId === "string"
      && Array.isArray(value.pendingApproval.consentDelta) && Array.isArray(value.pendingApproval.components)));
}

function isSwitchView(value: unknown): value is AutoUpdateSwitchView {
  return isRecord(value) && typeof value.effective === "boolean" && typeof value.lockedByPolicy === "boolean"
    && typeof value.required === "boolean" && (!value.required || (value.effective && value.lockedByPolicy))
    && (value.override === null || value.override === "on" || value.override === "off");
}

function isAutoUpdateStatus(value: unknown): boolean {
  return isRecord(value) && typeof value.enabled === "boolean"
    && (value.lockedByPolicy === null || value.lockedByPolicy === "on" || value.lockedByPolicy === "off")
    && Array.isArray(value.sources)
    && value.sources.every((source: unknown) => isRecord(source) && typeof source.id === "string" && typeof source.label === "string"
      && (SOURCE_ORIGIN_KINDS as readonly unknown[]).includes(source.origin)
      && isSwitchView(source.switch) && typeof source.needsUnencryptedUpdates === "boolean")
    && Array.isArray(value.packages)
    && value.packages.every((item: unknown) => isRecord(item) && isRecord(item.key) && typeof item.key.sourceId === "string"
      && isPackageKind(item.key.kind) && typeof item.key.name === "string" && isSwitchView(item.switch));
}

function isUnmetRequirement(value: unknown): boolean {
  return isRecord(value) && isRecord(value.key) && typeof value.key.sourceId === "string" && isPackageKind(value.key.kind)
    && typeof value.key.name === "string" && typeof value.sourceLabel === "string"
    && (UNMET_REQUIREMENT_REASONS as readonly unknown[]).includes(value.reason)
    && (value.reason === "incompatible" ? typeof value.minAppVersion === "string" : value.minAppVersion === null)
    && (value.installedFrom === null || (isRecord(value.installedFrom) && typeof value.installedFrom.sourceId === "string"
      && typeof value.installedFrom.label === "string" && (value.installedFrom.removal === "sheet" || value.installedFrom.removal === "confirm")));
}

/** Drop malformed update-status events. */
export function parseUpdateStatus(value: unknown): UpdateStatusView | null {
  if (!isRecord(value) || !isRecord(value.discovery) || !Array.isArray(value.packages)) return null;
  const { discovery } = value;
  const timeOrNull = (item: unknown) => item === null || isTime(item);
  if (!timeOrNull(discovery.lastAttemptAt) || !timeOrNull(discovery.lastSuccessAt) || !isTime(discovery.nextAt)) return null;
  if (discovery.result !== null && !DISCOVERY_RESULTS.has(discovery.result as string)) return null;
  if (!timeOrNull(value.applyCheckAt) || typeof value.running !== "boolean" || typeof value.historyReset !== "boolean") return null;
  if (!timeOrNull(value.waitingSince) || typeof value.escalated !== "boolean" || !isAutoUpdateStatus(value.autoUpdate)) return null;
  if (!value.packages.every(isUpdatePackage)) return null;
  if (!Array.isArray(value.unmetRequired) || !value.unmetRequired.every(isUnmetRequirement)) return null;
  return value as unknown as UpdateStatusView;
}

export function parseInstallProgress(value: unknown): InstallProgressView | null {
  if (!isRecord(value) || typeof value.planId !== "string" || typeof value.phase !== "string") return null;
  if (!["resolving", "downloading", "verifying", "installing", "activating"].includes(value.phase)) return null;
  return value as unknown as InstallProgressView;
}
