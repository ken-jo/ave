/** Owns plugin admission, generation publication, dispatch, and retirement for one runtime lifetime. */

import type { PluginAccessSpec, PluginManifest, PluginHostApi, PluginToolHandler, RuntimePlugin, RuntimePluginFactory, PluginAuthSpec, PluginConfigSchema, PluginOnboardingSpec, PluginUiExtension, PluginRegistryTrust } from "../types.js";
import { classifySubscription } from "../capabilities.js";
import { parsePluginJson, buildManifestValidator, getDeclaredEmittedEvents, recordManifestDocument } from "./manifest-validation.js";
import { flattenAgentPluginsManifest, pluginEntryKind } from "../public-contract.js";
import { isModelVisible } from "./tool-visibility.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, basename } from "node:path";
import type { ManifestLoadPlan, PluginStartPreparationOutcome, PluginStartPreparationReturn, SinglePluginStartResult, ManifestSnapshot, LoadedPlugin, PluginLifecycleHookScope, PluginLoadArm, PluginConfinementReport, PluginAttemptRefusal } from "./types.js";
import { logPluginLifecycle, PluginPhase } from "../lifecycle-log.js";
import { getLocale, t } from "../../i18n/index.js";
import { getPluginViewTitle } from "../../shared/plugin-view-label.js";
import type { CommittedPluginGeneration, PluginRuntimeGenerationLifecycle, PluginRuntimeGenerationProjection, PluginRuntimeGenerationAccess, PluginRuntimeRetirementPhase, PluginRuntimeRetirementStep, PreparedPluginRuntimeGenerationPublication, PreparedPluginRuntimeRemovalPublication } from "../plugin-host-generation.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { raceWithTimeout } from "../../shared/abortable-deadline.js";
import type { ValidateFunction } from "ajv";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
import { isTrustedRegistryManifestPath } from "../registry-manifest-trust.js";
import { createLogger } from "../../lib/logger.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import {
  installReceiptPath,
  verifyInstallReceipt,
  verifyInstallReceiptRaw,
  type GitInstallRecord,
  type PluginInstallReceipt,
  type PluginRung,
} from "../plugin-install-receipt.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { type PluginDeploymentGuard, assertDisableAllowed } from "../deployment-guard.js";
import { pluginArtifactGenerationId } from "../plugin-artifact-identity.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import { canonicalJSON } from "../secret-access/canonical-json.js";
import { manifestAuthority } from "../../marketplace/resolve/manifest-rules.js";
import { waitForPluginWorkersStopped } from "../../permissions/worker-spawn.js";
import { materializePluginGenerationRoot, removeRetainedPluginGeneration } from "../plugin-contributions.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import {
  assertProcessEntryAdmitted,
  ProcessEntryRequiresPinnedArtifactError,
  ProcessEntryUnconfinedError,
  resolveProcessLaunch,
} from "../process-entry.js";
import { revocationRegistry } from "../revocation/revocation-registry.js";
import { isPluginRuntimeDetachedOperationError, PluginRuntimeDetachedOperationError } from "./detached-operation.js";
import { isCommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { ensurePluginDataDir, resolvePluginDataDir, resolveEntryPath, buildPluginContext, resolveRealEntryPath } from "./sandbox.js";
import { buildImportUrl, buildMethodMap, declaredAppVisibleToolMethods } from "./plugin-loader.js";
import { withPluginInstallLock, hasExclusivePluginLifecycleMutation, isPluginInstallLockHeld, withAllPluginInstallLocks, withResolvedPluginInstallLocks } from "../install-lifecycle.js";
import type { SpawnConfinement } from "../../permissions/confined-child.js";
import { capturePluginSandboxGrant, createOutOfProcessPluginFactory, isPluginSandboxGrantCovered, PluginSandboxGrantError } from "../isolation/out-of-process-plugin.js";
import { PluginChildTerminationUnverifiedError } from "../isolation/plugin-child-transport.js";
import {
  HOST_PROTOCOL_VERSIONS_SERVED,
  IncompatibleHostProtocolError,
  isServedHostProtocolVersion,
} from "../isolation/host-api-wire.js";
import { createPluginStorage, createPluginStorageAuditSink } from "../storage.js";
import { resolvePluginHostStorageDir } from "../plugin-storage-layout.js";
import type { SecretEncryption } from "../../data/secret-document-store.js";
import { runWithCeiling } from "../../tools/executor-ceiling.js";
import { checkRuntimeAdmission } from "./runtime-admission.js";
import type { FloatingDockErrorCode, ResolvedFloatingSurface } from "../../main/floating-dock.js";
import type { InvocationOrigin } from "./origin-chain.js";
import { errorMessage } from "../../shared/error-message.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

const log = createLogger("plugin-runtime");

/** Bound HTML returned by one UI-resource read before it reaches the renderer. */
export const MAX_UI_RESOURCE_HTML_BYTES = 4 * 1024 * 1024;

export type { ManifestLoadPlan, ManifestSnapshot };

/** Catalog metadata remains available for plugins without an active runtime. */
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  /** Manifest tool names filtered through model visibility when a tool registry is supplied. */
  tools: string[];
  capabilities: string[];
  toolDescriptions?: Record<string, string>;
  loadStatus: "loaded" | "preparing" | "failed" | "disabled";
  /** Model exposure is independent of whether the runtime is loaded. */
  active: boolean;
  /** Inactive plugins can remain loaded and callable. */
  runtimeLoaded: boolean;
  /** Preparation detail is present only while loadStatus is "preparing". */
  preparationStatus?: PluginPreparationStatus;
  icon?: string;
  iconText?: string;
  /** Sidebar metadata remains available before the plugin loads. */
  uiExtensions?: PluginUiExtension[];
  version?: string;
  configSchema?: PluginConfigSchema;
  /** Optional declarative auth contract — see architecture.md §9.4a "Plugin-Owned OAuth — Host UI Surface". */
  auth?: PluginAuthSpec;
  networkAccess?: PluginManifest["networkAccess"];
  onboarding?: PluginOnboardingSpec;
  installFailureKind?: PluginInstallFailureKind;
  installFailureMessage?: string;
  /** Records factory routing only if construction reached that boundary. */
  arm?: PluginLoadArm;
  /** The wrap the plugin's child was spawned under, or `"not-spawned"`. Present with {@link arm}. */
  confinement?: PluginConfinementReport;
  /** A refused update belongs to the attempt; the loaded incumbent keeps serving until a later commit clears it. */
  lastAttemptRefusal?: PluginAttemptRefusal;
  /** Registry hints, manifest ids, and deployment aliases address one canonical catalog card. */
  installAliases?: string[];
}

export interface PluginPreparationStatus {
  phase: string;
  message: string;
  progressPct?: number;
  updatedAt: string;
}

export interface PluginPreparationProgressInput {
  phase: string;
  message: string;
  progressPct?: number;
}

export interface PluginToolInvocationContext {
  /** SoT: {@link InvocationOrigin} (`plugins/runtime/origin-chain.ts`). */
  origin: InvocationOrigin;
  callerPluginId?: string;
  ownerPluginId?: string;
  /** Host-admitted runtime activation; never inferred from mutable live state. */
  ownerGenerationId?: string;
  /** Capture auth classification from the admitted manifest so a replacement cannot downgrade an earlier auth call. */
  authToolKind?: "status" | "login" | "logout";
  /** Only trusted panel gestures prove browser activation; embedded card claims cannot be verified. */
  userAction?: boolean;
  /** Propagate InvocationOrigin through nested calls; combining origins must retain the least trusted source. */
  parentOrigin?: InvocationOrigin;
  /** Host-owned app-call envelope. The renderer may carry only the opaque token. */
  appInvocation?: {
    surface: "trusted-panel" | "mcp-app";
    sessionId: string;
    operationGrantToken?: string;
  };
  /** Exact foreign MCP owner captured from the card and rechecked at dispatch. */
  expectedMcpServerId?: string;
}

export type PluginToolInvocationDelegate = (
  method: string,
  payload: unknown,
  context: PluginToolInvocationContext,
) => Promise<unknown>;

/** App calls cannot invoke an auth tool; the host owns auth transitions through callFromApp. */
export const MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE = "mcp-app-auth-tool-not-app-callable";

interface PluginStartPreparationContext {
  pluginId: string;
  manifest: PluginManifest;
  manifestPath: string;
  pluginRoot: string;
  reportProgress?: (status: PluginPreparationProgressInput) => void;
}

interface PreparedArtifactRuntimeActivationInput<T> {
  installId: string;
  pluginRoot: string;
  manifest: PluginManifest;
  receiptRaw: string;
  registryEntry: Readonly<
    PluginRegistryTrust
  >;
  approvedPluginAccess?: PluginAccessSpec;
  durableCommit(): Promise<T>;
}

export interface PluginHostApiIncarnation {
  registerDisposer(dispose: () => void): void;
  trackOperation<T>(operation: Promise<T>): Promise<T>;
  isActive(): boolean;
  isLifecycleHookActive(): boolean;
  /**
   * Optional generation-wide effect scope. Prepared generations stage
   * registrations here until the generation is atomically published.
   */
  generationScope?: HostApiGenerationScope;
}

export interface PluginRuntimeOptions {
  hostRoot: string;
  encryption: SecretEncryption;
  /** Entry plugins require the host-owned child entry module; reject construction when its location is unknown. */
  childEntryPath: string;
  manifestPaths?: string[];
  registryPath?: string;
  pluginsRoot?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  createHostApi: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
    installPluginId: string | null,
    candidateRegistryEntry?: Readonly<PluginRegistryTrust>,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ) => PluginHostApi;
  deploymentGuard?: PluginDeploymentGuard;
  installReceiptCacheRoot?: string;
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  onMalformedCredentialSelector?: (pluginId: string) => void;
  /** Teardown callbacks must be idempotent because failed startup can invoke them after an earlier stop. */
  onDisable?: (pluginId: string) => void;

  onEnable?: (pluginId: string) => void;
  /** Revokes renderer authority whenever a plugin UI generation changes. */
  onPluginUiRevisionChange?: (pluginId: string) => void;
  /** Changing model exposure must retain runtime registrations for app and integration calls. */
  onActiveStateChange?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<void> | void;
  /** Dependency preparation defers startup without blocking boot; calls fail as preparing until it resolves. */
  preparePluginStart?: (context: PluginStartPreparationContext) => PluginStartPreparationReturn;
}

/** Cross-plugin calls and subscriptions share one permission and audit policy. */

type AuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

/** Foreign event subscriptions require an explicit grant; self-owned and unowned events are allowed. */
export function assertEventSubscribeAccess(opts: {
  callerPluginId: string;
  eventType: string;
  targetPluginId: string | undefined;
  getAccessGrant: () => PluginAccessSpec | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, targetPluginId } = opts;
  if (classifySubscription(eventType) === "private") {
    opts.auditLog?.("error", "plugin_private_event_access_denied", {
      callerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to subscribe to private event '${eventType}'`,
    );
  }
  if (!targetPluginId || targetPluginId === callerPluginId) return;
  const rule = opts
    .getAccessGrant()
    ?.plugins.find((entry) => entry.pluginId === targetPluginId);
  if (rule?.events?.includes(eventType)) return;
  opts.auditLog?.("error", "plugin_event_access_denied", {
    callerPluginId,
    targetPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to subscribe to event '${eventType}' from plugin '${targetPluginId}'`,
  );
}

/** Plugins may emit only their own events or events without a resolvable owner. */
export function assertEventEmitAccess(opts: {
  callerPluginId: string;
  eventType: string;
  ownerPluginId: string | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, ownerPluginId } = opts;
  if (classifySubscription(eventType) === "private") {
    opts.auditLog?.("error", "plugin_private_event_emit_denied", {
      callerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to emit private event '${eventType}'`,
    );
  }
  if (!ownerPluginId || ownerPluginId === callerPluginId) return;
  opts.auditLog?.("error", "plugin_event_emit_denied", {
    callerPluginId,
    ownerPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to emit event '${eventType}' owned by plugin '${ownerPluginId}'`,
  );
}

/** Renderer calls require explicit app visibility in the tool declaration. */
function assertAppVisibleToolInvokable(opts: {
  method: string;
  pluginId: string;
  appVisibleTools: string[];
}): void {
  if (!opts.appVisibleTools.includes(opts.method)) {
    throw new Error(
      `Method '${opts.method}' is not an app-visible Tool for plugin '${opts.pluginId}'. ` +
        `Give its tools[] entry "_meta":{"ui":{"visibility":["app"]}} (or ["model","app"]) to allow renderer invocation.`,
    );
  }
}

/** Card shaping is pure; callers resolve runtime state, visibility, preparation, and aliases first. */

export function buildPluginCard(
  pluginId: string,
  manifest: PluginManifest,
  loadStatus: PluginCard["loadStatus"],
  visibleNames: Set<string> | null,
  state: { active: boolean; runtimeLoaded: boolean },
  extras: {
    preparationStatus: PluginPreparationStatus | undefined;
    installAliases: string[] | undefined;
  },
): PluginCard {
  // Catalog tool lists expose model-visible tools only; app-only tools must stay out.
  const modelTools = (manifest.tools ?? []).filter(isModelVisible);
  const filteredTools = !state.active
    ? []
    : visibleNames
    ? modelTools.filter((t) => visibleNames.has(t.name))
    : modelTools;
  const filteredNames = filteredTools.map((t) => t.name);
  const sampleTools = filteredNames.slice(0, 3);
  const description = manifest.description;
  const toolDescriptions: Record<string, string> = {};
  for (const t of filteredTools) {
    if (t.description) toolDescriptions[t.name] = t.description;
  }
  const uiExtensions = manifest.ui?.filter((extension) => extension.slot === "sidebar");
  return {
    id: pluginId,
    name: manifest.name ?? manifest.id,
    description,
    sampleTools,
    tools: filteredNames,
    capabilities: manifest.capabilities ?? [],
    toolDescriptions: Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
    loadStatus,
    active: state.active,
    runtimeLoaded: state.runtimeLoaded,
    preparationStatus: loadStatus === "preparing" ? extras.preparationStatus : undefined,
    icon: manifest.icon,
    iconText: manifest.iconText,
    uiExtensions: uiExtensions && uiExtensions.length > 0 ? uiExtensions : undefined,
    version: manifest.version,
    configSchema: manifest.configSchema,
    auth: manifest.auth,
    networkAccess: manifest.networkAccess,
    onboarding: manifest.onboarding,
    installAliases: extras.installAliases,
  };
}

/** Host-private revocation tuple. Hash and minting generation are inseparable. */
type PluginAuthInvalidation = Readonly<{
  invalidatedAccountHash: string;
  invalidatedAccountGenerationId: string;
}>;

export type PluginAuthObservation = Readonly<{
  invalidatedAccountHash?: string;
  invalidatedAccountGenerationId?: string;
}>;
export type PluginAuthOperationAccount = Readonly<{
  /** Stable scope shared with ordinary account operations for FIFO serialization. */
  accountScopeHash: string;
  /**
   * Host-private synthetic principal used only by a manifest auth Tool's
   * operation-policy path. It is never a cached authenticated account.
   */
  accountHash: string;
}>;
export type PluginAuthInvocation = PluginAuthObservation & Readonly<{
  epoch: number;
  accountTransitionScopeHash: string;
  operationAccount: PluginAuthOperationAccount;
}>;

function fallbackPluginAuthTransitionScope(pluginId: string): string {
  return createHash("sha256")
    .update("plugin-auth-transition/v1\0")
    .update(pluginId)
    .digest("hex");
}

function pluginAuthOperationAccount(
  pluginId: string,
  generationId: string,
  appSessionId: string | undefined,
  accountScopeHash: string,
): PluginAuthOperationAccount {
  const effectiveSessionId = appSessionId || `plugin-auth-${pluginId}-${generationId}`;
  return Object.freeze({
    accountScopeHash,
    accountHash: createHash("sha256")
      .update("plugin-auth-operation-principal/v1\0")
      .update(pluginId)
      .update("\0")
      .update(generationId)
      .update("\0")
      .update(effectiveSessionId)
      .update("\0")
      .update(accountScopeHash)
      .digest("hex"),
  });
}

function pluginAccountIdentityHash(account: string): string {
  return createHash("sha256")
    .update("plugin-account-identity/v1\0")
    .update(account.trim().toLowerCase())
    .digest("hex");
}

function pluginAccountPrincipalHash(identityHash: string, sessionNonce: string): string {
  return createHash("sha256")
    .update("plugin-account-session/v1\0")
    .update(identityHash)
    .update("\0")
    .update(sessionNonce)
    .digest("hex");
}

function authInvalidation(
  current: { readonly principalHash: string } | undefined,
  currentGenerationId: string,
  retained: { readonly principalHash: string; readonly generationId: string } | undefined,
): PluginAuthInvalidation | undefined {
  if (current) {
    return {
      invalidatedAccountHash: current.principalHash,
      invalidatedAccountGenerationId: currentGenerationId,
    };
  }
  return retained
    ? {
        invalidatedAccountHash: retained.principalHash,
        invalidatedAccountGenerationId: retained.generationId,
      }
    : undefined;
}

/** Performance history survives resetLoadedState and runtime restarts. */

export interface PluginPerfStats {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
}

function zeroed(startupMs = 0): PluginPerfStats {
  return { startupMs, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null };
}

class PerfStatsTracker {
  private readonly stats = new Map<string, PluginPerfStats>();

  has(pluginId: string): boolean {
    return this.stats.has(pluginId);
  }

  /** Existing statistics must survive initialization. */
  ensure(pluginId: string): void {
    if (!this.stats.has(pluginId)) {
      this.stats.set(pluginId, zeroed());
    }
  }

  setStartupMs(pluginId: string, startupMs: number): void {
    const stats = this.stats.get(pluginId);
    if (stats) stats.startupMs = startupMs;
  }

  recordStartup(pluginId: string, startupMs: number): void {
    const existing = this.stats.get(pluginId);
    if (!existing) {
      this.stats.set(pluginId, zeroed(startupMs));
    } else {
      existing.startupMs = startupMs;
    }
  }

  beginCall(pluginId: string): PluginPerfStats {
    let stats = this.stats.get(pluginId);
    if (!stats) {
      stats = zeroed();
      this.stats.set(pluginId, stats);
    }
    stats.toolCallCount += 1;
    stats.lastCallAt = Date.now();
    return stats;
  }

  /** Deep copies prevent callers from mutating internal statistics. */
  snapshot(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.stats) {
      result[id] = { ...stats };
    }
    return result;
  }
}

/** Plugin and wildcard config overrides survive resetLoadedState and runtime restarts. */
class ConfigOverrideStore {
  private readonly overrides: Record<string, Record<string, unknown>>;

  constructor(initial: Record<string, Record<string, unknown>> = {}) {
    this.overrides = initial;
  }

  /** Live config reference; callers must treat it as read-only. */
  all(): Record<string, Record<string, unknown>> {
    return this.overrides;
  }

  set(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.overrides[pluginId];
      return;
    }
    this.overrides[pluginId] = { ...config };
  }

  get(pluginId: string): Record<string, unknown> | undefined {
    const current = this.overrides[pluginId];
    return current ? { ...current } : undefined;
  }

  merge(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides[pluginId] = {
      ...(this.overrides[pluginId] ?? {}),
      ...config,
    };
  }

  setWildcard(config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) return;
    this.overrides["*"] = {
      ...(this.overrides["*"] ?? {}),
      ...config,
    };
  }

  getWildcard(): Record<string, unknown> {
    return { ...(this.overrides["*"] ?? {}) };
  }

  clearWildcard(keys: string[]): void {
    const current = this.overrides["*"];
    if (!current) return;
    for (const key of keys) {
      delete current[key];
    }
    if (Object.keys(current).length === 0) {
      delete this.overrides["*"];
    }
  }

  delete(pluginId: string): void {
    delete this.overrides[pluginId];
  }
}

/** Monotonic preparation generations prevent late starts from restoring state after reset. */

interface PendingPreparedStart {
  generation: number;
  task: Promise<void>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
}

interface PreparationTrackerDeps {
  preparePluginStart?: (
    context: PluginStartPreparationContext,
  ) => PluginStartPreparationReturn;
  applyConfigOverride: (
    pluginId: string,
    configOverride: Record<string, unknown>,
  ) => void;
  instantiateAndStartSinglePlugin: (
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; shouldCommit?: () => boolean },
  ) => Promise<SinglePluginStartResult>;
  markFailed: (pluginId: string, stub?: { name: string; description: string }) => void;
  onDisable?: (pluginId: string) => void;
}

class PreparationTracker {
  private readonly preparingPluginIds = new Set<string>();
  private readonly preparationStatuses = new Map<string, PluginPreparationStatus>();
  private readonly preparationFailures = new Map<string, string>();
  private readonly pendingPreparedStarts = new Map<string, PendingPreparedStart>();
  private readonly preparationGenerations = new Map<string, number>();
  private nextPreparationGeneration = 0;

  constructor(private readonly deps: PreparationTrackerDeps) {}

  hasPending(pluginId: string): boolean {
    return this.pendingPreparedStarts.has(pluginId);
  }

  /** True means startup was deferred; false means the caller should start inline. */
  deferStart(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    startOpts: { shouldCommit?: () => boolean } = {},
  ): boolean {
    if (!this.deps.preparePluginStart) return false;
    if (this.pendingPreparedStarts.has(manifest.id)) return true;
    const pluginRoot = dirname(plan.manifestPath);
    const generation = ++this.nextPreparationGeneration;
    this.preparationGenerations.set(manifest.id, generation);
    let result: PluginStartPreparationReturn;
    try {
      result = this.deps.preparePluginStart({
        pluginId: manifest.id,
        manifest,
        manifestPath: plan.manifestPath,
        pluginRoot,
        reportProgress: (status) => this.setStatus(manifest.id, status, generation),
      });
    } catch (err) {
      this.markPreparationFailed(manifest, err);
      return true;
    }
    if (!result || typeof (result as Promise<void>).then !== "function") {
      this.applyPreparationResult(
        manifest.id,
        result as PluginStartPreparationOutcome,
      );
      this.preparationStatuses.delete(manifest.id);
      return false;
    }

    this.preparingPluginIds.add(manifest.id);
    this.preparationFailures.delete(manifest.id);
    if (!this.preparationStatuses.has(manifest.id)) {
      this.setStatus(manifest.id, {
        phase: "pending",
        message: t("be_runtimeIndex.preparingRuntimeMessage"),
        progressPct: 5,
      }, generation);
    }
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const task = Promise.resolve(result)
      .then(async (preparationResult) => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        this.applyPreparationResult(manifest.id, preparationResult);
        const startResult = await this.deps.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, {
          skipPreparation: true,
          shouldCommit: () =>
            this.preparationGenerations.get(manifest.id) === generation
            && (startOpts.shouldCommit?.() ?? true),
        });
        if (this.preparationGenerations.get(manifest.id) !== generation) {
          return;
        }
        if (startResult !== "started") {
          const err = new Error(`plugin '${manifest.id}' failed to start after runtime dependencies were prepared`);
          this.markPreparationFailed(manifest, err);
          rejectReady(err);
          return;
        }
        this.preparingPluginIds.delete(manifest.id);
        this.preparationStatuses.delete(manifest.id);
        this.preparationFailures.delete(manifest.id);
        resolveReady();
      })
      .catch((err: unknown) => {
        if (this.preparationGenerations.get(manifest.id) !== generation) return;
        this.markPreparationFailed(manifest, err);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (this.pendingPreparedStarts.get(manifest.id)?.generation === generation) {
          this.pendingPreparedStarts.delete(manifest.id);
        }
      });
    this.pendingPreparedStarts.set(manifest.id, { generation, task, ready, resolveReady, rejectReady });
    void ready.catch(() => {});
    return true;
  }

  private applyPreparationResult(
    pluginId: string,
    result: PluginStartPreparationOutcome,
  ): void {
    if (!result || typeof result !== "object" || !result.configOverride) return;
    this.deps.applyConfigOverride(pluginId, result.configOverride);
  }

  private setStatus(pluginId: string, status: PluginPreparationProgressInput, generation: number): void {
    if (this.preparationGenerations.get(pluginId) !== generation) return;
    const progressPct = typeof status.progressPct === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progressPct)))
      : undefined;
    this.preparationStatuses.set(pluginId, {
      phase: status.phase,
      message: status.message,
      progressPct,
      updatedAt: new Date().toISOString(),
    });
  }

  private markPreparationFailed(manifest: PluginManifest, err: unknown): void {
    const message = errorMessage(err);
    this.preparingPluginIds.delete(manifest.id);
    this.preparationStatuses.delete(manifest.id);
    this.preparationFailures.set(manifest.id, message);
    this.deps.markFailed(manifest.id, {
      name: manifest.name ?? manifest.id,
      description: `Plugin dependencies failed: ${message}`,
    });
    this.deps.onDisable?.(manifest.id);
    logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.START_FAIL, reason: message }, "plugin dependency preparation failed");
  }

  clearFor(pluginId: string): void {
    const pending = this.pendingPreparedStarts.get(pluginId);
    pending?.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled`));
    this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    this.preparingPluginIds.delete(pluginId);
    this.preparationStatuses.delete(pluginId);
    this.preparationFailures.delete(pluginId);
    this.pendingPreparedStarts.delete(pluginId);
  }

  /** Only tracks pending preparation; callers handle the already-loaded fast path. */
  waitForReady(pluginId: string): Promise<void> {
    const pending = this.pendingPreparedStarts.get(pluginId);
    if (pending) {
      return pending.ready;
    }
    const failure = this.preparationFailures.get(pluginId);
    if (failure) return Promise.reject(new Error(failure));
    return Promise.reject(new Error(`plugin '${pluginId}' is not preparing or loaded`));
  }

  isPreparing(pluginId: string): boolean {
    return this.preparingPluginIds.has(pluginId);
  }

  preparingIds(): IterableIterator<string> {
    return this.preparingPluginIds.values();
  }

  getStatus(pluginId: string): PluginPreparationStatus | undefined {
    return this.preparationStatuses.get(pluginId);
  }

  getFailure(pluginId: string): string | undefined {
    return this.preparationFailures.get(pluginId);
  }

  /** Reject waiters and advance the generation before clearing maps so late starts cannot resurrect state. */
  clear(): void {
    for (const [pluginId, pending] of this.pendingPreparedStarts) {
      pending.rejectReady(new Error(`plugin '${pluginId}' runtime dependency preparation was cancelled by runtime reset`));
      this.preparationGenerations.set(pluginId, ++this.nextPreparationGeneration);
    }
    this.preparingPluginIds.clear();
    this.preparationStatuses.clear();
    this.preparationFailures.clear();
    this.pendingPreparedStarts.clear();
    this.preparationGenerations.clear();
  }
}

interface AtomicPluginRemovalOptions<T> {
  requestedPluginId: string;
  loaded: boolean;
  known: boolean;
  hasActiveGeneration(): boolean;
  durableCommit(): Promise<T>;
  deactivateWithCommit(): Promise<CommittedPluginGeneration<T>>;
  captureRetirementFailure(retirement: Promise<void>): Promise<unknown>;
  purgeRuntimeState(): Promise<void>;
}

/** Commit durable registry removal before purging runtime state, even if retired stop hooks fail. */
async function commitAtomicPluginRemoval<T>(
  options: AtomicPluginRemovalOptions<T>,
): Promise<T> {
  if (!options.known) {
    throw new Error(
      `cannot atomically remove unknown plugin: ${options.requestedPluginId}`,
    );
  }

  let result: T;
  let retirementError: unknown;
  if (options.loaded) {
    const committed = await options.deactivateWithCommit();
    result = committed.result;
    retirementError = await options.captureRetirementFailure(
      committed.retirement,
    );
  } else {
    if (options.hasActiveGeneration()) {
      throw new Error(
        `atomic plugin removal found active generation without loaded runtime: ${options.requestedPluginId}`,
      );
    }
    result = await options.durableCommit();
  }

  await options.purgeRuntimeState();
  if (retirementError !== undefined) throw retirementError;
  return result;
}

/** Only started, actively published generations supply capabilities; installed or enabled metadata is insufficient. */
class CapabilityDependencies {
  constructor(
    private readonly manifests: ReadonlyMap<string, PluginManifest>,
    private readonly isActive: (pluginId: string) => boolean,
  ) {}

  activeManifests(excludePluginIds: readonly string[] = []): PluginManifest[] {
    const excluded = new Set(excludePluginIds);
    return [...this.manifests.entries()]
      .filter(([pluginId]) =>
        !excluded.has(pluginId)
        && this.isActive(pluginId),
      )
      .map(([, manifest]) => manifest);
  }

  missing(
    manifest: PluginManifest,
    additionallyUnavailablePluginIds: readonly string[] = [],
  ): string[] {
    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length === 0) return [];
    const result = resolveDependencies(
      requiredCapabilities,
      this.activeManifests([
        manifest.id,
        ...additionallyUnavailablePluginIds,
      ]),
    );
    return result.ok ? [] : result.missing;
  }
}

type CapabilityDependencyCommitScope = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

interface CapabilityBlockedReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface CapabilityBlockedRetry {
  readonly retry: () => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly readiness: CapabilityBlockedReadiness;
  readonly waitingForOwnPreparation?: boolean;
}

/** Internal extension implemented by PluginBundleLifecycle, never public API. */
interface CapabilityCommitScopedGenerationLifecycle
  extends PluginRuntimeGenerationLifecycle {
  replaceRuntime(
    runtime: PluginRuntimeGenerationProjection,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<void>;
  replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
}

/** Lifecycle deadlines and session activation share runtime lifetime without depending on registry loading. */

class PluginFactoryTimeoutError extends Error {
  readonly code = "plugin-factory-timeout";

  constructor(timeoutMs: number) {
    super(`plugin factory timeout (>${timeoutMs}ms)`);
  }
}

/** A factory that may have left a live child behind: neither retry nor replacement may start. */
function factoryFailureRequiresQuarantine(error: unknown): error is Error {
  return error instanceof PluginFactoryTimeoutError || error instanceof PluginChildTerminationUnverifiedError;
}

/** How one envelope registration ended: with its incarnation, or kept because termination is unverified. */
type SandboxEnvelopeSettlement = "released" | "quarantined";

/** Which plugins had not finished retiring when the shutdown deadline ended `stopAll()`. */
type PluginRuntimeShutdownReport = Readonly<{ unfinished: readonly string[] }>;

/** Shutdown may release a constructed candidate before its durable commit settles. */
type PluginCandidateConstruction = {
  readonly pluginId: string;
  /** Settles after both construction and release; release failure remains observable. */
  settled: Promise<void>;
  releaseForShutdown?: () => Promise<void>;
  readonly cleanupFailures: unknown[];
};

/** `work`'s value, or `undefined` as soon as `signal` aborts (the work keeps running). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** What retiring one generation's runtime side reads: a projection, or a loaded plugin's own fields. */
type PluginRuntimeRetirementView = Pick<
  PluginRuntimeGenerationProjection,
  "manifest" | "instance" | "lifecycleHookScope" | "hostEffects" | "disposers" | "deactivateHostApi" | "drainHostApiOperations"
>;

/** Shutdown rejects callers promptly but retains each work lease until the underlying call settles. */
class PluginRuntimeShutdownError extends Error {
  readonly code = "plugin-runtime-shutdown";

  constructor(pluginId: string, method: string) {
    super(`plugin '${pluginId}' call '${method}' aborted: the plugin runtime is shutting down`);
  }
}

class PluginStartupTimeoutError extends Error {
  readonly code = "plugin-startup-timeout";

  constructor(timeoutMs: number) {
    super(`startup timeout (>${timeoutMs}ms)`);
  }
}

/** Revoke timed-out factory authority and retain its late instance for cleanup without publishing it. */
export async function runPluginFactoryWithTimeout<T>(
  factory: () => Promise<T> | T,
  onLateResolution: (value: T) => Promise<void> | void,
  timeoutMs: number = TOOL_TIMEOUT_POLICY.pluginFactoryMs,
): Promise<T> {
  const operation = Promise.resolve().then(factory);
  let timedOut = false;
  try {
    return await raceWithTimeout(operation, timeoutMs, () => {
      timedOut = true;
      return new PluginFactoryTimeoutError(timeoutMs);
    });
  } finally {
    if (timedOut) {
      void operation.then(
        (value) => Promise.resolve(onLateResolution(value)).catch(() => undefined),
        () => undefined,
      );
    }
  }
}

/** Clamp declared startup timeouts to the host ceiling for every lifecycle path. */
export async function runStartWithTimeout(
  start: () => unknown,
  declaredTimeoutMs: number | undefined,
): Promise<void> {
  const hardTimeoutMs = Math.min(
    declaredTimeoutMs ?? TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
    TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
  );
  await raceWithTimeout(
    Promise.resolve(start()),
    hardTimeoutMs,
    () => new PluginStartupTimeoutError(hardTimeoutMs),
  );
}

/** Session activation is transient and never changes registry enablement. */
class SessionActivationTracker {
  private readonly bySession = new Map<string, Set<string>>();

  isActivated(sessionId: string, pluginId: string): boolean {
    return this.bySession.get(sessionId)?.has(pluginId) ?? false;
  }

  activate(sessionId: string, pluginId: string): void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.bySession.set(sessionId, set);
    }
    set.add(pluginId);
  }

  /** Clearing one session must preserve every other session activation. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

// Use the shared registry-manifest trust predicate so boot and runtime accept the same paths.

/** Refused registry rows remain diagnostic cards but never enter the executable load plan. */
export type RegistryLoadRefusal = {
  pluginId: string;
  /** The resolved candidate, for the diagnostic the user is shown. Never read. */
  manifestPath: string;
  reason: string;
};

/** Report untrusted registry rows through onRefused so boot can retain diagnostic cards. */
export async function resolveManifestLoadPlan(opts: {
  manifestPaths: string[];
  registryPath?: string;
  pluginsRoot?: string;
  onRefused?: (refusal: RegistryLoadRefusal) => void;
}): Promise<ManifestLoadPlan[]> {
  const plans: ManifestLoadPlan[] = opts.manifestPaths.map((manifestPath) => ({
    manifestPath,
    enabled: true,
  }));
  if (!opts.registryPath) {
    if (plans.length > 0) return plans;
    throw new Error("Either manifestPaths or registryPath must be provided.");
  }
  const registry = await readPluginRegistry(opts.registryPath);
  plans.push(
    ...registry.plugins.flatMap((entry) => {
      if (entry.pendingUpdate) {
        log.warn(`skipping pending-update registry entry for ${entry.id}`);
        return [];
      }
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(opts.registryPath!), entry.manifestPath);
      if (!opts.pluginsRoot || !isTrustedRegistryManifestPath(manifestPath, opts.pluginsRoot)) {
        const reason = opts.pluginsRoot
          ? `registry manifest path is not inside the plugin root: ${manifestPath}`
          : `registry manifest path cannot be trusted without a plugin root: ${manifestPath}`;
        log.warn(`ignoring untrusted registry manifest path for ${entry.id}: ${manifestPath}`);
        opts.onRefused?.({ pluginId: entry.id, manifestPath, reason });
        return [];
      }
      return [{
        pluginIdHint: entry.id,
        manifestPath,
        enabled: entry.enabled !== false,
        approvedPluginAccess: entry.approvedPluginAccess as PluginAccessSpec | undefined,
        installSource: entry.installSource,
        manifestSha256: entry.manifestSha256,
        ...(entry.origin ? { origin: entry.origin } : {}),
      }];
    }),
  );
  return plans;
}

/** Manifest snapshots are metadata only; receipt and package bytes must be reverified before instantiation. */
export async function readEnabledManifestSnapshots(
  loadPlan: ManifestLoadPlan[],
  validator: ValidateFunction,
): Promise<Map<string, ManifestSnapshot>> {
  const snapshots = new Map<string, ManifestSnapshot>();
  for (const plan of loadPlan) {
    try {
      const manifest = await parsePluginJson(plan.manifestPath, validator);
      // Prefer the registry id hint so lookups remain consistent when manifest.id differs.
      const key = plan.pluginIdHint ?? manifest.id;
      snapshots.set(key, {
        manifest,
        approvedPluginAccess: plan.approvedPluginAccess,
      });
    } catch (err) {
      log.warn(
        `failed to read manifest at ${plan.manifestPath} (plugin: ${plan.pluginIdHint ?? "<unknown>"}) — skipping: %s`,
        (err as Error).message,
      );
      continue;
    }
  }
  return snapshots;
}

const BOOT_PREFLIGHT_CONCURRENCY = 4;

/** Entry factories receive a resolved module; process launches resolve against their lifecycle context. */
type PluginFactorySource =
  | { readonly kind: "entry"; readonly resolvedEntryPath: string }
  | { readonly kind: "process" };

export interface PluginIntegrityEvidence {
  installSource: "marketplace" | "local-dev" | "git" | "folder";
  signerKeyId: string | null;
  artifactSha256: string | null;
  rung: PluginRung | null;
  sourceOrigin: GitInstallRecord["sourceOrigin"] | null;
}

export type PluginIntegrityCheckResult =
  | {
      ok: true;
      verified?: PluginIntegrityEvidence;
    }
  | {
      ok: false;
      reason: string;
      error?: unknown;
    };

export type BootPreflightOutcome =
  | {
      ok: true;
      plan: ManifestLoadPlan;
      manifest: PluginManifest;
      approvedPluginAccess: PluginAccessSpec | undefined;
      integrityResult?: PluginIntegrityCheckResult;
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "integrity";
      integrityResult: PluginIntegrityCheckResult & { ok: false };
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "manifest";
      error: unknown;
      integrityResult?: PluginIntegrityCheckResult;
    };

interface BootPreflightOperations {
  prepare(): Promise<unknown>;
  verify(pluginId: string, pluginRoot: string): Promise<PluginIntegrityCheckResult>;
  readManifest(manifestPath: string): Promise<PluginManifest>;
}

export async function preflightPluginLoadPlan(
  loadPlan: ManifestLoadPlan[],
  operations: BootPreflightOperations,
): Promise<BootPreflightOutcome[]> {
  if (loadPlan.length === 0) return [];
  await operations.prepare();
  return mapBoundedInOrder(
    loadPlan,
    BOOT_PREFLIGHT_CONCURRENCY,
    async (plan): Promise<BootPreflightOutcome> => {
      let integrityResult: PluginIntegrityCheckResult | undefined;
      if (plan.pluginIdHint) {
        try {
          integrityResult = await operations.verify(
            plan.pluginIdHint,
            dirname(plan.manifestPath),
          );
        } catch (error) {
          const detail = errorMessage(error);
          integrityResult = {
            ok: false,
            reason: `install receipt verification failed unexpectedly: ${detail}`,
            error,
          };
        }
        if (!integrityResult.ok) {
          return { ok: false, plan, kind: "integrity", integrityResult };
        }
      }
      try {
        return {
          ok: true,
          plan,
          manifest: await operations.readManifest(plan.manifestPath),
          approvedPluginAccess: plan.approvedPluginAccess,
          integrityResult,
        };
      } catch (error) {
        return { ok: false, plan, kind: "manifest", error, integrityResult };
      }
    },
  );
}

async function mapBoundedInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapItem(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
  );
  return results;
}

type IntegrityAuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

export async function verifyPluginIntegrity(
  cacheRoot: string | undefined,
  pluginId: string,
  pluginRoot: string,
): Promise<PluginIntegrityCheckResult> {
  if (!cacheRoot) return { ok: true };
  const receiptResult = await verifyInstallReceipt(cacheRoot, pluginId, pluginRoot);
  if (!receiptResult.ok) {
    return { ok: false, reason: receiptResult.reason };
  }
  const { installSource } = receiptResult.receipt;
  if (receiptResult.receipt.installSource === "git" || receiptResult.receipt.installSource === "folder") {
    const document: unknown = JSON.parse(await readFile(resolve(pluginRoot, "plugin.json"), "utf8"));
    const authority = manifestAuthority(document);
    const expected = receiptResult.receipt.installSource === "git"
      ? receiptResult.receipt.git.authoritySha256
      : receiptResult.receipt.folder.authoritySha256;
    if (expected && (!authority || sha256Hex(canonicalJSON(authority)) !== expected)) {
      return { ok: false, reason: "plugin authority differs from install review" };
    }
    if (!expected && authority?.sandbox !== undefined) {
      return { ok: false, reason: "sandbox authority has no install review evidence" };
    }
  }
  if (installSource === "local-dev" && !isDevModeUnlocked()) {
    return {
      ok: false,
      reason: "local-dev install rejected in packaged build",
    };
  }
  return {
    ok: true,
    verified: integrityEvidence(receiptResult.receipt),
  };
}

function integrityEvidence(receipt: PluginInstallReceipt): PluginIntegrityEvidence {
  return {
    installSource: receipt.installSource,
    artifactSha256: receipt.artifactSha256,
    signerKeyId: receipt.signerKeyId,
    rung: receipt.installSource === "git" ? receipt.git.rung : receipt.installSource === "folder" ? "folder" : null,
    sourceOrigin: receipt.installSource === "git" ? receipt.git.sourceOrigin : null,
  };
}

function reportPluginIntegrity(
  pluginId: string,
  result: PluginIntegrityCheckResult,
  auditLog: IntegrityAuditLog | undefined,
): void {
  if (!result.ok) {
    log.error(
      {
        pluginId,
        reason: result.reason,
        ...(result.error === undefined ? {} : { err: result.error }),
      },
      `${pluginId} rejected — install receipt integrity failed`,
    );
    try {
      auditLog?.("error", "plugin_integrity_rejected", {
        pluginId,
        reason: result.reason,
      });
    } catch (error) {
      log.error({ pluginId, err: error }, "plugin integrity rejection audit failed");
    }
    return;
  }
  if (!result.verified) return;
  try {
    auditLog?.("info", "plugin_integrity_verified", {
      pluginId,
      ...result.verified,
    });
  } catch (error) {
    log.error({ pluginId, err: error }, "plugin integrity verification audit failed");
  }
}

const START_FAILURE_STOP_TIMEOUT_MS = 2_000;
const HOST_API_OPERATION_DRAIN_TIMEOUT_MS = 10_000;

type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

/** Keep each routed factory paired with its arm for generation diagnostics. */
type RoutedPluginFactory = { createPlugin: RuntimePluginFactory; arm: PluginLoadArm };

interface PendingRestartCancellation {
  generation: number;
  cancelled: boolean;
  readonly promise: Promise<void>;
  cancel(): void;
}

function createPendingRestartCancellation(): PendingRestartCancellation {
  let resolveCancellation!: () => void;
  return {
    generation: 0,
    cancelled: false,
    promise: new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    }),
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      resolveCancellation();
    },
  };
}

abstract class PluginRuntimeState {
  protected readonly hostRoot: string;
  protected readonly childEntryPath: string;
  protected readonly encryption: SecretEncryption;
  protected readonly manifestPaths: string[];
  protected readonly registryPath?: string;
  protected readonly pluginsRoot?: string;
  protected readonly configStore: ConfigOverrideStore;
  protected readonly createHostApi: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
    installPluginId: string | null,
    candidateRegistryEntry?: Readonly<
      PluginRegistryTrust
    >,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ) => PluginHostApi;
  protected readonly deploymentGuard?: PluginDeploymentGuard;
  protected readonly installReceiptCacheRoot?: string;
  protected readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  protected readonly onMalformedCredentialSelector?: (pluginId: string) => void;
  protected readonly onDisable?: (pluginId: string) => void;
  protected readonly onPluginUiRevisionChange?: (pluginId: string) => void;
  protected readonly onEnable?: (pluginId: string) => void;
  protected readonly onActiveStateChange?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<void> | void;
  protected readonly preparePluginStart?: (context: PluginStartPreparationContext) => PluginStartPreparationReturn;
  protected plugins = new Map<string, LoadedPlugin>();
  private readonly sandboxEnvelopes = new Map<string, Set<{
    grants: ReturnType<typeof capturePluginSandboxGrant>[];
    pluginRoot: string;
    pluginDataDir: string;
    active: boolean;
    quarantined: boolean;
    terminating: boolean;
    settled: Promise<SandboxEnvelopeSettlement>;
    resolveSettled: (settlement: SandboxEnvelopeSettlement) => void;
  }>>();

  protected registerSandboxEnvelope(pluginId: string, paths: readonly string[], pluginRoot: string, pluginDataDir: string): {
    assertCurrent(): void;
    dispose(): void;
    quarantine(reason: string): void;
    terminating(): void;
  } {
    // Make-before-break may start a replacement beside a live incumbent, never beside one whose
    // termination has begun but is not yet verified, nor beside a quarantined one.
    for (const existing of this.sandboxEnvelopes.get(pluginId) ?? []) {
      if (existing.quarantined) this.assertPluginLifecycleAvailable(pluginId);
      if (existing.quarantined || existing.terminating) {
        throw Object.assign(new Error(
          `Plugin child termination is not yet verified; refusing a replacement beside it: ${pluginId}`,
        ), { code: existing.quarantined ? "plugin-lifecycle-quarantined" : "plugin-child-termination-pending" });
      }
    }
    let resolveSettled!: (settlement: SandboxEnvelopeSettlement) => void;
    const settled = new Promise<SandboxEnvelopeSettlement>((resolve) => { resolveSettled = resolve; });
    const record = { grants: paths.map(capturePluginSandboxGrant), pluginRoot, pluginDataDir, active: true, quarantined: false, terminating: false, settled, resolveSettled };
    const entries = this.sandboxEnvelopes.get(pluginId) ?? new Set<typeof record>();
    entries.add(record);
    this.sandboxEnvelopes.set(pluginId, entries);
    return {
      assertCurrent: () => {
        if (!record.active || record.grants.some((grant) => !isPluginSandboxGrantCovered(grant, pluginRoot, pluginDataDir))) {
          throw new Error("sandbox-grant-outside-ceiling");
        }
      },
      // Idempotent: a second release must not drop a later incarnation's entry set.
      dispose: () => {
        if (record.quarantined || !entries.delete(record)) return;
        if (entries.size === 0 && this.sandboxEnvelopes.get(pluginId) === entries) this.sandboxEnvelopes.delete(pluginId);
        record.resolveSettled("released");
      },
      // The record and its grants stay registered, inactive, so every later check fails closed and
      // withdrawal reports it instead of waiting for a release that verified termination alone can give.
      quarantine: (reason) => {
        if (record.quarantined || !entries.has(record)) return;
        record.active = false;
        record.quarantined = true;
        this.quarantinePluginLifecycle(pluginId, reason);
        record.resolveSettled("quarantined");
      },
      terminating: () => {
        record.terminating = true;
      },
    };
  }

  protected sandboxGrantWithdrawals(): Array<{ pluginId: string; settled: Promise<SandboxEnvelopeSettlement[]> }> {
    const affected: Array<{ pluginId: string; settled: Promise<SandboxEnvelopeSettlement[]> }> = [];
    for (const [pluginId, entries] of this.sandboxEnvelopes) {
      // A quarantined record is already inactive; only its grants leaving the ceiling select it again.
      if (![...entries].some((entry) => (!entry.active && !entry.quarantined) || entry.grants.some((grant) =>
        !isPluginSandboxGrantCovered(grant, entry.pluginRoot, entry.pluginDataDir)))) continue;
      for (const entry of entries) entry.active = false;
      affected.push({ pluginId, settled: Promise.all([...entries].map((entry) => entry.settled)) });
    }
    return affected;
  }
  protected methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  protected readonly perf = new PerfStatsTracker();
  protected disposers = new Map<string, Array<() => void>>();
  protected readonly knownPluginManifests = new Map<string, PluginManifest>();
  protected readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  protected readonly knownInstallAliases = new Map<string, Set<string>>();
  protected readonly knownInstallClaims = new Map<string, string | null>();
  private readonly pendingInstallIdentityOwners = new Map<string, symbol>();
  protected readonly knownToolOwners = new Map<string, string>();
  protected readonly knownEventOwners = new Map<string, string>();
  protected readonly failedPluginIds = new Set<string>();
  protected readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  /** Classify load failures by canonical id, or registry hint when no manifest can be read. */
  protected readonly loadFailureInfo = new Map<
    string,
    {
      installFailureKind?: PluginInstallFailureKind;
      installFailureMessage?: string;
      /** Only construction failures reached after routing have an arm. */
      arm?: PluginLoadArm;
      confinement?: PluginConfinementReport;
    }
  >();
  /** A refused replacement records attempt diagnostics while the loaded incumbent keeps serving. */
  protected readonly lastAttemptRefusal = new Map<string, PluginAttemptRefusal>();
  /** Confinement belongs to one routed factory attempt; an unspawned factory has no child confinement. */
  private readonly childSpawnConfinements = new WeakMap<RuntimePluginFactory, SpawnConfinement>();

  protected recordChildSpawnConfinement(createPlugin: RuntimePluginFactory, confinement: SpawnConfinement): void {
    this.childSpawnConfinements.set(createPlugin, confinement);
  }

  protected confinementReport(createPlugin: RuntimePluginFactory): PluginConfinementReport {
    return this.childSpawnConfinements.get(createPlugin) ?? "not-spawned";
  }
  protected readonly disabledPluginIds = new Set<string>();
  /** Inactive means model exposure is off; absence from this set defaults to active. */
  protected readonly inactivePluginIds = new Set<string>();
  protected readonly preparation: PreparationTracker;
  /** Loaded or requested consumers waiting for a preparing capability provider. */
  protected readonly capabilityBlockedPluginIds = new Set<string>();
  protected readonly pendingRestarts = new Map<string, Promise<RestartPluginResult>>();
  protected readonly pendingRestartPreparations = new Map<
    string,
    Promise<PluginStartPreparationOutcome>
  >();
  /** Per-login nonces prevent a later login to the same account from reviving earlier grants. */
  protected pluginAccountHashes = new Map<string, {
    identityHash: string;
    principalHash: string;
  }>();
  /** Latest auth invocation admitted for each immutable plugin generation. */
  protected pluginAuthInvocationEpochs = new Map<string, number>();
  /** Latest auth result that actually published for each immutable generation. */
  protected pluginAuthPublishedEpochs = new Map<string, number>();
  /** Failed refresh revokes its captured authority unless a later result published; a later start is insufficient. */
  protected pluginAuthFailurePrincipals = new Map<string, {
    principalHash: string;
    generationId: string;
  }>();
  /** Retain stable account identity across auth transitions to preserve their operation FIFO. */
  protected pluginAuthTransitionPrincipals = new Map<string, {
    identityHash: string;
    principalHash: string;
    generationId: string;
  }>();
  protected nextPluginAuthInvocationEpoch = 0;
  protected readonly pendingRestartCancellations = new Map<string, PendingRestartCancellation>();
  /** Monotonic generation used to reject stale async add/restart commits. */
  protected readonly pluginLifecycleGenerations = new Map<string, number>();
  /** Quarantine unknowable in-process work for the process lifetime; uncancellable bodies must not overlap a new incarnation. */
  protected readonly quarantinedPluginLifecycles = new Map<string, string>();
  /** HostApi incarnations whose plugin factory has not committed an instance. */
  private readonly pendingHostApiIncarnations = new Map<string, Set<() => void>>();
  /** A RuntimePlugin instance's stop hook must execute at most once. */
  private readonly pluginStopOperations = new WeakMap<RuntimePlugin, Promise<boolean>>();
  protected nextPluginLifecycleGeneration = 0;
  protected readonly pluginUiRevisions = new Map<string, number>();
  protected nextPluginUiRevision = 0;
  protected toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
  protected generationAccess: PluginRuntimeGenerationAccess | undefined;
  protected generationLifecycle: PluginRuntimeGenerationLifecycle | undefined;
  /** A committed generation owns its resources even if runtime publication fails; retire it exactly once. */
  protected readonly committedUnmappedGenerations = new Map<string, PluginRuntimeGenerationProjection>();
  /** Checkpoint retirement per phase and generation; failed phases remain retryable. */
  private readonly retirementPhaseRuns = new WeakMap<RuntimePlugin, Map<PluginRuntimeRetirementPhase, Promise<void>>>();
  /** Retry failed disposers only; successful disposers must not run twice. */
  private readonly completedRetirementDisposers = new WeakMap<RuntimePlugin, Set<() => void>>();
  /** Shutdown closes all generation admission and rejects callers waiting on leases or transitions. */
  protected readonly runtimeShutdownAdmission = new AbortController();
  /** Aborted when shutdown gives up waiting for in-flight plugin calls. */
  protected readonly runtimeShutdown = new AbortController();

  /** Stop host notifications when shutdown begins, alongside the incarnation guard. */
  isShuttingDown(): boolean {
    return this.runtimeShutdownAdmission.signal.aborted;
  }

  /** Close runtime and coordinator admission before publication can interleave; admitted calls keep running. */
  beginShutdown(): void {
    this.runtimeShutdownAdmission.abort();
    this.generationLifecycle?.closeAdmission(
      (pluginId) => new PluginRuntimeShutdownError(pluginId, "generation admission"),
    );
  }
  /** Uncommitted lifecycle candidates release what they built during shutdown, within its deadline. */
  protected readonly candidateConstructions = new Set<PluginCandidateConstruction>();

  protected trackCandidateConstruction<T>(
    pluginId: string,
    start: (construction: PluginCandidateConstruction) => Promise<T>,
  ): Promise<T> {
    const construction: PluginCandidateConstruction = { pluginId, settled: Promise.resolve(), cleanupFailures: [] };
    const work = start(construction);
    construction.settled = work.then(() => undefined, () => undefined).then(() => {
      if (construction.cleanupFailures.length > 0) {
        throw new AggregateError(construction.cleanupFailures, `plugin '${pluginId}' candidate cleanup failed`);
      }
    });
    this.candidateConstructions.add(construction);
    void construction.settled
      .finally(() => this.candidateConstructions.delete(construction))
      .catch(() => undefined);
    return work;
  }
  protected readonly pinnedGenerations =
    new AsyncLocalStorage<ReadonlyMap<string, string>>();
  /** Serialize only the final capability generation-pointer commit; imports, factories, and startup run outside the queue. */
  private capabilityDependencyCommitTail: Promise<void> = Promise.resolve();
  protected loaded = false;

  protected async withCapabilityDependencyCommit<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.capabilityDependencyCommitTail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.capabilityDependencyCommitTail = previous.then(() => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  protected createPendingRestartCancellation(): PendingRestartCancellation {
    return createPendingRestartCancellation();
  }
  protected manifestValidator: ValidateFunction | null = null;
  protected manifestValidatorPromise: Promise<ValidateFunction> | null = null;

  protected abstract instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts?: { skipPreparation?: boolean; shouldCommit?: () => boolean },
  ): Promise<SinglePluginStartResult>;

  protected hasTrackedPluginState(pluginId: string): boolean {
    return this.plugins.has(pluginId)
      || this.knownPluginManifests.has(pluginId)
      || this.failedPluginIds.has(pluginId)
      || this.failedPluginStubs.has(pluginId)
      || this.disabledPluginIds.has(pluginId)
      || this.inactivePluginIds.has(pluginId);
  }

  constructor(options: PluginRuntimeOptions) {
    if (typeof options.createHostApi !== "function") {
      throw new Error(
        "PluginRuntime requires an explicit createHostApi factory; test harnesses may inject createNoopHostApiForTests",
      );
    }
    if (typeof options.childEntryPath !== "string" || !isAbsolute(options.childEntryPath)) {
      throw new Error(
        "PluginRuntime requires an absolute childEntryPath: the composition root resolves the plugin child's entry module",
      );
    }
    this.hostRoot = resolve(options.hostRoot);
    this.childEntryPath = options.childEntryPath;
    this.encryption = options.encryption;
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : undefined;
    this.configStore = new ConfigOverrideStore(options.configOverrides ?? {});
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.installReceiptCacheRoot = options.installReceiptCacheRoot
      ? resolve(options.installReceiptCacheRoot)
      : undefined;
    this.auditLog = options.auditLog;
    this.onMalformedCredentialSelector = options.onMalformedCredentialSelector;
    this.onDisable = options.onDisable;
    this.onPluginUiRevisionChange = options.onPluginUiRevisionChange;
    this.onEnable = options.onEnable;
    this.onActiveStateChange = options.onActiveStateChange;
    this.preparePluginStart = options.preparePluginStart;
    this.preparation = new PreparationTracker({
      preparePluginStart: options.preparePluginStart,
      applyConfigOverride: (pluginId, configOverride) =>
        this.mergeConfigOverride(pluginId, configOverride),
      instantiateAndStartSinglePlugin: (plan, manifest, approvedPluginAccess, opts) =>
        this.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, opts),
      markFailed: (pluginId, stub) => this.markFailed(pluginId, stub),
      onDisable: options.onDisable,
    });
  }

  /** Tests observe the live override map rather than a snapshot. */
  protected get configOverrides(): Record<string, Record<string, unknown>> {
    return this.configStore.all();
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.set(this.resolveKnownPluginId(pluginId), config);
  }

  getConfigOverride(pluginId: string): Record<string, unknown> | undefined {
    return this.configStore.get(this.resolveKnownPluginId(pluginId));
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.merge(this.resolveKnownPluginId(pluginId), config);
  }

  setWildcardConfigOverride(config: Record<string, unknown>): void {
    this.configStore.setWildcard(config);
  }

  getWildcardConfigOverride(): Record<string, unknown> {
    return this.configStore.getWildcard();
  }

  /** Clear named wildcard keys without deleting unrelated host values. */
  clearWildcardConfigOverride(keys: string[]): void {
    this.configStore.clearWildcard(keys);
  }

  protected matchesManifestPath(manifestPath: string, pluginId: string): boolean {
    const dirName = basename(dirname(manifestPath));
    return dirName === pluginId
      || dirName === pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  protected async verifyReceiptAndDevGuard(
    pluginId: string,
    pluginRoot: string,
    options: { report?: boolean } = {},
  ): Promise<PluginIntegrityCheckResult> {
    const result = await verifyPluginIntegrity(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (options.report !== false) {
      this.reportPluginIntegrityResult(pluginId, result);
    }
    return result;
  }

  protected reportPluginIntegrityResult(
    pluginId: string,
    result: PluginIntegrityCheckResult,
  ): void {
    reportPluginIntegrity(pluginId, result, this.auditLog);
  }

  protected async getManifestValidator(): Promise<ValidateFunction> {
    if (this.manifestValidator) return this.manifestValidator;
    if (!this.manifestValidatorPromise) {
      this.manifestValidatorPromise = buildManifestValidator()
        .then((validator) => {
          this.manifestValidator = validator;
          return validator;
        })
        .finally(() => {
          this.manifestValidatorPromise = null;
        });
    }
    return this.manifestValidatorPromise;
  }

  protected async readManifest(
    path: string,
    options: { report?: boolean } = {},
  ): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    try {
      return await parsePluginJson(path, validator);
    } catch (err) {
      if (options.report !== false) this.reportPluginManifestRejected(path, err);
      throw err;
    }
  }

  protected reportPluginManifestRejected(path: string, error: unknown): void {
    try {
      this.auditLog?.("error", "plugin_manifest_rejected", {
        manifestPath: path,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } catch (auditError) {
      log.error({ manifestPath: path, err: auditError }, "plugin manifest rejection audit failed");
    }
  }

  protected resolveEntryPathForPlugin(pluginRoot: string, entry: string): string {
    return resolveEntryPath(pluginRoot, entry, this.hostRoot);
  }

  /** The factory source a manifest names in a generation; throws for an `entry` path outside it. */
  protected pluginFactorySource(manifest: PluginManifest, generationRoot: string): PluginFactorySource {
    if (manifest.process !== undefined) return { kind: "process" };
    return {
      kind: "entry",
      resolvedEntryPath: resolveRealEntryPath(this.resolveEntryPathForPlugin(generationRoot, manifest.entry)),
    };
  }

  protected ensureDataDir(pluginId: string, pluginRoot: string): string {
    return ensurePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  /** Resolve the data directory without creating it on per-request paths. */
  protected resolveDataDir(pluginId: string, pluginRoot: string): string {
    return resolvePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  protected buildHostApiIncarnation(
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    hostEffects?: HostApiGenerationScope,
    installPluginId: string | null = this.requirePluginInstallClaim(pluginId),
    candidateRegistryEntry?: Readonly<
      PluginRegistryTrust
    >,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ): {
    hostApi: PluginHostApi;
    disposers: Array<() => void>;
    deactivate: () => void;
    drainOperations: () => Promise<void>;
    commit: () => void;
    lifecycleHookScope: PluginLifecycleHookScope;
  } {
    const disposers: Array<() => void> = [];
    const pendingOperations = new Set<Promise<unknown>>();
    let active = true;
    const lifecycleHookScope: PluginLifecycleHookScope = { active: true, depth: 0 };
    let pending = true;
    let deactivate!: () => void;
    const forgetPending = () => {
      const pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
      pendingForPlugin?.delete(deactivate);
      if (pendingForPlugin?.size === 0) {
        this.pendingHostApiIncarnations.delete(pluginId);
      }
      pending = false;
    };
    deactivate = () => {
      if (!active && !pending) return;
      active = false;
      lifecycleHookScope.active = false;
      lifecycleHookScope.depth = 0;
      if (pending) {
        forgetPending();
        // Pending factories may never settle; revoke and splice their private disposers now so late cleanup is idempotent.
        const pendingDisposers = disposers.splice(0);
        this.runDisposerList(pendingDisposers, "pending HostApi invalidation");
      }
    };
    let pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
    if (!pendingForPlugin) {
      pendingForPlugin = new Set();
      this.pendingHostApiIncarnations.set(pluginId, pendingForPlugin);
    }
    pendingForPlugin.add(deactivate);
    const incarnation: PluginHostApiIncarnation = {
      registerDisposer: (dispose) => {
        if (active) {
          disposers.push(dispose);
          return;
        }
        try { dispose(); } catch {  }
      },
      trackOperation: <T>(operation: Promise<T>): Promise<T> => {
        const tracked = Promise.resolve(operation);
        pendingOperations.add(tracked);
        void tracked.then(
          () => pendingOperations.delete(tracked),
          () => pendingOperations.delete(tracked),
        );
        return tracked;
      },
      isActive: () => active,
      isLifecycleHookActive: () =>
        lifecycleHookScope.active && lifecycleHookScope.depth > 0,
      ...(hostEffects ? { generationScope: hostEffects } : {}),
    };
    try {
      const rawHostApi = this.createHostApi(
        pluginId,
        manifest,
        pluginDataDir,
        incarnation,
        installPluginId,
        candidateRegistryEntry,
        candidateApprovedPluginAccess,
      );
      const hostApi = hostEffects ? hostEffects.wrapHostApi(rawHostApi) : rawHostApi;
      // Partial test HostApi objects may omit required storage.
      if (!hostApi.storage) {
        throw new Error(
          `createHostApi returned an incomplete HostApi without storage: ${pluginId}`,
        );
      }
      return {
        hostApi,
        disposers,
        deactivate,
        drainOperations: async () => {
          if (pendingOperations.size === 0) return;
          await raceWithTimeout(
            Promise.allSettled([...pendingOperations]),
            HOST_API_OPERATION_DRAIN_TIMEOUT_MS,
            () => new Error(
              `HostApi operation drain timeout (>${HOST_API_OPERATION_DRAIN_TIMEOUT_MS}ms)`,
            ),
          );
        },
        lifecycleHookScope,
        commit: () => {
          if (!active) {
            throw new Error(`Cannot commit inactive HostApi incarnation: ${pluginId}`);
          }
          if (pending) forgetPending();
        },
      };
    } catch (err) {
      deactivate();
      throw err;
    }
  }

  protected async runPluginLifecycleHook<T>(
    scope: PluginLifecycleHookScope | undefined,
    hook: () => Promise<T> | T,
  ): Promise<T> {
    if (!scope) return await hook();
    scope.depth += 1;
    try {
      return await hook();
    } finally {
      scope.depth = Math.max(0, scope.depth - 1);
    }
  }

  protected markPluginUiRevision(pluginId: string): number {
    const revision = ++this.nextPluginUiRevision;
    this.pluginUiRevisions.set(pluginId, revision);
    this.onPluginUiRevisionChange?.(pluginId);
    return revision;
  }

  protected invalidatePluginUiRevision(pluginId: string): void {
    this.pluginUiRevisions.delete(pluginId);
    this.onPluginUiRevisionChange?.(pluginId);
  }

  protected getPluginUiRevision(pluginId: string): number {
    return this.pluginUiRevisions.get(pluginId) ?? this.markPluginUiRevision(pluginId);
  }

  protected buildPluginUiEntryUrl(pluginId: string, manifest: PluginManifest, entryPath: string): string {
    const url = new URL(buildImportUrl(entryPath));
    url.searchParams.set("avePluginVersion", manifest.version ?? "0");
    url.searchParams.set("aveRuntimeRevision", String(this.getPluginUiRevision(pluginId)));
    return url.href;
  }

  protected async resolveManifestLoadPlanInternal(onRefused?: (refusal: RegistryLoadRefusal) => void): Promise<ManifestLoadPlan[]> {
    return resolveManifestLoadPlan({
      manifestPaths: this.manifestPaths,
      registryPath: this.registryPath,
      pluginsRoot: this.pluginsRoot,
      onRefused,
    });
  }

  /** Known tool owners are model-only because origin permission checks use this fallback; app-only tools must not enter it. */
  protected rememberToolOwners(pluginId: string, manifest: PluginManifest): void {
    for (const t of (manifest.tools ?? []).filter(isModelVisible)) {
      this.knownToolOwners.set(t.name, pluginId);
    }
  }

  protected rememberPluginManifest(
    pluginId: string,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
  ): void {
    this.knownPluginManifests.set(pluginId, manifest);
    if (approvedPluginAccess) {
      this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
    } else {
      this.knownPluginAccessGrants.delete(pluginId);
    }
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === pluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === pluginId) this.knownEventOwners.delete(eventType);
    }
    this.rememberToolOwners(pluginId, manifest);
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, pluginId);
    }
  }

  protected rememberPluginInstallAlias(pluginId: string, alias: string | undefined): void {
    const normalizedPluginId = pluginId.trim();
    const normalizedAlias = alias?.trim() || undefined;
    if (!normalizedPluginId) return;
    this.assertPluginIdentityNamespace([
      { pluginId: normalizedPluginId, alias: normalizedAlias },
    ]);
    this.publishValidatedPluginInstallAlias(normalizedPluginId, normalizedAlias);
  }

  protected publishValidatedPluginInstallAlias(
    normalizedPluginId: string,
    normalizedAlias: string | undefined,
  ): void {
    this.knownInstallClaims.set(normalizedPluginId, normalizedAlias ?? null);
    if (!normalizedAlias || normalizedAlias === normalizedPluginId) return;
    let aliases = this.knownInstallAliases.get(normalizedPluginId);
    if (!aliases) {
      aliases = new Set<string>();
      this.knownInstallAliases.set(normalizedPluginId, aliases);
    }
    aliases.add(normalizedAlias);
  }

  /** Manifest ids and deployment aliases share one unambiguous namespace; validate both full plans and incremental adoption. */
  protected assertPluginIdentityNamespace(
    mappings: Iterable<{ pluginId: string; alias?: string }>,
    reservedInstallIds: Iterable<string> = [],
  ): void {
    const normalizedMappings = [...mappings]
      .map(({ pluginId, alias }) => ({
        pluginId: pluginId.trim(),
        alias: alias?.trim(),
      }))
      .filter(({ pluginId }) => pluginId.length > 0);
    const normalizedReservedIds = [...reservedInstallIds]
      .map((pluginId) => pluginId.trim())
      .filter(Boolean);
    const existingCanonicalIds = new Set([
      ...this.knownPluginManifests.keys(),
      ...this.plugins.keys(),
      ...this.knownInstallAliases.keys(),
      ...this.knownInstallClaims.keys(),
    ]);
    const canonicalIds = new Set([
      ...existingCanonicalIds,
      ...normalizedMappings.map(({ pluginId }) => pluginId),
    ]);
    const aliasOwners = new Map<string, string>();

    const recordAliasOwner = (alias: string, canonicalId: string) => {
      const existingOwner = aliasOwners.get(alias);
      if (existingOwner && existingOwner !== canonicalId) {
        throw this.pluginIdentityCollision(
          alias,
          `install alias for both '${existingOwner}' and '${canonicalId}'`,
        );
      }
      aliasOwners.set(alias, canonicalId);
    };
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      for (const alias of aliases) recordAliasOwner(alias, canonicalId);
    }

    const canonicalClaimCounts = new Map<string, number>();
    for (const { pluginId, alias } of normalizedMappings) {
      const claimCount = (canonicalClaimCounts.get(pluginId) ?? 0) + 1;
      canonicalClaimCounts.set(pluginId, claimCount);
      if (claimCount > 1) {
        throw this.pluginIdentityCollision(
          pluginId,
          `multiple active artifacts claim canonical id '${pluginId}'`,
        );
      }
      const aliasOwner = aliasOwners.get(pluginId);
      if (aliasOwner && aliasOwner !== pluginId) {
        throw this.pluginIdentityCollision(
          pluginId,
          `canonical id for '${pluginId}' and install alias for '${aliasOwner}'`,
        );
      }
      if (existingCanonicalIds.has(pluginId)) {
        const incomingClaim = alias ?? null;
        const reusesKnownIdentity = this.knownInstallClaims.has(pluginId)
          ? this.knownInstallClaims.get(pluginId) === incomingClaim
          : !alias
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : alias === pluginId
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : this.knownInstallAliases.get(pluginId)?.has(alias) === true;
        if (!reusesKnownIdentity) {
          throw this.pluginIdentityCollision(
            alias ?? pluginId,
            `new artifact claim for existing canonical id '${pluginId}'`,
          );
        }
      }
    }
    for (const { pluginId, alias } of normalizedMappings) {
      if (!alias || alias === pluginId) continue;
      if (canonicalIds.has(alias)) {
        throw this.pluginIdentityCollision(
          alias,
          `canonical id for '${alias}' and install alias for '${pluginId}'`,
        );
      }
      recordAliasOwner(alias, pluginId);
    }

    // Failed rows still reserve raw registry ids for diagnostics and cleanup; reject overlaps with canonical ids or aliases.
    const successfulClaimCounts = new Map<string, number>();
    for (const { alias } of normalizedMappings) {
      if (!alias) continue;
      successfulClaimCounts.set(alias, (successfulClaimCounts.get(alias) ?? 0) + 1);
    }
    for (const reservedId of normalizedReservedIds) {
      const successfulClaims = successfulClaimCounts.get(reservedId) ?? 0;
      if (successfulClaims > 0) {
        successfulClaimCounts.set(reservedId, successfulClaims - 1);
        continue;
      }
      const aliasOwner = aliasOwners.get(reservedId);
      if (canonicalIds.has(reservedId) || aliasOwner) {
        throw this.pluginIdentityCollision(
          reservedId,
          aliasOwner
            ? `failed registry id and install alias for '${aliasOwner}'`
            : `failed registry id and canonical id for '${reservedId}'`,
        );
      }
    }
  }

  protected async assertCurrentPluginIdentityLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Array<{ plan: ManifestLoadPlan; snapshot: ManifestSnapshot }>> {
    const currentIdentities: Array<{
      plan: ManifestLoadPlan;
      snapshot: ManifestSnapshot;
    }> = [];
    for (const plan of loadPlan) {
      try {
        currentIdentities.push({
          plan,
          snapshot: {
            manifest: await this.readManifest(plan.manifestPath, { report: false }),
            approvedPluginAccess: plan.approvedPluginAccess,
          },
        });
      } catch {
        // Raw registry ids are still reserved below when a manifest is invalid.
      }
    }
    this.assertPluginIdentityNamespace(
      currentIdentities.map(({ plan, snapshot }) => ({
        pluginId: snapshot.manifest.id,
        alias: plan.pluginIdHint,
      })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    return currentIdentities;
  }

  private pluginIdentityCollision(identifier: string, detail: string): Error {
    const error = new Error(
      `Plugin identity collision for '${identifier}': ${detail}`,
    ) as Error & { code?: string };
    error.code = "plugin-identity-collision";
    return error;
  }

  protected resolveKnownPluginId(pluginId: string): string {
    if (this.knownInstallAliases.has(pluginId)) return pluginId;
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      if (aliases.has(pluginId)) return canonicalId;
    }
    return pluginId;
  }

  protected getPluginInstallAliases(pluginId: string): string[] | undefined {
    const aliases = this.knownInstallAliases.get(pluginId);
    if (!aliases || aliases.size === 0) return undefined;
    return [...aliases].sort();
  }

  protected getPluginInstallClaim(pluginId: string): string | null | undefined {
    return this.knownInstallClaims.get(pluginId);
  }

  protected requirePluginInstallClaim(pluginId: string): string | null {
    const installClaim = this.getPluginInstallClaim(this.resolveKnownPluginId(pluginId));
    if (installClaim === undefined) {
      throw new Error(`Plugin install provenance unknown: ${pluginId}`);
    }
    return installClaim;
  }

  protected validatePreparedInstallIdentity(pluginId: string, installId: string): string {
    const normalized = installId.trim();
    if (!normalized) {
      throw new Error(`prepared artifact install identity missing for '${pluginId}'`);
    }
    this.assertPluginIdentityNamespace(
      [{ pluginId, alias: normalized }],
      [normalized],
    );
    return normalized;
  }

  protected reservePreparedInstallIdentity(
    pluginId: string,
    installId: string,
  ): { installId: string; release(): void } {
    const normalized = this.validatePreparedInstallIdentity(pluginId, installId);
    const identifiers = [...new Set([pluginId, normalized])];
    for (const identifier of identifiers) {
      if (this.pendingInstallIdentityOwners.has(identifier)) {
        throw this.pluginIdentityCollision(
          identifier,
          "reserved by another prepared activation",
        );
      }
    }
    const owner = Symbol(`prepared-plugin-identity:${pluginId}`);
    for (const identifier of identifiers) {
      this.pendingInstallIdentityOwners.set(identifier, owner);
    }
    let released = false;
    return {
      installId: normalized,
      release: () => {
        if (released) return;
        released = true;
        for (const identifier of identifiers) {
          if (this.pendingInstallIdentityOwners.get(identifier) === owner) {
            this.pendingInstallIdentityOwners.delete(identifier);
          }
        }
      },
    };
  }

  protected async withPreparedInstallIdentity<T>(
    pluginId: string,
    installId: string,
    operation: (normalizedInstallId: string) => Promise<T>,
  ): Promise<T> {
    const reservation = this.reservePreparedInstallIdentity(pluginId, installId);
    try {
      return await operation(reservation.installId);
    } finally {
      reservation.release();
    }
  }

  /** Hash the authored plugin.json document, not its flattened projection, to match registry receipt pins. */
  protected validatePreparedRegistryEntry(
    manifest: PluginManifest,
    registryEntry: Readonly<
      PluginRegistryTrust
    > | undefined,
    manifestDocument: unknown,
  ): Readonly<PluginRegistryTrust> {
    if (!registryEntry) {
      throw new Error(`prepared artifact registry provenance missing for '${manifest.id}'`);
    }
    const candidateManifestSha256 = sha256Hex(canonicalJSON(manifestDocument));
    if (
      registryEntry.manifestSha256 !== undefined
      && registryEntry.manifestSha256 !== candidateManifestSha256
    ) {
      throw new Error(`prepared artifact registry manifest provenance changed for '${manifest.id}'`);
    }
    return Object.freeze({ ...registryEntry });
  }

  protected assertPluginManifestIdentity(
    expectedPluginId: string,
    actualPluginId: string,
  ): void {
    if (expectedPluginId === actualPluginId) return;
    throw this.pluginIdentityCollision(
      actualPluginId,
      `manifest id changed from active canonical id '${expectedPluginId}'`,
    );
  }

  protected beginPluginLifecycleOperation(
    pluginId: string,
    preserveRestartCancellation?: PendingRestartCancellation,
  ): number {
    const generation = ++this.nextPluginLifecycleGeneration;
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const lifecycleIds = new Set([
      pluginId,
      canonicalId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    for (const lifecycleId of lifecycleIds) {
      const cancellation = this.pendingRestartCancellations.get(lifecycleId);
      if (cancellation !== preserveRestartCancellation) cancellation?.cancel();
      for (const deactivate of this.pendingHostApiIncarnations.get(lifecycleId) ?? []) {
        deactivate();
      }
    }
    this.pluginLifecycleGenerations.set(canonicalId, generation);
    this.pluginLifecycleGenerations.set(pluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return generation;
  }

  protected assertPluginLifecycleAvailable(pluginId: string): void {
    // No generation is added, replaced or reloaded once shutdown has begun.
    if (this.isShuttingDown()) throw new PluginRuntimeShutdownError(pluginId, "plugin lifecycle");
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const reason = this.quarantinedPluginLifecycles.get(canonicalId)
      ?? this.quarantinedPluginLifecycles.get(pluginId);
    if (!reason) return;
    const error = new Error(
      `Plugin lifecycle is quarantined until host restart: ${canonicalId} (${reason})`,
    ) as Error & { code?: string };
    error.code = "plugin-lifecycle-quarantined";
    throw error;
  }

  protected isPluginLifecycleQuarantined(pluginId: string): boolean {
    return this.quarantinedPluginLifecycles.has(this.resolveKnownPluginId(pluginId))
      || this.quarantinedPluginLifecycles.has(pluginId);
  }

  protected quarantinePluginLifecycle(pluginId: string, reason: string): void {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    this.quarantinedPluginLifecycles.set(canonicalId, reason);
    this.quarantinedPluginLifecycles.set(pluginId, reason);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.quarantinedPluginLifecycles.set(alias, reason);
    }
    this.markFailed(canonicalId);
  }

  protected adoptPluginLifecycleIdentity(
    requestedPluginId: string,
    canonicalPluginId: string,
    generation: number,
    installAlias: string | undefined,
  ): boolean {
    const requestedGeneration = this.pluginLifecycleGenerations.get(requestedPluginId);
    const canonicalGeneration = this.pluginLifecycleGenerations.get(canonicalPluginId);
    if (requestedGeneration !== generation || (canonicalGeneration !== undefined && canonicalGeneration > generation)) {
      return false;
    }
    this.rememberPluginInstallAlias(canonicalPluginId, installAlias);
    this.pluginLifecycleGenerations.set(canonicalPluginId, generation);
    this.pluginLifecycleGenerations.set(requestedPluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalPluginId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return true;
  }

  protected isPluginLifecycleOperationCurrent(pluginId: string, generation: number): boolean {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const keys = new Set([
      canonicalId,
      pluginId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    return [...keys].every(
      (key) => this.pluginLifecycleGenerations.get(key) === generation,
    );
  }

  waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    if (this.preparation.isPreparing(canonicalId)) {
      return this.preparation.waitForReady(canonicalId);
    }
    if (this.plugins.has(canonicalId)) return Promise.resolve();
    return this.preparation.waitForReady(canonicalId);
  }

  /** Verify installed bytes before parsing once per manifest; preserve load-plan order despite bounded concurrency. */

  protected resetLoadedState(): void {
    for (const plugin of this.plugins.values()) {
      plugin.deactivateHostApi?.();
    }
    for (const pending of this.pendingHostApiIncarnations.values()) {
      for (const deactivate of pending) {
        deactivate();
      }
    }
    this.pendingHostApiIncarnations.clear();
    for (const [, list] of this.disposers) {
      for (const d of list) {
        try { d(); } catch (err) {
          log.error(`disposer failed: %s`, (err as Error).message);
        }
      }
    }
    this.disposers.clear();
    this.knownPluginManifests.clear();
    this.knownPluginAccessGrants.clear();
    this.knownInstallAliases.clear();
    this.knownInstallClaims.clear();
    this.knownToolOwners.clear();
    this.knownEventOwners.clear();
    this.plugins.clear();
    for (const pluginId of this.pluginUiRevisions.keys()) {
      this.onPluginUiRevisionChange?.(pluginId);
    }
    this.pluginUiRevisions.clear();
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.loadFailureInfo.clear();
    this.lastAttemptRefusal.clear();
    this.disabledPluginIds.clear();
    this.capabilityBlockedPluginIds.clear();
    this.preparation.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    this.pendingRestartCancellations.clear();
    this.pluginLifecycleGenerations.clear();
    this.loaded = false;
  }

  protected stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    const pending = this.pluginStopOperations.get(instance);
    if (pending) return pending;
    const stop = this.stopPluginInstance(pluginId, instance, lifecycleHookScope);
    this.pluginStopOperations.set(instance, stop);
    return stop;
  }

  private async stopPluginInstance(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    if (!instance.stop) return true;
    try {
      await raceWithTimeout(
        this.runPluginLifecycleHook(lifecycleHookScope, () => instance.stop!()),
        START_FAILURE_STOP_TIMEOUT_MS,
        () => new Error(`stop timeout (>${START_FAILURE_STOP_TIMEOUT_MS}ms)`),
      );
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.STOP_OK }, "plugin stopped");
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.STOP_FAIL, err }, "plugin stop failed");
      return false;
    }
  }

  protected async drainPluginHostApiOperations(
    pluginId: string,
    plugin: Pick<LoadedPlugin, "drainHostApiOperations">,
  ): Promise<boolean> {
    if (!plugin.drainHostApiOperations) return true;
    try {
      await plugin.drainHostApiOperations();
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      logPluginLifecycle(
        "error",
        { pluginId, phase: PluginPhase.STOP_FAIL, err },
        "HostApi operation drain failed",
      );
      return false;
    }
  }

  protected async settleCommittedRetirement(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<void> {
    try {
      await retirement;
    } catch (error) {
      log.error(
        `plugin generation retirement failed after ${context} for ${pluginId}: %s`,
        errorMessage(error),
      );
      this.auditLog?.("error", "plugin_generation_retirement_failed", {
        pluginId,
        context,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  protected async captureCommittedRetirementFailure(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<unknown | undefined> {
    try {
      await this.settleCommittedRetirement(pluginId, retirement, context);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  protected async failClosedLoadedPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
    awaitDefinitiveStop = false,
  ): Promise<boolean> {
    this.markFailed(pluginId);
    this.retainLoadedPluginDiagnostics(pluginId, plugin);
    plugin.deactivateHostApi?.();
    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    this.runPluginDisposers(pluginId, context);
    this.onDisable?.(pluginId);
    let stopped: boolean;
    if (awaitDefinitiveStop) {
      try {
        await this.runPluginLifecycleHook(plugin.lifecycleHookScope, () => plugin.instance.stop?.());
        stopped = true;
      } catch (error) {
        this.quarantinePluginLifecycle(pluginId, (error as Error).message);
        stopped = false;
      }
    } else {
      stopped = await this.stopAfterStartFailure(pluginId, plugin.instance, plugin.lifecycleHookScope);
    }
    const drained = await this.drainPluginHostApiOperations(pluginId, plugin);
    return stopped && drained;
  }

  protected runPluginDisposers(pluginId: string, context: string): void {
    const pluginDisposers = this.disposers.get(pluginId);
    if (!pluginDisposers) return;
    for (const dispose of pluginDisposers) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
    this.disposers.delete(pluginId);
  }

  protected runDisposerList(disposers: Array<() => void>, context: string): void {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
  }

  protected throwIfPluginFailedAfterAdd(pluginId: string): void {
    if (!this.failedPluginIds.has(pluginId) && this.plugins.has(pluginId)) return;
    const stub = this.failedPluginStubs.get(pluginId);
    const reason = stub?.description ?? "plugin failed to load (see prior log)";
    throw new Error(`addPlugin failed for ${pluginId}: ${reason}`);
  }

  protected throwIfToolOwnerNotReady(toolName: string): void {
    const pluginId = this.knownToolOwners.get(toolName);
    if (!pluginId) return;
    if (
      this.preparation.isPreparing(pluginId)
      || this.capabilityBlockedPluginIds.has(pluginId)
    ) {
      throw new Error(
        `Plugin '${pluginId}' is still installing its runtime dependencies. ` +
        `Try again after the plugin is ready.`,
      );
    }
    const failure = this.preparation.getFailure(pluginId);
    if (failure) {
      throw new Error(`Plugin '${pluginId}' runtime dependency install failed: ${failure}`);
    }
  }

  protected throwIfPluginNotStarted(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.started !== false) return;
    throw new Error(
      `Plugin '${pluginId}' is still starting. Try again after the plugin is ready.`,
    );
  }

  /** Failure diagnostics belong to the exact attempt object, never a plugin-id lookup that may name a replacement. */
  protected markFailed(
    pluginId: string,
    stub?: { name: string; description: string },
    failure?: { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string },
    attempt?: PluginLoadAttemptResources,
  ): void {
    this.failedPluginIds.add(pluginId);
    this.disabledPluginIds.delete(pluginId);
    if (stub) {
      this.failedPluginStubs.set(pluginId, stub);
    }
    if (failure && (failure.installFailureKind || failure.installFailureMessage)) {
      this.loadFailureInfo.set(pluginId, failure);
    }
    if (attempt) this.recordAttemptDiagnostics(pluginId, attempt);
  }

  /** Every load refusal uses this reporter; summary is card text and reason is diagnostic detail. */
  protected markLoadRefused(
    pluginId: string,
    refusal: {
      summary: string;
      reason: string;
      kind?: PluginInstallFailureKind;
      displayName?: string;
    },
    attempt?: PluginLoadAttemptResources,
  ): void {
    this.markFailed(pluginId, {
      name: refusal.displayName ?? pluginId,
      description: refusal.summary,
    }, {
      ...(refusal.kind ? { installFailureKind: refusal.kind } : {}),
      installFailureMessage: refusal.reason,
    }, attempt);
  }

  /** Refuse manifests requiring a newer app and expose a stable code for renderer localization. */
  protected markIncompatibleAppVersion(manifest: PluginManifest): boolean {
    const minAppVersion = manifest.requires?.minAppVersion;
    if (!minAppVersion) return false;
    const currentAppVersion = getAveAppVersion();
    if (appVersionSatisfiesMin(currentAppVersion, minAppVersion)) return false;

    const reason = `incompatible app version — plugin requires Ave >= ${minAppVersion}, current ${currentAppVersion}`;
    log.error(`${manifest.id} rejected — ${reason}`);
    this.auditLog?.("error", "plugin_incompatible_app_version", {
      pluginId: manifest.id,
      required: minAppVersion,
      current: currentAppVersion,
    });
    this.markLoadRefused(manifest.id, {
      summary: `plugin requires Ave >= ${minAppVersion}, current ${currentAppVersion}`,
      reason: `plugin requires Ave >= ${minAppVersion}, current ${currentAppVersion}`,
      // Reinstalling the same package cannot resolve an app-version mismatch.
      kind: "incompatible-app-version",
      displayName: manifest.name ?? manifest.id,
    });
    return true;
  }

  /** Refuse unserved host protocols on every load path; a newer app may also have dropped that protocol. */
  protected markIncompatibleHostProtocol(manifest: PluginManifest): boolean {
    const declared = manifest.requires?.hostProtocol;
    if (isServedHostProtocolVersion(declared)) return false;
    this.refuseIncompatibleHostProtocol(
      manifest,
      new IncompatibleHostProtocolError(manifest.id, { declared: declared ?? null }),
    );
    return true;
  }

  protected refuseIncompatibleHostProtocol(
    manifest: PluginManifest,
    error: IncompatibleHostProtocolError,
  ): void {
    const refusal = this.reportFactoryRefusal(manifest, error);
    this.markLoadRefused(manifest.id, {
      summary: refusal.summary,
      reason: error.message,
      // Reinstalling the same package cannot change its declared protocol.
      kind: refusal.kind,
      displayName: manifest.name ?? manifest.id,
    });
  }

  /** Share refusal log and audit fields across boot, add, update, and restart. */
  protected reportFactoryRefusal(
    manifest: PluginManifest,
    error: IncompatibleHostProtocolError | ProcessEntryUnconfinedError | PluginSandboxGrantError,
  ): { kind: PluginInstallFailureKind; summary: string } {
    log.error(`${manifest.id} rejected — ${error.message}`);
    if (error instanceof IncompatibleHostProtocolError) {
      this.auditLog?.("error", "plugin_incompatible_host_protocol", {
        pluginId: manifest.id,
        ...error.detail,
        served: [...HOST_PROTOCOL_VERSIONS_SERVED],
      });
      return { kind: "incompatible-host-protocol", summary: error.message };
    }
    if (error instanceof ProcessEntryUnconfinedError) {
      this.auditLog?.("error", "plugin_process_entry_unconfined", {
        pluginId: manifest.id,
        platform: process.platform,
      });
      return {
        kind: "process-entry-unconfined",
        summary: "This extension runs only under an OS sandbox that confines processes.",
      };
    }
    return {
      kind: "sandbox-grant-outside-ceiling",
      summary: "Plugin filesystem grant is outside approved directories.",
    };
  }

  /** Record refused replacements separately so the incumbent remains loaded; unrelated errors return false. */
  protected recordAttemptRefusal(
    manifest: PluginManifest,
    error: unknown,
    attempt: PluginAttemptRefusal["attempt"],
  ): boolean {
    if (
      !(error instanceof IncompatibleHostProtocolError)
      && !(error instanceof ProcessEntryUnconfinedError)
      && !(error instanceof PluginSandboxGrantError)
    ) {
      return false;
    }
    const refusal = this.reportFactoryRefusal(manifest, error);
    this.lastAttemptRefusal.set(manifest.id, {
      attempt,
      kind: refusal.kind,
      message: error.message,
      at: new Date().toISOString(),
    });
    return true;
  }

  /** An unconfined process launch must produce a diagnostic refusal on every load path. */
  protected markProcessEntryUnconfined(manifest: PluginManifest, error: ProcessEntryUnconfinedError): void {
    const refusal = this.reportFactoryRefusal(manifest, error);
    this.markLoadRefused(manifest.id, {
      summary: refusal.summary,
      reason: error.message,
      // Reinstallation cannot change sandbox settings or platform capability.
      kind: refusal.kind,
      displayName: manifest.name ?? manifest.id,
    });
  }

  protected markProcessEntryUnpinned(
    manifest: PluginManifest,
    error: ProcessEntryRequiresPinnedArtifactError,
  ): void {
    log.error(`${manifest.id} rejected — ${error.message}`);
    this.auditLog?.("error", "plugin_process_entry_unpinned", { pluginId: manifest.id });
    this.markLoadRefused(manifest.id, {
      summary: "This extension requires an install pinned by a release or archive artifact.",
      reason: error.message,
      // The same install source yields the same provenance refusal.
      kind: "process-entry-requires-pinned-artifact",
      displayName: manifest.name ?? manifest.id,
    });
  }

  protected refuseSandboxGrant(manifest: PluginManifest, error: PluginSandboxGrantError): void {
    const refusal = this.reportFactoryRefusal(manifest, error);
    this.markLoadRefused(manifest.id, {
      summary: refusal.summary,
      reason: error.message,
      kind: refusal.kind,
      displayName: manifest.name ?? manifest.id,
    });
  }

  /** Capture routing and confinement from the exact failed attempt, replacing stale diagnostics. */
  protected recordAttemptDiagnostics(pluginId: string, attempt: PluginLoadAttemptResources): void {
    if (attempt.routed) {
      this.retainFailureDiagnostics(pluginId, attempt.routed.arm, this.confinementReport(attempt.routed.createPlugin));
    } else {
      this.clearFailureDiagnostics(pluginId);
    }
  }

  protected clearFailureDiagnostics(pluginId: string): void {
    const info = this.loadFailureInfo.get(pluginId);
    if (!info || (info.arm === undefined && info.confinement === undefined)) return;
    const { arm: _arm, confinement: _confinement, ...rest } = info;
    if (Object.keys(rest).length === 0) this.loadFailureInfo.delete(pluginId);
    else this.loadFailureInfo.set(pluginId, rest);
  }

  /** Boot and add share factory-failure reporting so routing diagnostics cannot drift. */
  protected reportAttemptFactoryFailure(
    manifest: PluginManifest,
    err: unknown,
    attempt: PluginLoadAttemptResources,
  ): void {
    if (err instanceof IncompatibleHostProtocolError) {
      this.refuseIncompatibleHostProtocol(manifest, err);
    } else if (err instanceof ProcessEntryUnconfinedError) {
      this.markProcessEntryUnconfined(manifest, err);
    } else if (err instanceof PluginSandboxGrantError) {
      this.refuseSandboxGrant(manifest, err);
    } else {
      this.markFailed(manifest.id);
    }
    this.recordAttemptDiagnostics(manifest.id, attempt);
  }

  protected retainLoadedPluginDiagnostics(pluginId: string, plugin: LoadedPlugin): void {
    this.retainFailureDiagnostics(pluginId, plugin.arm, plugin.confinement);
  }

  private retainFailureDiagnostics(
    pluginId: string,
    arm: PluginLoadArm,
    confinement: PluginConfinementReport,
  ): void {
    this.loadFailureInfo.set(pluginId, { ...this.loadFailureInfo.get(pluginId), arm, confinement });
  }

  /** Refuse revoked installed versions at load, including uninstall revocations awaiting marketplace removal. */
  protected markRevoked(manifest: PluginManifest): boolean {
    const decision = revocationRegistry.evaluate("plugin", manifest.id, manifest.version);
    if (decision.kind === "allow") return false;

    const reason = `revoked by ${decision.sourceId}: ${decision.reason}`;
    log.error(`${manifest.id} rejected — ${reason}`);
    this.auditLog?.("error", "plugin_revoked", {
      pluginId: manifest.id,
      version: manifest.version,
      sourceId: decision.sourceId,
      action: decision.action,
      reason: decision.reason,
    });
    this.markLoadRefused(manifest.id, {
      summary: reason,
      reason,
      // Reinstall cannot repair a revoked version; offer removal or a permitted update.
      kind: "plugin-revoked",
      displayName: manifest.name ?? manifest.id,
    });
    return true;
  }

  protected inferEventOwner(eventType: string): string | undefined {
    const exactOwner = this.knownEventOwners.get(eventType);
    if (exactOwner) return exactOwner;
    const candidateIds = new Set<string>([
      ...this.plugins.keys(),
      ...this.knownPluginManifests.keys(),
    ]);
    let bestMatch: string | undefined;
    for (const pluginId of candidateIds) {
      if (!eventType.startsWith(`${pluginId}.`)) continue;
      if (!bestMatch || pluginId.length > bestMatch.length) {
        bestMatch = pluginId;
      }
    }
    return bestMatch;
  }

  protected async materializeImmutableRuntimeRoot(
    pluginId: string,
    pluginRoot: string,
    activationId: string,
    receiptPluginId: string = pluginId,
  ): Promise<string> {
    this.requireGenerationLifecycle("materialize runtime root");
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = await readFile(
      installReceiptPath(this.installReceiptCacheRoot, receiptPluginId),
      "utf8",
    );
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, receiptRaw);
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    return materializePluginGenerationRoot(
      pluginRoot,
      this.installReceiptCacheRoot,
      pluginId,
      generationId,
      receiptRaw,
      receiptPluginId,
    );
  }

  protected async removeUnpublishedRuntimeRoot(pluginId: string, runtimeRoot: string): Promise<void> {
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const generationDir = dirname(runtimeRoot);
    const generationsRoot = resolve(this.installReceiptCacheRoot, pluginId, "generations");
    if (dirname(generationDir) !== generationsRoot || basename(runtimeRoot) !== "payload") return;
    const generationId = basename(generationDir);
    if (!/^[a-f0-9]{64}$/.test(generationId)) return;
    await removeRetainedPluginGeneration(this.installReceiptCacheRoot, pluginId, generationId);
  }

  setGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    if (!("replaceRuntime" in access) || typeof access.replaceRuntime !== "function") {
      throw new Error("plugin runtime requires a complete generation lifecycle");
    }
    this.generationAccess = access;
    this.generationLifecycle = access as PluginRuntimeGenerationLifecycle;
  }

  protected requireGenerationLifecycle(operation: string): PluginRuntimeGenerationLifecycle {
    if (!this.generationLifecycle) {
      throw new Error(`[plugin-runtime] generation lifecycle is not bound before ${operation}`);
    }
    return this.generationLifecycle;
  }

  protected requireGenerationAccess(operation: string): PluginRuntimeGenerationAccess {
    if (!this.generationAccess) {
      throw new Error(`[plugin-runtime] generation access is not bound before ${operation}`);
    }
    return this.generationAccess;
  }

  getGenerationAccess(): PluginRuntimeGenerationAccess | undefined {
    return this.generationAccess;
  }

  prepareRuntimeRetirement(
    runtime: PluginRuntimeRetirementView,
  ): readonly PluginRuntimeRetirementStep[] {
    if (this.committedUnmappedGenerations.get(runtime.manifest.id) === runtime) {
      this.committedUnmappedGenerations.delete(runtime.manifest.id);
    }
    let runs = this.retirementPhaseRuns.get(runtime.instance);
    if (!runs) {
      runs = new Map();
      this.retirementPhaseRuns.set(runtime.instance, runs);
    }
    const phaseRuns = runs;
    const once = (
      phase: PluginRuntimeRetirementPhase,
      run: () => void | Promise<void>,
    ): PluginRuntimeRetirementStep => Object.freeze({
      phase,
      run: () => {
        const existing = phaseRuns.get(phase);
        if (existing) return existing;
        const pending = Promise.resolve().then(run);
        phaseRuns.set(phase, pending);
        pending.catch(() => {
          if (phaseRuns.get(phase) === pending) phaseRuns.delete(phase);
        });
        return pending;
      },
    });
    return Object.freeze([
      once("runtime.authority", () => {
        // Revoke general HostApi authority before stop hooks; exact admitted leases have already drained.
        runtime.deactivateHostApi?.();
      }),
      once("runtime.stop", async () => {
        const stopped = await this.stopAfterStartFailure(
          runtime.manifest.id,
          runtime.instance,
          runtime.lifecycleHookScope,
        );
        if (!stopped) {
          throw new Error(
            `generation stop failed or timed out for ${runtime.manifest.id}`,
          );
        }
      }),
      once("runtime.effects", () => {
        const errors = [...(runtime.hostEffects?.retire() ?? [])];
        let completed = this.completedRetirementDisposers.get(runtime.instance);
        if (!completed) {
          completed = new Set();
          this.completedRetirementDisposers.set(runtime.instance, completed);
        }
        for (const dispose of runtime.disposers ?? []) {
          if (completed.has(dispose)) continue;
          try {
            dispose();
            completed.add(dispose);
          } catch (error) {
            log.error(
              `generation disposer failed for ${runtime.manifest.id}: %s`,
              (error as Error).message,
            );
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            `plugin '${runtime.manifest.id}' generation effects retirement failed`,
          );
        }
      }),
      once("runtime.drain", async () => {
        if (!runtime.drainHostApiOperations) return;
        try {
          await runtime.drainHostApiOperations();
        } catch (error) {
          log.error(
            `generation HostApi drain failed for ${runtime.manifest.id}: %s`,
            (error as Error).message,
          );
          throw error;
        }
      }),
    ]);
  }

  /** Shutdown may reject the caller while uncancelled work retains its lease until settlement. */
  protected untilRuntimeShutdown<T>(
    pluginId: string,
    method: string,
    work: Promise<T>,
    signal: AbortSignal = this.runtimeShutdown.signal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new PluginRuntimeShutdownError(pluginId, method));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  /** Every dispatch pins one immutable generation until its work settles; stopping a child settles its calls. */
  protected async withPinnedGeneration<T>(
    pluginId: string,
    operation: (
      projection: PluginRuntimeGenerationProjection,
      generationId: string,
    ) => Promise<T>,
    expectedGenerationId?: string,
    operationName = "plugin operation",
  ): Promise<T> {
    if (this.isShuttingDown()) throw new PluginRuntimeShutdownError(pluginId, operationName);
    const access = this.requireGenerationAccess("plugin operation");
    const pinned = expectedGenerationId ?? this.pinnedGenerations.getStore()?.get(pluginId);
    const lease = pinned
      ? await access.acquireExact(pluginId, pinned)
      : await access.acquire(pluginId);
    const next = new Map(this.pinnedGenerations.getStore() ?? []);
    next.set(pluginId, lease.generation.generationId);
    let work: Promise<T>;
    try {
      work = access.runWithLease(
        lease,
        () => this.pinnedGenerations.run(
          Object.freeze(next) as ReadonlyMap<string, string>,
          () => operation(lease.generation.state.runtime, lease.generation.generationId),
        ),
      );
    } catch (error) {
      lease.release();
      throw error;
    }
    // Observe work before the shutdown race so its settlement is recorded first.
    let workSettled = false;
    let detachedSettlement: Promise<unknown> | undefined;
    const settled = work.then(
      () => { workSettled = true; },
      (error: unknown) => {
        workSettled = true;
        // A detached operation's own work outlives the rejection it raised.
        if (isPluginRuntimeDetachedOperationError(error)) {
          detachedSettlement = error.settlement;
          return error.settlement.then(() => undefined, () => undefined);
        }
        return undefined;
      },
    );
    try {
      return await this.untilRuntimeShutdown(pluginId, operationName, work);
    } finally {
      if (workSettled && !detachedSettlement) lease.release();
      else void settled.then(() => lease.release());
    }
  }

  /** Integrations must not retain the leased instance; replacement and removal wait for this operation. */
  async withPluginInstanceLease<TPlugin, TResult>(
    pluginId: string,
    operation: (instance: TPlugin) => Promise<TResult>,
  ): Promise<TResult> {
    return this.withPinnedGeneration(
      pluginId,
      async (projection) => operation(projection.instance as TPlugin),
    );
  }
}

/** Host-private in-memory projections for an already prepared plugin generation. */
abstract class PluginRuntimePublicationState extends PluginRuntimeState {
  /** Attempt ownership transfers at the coordinator commit, even if later publication throws. */
  protected readonly commitHandoffs = new WeakMap<PluginRuntimeGenerationProjection, () => void>();

  getRuntimeGenerationProjection(pluginId: string): PluginRuntimeGenerationProjection | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    return Object.freeze({
      activationId: plugin.activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest: plugin.manifest,
      pluginRoot: plugin.pluginRoot,
      instance: plugin.instance,
      methods: new Map(plugin.methods),
      ...(plugin.approvedPluginAccess ? { approvedPluginAccess: plugin.approvedPluginAccess } : {}),
      disposers: Object.freeze([...(this.disposers.get(pluginId) ?? [])]),
      ...(plugin.hostEffects ? { hostEffects: plugin.hostEffects } : {}),
      ...(plugin.deactivateHostApi ? { deactivateHostApi: plugin.deactivateHostApi } : {}),
      ...(plugin.drainHostApiOperations
        ? { drainHostApiOperations: plugin.drainHostApiOperations }
        : {}),
      ...(plugin.lifecycleHookScope ? { lifecycleHookScope: plugin.lifecycleHookScope } : {}),
      arm: plugin.arm,
      confinement: plugin.confinement,
    });
  }

  private methodMapWith(
    pluginId: string,
    methods: ReadonlyMap<string, PluginToolHandler>,
  ): Map<string, { pluginId: string; handler: PluginToolHandler }> {
    const next = new Map(this.methodMap);
    for (const [toolName, entry] of next) {
      if (entry.pluginId === pluginId) next.delete(toolName);
    }
    for (const [toolName, handler] of methods) {
      const owner = next.get(toolName)?.pluginId;
      if (owner && owner !== pluginId) throw new Error(`Duplicate plugin method registered: ${toolName}`);
      next.set(toolName, { pluginId, handler });
    }
    return next;
  }

  prepareRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeGenerationPublication {
    const pluginId = runtime.manifest.id;
    if (runtime.installId === undefined) {
      throw new Error(`Plugin runtime generation install provenance missing: ${pluginId}`);
    }
    this.assertPluginIdentityNamespace(
      [{ pluginId, alias: runtime.installId ?? undefined }],
      runtime.installId === null ? [] : [runtime.installId],
    );
    // Recheck method ownership at publication because another plugin may have committed meanwhile.
    this.methodMapWith(pluginId, runtime.methods);
    const plugin: LoadedPlugin = {
      activationId: runtime.activationId,
      manifest: runtime.manifest,
      pluginRoot: runtime.pluginRoot,
      instance: runtime.instance,
      methods: new Map(runtime.methods),
      approvedPluginAccess: runtime.approvedPluginAccess,
      hostEffects: runtime.hostEffects,
      started: true,
      deactivateHostApi: runtime.deactivateHostApi,
      drainHostApiOperations: runtime.drainHostApiOperations,
      lifecycleHookScope: runtime.lifecycleHookScope,
      arm: runtime.arm,
      confinement: runtime.confinement,
    };
    const disposers = [...(runtime.disposers ?? [])];
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    const publishHostEffects = runtime.hostEffects?.preparePublish();
    let published = false;
    // Transfer resources exactly once when the coordinator commits, before runtime publication.
    const handOver = (): void => {
      if (!published) this.committedUnmappedGenerations.set(pluginId, runtime);
      const handOff = this.commitHandoffs.get(runtime);
      this.commitHandoffs.delete(runtime);
      handOff?.();
    };
    return Object.freeze({
      pluginId,
      handOver,
      publish: () => {
        if (published) return;
        handOver();
        // Build publication maps from live state after commit awaits to preserve intervening plugin changes.
        const nextMethods = this.methodMapWith(pluginId, runtime.methods);
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        publishHostEffects?.();
        this.publishValidatedPluginInstallAlias(pluginId, runtime.installId ?? undefined);
        this.methodMap = nextMethods;
        this.plugins = new Map(this.plugins).set(pluginId, plugin);
        this.disposers = new Map(this.disposers).set(pluginId, disposers);
        this.committedUnmappedGenerations.delete(pluginId);
        this.rememberPluginManifest(pluginId, runtime.manifest, runtime.approvedPluginAccess);
        this.markPluginUiRevision(pluginId);
        this.failedPluginIds.delete(pluginId);
        this.loadFailureInfo.delete(pluginId);
        // A committed generation supersedes earlier refused attempts.
        this.lastAttemptRefusal.delete(pluginId);
        this.disabledPluginIds.delete(pluginId);
        // Retain the live auth bridge; erase mutable state only for the exact predecessor generation.
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  prepareRuntimeRemoval(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): PreparedPluginRuntimeRemovalPublication {
    const predecessorAuthKey = predecessorGenerationId === undefined
      ? undefined
      : `${pluginId}\0${predecessorGenerationId}`;
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        const nextPlugins = new Map(this.plugins);
        nextPlugins.delete(pluginId);
        const nextDisposers = new Map(this.disposers);
        nextDisposers.delete(pluginId);
        this.methodMap = this.methodMapWith(pluginId, new Map());
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.invalidatePluginUiRevision(pluginId);
        if (predecessorAuthKey !== undefined) {
          this.pluginAccountHashes.delete(predecessorAuthKey);
          this.pluginAuthInvocationEpochs.delete(predecessorAuthKey);
          this.pluginAuthPublishedEpochs.delete(predecessorAuthKey);
          for (const key of this.pluginAuthFailurePrincipals.keys()) {
            if (key.startsWith(`${predecessorAuthKey}\0`)) {
              this.pluginAuthFailurePrincipals.delete(key);
            }
          }
        }
        published = true;
      },
    });
  }

  /** Host post-publication fence failures and plugin startup failures have different owners; startup degradation still permits dispatch. */
  async postPublishRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    const hostFaults: Error[] = [];
    for (const error of runtime.hostEffects?.postPublish() ?? []) {
      log.error(`generation post-publish signal failed for ${runtime.manifest.id}: %s`, error.message);
      hostFaults.push(error);
    }
    try {
      await runtime.instance.onPublished?.();
    } catch (error) {
      log.error(`generation post-publish startup degraded for ${runtime.manifest.id}: %s`, (error as Error).message);
      this.auditLog?.("warn", "plugin_post_publish_startup_degraded", {
        pluginId: runtime.manifest.id,
        version: runtime.manifest.version,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
    if (hostFaults.length > 0) {
      throw new AggregateError(
        hostFaults,
        `plugin '${runtime.manifest.id}' host generation effects failed to publish`,
      );
    }
  }

  publishRuntimeGeneration(
    runtime: PluginRuntimeGenerationProjection,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeGeneration(runtime, predecessorGenerationId).publish();
  }

  unpublishRuntimeGeneration(
    pluginId: string,
    predecessorGenerationId: string | undefined,
  ): void {
    this.prepareRuntimeRemoval(pluginId, predecessorGenerationId).publish();
  }
}

type PreparedArtifactHostApiIncarnation = {
  hostApi: PluginHostApi;
  disposers: Array<() => void>;
  deactivate: () => void;
  drainOperations: () => Promise<void>;
  commit: () => void;
  lifecycleHookScope: PluginLifecycleHookScope;
};
abstract class PluginRuntimeCapabilityLifecycle extends PluginRuntimePublicationState {
  /** Receipt-integrity refusal skips only this plugin and preserves reinstall repair classification. */
  protected markReceiptIntegrityFailed(
    pluginId: string,
    reason: string,
    displayName: string = pluginId,
  ): void {
    this.markLoadRefused(pluginId, {
      summary: "Plugin files do not match their install receipt.",
      reason,
      displayName,
    });
  }

  private readonly capabilityBlockedRetries = new Map<
    string,
    CapabilityBlockedRetry
  >();
  protected readonly capabilityBlockedReadiness = new Map<
    string,
    CapabilityBlockedReadiness
  >();
  protected readonly capabilityBlockedRetryAdds = new Set<string>();
  private readonly watchedPreparingCapabilityProviders = new Map<string, symbol>();
  private pendingCapabilityBlockedRetry: Promise<void> | undefined;
  private capabilityBlockedRetryRequested = false;

  protected abstract importPluginFactoryForLifecycle(
    pluginId: string,
    source: PluginFactorySource,
    manifest: PluginManifest,
    verified: PluginIntegrityEvidence | undefined,
  ): Promise<RoutedPluginFactory>;

  protected abstract startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined>;

  protected abstract failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void>;

  abstract restartPlugin(
    pluginId: string,
    opts?: { skipPreparation?: boolean; throwOnFailure?: boolean },
  ): Promise<RestartPluginResult>;

  abstract addPlugin(pluginId: string): Promise<"started" | "preparing">;

  abstract removePlugin(
    pluginId: string,
    options?: { preserveConfigOverride?: boolean },
  ): Promise<void>;

  protected abstract deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void;
  /** Unpublished capability-blocked candidates have no active bundle pointer; never fabricate one for teardown. */
  protected isUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    generationLifecycle: PluginRuntimeGenerationLifecycle,
  ): boolean {
    return this.plugins.get(pluginId) === plugin
      && plugin.started === false
      && !generationLifecycle.getActive(pluginId);
  }

  private throwUnpublishedCandidateCleanupErrors(pluginId: string, cleanupErrors: readonly Error[]): void {
    if (cleanupErrors.length === 1) throw cleanupErrors[0]!;
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        `unpublished plugin candidate cleanup failed: ${pluginId}`,
      );
    }
  }

  private runUnpublishedCandidateDisposers(
    disposers: Array<() => void> | undefined,
    context: string,
    cleanupErrors: Error[],
  ): void {
    if (!disposers) return;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        log.error(`disposer failed during ${context}: %s`, normalized.message);
        cleanupErrors.push(normalized);
      }
    }
  }

  /** Retire only unpublished candidate resources; cleanup failure retains its old root and reaches the caller. */
  private async retireUnpublishedCandidateResources(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    context: string,
    options: { authorityAlreadyRevoked?: boolean; preserveRuntimeRoot?: string } = {},
    initialErrors: Error[] = [],
  ): Promise<void> {
    const cleanupErrors = [...initialErrors];
    if (!options.authorityAlreadyRevoked) {
      try {
        plugin.deactivateHostApi?.();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    let stopped = false;
    try {
      stopped = await this.stopAfterStartFailure(
        pluginId,
        plugin.instance,
        plugin.lifecycleHookScope,
      );
      if (!stopped) {
        cleanupErrors.push(new Error(`unpublished plugin candidate stop failed: ${pluginId}`));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    try {
      if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.runUnpublishedCandidateDisposers(candidateDisposers, context, cleanupErrors);

    let drained = false;
    try {
      drained = await this.drainPluginHostApiOperations(pluginId, plugin);
      if (!drained) {
        cleanupErrors.push(new Error(
          `unpublished plugin candidate HostApi drain failed: ${pluginId}`,
        ));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    if (
      cleanupErrors.length === 0
      && stopped
      && drained
      && plugin.pluginRoot !== options.preserveRuntimeRoot
    ) {
      try {
        await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.throwUnpublishedCandidateCleanupErrors(pluginId, cleanupErrors);
  }

  /** Discard the exact unstarted candidate without touching bundle pointers or a replacement runtime. */
  protected detachUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
  ): () => Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed before cleanup`);
    }
    const candidateDisposers = this.disposers.get(pluginId);
    const cleanupErrors: Error[] = [];
    try {
      plugin.deactivateHostApi?.();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    // Stale candidate cleanup must preserve a same-id successor’s handlers.
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed during cleanup`);
    }
    for (const [toolName, handler] of plugin.methods) {
      const entry = this.methodMap.get(toolName);
      if (entry?.pluginId === pluginId && entry.handler === handler) {
        this.methodMap.delete(toolName);
      }
    }
    this.plugins.delete(pluginId);
    if (candidateDisposers && this.disposers.get(pluginId) === candidateDisposers) {
      this.disposers.delete(pluginId);
    }
    return () =>
      this.retireUnpublishedCandidateResources(
        pluginId,
        plugin,
        candidateDisposers,
        context,
        { authorityAlreadyRevoked: true },
        cleanupErrors,
      );
  }

  /** Displaced-candidate retirement touches captured old resources only; the successor owns current maps. */
  private retireDisplacedUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    replacementRuntimeRoot: string,
    context: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) === plugin) {
      return Promise.reject(new Error(
        `plugin '${pluginId}' unpublished candidate was not displaced by replacement`,
      ));
    }
    return this.retireUnpublishedCandidateResources(
      pluginId,
      plugin,
      candidateDisposers,
      context,
      { preserveRuntimeRoot: replacementRuntimeRoot },
    );
  }

  protected async removePluginLocked(
    pluginId: string,
    canonicalPluginId: string,
    options: { preserveConfigOverride?: boolean },
  ): Promise<void> {
    this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
    this.clearCapabilityBlockedRetry(
      canonicalPluginId,
      `plugin '${canonicalPluginId}' capability dependency wait was cancelled by removal`,
    );
    // Invalidate in-flight add/restart continuations before the first await.
    this.beginPluginLifecycleOperation(canonicalPluginId);
    this.preparation.clearFor(canonicalPluginId);
    this.pendingRestartPreparations.delete(canonicalPluginId);
    // Late incarnations own private disposers, so invalidated preparation need not settle before tracked state is purged.
    const plugin = this.plugins.get(canonicalPluginId);
    let retirementError: unknown;
    let unpublishedCleanup: (() => Promise<void>) | undefined;
    if (plugin) {
      const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin removal");
      if (this.isUnpublishedLoadedCandidate(canonicalPluginId, plugin, generationLifecycle)) {
        unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
          canonicalPluginId,
          plugin,
          "unpublished plugin removal",
        );
      } else {
        const { retirement } = await generationLifecycle.deactivateWithCommit(
          canonicalPluginId,
          async () => undefined,
          this.capabilityDependencyCommitScope(() => {
            this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
          }),
        );
        retirementError = await this.captureCommittedRetirementFailure(canonicalPluginId, retirement, "plugin removal");
      }
    } else if (this.generationLifecycle?.getActive(canonicalPluginId)) {
      // A committed generation still owns its resources when runtime-map publication fails; only retirement releases them.
      const { retirement } = await this.requireCapabilityCommitLifecycle("plugin removal").deactivateWithCommit(
        canonicalPluginId,
        async () => undefined,
        this.capabilityDependencyCommitScope(() => {
          this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
        }),
      );
      retirementError = await this.captureCommittedRetirementFailure(canonicalPluginId, retirement, "plugin removal");
    } else if (
      !this.knownPluginManifests.has(canonicalPluginId) &&
      !this.failedPluginIds.has(canonicalPluginId) &&
      !this.failedPluginStubs.has(canonicalPluginId) &&
      !this.disabledPluginIds.has(canonicalPluginId)
    ) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      this.knownInstallAliases.delete(canonicalPluginId);
      this.knownInstallClaims.delete(canonicalPluginId);
      this.inactivePluginIds.delete(canonicalPluginId);
      if (!options.preserveConfigOverride) {
        this.configStore.delete(canonicalPluginId);
      }
      return;
    } else {
      log.info(`removePlugin: plugin in non-loaded state (failed/disabled), purging tracking — ${pluginId}`);
    }

    // Stop hooks may persist config; delete overrides only after bounded deactivation.
    if (!options.preserveConfigOverride) {
      this.configStore.delete(canonicalPluginId);
    }

    this.knownPluginManifests.delete(canonicalPluginId);
    this.knownPluginAccessGrants.delete(canonicalPluginId);
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownEventOwners.delete(eventType);
    }
    this.failedPluginIds.delete(canonicalPluginId);
    this.failedPluginStubs.delete(canonicalPluginId);
    this.loadFailureInfo.delete(canonicalPluginId);
    this.lastAttemptRefusal.delete(canonicalPluginId);
    this.disabledPluginIds.delete(canonicalPluginId);
    this.inactivePluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.knownInstallAliases.delete(canonicalPluginId);
    this.knownInstallClaims.delete(canonicalPluginId);

    this.onDisable?.(canonicalPluginId);
    if (unpublishedCleanup) {
      try {
        await unpublishedCleanup();
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError !== undefined) throw retirementError;
  }

  /** Each add attempt owns its resources until handover; cleanup failures must not replace the original error. */
  protected async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const attempt: PluginLoadAttemptResources = { pluginId: manifest.id };
    this.clearFailureDiagnostics(manifest.id);
    return this.trackCandidateConstruction(manifest.id, (construction) => {
      attempt.cleanupFailures = construction.cleanupFailures;
      return this.runSinglePluginAddAttempt(plan, manifest, approvedPluginAccess, opts, attempt);
    });
  }

  private async runSinglePluginAddAttempt(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; shouldCommit?: () => boolean },
    attempt: PluginLoadAttemptResources,
  ): Promise<SinglePluginStartResult> {
    try {
      return await this.addSinglePluginAttempt(plan, manifest, approvedPluginAccess, opts, attempt);
    } catch (err) {
      if (attempt.handedOver) {
        log.error(`${manifest.id} add rejected after its generation was committed; the committed generation owns it: ${errorMessage(err)}`);
      } else if (attempt.routed) {
        if (this.isShuttingDown()) {
          // Shutdown refusal releases resources without reporting a plugin crash.
          await this.releaseAttempt(attempt, "plugin runtime shutdown");
        } else if (opts.shouldCommit?.() ?? true) {
          await this.abandonCrashedPluginLoad(attempt, err);
        } else {
          await this.releaseAttempt(attempt, "cancelled plugin add");
        }
      }
      throw err;
    }
  }

  /** Release only this failed attempt’s resources; cleanup failure must not replace its diagnostic outcome. */
  protected async abandonCrashedPluginLoad(
    resources: PluginLoadAttemptResources,
    err: unknown,
  ): Promise<void> {
    const { pluginId } = resources;
    const reason = errorMessage(err);
    logPluginLifecycle(
      "error",
      { pluginId, phase: PluginPhase.LOAD_FAIL, err, reason: "load_crash" },
      `plugin load crashed: ${reason}`,
    );
    this.auditAttemptEvent("plugin_load_crashed", { pluginId, reason });
    await this.releaseAttempt(resources, "crashed plugin load");
    this.markLoadRefused(pluginId, {
      summary: "Plugin crashed while loading.",
      reason,
      kind: "load-crash",
      displayName: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
    }, resources);
  }

  /** A throwing audit sink is reported separately and never replaces the failure being audited. */
  protected auditAttemptEvent(type: string, data: { pluginId: string } & Record<string, unknown>): void {
    try {
      this.auditLog?.("error", type, data);
    } catch (auditError) {
      log.error(`${data.pluginId} audit ${type} failed: ${errorMessage(auditError)}`);
    }
  }

  /** Clear each resource before release so retries and throws cannot release it twice; retain the caller’s original outcome. */
  protected async releaseAttempt(
    attempt: PluginLoadAttemptResources,
    context: string,
  ): Promise<unknown[]> {
    const { pluginId } = attempt;
    const failures: unknown[] = [];
    const step = async (action: () => unknown): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    const { incarnation, constructed, runtimeRoot } = attempt;
    attempt.incarnation = undefined;
    attempt.constructed = undefined;
    attempt.runtimeRoot = undefined;
    const disposers = incarnation ? incarnation.disposers.splice(0) : [];
    if (incarnation) {
      await step(() => incarnation.deactivate());
    }
    if (constructed) {
      await step(() => this.stopAfterStartFailure(pluginId, constructed.instance, constructed.lifecycleHookScope));
    }
    if (incarnation) {
      await step(() => {
        if (incarnation.hostEffects.isPreparing()) incarnation.hostEffects.discard();
      });
      await step(() => this.runDisposerList(disposers, context));
      await step(() => this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: incarnation.drainOperations,
      }));
    }
    // A quarantined attempt may still have a live child whose cwd and entry code are this payload.
    // Keep it with the rest of the lease for as long as the lifecycle stays quarantined (until host restart).
    if (runtimeRoot && !this.isPluginLifecycleQuarantined(pluginId)) {
      await step(() => this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot));
    }
    attempt.cleanupFailures?.push(...failures);
    for (const failure of failures) {
      log.error(`${pluginId} attempt cleanup failed (${context}): ${errorMessage(failure)}`);
      this.auditAttemptEvent("plugin_attempt_cleanup_failed", {
        pluginId,
        context,
        reason: errorMessage(failure),
      });
    }
    return failures;
  }

  /** After handover the committed generation owns every resource, including cleanup after later rejection. */
  protected handOverAttempt(attempt: PluginLoadAttemptResources): void {
    attempt.incarnation = undefined;
    attempt.constructed = undefined;
    attempt.runtimeRoot = undefined;
    attempt.handedOver = true;
  }

  private async addSinglePluginAttempt(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; shouldCommit?: () => boolean },
    attempt: PluginLoadAttemptResources,
  ): Promise<SinglePluginStartResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin add");
    const pluginRoot = dirname(plan.manifestPath);
    const canCommit = () => opts.shouldCommit?.() ?? true;
    if (!canCommit()) return "cancelled";
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    let verified: PluginIntegrityEvidence | undefined;
    if (plan.pluginIdHint) {
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
      );
      if (!canCommit()) return "cancelled";
      if (integrityResult.ok) verified = integrityResult.verified;
      if (!integrityResult.ok) {
        // Receipt failures must be keyed by canonical manifest id so card status and add failure checks see them.
        this.markReceiptIntegrityFailed(
          manifest.id,
          integrityResult.reason,
          manifest.name ?? manifest.id,
        );
        return "failed";
      }
    }

    if (!canCommit()) return "cancelled";
    if (this.markIncompatibleAppVersion(manifest)) {
      return "failed";
    }

    if (!canCommit()) return "cancelled";
    if (this.markIncompatibleHostProtocol(manifest)) {
      return "failed";
    }

    if (!canCommit()) return "cancelled";
    if (this.markRevoked(manifest)) {
      return "failed";
    }

    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      if (!canCommit()) return "cancelled";
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        manifest,
        missingCapabilities,
      );
      if (preparingProviderIds) {
        // Provider waits run only in background preparation so boot and restart remain nonblocking.
        if (opts.skipPreparation) {
          await this.waitForPreparingCapabilityProviderChange(
            preparingProviderIds,
          );
          if (!canCommit()) return "cancelled";
          return this.instantiateAndStartSinglePlugin(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          );
        }
        // After provider preparation settles, re-enter by id and resolve current identity rather than retaining a stale plan.
        if (
          this.preparation.deferStart(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          )
        ) {
          return "deferred";
        }
        this.deferBlockedAddPlugin(manifest.id, preparingProviderIds);
        return "deferred";
      }
      if (!canCommit()) return "cancelled";
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${manifest.id} rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId: manifest.id,
        missing: missingCapabilities,
      });
      this.markFailed(manifest.id, {
        name: manifest.name ?? manifest.id,
        description: `Missing capabilities: ${missingCapabilities.join(", ")}`,
      });
      return "failed";
    }

    if (!canCommit()) return "cancelled";
    if (!opts.skipPreparation && this.preparation.deferStart(plan, manifest, approvedPluginAccess, opts)) {
      return "deferred";
    }

    const activationId = randomUUID();
    const runtimeRoot = attempt.runtimeRoot = await this.materializeImmutableRuntimeRoot(
      manifest.id,
      pluginRoot,
      activationId,
      plan.pluginIdHint ?? manifest.id,
    );
    let source: PluginFactorySource;
    try {
      source = this.pluginFactorySource(manifest, runtimeRoot);
    } catch (err) {
      if (!canCommit()) {
        await this.releaseAttempt(attempt, "cancelled add entry");
        return "cancelled";
      }
      const reason = (err as Error).message;
      log.error(`${manifest.id} rejected: ${reason}`);
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      await this.releaseAttempt(attempt, "failed add entry");
      return "failed";
    }

    let routed: RoutedPluginFactory;
    try {
      routed = await this.importPluginFactoryForLifecycle(
        manifest.id,
        source,
        manifest,
        verified,
      );
    } catch (err) {
      if (!canCommit()) {
        await this.releaseAttempt(attempt, "cancelled add routing");
        return "cancelled";
      }
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      if (err instanceof ProcessEntryRequiresPinnedArtifactError) {
        this.markProcessEntryUnpinned(manifest, err);
      } else {
        this.markFailed(manifest.id);
      }
      await this.releaseAttempt(attempt, "failed add routing");
      return "failed";
    }
    if (!canCommit()) {
      await this.releaseAttempt(attempt, "cancelled add routing");
      return "cancelled";
    }
    const { createPlugin } = routed;
    attempt.routed = routed;

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostEffects = new HostApiGenerationScope(manifest.id);
    const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
      this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
      );
    // Until registration, the attempt owns root, incarnation, and instance; every exit releases through releaseAttempt.
    attempt.incarnation = { deactivate, disposers, drainOperations, hostEffects };

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId: manifest.id,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
    } catch (err) {
      if (factoryFailureRequiresQuarantine(err)) {
        this.quarantinePluginLifecycle(manifest.id, err.message);
      }
      await this.releaseAttempt(attempt, "failed add factory");
      if (!canCommit()) return "cancelled";
      log.error(`${manifest.id} createPlugin failed: %s`, (err as Error).message);
      // An unserved construct method is a host-protocol refusal, like an unserved declared version.
      this.reportAttemptFactoryFailure(manifest, err, attempt);
      return "failed";
    }
    attempt.constructed = { instance, lifecycleHookScope };

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle(
        "warn",
        { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
        "tool disabled — missing handler",
      ),
    );
    const foreignTool = (): string | undefined => [...methods.keys()].find((toolName) => {
      const owner = this.methodMap.get(toolName)?.pluginId;
      return owner !== undefined && owner !== manifest.id;
    });
    const duplicateBeforeStart = foreignTool();
    if (duplicateBeforeStart) {
      await this.releaseAttempt(attempt, "duplicate add method");
      throw new Error(`Duplicate plugin method registered: ${duplicateBeforeStart}`);
    }

    if (!canCommit()) {
      await this.releaseAttempt(attempt, "stale add factory");
      return "cancelled";
    }

    let startupMs = 0;
    if (instance.start) {
      const startedAt = Date.now();
      try {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
        startupMs = Date.now() - startedAt;
      } catch (err) {
        if (err instanceof PluginStartupTimeoutError) {
          this.quarantinePluginLifecycle(manifest.id, err.message);
        }
        if (!canCommit()) {
          await this.releaseAttempt(attempt, "stale add start");
          return "cancelled";
        }
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id, undefined, undefined, attempt);
        await this.releaseAttempt(attempt, "failed add start");
        return "failed";
      }
    }
    if (!canCommit()) {
      await this.releaseAttempt(attempt, "stale add commit");
      return "cancelled";
    }
    const duplicateBeforeCommit = foreignTool();
    if (duplicateBeforeCommit) {
      await this.releaseAttempt(attempt, "duplicate add method");
      throw new Error(`Duplicate plugin method registered: ${duplicateBeforeCommit}`);
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(manifest.id),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers,
      deactivateHostApi: deactivate,
      drainHostApiOperations: drainOperations,
      lifecycleHookScope,
      arm: routed.arm,
      confinement: this.confinementReport(createPlugin),
    });
    // Ownership transfers at coordinator commit; the lifecycle await can still reject before or after runtime publication.
    let rejectedAfterCommit: { error: unknown } | undefined;
    this.commitHandoffs.set(candidate, () => this.handOverAttempt(attempt));
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!canCommit()) {
            throw new Error(`plugin add cancelled for ${manifest.id}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin add");
          commit();
        }),
      );
    } catch (error) {
      if (!attempt.handedOver) {
        await this.releaseAttempt(attempt, "failed add publication");
        if (!canCommit()) return "cancelled";
        const missing = this.capabilityDependencies().missing(manifest);
        if (missing.length > 0) {
          this.auditLog?.("error", "plugin_dependency_missing", {
            pluginId: manifest.id,
            missing,
          });
          this.markFailed(manifest.id, {
            name: manifest.name ?? manifest.id,
            description: `Missing capabilities: ${missing.join(", ")}`,
          }, undefined, attempt);
          return "failed";
        }
        throw error;
      }
      // Post-commit rejection belongs to the generation; finish committed bookkeeping before returning the lifecycle fault.
      rejectedAfterCommit = { error };
    } finally {
      this.commitHandoffs.delete(candidate);
    }
    // Resolved publication commits ownership even when a lifecycle adapter omitted the handover callback.
    this.handOverAttempt(attempt);
    if (!rejectedAfterCommit) {
      this.finishCommittedAdd(manifest.id, startupMs);
      return "started";
    }
    // Bookkeeping failure is reported separately and must not replace the lifecycle error.
    try {
      this.finishCommittedAdd(manifest.id, startupMs);
    } catch (followUpError) {
      log.error(`${manifest.id} bookkeeping after a committed add failed: ${errorMessage(followUpError)}`);
      this.auditAttemptEvent("plugin_add_follow_up_failed", {
        pluginId: manifest.id,
        reason: errorMessage(followUpError),
      });
    }
    throw rejectedAfterCommit.error;
  }

  private finishCommittedAdd(pluginId: string, startupMs: number): void {
    this.inactivePluginIds.delete(pluginId);
    this.perf.recordStartup(pluginId, startupMs);
    this.resolveCapabilityBlockedRetry(pluginId);
    this.onEnable?.(pluginId);
  }

  protected capabilityDependencies(): CapabilityDependencies {
    return new CapabilityDependencies(
      this.knownPluginManifests,
      (pluginId) => this.isPluginGenerationActive(pluginId),
    );
  }

  /** The coordinator owns admission; the local started bit also excludes unstarted candidates in lifecycle adapters. */
  protected isPluginGenerationActive(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.started === true
      && Boolean(this.generationLifecycle?.getActive(pluginId));
  }

  /** Only already-preparing providers may defer consumers; background waits must not hold startup open. */
  protected preparingCapabilityProviderIds(
    manifest: PluginManifest,
    missingCapabilities: readonly string[],
  ): string[] | undefined {
    if (missingCapabilities.length === 0) return undefined;
    const candidatesByCapability = new Map<string, string[]>();
    for (const capability of missingCapabilities) {
      const candidates = [...this.knownPluginManifests.entries()]
        .filter(([pluginId, candidate]) =>
          pluginId !== manifest.id
          && this.preparation.isPreparing(pluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([pluginId]) => pluginId);
      if (candidates.length === 0) return undefined;
      candidatesByCapability.set(capability, candidates);
    }

    // Reject preparation cycles before either plugin can remain indefinitely preparing.
    const waitableByCapability = new Map<string, string[]>();
    for (const [capability, candidates] of candidatesByCapability) {
      const waitable = candidates.filter(
        (pluginId) => !this.preparingCapabilityCanReach(pluginId, manifest.id),
      );
      if (waitable.length === 0) return undefined;
      waitableByCapability.set(capability, waitable);
    }
    return [...new Set([...waitableByCapability.values()].flat())];
  }

  private async waitForPreparingCapabilityProviderChange(
    providerIds: readonly string[],
  ): Promise<void> {
    await Promise.race(
      providerIds.map((pluginId) =>
        this.preparation.waitForReady(pluginId).catch(() => undefined),
      ),
    );
  }

  /** Retry after a concrete provider settles, resolving current runtime identity in the callback. */
  protected deferCapabilityBlockedRetry(
    pluginId: string,
    providerIds: readonly string[],
    retry: () => Promise<void>,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const readiness = this.capabilityBlockedReadiness.get(pluginId)
      ?? this.createCapabilityBlockedReadiness();
    this.capabilityBlockedReadiness.set(pluginId, readiness);
    const entry: CapabilityBlockedRetry = { retry, isCurrent, readiness };
    this.capabilityBlockedPluginIds.add(pluginId);
    this.capabilityBlockedRetries.set(pluginId, entry);
    this.markPluginUiRevision(pluginId);
    for (const providerId of providerIds) {
      if (!this.preparation.isPreparing(providerId)) continue;
      if (this.watchedPreparingCapabilityProviders.has(providerId)) continue;
      const watchToken = Symbol(providerId);
      this.watchedPreparingCapabilityProviders.set(providerId, watchToken);
      void this.preparation.waitForReady(providerId).then(
        () => this.requestCapabilityBlockedRetry(),
        () => this.requestCapabilityBlockedRetry(),
      ).finally(() => {
        if (this.watchedPreparingCapabilityProviders.get(providerId) === watchToken) {
          this.watchedPreparingCapabilityProviders.delete(providerId);
        }
      });
    }
  }

  /** Capture the blocked incarnation so remove, disable, reset, restart, or reinstall invalidates late retries. */
  protected capabilityBlockedRetryGuard(
    pluginId: string,
    manifest: PluginManifest,
    loadedPlugin?: LoadedPlugin,
  ): () => boolean {
    const lifecycleGeneration = this.pluginLifecycleGenerations.get(pluginId);
    const installClaim = this.knownInstallClaims.get(pluginId);
    return () =>
      this.knownPluginManifests.get(pluginId) === manifest
      && this.knownInstallClaims.get(pluginId) === installClaim
      && this.pluginLifecycleGenerations.get(pluginId) === lifecycleGeneration
      && !this.disabledPluginIds.has(pluginId)
      && !this.inactivePluginIds.has(pluginId)
      && (!loadedPlugin || this.plugins.get(pluginId) === loadedPlugin);
  }

  private createCapabilityBlockedReadiness(): CapabilityBlockedReadiness {
    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Observe cancellation rejection even when nobody requested readiness.
    void promise.catch(() => undefined);
    return {
      promise,
      resolve: () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
  }

  protected resolveCapabilityBlockedRetry(
    pluginId: string,
    expectedReadiness?: CapabilityBlockedReadiness,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness || (expectedReadiness && readiness !== expectedReadiness)) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.resolve();
  }

  protected rejectCapabilityBlockedRetry(
    pluginId: string,
    error: Error,
    expectedReadiness?: CapabilityBlockedReadiness,
    expectedEntry?: CapabilityBlockedRetry,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    const current = this.capabilityBlockedRetries.get(pluginId);
    if (!readiness) {
      if (expectedReadiness) return;
      this.capabilityBlockedRetries.delete(pluginId);
      const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
      if (wasBlocked) this.markPluginUiRevision(pluginId);
      return;
    }
    if (expectedReadiness && readiness !== expectedReadiness) return;
    // An old watcher must not reject a newer retry that replaced its readiness entry.
    if (expectedEntry && current && current !== expectedEntry) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.reject(error);
  }

  protected clearCapabilityBlockedRetry(
    pluginId: string,
    reason = `plugin '${pluginId}' capability dependency wait was cancelled`,
  ): void {
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
  }

  protected clearAllCapabilityBlockedRetries(): void {
    const blockedPluginIds = new Set([
      ...this.capabilityBlockedRetries.keys(),
      ...this.capabilityBlockedReadiness.keys(),
      ...this.capabilityBlockedPluginIds,
    ]);
    this.watchedPreparingCapabilityProviders.clear();
    this.capabilityBlockedRetryRequested = false;
    for (const pluginId of blockedPluginIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by runtime reset`,
      );
    }
  }

  protected bridgeCapabilityBlockedReadinessToPreparation(pluginId: string): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness) return;
    const entry: CapabilityBlockedRetry = {
      retry: async () => undefined,
      isCurrent: () => this.preparation.isPreparing(pluginId),
      readiness,
      waitingForOwnPreparation: true,
    };
    this.capabilityBlockedRetries.set(pluginId, entry);
    void this.preparation.waitForReady(pluginId).then(
      () => this.resolveCapabilityBlockedRetry(pluginId, readiness),
      (error: unknown) => this.rejectCapabilityBlockedRetry(
        pluginId,
        error instanceof Error ? error : new Error(String(error)),
        readiness,
        entry,
      ),
    );
  }

  private requestCapabilityBlockedRetry(): void {
    this.capabilityBlockedRetryRequested = true;
    if (this.pendingCapabilityBlockedRetry) return;
    const retryTask = (async () => {
      while (this.capabilityBlockedRetryRequested) {
        this.capabilityBlockedRetryRequested = false;
        for (const [pluginId, entry] of [...this.capabilityBlockedRetries]) {
          if (this.capabilityBlockedRetries.get(pluginId) !== entry) continue;
          if (entry.waitingForOwnPreparation) continue;
          this.capabilityBlockedRetries.delete(pluginId);
          if (!entry.isCurrent()) {
            this.rejectCapabilityBlockedRetry(
              pluginId,
              new Error(`plugin '${pluginId}' capability dependency wait was cancelled`),
              entry.readiness,
              entry,
            );
            continue;
          }
          try {
            await entry.retry();
          } catch (error) {
            if (entry.isCurrent() && this.hasTrackedPluginState(pluginId)) {
              this.markFailed(pluginId, {
                name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
                description: errorMessage(error),
              });
            }
            this.rejectCapabilityBlockedRetry(
              pluginId,
              error instanceof Error ? error : new Error(String(error)),
              entry.readiness,
              entry,
            );
            log.error(
              `capability-blocked retry failed for ${pluginId}: ${(error as Error).message}`,
            );
          } finally {
            if (
              !this.capabilityBlockedRetries.has(pluginId)
              && this.capabilityBlockedReadiness.get(pluginId) === entry.readiness
            ) {
              if (this.isPluginGenerationActive(pluginId)) {
                this.resolveCapabilityBlockedRetry(pluginId);
              } else {
                this.rejectCapabilityBlockedRetry(
                  pluginId,
                  new Error(`plugin '${pluginId}' capability dependency retry did not start`),
                  entry.readiness,
                  entry,
                );
              }
            }
          }
        }
      }
    })();
    this.pendingCapabilityBlockedRetry = retryTask;
    void retryTask.finally(() => {
      if (this.pendingCapabilityBlockedRetry !== retryTask) return;
      this.pendingCapabilityBlockedRetry = undefined;
      if (this.capabilityBlockedRetryRequested) {
        this.requestCapabilityBlockedRetry();
      }
    }).catch(() => undefined);
  }
  private preparingCapabilityCanReach(
    pluginId: string,
    targetPluginId: string,
    visited = new Set<string>(),
  ): boolean {
    if (pluginId === targetPluginId) return true;
    if (visited.has(pluginId) || !this.preparation.isPreparing(pluginId)) {
      return false;
    }
    visited.add(pluginId);
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return false;
    const missing = this.capabilityDependencies().missing(manifest);
    for (const capability of missing) {
      const providers = [...this.knownPluginManifests.entries()]
        .filter(([candidatePluginId, candidate]) =>
          candidatePluginId !== pluginId
          && this.preparation.isPreparing(candidatePluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([candidatePluginId]) => candidatePluginId);
      // A cycle is mandatory only when every provider for a requirement routes back to the target.
      if (
        providers.length > 0
        && providers.every((providerId) =>
          this.preparingCapabilityCanReach(providerId, targetPluginId, new Set(visited)),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  protected assertEnabledCapabilityDependencies(manifest: PluginManifest): void {
    this.assertActiveCapabilityDependencies(manifest, "plugin re-enable");
  }

  protected assertActiveCapabilityDependencies(
    manifest: PluginManifest,
    operation: string,
  ): void {
    const missing = this.capabilityDependencies().missing(manifest);
    if (missing.length > 0) {
      throw new Error(
        `${operation} blocked — missing required capabilities: ${missing.join(", ")}`,
      );
    }
  }

  /** The generation-pointer commit scope closes capability races without serializing import or startup. */
  protected capabilityDependencyCommitScope(
    assertDependencies: () => void,
  ): CapabilityDependencyCommitScope {
    return <T>(operation: () => Promise<T>): Promise<T> =>
      this.withCapabilityDependencyCommit(async () => {
        assertDependencies();
        return await operation();
      });
  }

  protected requireCapabilityCommitLifecycle(
    operation: string,
  ): CapabilityCommitScopedGenerationLifecycle {
    return this.requireGenerationLifecycle(operation) as CapabilityCommitScopedGenerationLifecycle;
  }

  /** Refuse teardown of the last active provider needed by an admitted consumer. */
  protected assertNoActiveCapabilityDependents(
    providerPluginId: string,
    operation: "disable" | "remove",
  ): void {
    this.assertActiveCapabilityDependentsRemainSatisfied(
      providerPluginId,
      undefined,
      `plugin ${operation}`,
    );
  }

  /** Before removal or replacement, prove the post-change provider set covers every active consumer. */
  protected assertActiveCapabilityDependentsRemainSatisfied(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
    operation: string,
  ): void {
    const blocked = this.activeCapabilityDependentsMissingAfterProviderChange(
      providerPluginId,
      replacementManifest,
    );
    if (blocked.length === 0) return;
    const details = blocked
      .map(({ pluginId, missing }) => `${pluginId} (${missing.join(", ")})`)
      .join("; ");
    throw new Error(
      `${operation} blocked — active dependents require capabilities: ${details}`,
    );
  }

  protected activeCapabilityDependentsMissingAfterProviderChange(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
  ): Array<{ pluginId: string; missing: string[] }> {
    if (!this.isPluginGenerationActive(providerPluginId)) return [];
    const availableProviders = this.capabilityDependencies()
      .activeManifests([providerPluginId]);
    if (replacementManifest) availableProviders.push(replacementManifest);
    const blocked = [...this.knownPluginManifests.entries()].flatMap(
      ([candidatePluginId, candidateManifest]) => {
        if (
          candidatePluginId === providerPluginId
          || !this.isPluginGenerationActive(candidatePluginId)
        ) {
          return [];
        }
        const required = candidateManifest.requires?.capabilities ?? [];
        // A consumer cannot satisfy its own capability requirement.
        const dependencyResult = resolveDependencies(
          required,
          availableProviders.filter(
            (providerManifest) => providerManifest.id !== candidatePluginId,
          ),
        );
        return !dependencyResult.ok
          ? [{ pluginId: candidatePluginId, missing: dependencyResult.missing }]
          : [];
      },
    );
    return blocked;
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    this.requireGenerationLifecycle("plugin reload");
    const pendingRestart = this.pendingRestarts.get(canonicalPluginId);
    if (pendingRestart) {
      this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
      await pendingRestart;
    }
    const result = await this.restartPlugin(canonicalPluginId, {
      skipPreparation: true,
      throwOnFailure: true,
    });
    if (result !== "started") {
      throw new Error(
        `reloadPlugin failed for ${canonicalPluginId}: ${result ?? "not-loaded"}`,
      );
    }
  }

  async activatePreparedArtifact<T>(
    input: PreparedArtifactRuntimeActivationInput<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("prepared artifact activation");
    if (!this.installReceiptCacheRoot) throw new Error("prepared artifact activation requires installReceiptCacheRoot");
    const manifestPath = resolve(input.pluginRoot, "plugin.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifestDocument: unknown = JSON.parse(manifestRaw);
    const manifest = flattenAgentPluginsManifest(manifestDocument);
    recordManifestDocument(manifest, manifestDocument);
    if (manifest.id !== input.manifest.id || manifest.version !== input.manifest.version) {
      throw new Error(`prepared artifact manifest identity changed for '${input.manifest.id}'`);
    }
    this.assertActiveCapabilityDependencies(manifest, "prepared artifact activation");
    this.assertActiveCapabilityDependentsRemainSatisfied(
      manifest.id,
      manifest,
      "prepared artifact activation",
    );
    return this.trackCandidateConstruction(manifest.id, (construction) => this.withPreparedInstallIdentity(manifest.id, input.installId, async (installId) => {
    const candidateRegistryEntry = this.validatePreparedRegistryEntry(
      manifest,
      input.registryEntry,
      manifestDocument,
    );
    // Marketplace activation starts from verified staging without restart preparation; unmet dependencies roll the atomic update back.
    const preparationResult = await this.preparePluginStart?.({
        pluginId: manifest.id,
        manifest,
        manifestPath: resolve(input.pluginRoot, "plugin.json"),
        pluginRoot: input.pluginRoot,
      });
    const candidateConfigOverride =
      preparationResult && typeof preparationResult === "object"
        ? preparationResult.configOverride
        : undefined;
    const candidateConfigOverrides = candidateConfigOverride
      ? {
          ...this.configOverrides,
          [manifest.id]: {
            ...(this.configOverrides[manifest.id] ?? {}),
            ...candidateConfigOverride,
          },
        }
      : this.configOverrides;
    const activationId = randomUUID();
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, input.receiptRaw);
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    const payloadRoot = await materializePluginGenerationRoot(
      input.pluginRoot,
      this.installReceiptCacheRoot!,
      manifest.id,
      generationId,
      input.receiptRaw,
      installId,
    );
    const releasePreparedConstruction = async (hostEffects?: HostApiGenerationScope): Promise<void> => {
      const step = async (action: () => unknown): Promise<void> => {
        try {
          await action();
        } catch (cleanupError) {
          construction.cleanupFailures.push(cleanupError);
          log.error(`${manifest.id} prepared candidate cleanup failed before startup: ${errorMessage(cleanupError)}`);
          this.auditAttemptEvent("plugin_attempt_cleanup_failed", {
            pluginId: manifest.id,
            context: "prepared artifact construction",
            reason: errorMessage(cleanupError),
          });
        }
      };
      if (hostEffects) await step(() => hostEffects.discard());
      // A quarantined candidate may still have a live child running from this payload.
      if (!this.isPluginLifecycleQuarantined(manifest.id)) {
        await step(() => removeRetainedPluginGeneration(
          this.installReceiptCacheRoot!,
          manifest.id,
          generationId,
        ));
      }
    };
    let routed: RoutedPluginFactory;
    try {
      // Verify the staged receipt against its own payload instead of trusting installer provenance claims.
      const staged = await verifyInstallReceiptRaw(input.receiptRaw, installId, payloadRoot);
      if (!staged.ok) {
        throw new Error(`prepared artifact '${manifest.id}' receipt does not verify against its payload: ${staged.reason}`);
      }
      routed = await this.importPluginFactoryForLifecycle(
        manifest.id,
        this.pluginFactorySource(manifest, payloadRoot),
        manifest,
        integrityEvidence(staged.receipt),
      );
    } catch (error) {
      await releasePreparedConstruction();
      throw error;
    }
    const { createPlugin } = routed;
    const hostEffects = new HostApiGenerationScope(manifest.id);
    let pluginDataDir: string;
    let hostApiIncarnation: PreparedArtifactHostApiIncarnation;
    try {
      pluginDataDir = this.ensureDataDir(manifest.id, payloadRoot);
      hostApiIncarnation = this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
        installId,
        candidateRegistryEntry,
        input.approvedPluginAccess ?? null,
      );
    } catch (error) {
      await releasePreparedConstruction(hostEffects);
      throw error;
    }
    const {
      hostApi,
      disposers,
      deactivate,
      drainOperations,
      commit,
      lifecycleHookScope,
    } = hostApiIncarnation;
    let instance: RuntimePlugin | undefined;
    let candidateRelease: Promise<void> | undefined;
    // Release every uncommitted activation resource once; attempt all cleanup steps before throwing their combined failures.
    const releaseUncommittedCandidate = (): Promise<void> => {
      candidateRelease ??= (async () => {
        const failures: unknown[] = [];
        const step = async (action: () => unknown): Promise<void> => {
          try {
            await action();
          } catch (error) {
            failures.push(error);
          }
        };
        await step(() => deactivate());
        await step(() => { if (hostEffects.isPreparing()) hostEffects.discard(); });
        if (instance) {
          const started = instance;
          await step(() => this.stopAfterStartFailure(manifest.id, started, lifecycleHookScope));
        }
        await step(() => this.runDisposerList(disposers, "failed prepared artifact activation"));
        await step(() => this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        }));
        // A quarantined candidate may still have a live child running from this payload.
        if (!this.isPluginLifecycleQuarantined(manifest.id)) {
          await step(() => removeRetainedPluginGeneration(
            this.installReceiptCacheRoot!,
            manifest.id,
            generationId,
          ));
        }
        construction.cleanupFailures.push(...failures);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, `prepared candidate '${manifest.id}:${generationId}' cleanup failed`);
        }
      })();
      return candidateRelease;
    };
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(buildPluginContext({
            pluginId: manifest.id,
            pluginRoot: payloadRoot,
            hostRoot: this.hostRoot,
            pluginDataDir,
            manifest,
            configOverrides: candidateConfigOverrides,
            hostApi,
          })),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
      const methods = buildMethodMap(manifest, instance, (toolName) =>
        logPluginLifecycle(
          "warn",
          { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
          "tool disabled — missing handler in prepared artifact",
        ),
      );
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance!.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      const projection: PluginRuntimeGenerationProjection = Object.freeze({
        activationId,
        installId,
        manifest,
        pluginRoot: payloadRoot,
        instance,
        methods: new Map(methods),
        ...(input.approvedPluginAccess ? { approvedPluginAccess: input.approvedPluginAccess } : {}),
        hostEffects,
        disposers,
        deactivateHostApi: deactivate,
        drainHostApiOperations: drainOperations,
        lifecycleHookScope,
        arm: routed.arm,
        confinement: this.confinementReport(createPlugin),
      });
      // Shutdown may release a constructed candidate while its durable commit is pending; closed admission prevents publication.
      if (this.isShuttingDown()) {
        throw new PluginRuntimeShutdownError(manifest.id, "prepared artifact activation");
      }
      construction.releaseForShutdown = () =>
        generationLifecycle.getActive(manifest.id)?.generationId === generationId
          ? Promise.resolve()
          : releaseUncommittedCandidate();
      // Await publication inside this try so rejection releases the candidate unless ownership already committed.
      return await withPluginInstallLock(manifest.id, async () => {
        let displacedUnpublishedCandidate:
          | { plugin: LoadedPlugin; disposers: Array<() => void> | undefined }
          | undefined;
        const result = await generationLifecycle.replaceRuntimeWithCommit(
          projection,
          input.receiptRaw,
          input.durableCommit,
          this.capabilityDependencyCommitScope(() => {
            this.assertActiveCapabilityDependencies(
              manifest,
              "prepared artifact activation",
            );
            this.assertActiveCapabilityDependentsRemainSatisfied(
              manifest.id,
              manifest,
              "prepared artifact activation",
            );
            const incumbent = this.plugins.get(manifest.id);
            if (
              incumbent
              && this.isUnpublishedLoadedCandidate(
                manifest.id,
                incumbent,
                generationLifecycle,
              )
            ) {
              displacedUnpublishedCandidate = {
                plugin: incumbent,
                disposers: this.disposers.get(manifest.id),
              };
            }
            commit();
          }),
        );
        if (candidateConfigOverride) {
          this.mergeConfigOverride(manifest.id, candidateConfigOverride);
        }

        // Clear blocked retry state only after durable commit and pointer publication; failed commits leave it retryable.
        this.clearCapabilityBlockedRetry(
          manifest.id,
          `plugin '${manifest.id}' capability dependency wait was superseded by prepared activation`,
        );
        this.beginPluginLifecycleOperation(manifest.id);
        this.preparation.clearFor(manifest.id);
        this.onEnable?.(manifest.id);

        const displacedRetirement = displacedUnpublishedCandidate
          ? this.retireDisplacedUnpublishedLoadedCandidate(
              manifest.id,
              displacedUnpublishedCandidate.plugin,
              displacedUnpublishedCandidate.disposers,
              payloadRoot,
              "prepared artifact activation replacement",
            )
          : Promise.resolve();
        const retirement = Promise.all([result.retirement, displacedRetirement])
          .then(() => undefined);
        const completion = Promise.all([result.completion, displacedRetirement])
          .then(() => undefined);
        // Observe retirement rejection until consumers await it.
        void retirement.catch(() => undefined);
        void completion.catch(() => undefined);
        return Object.freeze({
          result: result.result,
          retirement,
          completion,
          retirementDeferred: result.retirementDeferred,
        });
      });
    } catch (error) {
      if (
        factoryFailureRequiresQuarantine(error)
        || error instanceof PluginStartupTimeoutError
      ) {
        this.quarantinePluginLifecycle(manifest.id, error.message);
      }
      const committed = generationLifecycle.getActive(manifest.id)?.generationId === generationId;
      if (!committed) {
        try {
          await releaseUncommittedCandidate();
        } catch (cleanupError) {
          const withheld = isCommittedPluginGenerationPublicationError(error);
          log.error(`${manifest.id} prepared candidate cleanup failed${withheld ? " after its durable commit" : ""}: ${errorMessage(cleanupError)}`);
          this.auditAttemptEvent("plugin_attempt_cleanup_failed", {
            pluginId: manifest.id,
            context: withheld ? "withheld prepared artifact activation" : "failed prepared artifact activation",
            reason: errorMessage(cleanupError),
          });
        }
      }
      // Record child-factory refusal against the replacement attempt while the incumbent keeps serving; propagate the update error.
      if (!committed) this.recordAttemptRefusal(manifest, error, "update");
      throw error;
    }
    }));
  }

  async removePluginWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
  ): Promise<T> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const generationLifecycle = this.requireCapabilityCommitLifecycle("atomic plugin removal");
    return generationLifecycle.runInLifecycleQueue(canonicalPluginId, () => {
      this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
      return commitAtomicPluginRemoval({
        requestedPluginId: pluginId,
        // Unpublished blocked candidates have no bundle pointer; commit removal before retiring their local resources.
        loaded: Boolean(generationLifecycle.getActive(canonicalPluginId)),
        known: this.hasTrackedPluginState(canonicalPluginId),
        hasActiveGeneration: () => Boolean(generationLifecycle.getActive(canonicalPluginId)),
        durableCommit,
        deactivateWithCommit: () =>
          generationLifecycle.deactivateWithCommit(
            canonicalPluginId,
            durableCommit,
            this.capabilityDependencyCommitScope(() => {
              this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
            }),
          ),
        captureRetirementFailure: (retirement) =>
          this.captureCommittedRetirementFailure(
            canonicalPluginId,
            retirement,
            "atomic plugin removal",
        ),
        purgeRuntimeState: () => this.removePlugin(canonicalPluginId),
      });
    });
  }

}

const BOOT_START_CANCELLED = "plugin start cancelled";

/** One attempt owns every acquired resource until handover, so every early exit can release it exactly once. */
type PluginLoadAttemptResources = {
  pluginId: string;
  routed?: RoutedPluginFactory;
  runtimeRoot?: string;
  incarnation?: {
    deactivate: () => void;
    disposers: Array<() => void>;
    drainOperations: () => Promise<void>;
    hostEffects: HostApiGenerationScope;
  };
  constructed?: {
    instance: RuntimePlugin;
    lifecycleHookScope: PluginLifecycleHookScope;
  };
  /** Coordinator commit or boot registration transfers ownership; later failure must not trigger attempt cleanup or refusal. */
  handedOver?: true;
  cleanupFailures?: unknown[];
};
class PluginRuntimeLifecycle extends PluginRuntimeCapabilityLifecycle {
  /** All lifecycle paths use one factory-routing funnel; unconfined process launches fail rather than falling back. */
  protected async importPluginFactoryForLifecycle(
    pluginId: string,
    source: PluginFactorySource,
    manifest: PluginManifest,
    verified: PluginIntegrityEvidence | undefined,
  ): Promise<RoutedPluginFactory> {
    this.assertPluginLifecycleAvailable(pluginId);
    // Verify process-entry provenance before factory routing, using this caller’s own receipt evidence.
    assertProcessEntryAdmitted(manifest, verified);
    if (source.kind !== pluginEntryKind(manifest)) {
      throw new Error(`plugin '${pluginId}' factory source is '${source.kind}' but its manifest declares '${pluginEntryKind(manifest)}'`);
    }
    const outOfProcess = {
      manifest,
      auditLog: this.auditLog,
      childEntryPath: this.childEntryPath,
      registerSandboxEnvelope: (paths: readonly string[], pluginRoot: string, pluginDataDir: string) =>
        this.registerSandboxEnvelope(manifest.id, paths, pluginRoot, pluginDataDir),
      onChildSpawned: (confinement: SpawnConfinement) =>
        this.recordChildSpawnConfinement(createPlugin, confinement),
      ...(this.onMalformedCredentialSelector
        ? { onMalformedCredentialSelector: this.onMalformedCredentialSelector }
        : {}),
    };
    // Process launch resolves against the generation context; fresh entry children need no import-cache invalidation.
    const createPlugin: RuntimePluginFactory = source.kind === "process"
      ? async (context) => createOutOfProcessPluginFactory({
        ...outOfProcess,
        launch: { kind: "process", ...resolveProcessLaunch(manifest, context.pluginRoot, context.pluginDataDir) },
      })(context)
      : createOutOfProcessPluginFactory({
        ...outOfProcess,
        launch: { kind: "entry", entryPath: source.resolvedEntryPath },
      });
    return { createPlugin, arm: "child" };
  }

  /** Loaded generation records, rather than plugin-id lists, determine which factory arms are running. */
  listLoadedPluginArms(): Array<{ pluginId: string; arm: PluginLoadArm }> {
    return [...this.plugins.values()].map((plugin) => ({ pluginId: plugin.manifest.id, arm: plugin.arm }));
  }

  protected async preflightBootLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<BootPreflightOutcome[]> {
    return preflightPluginLoadPlan(
      loadPlan,
      {
        prepare: () => this.getManifestValidator(),
        verify: (pluginId, pluginRoot) => this.verifyReceiptAndDevGuard(
          pluginId,
          pluginRoot,
          { report: false },
        ),
        readManifest: (manifestPath) => this.readManifest(manifestPath, { report: false }),
      },
    );
  }

  async load(): Promise<void> {
    this.requireGenerationLifecycle("plugin load");
    if (this.loaded) return;
    // Untrusted-path refusals never enter the load plan; create a diagnostic stub without overwriting a genuine load.
    const untrustedRegistryRows: RegistryLoadRefusal[] = [];
    const loadPlan = await this.resolveManifestLoadPlanInternal(
      (refusal) => untrustedRegistryRows.push(refusal),
    );
    for (const refusal of untrustedRegistryRows) {
      this.markUntrustedManifestPath(refusal);
    }
    for (const plan of loadPlan) {
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(plan.manifestPath))}>`;
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
    }
    const preflight = await this.preflightBootLoadPlan(loadPlan);
    this.assertPluginIdentityNamespace(
      preflight
        .filter((outcome) => outcome.ok)
        .map((outcome) => ({
          pluginId: outcome.manifest.id,
          alias: outcome.plan.pluginIdHint,
        })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    const enabledManifestSnapshots = new Map<string, ManifestSnapshot>();
    for (const outcome of preflight) {
      if (
        outcome.plan.pluginIdHint
        && "integrityResult" in outcome
        && outcome.integrityResult
      ) {
        this.reportPluginIntegrityResult(outcome.plan.pluginIdHint, outcome.integrityResult);
      }
      if (!outcome.ok && outcome.kind === "manifest") {
        this.reportPluginManifestRejected(outcome.plan.manifestPath, outcome.error);
      }
      if (!outcome.ok) continue;
      // Manifest ids own tools, events, grants, and HostApi; registry ids are deployment aliases only.
      const pluginId = outcome.manifest.id;
      // Structural preflight cannot admit dependencies; only successfully published generations supply capabilities.
      if (outcome.plan.enabled) {
        enabledManifestSnapshots.set(pluginId, {
          manifest: outcome.manifest,
          approvedPluginAccess: outcome.approvedPluginAccess,
        });
      }
      this.rememberPluginInstallAlias(outcome.manifest.id, outcome.plan.pluginIdHint);
      this.knownPluginManifests.set(pluginId, outcome.manifest);
      this.knownPluginAccessGrants.set(pluginId, outcome.approvedPluginAccess);
      this.rememberToolOwners(pluginId, outcome.manifest);
      for (const eventType of getDeclaredEmittedEvents(outcome.manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const outcome of preflight) {
      await this.admitPreflightedPlugin(outcome, enabledManifestSnapshots);
    }
    this.loaded = true;
  }

  /** An untrusted manifest path must never be read; expose its refusal through a stub card. */
  private markUntrustedManifestPath(refusal: RegistryLoadRefusal): void {
    log.error(`${refusal.pluginId} rejected — ${refusal.reason}`);
    this.auditLog?.("error", "plugin_manifest_path_untrusted", {
      pluginId: refusal.pluginId,
      manifestPath: refusal.manifestPath,
    });
    this.markLoadRefused(refusal.pluginId, {
      summary: "Plugin registry entry points outside the plugin folder.",
      reason: refusal.reason,
      kind: "untrusted-manifest-path",
    });
  }

  /** Isolate each complete load attempt so one thrown preflight or factory failure cannot stop the remaining plugins. */
  private async admitPreflightedPlugin(
    outcome: BootPreflightOutcome,
    enabledManifestSnapshots: Map<string, ManifestSnapshot>,
  ): Promise<void> {
    const resources: PluginLoadAttemptResources = {
      pluginId: outcome.plan.pluginIdHint
        ?? `<unresolved:${basename(dirname(outcome.plan.manifestPath))}>`,
    };
    if (this.isShuttingDown()) return;
    await this.trackCandidateConstruction(resources.pluginId, (construction) => {
      resources.cleanupFailures = construction.cleanupFailures;
      return this.admitPreflightedPluginAttempt(outcome, enabledManifestSnapshots, resources);
    });
  }

  private async admitPreflightedPluginAttempt(
    outcome: BootPreflightOutcome,
    enabledManifestSnapshots: Map<string, ManifestSnapshot>,
    resources: PluginLoadAttemptResources,
  ): Promise<void> {
    try {
      await this.instantiatePreflightedPlugin(outcome, enabledManifestSnapshots, resources);
    } catch (err) {
      if (resources.handedOver) {
        log.error(`${resources.pluginId} load threw after the plugin was registered; the registered plugin keeps running: ${errorMessage(err)}`);
        return;
      }
      await this.abandonCrashedPluginLoad(resources, err);
    }
  }

  private async instantiatePreflightedPlugin(
    outcome: BootPreflightOutcome,
    enabledManifestSnapshots: Map<string, ManifestSnapshot>,
    resources: PluginLoadAttemptResources,
  ): Promise<void> {
    const { plan } = outcome;
    const manifestPath = plan.manifestPath;
    const pluginRoot = dirname(manifestPath);
    let pluginId = resources.pluginId;
    if (!outcome.ok) {
      if (outcome.kind === "integrity") {
        if (plan.pluginIdHint) {
          // Without a trusted manifest, only the raw registry id is known.
          this.markReceiptIntegrityFailed(
            plan.pluginIdHint,
            outcome.integrityResult.reason,
          );
        }
        return;
      }
      const err = outcome.error;
      const reason =
        err instanceof SyntaxError ? "manifest_parse"
        : (err as Error).message?.includes("schema validation") ? "manifest_schema"
        : (err as NodeJS.ErrnoException).code === "ENOENT" ? "manifest_missing"
        : "manifest_read";
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.VALIDATION_FAIL, err, reason }, `manifest read failed: ${(err as Error).message}`);
      if (plan.pluginIdHint) {
        this.markLoadRefused(plan.pluginIdHint, {
          summary: "Plugin manifest could not be loaded.",
          reason: (err as Error).message,
          ...(reason === "manifest_schema" ? { kind: "manifest-validation-error" as const } : {}),
        });
      }
      return;
    }
    if (!plan.enabled) {
      pluginId = resources.pluginId = outcome.manifest.id;
      this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
      this.rememberPluginManifest(
        pluginId,
        outcome.manifest,
        outcome.approvedPluginAccess,
      );
      this.inactivePluginIds.add(pluginId);
      this.disabledPluginIds.add(pluginId);
      this.failedPluginIds.delete(pluginId);
      this.failedPluginStubs.delete(pluginId);
      this.loadFailureInfo.delete(pluginId);
      this.lastAttemptRefusal.delete(pluginId);
      logPluginLifecycle(
        "debug",
        { pluginId, phase: PluginPhase.LOAD_OK, reason: "inactive_pointer" },
        "plugin retained as inactive metadata without runtime admission",
      );
      return;
    }
    const { manifest, approvedPluginAccess } = outcome;
    // Once parsed, the manifest id supersedes the registry hint in every later phase.
    resources.pluginId = manifest.id;
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    this.knownPluginManifests.set(manifest.id, manifest);
    this.failedPluginStubs.delete(manifest.id);
    this.loadFailureInfo.delete(manifest.id);
    this.lastAttemptRefusal.delete(manifest.id);
    this.inactivePluginIds.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    // An installed plugin may require a newer host; keep its failure card while allowing other plugins to load.
    if (this.markIncompatibleAppVersion(manifest)) {
      return;
    }
    if (this.markIncompatibleHostProtocol(manifest)) {
      return;
    }
    if (this.markRevoked(manifest)) {
      return;
    }
    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length > 0) {
      const availableManifests = [...enabledManifestSnapshots.values()]
        .filter((candidate) => candidate.manifest.id !== manifest.id)
        .map((candidate) => candidate.manifest);
      const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
      if (!dependencyResult.ok) {
        const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
        log.error(`${manifest.id} rejected — ${reason}`);
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId: manifest.id,
          missing: dependencyResult.missing,
        });
        this.markFailed(manifest.id, {
          name: manifest.name ?? manifest.id,
          description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
        });
        return;
      }
    }
    if (this.preparation.deferStart(plan, manifest, approvedPluginAccess)) {
      return;
    }
    const activationId = randomUUID();
    const runtimeRoot = resources.runtimeRoot = await this.materializeImmutableRuntimeRoot(
      manifest.id,
      pluginRoot,
      activationId,
      plan.pluginIdHint ?? manifest.id,
    );
    let source: PluginFactorySource;
    try {
      source = this.pluginFactorySource(manifest, runtimeRoot);
    } catch (err) {
      const reason = (err as Error).message;
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "entry_path" }, "entry path rejected");
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      await this.releaseAttempt(resources, "failed boot entry");
      return;
    }
    let routed: RoutedPluginFactory;
    try {
      routed = await this.importPluginFactoryForLifecycle(
        manifest.id,
        source,
        manifest,
        outcome.integrityResult?.ok ? outcome.integrityResult.verified : undefined,
      );
    } catch (err) {
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      if (err instanceof ProcessEntryRequiresPinnedArtifactError) {
        this.markProcessEntryUnpinned(manifest, err);
      } else {
        this.markFailed(manifest.id);
      }
      await this.releaseAttempt(resources, "failed boot routing");
      return;
    }
    const { createPlugin } = routed;
    resources.routed = routed;

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostEffects = new HostApiGenerationScope(manifest.id);
    const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
      this.buildHostApiIncarnation(manifest.id, manifest, pluginDataDir, hostEffects);
    resources.incarnation = { deactivate, disposers, drainOperations, hostEffects };

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId: manifest.id,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
    } catch (err) {
      if (factoryFailureRequiresQuarantine(err)) {
        this.quarantinePluginLifecycle(manifest.id, err.message);
      }
      await this.releaseAttempt(resources, "failed load factory");
      this.reportAttemptFactoryFailure(manifest, err, resources);
      logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "factory" }, "plugin factory failed");
      return;
    }
    // Before registration the attempt owns the instance and child; boot cleanup releases them on failure.
    resources.constructed = { instance, lifecycleHookScope };

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle("warn", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler"),
    );
    for (const toolName of methods.keys()) {
      if (this.methodMap.has(toolName)) {
        await this.releaseAttempt(resources, "duplicate load method");
        const reason = `Duplicate plugin method registered: ${toolName}`;
        logPluginLifecycle("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "duplicate_tool_name" }, reason);
        this.auditLog?.("error", "plugin_duplicate_tool_name", { pluginId: manifest.id, toolName });
        this.markLoadRefused(manifest.id, {
          summary: "Plugin declares a tool name another plugin already owns.",
          reason,
          displayName: manifest.name ?? manifest.id,
        }, resources);
        return;
      }
    }
    if (this.isShuttingDown()) {
      // Release children constructed after shutdown began instead of registering them after the shutdown scan.
      await this.releaseAttempt(resources, "plugin runtime shutdown");
      return;
    }
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId: manifest.id, handler });
      logPluginLifecycle("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_OK, toolName }, "tool registered");
    }

    commit();
    this.plugins.set(manifest.id, {
      activationId,
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods,
      approvedPluginAccess,
      hostEffects,
      started: false,
      deactivateHostApi: deactivate,
      drainHostApiOperations: drainOperations,
      lifecycleHookScope,
      arm: routed.arm,
      confinement: this.confinementReport(createPlugin),
    });
    // Registration transfers root, incarnation, and instance ownership to the loaded plugin.
    this.handOverAttempt(resources);
    this.disposers.set(manifest.id, disposers);
    this.markPluginUiRevision(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);
    logPluginLifecycle("debug", { pluginId: manifest.id, phase: PluginPhase.LOAD_OK }, "plugin loaded");
    // Inactive plugins retain host, UI, and auth registrations; conversation scope controls model exposure.
  }

  async startAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin start");
    await this.load();
    // Admit only after providers start and publish, iterating so registry order cannot start consumers first.
    const pendingPluginIds = new Set(
      [...this.plugins.values()]
        .filter((plugin) => !plugin.started)
        .map((plugin) => plugin.manifest.id),
    );
    while (pendingPluginIds.size > 0) {
      const startable: Array<{ pluginId: string; plugin: LoadedPlugin }> = [];
      for (const pluginId of [...pendingPluginIds]) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || plugin.started) {
          pendingPluginIds.delete(pluginId);
          continue;
        }
        if (this.capabilityDependencies().missing(plugin.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        startable.push({ pluginId, plugin });
      }
      if (startable.length === 0) break;
      // Start siblings concurrently only when their dependencies were active before this layer; serialize publication.
      const outcomes = await Promise.all(startable.map(async ({ pluginId, plugin }) => ({
        pluginId,
        plugin,
        reason: await this.startLoadedPluginAtBoot(pluginId, plugin),
      })));
      for (const { pluginId, plugin, reason } of outcomes) {
        if (reason === undefined || reason === BOOT_START_CANCELLED) continue;
        await this.failBootPlugin(pluginId, plugin, reason);
      }
    }

    // Unresolved candidates cannot be admitted when a provider is missing, failed, or cyclic.
    for (const pluginId of pendingPluginIds) {
      const plugin = this.plugins.get(pluginId);
      if (!plugin) continue;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, preparingProviderIds);
        continue;
      }
      const reason = `missing required capabilities: ${missing.join(", ")}`;
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing,
      });
      this.markFailed(pluginId, {
        name: plugin.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      await this.failBootPlugin(pluginId, plugin, reason);
    }
  }

  override waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const readiness = this.capabilityBlockedReadiness.get(canonicalPluginId);
    if (readiness) return readiness.promise;
    return super.waitForPluginReady(canonicalPluginId);
  }

  protected async startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    return withPluginInstallLock(pluginId, () =>
      this.startLoadedPluginAtBootLocked(pluginId, expectedPlugin, shouldCommit),
    );
  }

  private async startLoadedPluginAtBootLocked(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin start");
    const plugin = this.plugins.get(pluginId);
    // Shutdown owns retirement when it cancels a boot start.
    const isCurrent = () =>
      !this.isShuttingDown()
      && this.plugins.get(pluginId) === plugin
      && (!expectedPlugin || plugin === expectedPlugin)
      && (shouldCommit?.() ?? true);
    if (!plugin || !isCurrent()) return BOOT_START_CANCELLED;
    const SLOW_THRESHOLD_MS = 5000;
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      log.warn(`slow plugin: ${pluginId} (>${SLOW_THRESHOLD_MS}ms)`);
    }, SLOW_THRESHOLD_MS);
    // After this projection commits, the generation owns its resources even if publication later throws.
    let committed = false;
    let publishedProjection: PluginRuntimeGenerationProjection | undefined;
    try {
      this.perf.ensure(pluginId);
      if (plugin.instance.start) {
        try {
          if (!isCurrent()) return BOOT_START_CANCELLED;
          await runStartWithTimeout(
            () => this.runPluginLifecycleHook(
              plugin.lifecycleHookScope,
              plugin.instance.start!.bind(plugin.instance),
            ),
            plugin.manifest.startupTimeoutMs,
          );
          if (!isCurrent()) return BOOT_START_CANCELLED;
        } catch (error) {
          if (error instanceof PluginStartupTimeoutError) {
            this.quarantinePluginLifecycle(pluginId, error.message);
          }
          plugin.deactivateHostApi?.();
          throw error;
        }
      }
      if (!isCurrent()) return BOOT_START_CANCELLED;
      const elapsed = Date.now() - startedAt;
      this.perf.setStartupMs(pluginId, elapsed);
      const projection = this.getRuntimeGenerationProjection(pluginId);
      if (!projection) throw new Error("runtime projection disappeared before publication");
      publishedProjection = projection;
      this.commitHandoffs.set(projection, () => { committed = true; });
      await generationLifecycle.replaceRuntime(
        projection,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(BOOT_START_CANCELLED);
          }
          this.assertActiveCapabilityDependencies(
            plugin.manifest,
            "plugin start",
          );
          plugin.started = true;
        }),
      );
      this.resolveCapabilityBlockedRetry(pluginId);
      if (elapsed > SLOW_THRESHOLD_MS) {
        logPluginLifecycle("warn", { pluginId, phase: PluginPhase.START_SLOW, elapsedMs: elapsed }, "plugin start slow");
      } else {
        logPluginLifecycle("debug", { pluginId, phase: PluginPhase.START_OK, elapsedMs: elapsed }, "plugin start ok");
      }
      return undefined;
    } catch (error) {
      if (committed) {
        // Post-commit faults retain generation ownership; normal removal retires it exactly once.
        logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, err: error, reason: "post_commit" }, "plugin start failed after its generation was committed");
        try {
          this.resolveCapabilityBlockedRetry(pluginId);
        } catch (followUpError) {
          log.error(`${pluginId} bookkeeping after a committed boot start failed: ${errorMessage(followUpError)}`);
        }
        return undefined;
      }
      plugin.started = false;
      plugin.deactivateHostApi?.();
      if (!isCurrent()) return BOOT_START_CANCELLED;
      return errorMessage(error);
    } finally {
      clearTimeout(slowTimer);
      if (publishedProjection) this.commitHandoffs.delete(publishedProjection);
    }
  }

  protected async failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) return;
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
    logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
    await this.failClosedLoadedPlugin(pluginId, plugin, "start failure cleanup");
    if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
  }

  private deferBlockedLoadedPlugin(
    plugin: LoadedPlugin,
    providerIds: readonly string[],
  ): void {
    const pluginId = plugin.manifest.id;
    const isCurrent = this.capabilityBlockedRetryGuard(
      pluginId,
      plugin.manifest,
      plugin,
    );
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () =>
      withPluginInstallLock(pluginId, async () => {
      // A stale provider callback must not resurrect a replaced or removed load candidate.
      if (!isCurrent() || plugin.started) return;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const nextProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (nextProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, nextProviderIds);
        return;
      }
      if (missing.length > 0) {
        const reason = `missing required capabilities: ${missing.join(", ")}`;
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId,
          missing,
        });
        this.markFailed(pluginId, {
          name: plugin.manifest.name ?? pluginId,
          description: `Missing capabilities: ${missing.join(", ")}`,
        });
        await this.failBootPlugin(pluginId, plugin, reason);
        return;
      }
      const reason = await this.startLoadedPluginAtBoot(pluginId, plugin, isCurrent);
      if (reason !== undefined && reason !== BOOT_START_CANCELLED) {
        await this.failBootPlugin(pluginId, plugin, reason);
      }
      }), isCurrent);
  }

  protected deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void {
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return;
    const isCurrent = this.capabilityBlockedRetryGuard(pluginId, manifest);
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () => {
      // Re-enter by id to re-resolve registry, receipt, canonical identity, and lifecycle generation.
      if (!isCurrent() || !this.hasTrackedPluginState(pluginId)) return;
      try {
        this.capabilityBlockedRetryAdds.add(pluginId);
        const result = await this.addPlugin(pluginId);
        if (result === "preparing" && this.preparation.isPreparing(pluginId)) {
          this.bridgeCapabilityBlockedReadinessToPreparation(pluginId);
        }
      } catch (error) {
        if (
          isCurrent()
          && this.hasTrackedPluginState(pluginId)
          && !this.inactivePluginIds.has(pluginId)
          && !this.disabledPluginIds.has(pluginId)
        ) {
          const message = errorMessage(error);
          this.auditLog?.("error", "plugin_dependency_retry_failed", {
            pluginId,
            reason: message,
          });
          this.markFailed(pluginId, {
            name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
            description: message,
          });
          this.rejectCapabilityBlockedRetry(pluginId, new Error(message));
        }
      } finally {
        this.capabilityBlockedRetryAdds.delete(pluginId);
      }
    }, isCurrent);
  }

  protected override resetLoadedState(): void {
    this.clearAllCapabilityBlockedRetries();
    this.capabilityBlockedRetryAdds.clear();
    super.resetLoadedState();
  }

  /** Retire every owned generation once within the shutdown deadline; shared references must not duplicate drain or disposal. */
  async stopAll(options: { signal?: AbortSignal } = {}): Promise<PluginRuntimeShutdownReport> {
    const deadline = options.signal ? undefined : new AbortController();
    const deadlineTimer = deadline
      ? setTimeout(() => deadline.abort(), TOOL_TIMEOUT_POLICY.shutdownCleanupMs)
      : undefined;
    deadlineTimer?.unref?.();
    const signal = options.signal ?? deadline!.signal;
    try {
      return await this.stopAllWithin(signal);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  private async stopAllWithin(signal: AbortSignal): Promise<PluginRuntimeShutdownReport> {
    this.beginShutdown();
    // Failed retirement remains unfinished because resources may still exist.
    const pending: Array<{ pluginId: string; done: Promise<void>; finished: boolean }> = [];
    const track = (pluginId: string, work: Promise<unknown>, after?: () => void): void => {
      const record = { pluginId, done: Promise.resolve(), finished: false };
      record.done = work.then(
        () => { record.finished = true; },
        (error: unknown) => {
          log.error(`${pluginId} shutdown retirement failed: ${errorMessage(error)}`);
        },
      ).finally(() => after?.());
      pending.push(record);
    };
    const retire = (runtime: PluginRuntimeRetirementView, after?: () => void): void =>
      track(runtime.manifest.id, this.runShutdownRetirement(runtime), after);

    const committedUnmapped = [...this.committedUnmappedGenerations.values()];
    this.committedUnmappedGenerations.clear();
    for (const runtime of committedUnmapped) retire(runtime);
    for (const candidate of this.candidateConstructions) {
      track(candidate.pluginId, candidate.releaseForShutdown?.() ?? candidate.settled);
    }

    const graceMs = TOOL_TIMEOUT_POLICY.pluginShutdownHandlerMs;
    if (!await this.waitForGenerationRetirements(graceMs, signal) && !signal.aborted) {
      log.warn(`plugin retirements still waiting after ${graceMs}ms of shutdown; aborting in-flight plugin calls and stopping their generations`);
    }
    this.runtimeShutdown.abort();
    for (const retiring of this.generationLifecycle?.listRetiringGenerations() ?? []) {
      track(retiring.pluginId, Promise.all([
        this.runShutdownRetirement(retiring.runtime),
        retiring.retired,
      ]));
    }
    for (const [pluginId, plugin] of [...this.plugins]) {
      retire({
        manifest: plugin.manifest,
        instance: plugin.instance,
        lifecycleHookScope: plugin.lifecycleHookScope,
        hostEffects: plugin.hostEffects,
        disposers: this.disposers.get(pluginId) ?? [],
        deactivateHostApi: plugin.deactivateHostApi,
        drainHostApiOperations: plugin.drainHostApiOperations,
      }, () => this.disposers.delete(pluginId));
    }
    await untilAborted(Promise.all(pending.map((record) => record.done)), signal);
    const unfinished = [...new Set(
      pending.filter((record) => !record.finished).map((record) => record.pluginId),
    )];
    if (unfinished.length > 0) {
      log.error(`plugin shutdown deadline reached before these plugins finished retiring; the process backstop ends them: ${unfinished.join(", ")}`);
      try {
        this.auditLog?.("error", "plugin_shutdown_retirement_incomplete", { pluginIds: unfinished });
      } catch (auditError) {
        log.error(`plugin shutdown audit failed: ${errorMessage(auditError)}`);
      }
    }
    return Object.freeze({ unfinished: Object.freeze(unfinished) });
  }

  /** Run every shutdown phase despite earlier failures, then report the generation unfinished if any failed. */
  private async runShutdownRetirement(runtime: PluginRuntimeRetirementView): Promise<void> {
    const failures: unknown[] = [];
    for (const step of this.prepareRuntimeRetirement(runtime)) {
      try {
        await step.run();
      } catch (error) {
        log.error(`${runtime.manifest.id} shutdown retirement failed (${step.phase}): ${errorMessage(error)}`);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `plugin '${runtime.manifest.id}' shutdown retirement failed`);
    }
  }

  /** False also means the caller aborted before retirement settled. */
  private async waitForGenerationRetirements(withinMs: number, signal?: AbortSignal): Promise<boolean> {
    const lifecycle = this.generationLifecycle;
    if (!lifecycle) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await untilAborted(Promise.race([
        lifecycle.waitForRetirements().then(
          () => true,
          (error: unknown) => {
            log.error(`plugin retirement failed during shutdown: ${errorMessage(error)}`);
            return true;
          },
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), withinMs);
          timer.unref?.();
        }),
      ]), signal) ?? false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async restartAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin restartAll");
    // Cancel dependency-held plugin locks before the global mutation queues.
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    return withAllPluginInstallLocks(() => this.restartAllLocked());
  }

  private async restartAllLocked(): Promise<void> {
    const lifecycleIds = new Set([
      ...this.plugins.keys(),
      ...this.pendingRestarts.keys(),
      ...this.pluginLifecycleGenerations.keys(),
    ]);
    for (const pluginId of lifecycleIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by restartAll`,
      );
      this.beginPluginLifecycleOperation(pluginId);
    }
    await Promise.allSettled([...this.pendingRestarts.values()]);
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    const targets = currentIdentities.filter(({ plan }) => plan.enabled);
    const targetIds = new Set(targets.map(({ snapshot }) => snapshot.manifest.id));
    // Remove consumers before their providers so ordinary dependency guards remain valid during teardown.
    const pendingRemovalIds = new Set(
      [...this.plugins.keys()].filter((pluginId) => !targetIds.has(pluginId)),
    );
    while (pendingRemovalIds.size > 0) {
      const nextPluginId = [...pendingRemovalIds].find(
        (pluginId) =>
          this.activeCapabilityDependentsMissingAfterProviderChange(
            pluginId,
            undefined,
          ).length === 0,
      );
      if (!nextPluginId) {
        // Refuse remaining dependents or cycles rather than bypassing the public removal guard.
        const blockedPluginId = pendingRemovalIds.values().next().value;
        if (typeof blockedPluginId === "string") {
          this.assertNoActiveCapabilityDependents(blockedPluginId, "remove");
        }
        throw new Error("restartAll could not order capability-dependent removals");
      }
      await this.removePlugin(nextPluginId);
      pendingRemovalIds.delete(nextPluginId);
    }

    // Cold restart admits providers before consumers, regardless of registry order.
    const pendingPluginIds = new Set(
      targets.map(({ snapshot }) => snapshot.manifest.id),
    );
    const failures: Error[] = [];
    let madeProgress = true;
    while (pendingPluginIds.size > 0 && madeProgress) {
      madeProgress = false;
      for (const { snapshot } of targets) {
        const pluginId = snapshot.manifest.id;
        if (!pendingPluginIds.has(pluginId)) continue;
        if (this.capabilityDependencies().missing(snapshot.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        madeProgress = true;
        try {
          if (this.plugins.has(pluginId)) {
            const result = await this.restartPlugin(pluginId);
            if (result === "failed") {
              failures.push(new Error(`restartAll failed for ${pluginId}`));
            }
          } else {
            await this.addPlugin(pluginId);
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
    for (const { snapshot, plan } of targets) {
      const pluginId = snapshot.manifest.id;
      if (!pendingPluginIds.has(pluginId)) continue;
      const missing = this.capabilityDependencies().missing(snapshot.manifest);
      this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
      this.rememberPluginManifest(
        pluginId,
        snapshot.manifest,
        snapshot.approvedPluginAccess,
      );
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        snapshot.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedAddPlugin(pluginId, preparingProviderIds);
        continue;
      }
      this.markFailed(pluginId, {
        name: snapshot.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      failures.push(
        new Error(
          `restartAll blocked for ${pluginId} — missing required capabilities: ${missing.join(", ")}`,
        ),
      );
    }
    if (failures.length > 0) throw failures[0]!;
  }

  async restartPlugin(
    pluginId: string,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    if (!this.plugins.has(canonicalPluginId)
      && this.loadFailureInfo.get(canonicalPluginId)?.installFailureKind === "sandbox-grant-outside-ceiling") {
      try {
        return (await this.addPlugin(canonicalPluginId)) === "preparing" ? "deferred" : "started";
      } catch {
        return "failed";
      }
    }
    if (
      hasExclusivePluginLifecycleMutation()
      && !isPluginInstallLockHeld(canonicalPluginId)
    ) {
      log.warn(
        `restartPlugin rejected while an all-plugin lifecycle mutation is queued: ${canonicalPluginId}`,
      );
      return "failed";
    }
    const pending = this.pendingRestarts.get(canonicalPluginId);
    if (pending) return pending;
    const cancellation = this.createPendingRestartCancellation();
    this.pendingRestartCancellations.set(canonicalPluginId, cancellation);
    const restart = withPluginInstallLock(canonicalPluginId, async () => {
      this.clearCapabilityBlockedRetry(
        canonicalPluginId,
        `plugin '${canonicalPluginId}' capability dependency wait was cancelled by restart`,
      );
      const generation = this.beginPluginLifecycleOperation(
        canonicalPluginId,
        cancellation,
      );
      cancellation.generation = generation;
      if (cancellation.cancelled) return "failed";
      return this.restartPluginInternal(
        canonicalPluginId,
        generation,
        cancellation,
        opts,
      );
    }).finally(() => {
      if (this.pendingRestarts.get(canonicalPluginId) === restart) {
        this.pendingRestarts.delete(canonicalPluginId);
      }
      if (this.pendingRestartCancellations.get(canonicalPluginId) === cancellation) {
        this.pendingRestartCancellations.delete(canonicalPluginId);
      }
    });
    this.pendingRestarts.set(canonicalPluginId, restart);
    return restart;
  }

  protected async restartPluginInternal(
    pluginId: string,
    generation: number,
    cancellation: PendingRestartCancellation,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin restart");
    logPluginLifecycle("info", { pluginId, phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.RESTART_REQUEST, reason: "not_loaded" }, "restart no-op — plugin not loaded");
      return undefined;
    }
    const isCurrent = () =>
      !cancellation.cancelled
      && this.isPluginLifecycleOperationCurrent(pluginId, generation);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (!isCurrent()) return "failed";
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (!isCurrent()) return "failed";
    const installClaim = this.getPluginInstallClaim(pluginId);
    const targetIdentity = currentIdentities.find(({ plan, snapshot }) => {
      if (snapshot.manifest.id !== pluginId) return false;
      return installClaim === null
        ? !plan.pluginIdHint
          && resolve(dirname(plan.manifestPath)) === resolve(plugin.pluginRoot)
        : plan.pluginIdHint === (installClaim ?? pluginId);
    });
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    const pluginRoot = targetPlan ? dirname(targetPlan.manifestPath) : plugin.pluginRoot;
    const approvedPluginAccess =
      snapshot?.approvedPluginAccess ??
      targetPlan?.approvedPluginAccess ??
      plugin.approvedPluginAccess ??
      this.knownPluginAccessGrants.get(pluginId);
    const receiptPluginId = targetPlan?.pluginIdHint ?? this.getPluginInstallClaim(pluginId);
    const integrityResult: PluginIntegrityCheckResult = receiptPluginId
      ? await this.verifyReceiptAndDevGuard(receiptPluginId, pluginRoot)
      : { ok: true };
    if (!isCurrent()) return "failed";
    if (!integrityResult.ok) {
      return "failed";
    }
    let manifest: PluginManifest;
    try {
      manifest =
        snapshot?.manifest ??
        (await this.readManifest(targetPlan?.manifestPath ?? resolve(pluginRoot, "plugin.json")));
    } catch (err) {
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "manifest_read" }, "manifest read failed during restart");
      return "failed";
    }
    this.assertPluginManifestIdentity(pluginId, manifest.id);
    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${pluginId} restart rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing: missingCapabilities,
      });
      if (opts.throwOnFailure) throw new Error(reason);
      return "failed";
    }
    try {
      this.assertActiveCapabilityDependentsRemainSatisfied(
        pluginId,
        manifest,
        "plugin restart",
      );
    } catch (error) {
      if (opts.throwOnFailure) throw error;
      log.error(
        `${pluginId} restart rejected — ${(error as Error).message}`,
      );
      return "failed";
    }
    const restartPlan: ManifestLoadPlan = targetPlan ?? {
      pluginIdHint: pluginId,
      manifestPath: resolve(pluginRoot, "plugin.json"),
      enabled: true,
      approvedPluginAccess,
    };

    let preparationResult: PluginStartPreparationOutcome = undefined;
    if (!opts.skipPreparation && this.preparePluginStart) {
      const pluginRootForPreparation = dirname(restartPlan.manifestPath);
      let result: PluginStartPreparationReturn;
      let preparation = this.pendingRestartPreparations.get(pluginId);
      if (!preparation) {
        try {
          result = this.preparePluginStart({
            pluginId: manifest.id,
            manifest,
            manifestPath: restartPlan.manifestPath,
            pluginRoot: pluginRootForPreparation,
          });
        } catch (err) {
          logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
        if (result && typeof (result as Promise<PluginStartPreparationOutcome>).then === "function") {
          preparation = Promise.resolve(result);
          this.pendingRestartPreparations.set(pluginId, preparation);
          void preparation.finally(() => {
            if (this.pendingRestartPreparations.get(pluginId) === preparation) {
              this.pendingRestartPreparations.delete(pluginId);
            }
          }).catch(() => {});
        } else {
          preparationResult = result as PluginStartPreparationOutcome;
        }
      }
      if (preparation) {
        try {
          const outcome = await Promise.race([
            preparation.then((result) => ({ status: "prepared" as const, result })),
            cancellation.promise.then(() => ({ status: "cancelled" as const })),
          ]);
          if (outcome.status === "cancelled") return "failed";
          preparationResult = outcome.result;
        } catch (err) {
          logPluginLifecycle("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    if (!isCurrent()) return "failed";
    if (
      preparationResult
      && typeof preparationResult === "object"
      && preparationResult.configOverride
    ) {
      this.mergeConfigOverride(pluginId, preparationResult.configOverride);
    }
    const activationId = randomUUID();
    const runtimeRoot = await this.materializeImmutableRuntimeRoot(
      pluginId,
      pluginRoot,
      activationId,
      receiptPluginId ?? pluginId,
    );
    const replacementAttempt: PluginLoadAttemptResources = { pluginId, runtimeRoot };
    let source: PluginFactorySource;
    try {
      source = this.pluginFactorySource(manifest, runtimeRoot);
    } catch (error) {
      await this.releaseAttempt(replacementAttempt, "failed restart entry");
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "entry_path" }, "entry path rejected during restart");
      if (opts.throwOnFailure) throw error;
      return "failed";
    }
    let routed: RoutedPluginFactory;
    try {
      routed = await this.importPluginFactoryForLifecycle(
        pluginId,
        source,
        manifest,
        integrityResult.verified,
      );
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "factory routed");
    } catch (err) {
      await this.releaseAttempt(replacementAttempt, "failed restart routing");
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    const { createPlugin } = routed;

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostEffects = new HostApiGenerationScope(pluginId);
    const {
      hostApi,
      disposers: replacementDisposers,
      deactivate: deactivateReplacementHostApi,
      drainOperations: drainReplacementHostApiOperations,
      commit: commitReplacementHostApi,
      lifecycleHookScope: replacementLifecycleHookScope,
    } = this.buildHostApiIncarnation(
      pluginId,
      manifest,
      pluginDataDir,
      hostEffects,
    );
    replacementAttempt.incarnation = {
      deactivate: deactivateReplacementHostApi,
      disposers: replacementDisposers,
      drainOperations: drainReplacementHostApiOperations,
      hostEffects,
    };

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          replacementLifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivateReplacementHostApi();
          await this.stopAfterStartFailure(
            pluginId,
            lateInstance,
            replacementLifecycleHookScope,
          );
        },
      );
    } catch (err) {
      if (factoryFailureRequiresQuarantine(err)) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      await this.releaseAttempt(replacementAttempt, "failed restart factory");
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "createPlugin_failed" }, "createPlugin failed during restart");
      // Replacement refusal belongs to that attempt; the running incumbent remains loaded.
      this.recordAttemptRefusal(manifest, err, "restart");
      if (opts.throwOnFailure) throw err;
      return "failed";
    }
    replacementAttempt.constructed = { instance, lifecycleHookScope: replacementLifecycleHookScope };

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart factory");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart"),
    );

    try {
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            replacementLifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.RESTART_START_OK }, "restart complete");
    } catch (err) {
      if (err instanceof PluginStartupTimeoutError) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_START_FAIL, err }, "start after restart failed");
      await this.releaseAttempt(replacementAttempt, "failed restart start");
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart start");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers: replacementDisposers,
      deactivateHostApi: deactivateReplacementHostApi,
      drainHostApiOperations: drainReplacementHostApiOperations,
      lifecycleHookScope: replacementLifecycleHookScope,
      arm: routed.arm,
      confinement: this.confinementReport(createPlugin),
    });
    // Coordinator commit transfers ownership of this exact candidate.
    let committed = false;
    this.commitHandoffs.set(candidate, () => { committed = true; });
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(`plugin restart cancelled for ${pluginId}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin restart");
          this.assertActiveCapabilityDependentsRemainSatisfied(
            pluginId,
            manifest,
            "plugin restart",
          );
          commitReplacementHostApi();
        }),
      );
    } catch (error) {
      if (committed) {
        // After commit, finish bookkeeping before returning the lifecycle error; report secondary bookkeeping failure separately.
        logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "post_commit" }, "runtime generation failed after it was committed");
        try {
          this.onEnable?.(pluginId);
        } catch (followUpError) {
          log.error(`${pluginId} bookkeeping after a committed restart failed: ${errorMessage(followUpError)}`);
          this.auditAttemptEvent("plugin_add_follow_up_failed", {
            pluginId,
            reason: errorMessage(followUpError),
          });
        }
        if (opts.throwOnFailure) throw error;
        return "failed";
      }
      await this.releaseAttempt(replacementAttempt, "failed restart publication");
      logPluginLifecycle("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "publication" }, "runtime generation publication failed");
      if (opts.throwOnFailure) throw error;
      return "failed";
    } finally {
      this.commitHandoffs.delete(candidate);
    }
    this.onEnable?.(pluginId);
    return "started";
  }

  async addPlugin(pluginId: string): Promise<"started" | "preparing"> {
    const knownPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(knownPluginId);
    if (!this.capabilityBlockedRetryAdds.has(knownPluginId)) {
      this.clearCapabilityBlockedRetry(
        knownPluginId,
        `plugin '${knownPluginId}' capability dependency wait was superseded by a new add`,
      );
    }
    if (this.plugins.has(knownPluginId)) {
      try {
        const restartResult = await this.restartPlugin(knownPluginId);
        if (restartResult === "deferred") return "preparing";
        if (restartResult === "failed") {
          throw new Error(`restartPlugin failed for ${pluginId}`);
        }
      } catch (err) {
        if ((err as { code?: string })?.code === "plugin-identity-collision") throw err;
        throw new Error(`addPlugin failed for ${pluginId}: ${(err as Error).message}`);
      }
      this.throwIfPluginFailedAfterAdd(knownPluginId);
      return "started";
    }

    const activePreparationGeneration = this.pluginLifecycleGenerations.get(knownPluginId);
    const lifecycleGeneration =
      this.preparation.hasPending(knownPluginId) && activePreparationGeneration !== undefined
        ? activePreparationGeneration
        : this.beginPluginLifecycleOperation(pluginId);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const targetIdentity = currentIdentities.find(({ plan }) =>
      plan.enabled && plan.pluginIdHint === pluginId
    ) ?? currentIdentities.find(({ plan, snapshot }) =>
      !plan.pluginIdHint && plan.enabled && snapshot.manifest.id === pluginId
    );
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    if (!snapshot) {
      const requestedPlan = loadPlan.find((plan) => plan.pluginIdHint === pluginId);
      if (requestedPlan?.enabled) {
        await this.readManifest(requestedPlan.manifestPath);
      }
      throw new Error(`addPlugin: plugin not found in registry or disabled: ${pluginId}`);
    }
    if (!targetPlan) {
      throw new Error(`addPlugin: load plan entry missing for ${pluginId}`);
    }

    const { manifest, approvedPluginAccess } = snapshot;
    if (!this.adoptPluginLifecycleIdentity(
      pluginId,
      manifest.id,
      lifecycleGeneration,
      targetPlan.pluginIdHint,
    )) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const shouldCommit = () =>
      this.isPluginLifecycleOperationCurrent(manifest.id, lifecycleGeneration);
    if (!shouldCommit()) throw new Error(`addPlugin cancelled for ${pluginId}`);
    this.rememberPluginManifest(manifest.id, manifest, approvedPluginAccess);

    const startResult = await this.instantiateAndStartSinglePlugin(
      targetPlan,
      manifest,
      approvedPluginAccess,
      { shouldCommit },
    );
    if (startResult === "deferred") return "preparing";
    if (startResult === "cancelled") {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }

    // IPC install callers need a hard failure signal for rollback.
    this.throwIfPluginFailedAfterAdd(manifest.id);
    return "started";
  }

  async removePlugin(
    pluginId: string,
    options: { preserveConfigOverride?: boolean } = {},
  ): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    // Cancel dependency-held restart work before entering the lifecycle lock.
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    return withPluginInstallLock(canonicalPluginId, () =>
      this.removePluginLocked(pluginId, canonicalPluginId, options)
    );
  }

}

export class PluginRuntime extends PluginRuntimeLifecycle {
  private readonly pendingSandboxRetirements = new Map<string, Promise<void>>();

  /** Retire incarnations whose reviewed path grants exceed the live approved roots. */
  async retireSandboxGrantsOutsideCeiling(): Promise<string[]> {
    const affected = this.sandboxGrantWithdrawals();
    const outcomes = await Promise.allSettled(affected.map(({ pluginId, settled }) => {
      let retirement = this.pendingSandboxRetirements.get(pluginId);
      if (!retirement) {
        retirement = Promise.resolve().then(() => this.retireSandboxGrantIncarnation(pluginId, settled));
        this.pendingSandboxRetirements.set(pluginId, retirement);
        void retirement.finally(() => {
          if (this.pendingSandboxRetirements.get(pluginId) === retirement) {
            this.pendingSandboxRetirements.delete(pluginId);
          }
        }).catch(() => {});
      }
      return retirement;
    }));
    const errors = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "sandbox grant retirement failed");
    return affected.map(({ pluginId }) => pluginId);
  }

  private async retireSandboxGrantIncarnation(pluginId: string, settled: Promise<SandboxEnvelopeSettlement[]>): Promise<void> {
    this.cancelPendingRestart(pluginId);
    this.beginPluginLifecycleOperation(pluginId);
    const plugin = this.plugins.get(pluginId);
    const errors: unknown[] = [];
    if (plugin) {
      try {
        errors.push(...(plugin.hostEffects?.retire() ?? []));
      } catch (error) {
        errors.push(error);
      }
      try {
        if (!await this.failClosedLoadedPlugin(pluginId, plugin, "sandbox ceiling withdrawal", true)) {
          errors.push(new Error("sandbox grant incarnation did not stop cleanly"));
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await waitForPluginWorkersStopped(pluginId);
    } catch (error) {
      errors.push(error);
    }
    // A quarantined record settles at once, so one unverified child never holds back another plugin's retirement.
    if ((await settled).includes("quarantined")) {
      errors.push(new Error(`sandbox grant incarnation is quarantined; its grants stay in place: ${pluginId}`));
    }
    this.markLoadRefused(pluginId, {
      summary: "Plugin filesystem grant is outside approved directories.",
      reason: "sandbox-grant-outside-ceiling",
      kind: "sandbox-grant-outside-ceiling",
      displayName: plugin?.manifest.name ?? this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
    });
    if (errors.length > 0) throw new AggregateError(errors, "sandbox grant retirement failed");
  }

  /** Release a same-plugin lifecycle lock held by dependency preparation. */
  cancelPendingRestart(pluginId: string): void {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    this.pendingRestartPreparations.delete(canonicalPluginId);
  }

  /** Release all pending per-plugin restarts before queuing a global mutation. */
  cancelAllPendingRestarts(): void {
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    this.pendingRestartPreparations.clear();
  }

  setToolInvocationDelegate(delegate: PluginToolInvocationDelegate): void {
    this.toolInvocationDelegate = delegate;
  }

  clearToolInvocationDelegate(): void {
    this.toolInvocationDelegate = null;
  }

  async call(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.callForPlugin(entry.pluginId, method, payload);
  }

  resolveToolOwner(method: string): string | undefined {
    return this.methodMap.get(method)?.pluginId ?? this.knownToolOwners.get(method);
  }

  assertPluginEventAccess(callerPluginId: string, eventType: string, candidateApprovedPluginAccess?: PluginAccessSpec | null): void {
    assertEventSubscribeAccess({
      callerPluginId,
      eventType,
      targetPluginId: this.inferEventOwner(eventType),
      getAccessGrant: () => candidateApprovedPluginAccess === undefined
        ? this.getPluginAccessGrant(callerPluginId) : candidateApprovedPluginAccess ?? undefined,
      auditLog: this.auditLog,
    });
  }

  assertPluginEventEmitAccess(callerPluginId: string, eventType: string): void {
    assertEventEmitAccess({
      callerPluginId,
      eventType,
      ownerPluginId: this.inferEventOwner(eventType),
      auditLog: this.auditLog,
    });
  }

  // Only trusted-panel origin may use this app-visible bypass; untrusted cards always use governed execution.
  // Enforce the shared tool ceiling here and retain the immutable generation lease until detached handler work settles.
  async callDeclaredAppOnlyTool(
    method: string,
    payload?: unknown,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.globalCeilingMs,
    expectedGenerationId?: string,
    beforeHandler?: () => void,
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(projection.manifest),
      });
      const handler = projection.methods.get(method);
      if (!handler) throw new Error(`Plugin method not found in active generation: ${method}`);
      const auth = projection.manifest.auth;
      const isAuthTool = auth !== undefined && (
        method === auth.statusTool ||
        method === auth.loginTool ||
        method === auth.logoutTool
      );
      this.auditLog?.("info", "plugin_ui_action_invoked", {
        pluginId: entry.pluginId,
        method,
      });
      const outcome = await runWithCeiling(
        async () => {
          // An admitted predecessor may finish ordinary calls but cannot mutate credentials after its generation changes.
          if (
            isAuthTool &&
            this.requireGenerationAccess("plugin auth handler").getActive(entry.pluginId)
              ?.generationId !== generationId
          ) {
            throw new Error("plugin auth generation changed before handler entry");
          }
          // Recheck session and generation revocation after the ceiling task boundary, with no await before dispatch.
          beforeHandler?.();
          return handler(payload);
        },
        ceilingMs,
        undefined,
        method,
      );
      if (!outcome.ok) {
        if (outcome.settlement) {
          throw new PluginRuntimeDetachedOperationError(
            outcome.error,
            outcome.settlement,
          );
        }
        throw outcome.error;
      }
      return outcome.value;
    }, expectedGenerationId, method);
  }

  /** Trusted panel calls require explicit UI invocation permission; embedded cards use callFromApp. */
  async callFromUi(
    method: string,
    payload?: unknown,
    options?: {
      userAction?: boolean;
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      const manifest = projection.manifest;
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(manifest),
      });
      if (!this.toolInvocationDelegate) {
        throw new Error("Plugin tool executor is not wired; UI plugin call denied");
      }
      const authToolKind = method === manifest.auth?.statusTool
        ? "status" as const
        : method === manifest.auth?.loginTool
          ? "login" as const
          : method === manifest.auth?.logoutTool
            ? "logout" as const
            : undefined;
      return this.toolInvocationDelegate(method, payload, {
        origin: "ui",
        ownerPluginId: entry.pluginId,
        ownerGenerationId: generationId,
        ...(authToolKind ? { authToolKind } : {}),
        userAction: options?.userAction === true,
        ...(options?.appSessionId
          ? {
              appInvocation: {
                surface: "trusted-panel" as const,
                sessionId: options.appSessionId,
                ...(options.operationGrantToken ? { operationGrantToken: options.operationGrantToken } : {}),
              },
            }
          : {}),
      });
    }, options?.expectedGenerationId, method);
  }

  // Untrusted cards have mcp-app origin and no userAction; every app-visible call uses governed execution.
  // Deny all manifest auth tools even behind approval: cards must not summon privileged login windows or inherit panel authority.
  async callFromApp(
    method: string,
    payload?: unknown,
    options?: {
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      this.throwIfToolOwnerNotReady(method);
      throw new Error(`Plugin method not found: ${method}`);
    }
    return this.withPinnedGeneration(entry.pluginId, async (projection, generationId) => {
      const manifest = projection.manifest;
      assertAppVisibleToolInvokable({
        method,
        pluginId: entry.pluginId,
        appVisibleTools: declaredAppVisibleToolMethods(manifest),
      });
      const auth = manifest?.auth;
      if (auth && (method === auth.statusTool || method === auth.loginTool || method === auth.logoutTool)) {
        throw new Error(
          `[${MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE}] Tool '${method}' is this plugin's manifest-declared ` +
            `auth tool and is reserved for the plugin's own trusted panel: a card cannot invoke it. ` +
            `auth.loginTool opens a credentialed auth window, and an untrusted card must never be able ` +
            `to summon one, gated or not.`,
        );
      }
      if (!this.toolInvocationDelegate) {
        throw new Error("Plugin tool executor is not wired; MCP App plugin call denied");
      }
      return this.toolInvocationDelegate(method, payload, {
        origin: "mcp-app",
        ownerPluginId: entry.pluginId,
        ownerGenerationId: generationId,
        userAction: false,
        ...(options?.appSessionId
          ? {
              appInvocation: {
                surface: "mcp-app" as const,
                sessionId: options.appSessionId,
                ...(options.operationGrantToken ? { operationGrantToken: options.operationGrantToken } : {}),
              },
            }
          : {}),
      });
    }, options?.expectedGenerationId, method);
  }

  // Relay plugin-served HTML only after own-namespace and declaration checks; never read a plugin-supplied disk path.
  // Use shared runtime admission plus policy timeout and HTML size bounds; refusal serves no body.
  async readUiResource(
    pluginId: string,
    uri: string,
    ceilingMs: number = TOOL_TIMEOUT_POLICY.pluginUiResourceReadMs,
    expectedGenerationId?: string,
  ): Promise<string> {
    // Use the shared runtime admission predicate with card-specific refusal text.
    const refusal = checkRuntimeAdmission(this, pluginId);
    if (refusal === "inactive") {
      throw new Error(
        `Plugin '${pluginId}' is inactive; its ui:// resources are unavailable until the plugin is re-enabled.`,
      );
    }
    if (refusal === "integrity-disabled") {
      throw new Error(
        `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin to re-enable.`,
      );
    }

    const html = await this.withPinnedGeneration(pluginId, async (projection) => {
      const instance = projection.instance;
      const readUiResource = instance.readUiResource;
      if (typeof readUiResource !== "function") {
        throw new Error(
          `Plugin '${pluginId}' declares ui:// resources but does not implement readUiResource(); cannot serve '${uri}'.`,
        );
      }
      const outcome = await runWithCeiling(
        async () => readUiResource.call(instance, uri),
        ceilingMs,
        undefined,
        `${pluginId}.readUiResource`,
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }, expectedGenerationId, `readUiResource(${uri})`);
    if (typeof html !== "string") {
      throw new Error(
        `Plugin '${pluginId}' readUiResource('${uri}') returned ${typeof html}, expected the card HTML as a string.`,
      );
    }
    const bytes = Buffer.byteLength(html, "utf-8");
    if (bytes > MAX_UI_RESOURCE_HTML_BYTES) {
      throw new Error(
        `Plugin '${pluginId}' readUiResource('${uri}') returned ${bytes} bytes, over the ${MAX_UI_RESOURCE_HTML_BYTES}-byte card limit.`,
      );
    }
    return html;
  }

  getMethodMap(): ReadonlyMap<string, { pluginId: string; handler: PluginToolHandler }> {
    return this.methodMap;
  }

  getPerfStats(): Record<string, PluginPerfStats> {
    return this.perf.snapshot();
  }

  /** Test-only injection bypasses lifecycle loading; production callers must use normal admission. */
  _testInjectPlugin(
    pluginId: string,
    toolName: string,
    handler: (payload?: unknown) => Promise<unknown>,
  ): void {
    const stub: LoadedPlugin = {
      activationId: randomUUID(),
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "index.js",
        description: "Test fixture",
        tools: [
          {
            name: toolName,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      },
      pluginRoot: "/tmp/test-inject",
      instance: {} as import("../types.js").RuntimePlugin,
      methods: new Map([[toolName, handler as import("../types.js").PluginToolHandler]]),
      started: true,
      // Injected handlers run in-process without a child.
      arm: "in-process",
      confinement: "not-spawned",
    };
    this.plugins.set(pluginId, stub);
    this.markPluginUiRevision(pluginId);
    this.methodMap.set(toolName, { pluginId, handler: handler as import("../types.js").PluginToolHandler });
    this.perf.ensure(pluginId);
  }

  registerDisposer(pluginId: string, dispose: () => void): void {
    let list = this.disposers.get(pluginId);
    if (!list) {
      list = [];
      this.disposers.set(pluginId, list);
    }
    list.push(dispose);
  }

  isPluginRestartPending(pluginId: string): boolean {
    return this.pendingRestarts.has(this.resolveKnownPluginId(pluginId));
  }

  isPluginUiRevisionCurrent(pluginId: string, revision: number): boolean {
    return this.pluginUiRevisions.get(pluginId) === revision;
  }

  listToolNames(): string[] {
    return [...this.methodMap.keys()].sort();
  }

  listPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  /** Model exposure mirrors enabled !== false; unknown plugins default active without a disk read. */
  isPluginEnabled(pluginId: string): boolean {
    return !this.inactivePluginIds.has(this.resolveKnownPluginId(pluginId));
  }

  /** Session activation is transient and must never mutate registry enablement. */
  private readonly sessionActivation = new SessionActivationTracker();

  isSessionActivated(sessionId: string, pluginId: string): boolean {
    return this.sessionActivation.isActivated(sessionId, pluginId);
  }

  setSessionActivated(sessionId: string, pluginId: string): void {
    this.sessionActivation.activate(sessionId, pluginId);
  }

  /** Clear only the completed session’s activations to avoid stale entries without affecting other sessions. */
  clearSessionActivated(sessionId: string): void {
    this.sessionActivation.clear(sessionId);
  }

  /** Disable drains predecessor leases; enable verifies immutable receipt bytes before atomic registry and generation publication. */
  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // Cancel dependency-held restart work before admission to its canonical lifecycle lock.
    this.cancelPendingRestart(this.resolveKnownPluginId(pluginId));
    return withResolvedPluginInstallLocks(
      () => {
        const canonicalPluginId = this.resolveKnownPluginId(pluginId);
        const installClaim = this.getPluginInstallClaim(canonicalPluginId);
        return [
          pluginId,
          canonicalPluginId,
          ...(typeof installClaim === "string" ? [installClaim] : []),
        ];
      },
      async () => {
        const canonicalPluginId = this.resolveKnownPluginId(pluginId);
        if (
          !this.knownPluginManifests.has(canonicalPluginId)
          && !this.plugins.has(canonicalPluginId)
        ) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }
        const installClaim = this.getPluginInstallClaim(canonicalPluginId);
        if (installClaim === undefined) {
          throw new Error(`Plugin install provenance unknown: ${pluginId}`);
        }
        await assertDisableAllowed(enabled, installClaim, pluginId, this.deploymentGuard);
        const generationLifecycle = this.requireCapabilityCommitLifecycle(
          "plugin enabled-state change",
        );
        await generationLifecycle.runInLifecycleQueue(canonicalPluginId, async () => {
          if (!this.inactivePluginIds.has(canonicalPluginId) === enabled) return;
          const persist = async (): Promise<void> => {
            // Static toggles are session-local; installed toggles persist under the raw registry id.
            if (this.registryPath && installClaim !== null) {
              await updatePluginRegistry(this.registryPath, (registry) => {
                const entry = registry.plugins.find(({ id }) => id === installClaim);
                if (!entry) {
                  throw new Error(`Plugin not found in registry: ${installClaim}`);
                }
                entry.enabled = enabled;
              });
            }
          };

          let retirementError: unknown;
          let unpublishedCleanup: (() => Promise<void>) | undefined;
          if (!enabled) {
            const plugin = this.plugins.get(canonicalPluginId);
            const unpublishedCandidate = plugin && this.isUnpublishedLoadedCandidate(
              canonicalPluginId,
              plugin,
              generationLifecycle,
            )
              ? plugin
              : undefined;
            if (!generationLifecycle.getActive(canonicalPluginId) && !unpublishedCandidate) {
              throw new Error(
                `cannot disable plugin without an active generation: ${canonicalPluginId}`,
              );
            }
            this.assertNoActiveCapabilityDependents(
              canonicalPluginId,
              "disable",
            );
            if (unpublishedCandidate) {
              const commitScope = this.capabilityDependencyCommitScope(() => {
                this.assertNoActiveCapabilityDependents(
                  canonicalPluginId,
                  "disable",
                );
              });
              await commitScope(async () => {
                // Only a committed disabled state cancels the candidate; failed registry transactions leave preparation retryable.
                await persist();
                this.clearCapabilityBlockedRetry(
                  canonicalPluginId,
                  `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
                );
                this.beginPluginLifecycleOperation(canonicalPluginId);
                this.preparation.clearFor(canonicalPluginId);
                try {
                  unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
                    canonicalPluginId,
                    unpublishedCandidate,
                    "unpublished plugin enabled-state disable",
                  );
                } catch (error) {
                  retirementError = error;
                }
              });
            } else {
              this.clearCapabilityBlockedRetry(
                canonicalPluginId,
                `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
              );
              this.beginPluginLifecycleOperation(canonicalPluginId);
              this.preparation.clearFor(canonicalPluginId);
              const { retirement } = await generationLifecycle.deactivateWithCommit(
                canonicalPluginId,
                persist,
                this.capabilityDependencyCommitScope(() => {
                  this.assertNoActiveCapabilityDependents(
                    canonicalPluginId,
                    "disable",
                  );
                }),
              );
              retirementError = await this.captureCommittedRetirementFailure(
                canonicalPluginId,
                retirement,
                "plugin enabled-state disable",
              );
            }
            this.inactivePluginIds.add(canonicalPluginId);
            this.disabledPluginIds.add(canonicalPluginId);
            if (unpublishedCleanup) {
              try {
                await unpublishedCleanup();
              } catch (error) {
                retirementError = retirementError === undefined
                  ? error
                  : new AggregateError(
                      [
                        retirementError instanceof Error
                          ? retirementError
                          : new Error(String(retirementError)),
                        error instanceof Error ? error : new Error(String(error)),
                      ],
                      `plugin '${canonicalPluginId}' committed disable cleanup failed`,
                    );
              }
            }
          } else {
            if (generationLifecycle.getActive(canonicalPluginId)) {
              throw new Error(
                `cannot re-enable plugin while a generation is active: ${canonicalPluginId}`,
              );
            }
            if (!this.installReceiptCacheRoot) {
              throw new Error("plugin re-enable requires installReceiptCacheRoot");
            }
            const loadPlan = await this.resolveManifestLoadPlanInternal();
            const targetPlan = loadPlan.find((plan) =>
              plan.pluginIdHint === canonicalPluginId
              || (installClaim !== null && plan.pluginIdHint === installClaim)
              || this.matchesManifestPath(plan.manifestPath, canonicalPluginId)
            );
            if (!targetPlan) {
              throw new Error(`Plugin not found in registry: ${canonicalPluginId}`);
            }
            const manifest = await this.readManifest(targetPlan.manifestPath);
            if (manifest.id !== canonicalPluginId) {
              throw new Error(
                `plugin re-enable manifest identity changed: expected ${canonicalPluginId}, got ${manifest.id}`,
              );
            }
            const pluginRoot = dirname(targetPlan.manifestPath);
            const receiptPluginId = installClaim ?? canonicalPluginId;
            const integrity = await this.verifyReceiptAndDevGuard(receiptPluginId, pluginRoot);
            if (!integrity.ok) {
              throw new Error(
                `plugin re-enable receipt verification failed: ${canonicalPluginId}`,
              );
            }
            this.assertEnabledCapabilityDependencies(manifest);
            const receiptRaw = await readFile(
              installReceiptPath(this.installReceiptCacheRoot, receiptPluginId),
              "utf8",
            );
            await this.activatePreparedArtifact({
              installId: receiptPluginId,
              pluginRoot,
              manifest,
              receiptRaw,
              // Preserve origin trust so re-enabled official plugins retain their host-secret grant.
              registryEntry: {
                installSource: targetPlan.installSource,
                manifestSha256: targetPlan.manifestSha256,
                ...(targetPlan.origin ? { origin: targetPlan.origin } : {}),
              },
              approvedPluginAccess:
                targetPlan.approvedPluginAccess
                ?? this.knownPluginAccessGrants.get(canonicalPluginId),
              durableCommit: persist,
            });
            this.inactivePluginIds.delete(canonicalPluginId);
            this.disabledPluginIds.delete(canonicalPluginId);
          }

          // After commit, align runtime state despite projection faults; later requests queue behind the callback.
          let callbackError: unknown;
          try {
            await this.onActiveStateChange?.(canonicalPluginId, enabled);
          } catch (error) {
            callbackError = error;
          }
          if (retirementError !== undefined && callbackError !== undefined) {
            throw new AggregateError(
              [
                retirementError instanceof Error
                  ? retirementError
                  : new Error(String(retirementError)),
                callbackError instanceof Error
                  ? callbackError
                  : new Error(String(callbackError)),
              ],
              `plugin '${canonicalPluginId}' committed disable cleanup failed`,
            );
          }
          if (retirementError !== undefined) throw retirementError;
          if (callbackError !== undefined) throw callbackError;
        });
      },
      (pluginIds) => {
        for (const discoveredPluginId of pluginIds) {
          this.cancelPendingRestart(discoveredPluginId);
        }
      },
    );
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest ?? this.knownPluginManifests.get(pluginId);
  }

  /** Canonical lifecycle identity for a marketplace/install alias. */
  resolvePluginId(pluginId: string): string {
    return this.resolveKnownPluginId(pluginId);
  }

  /** Raw registry identity for a canonical/alias plugin id; null for static roots. */
  resolvePluginInstallId(pluginId: string): string | null {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const installClaim = this.getPluginInstallClaim(canonicalPluginId);
    if (installClaim === undefined) {
      throw new Error(`Plugin install provenance unknown: ${pluginId}`);
    }
    return installClaim;
  }

  /** Registry/static provenance when known; undefined for a fresh identity. */
  resolvePluginInstallIdIfKnown(
    pluginId: string,
  ): string | null | undefined {
    return this.getPluginInstallClaim(this.resolveKnownPluginId(pluginId));
  }

  /** Final uninstall cleanup after stop-hook mutations have drained. */
  clearConfigOverride(pluginId: string): void {
    this.configStore.delete(this.resolveKnownPluginId(pluginId));
  }

  getApprovedPluginAccess(pluginId: string): PluginAccessSpec | undefined {
    return this.plugins.get(pluginId)?.approvedPluginAccess ?? this.knownPluginAccessGrants.get(pluginId);
  }

  private getPluginAccessGrant(pluginId: string): PluginAccessSpec | undefined {
    return this.getApprovedPluginAccess(pluginId);
  }

  listPluginCards(toolRegistry?: { getModelVisibleTools(): Array<{ name: string }> }): PluginCard[] {
    // Cards require model-visible tools; executable app-only tools must not enter the catalog list.
    const visibleNames = toolRegistry
      ? new Set(toolRegistry.getModelVisibleTools().map((t) => t.name))
      : null;
    const cards = new Map<string, PluginCard>();
    for (const [pluginId, manifest] of this.knownPluginManifests) {
      const runtimeLoaded = this.plugins.has(pluginId);
      const enabled = !this.inactivePluginIds.has(pluginId);
      // Loaded candidates remain inactive until their generation publishes.
      const active = enabled && this.isPluginGenerationActive(pluginId);
      const loadStatus = this.preparation.isPreparing(pluginId)
        || this.capabilityBlockedPluginIds.has(pluginId)
        ? "preparing"
        // Disabled cards report runtimeLoaded false while retaining the settings switch needed to re-enable them.
        : !enabled
          ? "disabled"
          : runtimeLoaded
          ? "loaded"
          : this.failedPluginIds.has(pluginId)
          ? "failed"
          : this.disabledPluginIds.has(pluginId)
            ? "disabled"
            : null;
      if (!loadStatus) continue;
      const card = buildPluginCard(pluginId, manifest, loadStatus, visibleNames, {
        active,
        runtimeLoaded,
      }, {
        preparationStatus: this.preparation.getStatus(pluginId),
        installAliases: this.getPluginInstallAliases(pluginId),
      });
      // Retain later-phase load classification so the settings UI can offer the appropriate repair.
      if (loadStatus === "failed") {
        const info = this.loadFailureInfo.get(pluginId);
        if (info?.installFailureKind) card.installFailureKind = info.installFailureKind;
        if (info?.installFailureMessage) card.installFailureMessage = info.installFailureMessage;
        // Factory arm and confinement exist only if the failed construction reached routing.
        if (info?.arm) card.arm = info.arm;
        if (info?.confinement) card.confinement = info.confinement;
      }
      // Report the generation actually serving, independent of model exposure.
      const loaded = this.plugins.get(pluginId);
      if (loaded) {
        card.arm = loaded.arm;
        card.confinement = loaded.confinement;
      }
      // A refused replacement is attempt state; the incumbent stays loaded.
      const refusal = this.lastAttemptRefusal.get(pluginId);
      if (loadStatus === "loaded" && refusal) card.lastAttemptRefusal = { ...refusal };
      cards.set(pluginId, card);
    }
    for (const [pluginId, stub] of this.failedPluginStubs) {
      if (cards.has(pluginId)) continue;
      // Even unparsed manifests need classified stub cards for reinstall repair.
      const info = this.loadFailureInfo.get(pluginId);
      cards.set(pluginId, {
        id: pluginId,
        name: stub.name,
        description: stub.description,
        sampleTools: [],
        tools: [],
        capabilities: [],
        loadStatus: "failed",
        active: false,
        runtimeLoaded: false,
        ...(info?.installFailureKind ? { installFailureKind: info.installFailureKind } : {}),
        ...(info?.installFailureMessage ? { installFailureMessage: info.installFailureMessage } : {}),
        ...(info?.arm ? { arm: info.arm } : {}),
        ...(info?.confinement ? { confinement: info.confinement } : {}),
      });
    }
    return [...cards.values()];
  }

  listPluginManifests(): Array<{ pluginId: string; manifest: PluginManifest }> {
    const result: Array<{ pluginId: string; manifest: PluginManifest }> = [];
    for (const pluginId of this.preparation.preparingIds()) {
      const manifest = this.knownPluginManifests.get(pluginId);
      if (manifest) result.push({ pluginId, manifest });
    }
    for (const [pluginId, plugin] of this.plugins) {
      result.push({ pluginId, manifest: plugin.manifest });
    }
    return result;
  }

  listPluginIdsByCapability(capability: string): string[] {
    const result: string[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.manifest.capabilities?.includes(capability)) {
        result.push(pluginId);
      }
    }
    return result;
  }

  getPluginEntryDir(pluginId: string): string | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    // Process entries have no module path for the development watcher.
    if (plugin.manifest.process !== undefined) return undefined;
    try {
      const entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, plugin.manifest.entry);
      return dirname(entryPath);
    } catch {
      return undefined;
    }
  }

  getPluginRoot(pluginId: string): string | undefined {
    return this.plugins.get(pluginId)?.pluginRoot;
  }

  // Webview storage shares host containment checks; unknown ids remain unknown-plugin-id.
  // The mandatory shared audit sink records refusals that would otherwise leave no host-side trace.
  getPluginStorage(pluginId: string): import("../types.js").PluginStorage | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    const audit = createPluginStorageAuditSink(pluginId, (...a) => this.auditLog?.(...a));
    // Storage IPC must resolve without creating directories so an install swap cannot produce a new path under the old root.
    return createPluginStorage(
      pluginId,
      resolvePluginHostStorageDir(this.resolveDataDir(pluginId, plugin.pluginRoot)),
      this.encryption,
      audit,
    );
  }

  /** Floating admission must validate the declared surface before host window creation; preserve distinct refusal codes for invalid declarations and transient runtime state. */
  resolveFloatingSurface(
    pluginId: string,
    extensionId: string,
  ): ResolvedFloatingSurface | FloatingDockErrorCode {
    // Use registered runtime state for both loader arms; floating admission must not depend on the process location.
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return "unknown-plugin";
    const extension = (plugin.manifest.ui ?? []).find((candidate) => candidate.id === extensionId);
    if (!extension) return "surface-not-declared";

    // The dock imports module entry URLs; unsupported declaration kinds have nothing the shell can render.
    if (extension.slot !== "floating") return "surface-not-floating";
    if (extension.kind !== "embedded-module") return "surface-not-floating";

    // Require entry and exportName even though manifest validation also enforces them, preserving a specific refusal reason.
    const entrySource = extension.entry ?? extension.page;
    if (!entrySource) return "surface-has-no-entry";

    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, entrySource);
    } catch (err) {
      // Single-surface lookup must report containment failure instead of silently skipping it as list enumeration does.
      log.warn(`floating ui entry rejected for '${pluginId}': ${(err as Error).message}`);
      this.auditLog?.("error", "plugin_ui_entry_path_rejected", {
        pluginId,
        entry: entrySource,
        reason: (err as Error).message,
      });
      return "surface-entry-rejected";
    }

    return {
      pluginId,
      extensionId: extension.id,
      entryUrl: this.buildPluginUiEntryUrl(pluginId, plugin.manifest, entryPath),
      // Render plugin titles as text, and re-resolve host placeholders when the UI language changes.
      title: getPluginViewTitle(extension, getLocale()) ?? pluginId,
    };
  }

  listUiExtensions(): Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> {
    const result: Array<{ pluginId: string; icon?: string; iconText?: string; extension: PluginUiExtension; entryUrl?: string; runtimeRevision?: number }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      const runtimeRevision = this.getPluginUiRevision(pluginId);
      for (const extension of plugin.manifest.ui ?? []) {
        // Sidebar enumeration excludes floating surfaces; the dock resolves its own slot separately.
        if (extension.slot !== "sidebar") continue;
        const entrySource = extension.entry ?? extension.page;
        let entryPath: string | undefined;
        if (entrySource) {
          try {
            entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, entrySource);
          } catch (err) {
            log.warn(
              `ui entry rejected for '${pluginId}': ${(err as Error).message}`,
            );
            this.auditLog?.("error", "plugin_ui_entry_path_rejected", {
              pluginId,
              entry: entrySource,
              reason: (err as Error).message,
            });
            continue;
          }
        }
        result.push({
          pluginId,
          icon: plugin.manifest.icon,
          iconText: plugin.manifest.iconText,
          extension,
          entryUrl: entryPath ? this.buildPluginUiEntryUrl(pluginId, plugin.manifest, entryPath) : undefined,
          runtimeRevision,
        });
      }
    }
    return result;
  }

  async callForPlugin(
    pluginId: string,
    method: string,
    payload?: unknown,
    expectedGenerationId?: string,
  ): Promise<unknown> {
    this.throwIfToolOwnerNotReady(method);
    this.throwIfPluginNotStarted(pluginId);
    return this.withPinnedGeneration(pluginId, async (projection) => {
      const handler = projection.methods.get(method);
      if (!handler) throw new Error(`Plugin method not found in active generation: ${method}`);
      const stats = this.perf.beginCall(pluginId);
      const t0 = Date.now();
      try {
        return await handler(payload);
      } catch (err) {
        stats.errorCount += 1;
        throw err;
      } finally {
        stats.totalExecMs += Date.now() - t0;
      }
    }, expectedGenerationId, method);
  }

  getPluginOperationAccountIdentity(
    pluginId: string,
    generationId: string,
  ): {
    readonly identityHash: string;
    readonly principalHash: string;
  } | undefined {
    const identity = this.pluginAccountHashes.get(`${pluginId}\0${generationId}`);
    return identity ? { ...identity } : undefined;
  }

  /** Auth tools use a host-only operation identity, never the cached account identity used by ordinary tools. */
  getPluginAuthOperationAccount(
    pluginId: string,
    generationId: string,
    toolName: string,
    appSessionId: string,
  ): PluginAuthOperationAccount | undefined {
    const active = this.requireGenerationAccess("plugin auth operation account")
      .getActive(pluginId);
    if (!active || active.generationId !== generationId) return undefined;
    const auth = active.manifest.auth;
    if (
      !auth ||
      (
        toolName !== auth.statusTool &&
        toolName !== auth.loginTool &&
        toolName !== auth.logoutTool
      )
    ) {
      return undefined;
    }
    const key = `${pluginId}\0${generationId}`;
    const currentAccount = this.pluginAccountHashes.get(key);
    const retainedTransitionAccount = this.pluginAuthTransitionPrincipals.get(pluginId);
    const accountTransitionScopeHash =
      currentAccount?.identityHash ??
      retainedTransitionAccount?.identityHash ??
      fallbackPluginAuthTransitionScope(pluginId);
    return pluginAuthOperationAccount(
      pluginId,
      generationId,
      appSessionId,
      accountTransitionScopeHash,
    );
  }

  /** Claim auth publication order before execution; starting login or logout immediately removes current authority. */
  beginPluginAuthInvocation(
    pluginId: string,
    generationId: string,
    toolName: string,
    appSessionId?: string,
  ): PluginAuthInvocation | undefined {
    const active = this.requireGenerationAccess("plugin auth invocation").getActive(pluginId);
    if (!active || active.generationId !== generationId) return undefined;
    const auth = active.manifest.auth;
    if (
      !auth ||
      (
        toolName !== auth.statusTool &&
        toolName !== auth.loginTool &&
        toolName !== auth.logoutTool
      )
    ) {
      return undefined;
    }
    const epoch = ++this.nextPluginAuthInvocationEpoch;
    const key = `${pluginId}\0${generationId}`;
    const transitionKey = pluginId;
    this.pluginAuthInvocationEpochs.set(key, epoch);
    const currentAccount = this.pluginAccountHashes.get(key);
    const retainedTransitionAccount =
      this.pluginAuthTransitionPrincipals.get(transitionKey);
    const failurePrincipal = currentAccount
      ? { principalHash: currentAccount.principalHash, generationId }
      : retainedTransitionAccount
        ? {
            principalHash: retainedTransitionAccount.principalHash,
            generationId: retainedTransitionAccount.generationId,
          }
        : undefined;
    if (failurePrincipal) {
      this.pluginAuthFailurePrincipals.set(
        `${key}\0${epoch}`,
        failurePrincipal,
      );
    }
    const accountTransitionScopeHash =
      currentAccount?.identityHash ??
      retainedTransitionAccount?.identityHash ??
      fallbackPluginAuthTransitionScope(pluginId);
    const operationAccount = pluginAuthOperationAccount(
      pluginId,
      generationId,
      appSessionId,
      accountTransitionScopeHash,
    );
    if (toolName !== auth.loginTool && toolName !== auth.logoutTool) {
      return { epoch, accountTransitionScopeHash, operationAccount };
    }
    if (currentAccount) {
      this.pluginAuthTransitionPrincipals.set(
        transitionKey,
        { ...currentAccount, generationId },
      );
    }
    const invalidatedAccount = authInvalidation(
      currentAccount,
      generationId,
      retainedTransitionAccount,
    );
    this.pluginAccountHashes.delete(key);
    return invalidatedAccount
      ? {
          epoch,
          accountTransitionScopeHash,
          operationAccount,
          ...invalidatedAccount,
        }
      : { epoch, accountTransitionScopeHash, operationAccount };
  }

  /**
   * Observe only manifest-declared auth tools after a successful invocation.
   * The account hash is derived exclusively from statusTool output; login and
   * logout results cannot mint or restore write authority.
   */
  observePluginAuthResult(
    pluginId: string,
    generationId: string,
    toolName: string,
    result: unknown,
    invocationEpoch: number | undefined,
  ): PluginAuthObservation {
    const active = this.requireGenerationAccess("plugin auth result observation").getActive(pluginId);
    if (!active || active.generationId !== generationId) return {};
    const manifest = active.manifest;
    const auth = manifest?.auth;
    if (!auth) return {};
    const key = `${pluginId}\0${generationId}`;
    if (invocationEpoch !== undefined) {
      this.pluginAuthFailurePrincipals.delete(`${key}\0${invocationEpoch}`);
    }
    if (
      (toolName === auth.statusTool || toolName === auth.logoutTool) &&
      (
        invocationEpoch === undefined ||
        this.pluginAuthInvocationEpochs.get(key) !== invocationEpoch
      )
    ) {
      return {};
    }
    if (
      invocationEpoch !== undefined &&
      this.pluginAuthInvocationEpochs.get(key) === invocationEpoch
    ) {
      this.pluginAuthPublishedEpochs.set(key, invocationEpoch);
    }
    if (toolName === auth.logoutTool) {
      const invalidatedAccount = authInvalidation(
        this.pluginAccountHashes.get(key),
        generationId,
        undefined,
      );
      this.pluginAccountHashes.delete(key);
      return invalidatedAccount ?? {};
    }
    if (toolName !== auth.statusTool) return {};
    const outer = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : undefined;
    const nested = outer?.data && typeof outer.data === "object" && !Array.isArray(outer.data)
      ? outer.data as Record<string, unknown>
      : outer;
    const retainedTransitionAccount =
      this.pluginAuthTransitionPrincipals.get(pluginId);
    if (nested?.authenticated !== true || typeof nested.account !== "string" || !nested.account.trim()) {
      const currentAccount = this.pluginAccountHashes.get(key);
      const invalidatedAccount = authInvalidation(
        currentAccount,
        generationId,
        retainedTransitionAccount,
      );
      this.pluginAccountHashes.delete(key);
      return invalidatedAccount ?? {};
    }
    const identityHash = pluginAccountIdentityHash(nested.account);
    const existing = this.pluginAccountHashes.get(key);
    if (existing?.identityHash === identityHash) {
      this.pluginAuthTransitionPrincipals.set(pluginId, {
        ...existing,
        generationId,
      });
      return {};
    }
    const principalHash = pluginAccountPrincipalHash(identityHash, randomUUID());
    const nextAccount = { identityHash, principalHash };
    this.pluginAccountHashes.set(key, nextAccount);
    this.pluginAuthTransitionPrincipals.set(pluginId, {
      ...nextAccount,
      generationId,
    });
    return authInvalidation(existing, generationId, retainedTransitionAccount) ?? {};
  }

  /** Failed auth transitions clear stale authority before releasing their lease to queued governed work. */
  invalidateFailedPluginAuthInvocation(
    pluginId: string,
    generationId: string,
    invocationEpoch: number,
  ): PluginAuthObservation {
    const key = `${pluginId}\0${generationId}`;
    const failurePrincipal = this.pluginAuthFailurePrincipals.get(
      `${key}\0${invocationEpoch}`,
    );
    this.pluginAuthFailurePrincipals.delete(`${key}\0${invocationEpoch}`);
    if (!failurePrincipal) return {};
    // Only a later completed auth result supersedes failure; a later started status may still be queued.
    if ((this.pluginAuthPublishedEpochs.get(key) ?? -1) > invocationEpoch) {
      return {};
    }
    const current = this.pluginAccountHashes.get(key);
    const retained = this.pluginAuthTransitionPrincipals.get(pluginId);
    const currentMatches =
      current?.principalHash === failurePrincipal.principalHash &&
      failurePrincipal.generationId === generationId;
    const retainedMatches =
      retained?.principalHash === failurePrincipal.principalHash &&
      retained.generationId === failurePrincipal.generationId;
    if (!currentMatches && !retainedMatches) return {};
    if (currentMatches && current) {
      this.pluginAuthTransitionPrincipals.set(pluginId, {
        ...current,
        generationId,
      });
      this.pluginAccountHashes.delete(key);
    }
    return {
      invalidatedAccountHash: failurePrincipal.principalHash,
      invalidatedAccountGenerationId: failurePrincipal.generationId,
    };
  }

  clearPluginOperationAccount(pluginId: string): void {
    for (const key of this.pluginAccountHashes.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAccountHashes.delete(key);
    }
    for (const key of this.pluginAuthInvocationEpochs.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthInvocationEpochs.delete(key);
    }
    for (const key of this.pluginAuthPublishedEpochs.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthPublishedEpochs.delete(key);
    }
    for (const key of this.pluginAuthFailurePrincipals.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.pluginAuthFailurePrincipals.delete(key);
    }
    this.pluginAuthTransitionPrincipals.delete(pluginId);
  }

}
