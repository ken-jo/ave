import { randomUUID } from "node:crypto";
import type { SubscriptionConnectionEvidence, SubscriptionEvidenceSink } from "./subscription-connection-evidence.js";
// Keep subscription credentials, process transports, safe status projection, and shutdown within this main-process boundary.
import { join } from "node:path";
import type { OpenOAuthLogin } from "./oauth-login.js";
import { claimPrivateOwnership } from "./codex-executable-location.js";
import type { StreamEvent, ToolSchema } from "../engine/llm/types.js";
import {
  ACP_SUBSCRIPTION_PROVIDER_IDS,
  type AcpSubscriptionProviderId,
  type AcpSubscriptionStatus,
  isAcpSubscriptionProviderId,
} from "../shared/acp-subscription.js";
import type { CodexSubscriptionStatus } from "../shared/codex-subscription.js";
import type { SubscriptionPlanUsageUpdate, SubscriptionPlanUsageWindow } from "../shared/subscription-plan-usage.js";
import { SubscriptionPlanUsageStore } from "./subscription-plan-usage-store.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  isSubscriptionRuntimeId,
  normalizeSubscriptionUsageTelemetry,
  subscriptionRuntimeDescriptor,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionConnectionState,
  type SubscriptionLoginMethod,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeModel,
  type SubscriptionRuntimeState,
  type SubscriptionRuntimeStatus,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import {
  ClaudeCodeSubscriptionClient,
  ClaudeCodeSubscriptionError,
  claudeCodeRuntimeDirectoryNames,
} from "./claude-code-subscription-client.js";
import { configuredClaudeCodeReleaseFetch } from "./claude-code-authenticity.js";
import { ClaudeCodeConversationRuntime } from "./claude-code-conversation-runtime.js";
import {
  CodexAppServerClient,
  CodexAppServerError,
} from "./codex-app-server-client.js";
import {
  isClaudeCodeSubscriptionProviderId,
  type ClaudeCodeSubscriptionStatus,
} from "../shared/claude-code-subscription.js";
import {
  CodexUserRuntimeError,
  CodexUserRuntimeLocator,
  type CodexUserRuntimeErrorCode,
} from "./codex-user-runtime.js";
import {
  CodexConversationRuntime,
  CodexConversationRuntimeError,
  type CodexConversationRuntimeOptions,
  type CodexConversationTokenUsage,
} from "./codex-conversation-runtime.js";
import { SubscriptionToolBridge } from "./subscription-tool-bridge.js";
import { catalogChatModelIds } from "../shared/model-catalog/vendor-models.js";
import {
  AcpSubscriptionRuntimeClient,
  AcpSubscriptionRuntimeError,
} from "./acp-subscription-runtime-client.js";
import {
  acpSubscriptionRuntimeDirectoryNames,
  ensureAcpSubscriptionNativePolicy,
  AcpSubscriptionRuntimeConfigStore,
  type AcpSubscriptionMcpServerConfig,
  validateAcpSubscriptionMcpServerConfigs,
} from "./acp-subscription-runtime-config.js";
import {
  AcpSubscriptionSessionClient,
  AcpSubscriptionSessionError,
  type AcpSubscriptionHostRequestObservation,
  type AcpSubscriptionPromptHandle,
  type AcpSubscriptionSessionClientOptions,
  ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
} from "./acp-subscription-session-client.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";
import {
  projectedSubscriptionTransportDiagnosticsFromError,
  subscriptionTransportFailure,
  type SubscriptionTransportDiagnosticError,
} from "./subscription-transport-error-diagnostics.js";
import {
  DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
  SubscriptionAttachmentTransportError,
  type SubscriptionPromptAttachment,
} from "./subscription-attachment-input.js";
import {
  ChatGptPlanRuntimeError,
  configuredChatGptPlanRuntimeDeps,
  createChatGptPlanRuntime,
  notConfiguredChatGptPlanStatus,
  type ChatGptPlanRuntime,
} from "./chatgpt-plan/runtime.js";

// Renderer input selects an allowlisted runtime ID only, never command, arguments, environment, home, or cwd.

type ClientMap = Record<AcpSubscriptionProviderId, AcpSubscriptionRuntimeClient>;

export interface AcpSubscriptionTextSession {
  readonly provider: AcpSubscriptionProviderId;
  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent>;
  cancelActiveTurn(): Promise<void>;
  stop(): Promise<void>;
}

export interface AcpSubscriptionTextSessionOptions {
  readonly onPlanUsage?: (windows: readonly SubscriptionPlanUsageWindow[]) => void;
  readonly onHostRequest?: (
    request: AcpSubscriptionHostRequestObservation,
  ) => void | Promise<void>;
  // The one main-process-created Ave MCP bridge for this session. It is runtime-validated and copied before the session factory receives it.
  readonly mcpServers?: readonly AcpSubscriptionMcpServerConfig[];
}

export interface AcpSubscriptionSessionTransport {
  start(): Promise<unknown>;
  startPrompt(input: {
    readonly text: string;
    readonly abortSignal?: AbortSignal;
    readonly attachments?: readonly SubscriptionPromptAttachment[];
  }): Promise<AcpSubscriptionPromptHandle>;
  cancelActivePrompt(): Promise<void>;
  stop(): Promise<void>;
}

export type AcpSubscriptionSessionClientFactory = (
  options: AcpSubscriptionSessionClientOptions,
) => AcpSubscriptionSessionTransport;

interface ResolvedAcpSubscriptionRuntimeRegistryOptions {
  readonly namespace: FeatureNamespaceHandle;
  readonly configStore: AcpSubscriptionRuntimeConfigStore;
  readonly clients: ClientMap;
  readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
}

export interface AcpSubscriptionRuntimeRegistryOptions {
  namespace?: FeatureNamespaceHandle;
  configStore?: AcpSubscriptionRuntimeConfigStore;
  clients?: ClientMap;
  sessionClientFactory?: AcpSubscriptionSessionClientFactory;
}

export class AcpSubscriptionRuntimeRegistry {
  private readonly namespace: FeatureNamespaceHandle;
  private readonly configStore: AcpSubscriptionRuntimeConfigStore;
  private readonly clients: ClientMap;
  private readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
  private readonly textSessions = new Set<AcpSubscriptionSessionTransport>();

  private constructor(options: ResolvedAcpSubscriptionRuntimeRegistryOptions) {
    this.namespace = options.namespace;
    this.configStore = options.configStore;
    this.clients = options.clients;
    this.sessionClientFactory = options.sessionClientFactory;
  }

  static async create(
    options: AcpSubscriptionRuntimeRegistryOptions = {},
  ): Promise<AcpSubscriptionRuntimeRegistry> {
    const namespace = options.namespace ?? openFeatureNamespace("subscription-runtimes");
    const configStore = options.configStore ?? new AcpSubscriptionRuntimeConfigStore(namespace);
    const sessionClientFactory: AcpSubscriptionSessionClientFactory = options.sessionClientFactory
      ?? ((sessionOptions) => new AcpSubscriptionSessionClient(sessionOptions));
    if (options.clients) {
      return new AcpSubscriptionRuntimeRegistry({
        namespace,
        configStore,
        clients: options.clients,
        sessionClientFactory,
      });
    }
    const executablePaths = await Promise.all(
      ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => configStore.getExecutable(provider)),
    );
    const clients = {} as ClientMap;
    for (const [index, provider] of ACP_SUBSCRIPTION_PROVIDER_IDS.entries()) {
      const directories = acpSubscriptionRuntimeDirectoryNames(provider);
      clients[provider] = new AcpSubscriptionRuntimeClient({
        provider,
        runtimeHome: join(namespace.dir, directories.runtimeHome),
        workspaceDir: join(namespace.dir, directories.workspaceDir),
        runtimeTempDir: join(namespace.dir, directories.runtimeTempDir),
        executablePath: executablePaths[index] ?? null,
      });
    }
    return new AcpSubscriptionRuntimeRegistry({
      namespace,
      configStore,
      clients,
      sessionClientFactory,
    });
  }

  async getStatus(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].getStatus();
  }

  async setExecutable(provider: AcpSubscriptionProviderId, pickerPath: string): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.setExecutable(pickerPath);
    const canonicalPath = client.getConfiguredExecutable();
    if (!canonicalPath) throw new Error("acp-subscription-missing-canonical-executable");
    try {
      await this.configStore.setExecutable(provider, canonicalPath);
    } catch (error) {
      if (previous) {
        await client.setExecutable(previous);
      } else {
        await client.clearExecutable();
      }
      throw error;
    }
    return status;
  }

  async forgetExecutable(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.clearExecutable();
    try {
      await this.configStore.clearExecutable(provider);
    } catch (error) {
      if (previous) await client.setExecutable(previous);
      throw error;
    }
    return status;
  }

  // Keep ACP sessions and capabilities in the main process; permit at most the supplied host-owned MCP server.
  async openTextSession(
    provider: AcpSubscriptionProviderId,
    options: AcpSubscriptionTextSessionOptions = {},
  ): Promise<AcpSubscriptionTextSession> {
    const mcpServers = validateAcpSubscriptionMcpServerConfigs(options.mcpServers);
    const directories = await this.prepareRuntime(provider);
    const executablePath = this.clients[provider].getConfiguredExecutable();
    if (!executablePath) throw new AcpSubscriptionRuntimeError("acp-runtime-not-configured");

    const session = this.sessionClientFactory({
      provider,
      executablePath,
      runtimeHome: directories.runtimeHome,
      workspaceDir: directories.workspaceDir,
      runtimeTempDir: directories.runtimeTempDir,
      onHostRequest: options.onHostRequest,
      onPlanUsage: options.onPlanUsage,
      mcpServers,
    });
    this.textSessions.add(session);
    try {
      await session.start();
    } catch (error) {
      this.textSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Preserve the stable session start failure rather than a cleanup error.
      }
      throw error;
    }

    let stopped = false;
    return Object.freeze({
      provider,
      async *streamTurn(
        text: string,
        abortSignal?: AbortSignal,
        attachments?: readonly SubscriptionPromptAttachment[],
      ): AsyncIterable<StreamEvent> {
        const prompt = await session.startPrompt({ text, abortSignal, attachments });
        for await (const event of prompt.events) yield event;
        await prompt.completion;
      },
      cancelActiveTurn: () => session.cancelActivePrompt(),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.textSessions.delete(session);
        await session.stop();
      },
    });
  }

  async verify(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].verify();
  }

  async startDeviceCodeLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].startDeviceCodeLogin();
  }

  async openPendingVerificationUrl(
    provider: AcpSubscriptionProviderId,
    openAuthorizationUrl: OpenOAuthLogin,
  ): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].openPendingVerificationUrl(openAuthorizationUrl);
  }

  async cancelLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].cancelLogin();
  }

  async logout(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].logout();
  }

  async stopAll(): Promise<void> {
    const textSessions = [...this.textSessions];
    this.textSessions.clear();
    await Promise.all([
      ...textSessions.map((session) => session.stop()),
      ...ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => this.clients[provider].stop()),
    ]);
  }

  private async prepareRuntime(provider: AcpSubscriptionProviderId): Promise<{
    readonly runtimeHome: string;
    readonly workspaceDir: string;
    readonly runtimeTempDir: string;
  }> {
    const directoryNames = acpSubscriptionRuntimeDirectoryNames(provider);
    const [runtimeHome, workspaceDir, runtimeTempDir] = await Promise.all([
      this.namespace.childDir(directoryNames.runtimeHome),
      this.namespace.childDir(directoryNames.workspaceDir),
      this.namespace.childDir(directoryNames.runtimeTempDir),
    ]);
    await ensureAcpSubscriptionNativePolicy(provider, runtimeHome);
    return Object.freeze({ runtimeHome, workspaceDir, runtimeTempDir });
  }
}

const MAX_QUEUED_EVENTS = 256;
const HOST_TOOL_ACCEPTED = "Ave accepted the host tool request and will provide its result in the next model round.";

export type SubscriptionOpenAuthorizationUrl = OpenOAuthLogin;

// A redacted audit observation: never include prompt, path, command, or RPC params.
export interface SubscriptionRuntimeAuditEvent {
  readonly provider: SubscriptionRuntimeId;
  readonly outcome: "host-request-rejected" | "model-fallback" | "session-failed";
  readonly requestKind?: string;
}

export type SubscriptionRuntimeAuditSink = (
  event: SubscriptionRuntimeAuditEvent,
) => void | Promise<void>;

export class SubscriptionRuntimeServiceError extends Error {
  constructor(
    readonly code: SubscriptionRuntimeErrorCode,
    readonly providerError?: SubscriptionTransportDiagnosticError["providerError"],
  ) {
    super(code);
    this.name = "SubscriptionRuntimeServiceError";
  }
}

export interface SubscriptionTextSession {
  readonly provider: SubscriptionRuntimeId;
  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent>;
  cancelActiveTurn(): Promise<void>;
  stop(): Promise<void>;
}

// Main-only schemas for one model round; never sourced from renderer IPC.
export interface SubscriptionTextSessionOptions {
  readonly tools?: readonly ToolSchema[];
  // Settings-normalized parent selection for a transient sub-agent Codex candidate. It is considered only after the current live catalog rejects that
  // candidate; catalog lookup failures remain fail-closed.
  readonly fallbackSelection?: SubscriptionChatRuntimeSelection;
}

interface CodexTextRuntimePaths {
  readonly runtimeHome: string;
  readonly sqliteHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
  readonly resolveRuntime: CodexConversationRuntimeOptions["resolveRuntime"];
}

// The part of the user-CLI locator the service drives; a seam for tests.
type CodexRuntimeLocator = Pick<CodexUserRuntimeLocator, "resolve" | "lastKnownVersion" | "dispose">;

export interface SubscriptionRuntimeServiceCreateOptions {
  readonly namespace?: FeatureNamespaceHandle;
  // Test seam; production always constructs the packaged account client.
  readonly createCodexAppServerClient?: (
    options: ConstructorParameters<typeof CodexAppServerClient>[0],
  ) => CodexAppServerClient;
  readonly codexClient?: CodexAppServerClient;
  // Test seam; production locates the user's own `codex` CLI.
  readonly codexRuntimeLocator?: CodexRuntimeLocator;
  readonly acpRegistry?: AcpSubscriptionRuntimeRegistry;
  readonly claudeCodeClient?: ClaudeCodeSubscriptionClient;
  /** Release-metadata transport for the production Claude Code client. Defaults to the boot-configured host network stack; having neither fails creation. */
  readonly claudeCodeReleaseFetch?: typeof fetch;
  readonly createCodexConversationRuntime?: (
    options: CodexConversationRuntimeOptions,
  ) => CodexConversationRuntime;
  readonly createClaudeCodeConversationRuntime?: (
    options: ConstructorParameters<typeof ClaudeCodeConversationRuntime>[0],
  ) => ClaudeCodeConversationRuntime;
  readonly audit?: SubscriptionRuntimeAuditSink;
  /** Plan usage runs no CLI. Null means boot configured no secret store or network stack, and the runtime reports not-configured. Defaults to the boot-configured runtime. */
  readonly chatGptPlanRuntime?: ChatGptPlanRuntime | null;
  // Test seam for a namespace whose directories do not exist. Production claims every runtime directory for the current account (see {@link claimPrivateOwnership}).
  readonly claimRuntimeDirectories?: (paths: readonly string[]) => Promise<void>;
}

export interface GetSubscriptionRuntimeServiceOptions {
  readonly audit?: SubscriptionRuntimeAuditSink;
}

function isConnectedAndReady(status: {
  readonly runtime: SubscriptionRuntimeState;
  readonly connection: SubscriptionConnectionState;
}): boolean {
  return status.runtime === "ready" && status.connection === "connected";
}

function observedConnection(status: {
  readonly runtime: SubscriptionRuntimeState;
  readonly connection: SubscriptionConnectionState;
}): SubscriptionConnectionState {
  return status.runtime === "unavailable" && status.connection === "connected" ? "unknown" : status.connection;
}

// The same native prompt budget governs capabilities and request construction.
export function getSubscriptionImageAttachmentLimits(runtimeId: SubscriptionRuntimeId) {
  return runtimeId === "codex" || runtimeId === "chatgpt-plan"
    ? DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS
    : ACP_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS;
}

// Every non-credential capability is exposed only after the host transport proof.
function verifiedRuntimeCapabilities(
  runtimeId: SubscriptionRuntimeId,
  verified: boolean,
  supportsImages = false,
): SubscriptionRuntimeCapabilities {
  if (!verified) {
    return DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES;
  }
  const imageAttachmentLimits = runtimeId === "codex" || supportsImages
    ? getSubscriptionImageAttachmentLimits(runtimeId)
    : null;
  return Object.freeze({
    chat: true,
    // Codex has a documented localImage turn input. ACP runtimes must instead prove the standard image content block in their initialize response.
    images: imageAttachmentLimits !== null,
    imageAttachmentLimits,
    // This is deliberately not raw file-upload parity. The renderer's normal FileAttachment marker remains paired with the governed Ave read tool.
    files: true,
    tools: true,
    projectAccess: true,
    plugins: true,
    mcp: true,
    generateText: true,
    compaction: true,
    routine: true,
    subagent: true,
  });
}

function codexStatus(
  status: CodexSubscriptionStatus,
  safelyVerified: boolean,
): SubscriptionRuntimeStatus {
  return {
    provider: "codex",
    runtime: status.runtime,
    connection: observedConnection(status),
    planType: status.planType,
    pendingLogin: status.pendingLogin,
    pendingDeviceCode: status.pendingDeviceCode,
    // Codex opens only allowlisted URLs as part of the managed login request; the URL is intentionally never retained for a renderer re-open action.
    canOpenVerificationUrl: false,
    version: status.version,
    capabilities: verifiedRuntimeCapabilities("codex", safelyVerified && isConnectedAndReady(status)),
  };
}

function acpRuntimeState(status: AcpSubscriptionStatus): SubscriptionRuntimeState {
  return status.runtime;
}

function acpStatus(
  status: AcpSubscriptionStatus,
  safelyVerified: boolean,
): SubscriptionRuntimeStatus {
  return {
    provider: status.provider,
    runtime: acpRuntimeState(status),
    connection: observedConnection(status),
    planType: null,
    pendingLogin: status.pendingLogin,
    pendingDeviceCode: status.pendingDeviceCode,
    canOpenVerificationUrl: status.canOpenVerificationUrl,
    version: status.version,
    capabilities: verifiedRuntimeCapabilities(
      status.provider,
      safelyVerified && isConnectedAndReady(status),
      status.promptCapabilities.image,
    ),
  };
}

function isAcpRuntime(runtimeId: SubscriptionRuntimeId): runtimeId is AcpSubscriptionProviderId {
  return isAcpSubscriptionProviderId(runtimeId);
}

function validSelection(
  selection: SubscriptionChatRuntimeSelection,
): SubscriptionChatRuntimeSelection | null {
  if (selection.kind !== "subscription" || !isSubscriptionRuntimeId(selection.provider)) return null;
  if (selection.model === undefined) {
    return Object.freeze({ kind: "subscription", provider: selection.provider });
  }
  if (!subscriptionRuntimeDescriptor(selection.provider).supportsModelSelection) return null;
  const model = selection.model.trim();
  if (
    !model
    || model.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(model)
  ) {
    return null;
  }
  return Object.freeze({ kind: "subscription", provider: selection.provider, model });
}

function abortError(): Error {
  const error = new Error("subscription-runtime-aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// Publisher verification must use the host network stack; there is no fallback to the process-global fetch.
function requireClaudeCodeReleaseFetch(supplied: typeof fetch | undefined): typeof fetch {
  const releaseFetch = supplied ?? configuredClaudeCodeReleaseFetch();
  if (!releaseFetch) throw new Error("Claude Code release verification transport is not configured; boot must call configureClaudeCodeReleaseFetch first");
  return releaseFetch;
}

// The renderer-safe meaning of a user-CLI resolution failure.
function codexRuntimeErrorCode(
  code: CodexUserRuntimeErrorCode | "codex-runtime-not-configured",
): SubscriptionRuntimeErrorCode {
  switch (code) {
    case "codex-runtime-not-installed":
    case "codex-runtime-not-configured":
      return "subscription-runtime-not-configured";
    case "codex-runtime-version-unsupported":
      return "subscription-runtime-version-unsupported";
    case "codex-runtime-incompatible":
      return "subscription-runtime-incompatible";
    case "codex-runtime-unsafe-location":
      return "subscription-runtime-unsafe-location";
    case "codex-runtime-invalid-executable":
    case "codex-runtime-start-failed":
      return "subscription-runtime-unavailable";
  }
}

// Maps every provider-specific failure to the stable renderer-safe union.
export function subscriptionRuntimeErrorCode(error: unknown): SubscriptionRuntimeErrorCode {
  if (error instanceof SubscriptionRuntimeServiceError) return error.code;
  if (error instanceof ChatGptPlanRuntimeError) return error.code;
  if (error instanceof CodexUserRuntimeError) return codexRuntimeErrorCode(error.code);
  if (error instanceof CodexAppServerError) {
    switch (error.code) {
      case "codex-runtime-not-configured":
      case "codex-runtime-invalid-executable":
      case "codex-runtime-unsafe-location":
      case "codex-runtime-version-unsupported":
      case "codex-runtime-incompatible":
        return codexRuntimeErrorCode(error.code);
      case "codex-runtime-unavailable":
      case "codex-runtime-start-failed":
        return "subscription-runtime-unavailable";
      case "codex-login-in-progress":
        return "subscription-login-in-progress";
      case "codex-login-failed":
        return "subscription-login-failed";
      default:
        return "subscription-operation-failed";
    }
  }
  if (error instanceof CodexConversationRuntimeError) {
    return error.code === "codex-runtime-unavailable" || error.code === "codex-runtime-start-failed"
      ? "subscription-runtime-unavailable"
      : "subscription-operation-failed";
  }
  if (error instanceof AcpSubscriptionRuntimeError) {
    switch (error.code) {
      case "acp-runtime-not-configured":
        return "subscription-runtime-not-configured";
      case "acp-runtime-unavailable":
      case "acp-runtime-invalid-executable":
        return "subscription-runtime-unavailable";
      case "acp-login-in-progress":
        return "subscription-login-in-progress";
      case "acp-login-failed":
        return "subscription-login-failed";
      case "acp-verification-url-unavailable":
        return "subscription-verification-url-unavailable";
      case "acp-logout-not-supported":
        return "subscription-logout-not-supported";
      default:
        return "subscription-operation-failed";
    }
  }
  if (error instanceof AcpSubscriptionSessionError) {
    return error.code === "acp-session-authentication-required"
      ? "subscription-chat-unavailable"
      : "subscription-operation-failed";
  }
  if (error instanceof ClaudeCodeSubscriptionError) {
    switch (error.code) {
      case "claude-code-runtime-not-configured":
        return "subscription-runtime-not-configured";
      case "claude-code-runtime-incompatible":
        return "subscription-runtime-incompatible";
      case "claude-code-runtime-unsafe-location":
        return "subscription-runtime-unsafe-location";
      case "claude-code-runtime-native-required":
        return "subscription-runtime-native-required";
      case "claude-code-runtime-unauthenticated":
        return "subscription-runtime-unauthenticated";
      case "claude-code-runtime-release-metadata-unavailable":
        return "subscription-runtime-release-metadata-unavailable";
      case "claude-code-runtime-version-unsupported":
        return "subscription-runtime-version-unsupported";
      case "claude-code-runtime-unverified":
        return "subscription-chat-unavailable";
      case "claude-code-runtime-unavailable":
      case "claude-code-runtime-invalid-executable":
        return "subscription-runtime-unavailable";
      case "claude-code-login-in-progress":
        return "subscription-login-in-progress";
      case "claude-code-login-failed":
        return "subscription-login-failed";
      default:
        return "subscription-operation-failed";
    }
  }
  return "subscription-operation-failed";
}

function stableError(error: unknown): Error {
  // Attachment transport failures are already fixed, local boundary codes. Preserve them to SubscriptionLlmProvider so size/capability feedback stays
  // actionable without exposing runtime output or protocol detail.
  if (
    error instanceof SubscriptionRuntimeServiceError
    || error instanceof SubscriptionAttachmentTransportError
  ) {
    return error;
  }
  return new SubscriptionRuntimeServiceError(
    subscriptionRuntimeErrorCode(error),
    projectedSubscriptionTransportDiagnosticsFromError(error),
  );
}

// Preserve sanitized transport recovery facts; other diagnostic failures must invalidate the session safety proof and throw.
function transportDiagnosticFailure(error: unknown): Extract<StreamEvent, { type: "error" }> | undefined {
  const providerError = projectedSubscriptionTransportDiagnosticsFromError(error);
  return providerError && !providerError.transport
    ? {
      type: "error",
      error: "Subscription runtime operation failed.",
      providerError,
    }
    : undefined;
}

// Convert the already-sanitized Codex `last` snapshot into non-billable SOT.
function codexReportedSubscriptionUsage(
  selection: SubscriptionChatRuntimeSelection,
  usage: CodexConversationTokenUsage,
): SubscriptionUsageTelemetry | undefined {
  return normalizeSubscriptionUsageTelemetry({
    provider: "codex",
    model: selection.model ?? "default",
    source: "provider-reported",
    billable: false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningOutputTokens }
      : {}),
    ...(usage.modelContextWindow !== undefined ? { contextWindow: usage.modelContextWindow } : {}),
  });
}

// Bounded single-consumer bridge from callback-style Codex events.
class SubscriptionEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason: Error) => void;
  } | null = null;
  private completed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.completed || this.failure) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
    if (this.values.length > MAX_QUEUED_EVENTS) {
      this.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
    }
  }

  finish(): void {
    if (this.completed || this.failure) return;
    this.completed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: Error): void {
    if (this.failure) return;
    // A late native-host rejection or transport failure must invalidate a scheduled tool boundary rather than letting already-buffered events run.
    this.completed = false;
    this.values.length = 0;
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.completed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

class CodexSubscriptionTextSession implements SubscriptionTextSession {
  readonly provider = "codex" as const;
  private stopped = false;

  constructor(
    private readonly runtime: CodexConversationRuntime,
    private readonly selection: SubscriptionChatRuntimeSelection,
    private readonly onUnsafeRequest: (kind: string) => void,
    private readonly bridge: SubscriptionToolBridge,
  ) {}

  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    return this.stream(text, abortSignal, attachments);
  }

  async cancelActiveTurn(): Promise<void> {
    if (this.stopped || !this.runtime.isTurnActive()) return;
    try {
      await this.runtime.interrupt();
    } catch {
      this.runtime.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.runtime.stop();
    await this.bridge.stop();
  }

  private async *stream(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    if (this.stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    if (abortSignal?.aborted) throw abortError();

    const queue = new SubscriptionEventQueue<StreamEvent>();
    let completed = false;
    let toolBoundary = false;
    let aborted = false;
    let unsafeRequest = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Cancellation is terminal at the host boundary. Do not wait for a provider to acknowledge it before rejecting buffered or late output.
      queue.fail(abortError());
      void this.cancelActiveTurn().catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.bridge.setHandler((call) => {
      if (toolBoundary || aborted || unsafeRequest || this.stopped) {
        throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
      }
      toolBoundary = true;
      // Return the protocol response first, then end this remote turn. The engine executes the emitted call through its normal ToolExecutor and starts a fresh
      // remote turn containing the Ave tool_result.
      setImmediate(() => {
        if (unsafeRequest) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed",
            subscriptionTransportFailure({ phase: "native-request", kind: "protocol" })));
          return;
        }
        if (aborted || this.stopped) return;
        queue.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        queue.push({ type: "message_complete", stopReason: "tool_use" });
        queue.finish();
        void this.cancelActiveTurn().catch(() => undefined);
      });
      return HOST_TOOL_ACCEPTED;
    });

    const turn = this.runtime.startTurn(
      {
        text,
        ...(attachments?.length ? { attachments } : {}),
        ...(this.selection.model ? { model: this.selection.model } : {}),
        ...(abortSignal ? { abortSignal } : {}),
        dynamicTools: this.bridge.tools,
      },
      {
        onTextDelta: (event) => {
          if (!toolBoundary && !aborted) queue.push({ type: "text_delta", text: event.delta });
        },
        onReasoningDelta: (event) => {
          if (!toolBoundary && !aborted) queue.push({ type: "reasoning_delta", text: event.delta });
        },
        onServerRequest: (request) => {
          // App Server invokes onServerRequest before its dedicated dynamic callback. Native and future reverse RPC remain deny-only.
          if (request.kind === "dynamic-tool") return;
          unsafeRequest = true;
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed",
            subscriptionTransportFailure({ phase: "native-request", kind: "protocol" })));
          this.onUnsafeRequest(request.kind);
          this.runtime.stop();
        },
        onDynamicToolCall: (call) => this.bridge.invoke(call.tool, call.arguments),
      },
    );
    void turn.then(
      (result) => {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        if (toolBoundary) {
          if (unsafeRequest) {
            queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed",
              subscriptionTransportFailure({ phase: "native-request", kind: "protocol" })));
            return;
          }
          completed = true;
          return;
        }
        if (result.status === "completed") {
          completed = true;
          const subscriptionUsage = result.tokenUsage
            ? codexReportedSubscriptionUsage(this.selection, result.tokenUsage)
            : undefined;
          queue.push({
            type: "message_complete",
            stopReason: "end_turn",
            ...(subscriptionUsage ? { subscriptionUsage } : {}),
          });
          queue.finish();
          return;
        }
        const diagnosticFailure = transportDiagnosticFailure(result);
        if (diagnosticFailure) {
          completed = true;
          queue.push(diagnosticFailure);
          queue.finish();
          return;
        }
        queue.fail(result.status === "interrupted"
          ? abortError()
          : stableError(result));
      },
      (error: unknown) => {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        if (!toolBoundary || unsafeRequest) {
          const diagnosticFailure = aborted ? undefined : transportDiagnosticFailure(error);
          if (diagnosticFailure) {
            completed = true;
            queue.push(diagnosticFailure);
            queue.finish();
            return;
          }
          queue.fail(aborted || isAbortError(error) ? abortError() : stableError(error));
        }
      },
    );

    try {
      for await (const event of queue) yield event;
    } finally {
      this.bridge.setHandler(null);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!completed && (!toolBoundary || unsafeRequest)) await this.cancelActiveTurn();
    }
  }
}

// Wrap an ACP session so only the Ave-owned MCP bridge can emit tool calls.
class BridgedAcpSubscriptionTextSession implements SubscriptionTextSession {
  readonly provider: AcpSubscriptionTextSession["provider"];
  private stopped = false;

  constructor(
    private readonly session: AcpSubscriptionTextSession,
    private readonly bridge: SubscriptionToolBridge,
    private readonly isUnsafeHostRequest: () => boolean,
  ) {
    this.provider = session.provider;
  }

  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    return this.stream(text, abortSignal, attachments);
  }

  async cancelActiveTurn(): Promise<void> {
    if (this.stopped) return;
    await this.session.cancelActiveTurn();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.session.stop();
    } finally {
      await this.bridge.stop();
    }
  }

  private async *stream(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    if (this.stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    if (abortSignal?.aborted) throw abortError();

    const queue = new SubscriptionEventQueue<StreamEvent>();
    let completed = false;
    let toolBoundary = false;
    let aborted = false;
    let transportFailed = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Cancellation is terminal at the host boundary. Do not wait for a provider to acknowledge it before rejecting buffered or late output.
      queue.fail(abortError());
      void this.cancelActiveTurn().catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.bridge.setHandler((call) => {
      if (toolBoundary || aborted || transportFailed || this.isUnsafeHostRequest() || this.stopped) {
        throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
      }
      toolBoundary = true;
      setImmediate(() => {
        if (transportFailed || this.isUnsafeHostRequest()) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
          return;
        }
        if (aborted || this.stopped) return;
        queue.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        queue.push({ type: "message_complete", stopReason: "tool_use" });
        queue.finish();
        void this.cancelActiveTurn().catch(() => undefined);
      });
      return HOST_TOOL_ACCEPTED;
    });

    void (async () => {
      try {
        for await (const event of this.session.streamTurn(text, abortSignal, attachments)) {
          if (!toolBoundary && !aborted) queue.push(event);
        }
        if (!aborted && !toolBoundary && !transportFailed && !this.isUnsafeHostRequest()) {
          completed = true;
          queue.finish();
        } else if (!aborted && this.isUnsafeHostRequest()) {
          queue.fail(new SubscriptionRuntimeServiceError("subscription-operation-failed"));
        }
      } catch (error) {
        if (aborted) {
          queue.fail(abortError());
          return;
        }
        transportFailed = true;
        const diagnosticFailure = transportDiagnosticFailure(error);
        if (diagnosticFailure) {
          completed = true;
          queue.push(diagnosticFailure);
          queue.finish();
          return;
        }
        queue.fail(stableError(error));
      }
    })();

    try {
      for await (const event of queue) yield event;
    } finally {
      this.bridge.setHandler(null);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!completed && (!toolBoundary || transportFailed || this.isUnsafeHostRequest())) await this.cancelActiveTurn();
    }
  }
}

// Settings reads, including the renderer's composer gate, may reuse a settled read this long; a user's "check again" and main's own chat-open and selection checks read live.
const SETTINGS_READ_CACHE_TTL_MS = 5 * 60_000;

export interface SubscriptionReadOptions {
  readonly allowCached?: boolean;
}

type SubscriptionRuntimeCatalog = {
  status: SubscriptionRuntimeStatus;
  models: SubscriptionRuntimeModel[];
};

type CachedRead<T> = { readonly value: T; readonly expiresAt: number };
type CliProvider = "codex" | "claude-code";

type PendingLoginProjection = Pick<SubscriptionRuntimeStatus, "pendingLogin" | "pendingDeviceCode">;
type AccountStatus = Omit<SubscriptionRuntimeStatus, keyof PendingLoginProjection>;

const NO_PENDING_LOGIN: PendingLoginProjection = Object.freeze({ pendingLogin: null, pendingDeviceCode: null });

type HostConnection = {
  intent: number;
  busy: number;
  generation: number;
  latch: number;
  acceptedRead: number;
  failedRead: number;
  artifact: string | null;
  source?: object;
  accountKey?: string;
  status: AccountStatus;
  login: PendingLoginProjection;
  // Once attempt receipts arrive, only the client that owns the attempt can change its projection.
  loginAttempt?: object | null;
  revision: number;
  scope: string;
  safetyEpoch: number;
  proven: boolean;
  // The host auth home owns the pending confirmation and its timer.
  target?: { attempts: number; timer?: ReturnType<typeof setTimeout> };
  confirming: boolean;
};

function isCliProvider(provider: SubscriptionRuntimeId): provider is CliProvider {
  return provider === "codex" || provider === "claude-code";
}

type VerificationSample = { proven: boolean; project: () => SubscriptionRuntimeStatus };

function isSettledStatus(status: SubscriptionRuntimeStatus): boolean {
  return status.connection !== "pending" && status.pendingLogin === null;
}

// Main-process-only facade. It is the only owner of authenticated runtime state and live governed model sessions. Chat availability is intentionally
// stricter than authentication: it becomes true only after safety verification.
export class SubscriptionRuntimeService {
  private readonly planUsage = new SubscriptionPlanUsageStore();
  private readonly safelyVerified = new Set<SubscriptionRuntimeId>();
  private readonly safetyEpochByProvider = new Map<SubscriptionRuntimeId, number>();
  private readonly activeSessions = new Set<SubscriptionTextSession>();
  private readonly cachedStatuses = new Map<SubscriptionRuntimeId, CachedRead<SubscriptionRuntimeStatus>>();
  private readonly cachedCatalogs = new Map<SubscriptionRuntimeId, CachedRead<SubscriptionRuntimeCatalog>>();
  private readonly readGenerationByProvider = new Map<SubscriptionRuntimeId, number>();
  private readonly authChangeRevisionByProvider = new Map<SubscriptionRuntimeId, number>();
  private readonly mutationsInFlight = new Map<SubscriptionRuntimeId, number>();
  private readonly connections = new Map<SubscriptionRuntimeId, HostConnection>();
  private sequence = 0;
  // Terminal per-instance guard for callers that retained a service reference during shutdown.
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  private constructor(
    private readonly codexClient: CodexAppServerClient,
    private readonly codexRuntimeLocator: CodexRuntimeLocator,
    private readonly acpRegistry: AcpSubscriptionRuntimeRegistry,
    private readonly claudeCodeClient: ClaudeCodeSubscriptionClient,
    private readonly codexTextRuntimePaths: CodexTextRuntimePaths,
    private readonly createCodexConversationRuntime: (
      options: CodexConversationRuntimeOptions,
    ) => CodexConversationRuntime,
    private readonly createClaudeCodeConversationRuntime: (
      options: ConstructorParameters<typeof ClaudeCodeConversationRuntime>[0],
    ) => ClaudeCodeConversationRuntime,
    private readonly audit?: SubscriptionRuntimeAuditSink,
    private readonly chatGptPlan: ChatGptPlanRuntime | null = null,
  ) {
    this.codexClient.connectionEvidence = this.evidenceSink("codex");
    this.claudeCodeClient.connectionEvidence = this.evidenceSink("claude-code");
    this.chatGptPlan?.onConnectionLost(() => this.disconnect("chatgpt-plan"));
  }

  static async create(
    openAuthorizationUrl: SubscriptionOpenAuthorizationUrl,
    options: SubscriptionRuntimeServiceCreateOptions = {},
  ): Promise<SubscriptionRuntimeService> {
    let created: SubscriptionRuntimeService | undefined;
    // Resolved before any directory, registry or client is made, so a creation attempted before boot configured the transport leaves nothing behind
    // and the lazy getter's next call starts clean.
    const claudeCodeReleaseFetch = options.claudeCodeClient ? null : requireClaudeCodeReleaseFetch(options.claudeCodeReleaseFetch);
    const namespace = options.namespace ?? openFeatureNamespace("subscription-runtimes");
    const claudeDirs = claudeCodeRuntimeDirectoryNames();
    const [
      codexHome,
      codexSqlite,
      loginWorkspace,
      loginTemp,
      textWorkspace,
      textTemp,
      registry,
      claudeHome,
      claudeWorkspace,
      claudeTemp,
    ] = await Promise.all([
      namespace.childDir("codex-v3-home"),
      namespace.childDir("codex-v3-sqlite"),
      namespace.childDir("codex-login-v2-workspace"),
      namespace.childDir("codex-login-v2-tmp"),
      namespace.childDir("codex-text-v2-workspace"),
      namespace.childDir("codex-text-v2-tmp"),
      options.acpRegistry ? Promise.resolve(options.acpRegistry) : AcpSubscriptionRuntimeRegistry.create({ namespace }),
      namespace.childDir(claudeDirs.runtimeHome),
      namespace.childDir(claudeDirs.workspaceDir),
      namespace.childDir(claudeDirs.runtimeTempDir),
    ]);
    const codexRuntimeDirectory = await namespace.childDir("codex-v3-home/runtime");
    // Reclaim persistent directories left administrator-owned by prior elevated runs; refuse foreign-owned directories unchanged.
    await (options.claimRuntimeDirectories ?? claimPrivateOwnership)([
      codexHome, codexRuntimeDirectory, codexSqlite, loginWorkspace, loginTemp, textWorkspace, textTemp,
      claudeHome, claudeWorkspace, claudeTemp,
    ]);
    const codexRuntimeLocator: CodexRuntimeLocator = options.codexRuntimeLocator ?? new CodexUserRuntimeLocator({
      runtimeHome: codexHome,
      runtimeDirectory: codexRuntimeDirectory,
      sqliteHome: codexSqlite,
      workspaceDir: loginWorkspace,
      runtimeTempDir: loginTemp,
    });
    const createCodexAppServerClient = options.createCodexAppServerClient
      ?? ((clientOptions: ConstructorParameters<typeof CodexAppServerClient>[0]) => new CodexAppServerClient(clientOptions));
    const codexClient = options.codexClient ?? createCodexAppServerClient({
      runtimeHome: codexHome,
      sqliteHome: codexSqlite,
      workspaceDir: loginWorkspace,
      runtimeTempDir: loginTemp,
      openAuthorizationUrl,
      resolveRuntime: () => codexRuntimeLocator.resolve(),
      lastKnownVersion: () => codexRuntimeLocator.lastKnownVersion(),
      onPlanUsage: (windows) => created?.recordPlanUsage("codex", windows),
    });
    const planDeps = configuredChatGptPlanRuntimeDeps();
    const chatGptPlanRuntime = options.chatGptPlanRuntime !== undefined
      ? options.chatGptPlanRuntime
      : planDeps
        ? createChatGptPlanRuntime(planDeps, openAuthorizationUrl)
        : null;
    const claudeCodeClient = options.claudeCodeClient ?? new ClaudeCodeSubscriptionClient({
      runtimeHome: claudeHome,
      workspaceDir: claudeWorkspace,
      runtimeTempDir: claudeTemp,
      openAuthorizationUrl,
      releaseFetch: claudeCodeReleaseFetch!,
    });
    created = new SubscriptionRuntimeService(
      codexClient,
      codexRuntimeLocator,
      registry,
      claudeCodeClient,
      Object.freeze({
        runtimeHome: codexHome,
        sqliteHome: codexSqlite,
        workspaceDir: textWorkspace,
        runtimeTempDir: textTemp,
        resolveRuntime: () => codexRuntimeLocator.resolve(),
      }),
      options.createCodexConversationRuntime ?? ((runtimeOptions) => new CodexConversationRuntime(runtimeOptions)),
      options.createClaudeCodeConversationRuntime
        ?? ((runtimeOptions) => new ClaudeCodeConversationRuntime(runtimeOptions)),
      options.audit,
      chatGptPlanRuntime,
    );
    return created;
  }

  // Read-only status. A connected account remains unavailable until verify() proves isolation.
  async getStatus(
    runtimeId: SubscriptionRuntimeId,
    options: SubscriptionReadOptions = {},
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (isCliProvider(runtimeId)) return this.readCliStatus(runtimeId, options);
    // Browser sign-in can remain open while the card polls its pending state.
    if (runtimeId === "chatgpt-plan" && this.mutationsInFlight.has(runtimeId)) {
      const revision = this.authChangeRevisionByProvider.get(runtimeId);
      const status = await this.chatGptPlanStatus();
      this.assertRunning();
      if (status.connection === "pending" && this.mutationsInFlight.has(runtimeId)
        && revision === this.authChangeRevisionByProvider.get(runtimeId)) return status;
      throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
    }
    return this.withStableErrors(() => this.readThrough(this.cachedStatuses, runtimeId, options, async () => {
      if (runtimeId === "chatgpt-plan") {
        const status = await this.chatGptPlanStatus();
        return () => status;
      }
      const status = await this.acpRegistry.getStatus(runtimeId);
      return () => this.projectAcpStatus(status);
    }, (status) => status, (_, status) => status));
  }

  async isConnected(runtimeId: SubscriptionRuntimeId): Promise<boolean> {
    await this.getStatus(runtimeId, { allowCached: true });
    return this.connectionHasAuthority(runtimeId, this.connection(runtimeId).status);
  }

  /** Drop settled reads kept for settings surfaces, e.g. after a settings change for this provider. */
  invalidateCachedReads(runtimeId: SubscriptionRuntimeId): void {
    this.cachedStatuses.delete(runtimeId);
    this.cachedCatalogs.delete(runtimeId);
    this.readGenerationByProvider.set(runtimeId, this.readGeneration(runtimeId) + 1);
  }

  // Error projection without forcing a new runtime start or credential refresh.
  async getCachedStatus(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus | undefined> {
    if (this.stopped) return undefined;
    if (isCliProvider(runtimeId)) return this.currentProjection(runtimeId);
    if (runtimeId === "chatgpt-plan") {
      const state = this.connections.get(runtimeId);
      return state ? { ...state.status, ...state.login, revision: state.revision } : undefined;
    }
    return this.cachedStatuses.get(runtimeId)?.value;
  }

  private failedProbeStatus(runtimeId: SubscriptionRuntimeId, version?: string | null): AccountStatus {
    return {
      provider: runtimeId,
      runtime: "unavailable",
      connection: "unknown",
      planType: null,
      canOpenVerificationUrl: false,
      version: version ?? null,
      capabilities: DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
    };
  }

  // Point a runtime at an executable the user picked. Only the ACP runtimes take one: Ave finds the `codex` and `claude` CLIs itself, and those runtimes
  // have no user-chosen path to set or forget.
  async chooseExecutable(
    runtimeId: SubscriptionRuntimeId,
    pickerPath: string,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
    return this.mutating(runtimeId, () => this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.setExecutable(runtimeId, pickerPath),
    )));
  }

  async forgetExecutable(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
    return this.mutating(runtimeId, () => this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.forgetExecutable(runtimeId),
    )));
  }

  // Authenticate, then prove the provider's isolated governed transport is safe to use.
  async verify(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (isCliProvider(runtimeId) ? this.connection(runtimeId).busy : this.mutationsInFlight.has(runtimeId)) {
      throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
    }
    if (runtimeId === "chatgpt-plan") return this.getStatus(runtimeId);
    const start = ++this.sequence;
    const hadProof = this.hasSafetyProof(runtimeId);
    const verificationEpoch = this.invalidateSafety(runtimeId);
    if (hadProof && isCliProvider(runtimeId)) this.publishConnection(runtimeId);
    const assertCurrent = () => {
      this.assertRunning();
      if (!this.safetyEpochIsCurrent(runtimeId, verificationEpoch)) {
        throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
      }
    };
    await this.stopSessionsFor(runtimeId);
    assertCurrent();
    const sample = await this.verifyRuntime(runtimeId, assertCurrent).catch((error: unknown) => {
      if (isAcpRuntime(runtimeId) && this.safetyEpochIsCurrent(runtimeId, verificationEpoch)) this.disconnect(runtimeId);
      throw error;
    });
    if (isCliProvider(runtimeId)) {
      const state = this.connection(runtimeId);
      if (sample.proven) assertCurrent();
      if (state.status.connection !== "connected") return this.currentProjection(runtimeId);
      assertCurrent();
      if (sample.proven && !state.busy) {
        state.proven = true;
        this.publishConnection(runtimeId);
        this.cachedStatuses.set(runtimeId, this.cachedRead(this.currentProjection(runtimeId)));
      }
      return this.currentProjection(runtimeId);
    }
    assertCurrent();
    if (sample.proven) {
      this.safelyVerified.add(runtimeId);
      notifyStatusChanged(runtimeId);
    }
    const status = this.observeIndependentStatus(runtimeId, start, sample.project());
    if (isSettledStatus(status)) {
      this.cachedStatuses.set(runtimeId, this.cachedRead(status));
    }
    return status;
  }

  private async verifyRuntime(
    runtimeId: Exclude<SubscriptionRuntimeId, "chatgpt-plan">,
    assertCurrent: () => void,
  ): Promise<VerificationSample> {
    return this.withStableErrors(async () => {
      if (runtimeId === "codex") {
        const status = await this.codexClient.getStatus();
        const project = () => this.projectCodexStatus(status);
        if (!isConnectedAndReady(status)) return { proven: false, project };
        assertCurrent();
        const runtime = this.createCodexConversationRuntime({
          ...this.codexTextRuntimePaths, connectionEvidence: this.evidenceSink("codex", true),
        });
        try {
          await runtime.verifyIsolation();
        } finally {
          runtime.stop();
        }
        return { proven: true, project };
      }
      if (isClaudeCodeSubscriptionProviderId(runtimeId)) {
        const status = await this.claudeCodeClient.verify();
        return { proven: isConnectedAndReady(status), project: () => this.projectClaudeCodeStatus(status) };
      }
      const status = await this.acpRegistry.verify(runtimeId);
      return { proven: isConnectedAndReady(status), project: () => this.projectAcpStatus(status) };
    });
  }

  async startLogin(
    runtimeId: SubscriptionRuntimeId,
    method: SubscriptionLoginMethod,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    return this.mutating(runtimeId, () => this.withStableErrors(async () => {
      if (runtimeId === "codex") {
        if (method === "browser") return this.projectCodexStatus(await this.codexClient.startBrowserLogin());
        const result = await this.codexClient.startDeviceCodeLogin();
        return this.projectCodexStatus(result.status);
      }
      if (runtimeId === "chatgpt-plan") {
        if (method !== "browser") {
          throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
        }
        return this.requireChatGptPlan().startLogin();
      }
      if (isClaudeCodeSubscriptionProviderId(runtimeId)) {
        if (method !== "browser") {
          throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
        }
        return this.projectClaudeCodeStatus(await this.claudeCodeClient.startBrowserLogin());
      }
      if (method !== "device-code") {
        throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
      }
      return this.projectAcpStatus(await this.acpRegistry.startDeviceCodeLogin(runtimeId));
    }));
  }

  async openPendingVerificationUrl(
    runtimeId: SubscriptionRuntimeId,
    openAuthorizationUrl: SubscriptionOpenAuthorizationUrl,
  ): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (!isAcpRuntime(runtimeId)) {
      throw new SubscriptionRuntimeServiceError("subscription-verification-url-unavailable");
    }
    return this.withStableErrors(async () => this.projectAcpStatus(
      await this.acpRegistry.openPendingVerificationUrl(runtimeId, async (url, login) => {
        await openAuthorizationUrl(url, login);
      }),
    ));
  }

  async cancelLogin(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    return this.mutating(runtimeId, () => this.withStableErrors(async () => {
      if (runtimeId === "codex") return this.projectCodexStatus(await this.codexClient.cancelLogin());
      if (runtimeId === "chatgpt-plan") return this.requireChatGptPlan().cancelLogin();
      if (isClaudeCodeSubscriptionProviderId(runtimeId)) {
        return this.projectClaudeCodeStatus(await this.claudeCodeClient.cancelLogin());
      }
      return this.projectAcpStatus(await this.acpRegistry.cancelLogin(runtimeId));
    }));
  }

  async logout(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    return this.mutating(runtimeId, () => this.withStableErrors(async () => {
      if (runtimeId === "codex") return this.projectCodexStatus(await this.codexClient.logout());
      if (runtimeId === "chatgpt-plan") return this.requireChatGptPlan().logout();
      if (isClaudeCodeSubscriptionProviderId(runtimeId)) {
        return this.projectClaudeCodeStatus(await this.claudeCodeClient.logout());
      }
      if (runtimeId !== "grok-build") {
        throw new SubscriptionRuntimeServiceError("subscription-logout-not-supported");
      }
      return this.projectAcpStatus(await this.acpRegistry.logout(runtimeId));
    }));
  }

  /** Dismiss the runtime's notice. Only plan usage carries notices; any other runtime refuses. */
  async acknowledgeNotice(runtimeId: SubscriptionRuntimeId): Promise<SubscriptionRuntimeStatus> {
    this.assertRunning();
    if (runtimeId !== "chatgpt-plan") throw new SubscriptionRuntimeServiceError("subscription-provider-not-supported");
    return this.withStableErrors(() => this.readThrough(this.cachedStatuses, runtimeId, {}, async () => {
      const status = await this.requireChatGptPlan().acknowledgeNotice();
      return () => status;
    }, (status) => status, (_, status) => status));
  }

  async listModels(
    runtimeId: SubscriptionRuntimeId,
    options: SubscriptionReadOptions = {},
  ): Promise<SubscriptionRuntimeCatalog> {
    this.assertRunning();
    return this.withStableErrors(async () => {
      if (isClaudeCodeSubscriptionProviderId(runtimeId)) {
        // Model choices come from the catalog. No choice keeps the CLI's own default; account availability is enforced by the runtime.
        const status = await this.getStatus(runtimeId, options);
        if (status.connection !== "connected") return { status, models: [] };
        return {
          status,
          models: catalogChatModelIds("claude").map((id) => ({ id, displayName: id, isDefault: false })),
        };
      }
      // The signed-in account's own list; a failure is an error, never an empty catalog.
      if (runtimeId === "chatgpt-plan") {
        return this.readThrough(this.cachedCatalogs, runtimeId, options, async () => {
          const result = await this.requireChatGptPlan().listModels();
          return () => result;
        }, (catalog) => catalog.status, (catalog, status) => ({ ...catalog, status }));
      }
      if (runtimeId !== "codex") return { status: await this.getStatus(runtimeId, options), models: [] };
      const cached = this.cachedCatalogs.get(runtimeId);
      if (options.allowCached && cached && cached.expiresAt > Date.now()) return cached.value;
      const state = this.connection(runtimeId);
      const generation = state.generation;
      const result = await this.codexClient.listModels();
      const status = this.currentProjection(runtimeId);
      if (state.generation !== generation || status.connection !== "connected") {
        throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
      }
      const catalog = { status, models: result.models.map(({ id, displayName, isDefault }) => ({ id, displayName, isDefault })) };
      this.cachedCatalogs.set(runtimeId, this.cachedRead(catalog));
      return catalog;
    });
  }

  // Opens one main-owned, Ave-governed session after rechecking availability.
  async openTextSession(
    selection: SubscriptionChatRuntimeSelection,
    options: SubscriptionTextSessionOptions = {},
  ): Promise<SubscriptionTextSession> {
    this.assertRunning();
    const safeSelection = validSelection(selection);
    if (!safeSelection) throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    // Plan usage talks to the Responses API through its own transport (chatGptPlanTransport); it has no CLI text session.
    if (safeSelection.provider === "chatgpt-plan") {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
    const safeFallbackSelection = options.fallbackSelection === undefined
      ? undefined
      : validSelection(options.fallbackSelection);
    if (
      options.fallbackSelection !== undefined
      && (
        !safeFallbackSelection
        || safeFallbackSelection.provider !== safeSelection.provider
        || safeSelection.provider !== "codex"
      )
    ) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
    let safetyEpoch = this.safetyEpoch(safeSelection.provider);
    let status = await this.getStatus(safeSelection.provider);
    this.assertSafetyEpochCurrent(safeSelection.provider, safetyEpoch);
    // A persisted selection survives app restart, while the in-memory safety proof intentionally does not. Re-prove only for an explicit model turn.
    if (!status.capabilities.chat && (isConnectedAndReady(status) || (isCliProvider(safeSelection.provider) && status.connection === "connected"))) {
      status = await this.verify(safeSelection.provider);
      this.assertRunning();
      safetyEpoch = this.safetyEpoch(safeSelection.provider);
    }
    if (!status.capabilities.chat) throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");

    let effectiveSelection = safeSelection;
    if (
      (safeSelection.provider === "codex" || isClaudeCodeSubscriptionProviderId(safeSelection.provider))
      && (safeSelection.model !== undefined || safeFallbackSelection !== undefined)
    ) {
      // Persisted selections and transient sub-agent overrides bypass the renderer IPC. Re-enumerate against the current subscription-scoped catalog before
      // forwarding either model ID.
      const catalog = await this.listModels(safeSelection.provider);
      this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
      if (!catalog.status.capabilities.chat) {
        throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
      }
      const selectable = (candidate: SubscriptionChatRuntimeSelection): boolean =>
        candidate.model === undefined || catalog.models.some((model) => model.id === candidate.model);
      if (!selectable(safeSelection)) {
        if (!safeFallbackSelection || !selectable(safeFallbackSelection)) {
          throw new SubscriptionRuntimeServiceError("subscription-model-not-supported");
        }
        this.emitAudit({ provider: "codex", outcome: "model-fallback" });
        effectiveSelection = safeFallbackSelection;
      }
    }

    this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
    return this.withStableErrors(async () => {
      this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
      const bridge = new SubscriptionToolBridge(options.tools);
      try {
        if (effectiveSelection.provider === "codex") {
          const runtime = this.createCodexConversationRuntime({
            ...this.codexTextRuntimePaths,
            connectionEvidence: this.evidenceSink("codex", true),
            onPlanUsage: (windows) => {
              if (this.safetyEpochIsCurrent("codex", safetyEpoch)) {
                this.codexClient.invalidatePlanUsageReads();
                this.recordPlanUsage("codex", windows);
              }
            },
          });
          return await this.trackVerifiedSession(new CodexSubscriptionTextSession(
            runtime,
            effectiveSelection,
            (kind) => this.rejectUnsafeRequest("codex", kind),
            bridge,
          ), safetyEpoch);
        }
        if (isClaudeCodeSubscriptionProviderId(effectiveSelection.provider)) {
          const executable = await this.claudeCodeClient.verifiedRuntime();
          const paths = this.claudeCodeClient.getRuntimePaths();
          const runtime = this.createClaudeCodeConversationRuntime({
            resolveRuntime: async () => executable,
            runtimeHome: paths.runtimeHome,
            workspaceDir: paths.workspaceDir,
            runtimeTempDir: paths.runtimeTempDir,
            bridge,
            connectionEvidence: this.evidenceSink("claude-code", true),
            onPlanUsage: (windows) => {
              if (this.safetyEpochIsCurrent("claude-code", safetyEpoch)) this.recordPlanUsage("claude-code", windows);
            },
            ...(effectiveSelection.model !== undefined ? { model: effectiveSelection.model } : {}),
          });
          return await this.trackVerifiedSession(runtime, safetyEpoch);
        }
        const acpProvider = effectiveSelection.provider;
        if (!isAcpRuntime(acpProvider)) throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
        const mcpServers = bridge.tools.length === 0
          ? []
          : [await bridge.startMcpServer()];
        this.assertSafetyEpoch(effectiveSelection.provider, safetyEpoch);
        let unsafeHostRequest = false;
        const session = await this.acpRegistry.openTextSession(acpProvider, {
          onPlanUsage: (windows) => {
            if (this.safetyEpochIsCurrent(acpProvider, safetyEpoch)) this.recordPlanUsage(acpProvider, windows);
          },
          onHostRequest: (request) => {
            unsafeHostRequest = true;
            this.rejectUnsafeRequest(effectiveSelection.provider, request.kind);
          },
          mcpServers,
        });
        return await this.trackVerifiedSession(new BridgedAcpSubscriptionTextSession(
          session,
          bridge,
          () => unsafeHostRequest,
        ), safetyEpoch);
      } catch (error) {
        try {
          await bridge.stop();
        } catch {
          // Preserve the stable open failure rather than cleanup detail.
        }
        throw error;
      }
    });
  }

  // Stops all login and conversation children. Terminal and idempotent per service instance.
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Set synchronously before snapshotting so an already-held reference cannot add a late session while the active set is being drained.
    this.stopped = true;
    for (const [provider, state] of this.connections) {
      this.clearConfirmation(state);
      if (state.status.connection === "connected") this.latchConnection(provider, state, "unknown");
      if (connectionProjections.get(provider)?.revision === state.revision) connectionProjections.delete(provider);
    }
    this.stopPromise = (async () => {
      const sessions = [...this.activeSessions];
      this.activeSessions.clear();
      await Promise.allSettled(sessions.map((session) => session.stop()));
      this.safelyVerified.clear();
      this.cachedStatuses.clear();
      this.cachedCatalogs.clear();
      this.chatGptPlan?.stop();
      this.codexClient.connectionEvidence = undefined;
      this.claudeCodeClient.connectionEvidence = undefined;
      this.codexClient.stop();
      await Promise.all([
        this.acpRegistry.stopAll(),
        this.claudeCodeClient.stop(),
      ]);
      await this.codexRuntimeLocator.dispose();
    })();
    return this.stopPromise;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    }
  }

  /** The plan-usage runtime, for the inference transport. Throws not-configured when boot supplied none. */
  requireChatGptPlan(): ChatGptPlanRuntime {
    this.assertRunning();
    if (!this.chatGptPlan) throw new SubscriptionRuntimeServiceError("subscription-runtime-not-configured");
    return this.chatGptPlan;
  }

  private chatGptPlanStatus(): Promise<SubscriptionRuntimeStatus> {
    return this.chatGptPlan ? this.chatGptPlan.getStatus() : Promise.resolve(notConfiguredChatGptPlanStatus());
  }

  private projectCodexStatus(status: CodexSubscriptionStatus): SubscriptionRuntimeStatus {
    return this.withPlanUsage(codexStatus(status, this.hasSafetyProof("codex")));
  }

  private projectAcpStatus(status: AcpSubscriptionStatus): SubscriptionRuntimeStatus {
    return this.withPlanUsage(acpStatus(status, this.hasSafetyProof(status.provider)));
  }

  private projectClaudeCodeStatus(status: ClaudeCodeSubscriptionStatus): SubscriptionRuntimeStatus {
    return this.withPlanUsage({
      provider: status.provider,
      runtime: status.runtime,
      connection: observedConnection(status),
      planType: null,
      pendingLogin: status.pendingLogin,
      pendingDeviceCode: null,
      canOpenVerificationUrl: false,
      version: status.version,
      capabilities: verifiedRuntimeCapabilities(
        status.provider,
        this.hasSafetyProof(status.provider) && isConnectedAndReady(status),
      ),
    });
  }

  private recordPlanUsage(provider: SubscriptionRuntimeId, windows: readonly SubscriptionPlanUsageUpdate[]): void {
    if (this.stopped || !this.planUsage.update(provider, windows)) return;
    this.invalidateCachedReads(provider);
    notifyStatusChanged(provider);
  }

  private withPlanUsage(status: SubscriptionRuntimeStatus): SubscriptionRuntimeStatus {
    if (!isConnectedAndReady(status)) return status;
    const planUsage = this.planUsage.get(status.provider);
    return planUsage ? { ...status, planUsage } : status;
  }

  private reconcileSafety(
    provider: SubscriptionRuntimeId,
    status: { readonly runtime: SubscriptionRuntimeState; readonly connection: SubscriptionConnectionState },
  ): void {
    if (isConnectedAndReady(status)) return;
    if (status.runtime === "unverified" && status.connection === "connected" && !this.safelyVerified.has(provider)) return;
    // A cached projection carries the proof; only losing one makes it stale.
    if (this.safelyVerified.has(provider)) this.invalidateCachedReads(provider);
    this.revokeSafety(provider);
  }

  private async mutating(
    provider: SubscriptionRuntimeId,
    mutation: () => Promise<SubscriptionRuntimeStatus>,
  ): Promise<SubscriptionRuntimeStatus> {
    const intent = ++this.sequence;
    const state = isCliProvider(provider) ? this.connection(provider) : undefined;
    if (state && isCliProvider(provider)) {
      state.intent = intent;
      state.busy += 1;
      // Register the settlement read before a sign-out or logout can withdraw it.
      state.target ??= { attempts: 0 };
      this.latchConnection(provider, state, state.status.connection === "signed-out" ? "signed-out" : "unknown");
    } else {
      this.authChangeRevisionByProvider.set(provider, intent);
      this.mutationsInFlight.set(provider, (this.mutationsInFlight.get(provider) ?? 0) + 1);
      this.disconnect(provider);
    }
    try {
      await this.stopSessionsFor(provider);
      const status = await mutation();
      if (state && isCliProvider(provider)) {
        if (state.intent === intent && state.loginAttempt === undefined) this.projectLogin(provider, state, status);
        return this.currentProjection(provider);
      }
      if (this.authChangeRevisionByProvider.get(provider) !== intent) {
        throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
      }
      if (status.connection !== "connected") return this.observeIndependentStatus(provider, ++this.sequence, status);
    } finally {
      this.invalidateCachedReads(provider);
      if (state && isCliProvider(provider)) {
        state.busy -= 1;
        if (state.busy === 0) {
          state.intent = ++this.sequence;
          this.confirmAccount(provider, state, 0);
        }
      } else {
        const remaining = (this.mutationsInFlight.get(provider) ?? 1) - 1;
        if (remaining === 0) this.mutationsInFlight.delete(provider);
        else this.mutationsInFlight.set(provider, remaining);
      }
    }
    return this.getStatus(provider);
  }

  private async readThrough<T>(
    cache: Map<SubscriptionRuntimeId, CachedRead<T>>,
    runtimeId: SubscriptionRuntimeId,
    options: SubscriptionReadOptions,
    read: () => Promise<() => T>,
    statusOf: (value: T) => SubscriptionRuntimeStatus,
    withStatus: (value: T, status: SubscriptionRuntimeStatus) => T,
  ): Promise<T> {
    const cacheEnabled = runtimeId !== "chatgpt-plan";
    if (cacheEnabled && options.allowCached) {
      const cached = cache.get(runtimeId);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }
    const generation = this.readGeneration(runtimeId);
    if (this.mutationsInFlight.has(runtimeId)) throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
    const start = ++this.sequence;
    const project = await read().catch((error: unknown) => {
      if (isAcpRuntime(runtimeId) && this.readGeneration(runtimeId) === generation && subscriptionConnectionProjection(runtimeId)?.connected) {
        this.disconnect(runtimeId);
      }
      throw error;
    });
    this.assertRunning();
    if (this.readGeneration(runtimeId) !== generation) throw new SubscriptionRuntimeServiceError("subscription-status-superseded");
    const value = project();
    const status = this.observeIndependentStatus(runtimeId, start, statusOf(value));
    if (cacheEnabled) this.reconcileSafety(runtimeId, status);
    const result = withStatus(value, status);
    if (cacheEnabled && isSettledStatus(status)) cache.set(runtimeId, this.cachedRead(result));
    return result;
  }

  private connection(provider: SubscriptionRuntimeId): HostConnection {
    let state = this.connections.get(provider);
    if (!state) {
      state = {
        intent: 0, busy: 0, generation: 0, latch: 0, acceptedRead: 0, failedRead: 0, artifact: null,
        status: this.failedProbeStatus(provider), login: NO_PENDING_LOGIN,
        confirming: false, revision: 0, scope: randomUUID(), safetyEpoch: 0, proven: false,
      };
      this.connections.set(provider, state);
    }
    return state;
  }

  private disconnect(provider: SubscriptionRuntimeId): void {
    if (!this.stopped) this.latchConnection(provider, this.connection(provider), "unknown");
  }

  private observeIndependentStatus(
    provider: SubscriptionRuntimeId, start: number, status: SubscriptionRuntimeStatus,
  ): SubscriptionRuntimeStatus {
    const state = this.connection(provider);
    if (start <= state.latch || start <= state.acceptedRead) {
      return { ...state.status, ...state.login, revision: state.revision };
    }
    const wasConnected = this.connectionHasAuthority(provider, state.status);
    const connected = this.connectionHasAuthority(provider, status);
    state.acceptedRead = start;
    state.login = { pendingLogin: status.pendingLogin, pendingDeviceCode: status.pendingDeviceCode };
    if (wasConnected && !connected) {
      this.latchConnection(provider, state, status.connection === "signed-out" ? "signed-out" : "unknown", status.version, undefined, status);
    } else {
      state.status = status;
      if (connected && !wasConnected) this.publishConnection(provider);
    }
    return { ...status, revision: state.revision };
  }

  private currentProjection(provider: CliProvider): SubscriptionRuntimeStatus {
    const { status, login, proven } = this.connection(provider);
    return this.withPlanUsage({
      ...status,
      ...login,
      connection: status.connection === "unknown" && login.pendingLogin !== null ? "pending" : status.connection,
      revision: subscriptionHostRevision(),
      runtime: provider === "claude-code" && status.connection === "connected" && proven ? "ready" : status.runtime,
      capabilities: verifiedRuntimeCapabilities(provider, proven && status.connection === "connected"),
    });
  }

  private projectLogin(
    provider: CliProvider, state: HostConnection, ui: PendingLoginProjection & { version?: string | null },
  ): void {
    state.status.version ??= ui.version ?? null;
    if (state.login.pendingLogin === ui.pendingLogin && state.login.pendingDeviceCode === ui.pendingDeviceCode) return;
    state.login = { pendingLogin: ui.pendingLogin, pendingDeviceCode: ui.pendingDeviceCode };
    this.publishConnection(provider);
  }

  private async readCliStatus(provider: CliProvider, options: SubscriptionReadOptions): Promise<SubscriptionRuntimeStatus> {
    const state = this.connection(provider);
    const cached = this.cachedStatuses.get(provider);
    if (options.allowCached && (state.busy || (cached && cached.expiresAt > Date.now()))) return this.currentProjection(provider);
    const intent = state.intent;
    const start = this.sequence;
    try {
      const ui = await this.withStableErrors(async () => provider === "codex"
        ? this.projectCodexStatus(await this.codexClient.getStatus(!options.allowCached || !this.planUsage.get(provider)))
        : this.projectClaudeCodeStatus(await this.claudeCodeClient.getStatus()));
      this.assertRunning();
      if (state.intent === intent && state.loginAttempt === undefined) this.projectLogin(provider, state, ui);
    } catch (error) {
      this.assertRunning();
      if (state.intent === intent) {
        if (state.loginAttempt === undefined && subscriptionRuntimeErrorCode(error) === "subscription-login-failed") {
          this.projectLogin(provider, state, NO_PENDING_LOGIN);
        }
        if (state.acceptedRead <= start && (state.latch <= start || state.failedRead > start)) throw error;
      }
    }
    const status = this.currentProjection(provider);
    if (!state.busy && isSettledStatus(status)) this.cachedStatuses.set(provider, this.cachedRead(status));
    return status;
  }

  private evidenceSink(provider: CliProvider, auxiliary = false): SubscriptionEvidenceSink {
    return (evidence) => this.reduceConnection(provider, evidence, auxiliary);
  }

  private reduceConnection(
    provider: CliProvider, evidence: SubscriptionConnectionEvidence, auxiliary: boolean,
  ): ReturnType<SubscriptionEvidenceSink> {
    if (this.stopped) return undefined;
    const state = this.connection(provider);
    if (evidence.kind === "read") {
      const start = ++this.sequence;
      const { intent, generation } = state;
      let delivered = false;
      return (verdict) => {
        if (delivered || this.stopped) return false;
        delivered = true;
        if (verdict.kind === "signed-out") {
          this.clearConfirmation(state);
          this.latchConnection(provider, state, "signed-out", evidence.version);
          return true;
        }
        if (generation !== state.generation || intent !== state.intent || start <= state.latch || start <= state.acceptedRead) {
          return false;
        }
        if (verdict.kind === "unavailable") {
          state.failedRead = start;
          this.latchConnection(provider, state, state.status.connection === "signed-out" ? "signed-out" : "unknown", evidence.version, verdict.runtime);
          return true;
        }
        if (state.busy) return false;
        if (evidence.artifact !== state.artifact) {
          if (auxiliary) this.latchConnection(provider, state, "unknown");
          return false;
        }
        if (verdict.accountKey && state.accountKey && verdict.accountKey !== state.accountKey) {
          state.accountKey = verdict.accountKey;
          this.requireConfirmation(state);
          this.latchConnection(provider, state, "unknown", evidence.version);
          return false;
        }
        if (verdict.accountKey) state.accountKey = verdict.accountKey;
        if (auxiliary) return state.status.connection === "connected";
        const connected = state.status.connection === "connected";
        state.acceptedRead = start;
        this.clearConfirmation(state);
        state.status = {
          ...this.failedProbeStatus(provider, evidence.version),
          connection: "connected",
          runtime: provider === "codex" ? "ready" : "unverified",
          planType: verdict.planType ?? null,
        };
        if (!connected) this.publishConnection(provider);
        return true;
      };
    }
    if (evidence.kind === "artifact") {
      const changed = state.source !== undefined && (state.artifact !== evidence.artifact || state.source !== evidence.source);
      if (changed) state.accountKey = undefined;
      state.source = evidence.source;
      state.artifact = evidence.artifact;
      if (changed || evidence.artifact === null) {
        this.latchConnection(provider, state, state.status.connection === "signed-out" ? "signed-out" : "unknown", evidence.version, evidence.runtime);
      }
      return undefined;
    }
    if (evidence.kind === "login-started") {
      state.loginAttempt = evidence.attempt;
      this.projectLogin(provider, state, {
        pendingLogin: evidence.method, pendingDeviceCode: evidence.deviceCode, version: evidence.version,
      });
      return undefined;
    }
    if (evidence.kind === "login-retired") {
      if (state.loginAttempt !== evidence.attempt) return undefined;
      state.loginAttempt = null;
      if (!evidence.completed) {
        this.projectLogin(provider, state, NO_PENDING_LOGIN);
        return undefined;
      }
      state.login = NO_PENDING_LOGIN;
    }
    if (evidence.kind === "advertisement" || evidence.kind === "login-completed" || evidence.kind === "login-retired") {
      const revision = state.revision;
      this.requireConfirmation(state);
      state.accountKey = undefined;
      this.latchConnection(provider, state, "unknown");
      if (evidence.kind === "login-retired" && state.revision === revision) this.publishConnection(provider);
      return undefined;
    }
    if (evidence.kind === "retired") {
      // Disposing an idle auxiliary proof leaves established primary authority intact.
      if (!auxiliary || state.target) this.latchConnection(provider, state, "unknown");
      return undefined;
    }
    const signedOut = evidence.kind !== "transport-lost";
    if (signedOut) this.clearConfirmation(state);
    state.accountKey = undefined;
    this.latchConnection(provider, state, signedOut ? "signed-out" : "unknown");
    return undefined;
  }

  private latchConnection(
    provider: SubscriptionRuntimeId, state: HostConnection, connection: "unknown" | "signed-out", version = state.status.version,
    runtime?: "not-configured" | "unavailable", observed?: SubscriptionRuntimeStatus,
  ): void {
    const nextRuntime = observed?.runtime ?? runtime ?? (connection === "signed-out" ? (provider === "codex" ? "ready" : "unverified") : "unavailable");
    const changed = state.status.connection !== connection || state.status.runtime !== nextRuntime
      || state.status.version !== version || state.latch === 0;
    state.latch = ++this.sequence;
    state.generation += 1;
    this.invalidateSafety(provider);
    state.status = {
      ...this.failedProbeStatus(provider, version),
      ...observed,
      connection: observed?.connection ?? connection,
      runtime: nextRuntime,
    };
    if (!observed && !isCliProvider(provider)) state.login = NO_PENDING_LOGIN;
    if (changed || (observed && !observed.capabilities.chat)) this.publishConnection(provider);
    if (isCliProvider(provider)) this.confirmAccount(provider, state);
  }

  private connectionHasAuthority(provider: SubscriptionRuntimeId, status: AccountStatus): boolean {
    return status.connection === "connected" && (isCliProvider(provider) || (status.runtime === "ready" && status.capabilities.chat));
  }

  private publishConnection(provider: SubscriptionRuntimeId): void {
    this.invalidateCachedReads(provider);
    const state = this.connection(provider);
    state.revision = nextSubscriptionHostRevision();
    const connected = this.connectionHasAuthority(provider, state.status);
    connectionProjections.set(provider, { revision: state.revision, connected, scope: `${state.scope}:${state.generation}` });
    notifyStatusChanged(provider, connected, state.revision);
  }

  private requireConfirmation(state: HostConnection): void {
    state.target ??= { attempts: 0 };
    const target = state.target;
    clearTimeout(target.timer);
    target.timer = undefined;
    target.attempts = 0;
  }

  private clearConfirmation(state: HostConnection): void {
    clearTimeout(state.target?.timer);
    state.target = undefined;
  }

  private confirmAccount(provider: CliProvider, state: HostConnection, delay?: number): void {
    const target = state.target;
    if (this.stopped || !target || state.busy || state.confirming || target.timer || state.status.connection === "connected") return;
    target.timer = setTimeout(() => {
      target.timer = undefined;
      if (this.stopped || state.target !== target || state.busy || state.status.connection === "connected") return;
      state.confirming = true;
      void this.readCliStatus(provider, {}).catch(() => undefined).finally(() => {
        state.confirming = false;
        target.attempts += 1;
        this.confirmAccount(provider, state);
      });
    }, delay ?? (target.attempts === 0 ? 0 : Math.min(250 * 2 ** Math.min(target.attempts - 1, 5), 8000)));
    target.timer.unref();
  }

  private cachedRead<T>(value: T): CachedRead<T> {
    return { value, expiresAt: Date.now() + SETTINGS_READ_CACHE_TTL_MS };
  }

  private readGeneration(provider: SubscriptionRuntimeId): number {
    return this.readGenerationByProvider.get(provider) ?? 0;
  }

  private async stopSessionsFor(provider: SubscriptionRuntimeId): Promise<void> {
    const sessions = [...this.activeSessions].filter((session) => session.provider === provider);
    // Session cleanup is best effort here: an auth/logout mutation must not be blocked by a third-party runtime that is already being force-stopped.
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  // Synchronously revoke every proof tied to this provider and advance its epoch. Any in-flight verify/open operation that captured an earlier epoch must
  // fail closed rather than re-authorizing a newly selected runtime.
  private invalidateSafety(provider: SubscriptionRuntimeId): number {
    this.planUsage.clear(provider);
    this.invalidateCachedReads(provider);
    return this.revokeSafety(provider);
  }

  private revokeSafety(provider: SubscriptionRuntimeId): number {
    if (isCliProvider(provider)) {
      const state = this.connection(provider);
      state.proven = false;
      return ++state.safetyEpoch;
    }
    this.safelyVerified.delete(provider);
    const nextEpoch = this.safetyEpoch(provider) + 1;
    this.safetyEpochByProvider.set(provider, nextEpoch);
    return nextEpoch;
  }

  private safetyEpoch(provider: SubscriptionRuntimeId): number {
    return isCliProvider(provider) ? this.connection(provider).safetyEpoch : this.safetyEpochByProvider.get(provider) ?? 0;
  }

  private safetyEpochIsCurrent(provider: SubscriptionRuntimeId, epoch: number): boolean {
    return this.safetyEpoch(provider) === epoch;
  }

  private hasSafetyProof(provider: SubscriptionRuntimeId): boolean {
    return isCliProvider(provider) ? this.connection(provider).proven : this.safelyVerified.has(provider);
  }

  private assertSafetyEpoch(provider: SubscriptionRuntimeId, epoch: number): void {
    this.assertSafetyEpochCurrent(provider, epoch);
    if (!this.hasSafetyProof(provider)) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
  }

  private assertSafetyEpochCurrent(provider: SubscriptionRuntimeId, epoch: number): void {
    this.assertRunning();
    if (!this.safetyEpochIsCurrent(provider, epoch)) {
      throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
    }
  }

  private rejectUnsafeRequest(provider: SubscriptionRuntimeId, requestKind: string): void {
    this.invalidateSessionProof(provider);
    this.emitAudit({ provider, outcome: "host-request-rejected", requestKind });
  }

  private sessionFailed(provider: SubscriptionRuntimeId): void {
    if (isAcpRuntime(provider)) this.disconnect(provider);
    else this.invalidateSessionProof(provider);
    this.emitAudit({ provider, outcome: "session-failed" });
  }

  private invalidateSessionProof(provider: SubscriptionRuntimeId): void {
    const changed = this.hasSafetyProof(provider);
    this.invalidateSafety(provider);
    if (changed && isCliProvider(provider)) this.publishConnection(provider);
  }

  private emitAudit(event: SubscriptionRuntimeAuditEvent): void {
    try {
      const pending = this.audit?.(Object.freeze({ ...event }));
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Auditing cannot turn a deny/cleanup decision into a permissive one.
    }
  }

  private async trackSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    safetyEpoch: number,
  ): Promise<SubscriptionTextSession> {
    if (this.stopped || !this.safetyEpochIsCurrent(session.provider, safetyEpoch) || !this.hasSafetyProof(session.provider)) {
      try {
        await session.stop();
      } catch {
        // Preserve the terminal service error rather than cleanup detail.
      }
      throw new SubscriptionRuntimeServiceError(
        this.stopped ? "subscription-operation-failed" : "subscription-chat-unavailable",
      );
    }
    let stopped = false;
    const tracked: SubscriptionTextSession = {
      provider: session.provider,
      streamTurn: (text, abortSignal, attachments) => this.streamTrackedSession(
        session,
        text,
        safetyEpoch,
        abortSignal,
        attachments,
      ),
      cancelActiveTurn: async () => {
        this.assertSafetyEpoch(session.provider, safetyEpoch);
        try {
          await session.cancelActiveTurn();
        } catch (error) {
          if (this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
            this.sessionFailed(session.provider);
          }
          throw stableError(error);
        }
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.activeSessions.delete(tracked);
        try {
          await session.stop();
        } catch (error) {
          if (this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
            this.sessionFailed(session.provider);
          }
          throw stableError(error);
        }
      },
    };
    this.activeSessions.add(tracked);
    return Object.freeze(tracked);
  }

  private async trackVerifiedSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    safetyEpoch: number,
  ): Promise<SubscriptionTextSession> {
    const tracked = await this.trackSession(session, safetyEpoch);
    try {
      this.assertSafetyEpoch(session.provider, safetyEpoch);
      return tracked;
    } catch (error) {
      try {
        await tracked.stop();
      } catch {
        // The outer session-open cleanup remains best effort.
      }
      throw error;
    }
  }

  private async *streamTrackedSession(
    session: AcpSubscriptionTextSession | SubscriptionTextSession,
    text: string,
    safetyEpoch: number,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent> {
    this.assertSafetyEpoch(session.provider, safetyEpoch);
    try {
      for await (const event of session.streamTurn(text, abortSignal, attachments)) {
        this.assertSafetyEpoch(session.provider, safetyEpoch);
        yield event;
      }
    } catch (error) {
      // User cancellation is an expected lifecycle event, not evidence that a previously verified subscription runtime became unsafe or unavailable.
      if (!isAbortError(error) && this.safetyEpochIsCurrent(session.provider, safetyEpoch)) {
        this.sessionFailed(session.provider);
      }
      throw stableError(error);
    }
  }

  private async withStableErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertRunning();
      const result = await operation();
      this.assertRunning();
      return result;
    } catch (error) {
      throw stableError(error);
    }
  }
}

type StatusChangedListener = (provider: SubscriptionRuntimeId, connected: boolean | undefined, revision: number) => void;
const statusChangedListeners = new Set<StatusChangedListener>();
const connectionProjections = new Map<SubscriptionRuntimeId, { revision: number; connected: boolean; scope: string }>();
let subscriptionRevision = 0;

export function subscriptionHostRevision(): number {
  return subscriptionRevision;
}

export function nextSubscriptionHostRevision(): number {
  return ++subscriptionRevision;
}

export function subscriptionConnectionProjection(provider: SubscriptionRuntimeId) {
  return connectionProjections.get(provider);
}

// Live connection observations, account gauges and turn verification can change status outside settings mutations.
export function onSubscriptionRuntimeStatusChanged(listener: StatusChangedListener): () => void {
  statusChangedListeners.add(listener);
  return () => { statusChangedListeners.delete(listener); };
}

function notifyStatusChanged(provider: SubscriptionRuntimeId, connected?: boolean, revision = nextSubscriptionHostRevision()): void {
  for (const listener of statusChangedListeners) listener(provider, connected, revision);
}

let service: SubscriptionRuntimeService | null = null;
let createPromise: Promise<SubscriptionRuntimeService> | null = null;
let stopPromise: Promise<void> | null = null;
let stopped = false;

// Lazily create the one main-owned service. The opener must be main-validated.
export async function getSubscriptionRuntimeService(
  openAuthorizationUrl: SubscriptionOpenAuthorizationUrl,
  options: GetSubscriptionRuntimeServiceOptions = {},
): Promise<SubscriptionRuntimeService> {
  if (stopped) throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
  if (service) return service;
  if (!createPromise) {
    createPromise = SubscriptionRuntimeService.create(openAuthorizationUrl, options)
      .then(async (created) => {
        if (stopped) {
          await created.stop();
          throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
        }
        service = created;
        return created;
      })
      .finally(() => {
        createPromise = null;
      });
  }
  return createPromise;
}

// Idempotently stop login and execution-capable subscription runtimes.
export function stopSubscriptionRuntimes(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopped = true;
  stopPromise = (async () => {
    const active = service;
    service = null;
    if (active) await active.stop();
    const pending = createPromise;
    if (pending) {
      const late = await pending.catch(() => null);
      if (late && late !== active) await late.stop();
    }
  })().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}
