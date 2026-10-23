



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
import type { PermissionManager } from "../permissions/permission-manager.js";
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
  /**
   * Whether list() names every installed package of this kind (none failed to
   * load). Only a complete list may retire stored OAuth grants of servers it
   * no longer names; an incomplete one could mistake a broken package for an
   * uninstalled one.
   */
  complete(): boolean;
}

export interface BundledSecretStore {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** Encrypted-store record naming each external server's OAuth credential key (keys only, no tokens). */
const OAUTH_CREDENTIAL_INDEX_KEY = "mcp.oauth.index";

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
  readonly permissionPublication?: { publish(): void };
  published: boolean;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private readonly oauthSessions = new Map<string, { fingerprint: string; session: McpOAuthSession }>();
  /** Plugin-bundled OAuth sessions, keyed by the generation-independent bundled config id. */
  private readonly bundledOAuthSessions = new Map<string, { fingerprint: string; session: McpOAuthSession }>();
  /** Generation-specific bundled server id → its stable OAuth session id. */
  private readonly bundledOAuthRuntimeIds = new Map<string, string>();
  private oauthStoreWork: Promise<void> = Promise.resolve();
  /** Set while the credential index cannot be read; cleanup is paused (nothing deleted) until a load rebuilds it. */
  private oauthIndexUnreadable = false;
  private readonly authentications = new Map<string, Promise<McpAuthenticationResult>>();
  private readonly oauthRetirements = new Map<string, number>();
  private readonly serverLifecycleLocks = new Map<string, Promise<void>>();
  private oauthShutdownGeneration = 0;
  private bundledOwners = new Map<string, PluginMcpOwner>();
  private readonly bundledCredentialSources = new Map<BundledPackageRef["kind"], BundledCredentialSource>();
  private activeBundledServerIds = new Set<string>();
  private bundledDegraded = new Map<string, readonly BundledMcpDegradedState[]>();
  private readonly bundledBaseTools = new WeakMap<Tool, Tool>();
  private readonly bundledToolSnapshots = new Map<string, readonly Tool[]>();
  /** Retains exact transport handles until candidate teardown succeeds. */
  private readonly pendingBundledCandidateCleanup = new Map<
    McpClient,
    PendingBundledCandidateCleanup
  >();
  private generationAccess: PluginRuntimeGenerationAccess | undefined;
  /** Lease sources by owner-id prefix (`agent-plugin/`), consulted before the plugin lifecycle. */
  private readonly generationLeaseSources = new Map<string, (pluginId: string, activationId: string) => Promise<{ release(): void }>>();
  private readonly configPath: string;
  private readonly configLockPath: string;
  /** Serialises all config read-modify-write ops to prevent TOCTOU races */
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
    // Use a stable sibling sentinel instead of touching configPath before lock acquisition.
    // This avoids interfering with Windows temp-file + rename replacement of configPath.
    return withFileLock(this.configLockPath, fn);
  }

  constructor(
    private readonly governance: McpGovernance,
    private readonly toolRegistry: ToolRegistry,
    /** The host's outbound transport, handed to every client this builds. */
    private readonly networkFetch: typeof fetch,
    configPath?: string,
    private readonly permissionManager?: PermissionManager,
    private readonly auditLogger?: AuditLogger,
    /**
     * MRTR resolver factory (milestone mrtr-input-loop). Bound per-server and
     * passed to each McpClient so a server's `input_required` (elicitation) is
     * gathered via the host approval gate. Omitted ⇒ clients fail closed on
     * `input_required` (No-Fallback).
     */
    private readonly inputResolverFactory?: (serverId: string) => McpInputRequestResolver,
    /**
     * #885 b3 — invoked EXACTLY once per server *retirement* (the 3 teardown
     * paths: `killSwitch`, `removeConfig`, `disconnectAll`). NOT invoked from
     * the 2 reconnect/replace paths (`setApiKey`, `connectServer`'s error
     * re-establish), because those re-create the same server id and the card is
     * about to become valid again. The sink (wired in `mcp-setup.ts`) broadcasts
     * the disconnect so renderer-owned cards retire, then clears the ephemeral
     * per-server partition. Omitted ⇒ teardown proceeds without a UI signal.
     */
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

  /**
   * Route the generation leases of bundled servers whose owner id starts
   * with `prefix` to `acquireExact` instead of the plugin lifecycle (design
   * §18.7.4): agent plugins own their activations, which the plugin
   * lifecycle's coordinator does not know.
   */
  registerGenerationLeaseSource(prefix: string, acquireExact: (pluginId: string, activationId: string) => Promise<{ release(): void }>): void {
    if (!prefix || this.generationLeaseSources.has(prefix)) throw new Error(`bundled MCP lease source ${prefix} is already registered`);
    this.generationLeaseSources.set(prefix, acquireExact);
  }

  /**
   * The one acquisition of a bundled server's generation lease: the source
   * registered for the longest prefix of the owner's id, else the plugin
   * lifecycle. Both a registered tool's `execute` and every other bundled
   * call ({@link withBundledLease}) take their lease here.
   */
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

  registerBundledCredentialSource(kind: BundledPackageRef["kind"], source: BundledCredentialSource): void {
    this.bundledCredentialSources.set(kind, source);
    void this.reconcileBundledOAuthCredentials(kind, source);
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

  // ─── Config Loading ─────────────────────────────────

  /** MCP 서버 설정 파일에서 설정 로드 */
  async loadFromConfig(): Promise<McpServerConfig[]> {
    return this.withConfigFileLock(() => this.loadFromConfigUnlocked());
  }

  private async loadFromConfigUnlocked(): Promise<McpServerConfig[]> {
    return (await this.loadConfigFile()).servers;
  }

  /**
   * `loaded` is true only when the configuration file itself was read and
   * parsed. A missing, empty or unparsable file (or a legacy .bak fallback)
   * yields a usable server list but never authority to delete stored
   * credentials: one stray comma must not sign the user out of everything.
   */
  private async loadConfigFile(): Promise<{ servers: McpServerConfig[]; loaded: boolean }> {
    const bakPath = `${this.configPath}.bak`;
    // Keep read-only fallback for legacy/operator-provided recovery files.
    // saveConfigs() no longer creates new .bak files because they can retain secrets.
    const candidatePaths = [
      ...(existsSync(this.configPath) ? [this.configPath] : []),
      ...(existsSync(bakPath) ? [bakPath] : []),
    ];

    if (candidatePaths.length === 0) {
      // A first run has no file and no credential index either; nothing is cleaned up.
      log.info("MCP server config file missing: %s", this.configPath);
      return { servers: [], loaded: false };
    }

    for (const path of candidatePaths) {
      try {
        const raw = await readFile(path, "utf-8");
        if (!raw.trim()) {
          if (path === candidatePaths[candidatePaths.length - 1]) {
            return { servers: [], loaded: false };
          }
      log.warn(`Empty config file detected, falling back to next candidate: ${path}`);
          continue;
        }
        const parsed = JSON.parse(raw) as unknown;
        const listed = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { servers?: unknown }).servers : undefined;
        // `{}`, another app's `{"mcpServers":…}`, a misspelled key or a bare array is a
        // configuration error, never an empty server list.
        if (!Array.isArray(listed)) throw new Error(`MCP server config ${path} must be an object with a "servers" array`);
        const servers = (listed as McpServerConfig[]).map((s) => {
          // transport 필드 누락 시 command 유무로 기본값 보정
          if (!s.transport) {
            (s as Record<string, unknown>).transport = (s as Record<string, unknown>).command ? "stdio" : "http";
          }
          return s;
        });
      log.info(`${servers.length} MCP server configs loaded`);
        return { servers, loaded: path === this.configPath };
      } catch (err) {
      log.error({ err }, "Config file parse failed");
      }
    }

    return { servers: [], loaded: false };
  }

  // ─── Connection Management ──────────────────────────

  /** 설정된 모든 승인 서버에 연결 (병렬) */
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

  /** 단일 서버 연결 */
  async connectServer(config: McpServerConfig, opts: { force?: boolean } = {}): Promise<void> {
    const epoch = this.oauthEpoch(config.id);
    // 이미 연결된 서버는 건너뛰기
    const existing = this.clients.get(config.id);
    if (existing && existing.getState().status === "connected" && !opts.force) {
      log.info(`${config.id}: already connected — skipping`);
      return;
    }

    // 기존 에러/연결 해제 상태면 정리 후 재연결
    if (existing) {
      await existing.disconnect();
      this.clients.delete(config.id);
    }

    // The HOST decides the stdio worker's filesystem-jail
    // root — it is NEVER sourced from plugin/renderer/marketplace/config-file
    // input. `connectServer` is the single chokepoint every external MCP server
    // config passes through before `new McpClient`, so the invariant "the host
    // always sets sandboxRoot" is established here (deny-by-default A.a). Any
    // value that rode in on `config` (e.g. a tampered servers.json) is dropped
    // and overwritten with the host-derived per-server root.
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
      this.permissionManager,
      undefined, // transportOverride — external servers build their own transport
      this.inputResolverFactory?.(config.id), // MRTR resolver, bound to this server
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

  /**
   * The session for an external OAuth server. Decided synchronously so every
   * concurrent caller for one id shares a single session (and so a single
   * refresh): two sessions would each spend the same refresh token.
   */
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

  /**
   * A new session for `config`, retiring `previous`. Only a change to the
   * credential identity (id, URL, OAuth settings) retires the stored grant.
   * Under the same key the old session hands off: a refresh it has in flight
   * finishes and persists before the new session reads the record.
   */
  private replaceOAuthSession(config: McpHttpServerConfig, previous: McpOAuthSession | undefined): McpOAuthSession {
    if (!this.oauthPresentation) throw new Error("MCP authorization is unavailable");
    const dependencies = { ...this.oauthPresentation, networkFetch: this.networkFetch };
    const key = tryMcpOAuthCredentialKey(config);
    if (previous && key !== undefined && previous.credentialKey === key) {
      const session = new McpOAuthSession(config, dependencies, { after: previous.handOff(), initialStatus: previous.getStatus() });
      void this.queueOAuthIndexUpdate(config.id, session.credentialKey);
      return session;
    }
    const session = new McpOAuthSession(config, dependencies);
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

  /**
   * The credential index, or undefined when it cannot be read or is malformed.
   * An unreadable index is reported (log and server status) and never treated
   * as empty: nothing is deleted on its account, and it is rewritten only from
   * keys a successful configuration load names.
   */
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

  /**
   * Record which credential key each server owns, deleting a key it no longer
   * owns. The encrypted store cannot be enumerated, so this index is how a
   * record left under an old key (an edited URL or OAuth setting) is found.
   */
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

  /**
   * After a successful configuration load: delete records under keys the
   * configuration no longer names. Bundled entries belong to their package
   * source's reconciliation. An unreadable index is rebuilt from the keys
   * known now, deleting nothing.
   */
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
        // Bundled servers not prepared yet: from each complete source now; an incomplete one adds
        // them when it next reports complete (reconcileBundledOAuthCredentials).
        for (const [kind, source] of this.bundledCredentialSources) {
          for (const [stableId, key] of this.declaredBundledOAuthKeys(kind, source) ?? []) rebuilt[stableId] ??= key;
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

  /**
   * The bundled OAuth servers a source declares, by stable id, with the
   * credential key each would be stored under; undefined while the source is
   * incomplete (a package failed to load or a package transaction is open) or
   * cannot be read. The key is derived the way the server's session derives
   * it, so it is known before the server is ever prepared.
   */
  private declaredBundledOAuthKeys(kind: BundledPackageRef["kind"], source: BundledCredentialSource): Map<string, string> | undefined {
    try {
      if (!source.complete()) return undefined;
      const declared = new Map<string, string>();
      for (const item of source.list()) {
        if (item.transport !== "http" || item.auth !== "oauth" || !item.url) continue;
        const id = bundledConfigId({ kind, name: item.packageName }, item.serverName);
        const key = tryMcpOAuthCredentialKey({ id, transport: "http", url: item.url, auth: "oauth", ...(item.oauth ? { oauth: item.oauth } : {}) });
        if (key) declared.set(id, key);
      }
      return declared;
    } catch (error) {
      log.warn("Bundled MCP package list unavailable; stored authorization cleanup skipped: %s", errorMessage(error));
      return undefined;
    }
  }

  /**
   * After a complete package list: index the grants of declared bundled OAuth
   * servers not yet indexed (an index rebuilt before their servers were
   * prepared), and delete grants of servers of this kind the list no longer
   * declares (an uninstalled plugin). Completeness is checked again when the
   * work runs, so a package transaction opened meanwhile defers it.
   */
  private reconcileBundledOAuthCredentials(kind: BundledPackageRef["kind"], source: BundledCredentialSource): Promise<void> {
    return this.queueOAuthStoreWork(async (secrets) => {
      if (!secrets.canStoreEncrypted()) return;
      const declared = this.declaredBundledOAuthKeys(kind, source);
      if (!declared) return;
      const index = this.readOAuthIndex(secrets);
      if (!index) return;
      let changed = false;
      for (const [serverId, key] of Object.entries(index)) {
        if (!serverId.startsWith("bundled:") || declared.has(serverId)) continue;
        let ref: ReturnType<typeof parseBundledConfigId>;
        try { ref = parseBundledConfigId(serverId); }
        catch { ref = null; }
        if (ref && ref.packageRef.kind !== kind) continue;
        await secrets.deleteSecret(key);
        delete index[serverId];
        changed = true;
      }
      for (const [serverId, key] of declared) {
        if (index[serverId] !== undefined) continue;
        index[serverId] = key;
        changed = true;
      }
      if (changed) await this.writeOAuthIndex(secrets, index);
    });
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

  /** The stable (generation-independent) id under which a bundled OAuth server keeps its session. */
  private bundledOAuthStableId(serverId: string): string | undefined {
    if (this.bundledOAuthSessions.has(serverId)) return serverId;
    return this.bundledOAuthRuntimeIds.get(serverId);
  }

  private bundledOAuthSessionFor(projection: PreparedPluginMcpProjection): McpOAuthSession {
    if (projection.config.transport !== "http") throw new Error("bundled MCP OAuth requires an HTTP server");
    const bundled = projection.approval.bundled;
    if (!bundled) throw new Error("bundled MCP approval is missing its package identity");
    if (!this.oauthPresentation) throw new Error("MCP authorization is unavailable");
    // Keyed by package and server, not generation, so a grant survives plugin updates.
    const stableId = bundledConfigId(this.packageRefFromApproval(bundled.package), bundled.server);
    this.bundledOAuthRuntimeIds.set(projection.serverId, stableId);
    const config: McpHttpServerConfig = { ...projection.config, id: stableId };
    const fingerprint = JSON.stringify(config);
    const previous = this.bundledOAuthSessions.get(stableId);
    if (previous?.fingerprint === fingerprint) return previous.session;
    const session = this.replaceOAuthSession(config, previous?.session);
    this.bundledOAuthSessions.set(stableId, { fingerprint, session });
    return session;
  }

  /** Authenticate a plugin-bundled server, then re-prepare it through its package's normal reconnect. */
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

  /** Prepare trusted bundled servers against an isolated registry. */
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
          // Preparation never opens a browser; the settings row's Authenticate action does, then reconnects.
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
      const replacementNames = new Set(replacementTools.map((tool) => tool.name));
      const permissionPublication = this.permissionManager?.prepareToolModeOverrides(
        predecessorToolNames.filter((toolName) => !replacementNames.has(toolName)),
        records.flatMap((record) => record.tools.map((tool) => ({
          toolName: tool.name,
          mode: record.projection.approval.toolPermissionMode ?? "strict",
        }))),
      );
      // Reserve the shared ToolRegistry last. All other validation and snapshot
      // construction has completed, so no later preparation failure can strand it.
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
        ...(permissionPublication ? { permissionPublication } : {}),
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

  /** Synchronous half of the shared plugin generation publish point. */
  publishBundledGeneration(prepared: PreparedBundledMcpGeneration): void {
    if (prepared.published) return;
    prepared.governancePublication.assertAdmitted();
    prepared.registryReplacement.publish();
    prepared.governancePublication.publish();
    prepared.permissionPublication?.publish();
    for (const serverId of prepared.predecessorServerIds) this.activeBundledServerIds.delete(serverId);
    for (const record of prepared.records) {
      const serverId = record.projection.serverId;
      this.clients.set(serverId, record.client);
      this.bundledOwners.set(serverId, record.projection.owner);
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

  /**
   * Disconnect omitted clients only when they belong to this same generation.
   * A predecessor generation remains transport-live until its coordinator
   * leases drain and exact-generation retirement owns its teardown.
   */
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

  /** Retire only MCP clients and tools owned by the selected immutable generation. */
  async disconnectBundledGeneration(pluginId: string, generationId: string): Promise<void> {
    const ids = [...this.bundledOwners]
      .filter(([, owner]) => owner.pluginId === pluginId &&
        owner.activationId === generationId)
      .map(([serverId]) => serverId);
    for (const serverId of ids) await this.disconnectBundledServer(serverId);
    this.bundledDegraded.delete(`${pluginId}\0${generationId}`);
  }

  /** Apply current governance withdrawals to live clients and their published tools. */
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
    this.bundledToolSnapshots.delete(serverId);
    if (wasActive) {
      const toolNames = this.toolRegistry.listAll()
        .filter((tool) => tool.mcpServerId === serverId)
        .map((tool) => tool.name);
      this.toolRegistry.unregisterByMcp(serverId);
      for (const toolName of toolNames) this.permissionManager?.clearToolModeOverride(toolName);
      this.governance.unregisterRuntimeApproval(serverId);
    }
    try {
      this.onServerDisconnected?.(serverId);
    } catch (error) {
      disconnectError ??= error instanceof Error ? error : new Error(String(error));
    }
    if (disconnectError) throw disconnectError;
  }

  /** 모든 서버 연결 해제 */
  async disconnectAll(): Promise<void> {
    this.oauthShutdownGeneration++;
    for (const { session } of this.oauthSessions.values()) session.dispose();
    for (const { session } of this.bundledOAuthSessions.values()) session.dispose();
    await Promise.all(this.serverLifecycleLocks.values());
    // Credential index writes are queued without a caller awaiting them; finish
    // them before shutdown so none lands after the store is closed or removed.
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
    this.activeBundledServerIds.clear();
    this.bundledDegraded.clear();
    // b3 — teardown path: emit once per retired id AFTER client teardown.
    // Best-effort (may run at shutdown); the sink guards `isDestroyed()` and
    // swallows send errors so a send-after-window-destroy is a no-op.
    for (const id of ids) {
      this.onServerDisconnected?.(id);
    }
    log.info("All MCP servers disconnected");
    if (pendingCleanupError) throw pendingCleanupError;
  }

  /**
   * Host-derive (and create) the per-server filesystem-jail root for an external
   * stdio MCP worker — `~/.ave/mcp/<serverId>/sandbox/`.
   *
   * This is the ONLY writable path the ASRT-wrapped worker is granted. The
   * directory is created mode 0o700 per the storage-namespace convention so the
   * jail exists before the worker spawns. The server id is sanitized to a single
   * path segment (no separators / parent traversal) so a crafted id cannot
   * escape the `~/.ave/mcp/` namespace; if sanitization empties the id the
   * server is rejected rather than silently jailing into a shared dir.
   *
   * On failure to create the dir we DO NOT fall back to a permissive path — we
   * throw, and the caller's connect fails closed (No-Fallback).
   */
  private async ensureStdioSandboxRoot(serverId: string): Promise<string> {
    // Collapse to a single safe path segment: keep alnum / dash / underscore /
    // dot, replace everything else with `_`, and strip leading dots so a
    // sanitized id can never be `.` / `..` (parent traversal).
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

  // ─── Kill Switch (§10.1) ────────────────────────────

  /**
   * 즉시 연결 해제 + 도구 제거.
   * 진행 중인 요청은 에러로 reject됨.
   */
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

    // 안전장치: ToolRegistry에서도 직접 제거 (중복 호출이지만 확실히 정리)
    this.toolRegistry.unregisterByMcp(serverId);
    this.activeBundledServerIds.delete(serverId);
    this.bundledOwners.delete(serverId);
    this.governance.unregisterRuntimeApproval?.(serverId);
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "mcp-manager",
      type: "kill_switch",
      input: JSON.stringify({ serverId }),
    });

    // b3 — teardown path (permanent retirement): signal the UI to disable
    // renderer-owned cards, then clear the ephemeral partition.
    this.onServerDisconnected?.(serverId);

    log.warn(`Kill switch completed: ${serverId} — all tools unregistered`);
  }

  // ─── Query ──────────────────────────────────────────

  /** 전체 서버 상태 조회 */
  listServers(): McpServerState[] {
    const states = Array.from(this.clients.entries())
      .filter(([serverId]) => !this.bundledOwners.has(serverId) || this.activeBundledServerIds.has(serverId))
      .map(([serverId, client]) => this.withAuthState(serverId, client.getState()));
    for (const serverId of this.oauthSessions.keys()) {
      if (!this.clients.has(serverId)) states.push(this.withAuthState(serverId, { id: serverId, status: "disconnected", registeredTools: [] }));
    }
    // A bundled OAuth server that is not running is listed under its stable id, as its settings row is.
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

  /** 특정 서버 상태 조회 */
  getServerState(serverId: string): McpServerState | undefined {
    if (this.bundledOwners.has(serverId) && !this.activeBundledServerIds.has(serverId)) return undefined;
    const state = this.clients.get(serverId)?.getState();
    if (state) return this.withAuthState(serverId, state);
    if (this.oauthSessions.has(serverId) || this.bundledOAuthSessions.has(serverId)) {
      return this.withAuthState(serverId, { id: serverId, status: "disconnected", registeredTools: [] });
    }
    return undefined;
  }

  // ─── MCP Apps UI Resource ────────────────────────────

  /**
   * Fetch a `ui://` resource from the given MCP server — the HTML plus the
   * resource's OWN declared `_meta.ui` (csp / permissions), which main uses to build
   * that card's sandbox-proxy CSP header. Delegates to {@link McpClient.readResource}.
   */
  async readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverNotFound", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.readResource(uri));
  }

  /**
   * The name a server-local tool is REGISTERED under in the §6.4 ToolRegistry
   * (`mcp_<prefix>_<name>`) — governance namespacing is the SoT, so this only
   * delegates. An MCP App names its server's tools by their SERVER-LOCAL name
   * (it knows nothing about host namespacing); the `oncalltool` external backend
   * uses this to find the GATED registry `Tool` the executor must run. It never
   * proves ownership on its own (an unapproved server namespaces to a passthrough
   * name) — the registry entry's `mcpServerId` is what binds the tool to the card's
   * server.
   */
  namespacedToolName(serverId: string, toolName: string): string {
    return this.governance.applyToolNamespace(serverId, toolName);
  }

  // ─── Config Mutation ────────────────────────────────

  /** 설정 파일의 현재 서버 목록 반환 (renderer-safe DTO) */
  async getConfigs(): Promise<McpServerConfigDto[]> {
    const configs = await this.loadFromConfig();
    const bundled: McpServerConfigDto[] = [];
    for (const [kind, source] of this.bundledCredentialSources) {
      for (const declaration of source.list()) {
        const packageRef = { kind, name: declaration.packageName };
        const runtimeId = [...this.bundledOwners].find(([serverId, owner]) =>
          this.activeBundledServerIds.has(serverId) && owner.pluginId === `${kind}/${declaration.packageName}`
          && owner.localId === declaration.serverName)?.[0];
        const id = runtimeId ?? bundledConfigId(packageRef, declaration.serverName);
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

  /** A Studio-only read. Existing MCP settings projections keep arguments and environment values write-only. */
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

  /** Main-only export guard input; no credential crosses the Studio IPC bridge. */
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

  /**
   * 설정 파일에 서버 추가 + 연결 시도.
   * 이미 동일 id가 있으면 에러. write-lock으로 동시 추가 시 TOCTOU 방지.
   */
  /** What `addConfig` would decide about `config` under the governance policy, without adding it. */
  validateConfig(config: McpServerConfig): ValidationResult {
    return this.governance.validateServer(config);
  }

  async addConfig(config: McpServerConfig): Promise<McpConfigMutationResult> {
    // Runtime payload validation (IPC cast is type-only, disappears at runtime)
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

    // Normalize id: trim whitespace, reject empty
    const normalizedId = config.id.trim();
    if (!normalizedId) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdBlank")}`);
    }
    // Bound the id at ingestion. This is the primary guard;
    // `encodeMcpServerId` applies the same bound defensively for the
    // `loadFromConfig`/servers.json path that bypasses addConfig. English throw
    // (developer-facing tamper path, per CLAUDE.md IPC error-language convention).
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
        const existing = await this.loadFromConfigUnlocked();
        if (existing.some((s) => s.id === normalizedId)) {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdAlreadyExists", { id: normalizedId })}`);
        }
        const updated = [...existing, normalizedConfig];
        await this.saveConfigs(updated);
      });
      // 연결 시도 (실패해도 config 저장은 유지)
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

  /** Remove an obsolete declaration's value before update preparation; restore it if the install rolls back. */
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

    // HIGH: validate BEFORE saveConfigs (inside the file-lock, mirrors addConfig pattern)
    await this.withConfigLock(async () => {
      await this.withConfigFileLock(async () => {
        const existing = await this.loadFromConfigUnlocked();
        const idx = existing.findIndex((server) => server.id === id);
        if (idx === -1) {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverIdNotFound", { id })}`);
        }
        const current = existing[idx];
        if (current.auth !== "api-key") {
          throw new Error(`[mcp-manager] ${t("be_mcpManager.serverNotApiKey", { id })}`);
        }
        const candidate = { ...current, apiKey: trimmedKey } as McpServerConfig;
        // Governance validation BEFORE persisting to disk
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

    // MEDIUM: disconnect existing client before reconnect so the new apiKey takes effect
    const existingClient = this.clients.get(id);
    if (existingClient) {
      await existingClient.disconnect().catch((err) => {
      log.warn(`setApiKey: existing client disconnect failed (${id}): %s`, err);
      });
      this.clients.delete(id);
    }

    try {
      await this.connectServer(updatedConfig, { force: true });
      // MEDIUM: audit log on success
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-manager",
        type: "mcp_apikey_set",
        input: JSON.stringify({ serverId: id }),
        output: "connected",
      });
      return { connected: true };
    } catch (err) {
      // MEDIUM: scrub secrets from warning before surfacing to caller
      const rawMsg = errorMessage(err);
      const warning = scrubSecrets(rawMsg);
      log.warn(`Connection after API key set failed (${id}): %s`, warning);
      // MEDIUM: audit log on failure
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

  /**
   * 설정 파일에서 서버 제거 + 연결 해제.
   * 존재하지 않아도 에러 없이 처리. write-lock으로 동시 제거 시 TOCTOU 방지.
   *
   * NOTE: loadFromConfigUnlocked() may surface servers from a legacy .bak file
   * even when the primary config is absent.  We therefore reason about the
   * *effective* server list rather than short-circuiting on existsSync(), so
   * that bak-only servers are also correctly removed: a new primary config is
   * written without the removed server, which takes precedence over the .bak on
   * the next load.
   */
  async removeConfig(serverId: string): Promise<void> {
    this.retireOAuth(serverId);
    return this.withConfigLock(async () => {
      let removedKey: string | undefined;
      await this.withConfigFileLock(async () => {
        const existing = await this.loadFromConfigUnlocked();
        const removedConfig = existing.find((config) => config.id === serverId);
        // Resolved before the file is rewritten. An endpoint that is not a valid OAuth target
        // can never have stored credentials, so it has no key to clear.
        removedKey = removedConfig?.transport === "http" && removedConfig.auth === "oauth"
          ? tryMcpOAuthCredentialKey(removedConfig) : undefined;
        const updated = existing.filter((s) => s.id !== serverId);
        if (updated.length === existing.length) {
          // Server not present in the effective config — nothing to persist.
          return;
        }
        await this.saveConfigs(updated);
      });
      const session = this.oauthSessions.get(serverId)?.session;
      session?.dispose();
      this.oauthSessions.delete(serverId);
      // 연결 해제 (이미 끊겨있으면 무시)
      const client = this.clients.get(serverId);
      if (client) {
        await client.disconnect().catch((e) =>
      log.warn(`removeConfig disconnect failed (${serverId}): %s`, e),
        );
        this.clients.delete(serverId);
      }
      this.toolRegistry.unregisterByMcp(serverId);
      // b3 — teardown path (permanent retirement).
      this.onServerDisconnected?.(serverId);
      if (session) await session.clear();
      else if (removedKey) await this.oauthPresentation?.secrets.deleteSecret(removedKey);
      await this.queueOAuthIndexUpdate(serverId, undefined);
    });
  }

  /**
   * `configPath` 에 서버 목록을 원자적으로 저장. Routes through the shared
   * atomic-write authority ({@link writeFileAtomicAtPath}): random staging name
   * + `O_CREAT|O_EXCL`, fsync of the staged bytes and parent directory, and a
   * Windows transient-lock retry on the rename. That retry replaces the bespoke
   * `EEXIST` backup-and-restore dance this used to carry — `EEXIST` is
   * unreachable for a file-onto-file rename (Win32 `rename` replaces the target),
   * whereas a scanner briefly locking the config is the case the old dance
   * missed and the authority's retry now covers.
   */
  private async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    await writeFileAtomicAtPath(
      this.configPath,
      JSON.stringify({ servers: configs }, null, 2),
    );
  }

  private toConfigDto(config: McpServerConfig): McpServerConfigDto {
    // Secrets remain write-only across IPC:
    // - apiKey: shared secret
    // - headers: may contain bearer/session tokens
    // - env: may contain injected credentials
    // - args: may embed secrets on stdio command lines
    // - sandboxRoot, cwd, pluginDataDir and bundledPayloadRoot: host-derived filesystem paths;
    //   never renderer concerns and never sourced from renderer input.
    const { apiKey: _apiKey, headers: _headers, env: _env, args: _args, ...rest } =
      config;
    const { sandboxRoot: _sandboxRoot, cwd: _cwd, pluginDataDir: _pluginDataDir, bundledPayloadRoot: _bundledPayloadRoot, ...safe } =
      rest as Record<string, unknown>;
    return safe as McpServerConfigDto;
  }

  /** 특정 서버의 도구 호출 — ToolExecutor에서 사용 */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallOutput> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`[mcp-manager] ${t("be_mcpManager.serverDoesNotExist", { serverId })}`);
    }
    return this.withBundledLease(serverId, () => client.callTool(toolName, args));
  }

  /**
   * Fetch one declared prompt. Mirrors {@link callTool}: the bundled-generation
   * lease is held across the request so a plugin-backed server cannot be
   * retired mid-flight.
   */
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

  /**
   * Servers that currently declare resources, with their catalogues.
   *
   * The ONE projection for callers that need the catalogue as a list. Today that is
   * the model-facing tools; the attach path deliberately does NOT use it — it calls
   * `readDeclaredResource` and lets the listed-URI gate inside the client decide,
   * so there is one place a URI is checked against what the server published rather
   * than a second copy of that check in the handler.
   *
   * Only CONNECTED servers are listed. That cannot currently change an outcome —
   * `clearDiscoveredSurfaces` nulls the catalogue on both teardown paths, and
   * `connect()` flips the status in the same continuation as discovery — so it stands
   * as an explicit invariant, not as a filter something is expected to fall through.
   */
  listDeclaredResources(): Array<{ serverId: string; resources: readonly McpResourceSummary[] }> {
    return this.listServers()
      .filter((server) => server.status === "connected" && (server.resources?.length ?? 0) > 0)
      .map((server) => ({ serverId: server.id, resources: server.resources ?? [] }));
  }

  /**
   * Servers that currently declare URI TEMPLATES, with their catalogues.
   *
   * A sibling projection rather than a field on the one above, for the reason the type
   * exists at all: a template's identity is `uriTemplate` and a resource's is `uri`, so
   * one list carrying both would need every consumer to discriminate before it could
   * even validate an entry.
   */
  listDeclaredResourceTemplates(): Array<{
    serverId: string;
    templates: readonly McpResourceTemplateSummary[];
  }> {
    return this.listServers()
      .filter((server) =>
        server.status === "connected" && (server.resourceTemplates?.length ?? 0) > 0)
      .map((server) => ({ serverId: server.id, templates: server.resourceTemplates ?? [] }));
  }

  /**
   * Read one resource the server declared (`resources/read`, core capability).
   *
   * Leased like every other bundled-server round trip, so a plugin-backed server
   * cannot be read after its generation is gone. Distinct from
   * {@link readUiResource}, which serves the MCP-Apps `ui://` extension.
   */
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

  /**
   * Expand a declared URI template with the user's values and read the result.
   *
   * Leased like the plain read. Separate from it rather than a flag on it because the
   * two are gated differently — one matches a listed URI, this one matches a listed
   * TEMPLATE and produces the URI itself — and collapsing them would put a branch
   * inside the gate, which is the shape that lets one side inherit the other's check.
   */
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

  /** 연결된 서버 수 */
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
