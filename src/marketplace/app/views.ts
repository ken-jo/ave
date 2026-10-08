/**
 * Catalog rows as the renderer shows them (design §15.1, §15.2): the state
 * chip of a card, the permission summary, the delivery rungs and the version
 * history. Pure functions over the aggregated rows and what is installed.
 */
import type {
  AuthorityView,
  InstallActionView,
  PackageStateView,
  RungOutcomeView,
  RungView,
  SourceStatusView,
  VersionView,
} from "../../shared/git-marketplace.js";
import { versionExclusions, type CatalogRow, type VersionChoiceContext } from "../catalog/aggregate.js";
import type { AgentPluginComponents, PackageKind, PluginArtifactPins, PluginAuthority, Revocation } from "../catalog/types.js";
import { parseMarketplaceErrorDetail, scrubMarketplaceErrorDetail, type MarketplaceError } from "../errors.js";
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import { updateFor, type InstallAction, type InstalledPackage } from "../resolve/identity.js";
import type { RungOutcome } from "../../plugins/plugin-install-receipt.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";
import type { SourceState } from "../sources/registry.js";

/** Kinds whose packages run code on this computer (design §15.5). */
export function runsCode(kind: PackageKind, components?: AgentPluginComponents): boolean {
  if (kind === "agent-plugin") return components === undefined || Object.keys(components.mcpServers).length > 0 || components.hooks.length > 0;
  return kind === "plugin" || kind === "mcp";
}

/**
 * The card's state (design §15.1). Only the bound source's row offers an
 * update; the same name from another source is a switch, never an update.
 */
export function rowState(row: CatalogRow, installed: InstalledPackage | null, rows: readonly CatalogRow[], sources: ReadonlySet<string>): PackageStateView {
  if (installed) {
    if (installed.sourceId !== row.sourceId) {
      return { state: "installed-elsewhere", sourceId: installed.sourceId, version: installed.version };
    }
    if (installed.version === null) return { state: "installed", version: null };
    const update = updateFor({ ...installed, version: installed.version }, rows, sources);
    if (update.state === "update") return { state: "update", from: installed.version, to: update.version };
    return { state: "installed", version: installed.version };
  }
  const choice = row.choice;
  if (choice.state === "candidate") return { state: "install", version: choice.version.version };
  if (choice.state === "upgrade_required") return { state: "requires-app", minAppVersion: choice.minAppVersion };
  if (choice.reason === "yanked") return { state: "yanked" };
  if (choice.reason === "revoked") return { state: "revoked" };
  return { state: "unavailable" };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The permissions a plugin asks for, read from the descriptor before any download (§15.2). */
export function authorityView(authority: PluginAuthority): AuthorityView {
  const plugins = record(authority.pluginAccess)?.plugins;
  const filesystem = (["read", "write"] as const).flatMap((access) =>
    (authority.sandbox?.[access] ?? []).map((grant) =>
      ({ access, target: grant.kind === "hostDirectory" ? grant.segments.join("/") : `config.${grant.configKey}`, why: grant.why })));
  return {
    capabilities: [...authority.capabilities],
    networkHosts: stringList(record(authority.networkAccess)?.allowedDomains),
    secrets: [...(authority.hostSecrets?.read ?? [])],
    pluginAccess: Array.isArray(plugins)
      ? plugins.flatMap((item) => {
          const id = record(item)?.pluginId;
          return typeof id === "string" ? [id] : [];
        })
      : [],
    dependencies: (authority.dependencies ?? []).flatMap((item) => {
      const id = record(item)?.pluginId;
      return typeof id === "string" ? [id] : [];
    }),
    filesystem,
  };
}

function difference<T>(next: readonly T[], previous: readonly T[], key: (item: T) => string = (item) => String(item)): T[] {
  const seen = new Set(previous.map(key));
  return next.filter((item) => !seen.has(key(item)));
}

/** What an update adds and removes (design §15.6); null when nothing changes. */
export function authorityDelta(previous: AuthorityView, next: AuthorityView): { added: AuthorityView; removed: AuthorityView } | null {
  const fields = ["capabilities", "networkHosts", "secrets", "pluginAccess", "dependencies"] as const;
  const grantKey = (grant: AuthorityView["filesystem"][number]): string => `${grant.access}:${grant.target}`;
  const added: AuthorityView = {
    capabilities: difference(next.capabilities, previous.capabilities),
    networkHosts: difference(next.networkHosts, previous.networkHosts),
    secrets: difference(next.secrets, previous.secrets),
    pluginAccess: difference(next.pluginAccess, previous.pluginAccess),
    dependencies: difference(next.dependencies, previous.dependencies),
    filesystem: difference(next.filesystem, previous.filesystem, grantKey),
  };
  const removed: AuthorityView = {
    capabilities: difference(previous.capabilities, next.capabilities),
    networkHosts: difference(previous.networkHosts, next.networkHosts),
    secrets: difference(previous.secrets, next.secrets),
    pluginAccess: difference(previous.pluginAccess, next.pluginAccess),
    dependencies: difference(previous.dependencies, next.dependencies),
    filesystem: difference(previous.filesystem, next.filesystem, grantKey),
  };
  const changed = fields.some((field) => added[field].length > 0 || removed[field].length > 0) ||
    added.filesystem.length > 0 || removed.filesystem.length > 0;
  return changed ? { added, removed } : null;
}

/** An update that widens what the plugin may reach needs an explicit decision (§15.6). */
export function widensAuthority(delta: { added: AuthorityView } | null): boolean {
  if (!delta) return false;
  return delta.added.networkHosts.length > 0 || delta.added.secrets.length > 0 || delta.added.capabilities.length > 0 || delta.added.pluginAccess.length > 0 || delta.added.filesystem.length > 0;
}

/** The ladder as the plan will walk it (§6.2): release → archive → tree. */
/** A download URL that is plain http; an unparsable one is not claimed to be. */
function isHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The Delivery rows (§15.2). A plain-http release or archive is labelled: it
 * is verified only by the sha256 the source pinned (§18.2.3). A release
 * without `url` is served from the source's own origin, http for an http
 * source.
 */
export function rungViews(artifact: PluginArtifactPins, packagePath: string, treeDeclared: boolean, sourceUrl: NormalizedSourceUrl): RungView[] {
  const release = artifact.release;
  const archive = artifact.archive;
  let archiveHost: string | null = null;
  if (archive) {
    try {
      archiveHost = new URL(archive.url).host;
    } catch {
      archiveHost = archive.url;
    }
  }
  return [
    {
      rung: "release",
      declared: release !== undefined,
      pinned: typeof release?.sha256 === "string",
      detail: release ? (release.asset ?? (release.url ? release.url.slice(release.url.lastIndexOf("/") + 1) : null)) : null,
      unencrypted: release !== undefined && (release.url ? isHttpUrl(release.url) : sourceUrl.scheme === "http"),
    },
    { rung: "archive", declared: archive !== undefined, pinned: typeof archive?.sha256 === "string", detail: archiveHost, unencrypted: archive !== undefined && isHttpUrl(archive.url) },
    // Read over the source's own git transport, which the source's badge describes.
    { rung: "tree", declared: treeDeclared, pinned: treeDeclared, detail: treeDeclared ? (artifact.tree ?? packagePath) : null, unencrypted: false },
  ];
}

/**
 * A folder source's one rung (§18.4.2): the built tree in the folder,
 * read in place; nothing is pinned or downloaded.
 */
export function folderRungView(packagePath: string): RungView {
  return { rung: "folder", declared: true, pinned: false, detail: packagePath === "" ? null : packagePath, unencrypted: false };
}

export function rungOutcomeViews(outcomes: readonly RungOutcome[]): RungOutcomeView[] {
  return outcomes.map((item) => ({ ...item }));
}

export function installActionView(action: InstallAction): InstallActionView {
  return { ...action };
}

/** Every listed version with why it is or is not offered (§15.2 Versions). */
export function versionViews(row: CatalogRow, revocations: readonly Revocation[], context: VersionChoiceContext, installedVersion: string | null): VersionView[] {
  const candidate = row.choice.state === "candidate" ? row.choice.version.version : null;
  return row.package.versions.map((version) => ({
    version: version.version,
    commit: version.commit,
    publishedAt: version.publishedAt,
    minAppVersion: version.minAppVersion,
    excluded: versionExclusions(row.sourceId, row.kind, row.name, version, revocations, context),
    yankedReason: version.yanked?.reason ?? null,
    rolloutPercent: version.rollout?.percent ?? null,
    installed: installedVersion === version.version,
    candidate: candidate === version.version,
  }));
}

/** A source whose downloaded copy cannot be used (`SOURCE_LOCAL_DATA_DAMAGED`), scrubbed for the renderer. */
export function brokenStatus(problem: MarketplaceError): SourceStatusView {
  const detail = parseMarketplaceErrorDetail("SOURCE_LOCAL_DATA_DAMAGED", problem.detail);
  return { state: "broken", message: scrubDiagnosticSecrets(problem.message), ...(detail ? { detail: scrubMarketplaceErrorDetail("SOURCE_LOCAL_DATA_DAMAGED", detail) } : {}) };
}

/** A source's status column (§15.4) from its state, whether a sync runs, and whether its snapshot is served. */
export function sourceStatus(state: SourceState, syncing: boolean, cached: boolean, reviewable: boolean): SourceStatusView {
  if (syncing) return { state: "syncing" };
  const last = state.lastSync;
  // A sync that found the copy damaged (its repository): the row offers Repair, as for a state that does not read.
  // Checked before a pending review, which cannot be accepted from a repository git cannot open.
  if (last?.result === "SOURCE_LOCAL_DATA_DAMAGED") {
    const detail = parseMarketplaceErrorDetail(last.result, last.detail);
    return {
      state: "broken",
      message: `the last sync found the downloaded copy damaged${detail ? ` (${detail.reason})` : ""}`,
      ...(detail ? { detail: scrubMarketplaceErrorDetail(last.result, detail) } : {}),
    };
  }
  if (state.pendingRewrite) return { state: "history-rewritten", candidate: state.pendingRewrite.candidate, reviewable };
  if (!last) return state.pinnedCommit ? { state: "up-to-date" } : { state: "never-synced" };
  if (last.result === "ok") return { state: "up-to-date" };
  if (last.result === "SOURCE_HISTORY_REWRITTEN") {
    return { state: "history-rewritten", candidate: last.candidate ?? "", reviewable: false };
  }
  if (last.result === "SOURCE_AUTH_REQUIRED") {
    const detail = parseMarketplaceErrorDetail(last.result, last.detail);
    return { state: "auth-required", ...(detail ? { detail: scrubMarketplaceErrorDetail(last.result, detail) } : {}), cached };
  }
  // The renderer gets a stored detail scrubbed, whatever wrote the state file.
  return { state: "unreachable", code: last.result, ...(last.detail ? { detail: scrubMarketplaceErrorDetail(last.result, last.detail) } : {}), cached };
}
