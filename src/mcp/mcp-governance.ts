



import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  McpCapability,
  McpGovernancePolicy,
  McpServerApproval,
  McpServerConfig,
  McpToolSchema,
  ValidationResult,
} from "./types.js";
import { isMcpAppUiUri } from "../shared/mcp-app-partition.js";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  ENV_NAME_RE,
  HTTP_HEADER_NAME_RE,
  MAX_NAME_LEN,
  RESERVED_ENV_NAMES,
  RESERVED_HEADERS,
} from "./safe-names.js";
import { t } from "../i18n/index.js";
import { isLoopbackUrlHostname } from "../shared/loopback-url.js";
const log = createLogger("mcp-governance");

/** Exhaustive capability mapping makes new methods opt in; task management uses tools authority. */
const CAPABILITY_METHODS = {
  tools: ["tools/list", "tools/call", "tasks/get", "tasks/cancel"],
  resources: ["resources/list", "resources/read", "resources/templates/list"],
  prompts: ["prompts/list", "prompts/get"],
} satisfies Record<McpCapability, string[]>;

const REQUEST_METHOD_CAPABILITY: Record<string, McpCapability> = Object.fromEntries(
  Object.entries(CAPABILITY_METHODS).flatMap(([capability, methods]) =>
    methods.map((method) => [method, capability as McpCapability]),
  ),
);

/** Only classified capabilities and this closed control allow-list pass; unknown methods fail closed. */
// Notification refreshes re-enter gated list methods; sendNotification does not use this request gate.
const CONTROL_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "initialize",
  "subscriptions/listen",
]);

const DEFAULT_POLICY: McpGovernancePolicy = {
  version: "1.0",
  defaultPolicy: "deny",
  servers: [],
  bundledServers: [],
  globalRules: {
    maxServersTotal: 10,
    blockedUrlPatterns: ["*.ngrok.io", "*.serveo.net", "*.localtunnel.me"],
    allowedUrlPatterns: [],
    policyRefreshIntervalMs: 30 * 60 * 1000,
    allowUserApprovedServers: true,
  },
};

export class McpGovernance {
  private policy: McpGovernancePolicy;
  private runtimeApprovals: Map<string, McpServerApproval>;
  private readonly policyPath: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    policyPath?: string,
    scopedState?: {
      policy: McpGovernancePolicy;
      runtimeApprovals: Map<string, McpServerApproval>;
    },
  ) {
    this.policyPath = policyPath ?? join(aveHome(), "governance", "mcp-policy.json");
    this.policy = scopedState?.policy ?? this.loadPolicy();
    this.runtimeApprovals = scopedState?.runtimeApprovals ?? new Map();
  }



  private loadPolicy(): McpGovernancePolicy {
    if (!existsSync(this.policyPath)) {
      log.info("Policy file missing — applying deny-by-default");
      return DEFAULT_POLICY;
    }
    try {
      const raw = readFileSync(this.policyPath, "utf-8");
      const parsed = JSON.parse(raw) as McpGovernancePolicy;


      if (parsed.defaultPolicy !== "deny") {
      log.warn("defaultPolicy must be 'deny'. Forcing deny-by-default.");
        parsed.defaultPolicy = "deny";
      }
      if (!parsed.globalRules) parsed.globalRules = DEFAULT_POLICY.globalRules;
      if (!Array.isArray(parsed.servers)) parsed.servers = [];
      if (parsed.globalRules.allowUserApprovedServers !== undefined
        && typeof parsed.globalRules.allowUserApprovedServers !== "boolean") {
        throw new Error("allowUserApprovedServers must be boolean");
      }
      if (parsed.bundledServers !== undefined && (!Array.isArray(parsed.bundledServers)
        || !parsed.bundledServers.every((entry) => entry && typeof entry.package === "string"
          && typeof entry.server === "string" && /^[a-f0-9]{64}$/u.test(entry.fingerprint)))) {
        throw new Error("bundledServers must contain package, server and fingerprint");
      }

    log.info(`Policy loaded: ${parsed.servers.length} server rules`);
      return parsed;
    } catch (err) {
    log.error({ err }, "Policy file parse failed — applying deny-by-default");
      return { ...DEFAULT_POLICY, globalRules: { ...DEFAULT_POLICY.globalRules, allowUserApprovedServers: false } };
    }
  }

  startPolicyRefresh(onRevoked?: (revokedIds: string[]) => void | Promise<void>): void {
    if (this.refreshTimer) return;
    const interval = this.policy.globalRules.policyRefreshIntervalMs;
    this.refreshTimer = setInterval(() => {
      const revokedIds = this.reloadPolicy();
      if (revokedIds.length > 0) {
    log.warn(`Revoked servers detected: ${revokedIds.join(", ")}`);
        Promise.resolve(onRevoked?.(revokedIds)).catch((err) => {
      log.error("revoke callback failed: %s", err);
        });
      }
    }, interval);
    this.refreshTimer.unref?.();
  }

  reloadPolicy(): string[] {
    const previous = this.policy;
    this.policy = this.loadPolicy();
    const prevStatusById = new Map(previous.servers.map((server) => [server.id, server.status]));
    const revokedManaged = this.policy.servers
      .filter((server) => server.status === "revoked" && prevStatusById.get(server.id) !== "revoked")
      .map((server) => server.id);
    return [...new Set([...revokedManaged, ...this.inadmissibleRuntimeServerIds()])];
  }

  stopPolicyRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Return the specific policy layer refusing a server configuration. */
  validateServer(config: McpServerConfig): ValidationResult {
    if (!this.policy) {
      return { valid: false, reason: t("be_mcpGovernance.policyNotLoaded"), layer: 0 };
    }

    const approval = this.findApproval(config.id);
    if (!approval) {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServer", { id: config.id }), layer: 1 };
    }
    if (approval.status === "revoked") {
      return { valid: false, reason: t("be_mcpGovernance.revokedServer", { id: config.id, revokedAt: approval.revokedAt ?? "" }), layer: 1 };
    }
    if (approval.status === "pending") {
      return { valid: false, reason: t("be_mcpGovernance.pendingServer", { id: config.id }), layer: 1 };
    }

    const activeCount = this.policy.servers.filter((s) => s.status === "approved").length + this.runtimeApprovals.size;
    if (activeCount > this.policy.globalRules.maxServersTotal) {
      return { valid: false, reason: t("be_mcpGovernance.maxServersExceeded", { activeCount, maxServersTotal: this.policy.globalRules.maxServersTotal }), layer: 1 };
    }

    if (config.transport !== approval.transport) {
      return { valid: false, reason: t("be_mcpGovernance.transportMismatch", { configTransport: config.transport, approvedTransport: approval.transport }), layer: 1 };
    }

    if (config.transport === "stdio") {
      const cmdResult = this.validateStdioCommand(config, approval);
      if (!cmdResult.valid) return cmdResult;
      const apiKeyEnvResult = this.validateApiKeyEnv(config, approval);
      if (!apiKeyEnvResult.valid) return apiKeyEnvResult;
    }

    if (
      config.transport === "http" ||
      config.transport === "sse" ||
      config.transport === "websocket"
    ) {
      const urlResult = this.validateUrl(config, approval);
      if (!urlResult.valid) return urlResult;

      // Require HTTPS except loopback; private-address approval is enforced separately.
      if (config.transport === "http") {
        const httpResult = this.validateHttpScheme(config.url);
        if (!httpResult.valid) return httpResult;

        // Reject header CRLF before request splitting can cross the transport boundary.
        const headersResult = this.validateHeaders(config.headers);
        if (!headersResult.valid) return headersResult;
        const apiKeyHeaderResult = this.validateApiKeyHeader(config, approval);
        if (!apiKeyHeaderResult.valid) return apiKeyHeaderResult;

        // Config cannot self-authorize private networks; global or server policy must opt in.
        if (config.allowPrivateNetworks) {
          const gateResult = this.validateAllowPrivateNetworks(approval);
          if (!gateResult.valid) return gateResult;
        }
      }
    }

    const connResult = this.validateConnectionSecurity(config, approval);
    if (!connResult.valid) return connResult;

    return { valid: true };
  }

  /** Require namespacing and count limits without shadowing registered or built-in tools. */
  validateToolRegistration(
    serverId: string,
    tools: McpToolSchema[],
    existingToolNames: Set<string>,
  ): ValidationResult {
    const approval = this.findApproval(serverId);
    if (!approval || approval.status !== "approved") {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServerToolRegistration", { serverId }), layer: 3 };
    }

    if (!approval.allowedCapabilities.includes("tools")) {
      return { valid: false, reason: t("be_mcpGovernance.noToolRegistrationPermission", { serverId }), layer: 3 };
    }

    if (tools.length > approval.maxTools) {
      return { valid: false, reason: t("be_mcpGovernance.toolCountExceeded", { toolCount: tools.length, maxTools: approval.maxTools, serverId }), layer: 3 };
    }

    const requiredPrefix = `mcp_${approval.toolNamePrefix}_`;
    for (const tool of tools) {
      const namespacedName = tool.name.startsWith(requiredPrefix)
        ? tool.name
        : `${requiredPrefix}${tool.name}`;

      if (existingToolNames.has(namespacedName)) {
        return { valid: false, reason: t("be_mcpGovernance.toolNameConflict", { namespacedName }), layer: 3 };
      }

      // Compare against the live registry so plugin and dynamic tools cannot be shadowed.
      const baseNames = [
        "agent_list",
        "agent_spawn",
        "ask_user_question",
        "render_html",
        "request_plugin",
        "routine_schedule",
        "skill_list",
        "skill_load",
        "skill_read",
        "session_tasks",
        "web_fetch",
        "web_search",
      ];
      if (baseNames.includes(tool.name)) {
        return { valid: false, reason: t("be_mcpGovernance.builtinToolOverwriteBlocked", { toolName: tool.name }), layer: 3 };
      }
    }

    return { valid: true };
  }

  /** Recheck server approval and the exercised capability on every request, not just registration. */
  validateRequestCapability(
    serverId: string,
    method: string,
    params?: Record<string, unknown>,
  ): ValidationResult {
    const approval = this.findApproval(serverId);
    if (!approval || approval.status !== "approved") {
      return { valid: false, reason: t("be_mcpGovernance.unapprovedServerToolRegistration", { serverId }), layer: 3 };
    }

    if (CONTROL_METHODS.has(method)) {
      return { valid: true };
    }

    // Apps reads share the client URI predicate; core resource catalogs exclude ui schemes structurally.
    if (method === "resources/read" && isMcpAppUiUri(params?.uri)) {
      return { valid: true };
    }

    const required = REQUEST_METHOD_CAPABILITY[method];
    if (required === undefined) {
      // Unknown methods remain denied until explicitly classified.
      return {
        valid: false,
        reason: `MCP server '${serverId}' sent an unclassified method '${method}' (denied; not a control method and exercises no approved capability)`,
        layer: 3,
      };
    }
    if (!approval.allowedCapabilities.includes(required)) {
      return {
        valid: false,
        reason: `MCP server '${serverId}' is not approved for the '${required}' capability (request '${method}')`,
        layer: 3,
      };
    }
    return { valid: true };
  }


  applyToolNamespace(serverId: string, toolName: string): string {
    const approval = this.findApproval(serverId);
    if (!approval) return toolName;
    const prefix = `mcp_${approval.toolNamePrefix}_`;
    return toolName.startsWith(prefix) ? toolName : `${prefix}${toolName}`;
  }

  getApproval(serverId: string): McpServerApproval | undefined {
    return this.findApproval(serverId);
  }

  isRuntimeApprovalAdmitted(approval: McpServerApproval): boolean {
    if (this.policy.servers.some((entry) => entry.id === approval.id)) return true;
    if (!approval.bundled) return false;
    if (approval.provenance === "user") return this.policy.globalRules.allowUserApprovedServers !== false;
    if (approval.provenance !== "policy-fingerprint") return false;
    return this.policy.bundledServers?.some((entry) => entry.package === approval.bundled!.package
      && entry.server === approval.bundled!.server && entry.fingerprint === approval.bundled!.fingerprint) ?? false;
  }

  policyFingerprintApproval(approval: McpServerApproval): McpServerApproval | null {
    if (!approval.bundled) return null;
    const candidate = { ...approval, provenance: "policy-fingerprint" as const };
    return this.isRuntimeApprovalAdmitted(candidate) ? candidate : null;
  }

  inadmissibleRuntimeServerIds(): string[] {
    return [...this.runtimeApprovals].filter(([, approval]) => !this.isRuntimeApprovalAdmitted(approval)).map(([id]) => id);
  }

  /** Runtime approval belongs to one host-owned generation and is never persisted. */
  registerRuntimeApproval(approval: McpServerApproval): void {
    if (!this.isRuntimeApprovalAdmitted(approval)) throw new Error("runtime approval not admitted by policy");
    if (this.policy.servers.some((entry) => entry.id === approval.id)) {
      throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
    }
    const existing = this.runtimeApprovals.get(approval.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
      throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
    }
    this.runtimeApprovals.set(approval.id, Object.freeze({ ...approval }));
  }

  unregisterRuntimeApproval(serverId: string): void {
    this.runtimeApprovals.delete(serverId);
  }

  scopedRuntimeApproval(approval: McpServerApproval): McpGovernance {
    if (!this.isRuntimeApprovalAdmitted(approval)) throw new Error("runtime approval not admitted by policy");
    if (this.policy.servers.some((entry) => entry.id === approval.id)) {
      throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
    }
    const approvals = new Map(this.runtimeApprovals);
    approvals.set(approval.id, Object.freeze({ ...approval }));
    return new McpGovernance(this.policyPath, { policy: this.policy, runtimeApprovals: approvals });
  }

  /** Publish generation approvals atomically only after preparation. */
  replaceRuntimeApprovals(
    predecessorServerIds: Iterable<string>,
    approvals: readonly McpServerApproval[],
  ): void {
    const next = new Map(this.runtimeApprovals);
    for (const serverId of predecessorServerIds) next.delete(serverId);
    for (const approval of approvals) {
      if (!this.isRuntimeApprovalAdmitted(approval)) throw new Error("runtime approval not admitted by policy");
      if (this.policy.servers.some((entry) => entry.id === approval.id)) {
        throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
      }
      const existing = next.get(approval.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
        throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
      }
      next.set(approval.id, Object.freeze({ ...approval }));
    }
    this.runtimeApprovals = next;
  }

  prepareRuntimeApprovals(
    predecessorServerIds: Iterable<string>,
    approvals: readonly McpServerApproval[],
  ): { assertAdmitted(): void; publish(): void } {
    const predecessors = Object.freeze([...predecessorServerIds]);
    const prepared = approvals.map((approval) => Object.freeze({ ...approval }));
    const next = new Map(this.runtimeApprovals);
    for (const serverId of predecessors) next.delete(serverId);
    for (const approval of prepared) {
      if (!this.isRuntimeApprovalAdmitted(approval)) throw new Error("runtime approval not admitted by policy");
      if (this.policy.servers.some((entry) => entry.id === approval.id)) {
        throw new Error(`runtime MCP approval '${approval.id}' collides with managed policy`);
      }
      const existing = next.get(approval.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
        throw new Error(`runtime MCP approval '${approval.id}' has conflicting policy`);
      }
      next.set(approval.id, approval);
    }
    let published = false;
    const assertAdmitted = () => {
        for (const approval of prepared) {
          if (!this.isRuntimeApprovalAdmitted(approval)) throw new Error("runtime approval not admitted by policy");
        }
    };
    return Object.freeze({
      assertAdmitted,
      publish: () => {
        if (published) return;
        assertAdmitted();
        for (const serverId of predecessors) this.runtimeApprovals.delete(serverId);
        for (const approval of prepared) this.runtimeApprovals.set(approval.id, approval);
        published = true;
      },
    });
  }

  private findApproval(serverId: string): McpServerApproval | undefined {
    const managed = this.policy.servers.find((s) => s.id === serverId);
    if (managed) return managed;
    const runtime = this.runtimeApprovals.get(serverId);
    return runtime && this.isRuntimeApprovalAdmitted(runtime) ? runtime : undefined;
  }

  private validateStdioCommand(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.command) {
      return { valid: false, reason: t("be_mcpGovernance.stdioCommandRequired"), layer: 1 };
    }
    const allowed = approval.allowedCommands ?? [];
    // An empty allowed-command list denies every command.
    if (allowed.length === 0 || !allowed.includes(config.command)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.disallowedCommand", { command: config.command, allowedList: allowed.join(", ") }),
        layer: 1,
      };
    }

    const dangerousArgs = ["--no-sandbox", "--disable-security", "eval(", "$(", "`"];
    for (const arg of config.args ?? []) {
      if (dangerousArgs.some((d) => arg.includes(d))) {
        return { valid: false, reason: t("be_mcpGovernance.dangerousArgDetected", { arg }), layer: 1 };
      }
    }

    return { valid: true };
  }

  private validateUrl(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.url) {
      return { valid: false, reason: t("be_mcpGovernance.transportRequiresUrl", { transport: config.transport }), layer: 1 };
    }


    for (const pattern of this.policy.globalRules.blockedUrlPatterns) {
      if (matchUrlPattern(pattern, config.url)) {
        return { valid: false, reason: t("be_mcpGovernance.blockedUrlPattern", { url: config.url, pattern }), layer: 1 };
      }
    }


    const allowed = approval.allowedUrls ?? [];
    if (allowed.length > 0) {
      const matches = allowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.disallowedUrl", { url: config.url, allowedList: allowed.join(", ") }),
          layer: 1,
        };
      }
    }


    const globalAllowed = this.policy.globalRules.allowedUrlPatterns;
    if (globalAllowed.length > 0) {
      const matches = globalAllowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.urlNotInGlobalAllowList", { url: config.url }),
          layer: 1,
        };
      }
    }

    return { valid: true };
  }




  private validateHttpScheme(rawUrl: string): ValidationResult {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { valid: false, reason: t("be_mcpGovernance.invalidUrlFormat", { rawUrl }), layer: 1 };
    }
    if (parsed.protocol === "https:") return { valid: true };
    if (parsed.protocol === "http:") {
      // Use the shared loopback predicate for every address in the loopback range.
      if (isLoopbackUrlHostname(parsed.hostname)) {
        return { valid: true };
      }
      return {
        valid: false,
        reason: t("be_mcpGovernance.httpsRequired", { rawUrl }),
        layer: 1,
      };
    }
    return {
      valid: false,
      reason: t("be_mcpGovernance.httpSchemeOnly", { rawUrl }),
      layer: 1,
    };
  }

  /** Reject header injection and invalid controls even when admin policy approved the server. */
  private validateHeaders(headers: Record<string, string> | undefined): ValidationResult {
    if (!headers) return { valid: true };
    for (const [name, value] of Object.entries(headers)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.headerCrlfForbidden", { name }),
          layer: 1,
        };
      }
      if (
        Array.from(value).some((ch) => {
          const cp = ch.charCodeAt(0);
          return cp <= 0x1f && cp !== 0x09 && cp !== 0x0a;
        })
      ) {
        return {
          valid: false,
          reason: t("be_mcpGovernance.headerControlCharForbidden", { name }),
          layer: 1,
        };
      }
    }
    return { valid: true };
  }

  private validateApiKeyEnv(
    config: McpServerConfig,
    approval: McpServerApproval,
  ): ValidationResult {
    const name = config.apiKeyEnv;
    const isApiKeyServer = config.auth === "api-key" || approval.requiredAuth === "api-key";
    if (!name) {
      if (!isApiKeyServer) return { valid: true };
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvRequired", { serverId: config.id }),
        layer: 1,
      };
    }
    if (!ENV_NAME_RE.test(name)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvInvalidName", { name }),
        layer: 1,
      };
    }
    if (name.length > MAX_NAME_LEN) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvNameTooLong", { maxLen: MAX_NAME_LEN, name }),
        layer: 1,
      };
    }
    if (RESERVED_ENV_NAMES.has(name.toUpperCase())) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyEnvReserved", { name }),
        layer: 1,
      };
    }
    if (approval.apiKeyEnv !== name) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.unapprovedApiKeyEnv", { name, approvedValue: approval.apiKeyEnv ?? "(none)" }),
        layer: 1,
      };
    }
    return { valid: true };
  }

  private validateApiKeyHeader(
    config: McpServerConfig,
    approval: McpServerApproval,
  ): ValidationResult {
    const name = config.apiKeyHeader;
    if (!name) {
      if (!approval.apiKeyHeader) return { valid: true };
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderRequired", { approvedHeader: approval.apiKeyHeader }),
        layer: 1,
      };
    }
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderInvalidName", { name }),
        layer: 1,
      };
    }
    if (name.length > MAX_NAME_LEN) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderNameTooLong", { maxLen: MAX_NAME_LEN, name }),
        layer: 1,
      };
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.apiKeyHeaderReserved", { name }),
        layer: 1,
      };
    }
    if (approval.apiKeyHeader !== name) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.unapprovedApiKeyHeader", { name, approvedValue: approval.apiKeyHeader ?? "(none)" }),
        layer: 1,
      };
    }
    return { valid: true };
  }

  /** Private-network config requires explicit global or matching-server policy approval. */
  private validateAllowPrivateNetworks(approval: McpServerApproval): ValidationResult {
    const globalOk = this.policy.globalRules.allowPrivateNetworks === true;
    const serverOk = approval.allowPrivateNetworks === true;
    if (globalOk || serverOk) return { valid: true };
    return {
      valid: false,
      reason: t("be_mcpGovernance.allowPrivateNetworksDenied", { serverId: approval.id }),
      layer: 1,
    };
  }

  private validateConnectionSecurity(config: McpServerConfig, approval: McpServerApproval): ValidationResult {


    if (
      typeof approval.connectionTimeoutMs === "number"
      && approval.connectionTimeoutMs > TOOL_TIMEOUT_POLICY.mcpRequestMaxMs
    ) {
      return {
        valid: false,
        reason: t("be_mcpGovernance.connectionTimeoutPolicyViolation", {
          serverId: approval.id,
          timeoutMs: approval.connectionTimeoutMs,
          maxMs: TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
        }),
        layer: 2,
      };
    }


    if (approval.tlsRequired && config.url) {
      const isSecure = config.url.startsWith("https://") || config.url.startsWith("wss://");
      if (!isSecure) {
        return { valid: false, reason: t("be_mcpGovernance.tlsRequired", { url: config.url }), layer: 2 };
      }
    }


    if (approval.requiredAuth !== "none") {
      if (approval.requiredAuth === "api-key" && !config.apiKey) {
        return { valid: false, reason: t("be_mcpGovernance.apiKeyRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "sso" && config.auth !== "sso") {
        return { valid: false, reason: t("be_mcpGovernance.ssoRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "oauth" && config.auth !== "oauth") {
        return { valid: false, reason: t("be_mcpGovernance.oauthRequired", { serverId: config.id }), layer: 2 };
      }
      if (approval.requiredAuth === "mtls") {
        // Unsupported client-certificate authentication must fail closed, never satisfy connection security.
        return { valid: false, reason: t("be_mcpGovernance.mtlsUnsupported", { serverId: config.id }), layer: 2 };
      }
    }

    return { valid: true };
  }
}

function matchUrlPattern(pattern: string, url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const regexStr = "^" + pattern.split("*").map(escapeRegexLiteral).join(".*") + "$";
    return new RegExp(regexStr, "i").test(hostname);
  } catch {
    return url.includes(pattern.replace(/\*/g, ""));
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
