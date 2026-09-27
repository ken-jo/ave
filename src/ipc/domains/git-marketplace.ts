/**
 * Host-renderer-only IPC for the git marketplace (design §13).
 * Covers: ave:marketplace:{sources,catalog,package,install,update,uninstall,direct}:*
 * and the marketplace:{sync-progress,catalog-changed,install-progress} events.
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
 * The work outside a request — the boot sync and installs, the periodic sync
 * and update notices (design §7.3, §10.2) — starts from `startBackground`,
 * which the desktop launch calls once the window has loaded. The boot status
 * pill's Retry (`ave:bootstrap:retry`) runs that boot pass again.
 */
import { app, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { notifyBootstrapStatus } from "../../boot/bootstrap-status.js";
import { isDevModeUnlocked, isE2eTestRuntime } from "../../boot/dev-flags.js";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { messages } from "../../i18n/messages/index.js";
import { createLogger } from "../../lib/logger.js";
import { getBootInstallNotice, setBootInstallNotice, takePendingGitMarketplaceLink } from "../../main/app-state.js";
import { ensureCorporateCa } from "../../main/corp-ca-runtime.js";
import { readPersistedCorpCaConfigSync } from "../../main/persisted-corp-ca.js";
import { startMarketplaceBackground, type MarketplaceBackground } from "../../marketplace/app/background.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import type { RevocationFeed } from "../../marketplace/app/revocations.js";
import { McpInstaller, mcpInstallOrigins } from "../../marketplace/app/mcp-installer.js";
import type { ContentInstallerPort, InstallerPorts, PluginInstallerPort, TokenStore } from "../../marketplace/app/ports.js";
import { MarketplaceService } from "../../marketplace/app/service.js";
import { AppliedDefaults } from "../../marketplace/boot-installs/applied.js";
import { DEFAULT_INSTALLS } from "../../marketplace/boot-installs/default-installs.js";
import { loadInstallationId } from "../../marketplace/catalog/installation-id.js";
import { contentLedgerOrigins } from "../../marketplace/content/ledger.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { MarketplaceGit } from "../../marketplace/git/marketplace-git.js";
import { migrateLegacyContent } from "../../marketplace/migration/legacy-content.js";
import { migrateLegacyPlugins } from "../../marketplace/migration/legacy-plugins.js";
import { clearKeptArtifacts, createArtifactCache, resolveKeepArtifacts } from "../../marketplace/resolve/artifact-cache.js";
import { gitRuntimeRoot } from "../../marketplace/git/runtime-service.js";
import { NetworkGate } from "../../marketplace/net/network-gate.js";
import { EMPTY_MARKETPLACE_POLICY, loadMarketplacePolicy, type MarketplacePolicy } from "../../marketplace/sources/policy.js";
import { SourceRegistry } from "../../marketplace/sources/registry.js";
import { pluginRegistryOrigins, retainedCommitsFrom } from "../../marketplace/sources/retained.js";
import { SourceSyncer } from "../../marketplace/sources/sync.js";
import { withPluginInstallLock } from "../../plugins/install-lifecycle.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import { resolveUpdateCheckEnabled } from "../../plugins/update-detector.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  isPackageKind,
  type CatalogQuery,
  type DirectMcpPreviewRequest,
  type GitMarketplaceResult,
  type InstallPlanRequest,
  type InstalledKeyView,
  type InstallProgressView,
  type McpComponentConsent,
  type PackageKeyView,
  type SourceAddRequest,
  type SourcePreviewRequest,
  type SyncProgressView,
  type UninstallRequest,
} from "../../shared/git-marketplace.js";
import { aveHome } from "../../shared/ave-home.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { legacyContentSettings, type InstalledContentRuntime } from "./marketplace-content.js";
import { pluginLifecycleServices } from "./plugins.js";

const log = createLogger("git-marketplace");

export type GitMarketplacePort = Pick<
  MarketplaceService,
  | "listSources"
  | "previewSource"
  | "addSource"
  | "removeSource"
  | "setEnabled"
  | "refresh"
  | "acceptRewrite"
  | "setToken"
  | "deleteToken"
  | "catalog"
  | "detail"
  | "planInstall"
  | "planUpdate"
  | "executeInstall"
  | "uninstall"
  | "getRetirementEntry"
  | "previewDirectMcp"
  | "updates"
  | "applyBootInstalls"
  | "enforceRevocations"
  | "takeRevocationNotice"
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

function pluginInstaller(deps: IpcDeps): PluginInstallerPort {
  const { pluginMarketplace, pluginRuntime } = deps;
  const lifecycle = pluginLifecycleServices(deps);
  return {
    list: async () => (await pluginMarketplace.listInstalledPackages()).map((row) => ({ kind: "plugin" as const, ...row })),
    installedAuthority: (name) => pluginMarketplace.getInstalledAuthority(name),
    install: async (plan, options) => {
      const pluginId = plan.name;
      if (pluginRuntime.resolvePluginInstallIdIfKnown(pluginRuntime.resolvePluginId(pluginId)) === null) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `plugin ${pluginId} is configured statically and cannot be replaced from a marketplace`);
      }
      pluginRuntime.cancelPendingRestart(pluginId);
      return withPluginInstallLock(pluginId, async () => {
        await lifecycle.ensureInstallStateReady(pluginId);
        const result = await pluginMarketplace.installGitPlugin(plan, {
          stage: options.stage,
          switchSource: options.switchSource,
          ...(options.signal ? { signal: options.signal } : {}),
          activatePreparedArtifact: (prepared) => pluginRuntime.activatePreparedArtifact<string>(prepared),
        });
        if (!pluginRuntime.listPluginIds().includes(result.pluginId)) {
          throw new Error(`atomic git install committed without active runtime: ${result.pluginId}`);
        }
        emitHostEvent("plugin.installed", { pluginId: result.pluginId, source: "marketplace" });
        deps.refreshPluginNotifications?.();
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

function contentInstaller(content: () => Promise<InstalledContentRuntime | null>, policy: MarketplacePolicy): ContentInstallerPort {
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
      })),
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
      await loaded.store.uninstall(kind, name, policy);
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
  const policyLoad = await loadMarketplacePolicy();
  if (!policyLoad.ok) log.warn({ err: policyLoad.error }, "marketplace policy unreadable; only the official source is reachable");
  const policy = policyLoad.ok ? policyLoad.policy : EMPTY_MARKETPLACE_POLICY;
  // A marketplace on this machine (an author's own checkout served over HTTP,
  // the E2E fixture) is reachable only in an unpackaged build with AVE_DEV=1.
  const gate = new NetworkGate({ policy: policyLoad, allowLoopback: isDevModeUnlocked() });
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
  const registry = await SourceRegistry.open({ root, policy: policyLoad });

  const broadcast = (channel: string, payload?: unknown) => broadcastTo(deps, channel, payload);
  const catalogChanged = () => {
    broadcast(CHANNELS.gitMarketplace.catalogChanged);
    onCatalogChanged();
  };

  const packagesRoot = join(home, "packages");
  const mcpRecordsPath = join(packagesRoot, "mcp-installs.json");
  // MCP package files, and the zip inspector the plugin ladder checks a release with.
  const artifacts = new PluginArtifactStore({
    installRoot: join(home, "mcp"),
    cacheRoot: join(home, "mcp", ".cache"),
    artifactLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
  });
  const installers: InstallerPorts = {
    plugin: pluginInstaller(deps),
    content: contentInstaller(content, policy),
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
    onCatalogChanged: catalogChanged,
  });
  const { id: installationId } = await loadInstallationId(join(home, "installation-id"));
  const service = new MarketplaceService({
    registry,
    syncer,
    git: { commands: git.commands, credentialHelperFor: (host) => git.credentialHelperFor(host) },
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
      fetchImpl: deps.singleHopNetworkFetch,
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
    english: messages.en,
    onSyncProgress: (progress: SyncProgressView) => broadcast(CHANNELS.gitMarketplace.syncProgress, progress),
    onCatalogChanged: catalogChanged,
    onInstallProgress: (progress: InstallProgressView) => broadcast(CHANNELS.gitMarketplace.installProgress, progress),
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
    revocations: revocationSink(content, catalogChanged),
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

function mcpComponentConsents(value: unknown): readonly McpComponentConsent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new InvalidRequest("approvedMcpServers must be an array of at most 64 entries");
  const names = new Set<string>();
  return value.map((item: unknown) => {
    const consent = record(item, "an MCP server consent");
    if (Object.keys(consent).some((key) => key !== "name" && key !== "digest")) throw new InvalidRequest("MCP server consent has an unknown field");
    const name = text(consent.name, "MCP server name", 128);
    const digest = text(consent.digest, "MCP server digest", 64);
    if (!/^[a-f0-9]{64}$/u.test(digest) || names.has(name)) throw new InvalidRequest("MCP server consent has an invalid digest or repeated name");
    names.add(name);
    return { name, digest };
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

function previewRequest(value: unknown): SourcePreviewRequest {
  const request = record(value, "the preview request");
  if (request.auth !== "none" && request.auth !== "token" && request.auth !== "ssh") throw new InvalidRequest("auth must be none, token or ssh");
  const ref = optionalText(request.ref, "ref", 256);
  const subdir = optionalText(request.subdir, "subdir", 1024);
  const token = optionalText(request.token, "token", 4096);
  return { input: text(request.input, "input", 2048), auth: request.auth, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}), ...(token ? { token } : {}) };
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

function broadcastTo(deps: IpcDeps, channel: string, payload?: unknown): void {
  for (const window of deps.getAppWindows?.() ?? [deps.getMainWindow()]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export interface GitMarketplaceRegistration {
  /** Reuse the same main-owned service for retaining alert predecessor removal. */
  getService(): Promise<GitMarketplacePort>;
  /**
   * Start the boot pass and the periodic sync (desktop only, once the window
   * has loaded). An isolated E2E run reports the pass skipped: it must not
   * reach the official repository.
   */
  startBackground(): void;
  /** `marketplace` settings were written: recompute the update list under the new notice and skip settings. */
  settingsChanged(): void;
}

export function registerGitMarketplaceHandlers(
  deps: IpcDeps,
  content: () => Promise<InstalledContentRuntime | null>,
  create?: () => Promise<{ service: GitMarketplacePort; close: () => Promise<void> }>,
  onBuilt: (close: () => Promise<void>) => Promise<void> = closeOnQuit,
  home: string = aveHome(),
): GitMarketplaceRegistration {
  let background: MarketplaceBackground | null = null;
  // What is installed or offered changed: the update pill follows without waiting for the next sync.
  const build = create ?? (() => createGitMarketplaceService(deps, content, home, () => void background?.recheck()));
  let ready: Promise<{ service: GitMarketplacePort; close: () => Promise<void> }> | null = null;
  const loaded = () => {
    ready ??= (async () => {
      const built = await build();
      try {
        await onBuilt(built.close);
      } catch (error) {
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

  const handle = <T>(channel: string, run: (service: GitMarketplacePort, args: unknown[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitMarketplaceResult<T>> => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED;
      }
      try {
        const { service } = await loaded();
        return { ok: true, value: await run(service, args) };
      } catch (error) {
        if (error instanceof MarketplaceError) return { ok: false, code: error.code, message: error.message };
        if (error instanceof InvalidRequest) return { ok: false, code: "invalid-request", message: error.message };
        log.error({ err: errorMessage(error), channel }, "git marketplace request failed");
        return { ok: false, code: "unavailable", message: errorMessage(error) };
      }
    });
  };

  const channels = CHANNELS.gitMarketplace;
  handle(channels.sourcesList, (service) => service.listSources());
  handle(channels.sourcesPreview, (service, [request]) => service.previewSource(previewRequest(request)));
  handle(channels.sourcesAdd, (service, [request]) => service.addSource(addRequest(request)));
  handle(channels.sourcesRemove, (service, [id]) => service.removeSource(text(id, "id", 64)));
  handle(channels.sourcesSetEnabled, (service, [id, enabled]) => {
    if (typeof enabled !== "boolean") throw new InvalidRequest("enabled must be a boolean");
    return service.setEnabled(text(id, "id", 64), enabled);
  });
  handle(channels.sourcesRefresh, (service, [id]) => service.refresh(id === undefined ? undefined : text(id, "id", 64)));
  handle(channels.sourcesAcceptRewrite, (service, [id, commit]) => service.acceptRewrite(text(id, "id", 64), text(commit, "commit", 40)));
  handle(channels.sourcesSetToken, (service, [host, token]) => service.setToken(text(host, "host", 255), text(token, "token")));
  handle(channels.sourcesDeleteToken, (service, [host]) => service.deleteToken(text(host, "host", 255)));
  handle(channels.catalogList, (service, [query]) => service.catalog(catalogQuery(query)));
  handle(channels.packageDetail, (service, [key]) => service.detail(packageKey(key)));
  handle(channels.installPlan, (service, [request]) => service.planInstall(planRequest(request)));
  handle(channels.updatePlan, (service, [key]) => service.planUpdate(packageKey(key)));
  handle(channels.installExecute, (service, [planId, consents]) => service.executeInstall(text(planId, "planId", 64), mcpComponentConsents(consents)));
  handle(channels.uninstall, (service, [request]) => service.uninstall(uninstallRequest(request)));
  handle(channels.directPreview, (service, [request]) => service.previewDirectMcp(directMcpRequest(request)));

  // Held in main until the tab reads them; answering them builds no marketplace.
  const handleHeld = <T>(channel: string, run: () => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent): GitMarketplaceResult<T> => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(deps.auditLogger, channel, event);
        return UNAUTHORIZED;
      }
      return { ok: true, value: run() };
    });
  };
  handleHeld(channels.deepLinkTake, takePendingGitMarketplaceLink);
  handleHeld(channels.bootInstallsNotice, getBootInstallNotice);
  handleHeld(channels.bootInstallsDismiss, () => {
    setBootInstallNotice(null);
    return null;
  });

  ipcMain.handle(CHANNELS.bootstrap.retry, async (event: IpcMainInvokeEvent) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.bootstrap.retry, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!background) return { ok: false, error: "the marketplace boot pass has not started" } as const;
    await background.retryBootInstalls();
    return { ok: true } as const;
  });

  return {
    getService: async () => (await loaded()).service,
    settingsChanged: () => {
      void background?.settingsChanged();
      dropKeptArtifactsIfOff(deps, home);
    },
    startBackground: () => {
      if (background) return;
      if (isE2eTestRuntime()) {
        notifyBootstrapStatus(deps.getMainWindow(), { phase: "complete", installed: [], failed: [], skipped: { reason: "e2e-isolated" } });
        return;
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
          };
        },
        publishStatus: (status) => notifyBootstrapStatus(deps.getMainWindow(), status),
        publishNotice: (notice) => {
          setBootInstallNotice(notice);
          broadcastTo(deps, channels.bootInstallsApplied);
        },
        publishUpdates: (updates) => broadcastTo(deps, CHANNELS.marketplace.updatesAvailable, updates),
        log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
      });
      const started = background;
      void import("../../main/app-shutdown.js")
        .then(({ registerShutdownHook }) => registerShutdownHook("git-marketplace-background", () => started.stop()))
        .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "marketplace background stop hook failed"));
    },
  };
}
