/**
 * The git marketplace as the renderer sees it (design §13, §15): the views
 * the `ave:marketplace:*` channels return, their requests, the events, and
 * the private `window.aveApi.gitMarketplace` namespace.
 *
 * The kind list and the error codes are the marketplace's own
 * (`catalog/types.ts`, `errors.ts`), both free of imports, so the renderer
 * reads the same constants main validates against.
 */
import { PACKAGE_KINDS, type PackageKind } from "../marketplace/catalog/types.js";
import { MARKETPLACE_ERROR_CODES, type MarketplaceErrorCode } from "../marketplace/errors.js";
import type { DirectDetectedFile } from "../marketplace/sources/direct-package.js";

export type { PackageKind };

export type SourceOriginKind = "official" | "managed" | "custom" | "direct";

/** A package in one source: the identity every channel takes (design §15.1). */
export interface PackageKeyView {
  sourceId: string;
  kind: PackageKind;
  name: string;
}

/** An installed package's key: the source is null when the install is bound to none. */
export interface InstalledKeyView {
  sourceId: string | null;
  kind: PackageKind;
  name: string;
}

// ─── Sources ────────────────────────────────────────────────────────────────

export type SourceStatusView =
  | { state: "up-to-date" }
  | { state: "syncing" }
  | { state: "never-synced" }
  /** The last sync failed with `code`; `cached` when the snapshot at the pin is still served. */
  | { state: "unreachable"; code: MarketplaceErrorCode; cached: boolean }
  | { state: "auth-required"; cached: boolean }
  /** Custom and direct sources show Review; official and managed keep the pin (design §7.3). */
  | { state: "history-rewritten"; candidate: string; reviewable: boolean }
  /** Its state or snapshot file cannot be read: repair or remove it. */
  | { state: "broken"; problem: string };

export interface SourceView {
  id: string;
  origin: SourceOriginKind;
  /** The user's label, else the marketplace's display name, else the id. */
  label: string;
  url: string;
  ref: string | null;
  /** Direct sources: the package path inside the repository. */
  subdir: string | null;
  mirrors: number;
  auth: "none" | "token" | "ssh";
  /** The host a token is stored under when `auth` is token. */
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
  /** Packages the snapshot dropped, as "path: problem". */
  diagnostics: string[];
}

export interface SourcePreviewRequest {
  /** `owner/repo`, an https or ssh URL, or `git@host:path`. */
  input: string;
  ref?: string;
  /** Direct install from a git folder (design §8.1). */
  subdir?: string;
  auth: "none" | "token" | "ssh";
  /** Used for this preview only; stored under the host when the source is added. */
  token?: string;
}

export interface MarketplacePreviewView {
  type: "marketplace";
  previewId: string;
  expiresAt: string;
  url: string;
  ref: string | null;
  commit: string;
  marketplace: { name: string; displayName: string; description: string | null; owner: string | null };
  counts: Partial<Record<PackageKind, number>>;
  /** Plugins and MCP servers: packages that can run code on this computer. */
  codeRunning: number;
  diagnostics: string[];
  /** An OS credential helper answers for this host (design §9.3). */
  credentialHelper: boolean;
  suggestedId: string;
}


interface DirectPackagePreviewView {
  type: "package";
  previewId: string;
  expiresAt: string;
  url: string;
  ref: string | null;
  subdir: string | null;
  commit: string;
  detectedFrom: DirectDetectedFile;
  kind: PackageKind;
  name: string;
  displayName: string | null;
  description: string | null;
  version: string;
  /** `0.0.0+g<commit12>`: the file declares no version (design §8.2). */
  versionSynthesized: boolean;
  runsCode: boolean;
  credentialHelper: boolean;
  suggestedId: string;
}

export type SourcePreviewView = MarketplacePreviewView | DirectPackagePreviewView;

export interface SourceAddRequest {
  previewId: string;
  id?: string;
  label?: string;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export type PackageStateView =
  | { state: "install"; version: string }
  | { state: "installed"; version: string | null }
  | { state: "update"; from: string; to: string }
  | { state: "requires-app"; minAppVersion: string }
  | { state: "yanked" }
  | { state: "revoked" }
  | { state: "unavailable" }
  /** The name is installed from another source (or from none): installing here is a switch. */
  | { state: "installed-elsewhere"; sourceId: string | null; version: string | null }
  /** Installed from a source that no longer exists: no updates. */
  | { state: "source-removed"; version: string | null }
  /** Installed without a source (a pasted server.json, a local plugin): nothing updates it. */
  | { state: "unbound"; version: string | null };

export interface CatalogEntryView {
  /** The source is null only for an installed package bound to none (`installedOnly`). */
  key: InstalledKeyView;
  sourceOrigin: SourceOriginKind | null;
  sourceLabel: string | null;
  displayName: string;
  description: string;
  keywords: string[];
  state: PackageStateView;
  /** The policy's requiredInstalls names this package from this source: no Uninstall or Disable. */
  required: boolean;
  /** Plugins and MCP servers. */
  runsCode: boolean;
}

export interface CatalogQuery {
  kind?: PackageKind;
  sourceId?: string;
  query?: string;
  installedOnly?: boolean;
}

export interface CatalogView {
  entries: CatalogEntryView[];
  /** Entries per kind for the tab counts, before the kind filter. */
  counts: Record<PackageKind, number>;
  sourceCount: number;
  /** The most recent successful sync of any shown source. */
  syncedAt: string | null;
}

// ─── Detail, plans, installs ────────────────────────────────────────────────

export type VersionExclusionView = "min_app_version" | "yanked" | "platform" | "prerelease" | "rollout" | "revoked";

export interface VersionView {
  version: string;
  commit: string;
  publishedAt: string;
  minAppVersion: string;
  excluded: VersionExclusionView[];
  yankedReason: string | null;
  rolloutPercent: number | null;
  installed: boolean;
  /** The version the source offers this installation. */
  candidate: boolean;
}

export interface AuthorityView {
  capabilities: string[];
  networkHosts: string[];
  secrets: string[];
  pluginAccess: string[];
  dependencies: string[];
}

type RungKindView = "release" | "archive" | "tree";

export interface RungView {
  rung: RungKindView;
  declared: boolean;
  /** A sha256 stored in git (release and archive); the tree rung needs none. */
  pinned: boolean;
  /** Asset name, archive host or tree path. */
  detail: string | null;
}

export type RungOutcomeView =
  | { rung: RungKindView; outcome: "used" }
  | { rung: RungKindView; outcome: "skipped"; reason: string }
  | { rung: RungKindView; outcome: "failed"; code: string; message: string };

export interface McpRuntimeView {
  transport: "stdio" | "http";
  /** The command line after `$PLUGIN_DIR`/`$DATA_DIR`/`$NODE` names, before substitution. */
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
    repository: string;
    path: string;
    snapshotCommit: string;
    versionCommit: string | null;
    publishedAt: string | null;
  };
  compatibility: { minAppVersion: string | null; appVersion: string; compatible: boolean };
  authority: AuthorityView | null;
  rungs: RungView[];
  versions: VersionView[];
}

export interface InstallPlanRequest extends PackageKeyView {
  version?: string;
  /** Replace an install bound to another source (or to none), keeping the plugin's data. */
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
  rungs: RungView[];
  mcp: McpRuntimeView | null;
}

export interface UpdatePlanView extends InstallPlanView {
  from: string | null;
  /** `origin.commit` of the install to the plan's snapshot commit. */
  commitRange: { from: string | null; to: string };
  authorityDelta: { added: AuthorityView; removed: AuthorityView } | null;
  /** The source's history was rewritten and the new history is pending review (custom and direct only). */
  historyRewritten: { pinned: string | null; candidate: string } | null;
  /** New network hosts, secrets or capabilities, or rewritten history: the update needs an explicit decision. */
  needsConfirmation: boolean;
}

type InstallPhaseView = "resolving" | "downloading" | "verifying" | "installing" | "activating";

export interface InstallProgressView {
  planId: string;
  phase: InstallPhaseView;
  rung: RungKindView | null;
  bytes: number | null;
  total: number | null;
}

export interface InstallResultView {
  /** `sourceId` is null for an MCP server from a pasted server.json: it is bound to no source. */
  key: { sourceId: string | null; kind: PackageKind; name: string };
  /** Null for a pasted server.json, whose version is not recorded. */
  version: string | null;
  action: InstallActionView;
  /** Plugins: the rung that delivered and every rung's outcome. */
  rungs: RungOutcomeView[];
  /** MCP servers: installed, but the first connection failed with this message (the server stays configured). */
  connectionWarning: string | null;
}

export interface UninstallRequest extends InstalledKeyView {
  /** MCP servers: also remove `$DATA_DIR` (design §5.2). */
  removeData?: boolean;
}

export interface UninstallResultView {
  key: InstalledKeyView;
  /** An MCP server's data directory that was kept. */
  keptDataDir: string | null;
}

// ─── Direct MCP input (design §8.1) ─────────────────────────────────────────

export type DirectMcpPreviewRequest = { serverJson: string; select?: { package?: number; remote?: number } };

export interface DirectMcpPreviewView {
  planId: string;
  expiresAt: string;
  name: string;
  version: string;
  runtime: McpRuntimeView;
  /** How many packages and remotes the file lists; `select` picks one. */
  options: { packages: number; remotes: number };
}

// ─── Envelope and API ───────────────────────────────────────────────────────

// ─── Deep links and the boot-install notice (design §15.1, blueprint 4.6) ───

/**
 * What `ave://install|uninstall/<kind>/<name>@<source>` or
 * `ave://marketplace/add?url=…` asks the marketplace to open. The link only
 * opens the confirming UI (the package sheet, the Add dialog); nothing is
 * installed, removed or added until the user confirms there.
 */
export type GitMarketplaceDeepLink =
  | { action: "install" | "uninstall"; key: PackageKeyView }
  | { action: "add"; url: string };

/** An installed package whose bound source offers a newer version (`marketplace:updates-available`, design §7.3). */
export interface PackageUpdateView {
  key: PackageKeyView;
  displayName: string;
  from: string;
  to: string;
}

/** What the boot pass installed, moved or migrated (design §10.2, §16.3), shown once until dismissed. */
/**
 * An installed package its bound source revoked with `uninstall`, or with
 * `disable` where the host has no load gate for the kind (design §10.4).
 */
export interface RevokedPackageView {
  key: PackageKeyView;
  version: string;
  /** The source's reason, as written in its revocations file. */
  reason: string;
  /** `required`: a `requiredInstalls` entry locks it, so it stays; `failed`: the uninstall threw (`message`). */
  outcome: "uninstalled" | "required" | "failed";
  message?: string;
}

export interface BootInstallNoticeView {
  /** Default installs: they belong to the user now, each offered with Uninstall. */
  forYou: PackageKeyView[];
  /** `requiredInstalls` entries installed, updated or switched to their listed source. */
  required: PackageKeyView[];
  /** Plugins an administrator installed that no source lists: no longer locked, no updates. */
  unmanaged: string[];
  /** Plugins that no longer read these host secrets until they update (§10.3). */
  lostGrants: Array<{ plugin: string; keys: string[] }>;
  /** Packages removed, or left in place, because their source revoked them (§10.4). */
  revoked: RevokedPackageView[];
}

/** Nothing left to show: every list is empty. */
export function bootInstallNoticeIsEmpty(notice: BootInstallNoticeView): boolean {
  return notice.forYou.length + notice.required.length + notice.unmanaged.length + notice.lostGrants.length + notice.revoked.length === 0;
}

export type GitMarketplaceErrorCode = MarketplaceErrorCode | "invalid-request" | "unauthorized-frame" | "unavailable";

export type GitMarketplaceResult<T> = { ok: true; value: T } | { ok: false; code: GitMarketplaceErrorCode; message: string };

export interface SyncProgressView {
  sourceId: string;
  state: "syncing" | "done" | "failed";
}

export interface GitMarketplaceApi {
  listSources(): Promise<GitMarketplaceResult<SourceView[]>>;
  previewSource(request: SourcePreviewRequest): Promise<GitMarketplaceResult<SourcePreviewView>>;
  addSource(request: SourceAddRequest): Promise<GitMarketplaceResult<SourceView>>;
  removeSource(id: string): Promise<GitMarketplaceResult<{ orphanedPackages: PackageKeyView[] }>>;
  setSourceEnabled(id: string, enabled: boolean): Promise<GitMarketplaceResult<SourceView>>;
  refreshSources(id?: string): Promise<GitMarketplaceResult<SourceView[]>>;
  acceptRewrite(id: string, commit: string): Promise<GitMarketplaceResult<SourceView>>;
  setToken(host: string, token: string): Promise<GitMarketplaceResult<{ host: string }>>;
  deleteToken(host: string): Promise<GitMarketplaceResult<{ host: string }>>;
  listCatalog(query: CatalogQuery): Promise<GitMarketplaceResult<CatalogView>>;
  packageDetail(key: PackageKeyView): Promise<GitMarketplaceResult<PackageDetailView>>;
  planInstall(request: InstallPlanRequest): Promise<GitMarketplaceResult<InstallPlanView>>;
  planUpdate(key: PackageKeyView): Promise<GitMarketplaceResult<UpdatePlanView>>;
  executeInstall(planId: string): Promise<GitMarketplaceResult<InstallResultView>>;
  uninstall(request: UninstallRequest): Promise<GitMarketplaceResult<UninstallResultView>>;
  previewDirectMcp(request: DirectMcpPreviewRequest): Promise<GitMarketplaceResult<DirectMcpPreviewView>>;
  onSyncProgress(listener: (progress: SyncProgressView) => void): () => void;
  onCatalogChanged(listener: () => void): () => void;
  onInstallProgress(listener: (progress: InstallProgressView) => void): () => void;
  /** The deep link waiting to be opened, cleared by this read. */
  takeDeepLink(): Promise<GitMarketplaceResult<GitMarketplaceDeepLink | null>>;
  /** A deep link arrived: read it with `takeDeepLink`. */
  onDeepLink(listener: () => void): () => void;
  bootInstallNotice(): Promise<GitMarketplaceResult<BootInstallNoticeView | null>>;
  dismissBootInstallNotice(): Promise<GitMarketplaceResult<null>>;
  /** The boot-install step published a notice: read it with `bootInstallNotice`. */
  onBootInstallsApplied(listener: () => void): () => void;
}

// ─── Bridge checks ──────────────────────────────────────────────────────────

const ENVELOPE_CODES = new Set<string>([...MARKETPLACE_ERROR_CODES, "invalid-request", "unauthorized-frame", "unavailable"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check for a result crossing the bridge: the envelope is checked and
 * the value is trusted as main's own view. Anything else reads as unavailable.
 */
export function parseGitMarketplaceResult<T>(value: unknown): GitMarketplaceResult<T> {
  if (isRecord(value)) {
    if (value.ok === true && "value" in value) return { ok: true, value: value.value as T };
    if (value.ok === false && typeof value.code === "string" && ENVELOPE_CODES.has(value.code) && typeof value.message === "string") {
      return { ok: false, code: value.code as GitMarketplaceErrorCode, message: value.message };
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

export function parseInstallProgress(value: unknown): InstallProgressView | null {
  if (!isRecord(value) || typeof value.planId !== "string" || typeof value.phase !== "string") return null;
  if (!["resolving", "downloading", "verifying", "installing", "activating"].includes(value.phase)) return null;
  return value as unknown as InstallProgressView;
}
