



import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  McpAuthErrorCode,
  McpAuthStatus,
  McpAuthenticationResult,
  McpHttpServerConfig,
  McpConfigMutationResult,
  McpResourceSummary,
  McpResourceTemplateSummary,
  McpServerConfig,
  McpServerConfigDto,
  McpServerState,
  McpToolCallOutput,
  McpUiResourceRead,
  ValidationResult,
} from "./types.js";
import { McpGovernance } from "./mcp-governance.js";
import { McpClient, scrubSecrets } from "./mcp-client.js";
import { McpOAuthError, McpOAuthSession, tryMcpOAuthCredentialKey, type McpOAuthDependencies, type McpOAuthSecrets } from "./mcp-oauth.js";
import { ToolRegistry, type PreparedMcpRegistryReplacement } from "../tools/registry.js";
import type { Tool } from "../tools/base.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { McpInputRequestResolver } from "./mcp-client.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { MAX_SERVER_ID_LEN } from "../shared/mcp-app-partition.js";
import { t } from "../i18n/index.js";
import { studioConnectorSpecDigest } from "../studio/connector-digest.js";
import { containsStoredCredential } from "./studio-credential-guard.js";
import type { PluginMcpOwner, PluginMcpTrustStore, PreparedPluginMcpProjection } from "./plugin-mcp-projection.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";
import { errorMessage } from "../shared/error-message.js";
import { boundBundledCredential, bundledConfigId, bundledCredentialDeclaration, bundledCredentialKey, parseBundledConfigId, readBoundBundledCredential, type BundledPackageRef } from "./bundled-credential.js";
const log = createLogger("mcp-manager");

interface BundledCredentialDeclaration {
  packageName: string;
  serverName: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  auth?: "api-key" | "oauth";
  /** OAuth metadata exactly as the server's projection carries it; part of its credential key. */
  oauth?: McpHttpServerConfig["oauth"];
  apiKeyEnv?: string;
  apiKeyHeader?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BundledCredentialSource {
  list(): readonly BundledCredentialDeclaration[];
  reconnect(packageName: string, serverName: string): Promise<void>;
  /** Only a verified installed set can authorize pruning; undefined means ownership is unknown. */
  installedPackages(): Promise<ReadonlySet<string> | undefined>;
}

export interface BundledSecretStore {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

const OAUTH_CREDENTIAL_INDEX_KEY = "mcp.oauth.index";

/** Malformed existing configuration must never be overwritten. */
class McpConfigFileInvalidError extends Error {
  readonly code = "mcp-config-invalid";
  constructor(message: string) {
    super(message);
    this.name = "McpConfigFileInvalidError";
  }
}

function oauthErrorCode(error: unknown, status: McpAuthStatus | undefined): McpAuthErrorCode {
  if (error instanceof McpOAuthError) return error.code;
  return status === "required" ? "mcp-auth-required" : "mcp-auth-failed";
}

const defaultConfigPath = (): string => join(aveHome(), "mcp", "servers.json");

function validatedApiKey(value: string): string {
  if (typeof value !== "string") throw new Error("MCP credential must be text");
  if (/[\r\n\x00-\x08\x0B-\x1F\x7F]/u.test(value)) {
    throw new Error(`[mcp-manager] ${t("be_mcpManager.apiKeyControlChars")}`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`[mcp-manager] ${t("be_mcpManager.apiKeyEmpty")}`);
  if (trimmed.length > 4096) throw new Error(`[mcp-manager] ${t("be_mcpManager.apiKeyTooLong")}`);
  return trimmed;
}

interface PreparedBundledMcpRecord {
  projection: PreparedPluginMcpProjection;
  client: McpClient;
  baseTools: readonly Tool[];
  tools: readonly Tool[];
  reused: boolean;
}

interface PendingBundledCandidateCleanup {
  readonly serverId: string;
  readonly context: string;
}

export interface BundledMcpDegradedState {
  readonly pluginId: string;
  readonly generationId: string;
  readonly localId: string;
  readonly code: "connection_failed" | "blocked-by-policy" | "credential_required";
  readonly message: string;
  readonly retryable: boolean;
  readonly lastAttemptAt: string;
}

export interface PreparedBundledMcpGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  readonly predecessorServerIds: readonly string[];
  readonly predecessorToolNames: readonly string[];
  readonly records: readonly PreparedBundledMcpRecord[];
  readonly degraded: readonly BundledMcpDegradedState[];
  readonly registryReplacement: PreparedMcpRegistryReplacement;
  readonly governancePublication: { assertAdmitted(): void; publish(): void };
  published: boolean;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private readonly oauthSessions = new Map<string, { fingerprint: string; session: McpOAuthSession }>();
  private readonly bundledOAuthSessions = new Map<string, { fingerprint: string; session: McpOAuthSession }>();
  private readonly bundledOAuthRuntimeIds = new Map<string, string>();
  private oauthStoreWork: Promise<void> = Promise.resolve();
  /** Unreadable credential indexes pause cleanup until a successful rebuild. */
  private oauthIndexUnreadable = false;
  /** Pruning waits until package transactions are closed. */
  private packageTransactionsIdle: () => boolean = () => true;
  private readonly deferredBundledReconciles = new Set<BundledPackageRef["kind"]>();
  /** Reinstall sessions wait for committed removal revocations before loading grants. */
  private readonly pendingBundledRemovals = new Map<string, Promise<void>>();
  private readonly authentications = new Map<string, Promise<McpAuthenticationResult>>();
  private readonly oauthRetirements = new Map<string, number>();
  private readonly serverLifecycleLocks = new Map<string, Promise<void>>();
  private oauthShutdownGeneration = 0;
  private bundledOwners = new Map<string, PluginMcpOwner>();
  private readonly bundledStableIds = new Map<string, string>();
  private readonly bundledCredentialSources = new Map<BundledPackageRef["kind"], BundledCredentialSource>();
  private activeBundledServerIds = new Set<string>();
  private bundledDegraded = new Map<string, readonly BundledMcpDegradedState[]>();
  private readonly bundledBaseTools = new WeakMap<Tool, Tool>();
  private readonly bundledToolSnapshots = new Map<string, readonly Tool[]>();
  /** Keep exact transport handles until candidate teardown succeeds. */
  private readonly pendingBundledCandidateCleanup = new Map<
    McpClient,
    PendingBundledCandidateCleanup
  >();
  private generationAccess: PluginRuntimeGenerationAccess | undefined;
  /** Longest owner-prefix lease routing takes precedence over the plugin lifecycle. */
  private readonly generationLeaseSources = new Map<string, (pluginId: string, activationId: string) => Promise<{ release(): void }>>();
  private readonly configPath: string;
  private readonly configLockPath: string;
  /** Serialize config read-modify-write operations to prevent races. */
  private configOpLock: Promise<void> = Promise.resolve();

  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.configOpLock.then(fn);
    this.configOpLock = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  private withConfigFileLock<T>(fn: () => Promise<T>): Promise<T> {
    // Lock a stable sibling sentinel so Windows atomic config replacement is not disturbed.
    return withFileLock(this.configLockPath, fn);
  }

  constructor(
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    private readonly networkFetch: typeof fetch,
    configPath?: string,
    private readonly auditLogger?: AuditLogger,
    /** Bind elicitation approval per server; without a resolver, input_required fails closed. */
    private readonly inputResolverFactory?: (serverId: string) => McpInputRequestResolver,
    /** Emit once for permanent retirement, never reconnect; consumers disable cards and clear partitions. */
    private readonly onServerDisconnected?: (serverId: string) => void,
    private readonly bundledSecrets?: BundledSecretStore,
    private readonly oauthPresentation?: Omit<McpOAuthDependencies, "networkFetch">,
  ) {
    this.configPath = configPath ?? defaultConfigPath();
    this.configLockPath = `${this.configPath}.guard`;
  }

  setPluginGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    this.generationAccess = access;
  }

  /** Agent plugins supply their own generation leases because the plugin lifecycle does not own them. */
  registerGenerationLeaseSource(prefix: string, acquireExact: (pluginId: string, activationId: string) => Promise<{ release(): void }>): void {
    if (!prefix || this.generationLeaseSources.has(prefix)) throw new Error(`bundled MCP lease source ${prefix} is already registered`);
    this.generationLeaseSources.set(prefix, acquireExact);
  }

  /** Registered tools and all other bundled calls share the exact-generation lease acquisition path. */
  private async acquireOwnerLease(owner: { pluginId: string; activationId: string }): Promise<{ release(): void }> {
    let source: ((pluginId: string, activationId: string) => Promise<{ release(): void }>) | undefined;
    let matched = -1;
    for (const [prefix, acquire] of this.generationLeaseSources) {
      if (owner.pluginId.startsWith(prefix) && prefix.length > matched) {
        source = acquire;
        matched = prefix.length;
      }
    }
    if (source) return source(owner.pluginId, owner.activationId);
    const access = this.generationAccess;
    if (!access) throw new Error("plugin generation access is not configured for bundled MCP");
    return access.acquireExact(owner.pluginId, owner.activationId);
  }

  /** Bundled sign-in pruning waits while this reports an open package transaction. */
  setPackageTransactionProbe(probe: () => boolean): void {
    this.packageTransactionsIdle = probe;
  }

  registerBundledCredentialSource(kind: BundledPackageRef["kind"], source: BundledCredentialSource): void {
    this.bundledCredentialSources.set(kind, source);
    void this.reconcileBundledOAuthCredentials(kind, source);
  }

  /** Committed removal revokes grants even if a same-id reinstall already appears in the installed set. */
  reconcileBundledCredentials(kind: BundledPackageRef["kind"], options: { removed?: string } = {}): Promise<void> {
    const revoked = options.removed === undefined ? Promise.resolve() : this.revokeRemovedBundledPackage({ kind, name: options.removed });
    const source = this.bundledCredentialSources.get(kind);
    return Promise.all([revoked, source ? this.reconcileBundledOAuthCredentials(kind, source) : undefined]).then(() => undefined);
  }

  private revokeRemovedBundledPackage(packageRef: BundledPackageRef): Promise<void> {
    const ofPackage = (serverId: string): boolean => {
      let ref: ReturnType<typeof parseBundledConfigId>;
      try { ref = parseBundledConfigId(serverId); }
      catch { ref = null; }
      return ref?.packageRef.kind === packageRef.kind && ref.packageRef.name === packageRef.name;
    };
    const keys = new Set<string>();
    for (const stableId of [...this.bundledOAuthSessions.keys()]) {
      if (ofPackage(stableId)) keys.add(this.retireBundledSession(stableId));
    }
    const removal = `${packageRef.kind}/${packageRef.name}`;
    const work = this.queueOAuthStoreWork(async (secrets) => {
      const index = this.readOAuthIndex(secrets);
      let changed = false;
      for (const [serverId, key] of Object.entries(index ?? {})) {
        if (!ofPackage(serverId)) continue;
        keys.add(key);
        delete index![serverId];
        changed = true;
      }
      for (const key of keys) await secrets.deleteSecret(key);
      if (changed) await this.writeOAuthIndex(secrets, index!);
    });
    this.pendingBundledRemovals.set(removal, work);
    void work.then(() => {
      if (this.pendingBundledRemovals.get(removal) === work) this.pendingBundledRemovals.delete(removal);
    });
    return work;
  }

  private retireBundledSession(stableId: string): string {
    const { session } = this.bundledOAuthSessions.get(stableId)!;
    session.dispose();
    this.bundledOAuthSessions.delete(stableId);
    for (const [serverId, mapped] of [...this.bundledOAuthRuntimeIds]) {
      if (mapped === stableId) this.bundledOAuthRuntimeIds.delete(serverId);
    }
    return session.credentialKey;
  }

  packageTransactionsSettled(): void {
    for (const kind of [...this.deferredBundledReconciles]) void this.reconcileBundledCredentials(kind);
  }

  private packageRefFromApproval(packageId: string): BundledPackageRef {
    const separator = packageId.indexOf("/");
    const kind = packageId.slice(0, separator);
    const name = packageId.slice(separator + 1);
    if ((kind !== "plugin" && kind !== "agent-plugin") || !name) {
      throw new Error("bundled MCP approval has an invalid package identity");
    }
    return { kind, name };
  }

  bundledCredentialRefForConfigId(id: string): { packageRef: BundledPackageRef; server: string } | null {
    const owner = this.bundledOwners.get(id);
    if (owner && this.activeBundledServerIds.has(id)) {
      return { packageRef: this.packageRefFromApproval(owner.pluginId.startsWith("agent-plugin/") ? owner.pluginId : `plugin/${owner.pluginId}`), server: owner.localId };
    }
    return parseBundledConfigId(id);
  }

  bundledServerIdsForPlugin(pluginId: string): readonly string[] {
    return Object.freeze(
      [...this.bundledOwners]
        .filter(([serverId, owner]) =>
          this.activeBundledServerIds.has(serverId) && owner.pluginId === pluginId)
        .map(([serverId]) => serverId),
    );
  }

  getBundledGenerationDegraded(
    pluginId: string,
    generationId: string,
  ): readonly BundledMcpDegradedState[] {
    return this.bundledDegraded.get(`${pluginId}\0${generationId}`) ?? [];
  }

  async loadFromConfig(): Promise<McpServerConfig[]> {
    return this.withConfigFileLock(() => this.loadFromConfigUnlocked());
  }

  private async loadFromConfigUnlocked(): Promise<McpServerConfig[]> {
    return (await this.loadConfigFile()).servers;
  }

  /** Only a parsed primary config authorizes credential cleanup; fallback or missing data does not. */
  private async loadConfigFile(): Promise<{ servers: McpServerConfig[]; loaded: boolean; primaryInvalid: boolean }> {
    const bakPath = `${this.configPath}.bak`;
    // Read legacy backups without creating new secret-bearing backups on save.
    const candidatePaths = [
      ...(existsSync(this.configPath) ? [this.configPath] : []),
      ...(existsSync(bakPath) ? [bakPath] : []),
    ];

    if (candidatePaths.length === 0) {
      log.info("MCP server config file missing: %s", this.configPath);
      return { servers: [], loaded: false, primaryInvalid: false };
    }

    // Refuse writes over existing malformed user configuration.
    let primaryInvalid = false;
    for (const path of candidatePaths) {
      try {
        const raw = await readFile(path, "utf-8");
        if (!raw.trim()) {
          if (path === candidatePaths[candidatePaths.length - 1]) {
            return { servers: [], loaded: false, primaryInvalid };
          }
      log.warn(`Empty config file detected, falling back to next candidate: ${path}`);
          continue;
        }
        const parsed = JSON.parse(raw) as unknown;
        const listed = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { servers?: unknown }).servers : undefined;
        // Wrong top-level shapes are configuration errors, never empty server lists.
        if (!Array.isArray(listed)) throw new Error(`MCP server config ${path} must be an object with a "servers" array`);
        const servers = (listed as McpServerConfig[]).map((s) => {
          if (!s.transport) {
            (s as Record<string, unknown>).transport = (s as Record<string, unknown>).command ? "stdio" : "http";
          }
          return s;
        });
      log.info(`${servers.length} MCP server configs loaded`);
        return { servers, loaded: path === this.configPath, primaryInvalid };
      } catch (err) {
        if (path === this.configPath) primaryInvalid = true;
      log.error({ err }, "Config file parse failed");
      }
    }

    return { servers: [], loaded: false, primaryInvalid };
  }

  /** Existing unreadable configuration blocks writes to preserve user contents. */
  private async loadConfigForWrite(): Promise<McpServerConfig[]> {
    const { servers, primaryInvalid } = await this.loadConfigFile();
    if (primaryInvalid) {
      throw new McpConfigFileInvalidError(`[mcp-manager] ${t("be_mcpManager.configFileInvalid", { path: this.configPath })}`);
    }
    return servers;
  }

  async connectAll(): Promise<{ connected: string[]; failed: Array<{ id: string; error: string }> }> {
    const { servers: configs, loaded } = await this.withConfigFileLock(() => this.loadConfigFile());
    if (loaded) await this.reconcileOAuthCredentials(configs);
    else log.warn("MCP server configuration was not loaded from its file; stored authorization cleanup skipped");

    const results = await Promise.allSettled(
      configs.map((config) => this.connectServer(config).then(() => config.id)),
    );

    const connected: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        connected.push(result.value);
      } else {
        const message = errorMessage(result.reason);
        failed.push({ id: configs[i].id, error: message });
      log.warn(`Server connection failed (${configs[i].id}): %s`, message);
      }
    }

    log.info(
      `Connection result: ${connected.length} succeeded, ${failed.length} failed`,
    );
    return { connected, failed };
  }

  async connectServer(config: McpServerConfig, opts: { force?: boolean } = {}): Promise<void> {
    const epoch = this.oauthEpoch(config.id);
    const existing = this.clients.get(config.id);
    if (existing && existing.getState().status === "connected" && !opts.force) {
      log.info(`${config.id}: already connected — skipping`);
      return;
    }

    if (existing) {
      await existing.disconnect();
      this.clients.delete(config.id);
    }

    // Always overwrite external sandboxRoot with the host-derived root before constructing a client.
    const { pluginDataDir: _untrustedDataDir, bundledPayloadRoot: _untrustedPayloadRoot, ...managedConfig } =
      config.transport === "stdio" ? config : { ...config, pluginDataDir: undefined, bundledPayloadRoot: undefined };
    const connectConfig =
      managedConfig.transport === "stdio"
        ? { ...managedConfig, sandboxRoot: await this.ensureStdioSandboxRoot(config.id) }
        : managedConfig;

    const oauthSession = this.oauthSessionFor(config);
    if (epoch !== this.oauthEpoch(config.id)) {
      if (oauthSession) this.discardOAuthSession(config.id, oauthSession);
      throw new Error("MCP connection retired");
    }
    const clientFetch: typeof fetch = oauthSession ? async (input, init) => {
      try {
        return await oauthSession.fetch(input, init);
      } catch (error) {
        if (oauthSession.getStatus() === "required" || oauthSession.getStatus() === "error") {
          this.toolRegistry.unregisterByMcp(config.id);
          const activeClient = this.clients.get(config.id);
          if (activeClient?.getState().status === "connected") {
            void activeClient.disconnect().catch(() => undefined);
            this.onServerDisconnected?.(config.id);
          }
        }
        throw error;
      }
    } : this.networkFetch;
    const client = new McpClient(
      connectConfig,
      this.governance,
      this.toolRegistry,
      clientFetch,
      undefined,
      this.inputResolverFactory?.(config.id),
    );
    this.clients.set(config.id, client);
    try {
      await client.connect();
      if (epoch !== this.oauthEpoch(config.id)) {
        await client.disconnect();
        this.toolRegistry.unregisterByMcp(config.id);
        throw new Error("MCP connection retired");
      }
      if (oauthSession && oauthSession.getStatus() !== "authenticated") {
        await client.disconnect();
        this.toolRegistry.unregisterByMcp(config.id);
        throw new Error("MCP authentication required");
      }
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_connect",
        input: JSON.stringify({ serverId: config.id, transport: config.transport }),
        output: JSON.stringify({
          status: client.getState().status,
          registeredTools: client.getState().registeredTools,
        }),
      });
    } catch (err) {
      if (this.clients.get(config.id) === client) this.clients.delete(config.id);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_connect",
        input: JSON.stringify({ serverId: config.id, transport: config.transport }),
        output: errorMessage(err),
      });
      throw err;
    }
  }

  /** Create one session synchronously per id so concurrent callers cannot spend a refresh token twice. */
  private oauthSessionFor(config: McpServerConfig): McpOAuthSession | undefined {
    const previous = this.oauthSessions.get(config.id);
    if (config.transport !== "http" || config.auth !== "oauth") {
      if (previous) {
        this.oauthSessions.delete(config.id);
        previous.session.dispose();
        void this.queueOAuthIndexUpdate(config.id, undefined, previous.session.credentialKey);
      }
      return undefined;
    }
    if (!this.oauthPresentation) throw new Error("MCP authorization is unavailable");
    const fingerprint = JSON.stringify(config);
    if (previous?.fingerprint === fingerprint) return previous.session;
    const session = this.replaceOAuthSession(config, previous?.session);
    this.oauthSessions.set(config.id, { fingerprint, session });
    return session;
  }

  /** Identity changes revoke old grants; same-key successors wait for in-flight refresh persistence. */
  private replaceOAuthSession(config: McpHttpServerConfig, previous: McpOAuthSession | undefined, after?: Promise<void>): McpOAuthSession {
    if (!this.oauthPresentation) throw new Error("MCP authorization is unavailable");
    const dependencies = { ...this.oauthPresentation, networkFetch: this.networkFetch };
    const key = tryMcpOAuthCredentialKey(config);
    if (previous && key !== undefined && previous.credentialKey === key) {
      const session = new McpOAuthSession(config, dependencies, { after: previous.handOff(), initialStatus: previous.getStatus() });
      void this.queueOAuthIndexUpdate(config.id, session.credentialKey);
      return session;
    }
    const session = new McpOAuthSession(config, dependencies, after ? { after } : {});
    previous?.dispose();
    void this.queueOAuthIndexUpdate(config.id, session.credentialKey, previous?.credentialKey);
    return session;
  }

  /** Serialized work on the credential store, so index updates and deletions never interleave. */
  private queueOAuthStoreWork(work: (secrets: McpOAuthSecrets) => Promise<void>): Promise<void> {
    const secrets = this.oauthPresentation?.secrets;
    if (!secrets) return Promise.resolve();
    const next = this.oauthStoreWork.then(() => work(secrets)).catch((error: unknown) => {
      log.warn("MCP authorization credential index update failed: %s", errorMessage(error));
    });
    this.oauthStoreWork = next;
    return next;
  }

  /** Unreadable indexes authorize no deletion and rebuild only from successfully loaded config keys. */
  private readOAuthIndex(secrets: McpOAuthSecrets): Record<string, string> | undefined {
    let parsed: unknown;
    try {
      const raw = secrets.getSecret(OAUTH_CREDENTIAL_INDEX_KEY);
      if (!raw) return {};
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string" || !value.startsWith("mcp.oauth."))) {
      if (!this.oauthIndexUnreadable) {
        log.error("MCP authorization credential index is unreadable; stored sign-in cleanup is paused until it is rebuilt");
      }
      this.oauthIndexUnreadable = true;
      return undefined;
    }
    return { ...(parsed as Record<string, string>) };
  }

  private async writeOAuthIndex(secrets: McpOAuthSecrets, index: Record<string, string>): Promise<void> {
    await secrets.setSecret(OAUTH_CREDENTIAL_INDEX_KEY, JSON.stringify(index));
  }

  /** Index credential keys because the encrypted store cannot enumerate records after identity changes. */
  private queueOAuthIndexUpdate(serverId: string, key: string | undefined, retiredKey?: string): Promise<void> {
    return this.queueOAuthStoreWork(async (secrets) => {
      if (retiredKey) await secrets.deleteSecret(retiredKey);
      if (!secrets.canStoreEncrypted()) return;
      const index = this.readOAuthIndex(secrets);
      if (!index) return;
      const recorded = index[serverId];
      if (recorded === key) return;
      if (recorded) await secrets.deleteSecret(recorded);
      if (key) index[serverId] = key;
      else delete index[serverId];
      await this.writeOAuthIndex(secrets, index);
    });
  }

  /** Clean external grants only after verified config load; rebuild unreadable indexes without deleting. */
  private reconcileOAuthCredentials(configs: readonly McpServerConfig[]): Promise<void> {
    const desired = new Map<string, string>();
    for (const config of configs) {
      if (config.transport !== "http" || config.auth !== "oauth") continue;
      const key = tryMcpOAuthCredentialKey(config);
      if (key) desired.set(config.id, key);
    }
    return this.queueOAuthStoreWork(async (secrets) => {
      if (!secrets.canStoreEncrypted()) return;
      const index = this.readOAuthIndex(secrets);
      if (!index) {
        const rebuilt = Object.fromEntries(desired);
        for (const [stableId, { session }] of this.bundledOAuthSessions) rebuilt[stableId] = session.credentialKey;
        // Index bundled grants only when their source can vouch for the installed set.
        for (const [kind, source] of this.bundledCredentialSources) {
          for (const [stableId, key] of (await this.bundledInventory(kind, source))?.declared ?? []) rebuilt[stableId] ??= key;
        }
        await this.writeOAuthIndex(secrets, rebuilt);
        this.oauthIndexUnreadable = false;
        log.error("MCP authorization credential index was rebuilt from the loaded configuration; earlier orphaned sign-ins were not deleted");
        return;
      }
      let changed = false;
      for (const [serverId, key] of Object.entries(index)) {
        if (serverId.startsWith("bundled:") || desired.get(serverId) === key) continue;
        await secrets.deleteSecret(key);
        delete index[serverId];
        changed = true;
      }
      for (const [serverId, key] of desired) {
        if (index[serverId] === key) continue;
        index[serverId] = key;
        changed = true;
      }
      if (changed) await this.writeOAuthIndex(secrets, index);
    });
  }

  /** Defer unverifiable inventories or open transactions atomically so a settle signal cannot be missed. */
  private async bundledInventory(kind: BundledPackageRef["kind"], source: BundledCredentialSource): Promise<{
    installed: ReadonlySet<string>; listed: ReadonlySet<string>; declared: Map<string, string>;
  } | undefined> {
    const defer = (): undefined => {
      this.deferredBundledReconciles.add(kind);
      return undefined;
    };
    try {
      if (!this.packageTransactionsIdle()) return defer();
      const installed = await source.installedPackages();
      if (!installed || !this.packageTransactionsIdle()) return defer();
      const listed = new Set<string>();
      const declared = new Map<string, string>();
      for (const item of source.list()) {
        listed.add(item.packageName);
        if (item.transport !== "http" || item.auth !== "oauth" || !item.url) continue;
        const id = bundledConfigId({ kind, name: item.packageName }, item.serverName);
        const key = tryMcpOAuthCredentialKey({ id, transport: "http", url: item.url, auth: "oauth", ...(item.oauth ? { oauth: item.oauth } : {}) });
        if (key) declared.set(id, key);
      }
      return { installed, listed, declared };
    } catch (error) {
      log.warn("Bundled MCP package list unavailable; stored authorization cleanup skipped: %s", errorMessage(error));
      return defer();
    }
  }

  /** Prune only verified removals or dropped declarations; disabled installed packages retain grants.
     * Recheck transaction state when queued reconciliation runs and dispose sessions with retired grants. */
  private reconcileBundledOAuthCredentials(kind: BundledPackageRef["kind"], source: BundledCredentialSource): Promise<void> {
    return this.queueOAuthStoreWork(async (secrets) => {
      const inventory = await this.bundledInventory(kind, source);
      if (!inventory) return;
      this.deferredBundledReconciles.delete(kind);
      for (const stableId of [...this.bundledOAuthSessions.keys()]) {
        if (this.bundledGrantRetired(stableId, kind, inventory)) this.retireBundledSession(stableId);
      }
      if (!secrets.canStoreEncrypted()) return;
      const index = this.readOAuthIndex(secrets);
      if (!index) return;
      let changed = false;
      for (const [serverId, key] of Object.entries(index)) {
        if (!this.bundledGrantRetired(serverId, kind, inventory)) continue;
        await secrets.deleteSecret(key);
        delete index[serverId];
        changed = true;
      }
      for (const [serverId, key] of inventory.declared) {
        if (index[serverId] !== undefined) continue;
        index[serverId] = key;
        changed = true;
      }
      if (changed) await this.writeOAuthIndex(secrets, index);
    });
  }

  private bundledGrantRetired(serverId: string, kind: BundledPackageRef["kind"], inventory: {
    installed: ReadonlySet<string>; listed: ReadonlySet<string>; declared: Map<string, string>;
  }): boolean {
    if (!serverId.startsWith("bundled:") || inventory.declared.has(serverId)) return false;
    let ref: ReturnType<typeof parseBundledConfigId>;
    try { ref = parseBundledConfigId(serverId); }
    catch { ref = null; }
    if (ref && ref.packageRef.kind !== kind) return false;
    return !(ref && inventory.installed.has(ref.packageRef.name) && !inventory.listed.has(ref.packageRef.name));
  }

  private discardOAuthSession(serverId: string, session: McpOAuthSession): void {
    session.dispose();
    if (this.oauthSessions.get(serverId)?.session === session) this.oauthSessions.delete(serverId);
  }

  private oauthEpoch(serverId: string): string {
    return `${this.oauthShutdownGeneration}:${this.oauthRetirements.get(serverId) ?? 0}`;
  }

  private retireOAuth(serverId: string): void {
    this.oauthRetirements.set(serverId, (this.oauthRetirements.get(serverId) ?? 0) + 1);
    this.oauthSessions.get(serverId)?.session.dispose();
  }

  private withServerLifecycleLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const operation = (this.serverLifecycleLocks.get(serverId) ?? Promise.resolve()).then(fn);
    const settled = operation.then(() => undefined, () => undefined);
    this.serverLifecycleLocks.set(serverId, settled);
    void settled.then(() => {
      if (this.serverLifecycleLocks.get(serverId) === settled) this.serverLifecycleLocks.delete(serverId);
    });
    return operation;
  }

  /** Browser interaction is reserved for the explicit settings action. */
  authenticate(serverId: string): Promise<McpAuthenticationResult> {
    const pending = this.authentications.get(serverId);
    if (pending) return pending;
    const bundledId = this.bundledOAuthStableId(serverId);
    const operation = (bundledId ? this.authenticateBundled(bundledId) : this.authenticateServer(serverId)).finally(() => {
      if (this.authentications.get(serverId) === operation) this.authentications.delete(serverId);
    });
    this.authentications.set(serverId, operation);
    return operation;
  }

  private async authenticateServer(serverId: string): Promise<McpAuthenticationResult> {
    const epoch = this.oauthEpoch(serverId);
    try {
      const config = (await this.loadFromConfig()).find((item) => item.id === serverId);
      if (!config || config.transport !== "http" || config.auth !== "oauth") return { connected: false, errorCode: "mcp-auth-failed" };
      if (!this.governance.validateServer(config).valid) return { connected: false, errorCode: "mcp-auth-failed" };
      if (epoch !== this.oauthEpoch(serverId)) return { connected: false, errorCode: "mcp-auth-failed" };
      const session = this.oauthSessionFor(config)!;
      await session.authenticate();
      return await this.withConfigLock(() => this.withServerLifecycleLock(serverId, async (): Promise<McpAuthenticationResult> => {
        const current = (await this.loadFromConfig()).find((item) => item.id === serverId);
        if (epoch !== this.oauthEpoch(serverId) || !current || JSON.stringify(current) !== JSON.stringify(config) || this.oauthSessions.get(serverId)?.session !== session) {
          this.discardOAuthSession(serverId, session);
          return { connected: false, errorCode: "mcp-auth-failed" };
        }
        await this.connectServer(current, { force: true });
        const latest = (await this.loadFromConfig()).find((item) => item.id === serverId);
        if (epoch !== this.oauthEpoch(serverId) || JSON.stringify(latest) !== JSON.stringify(current)) {
          await this.clients.get(serverId)?.disconnect();
          this.clients.delete(serverId);
          this.toolRegistry.unregisterByMcp(serverId);
          return { connected: false, errorCode: "mcp-auth-failed" };
        }
        return { connected: true };
      }));
    } catch (error) {
      const status = this.oauthSessions.get(serverId)?.session.getStatus();
      if (status === "required" || status === "error") {
        const client = this.clients.get(serverId);
        const connected = client?.getState().status === "connected";
        this.toolRegistry.unregisterByMcp(serverId);
        await client?.disconnect().catch(() => undefined);
        if (connected) this.onServerDisconnected?.(serverId);
      }
      return { connected: false, errorCode: oauthErrorCode(error, status) };
    }
  }

  private bundledOAuthStableId(serverId: string): string | undefined {
    if (this.bundledOAuthSessions.has(serverId)) return serverId;
    return this.bundledOAuthRuntimeIds.get(serverId);
  }

  private bundledOAuthSessionFor(projection: PreparedPluginMcpProjection): McpOAuthSession {
    if (projection.config.transport !== "http") throw new Error("bundled MCP OAuth requires an HTTP server");
    const bundled = projection.approval.bundled;
    if (!bundled) throw new Error("bundled MCP approval is missing its package identity");
    if (!this.oauthPresentation) throw new Error("MCP authorization is unavailable");
    // Package/server keys survive generation updates.
    const packageRef = this.packageRefFromApproval(bundled.package);
    const stableId = bundledConfigId(packageRef, bundled.server);
    this.bundledOAuthRuntimeIds.set(projection.serverId, stableId);
    const config: McpHttpServerConfig = { ...projection.config, id: stableId };
    const fingerprint = JSON.stringify(config);
    const previous = this.bundledOAuthSessions.get(stableId);
    if (previous?.fingerprint === fingerprint) return previous.session;
    // Reinstalls wait for removal revocations before reading credentials.
    const removal = this.pendingBundledRemovals.get(`${packageRef.kind}/${packageRef.name}`);
    const session = this.replaceOAuthSession(config, previous?.session, removal);
    this.bundledOAuthSessions.set(stableId, { fingerprint, session });
    return session;
  }

  private async authenticateBundled(stableId: string): Promise<McpAuthenticationResult> {
    const entry = this.bundledOAuthSessions.get(stableId);
    const ref = parseBundledConfigId(stableId);
    const source = ref ? this.bundledCredentialSources.get(ref.packageRef.kind) : undefined;
    if (!entry || !ref || !source) return { connected: false, errorCode: "mcp-auth-failed" };
    try {
      await entry.session.authenticate();
    } catch (error) {
      return { connected: false, errorCode: oauthErrorCode(error, entry.session.getStatus()) };
    }
    const isThisServer = (serverId: string): boolean => this.bundledOAuthRuntimeIds.get(serverId) === stableId;
    for (const serverId of [...this.activeBundledServerIds]) {
      if (isThisServer(serverId)) await this.disconnectBundledServer(serverId);
    }
    try { await source.reconnect(ref.packageRef.name, ref.server); }
    catch { return { connected: false, errorCode: "mcp-auth-failed" }; }
    const connected = [...this.activeBundledServerIds].some(isThisServer);
    return connected ? { connected: true } : { connected: false, errorCode: "mcp-auth-failed" };
  }

  async prepareBundledGeneration(
    owner: { pluginId: string; generationId: string },
    projections: readonly PreparedPluginMcpProjection[],
    trust: PluginMcpTrustStore,
  ): Promise<PreparedBundledMcpGeneration> {
    await this.retryPendingBundledCandidateCleanup("before bundled preparation");
    const predecessorServerIds = [...this.bundledOwners]
      .filter(([serverId, current]) =>
        this.activeBundledServerIds.has(serverId) && current.pluginId === owner.pluginId)
      .map(([serverId]) => serverId);
    const predecessorSet = new Set(predecessorServerIds);
    const predecessorToolNames = this.toolRegistry.listAll()
      .filter((tool) => tool.mcpServerId && predecessorSet.has(tool.mcpServerId))
      .map((tool) => tool.name);
    const records: PreparedBundledMcpRecord[] = [];
    const degraded: BundledMcpDegradedState[] = [];
    try {
      for (const inputProjection of projections) {
        const policyApproval = this.governance.policyFingerprintApproval(inputProjection.approval);
        const projection = policyApproval
          ? { ...inputProjection, approval: policyApproval }
          : inputProjection;
        if (!projection.owner.activationId) {
          throw new Error(`bundled MCP activation identity is missing for '${projection.serverId}'`);
        }
        if (
          projection.owner.pluginId !== owner.pluginId ||
          projection.owner.activationId !== owner.generationId
        ) {
          throw new Error(`bundled MCP owner mismatch for '${projection.serverId}'`);
        }
        if (!policyApproval && !trust.isApproved(projection)) continue;
        if (!this.governance.isRuntimeApprovalAdmitted(projection.approval)) {
          degraded.push(Object.freeze({ pluginId: owner.pluginId, generationId: owner.generationId,
            localId: projection.owner.localId, code: "blocked-by-policy", message: "runtime approval not admitted by policy",
            retryable: false, lastAttemptAt: new Date().toISOString() }));
          continue;
        }
        let oauthSession: McpOAuthSession | undefined;
        if (projection.config.auth === "oauth") {
          oauthSession = this.bundledOAuthSessionFor(projection);
          const authStatus = oauthSession.getStatus();
          // Only explicit settings authentication may open a browser; preparation cannot.
          if (authStatus !== "authenticated" && authStatus !== "insufficient_scope") {
            degraded.push(Object.freeze({ pluginId: owner.pluginId, generationId: owner.generationId,
              localId: projection.owner.localId, code: "credential_required",
              message: "Authenticate this server in MCP settings",
              retryable: true, lastAttemptAt: new Date().toISOString() }));
            continue;
          }
        }
        let credential: string | null = null;
        if (projection.config.auth === "api-key") {
          if (!this.bundledSecrets) throw new Error("bundled MCP credential store is unavailable");
          const bundled = projection.approval.bundled;
          if (!bundled) throw new Error("bundled MCP approval is missing its package identity");
          const packageRef = this.packageRefFromApproval(bundled.package);
          const stored = this.bundledSecrets.getSecret(bundledCredentialKey(packageRef, bundled.server));
          const bound = packageRef.kind === "agent-plugin" ? readBoundBundledCredential(stored) : null;
          credential = packageRef.kind === "agent-plugin"
            ? (bound?.declaration === bundledCredentialDeclaration(projection.config) ? bound.secret : null)
            : stored;
          if (!credential) {
            degraded.push(Object.freeze({ pluginId: owner.pluginId, generationId: owner.generationId,
              localId: projection.owner.localId, code: "credential_required", message: "credential required",
              retryable: true, lastAttemptAt: new Date().toISOString() }));
            continue;
          }
        }
        const existing = this.clients.get(projection.serverId);
        if (existing && this.activeBundledServerIds.has(projection.serverId)) {
          const baseTools = this.bundledToolSnapshots.get(projection.serverId);
          if (!baseTools) {
            throw new Error(`bundled MCP tool snapshot is missing for '${projection.serverId}'`);
          }
          const tools = baseTools.map((tool) => this.bindBundledTool(tool, projection.owner));
          records.push({ projection, client: existing, baseTools, tools: Object.freeze(tools), reused: true });
          continue;
        }

        const scopedGovernance = this.governance.scopedRuntimeApproval(projection.approval);
        const stagingRegistry = new ToolRegistry();
        const connectConfig = projection.config.transport === "stdio"
          ? { ...projection.config, ...(credential ? { apiKey: credential } : {}), sandboxRoot: await this.ensureStdioSandboxRoot(projection.serverId) }
          : { ...projection.config, ...(credential ? { apiKey: credential } : {}) };
        const client = new McpClient(
          connectConfig,
          scopedGovernance,
          stagingRegistry,
          oauthSession ? oauthSession.fetch : this.networkFetch,
          undefined,
          this.inputResolverFactory?.(projection.serverId),
        );
        try {
          await client.connect();
        } catch (error) {
          try {
            await this.disconnectBundledCandidate(client, projection.serverId, "failed preparation");
          } catch (cleanupError) {
            throw new AggregateError(
              [
                error instanceof Error ? error : new Error(String(error)),
                cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
              ],
              `bundled MCP candidate connection and cleanup failed (${projection.serverId})`,
            );
          }
          const message = scrubSecrets(errorMessage(error));
          degraded.push(Object.freeze({
            pluginId: owner.pluginId,
            generationId: owner.generationId,
            localId: projection.owner.localId,
            code: "connection_failed",
            message,
            retryable: true,
            lastAttemptAt: new Date().toISOString(),
          }));
          log.warn(`bundled MCP candidate degraded (${projection.serverId}): %s`, message);
          continue;
        }
        const baseTools = Object.freeze(stagingRegistry.listAll());
        const tools = baseTools.map((tool) => this.bindBundledTool(tool, projection.owner));
        records.push({ projection, client, baseTools, tools: Object.freeze(tools), reused: false });
      }
      const replacementTools = records.flatMap((record) => [...record.tools]);
      const governancePublication = this.governance.prepareRuntimeApprovals(
        predecessorServerIds,
        records.map((record) => record.projection.approval),
      );
      // Reserve the shared registry last so later preparation failure cannot strand reservations.
      const registryReplacement = this.toolRegistry.reserveMcpReplacement(
        predecessorServerIds,
        replacementTools,
      );
      return {
        pluginId: owner.pluginId,
        generationId: owner.generationId,
        predecessorServerIds: Object.freeze(predecessorServerIds),
        predecessorToolNames: Object.freeze(predecessorToolNames),
        records: Object.freeze(records),
        degraded: Object.freeze(degraded),
        registryReplacement,
        governancePublication,
        published: false,
      };
    } catch (error) {
      const cleanupResults = await Promise.allSettled(records
        .filter((record) => !record.reused)
        .map((record) => this.disconnectBundledCandidate(
          record.client,
          record.projection.serverId,
          "aborted preparation",
        )));
      const cleanupErrors = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) =>
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [
            error instanceof Error ? error : new Error(String(error)),
            ...cleanupErrors,
          ],
          `bundled MCP preparation and candidate cleanup failed (${owner.pluginId})`,
        );
      }
      throw error;
    }
  }

  publishBundledGeneration(prepared: PreparedBundledMcpGeneration): void {
    if (prepared.published) return;
    prepared.governancePublication.assertAdmitted();
    prepared.registryReplacement.publish();
    prepared.governancePublication.publish();
    for (const serverId of prepared.predecessorServerIds) this.activeBundledServerIds.delete(serverId);
    for (const record of prepared.records) {
      const serverId = record.projection.serverId;
      this.clients.set(serverId, record.client);
      this.bundledOwners.set(serverId, record.projection.owner);
      const bundled = record.projection.approval.bundled;
      if (bundled) this.bundledStableIds.set(serverId, bundledConfigId(this.packageRefFromApproval(bundled.package), bundled.server));
      this.bundledToolSnapshots.set(serverId, record.baseTools);
      this.activeBundledServerIds.add(serverId);
    }
    const degradedKey = `${prepared.pluginId}\0${prepared.generationId}`;
    if (prepared.degraded.length > 0) this.bundledDegraded.set(degradedKey, prepared.degraded);
    else this.bundledDegraded.delete(degradedKey);
    prepared.published = true;
  }

  async discardBundledGeneration(prepared: PreparedBundledMcpGeneration): Promise<void> {
    if (prepared.published) return;
    prepared.registryReplacement.cancel();
    await Promise.all(
      prepared.records
        .filter((record) => !record.reused)
        .map((record) => this.disconnectBundledCandidate(
          record.client,
          record.projection.serverId,
          "discarded preparation",
        )),
    );
  }

  private async disconnectBundledCandidate(
    client: McpClient,
    serverId: string,
    context: string,
  ): Promise<void> {
    const pending = this.pendingBundledCandidateCleanup.get(client) ?? { serverId, context };
    this.pendingBundledCandidateCleanup.set(client, pending);
    try {
      await client.disconnect();
      this.pendingBundledCandidateCleanup.delete(client);
    } catch (error) {
      log.warn(
        `bundled MCP candidate disconnect failed (${pending.serverId}, ${pending.context}): %s`,
        scrubSecrets(errorMessage(error)),
      );
      throw new Error(
        `bundled MCP candidate cleanup remains pending (${pending.serverId}, ${context})`,
        { cause: error },
      );
    }
  }

  private async retryPendingBundledCandidateCleanup(context: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.pendingBundledCandidateCleanup].map(([client, pending]) =>
        this.disconnectBundledCandidate(client, pending.serverId, context)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (errors.length > 0) {
      throw new AggregateError(errors, "bundled MCP candidate cleanup remains pending");
    }
  }

  /** Tear down only omitted clients from this generation; predecessors stay live until leases drain. */
  async retirePublishedMcpReplacement(prepared: PreparedBundledMcpGeneration): Promise<void> {
    if (!prepared.published) throw new Error("bundled MCP replacement is not published");
    const replacementIds = new Set(prepared.records.map((record) => record.projection.serverId));
    const errors: Error[] = [];
    for (const serverId of prepared.predecessorServerIds) {
      if (replacementIds.has(serverId)) continue;
      const owner = this.bundledOwners.get(serverId);
      if (!owner || owner.activationId !== prepared.generationId) continue;
      try { await this.disconnectBundledServer(serverId); } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "bundled MCP predecessor retirement failed");
  }

  async disconnectBundledGeneration(pluginId: string, generationId: string): Promise<void> {
    const ids = [...this.bundledOwners]
      .filter(([, owner]) => owner.pluginId === pluginId &&
        owner.activationId === generationId)
      .map(([serverId]) => serverId);
    for (const serverId of ids) await this.disconnectBundledServer(serverId);
    this.bundledDegraded.delete(`${pluginId}\0${generationId}`);
  }

  async handlePolicyWithdrawal(serverIds: readonly string[]): Promise<void> {
    for (const serverId of serverIds) {
      const owner = this.bundledOwners.get(serverId);
      if (!owner) {
        await this.killSwitch(serverId);
        continue;
      }
      const key = `${owner.pluginId}\0${owner.activationId}`;
      await this.disconnectBundledServer(serverId);
      const remaining = (this.bundledDegraded.get(key) ?? []).filter((state) => state.localId !== owner.localId);
      this.bundledDegraded.set(key, Object.freeze([...remaining, Object.freeze({
        pluginId: owner.pluginId, generationId: owner.activationId, localId: owner.localId,
        code: "blocked-by-policy" as const, message: "runtime approval not admitted by policy",
        retryable: false, lastAttemptAt: new Date().toISOString(),
      })]));
    }
  }

  private async disconnectBundledServer(serverId: string): Promise<void> {
    const wasActive = this.activeBundledServerIds.delete(serverId);
    const client = this.clients.get(serverId);
    let disconnectError: Error | undefined;
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        disconnectError = error instanceof Error ? error : new Error(String(error));
        log.warn(`bundled MCP disconnect failed (${serverId}): %s`, disconnectError.message);
      }
    }
    this.clients.delete(serverId);
    this.bundledOwners.delete(serverId);
    this.bundledStableIds.delete(serverId);
    this.bundledToolSnapshots.delete(serverId);
    if (wasActive) {
      this.toolRegistry.unregisterByMcp(serverId);
      this.governance.unregisterRuntimeApproval(serverId);
    }
    try {
      this.onServerDisconnected?.(serverId);
    } catch (error) {
      disconnectError ??= error instanceof Error ? error : new Error(String(error));
    }
    if (disconnectError) throw disconnectError;
  }

  async disconnectAll(): Promise<void> {
    this.oauthShutdownGeneration++;
    for (const { session } of this.oauthSessions.values()) session.dispose();
    for (const { session } of this.bundledOAuthSessions.values()) session.dispose();
    await Promise.all(this.serverLifecycleLocks.values());
    // Drain queued credential writes before closing the store.
    await this.oauthStoreWork;
    return this.disconnectAllLocked();
  }

  private async disconnectAllLocked(): Promise<void> {
    this.oauthSessions.clear();
    this.bundledOAuthSessions.clear();
    this.bundledOAuthRuntimeIds.clear();
    let pendingCleanupError: Error | undefined;
    try {
      await this.retryPendingBundledCandidateCleanup("manager shutdown");
    } catch (error) {
      pendingCleanupError = error instanceof Error ? error : new Error(String(error));
    }
    const ids = Array.from(this.clients.keys());
    const promises: Promise<void>[] = [];
    for (const [id, client] of this.clients) {
      promises.push(
        client.disconnect().catch((err) => {
      log.error(`${id} shutdown failed: %s`, err);
        }),
      );
    }
    await Promise.all(promises);
    this.clients.clear();
    for (const id of this.bundledOwners.keys()) this.governance.unregisterRuntimeApproval?.(id);
    this.bundledOwners.clear();
    this.bundledStableIds.clear();
    this.activeBundledServerIds.clear();
    this.bundledDegraded.clear();
    // Notify after teardown; shutdown notification is best-effort.
    for (const id of ids) {
      this.onServerDisconnected?.(id);
    }
    log.info("All MCP servers disconnected");
    if (pendingCleanupError) throw pendingCleanupError;
  }

  /** Derive a private per-server write root from a safe single-segment id.
     * Root creation failure refuses connection without a permissive fallback. */
  private async ensureStdioSandboxRoot(serverId: string): Promise<string> {
    // Remove separators and leading dots so ids cannot escape or alias the namespace root.
    const safeId = serverId
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^\.+/, "");
    if (safeId.length === 0) {
      throw new Error(
        `[mcp-manager] cannot derive a sandbox root for server id '${serverId}' (empty after sanitization)`,
      );
    }
    const root = join(aveHome(), "mcp", safeId, "sandbox");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  /** Immediate teardown removes tools and rejects in-flight requests. */
  async killSwitch(serverId: string): Promise<void> {
    this.retireOAuth(serverId);
    return this.withServerLifecycleLock(serverId, () => this.killServer(serverId));
  }

  private async killServer(serverId: string): Promise<void> {
    log.warn(`Kill switch executing: ${serverId}`);
    this.oauthSessions.get(serverId)?.session.dispose();
    this.oauthSessions.delete(serverId);

    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverId);
    }

    this.toolRegistry.unregisterByMcp(serverId);
    this.activeBundledServerIds.delete(serverId);
    this.bundledOwners.delete(serverId);
    this.bundledStableIds.delete(serverId);
    this.governance.unregisterRuntimeApproval?.(serverId);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "mcp-manager",
      type: "kill_switch",
      input: JSON.stringify({ serverId }),
    });

    this.onServerDisconnected?.(serverId);

    log.warn(`Kill switch completed: ${serverId} — all tools unregistered`);
  }

  listServers(): McpServerState[] {
    const states = Array.from(this.clients.entries())
      .filter(([serverId]) => !this.bundledOwners.has(serverId) || this.activeBundledServerIds.has(serverId))
      .map(([serverId, client]) => this.withAuthState(serverId, client.getState()));
    for (const serverId of this.oauthSessions.keys()) {
      if (!this.clients.has(serverId)) states.push(this.withAuthState(serverId, { id: serverId, status: "disconnected", registeredTools: [] }));
    }
    const running = new Set(states.flatMap((state) => {
      const stableId = this.bundledOAuthStableId(state.id);
      return stableId ? [stableId] : [];
    }));
    for (const stableId of this.bundledOAuthSessions.keys()) {
      if (!running.has(stableId)) states.push(this.withAuthState(stableId, { id: stableId, status: "disconnected", registeredTools: [] }));
    }
    return states;
  }

  private oauthSessionForState(serverId: string): McpOAuthSession | undefined {
    const external = this.oauthSessions.get(serverId)?.session;
    if (external) return external;
    const stableId = this.bundledOAuthStableId(serverId);
    return stableId ? this.bundledOAuthSessions.get(stableId)?.session : undefined;
  }

  private withAuthState(serverId: string, state: McpServerState): McpServerState {
    const session = this.oauthSessionForState(serverId);
    const authStatus = session?.getStatus();
    if (!session || !authStatus) return state;
    const authError = this.oauthIndexUnreadable ? "mcp-auth-index-unreadable" as const : undefined;
    if (authStatus === "required" || authStatus === "error") {
      return { id: serverId, status: "disconnected", registeredTools: [], authStatus, ...(authError ? { authError } : {}) };
    }
    return { ...state, authStatus, ...(authError ? { authError } : {}) };
  }

  getServerState(serverId: string): McpServerState | undefined {
    if (this.bundledOwners.has(serverId) && !this.activeBundledServerIds.has(serverId)) return undefined;
    const state = this.clients.get(serverId)?.getState();
    if (state) return this.withAuthState(serverId, state);
    if (this.oauthSessions.has(serverId) || this.bundledOAuthSessions.has(serverId)) {
      return this.withAuthState(serverId, { id: serverId, status: "disconnected", registeredTools: [] });
    }
    return undefined;
  }

  /** Read card HTML with resource-owned CSP and permissions, never tool-result policy. */
  async readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverNotFound", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.readResource(uri));
  }

  /** Resolve server-local names through governance; registry mcpServerId, not namespacing, proves ownership. */
  namespacedToolName(serverId: string, toolName: string): string {
    return this.governance.applyToolNamespace(serverId, toolName);
  }

  async getConfigs(): Promise<McpServerConfigDto[]> {
    const configs = await this.loadFromConfig();
    const bundled: McpServerConfigDto[] = [];
    for (const [kind, source] of this.bundledCredentialSources) {
      for (const declaration of source.list()) {
        const packageRef = { kind, name: declaration.packageName };
        const stableId = bundledConfigId(packageRef, declaration.serverName);
        const runtimeId = [...this.bundledStableIds].find(([serverId, candidate]) =>
          this.activeBundledServerIds.has(serverId) && candidate === stableId)?.[0];
        const id = runtimeId ?? stableId;
        const identity = { kind, name: declaration.packageName, server: declaration.serverName };
        if (declaration.transport === "stdio") {
          if (!declaration.command) throw new Error("bundled MCP stdio declaration has no command");
          bundled.push({ id, transport: "stdio", command: declaration.command, auth: declaration.auth,
            apiKeyEnv: declaration.apiKeyEnv, bundled: identity });
        } else {
          if (!declaration.url) throw new Error("bundled MCP HTTP declaration has no URL");
          bundled.push({ id, transport: "http", url: declaration.url, auth: declaration.auth,
            apiKeyHeader: declaration.apiKeyHeader, bundled: identity });
        }
      }
    }
    return [...configs.map((config) => this.toConfigDto(config)), ...bundled];
  }

  /** Studio-only projection; ordinary settings keep arguments and environment values write-only. */
  async getStudioConnectorSource(serverId: string): Promise<{ spec: McpServerConfigDto; args: string[]; env: Record<string, string> }> {
    const config = (await this.loadFromConfig()).find((item) => item.id === serverId);
    if (!config) {
      const ref = this.bundledCredentialRefForConfigId(serverId);
      const declaration = ref && this.bundledCredentialSources.get(ref.packageRef.kind)?.list().find((item) =>
        item.packageName === ref.packageRef.name && item.serverName === ref.server);
      const spec = declaration && (await this.getConfigs()).find((item) => item.id === serverId);
      if (!declaration || !spec) throw new Error(`Configured connector ${serverId} does not exist`);
      const args = [...(declaration.args ?? [])];
      const env = { ...(declaration.env ?? {}) };
      const credential = ref ? this.bundledStudioCredential(ref.packageRef, ref.server) : null;
      if (credential && declaration.apiKeyEnv && env[declaration.apiKeyEnv] === credential) delete env[declaration.apiKeyEnv];
      if ((await this.getStudioStoredCredentialValues()).some((key) => containsStoredCredential({ spec, args, env }, key))) {
        throw new Error("Connector arguments or environment contain its stored credential");
      }
      return { spec, args, env };
    }
    if (config.transport !== "stdio" && config.transport !== "http") throw new Error("Connector transport is not portable");
    if (config.apiKey && config.auth !== "api-key") throw new Error("Connector stored credential needs an API key declaration");
    if (config.headers && Object.keys(config.headers).length) throw new Error("Connector custom headers cannot be copied by Studio");
    const spec = this.toConfigDto(config);
    const args = config.transport === "stdio" ? [...(config.args ?? [])] : [];
    const env = config.transport === "stdio" ? { ...(config.env ?? {}) } : {};
    if (config.apiKey && config.transport === "stdio" && config.apiKeyEnv && env[config.apiKeyEnv] === config.apiKey) {
      delete env[config.apiKeyEnv];
    }
    if ((await this.getStudioStoredCredentialValues()).some((key) => containsStoredCredential({ spec, args, env }, key))) {
      throw new Error("Connector arguments or environment contain its stored credential");
    }
    return { spec, args, env };
  }

  private bundledStudioCredential(packageRef: BundledPackageRef, server: string): string | null {
    const declaration = this.bundledCredentialSources.get(packageRef.kind)?.list().find((item) =>
      item.packageName === packageRef.name && item.serverName === server);
    if (!declaration || declaration.auth !== "api-key" || !this.bundledSecrets) return null;
    const stored = this.bundledSecrets.getSecret(bundledCredentialKey(packageRef, server));
    if (packageRef.kind !== "agent-plugin") return stored;
    const bound = readBoundBundledCredential(stored);
    return bound?.declaration === bundledCredentialDeclaration(declaration) ? bound.secret : null;
  }

  async getStudioStoredCredentialValues(): Promise<string[]> {
    const keys = (await this.loadFromConfig()).flatMap((config) => config.apiKey ? [config.apiKey] : []);
    for (const [kind, source] of this.bundledCredentialSources) for (const declaration of source.list()) {
      const key = this.bundledStudioCredential({ kind, name: declaration.packageName }, declaration.serverName);
      if (key) keys.push(key);
    }
    return [...new Set(keys)];
  }

  async assertStudioConnectorWriteSafe(serverId: string, value: unknown): Promise<void> {
    const config = (await this.loadFromConfig()).find((item) => item.id === serverId);
    const ref = config ? null : this.bundledCredentialRefForConfigId(serverId);
    if (!config && !ref) throw new Error(`Configured connector ${serverId} does not exist`);
    if ((await this.getStudioStoredCredentialValues()).some((credential) => containsStoredCredential(value, credential))) {
      throw new Error("Connector copy contains its stored credential");
    }
  }

  async getStudioConnectorSummary(serverId: string): Promise<{ digest: string; argsCount: number; envCount: number }> {
    const { spec, args, env } = await this.getStudioConnectorSource(serverId);
    return { digest: studioConnectorSpecDigest(spec, args, env), argsCount: args.length, envCount: Object.keys(env).length };
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /** Serialize additions, persist before connecting, and reject duplicate ids. */
  validateConfig(config: McpServerConfig): ValidationResult {
    return this.governance.validateServer(config);
  }

  async addConfig(config: McpServerConfig): Promise<McpConfigMutationResult> {
    // IPC type casts do not validate runtime payloads.
    if (!config?.id || typeof config.id !== "string") {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.invalidServerId")}`);
    }
    const validTransports = ["stdio", "http"] as const;
    if (!validTransports.includes(config.transport as (typeof validTransports)[number])) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.invalidTransport", { transport: String(config.transport) })}`);
    }
    if (config.transport === "stdio" && !(config as { command?: string }).command?.trim()) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.stdioCommandRequired")}`);
    }
    if (config.transport === "http" && !(config as { url?: string }).url?.trim()) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.httpUrlRequired")}`);
    }

    const normalizedId = config.id.trim();
    if (!normalizedId) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdBlank")}`);
    }
    // Bound ids at ingestion and encoding because persisted configuration bypasses this entry point.
    if (normalizedId.length > MAX_SERVER_ID_LEN) {
      throw new Error(
        `[mcp-manager] server id exceeds ${MAX_SERVER_ID_LEN} characters`,
      );
    }
    const normalizedConfig = { ...config, id: normalizedId } as McpServerConfig;

    return this.withConfigLock(async () => {
      await this.withConfigFileLock(async () => {
        const validation = this.governance.validateServer(normalizedConfig);
        if (!validation.valid) {
          throw new Error(
            `[mcp-manager] ${t("be_mcpManager.governanceValidationFailed", { layer: String(validation.layer), reason: validation.reason })}`,
          );
        }
        const existing = await this.loadConfigForWrite();
        if (existing.some((s) => s.id === normalizedId)) {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdAlreadyExists", { id: normalizedId })}`);
        }
        const updated = [...existing, normalizedConfig];
        await this.saveConfigs(updated);
      });
      try {
        await this.connectServer(normalizedConfig);
        return { connected: true };
      } catch (err) {
        if (normalizedConfig.transport === "http" && normalizedConfig.auth === "oauth") {
          const session = this.oauthSessions.get(normalizedId)?.session;
          return { connected: false, errorCode: session?.getBlockedCode() ?? oauthErrorCode(err, session?.getStatus()) };
        }
        const warning = errorMessage(err);
      log.warn(`Connection after server add failed (${normalizedId}): %s`, err);
        return { connected: false, warning };
      }
    });
  }

  async setBundledApiKey(packageRef: BundledPackageRef, serverName: string, value: string): Promise<{ connected: boolean; warning?: string }> {
    const source = this.bundledCredentialSources.get(packageRef.kind);
    if (!source) throw new Error("bundled MCP credential source is unavailable");
    const declarations = source.list().filter((entry) => entry.packageName === packageRef.name && entry.serverName === serverName);
    const declaration = declarations[0];
    if (declarations.length !== 1 || !declaration || declaration.auth !== "api-key"
      || (declaration.transport === "stdio" && !declaration.apiKeyEnv)
      || (declaration.transport === "http" && !declaration.apiKeyHeader)) {
      throw new Error("bundled MCP server has no valid credential declaration");
    }
    if (!this.bundledSecrets) throw new Error("bundled MCP credential store is unavailable");
    const secret = validatedApiKey(value);
    await this.bundledSecrets.setSecret(bundledCredentialKey(packageRef, serverName),
      packageRef.kind === "agent-plugin" ? boundBundledCredential(bundledCredentialDeclaration(declaration), secret) : secret);
    for (const [serverId, owner] of this.bundledOwners) {
      if (this.activeBundledServerIds.has(serverId)
        && owner.pluginId === `${packageRef.kind}/${packageRef.name}` && owner.localId === serverName) {
        await this.disconnectBundledServer(serverId);
      }
    }
    try { await source.reconnect(packageRef.name, serverName); }
    catch (error) { return { connected: false, warning: scrubSecrets(errorMessage(error)) }; }
    const connected = [...this.bundledOwners].some(([serverId, owner]) => this.activeBundledServerIds.has(serverId)
      && owner.pluginId === `${packageRef.kind}/${packageRef.name}` && owner.localId === serverName);
    return connected ? { connected: true } : { connected: false, warning: "server did not connect" };
  }

  /** Drop obsolete declaration values during preparation and restore them on rollback. */
  async stageBundledCredentialDrop(packageRef: BundledPackageRef, serverName: string, expectedDeclaration?: string): Promise<() => Promise<void>> {
    if (!this.bundledSecrets) throw new Error("bundled MCP credential store is unavailable");
    const key = bundledCredentialKey(packageRef, serverName);
    const previous = this.bundledSecrets.getSecret(key);
    if (previous === null) return async () => undefined;
    if (expectedDeclaration && readBoundBundledCredential(previous)?.declaration === expectedDeclaration) return async () => undefined;
    await this.bundledSecrets.deleteSecret(key);
    return () => this.bundledSecrets!.setSecret(key, previous);
  }

  async setApiKey(serverId: string, apiKey: string): Promise<{ connected: boolean; warning?: string }> {
    const id = serverId.trim();
    if (!id) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdBlank")}`);
    }
    if (this.bundledOwners.has(id) || id.startsWith("bundled:")) {
      throw new Error("bundled MCP credentials require setBundledApiKey");
    }

    const trimmedKey = validatedApiKey(apiKey);

    let updatedConfig: McpServerConfig | undefined;

    // Validate under the file lock before persisting any config change.
    await this.withConfigLock(async () => {
      await this.withConfigFileLock(async () => {
        const existing = await this.loadConfigForWrite();
        const idx = existing.findIndex((server) => server.id === id);
        if (idx === -1) {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdNotFound", { id })}`);
        }
        const current = existing[idx];
        if (current.auth !== "api-key") {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverNotApiKey", { id })}`);
        }
        const candidate = { ...current, apiKey: trimmedKey } as McpServerConfig;
        const validation = this.governance.validateServer(candidate);
        if (!validation.valid) {
          throw new Error(
            `[mcp-manager] ${t("be_mcpManager.governanceValidationFailed", { layer: String(validation.layer), reason: validation.reason })}`,
          );
        }
        updatedConfig = candidate;
        const updated = [...existing];
        updated[idx] = updatedConfig;
        await this.saveConfigs(updated);
      });
    });

    if (!updatedConfig) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdNotFound", { id })}`);
    }

    const existingClient = this.clients.get(id);
    if (existingClient) {
      await existingClient.disconnect().catch((err) => {
      log.warn(`setApiKey: existing client disconnect failed (${id}): %s`, err);
      });
      this.clients.delete(id);
    }

    try {
      await this.connectServer(updatedConfig, { force: true });
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_apikey_set",
        input: JSON.stringify({ serverId: id }),
        output: "connected",
      });
      return { connected: true };
    } catch (err) {
      const rawMsg = errorMessage(err);
      const warning = scrubSecrets(rawMsg);
      log.warn(`Connection after API key set failed (${id}): %s`, warning);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_apikey_set",
        input: JSON.stringify({ serverId: id }),
        output: "warning",
      });
      return { connected: false, warning };
    }
  }

  /** Remove from the effective list, including legacy-backup entries, and write a new primary if needed. */
  async removeConfig(serverId: string): Promise<void> {
    this.retireOAuth(serverId);
    return this.withConfigLock(async () => {
      let removedKey: string | undefined;
      await this.withConfigFileLock(async () => {
        const existing = await this.loadConfigForWrite();
        const removedConfig = existing.find((config) => config.id === serverId);
        // Resolve credentials before rewriting config; invalid OAuth endpoints have no stored key.
        removedKey = removedConfig?.transport === "http" && removedConfig.auth === "oauth"
          ? tryMcpOAuthCredentialKey(removedConfig) : undefined;
        const updated = existing.filter((s) => s.id !== serverId);
        if (updated.length === existing.length) {
          return;
        }
        await this.saveConfigs(updated);
      });
      const session = this.oauthSessions.get(serverId)?.session;
      session?.dispose();
      this.oauthSessions.delete(serverId);
      const client = this.clients.get(serverId);
      if (client) {
        await client.disconnect().catch((e) =>
      log.warn(`removeConfig disconnect failed (${serverId}): %s`, e),
        );
        this.clients.delete(serverId);
      }
      this.toolRegistry.unregisterByMcp(serverId);
      this.onServerDisconnected?.(serverId);
      if (session) await session.clear();
      else if (removedKey) await this.oauthPresentation?.secrets.deleteSecret(removedKey);
      await this.queueOAuthIndexUpdate(serverId, undefined);
    });
  }

  /** Shared atomic writes provide exclusive staging, fsync and Windows transient-lock retries. */
  private async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    await writeFileAtomicAtPath(
      this.configPath,
      JSON.stringify({ servers: configs }, null, 2),
    );
  }

  private toConfigDto(config: McpServerConfig): McpServerConfigDto {
    // Keep credentials, headers, args and environment write-only across IPC.
        // Filesystem authority paths are host-derived and never accepted from renderer input.
    const { apiKey: _apiKey, headers: _headers, env: _env, args: _args, ...rest } =
      config;
    const { sandboxRoot: _sandboxRoot, cwd: _cwd, pluginDataDir: _pluginDataDir, bundledPayloadRoot: _bundledPayloadRoot, ...safe } =
      rest as Record<string, unknown>;
    return safe as McpServerConfigDto;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallOutput> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverDoesNotExist", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.callTool(toolName, args));
  }

  /** Hold the exact bundled-generation lease across prompt reads. */
  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<{
    description?: string;
    blocks: Array<{ role: string; type: string; text?: string }>;
    droppedBlocks: number;
  }> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverDoesNotExist", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.getPrompt(name, args));
  }

  /** List connected resource catalogs; clients remain the sole authority for declared-URI reads. */
  listDeclaredResources(): Array<{ serverId: string; resources: readonly McpResourceSummary[] }> {
    return this.listServers()
      .filter((server) => server.status === "connected" && (server.resources?.length ?? 0) > 0)
      .map((server) => ({ serverId: server.id, resources: server.resources ?? [] }));
  }

  /** Templates have uriTemplate identities and remain separate from concrete resource catalogs. */
  listDeclaredResourceTemplates(): Array<{
    serverId: string;
    templates: readonly McpResourceTemplateSummary[];
  }> {
    return this.listServers()
      .filter((server) =>
        server.status === "connected" && (server.resourceTemplates?.length ?? 0) > 0)
      .map((server) => ({ serverId: server.id, templates: server.resourceTemplates ?? [] }));
  }

  /** Declared core-resource reads hold a generation lease and remain distinct from Apps ui reads. */
  async readDeclaredResource(serverId: string, uri: string): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
  }> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverDoesNotExist", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.readDeclaredResource(uri));
  }

  /** Match listed templates and expand values in the host; concrete-resource reads use a different gate. */
  async readDeclaredResourceTemplate(
    serverId: string,
    uriTemplate: string,
    values: ReadonlyMap<string, string>,
  ): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
    uri: string;
  }> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverDoesNotExist", { serverId })}`);
    }
    return this.withBundledLease(
      serverId,
      () => client.readDeclaredResourceTemplate(uriTemplate, values),
    );
  }

  get connectedCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.getState().status === "connected") count++;
    }
    return count;
  }

  private bindBundledTool(tool: Tool, owner: PluginMcpOwner): Tool {
    const execute = tool.execute.bind(tool);
    const bound = Object.freeze({
      ...tool,
      pluginGeneration: Object.freeze({
        pluginId: owner.pluginId,
        generationId: owner.activationId,
      }),
      execute: async (...args: Parameters<Tool["execute"]>) => {
        const lease = await this.acquireOwnerLease(owner);
        try {
          return await execute(...args);
        } finally {
          lease.release();
        }
      },
    });
    this.bundledBaseTools.set(bound, tool);
    return bound;
  }

  private async withBundledLease<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const owner = this.bundledOwners.get(serverId);
    if (!owner) return operation();
    const lease = await this.acquireOwnerLease(owner);
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }
}
