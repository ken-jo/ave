/**
 * Host-renderer-only IPC for the git marketplace (design §13).
 * Covers: ave:marketplace:{sources,catalog,package,install,update,updates,uninstall,direct}:*
 * and the marketplace:{sync-progress,catalog-changed,install-progress,update-status} events.
 *
 * This is also the composition root: the git runner, network gate, source
 * registry, syncer and each kind's installer are built here, once, on the
 * first request. Plugins install through the same lifecycle (install lock,
 * state preparation, generation activation) as a catalog install; content
 * packages through the installed-content store the content domain loaded,
 * which is re-applied in main after each change; MCP servers through the MCP
 * config with their own record file.
 *
 * Every answer is a `GitMarketplaceResult` envelope: a marketplace failure
 * carries its error code, a malformed request is `invalid-request`, and any
 * other failure is `unavailable` with its message.
 *
 * The work outside a request — the boot sync and installs, and the update
 * scheduler with its notices and status (design §7.3, §10.2, §18.7.1) —
 * starts from `startBackground`, which the desktop launch calls once the
 * window has loaded. The boot status pill's Retry (`ave:bootstrap:retry`)
 * runs that boot pass again; `updates:status` and `updates:check` answer from
 * the scheduler.
 */
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell, type IpcMainInvokeEvent } from "electron";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { notifyBootstrapStatus } from "../../boot/bootstrap-status.js";
import { isDevModeUnlocked, isE2eMarketplaceSchedulerRun, isE2eTestRuntime } from "../../boot/dev-flags.js";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { t } from "../../i18n/index.js";
import { messages } from "../../i18n/messages/index.js";
import { createMarketplaceLogger } from "../../marketplace/log.js";
import { getBootInstallNotice, getMarketplaceLifetime, setBootInstallNotice, takePendingGitMarketplaceLink } from "../../main/app-state.js";
import { ensureCorporateCa } from "../../main/corp-ca-runtime.js";
import { readPersistedCorpCaConfigSync } from "../../main/persisted-corp-ca.js";
import { queryDosDevice } from "../../main/windows-path-kind-launcher.js";
import { marketplaceEvents, startMarketplaceBackground, whileRunning, type MarketplaceBackground } from "../../marketplace/app/background.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import type { RevocationFeed } from "../../marketplace/app/revocations.js";
import { McpInstaller, mcpInstallOrigins } from "../../marketplace/app/mcp-installer.js";
import type { ContentInstallerPort, InstallerPorts, PluginInstallerPort, TokenStore } from "../../marketplace/app/ports.js";
import { MarketplaceService } from "../../marketplace/app/service.js";
import { AppliedDefaults } from "../../marketplace/boot-installs/applied.js";
import { DEFAULT_INSTALLS } from "../../marketplace/boot-installs/default-installs.js";
import { loadInstallationId } from "../../marketplace/catalog/installation-id.js";
import { contentLedgerOrigins } from "../../marketplace/content/ledger.js";
import { MarketplaceError, scrubMarketplaceErrorDetail, scrubMarketplaceStrings } from "../../marketplace/errors.js";
import { MarketplaceGit } from "../../marketplace/git/marketplace-git.js";
import { migrateLegacyContent } from "../../marketplace/migration/legacy-content.js";
import { migrateLegacyPlugins } from "../../marketplace/migration/legacy-plugins.js";
import { clearKeptArtifacts, createArtifactCache, resolveKeepArtifacts } from "../../marketplace/resolve/artifact-cache.js";
import { gitRuntimeRoot } from "../../marketplace/git/runtime-service.js";
import { updateHistoryStore } from "../../marketplace/updates/history.js";
import { NetworkGate } from "../../marketplace/net/network-gate.js";
import { createPinnedFetch } from "../../marketplace/net/pinned-fetch.js";
import { createNodeFolderFs } from "../../marketplace/sources/folder-fs.js";
import { EMPTY_MARKETPLACE_POLICY, FilePolicySource, type MarketplacePolicy } from "../../marketplace/sources/policy.js";
import { isSourceWarning, type SourceWarning } from "../../marketplace/sources/warnings.js";
import { SourceRegistry } from "../../marketplace/sources/registry.js";
import { pluginRegistryOrigins, retainedCommitsFrom } from "../../marketplace/sources/retained.js";
import { SourceSyncer } from "../../marketplace/sources/sync.js";
import { withPluginInstallLock } from "../../plugins/install-lifecycle.js";
import { readPayloadFiles } from "../../plugins/contribution-approval-digest.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import { resolveUpdateCheckEnabled } from "../../plugins/update-detector.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  isPackageKind,
  mergeBootInstallNotices,
  type CatalogQuery,
  type DirectMcpPreviewRequest,
  type GitMarketplaceResult,
  type InstallPlanRequest,
  type InstalledKeyView,
  type ComponentConsent,
  type ReviewedComponentConsent,
  type PackageKeyView,
  type SourceAddRequest,
  type FolderPickView,
  type SourcePreviewRequest,
  type UninstallRequest,
} from "../../shared/git-marketplace.js";
import { aveHome } from "../../shared/ave-home.js";
import { packageUpdateSkipKey, putSkippedPluginUpdate, readSkippedPluginUpdates } from "../../shared/skipped-plugin-updates.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { broadcastToAppWindows } from "../window-fanout.js";
import { legacyContentSettings, type InstalledContentRuntime } from "./marketplace-content.js";
import { pluginLifecycleServices } from "./plugins.js";

const log = createMarketplaceLogger("git-marketplace");

export type GitMarketplacePort = Pick<
  MarketplaceService,
  | "listSources"
  | "previewSource"
  | "addSource"
  | "acknowledgeSource"
  | "revealFolder"
  | "removeSource"
  | "setEnabled"
  | "refresh"
  | "repairSource"
  | "acceptRewrite"
  | "setToken"
  | "deleteToken"
  | "catalog"
  | "detail"
  | "planInstall"
  | "planUpdate"
  | "executeInstall"
  | "uninstall"
  | "uninstallInstalled"
  | "getRetirementEntry"
  | "asOneOperation"
  | "previewDirectMcp"
  | "updates"
  | "discover"
  | "applyBootInstalls"
  | "enforceRevocations"
  | "takeRevocationNotice"
  | "updateCandidates"
  | "autoUpdateContext"
  | "applyUpdate"
  | "appliedState"
  | "callsInFlight"
  | "approveComponents"
  | "packageTransactionsIdle"
>;

/** The settings secret each host's token is stored under (design §2.1). */
function gitTokenSecretKey(host: string): string {
  return `marketplace.gitToken.${host}`;
}

function settingsTokenStore(deps: IpcDeps): TokenStore {
  const settings = deps.settingsService;
  return {
    get: (host) => settings.getSecret(gitTokenSecretKey(host)),
    has: (host) => settings.getSecret(gitTokenSecretKey(host)) !== null,
    set: (host, token) => settings.setSecret(gitTokenSecretKey(host), token),
    delete: (host) => settings.deleteSecret(gitTokenSecretKey(host)),
  };
}

/**
 * The plugin port of the marketplace. `gated` is the marketplace's event
 * boundary: an install that lands after shutdown keeps its files and record,
 * but neither tells the host's subscribers nor refreshes the plugin bridge.
 */
export function pluginInstaller(deps: IpcDeps, gated: ReturnType<typeof whileRunning>): PluginInstallerPort {
  const { pluginMarketplace, pluginRuntime } = deps;
  const lifecycle = pluginLifecycleServices(deps);
  const bundles = () => {
    if (!deps.pluginBundleLifecycle) throw new Error("the plugin bundle lifecycle is not wired");
    return deps.pluginBundleLifecycle;
  };
  return {
    list: async () => (await pluginMarketplace.listInstalledPackages()).map((row) => ({ kind: "plugin" as const, ...row })),
    installedAuthority: (name) => pluginMarketplace.getInstalledAuthority(name),
    baseline: (name) => pluginMarketplace.getInstalledConsentBaseline(name),
    stagedFiles: (staged) => pluginMarketplace.stagedPayloadFiles(staged),
    componentApprovals: (name) => bundles().componentApprovals(name).map((item) => ({
      field: `${item.kind}:${item.localId}`,
      approvalDigest: item.approvalDigest,
      approved: item.approved,
      recordDigest: item.recordDigest,
    })),
    running: (name) => bundles().getActive(name) !== undefined,
    install: async (plan, options) => {
      const pluginId = plan.name;
      if (pluginRuntime.resolvePluginInstallIdIfKnown(pluginRuntime.resolvePluginId(pluginId)) === null) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `plugin ${pluginId} is configured statically and cannot be replaced from a marketplace`);
      }
      pluginRuntime.cancelPendingRestart(pluginId);
      return withPluginInstallLock(pluginId, async () => {
        await lifecycle.ensureInstallStateReady(pluginId);
        const consents = (options.componentConsents ?? []).map((consent) => ({ kind: consent.component, localId: consent.localId, approvalDigest: consent.approvalDigest }));
        // The reviewed components are approved for the generation this install prepares (§18.7.3).
        const install = () => pluginMarketplace.installGitPlugin(plan, {
          stage: options.stage,
          switchSource: options.switchSource,
          ...(options.reviewedAppVersion ? { reviewedAppVersion: options.reviewedAppVersion } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.assertConsent ? { assertConsent: options.assertConsent } : {}),
          activatePreparedArtifact: (prepared) => pluginRuntime.activatePreparedArtifact<string>(prepared),
        });
        const result = consents.length > 0 ? await bundles().withComponentConsents(pluginId, consents, install) : await install();
        if (!pluginRuntime.listPluginIds().includes(result.pluginId)) {
          throw new Error(`atomic git install committed without active runtime: ${result.pluginId}`);
        }
        gated(() => {
          emitHostEvent("plugin.installed", { pluginId: result.pluginId, source: "marketplace" });
          deps.refreshPluginEventBridge?.();
        })();
        return { action: result.action, staged: result.staged };
      });
    },
    retire: async (name, retain) => {
      await lifecycle.retirement.writeIfAbsent(name, await lifecycle.retirement.capture(name, retain));
    },
    uninstall: async (name, retain) => {
      await lifecycle.uninstall(name, retain);
    },
  };
}

function contentInstaller(content: () => Promise<InstalledContentRuntime | null>, policy: () => MarketplacePolicy): ContentInstallerPort {
  const runtime = async () => {
    const loaded = await content();
    if (!loaded) throw new Error("installed content could not be loaded; see the log");
    return loaded;
  };
  return {
    list: async () =>
      (await runtime()).store.list().map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        version: entry.version,
        sourceId: entry.origin.sourceId,
        originCommit: entry.origin.commit,
        digest: entry.origin.contentSha256,
      })),
    baseline: async (kind, name, descriptor) => {
      if (kind === "plugin" || kind === "mcp") throw new Error(`${kind} ${name} is not a content package`);
      return (await runtime()).store.installedConsent(kind, name, (entry) =>
        descriptor({ sourceId: entry.origin.sourceId, commit: entry.origin.commit, packagePath: entry.origin.packagePath, version: entry.version }));
    },
    installedFiles: async (kind, name) => {
      if (kind === "plugin" || kind === "mcp") throw new Error(`${kind} ${name} is not a content package`);
      const { loaded } = await (await runtime()).store.load();
      const found = loaded.find((item) => item.entry.kind === kind && item.entry.name === name);
      return found ? readPayloadFiles(found.dir) : null;
    },
    installId: async (kind, name) => {
      if (kind === "plugin" || kind === "mcp") throw new Error(`${kind} ${name} is not a content package`);
      return (await runtime()).store.list().find((entry) => entry.kind === kind && entry.name === name)?.origin.installId ?? null;
    },
    componentApprovals: async (name) => {
      const approvals = await (await runtime()).componentApprovals(name);
      return [
        ...approvals.mcpServers.map((item) => ({ field: `mcpServer:${item.name}`, approvalDigest: item.approvalDigest, approved: item.approved, recordDigest: item.recordDigest })),
        ...approvals.hooks.map((item) => ({ field: `hook:${item.index}`, approvalDigest: item.approvalDigest, approved: item.approved, recordDigest: item.recordDigest })),
      ];
    },
    callsInFlight: async (name) => (await runtime()).callsInFlight(name),
    approveComponents: async (name, installId, consents) => {
      const loaded = await runtime();
      await loaded.store.approveComponents(name, installId, consents);
    },
    installedComponents: async (name) => {
      const { loaded } = await (await runtime()).store.load();
      const content = loaded.find((item) => item.entry.kind === "agent-plugin" && item.entry.name === name)?.content;
      if (content?.kind !== "agent-plugin") throw new Error(`installed agent-plugin ${name} has no verified components`);
      return content.components;
    },
    install: async (staged, options) => {
      const loaded = await runtime();
      const { action } = await loaded.store.install(staged, options);
      await loaded.reload();
      return { action };
    },
    uninstall: async (kind, name, options) => {
      if (kind === "plugin" || kind === "mcp") throw new Error(`${kind} ${name} is not a content package`);
      const loaded = await runtime();
      const installed = options?.removeData && kind === "agent-plugin" ? (await loaded.store.load()).loaded : [];
      const content = installed.find((item) => item.entry.kind === "agent-plugin" && item.entry.name === name)?.content;
      await loaded.store.uninstall(kind, name, policy());
      await loaded.reload();
      if (options?.removeData && kind === "agent-plugin") {
        await loaded.removeAgentPluginData(name, content?.kind === "agent-plugin" ? Object.keys(content.components.mcpServers) : []);
      }
    },
  };
}

/** Kept plugin zips (design §7.5): `~/.ave/packages/artifacts`. */
function keptArtifactsDir(home: string): string {
  return join(home, "packages", "artifacts");
}

/** Keeping is off: the kept zips go now, not at the next install. */
function dropKeptArtifactsIfOff(deps: IpcDeps, home: string): void {
  if (resolveKeepArtifacts(deps.settingsService.get("marketplace").offlineCacheEnabled)) return;
  void clearKeptArtifacts(keptArtifactsDir(home)).catch((error: unknown) => log.warn({ err: errorMessage(error) }, "kept artifacts could not be removed"));
}

/**
 * Where the service's revocation feed lands (design §10.4): the registry the
 * load gates answer from. A changed set reloads installed content, which
 * applies the gate, and refreshes the catalog; plugins meet it at their next
 * load.
 */
export function revocationSink(
  content: () => Promise<InstalledContentRuntime | null>,
  catalogChanged: () => void,
): { apply(feed: RevocationFeed): Promise<void> } {
  return {
    apply: async (feed) => {
      for (const item of feed.unreadable) log.error({ sourceId: item.sourceId, err: item.message }, "revocations: a source snapshot could not be read; its revocations wait for the next sync");
      if (!revocationRegistry.replace(feed.rules)) return;
      await (await content())?.reload();
      catalogChanged();
    },
  };
}

/** Build the marketplace over `~/.ave`. Nothing touches the network until a request does. */
async function createGitMarketplaceService(
  deps: IpcDeps,
  content: () => Promise<InstalledContentRuntime | null>,
  home: string,
  /** The app's shutdown: no event of the service, the syncer or the revocation sink reaches the renderer after it. */
  shutdown: AbortSignal,
  onCatalogChanged: () => void,
): Promise<{ service: MarketplaceService; close: () => Promise<void> }> {
  if (!deps.pluginPaths) throw new Error("plugin paths are not wired");
  const pluginPaths = deps.pluginPaths;
  const root = join(home, "marketplaces");
  const workRoot = join(root, ".work");
  // Previews and scratch exports live only as long as the process that made them.
  await rm(join(root, ".previews"), { recursive: true, force: true });
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  // Keeping may have been turned off while the app was not running (or by the environment).
  dropKeptArtifactsIfOff(deps, home);
  // Re-read at the start of every operation; a change applies without a restart (§18.6).
  const policy = await FilePolicySource.open();
  if (!policy.load.ok) log.warn({ err: policy.load.error }, "marketplace policy unreadable; only the official source is reachable");
  // Downloads resolve once per hop and connect to the checked address (§18.2.4).
  const transport = createPinnedFetch({ resolveProxy: (url) => session.defaultSession.resolveProxy(url) });
  // A marketplace on this machine (an author's own checkout served over HTTP,
  // the E2E fixture) needs no confirmation in an unpackaged build with AVE_DEV=1.
  const gate = new NetworkGate({ policy, allowLoopback: isDevModeUnlocked(), transport });
  const tokens = settingsTokenStore(deps);
  // A token typed into the add dialog answers only that preview's prompts (design §9.3).
  const previewTokens = new Map<string, string>();
  const git = new MarketplaceGit({
    envRoot: join(root, ".git-env"),
    runtimeRoot: gitRuntimeRoot(home),
    mode: () => deps.settingsService.get("marketplace").git?.mode ?? "auto",
    getToken: (host, sourceId) => previewTokens.get(sourceId) ?? tokens.get(host),
    corporateRootsPem: async () => (await ensureCorporateCa(readPersistedCorpCaConfigSync(app.getPath("userData")))).pem,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });
  const registry = await SourceRegistry.open({ root, policy });
  // Folder sources (§18.4): every filesystem call through one interface; on
  // Windows a drive letter is classified by native/windows-path-kind/.
  const folders = {
    fs: createNodeFolderFs({ platform: process.platform, queryDosDevice }),
    platform: process.platform,
    limits: { maxFiles: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxEntryCount, maxBytes: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxTotalUncompressedBytes },
  };

  // Every event of the service, the syncer and the revocation sink leaves through these, closed at shutdown.
  const events = marketplaceEvents(shutdown, {
    syncProgress: (progress) => broadcastTo(deps, CHANNELS.gitMarketplace.syncProgress, progress),
    installProgress: (progress) => broadcastTo(deps, CHANNELS.gitMarketplace.installProgress, progress),
    catalogChanged: () => {
      broadcastTo(deps, CHANNELS.gitMarketplace.catalogChanged);
      onCatalogChanged();
    },
  });

  const packagesRoot = join(home, "packages");
  const mcpRecordsPath = join(packagesRoot, "mcp-installs.json");
  // MCP package files, and the zip inspector the plugin ladder checks a release with.
  const artifacts = new PluginArtifactStore({
    installRoot: join(home, "mcp"),
    cacheRoot: join(home, "mcp", ".cache"),
    artifactLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
  });
  const installers: InstallerPorts = {
    plugin: pluginInstaller(deps, whileRunning(shutdown)),
    content: contentInstaller(content, () => (policy.load.ok ? policy.load.policy : EMPTY_MARKETPLACE_POLICY)),
    mcp: new McpInstaller({
      recordsPath: mcpRecordsPath,
      dataRoot: join(home, "mcp-data"),
      files: artifacts,
      manager: deps.mcpManager,
      nodePath: process.execPath,
    }),
  };
  const syncer = new SourceSyncer({
    registry,
    gate,
    runner: git.commands,
    root,
    retainedCommits: retainedCommitsFrom([
      pluginRegistryOrigins(pluginPaths.registryPath),
      contentLedgerOrigins(join(packagesRoot, "ledger.json")),
      mcpInstallOrigins(mcpRecordsPath),
    ]),
    onCatalogChanged: events.onCatalogChanged,
    folders,
  });
  const { id: installationId } = await loadInstallationId(join(home, "installation-id"));
  const service = new MarketplaceService({
    registry,
    syncer,
    git: { commands: git.commands, credentialHelperFor: (host) => git.credentialHelperFor(host), preflight: (remote) => git.preflight(remote) },
    gate,
    root,
    workRoot,
    policy,
    tokens,
    previewTokens,
    versionContext: () => ({
      appVersion: getAveAppVersion(),
      platform: process.platform,
      canaryOptIn: deps.settingsService.get("marketplace").canaryOptIn ?? false,
      installationId,
    }),
    installers,
    ladder: {
      zip: artifacts,
      limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
      artifacts: createArtifactCache({
        dir: keptArtifactsDir(home),
        enabled: () => resolveKeepArtifacts(deps.settingsService.get("marketplace").offlineCacheEnabled),
        maxFileBytes: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxCompressedBytes,
        log,
      }),
    },
    mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
    folders: { ...folders, home: homedir() },
    english: messages.en,
    onSyncProgress: events.onSyncProgress,
    onCatalogChanged: events.onCatalogChanged,
    onInstallProgress: events.onInstallProgress,
    // A sign-in pruning deferred by a package transaction runs once none is open.
    onPackageTransactionsIdle: () => deps.mcpManager.packageTransactionsSettled(),
    log: { warn: (message) => log.warn(message) },
    legacyMigration: {
      markerPath: join(packagesRoot, "legacy-migration.json"),
      plugins: (officialPlugin, applied) =>
        migrateLegacyPlugins({
          paths: pluginPaths,
          officialPlugin,
          applied,
          now: () => new Date(),
          log: { warn: (message) => log.warn(message) },
        }),
      content: (ports) => migrateLegacyContent({ ...ports, ...legacyContentSettings(deps), log: { warn: (message) => log.warn(message) } }),
    },
    revocations: revocationSink(content, events.onCatalogChanged),
  });
  return {
    service,
    close: async () => {
      service.close();
      await git.close();
    },
  };
}

// ─── request checks ─────────────────────────────────────────────────────────

class InvalidRequest extends Error {}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidRequest(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new InvalidRequest(`${what} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, what: string, max = 4096): string | undefined {
  return value === undefined ? undefined : text(value, what, max);
}

function optionalFlag(value: unknown, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InvalidRequest(`${what} must be a boolean`);
  return value;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function componentConsents(value: unknown): readonly ComponentConsent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new InvalidRequest("component consents must be an array of at most 64 entries");
  const names = new Set<string>();
  return value.map((item: unknown): ComponentConsent => {
    const consent = record(item, "a component consent");
    if (consent.kind === "extension") {
      // An extension's bundled component by local id, with the approval digest its review showed (§18.7.3).
      if (Object.keys(consent).some((key) => !["kind", "component", "localId", "approvalDigest"].includes(key))
        || (consent.component !== "hook" && consent.component !== "mcpServer")) throw new InvalidRequest("extension consent has an invalid component or field");
      const localId = text(consent.localId, "component local id", 128);
      const approvalDigest = consent.approvalDigest === null ? null : text(consent.approvalDigest, "approval digest", 64);
      const key = `extension:${consent.component}:${localId}`;
      if ((approvalDigest !== null && !SHA256.test(approvalDigest)) || names.has(key)) throw new InvalidRequest("extension consent has an invalid digest or repeated component");
      names.add(key);
      return { kind: "extension", component: consent.component, localId, approvalDigest };
    }
    if (consent.kind === "hook") {
      if (Object.keys(consent).some((key) => !["kind", "index", "digest"].includes(key))
        || !Number.isInteger(consent.index) || (consent.index as number) < 0) throw new InvalidRequest("hook consent has an invalid index or field");
      const digest = text(consent.digest, "hook digest", 64);
      const key = `hook:${consent.index}`;
      if (!/^[a-f0-9]{64}$/u.test(digest) || names.has(key)) throw new InvalidRequest("hook consent has an invalid digest or repeated index");
      names.add(key);
      return { kind: "hook", index: consent.index as number, digest };
    }
    if (Object.keys(consent).some((key) => key !== "name" && key !== "digest")) throw new InvalidRequest("MCP server consent has an unknown field");
    const name = text(consent.name, "MCP server name", 128);
    const digest = text(consent.digest, "MCP server digest", 64);
    if (!/^[a-f0-9]{64}$/u.test(digest) || names.has(`mcp:${name}`)) throw new InvalidRequest("MCP server consent has an invalid digest or repeated name");
    names.add(`mcp:${name}`);
    return { name, digest };
  });
}

/** `components:approve`'s consents (§18.7.5): an agent plugin's server or hook consent plus the approval digest its review showed. */
function reviewedConsents(value: unknown): readonly ReviewedComponentConsent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new InvalidRequest("consents must be an array of 1 to 64 entries");
  const names = new Set<string>();
  return value.map((item: unknown): ReviewedComponentConsent => {
    const consent = record(item, "a component consent");
    const approvalDigest = consent.approvalDigest === null ? null : text(consent.approvalDigest, "approval digest", 64);
    if (approvalDigest !== null && !SHA256.test(approvalDigest)) throw new InvalidRequest("approval digest is not a sha256");
    const { approvalDigest: _shown, ...rest } = consent;
    const [parsed] = componentConsents([rest]);
    if (!parsed || ("kind" in parsed && parsed.kind === "extension")) throw new InvalidRequest("components:approve takes agent plugin components");
    const key = "kind" in parsed ? `hook:${parsed.index}` : `mcp:${parsed.name}`;
    if (names.has(key)) throw new InvalidRequest("a component is named twice");
    names.add(key);
    return { ...parsed, approvalDigest };
  });
}

function packageKey(value: unknown): PackageKeyView {
  const key = record(value, "the package key");
  if (!isPackageKind(key.kind)) throw new InvalidRequest("kind is not a package kind");
  return { sourceId: text(key.sourceId, "sourceId", 64), kind: key.kind, name: text(key.name, "name", 64) };
}

function installedKey(value: unknown): InstalledKeyView {
  const key = record(value, "the package key");
  if (!isPackageKind(key.kind)) throw new InvalidRequest("kind is not a package kind");
  return { sourceId: key.sourceId === null ? null : text(key.sourceId, "sourceId", 64), kind: key.kind, name: text(key.name, "name", 64) };
}

/** A list of confirmations: known warnings, each once (§18.5). */
function warnings(value: unknown, what: string): SourceWarning[] {
  if (!Array.isArray(value) || value.length > 16 || !value.every(isSourceWarning) || new Set(value).size !== value.length) {
    throw new InvalidRequest(`${what} must list known confirmations, each once`);
  }
  return value as SourceWarning[];
}

/** How long a *Choose folder…* selection stays usable for previews (§18.9). */
const FOLDER_PICK_TTL_MS = 15 * 60_000;

/**
 * The folder *Choose folder…* last chose (§18.9), held in main. The tab gets
 * an opaque `pick` and the path scrubbed for display: scrubbed text is not an
 * address (a masked name can name another folder, or none), so a preview of
 * the chosen folder names it by `pick` and main reads the path it kept. One
 * selection at a time: a newer pick replaces it, an add drops it, and it
 * expires after {@link FOLDER_PICK_TTL_MS}. It lives only as long as this
 * process. Any other `pick` is refused as `folder-pick-unknown`.
 */
class FolderPicks {
  private held: { pick: string; path: string; at: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  hold(path: string): FolderPickView {
    const pick = `pick-${randomBytes(16).toString("hex")}`;
    this.held = { pick, path, at: this.now() };
    return { pick, display: scrubMarketplaceStrings(path) };
  }

  /** The path `pick` names; any pick not held now is refused, never guessed. */
  resolve(pick: string): string {
    const held = this.held;
    if (held === null || held.pick !== pick || this.now() - held.at >= FOLDER_PICK_TTL_MS) {
      throw new MarketplaceError("SOURCE_URL_REJECTED", "the chosen folder is no longer held; choose it again", { detail: { reason: "folder-pick-unknown" } });
    }
    return held.path;
  }

  drop(): void {
    this.held = null;
  }
}

function previewRequest(value: unknown, picks: FolderPicks): SourcePreviewRequest {
  const request = record(value, "the preview request");
  if (request.pick !== undefined) {
    // A chosen folder: main's own path for it, and nothing a folder does not take.
    if (request.input !== undefined || request.ref !== undefined || request.subdir !== undefined || request.token !== undefined || request.auth !== "none") {
      throw new InvalidRequest("a chosen folder is previewed by its pick alone, with no address, branch, package folder or sign-in");
    }
    const acknowledge = request.acknowledge === undefined ? undefined : warnings(request.acknowledge, "acknowledge");
    return { input: picks.resolve(text(request.pick, "pick", 64)), auth: "none", ...(acknowledge && acknowledge.length > 0 ? { acknowledge } : {}) };
  }
  if (request.auth !== "none" && request.auth !== "token" && request.auth !== "ssh") throw new InvalidRequest("auth must be none, token or ssh");
  const ref = optionalText(request.ref, "ref", 256);
  const subdir = optionalText(request.subdir, "subdir", 1024);
  const token = optionalText(request.token, "token", 4096);
  const acknowledge = request.acknowledge === undefined ? undefined : warnings(request.acknowledge, "acknowledge");
  return {
    input: text(request.input, "input", 2048),
    auth: request.auth,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
    ...(token ? { token } : {}),
    ...(acknowledge && acknowledge.length > 0 ? { acknowledge } : {}),
  };
}

function addRequest(value: unknown): SourceAddRequest {
  const request = record(value, "the add request");
  const id = optionalText(request.id, "id", 64);
  const label = optionalText(request.label, "label", 100);
  return { previewId: text(request.previewId, "previewId", 64), ...(id ? { id } : {}), ...(label ? { label } : {}) };
}

function catalogQuery(value: unknown): CatalogQuery {
  const query = value === undefined ? {} : record(value, "the catalog query");
  if (query.kind !== undefined && !isPackageKind(query.kind)) throw new InvalidRequest("kind is not a package kind");
  const sourceId = optionalText(query.sourceId, "sourceId", 64);
  const installedOnly = optionalFlag(query.installedOnly, "installedOnly");
  const search = query.query === undefined || query.query === "" ? undefined : text(query.query, "query", 200);
  return {
    ...(query.kind !== undefined ? { kind: query.kind } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(search ? { query: search } : {}),
    ...(installedOnly !== undefined ? { installedOnly } : {}),
  };
}

function planRequest(value: unknown): InstallPlanRequest {
  const key = packageKey(value);
  const request = record(value, "the plan request");
  const version = optionalText(request.version, "version", 256);
  const switchSource = optionalFlag(request.switchSource, "switchSource");
  return { ...key, ...(version ? { version } : {}), ...(switchSource !== undefined ? { switchSource } : {}) };
}

function uninstallRequest(value: unknown): UninstallRequest {
  const key = installedKey(value);
  const removeData = optionalFlag(record(value, "the uninstall request").removeData, "removeData");
  return { ...key, ...(removeData !== undefined ? { removeData } : {}) };
}

function directMcpRequest(value: unknown): DirectMcpPreviewRequest {
  const request = record(value, "the server.json request");
  const select = request.select === undefined ? undefined : record(request.select, "select");
  const index = (raw: unknown, what: string): number | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 1000) throw new InvalidRequest(`${what} must be an index`);
    return raw;
  };
  const pkg = index(select?.package, "select.package");
  const remote = index(select?.remote, "select.remote");
  return {
    serverJson: text(request.serverJson, "serverJson", 256 * 1024),
    ...(select ? { select: { ...(pkg !== undefined ? { package: pkg } : {}), ...(remote !== undefined ? { remote } : {}) } } : {}),
  };
}

// ─── handlers ───────────────────────────────────────────────────────────────

const UNAUTHORIZED: GitMarketplaceResult<never> = Object.freeze({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });

/** Close the built marketplace when the app quits: the askpass broker's socket and directory, and preview clones. */
async function closeOnQuit(close: () => Promise<void>): Promise<void> {
  // Loaded only once a marketplace exists: the shutdown registry pulls in the app's servers.
  const { registerShutdownHook } = await import("../../main/app-shutdown.js");
  registerShutdownHook("git-marketplace", () => {
    close().catch((error: unknown) => log.warn({ err: errorMessage(error) }, "git marketplace close failed"));
  });
}

/**
 * The conversation's idle gate for the apply queue (§18.7.4): the main
 * conversation's activity coordinator, which every surface acquires before
 * it touches the main loop.
 */
function conversationActivity(deps: IpcDeps): { isBusy(): boolean; onIdle(listener: () => void): () => void } {
  const runtime = deps.conversationSurfaceRuntime;
  if (!runtime) throw new Error("the conversation surface runtime is not wired; the apply queue has no idle gate");
  return runtime.activity;
}

/** Record `version` of `key` as skipped (`skippedPluginUpdates`, §18.7.5). */
async function skipVersion(deps: IpcDeps, key: { kind: string; name: string }, version: string): Promise<void> {
  const skipped = readSkippedPluginUpdates(deps.settingsService.get("marketplace").skippedPluginUpdates);
  putSkippedPluginUpdate(skipped, packageUpdateSkipKey(key), version);
  await deps.settingsService.patch({ marketplace: { skippedPluginUpdates: skipped } });
}

/** Every window gets `payload` with its strings scrubbed: what the marketplace tells the renderer crosses only scrubbed (§18.8). */
function broadcastTo(deps: IpcDeps, channel: string, payload?: unknown): void {
  broadcastToAppWindows(deps, channel, scrubMarketplaceStrings(payload));
}

export interface GitMarketplaceRegistration {
  /** Reuse the same main-owned service for retaining alert predecessor removal. */
  getService(): Promise<GitMarketplacePort>;
  /**
   * Start the boot pass and the update scheduler (desktop only, once the
   * window has loaded). An isolated E2E run reports the pass skipped: it must
   * not reach the official repository. Answers the scheduler's `started`:
   * settled when the boot pass, its apply check and the first update list are
   * done (already settled when nothing started), so a caller that must see
   * that work finished waits for the work itself, not for what it published.
   */
  startBackground(): Promise<void>;
  /** `marketplace` settings were written: republish the updates under the new notice and skip settings, and run a due check. */
  settingsChanged(): void;
  /** No package transaction is open; true before the service is built, when none can be. */
  packageTransactionsIdle(): boolean;
}

export function registerGitMarketplaceHandlers(
  deps: IpcDeps,
  content: () => Promise<InstalledContentRuntime | null>,
  create?: () => Promise<{ service: GitMarketplacePort; close: () => Promise<void> }>,
  onBuilt: (close: () => Promise<void>) => Promise<void> = closeOnQuit,
  home: string = aveHome(),
  /** The marketplace's lifetime, shared with its git runtime and deep links (`getMarketplaceLifetime`). */
  shutdown: AbortController = getMarketplaceLifetime(),
): GitMarketplaceRegistration {
  let background: MarketplaceBackground | null = null;
  // Aborted by the `git-marketplace-events` shutdown hook: it closes the event
  // boundary and stops the update scheduler in the same step.
  const gated = whileRunning(shutdown.signal);
  shutdown.signal.addEventListener("abort", () => background?.stop(), { once: true });
  // From registration on: the git runtime and deep links share this lifetime before any marketplace is built.
  // Imported, not named at load: the shutdown registry pulls in the app's servers.
  void import("../../main/app-shutdown.js")
    .then(({ registerShutdownHook }) => registerShutdownHook("git-marketplace-events", () => shutdown.abort()))
    .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "marketplace shutdown hook failed"));
  // What is installed or offered changed: the update pill follows without waiting for the next sync.
  const build = create ?? (() => createGitMarketplaceService(deps, content, home, shutdown.signal, () => void background?.recheck()));
  let ready: Promise<{ service: GitMarketplacePort; close: () => Promise<void> }> | null = null;
  let current: GitMarketplacePort | null = null;
  const loaded = () => {
    ready ??= (async () => {
      const built = await build();
      // Readable at once: an install that runs during onBuilt already holds its package lock.
      current = built.service;
      try {
        await onBuilt(built.close);
      } catch (error) {
        current = null;
        // Nothing would close a service no one can reach: close it here, then build afresh next time.
        await built.close().catch((closeError: unknown) => log.warn({ err: errorMessage(closeError) }, "git marketplace close after a failed start failed"));
        throw error;
      }
      return built;
    })().catch((error: unknown) => {
      // Built again on the next request: a missing directory or a transient read may clear.
      ready = null;
      throw error;
    });
    return ready;
  };

  /** A failure as the envelope carries it (§18.8). */
  const failure = <T>(channel: string, error: unknown): GitMarketplaceResult<T> => {
    // A message or a detail's text can quote a git error or an address; it reaches the renderer and its clipboard only scrubbed.
    if (error instanceof MarketplaceError) return { ok: false, code: error.code, message: scrubDiagnosticSecrets(error.message), ...(error.detail ? { detail: scrubMarketplaceErrorDetail(error.code, error.detail) } : {}) };
    if (error instanceof InvalidRequest) return { ok: false, code: "invalid-request", message: scrubDiagnosticSecrets(error.message) };
    const message = scrubDiagnosticSecrets(errorMessage(error));
    log.error({ err: message, channel }, "git marketplace request failed");
    return { ok: false, code: "unavailable", message };
  };

  const handle = <T>(channel: string, run: (service: GitMarketplacePort, args: unknown[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitMarketplaceResult<T>> => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED;
      }
      try {
        const { service } = await loaded();
        // Paths, addresses, labels and names in an answer reach the renderer only scrubbed, like a failure's detail.
        return { ok: true, value: scrubMarketplaceStrings(await run(service, args)) };
      } catch (error) {
        return failure<T>(channel, error);
      }
    });
  };

  const channels = CHANNELS.gitMarketplace;
  handle(channels.sourcesList, (service) => service.listSources());
  const picks = new FolderPicks();
  handle(channels.sourcesPreview, (service, [request]) => service.previewSource(previewRequest(request, picks)));
  handle(channels.sourcesAdd, async (service, [request]) => {
    const added = await service.addSource(addRequest(request));
    // The chosen folder was for this add: a later preview chooses again.
    picks.drop();
    return added;
  });
  handle(channels.sourcesAcknowledge, (service, [id, list]) => {
    const confirmed = warnings(list, "warnings");
    if (confirmed.length === 0) throw new InvalidRequest("warnings must name at least one confirmation");
    return service.acknowledgeSource(text(id, "id", 64), confirmed);
  });
  // *Show in Finder / Explorer*: an id, never a path, and only a folder source's (§18.9).
  handle(channels.sourcesReveal, async (service, [id]) => {
    const path = await service.revealFolder(text(id, "id", 64));
    if (path === null) throw new InvalidRequest("only a folder source has a folder to show");
    // Straight to the shell, no call in between: revealFolder classified the path as its last
    // step. A remap after that is the stated residual of design §7.7 (reveal boundary).
    shell.showItemInFolder(path);
    return null;
  });
  handle(channels.sourcesRemove, (service, [id]) => service.removeSource(text(id, "id", 64)));
  handle(channels.sourcesSetEnabled, (service, [id, enabled]) => {
    if (typeof enabled !== "boolean") throw new InvalidRequest("enabled must be a boolean");
    return service.setEnabled(text(id, "id", 64), enabled);
  });
  // Repair is a refresh with that intent (§18.8): it starts the source's downloaded copy over before the sync.
  handle(channels.sourcesRefresh, (service, [id, intent]) => {
    if (intent === undefined) return service.refresh(id === undefined ? undefined : text(id, "id", 64));
    if (intent !== "repair") throw new InvalidRequest("intent must be repair");
    return service.repairSource(text(id, "id", 64));
  });
  handle(channels.sourcesAcceptRewrite, (service, [id, commit]) => service.acceptRewrite(text(id, "id", 64), text(commit, "commit", 40)));
  handle(channels.sourcesSetToken, (service, [host, token]) => service.setToken(text(host, "host", 255), text(token, "token")));
  handle(channels.sourcesDeleteToken, (service, [host]) => service.deleteToken(text(host, "host", 255)));
  handle(channels.catalogList, (service, [query]) => service.catalog(catalogQuery(query)));
  handle(channels.packageDetail, (service, [key]) => service.detail(packageKey(key)));
  handle(channels.installPlan, (service, [request]) => service.planInstall(planRequest(request)));
  handle(channels.updatePlan, (service, [key]) => service.planUpdate(packageKey(key)));
  handle(channels.installExecute, async (service, [planId, consents]) => {
    const result = await service.executeInstall(text(planId, "planId", 64), componentConsents(consents), true);
    // A rollback by hand: the version it left is skipped, so the next apply check does not undo it (§18.7.5).
    if (result.action.action === "replace" && result.action.direction === "downgrade" && result.action.from !== null) {
      await skipVersion(deps, result.key, result.action.from);
      void background?.settingsChanged().catch((error: unknown) => log.warn({ err: errorMessage(error) }, "marketplace settings recheck failed"));
    }
    return result;
  });
  handle(channels.uninstall, (service, [request]) => service.uninstall(uninstallRequest(request)));
  handle(channels.directPreview, (service, [request]) => service.previewDirectMcp(directMcpRequest(request)));

  // Held in main until the tab reads them; answering them builds no marketplace.
  const handleHeld = <T>(channel: string, run: () => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent): GitMarketplaceResult<T> => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED;
      }
      return { ok: true, value: scrubMarketplaceStrings(run()) };
    });
  };
  handleHeld(channels.deepLinkTake, takePendingGitMarketplaceLink);

  // *Choose folder…* (§18.9): main's own folder dialog, which needs no marketplace. Main keeps the path;
  // the tab shows it scrubbed and previews it by its pick (`FolderPicks`).
  ipcMain.handle(channels.sourcesPickFolder, async (event: IpcMainInvokeEvent): Promise<GitMarketplaceResult<FolderPickView | null>> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, channels.sourcesPickFolder, event);
      return UNAUTHORIZED;
    }
    try {
      const options = { title: t("mainDialog.marketplacePickFolderTitle"), properties: ["openDirectory" as const, "dontAddToRecent" as const] };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const path = picked.filePaths[0];
      return { ok: true, value: picked.canceled || !path ? null : picks.hold(path) };
    } catch (error) {
      const message = scrubDiagnosticSecrets(errorMessage(error));
      log.error({ err: message }, "git marketplace folder dialog failed");
      return { ok: false, code: "unavailable", message };
    }
  });
  handleHeld(channels.bootInstallsNotice, getBootInstallNotice);
  handleHeld(channels.bootInstallsDismiss, () => {
    setBootInstallNotice(null);
    return null;
  });

  // The update scheduler's answers (design §18.7.1); none exists before the window has loaded, or in an isolated E2E run.
  const handleScheduler = <T>(channel: string, run: (scheduler: MarketplaceBackground, args: unknown[]) => Promise<T>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitMarketplaceResult<T>> => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED;
      }
      if (!background) return { ok: false, code: "unavailable", message: "update checks have not started" };
      try {
        return { ok: true, value: scrubMarketplaceStrings(await run(background, args)) };
      } catch (error) {
        return failure<T>(channel, error);
      }
    });
  };
  handleScheduler(channels.updatesStatus, (scheduler) => scheduler.status());
  handleScheduler(channels.updatesCheck, (scheduler) => scheduler.checkNow());
  handleScheduler(channels.updatesApplyNow, (scheduler) => scheduler.applyNow());
  handleScheduler(channels.componentsApprove, (scheduler, [key, installId, consents]) =>
    scheduler.approveComponents(packageKey(key), text(installId, "installId", 64), reviewedConsents(consents)));

  ipcMain.handle(CHANNELS.bootstrap.retry, async (event: IpcMainInvokeEvent) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.bootstrap.retry, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!background) return { ok: false, error: "the marketplace boot pass has not started" } as const;
    try {
      await background.retryBootInstalls();
    } catch (error) {
      // Refused once the app is shutting down (the scheduler has stopped): the declared refusal, not a rejection.
      const message = scrubDiagnosticSecrets(errorMessage(error));
      log.warn({ err: message }, "marketplace boot pass retry refused");
      return { ok: false, error: message } as const;
    }
    return { ok: true } as const;
  });

  return {
    getService: async () => (await loaded()).service,
    packageTransactionsIdle: () => current?.packageTransactionsIdle ?? true,
    settingsChanged: () => {
      // Never rejects for a stop (the scheduler ends quietly); anything else is logged, not left unhandled.
      void background?.settingsChanged().catch((error: unknown) => log.warn({ err: errorMessage(error) }, "marketplace settings recheck failed"));
      dropKeptArtifactsIfOff(deps, home);
    },
    startBackground: () => {
      if (background) return background.started;
      if (shutdown.signal.aborted) return Promise.resolve();
      // An isolated E2E run skips the pass, unless the spec exercises the real scheduler against its own sources.
      if (isE2eTestRuntime() && !isE2eMarketplaceSchedulerRun()) {
        notifyBootstrapStatus(deps.getMainWindow(), { phase: "complete", installed: [], failed: [], skipped: { reason: "e2e-isolated" } });
        return Promise.resolve();
      }
      background = startMarketplaceBackground({
        service: async () => (await loaded()).service,
        appliedDefaults: () => AppliedDefaults.open(join(home, "packages", "default-installs.json")),
        defaults: DEFAULT_INSTALLS,
        settings: () => {
          const marketplace = deps.settingsService.get("marketplace");
          return {
            updateNotices: resolveUpdateCheckEnabled(marketplace.updateCheckEnabled),
            ...(marketplace.updateCheckIntervalMs !== undefined ? { updateCheckIntervalMs: marketplace.updateCheckIntervalMs } : {}),
            skippedPluginUpdates: marketplace.skippedPluginUpdates,
            ...(marketplace.autoUpdate !== undefined ? { autoUpdate: marketplace.autoUpdate } : {}),
            ...(marketplace.autoUpdateSources ? { autoUpdateSources: marketplace.autoUpdateSources } : {}),
            ...(marketplace.autoUpdatePackages ? { autoUpdatePackages: marketplace.autoUpdatePackages } : {}),
          };
        },
        activity: conversationActivity(deps),
        publishStatus: gated((status) => notifyBootstrapStatus(deps.getMainWindow(), scrubMarketplaceStrings(status))),
        publishNotice: gated((notice) => {
          // Added to what the user has not dismissed yet: an update applied after the boot notice joins it (§18.7.5).
          setBootInstallNotice(mergeBootInstallNotices(getBootInstallNotice(), notice));
          broadcastTo(deps, channels.bootInstallsApplied);
        }),
        publishUpdates: gated((updates) => broadcastTo(deps, CHANNELS.marketplace.updatesAvailable, updates)),
        publishUpdateStatus: gated((status) => broadcastTo(deps, channels.updateStatusChanged, status)),
        history: updateHistoryStore(join(home, "marketplaces", "updates.json")),
        onResume: (listener) => {
          powerMonitor.on("resume", listener);
          return () => powerMonitor.removeListener("resume", listener);
        },
        log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
      });
      return background.started;
    },
  };
}
