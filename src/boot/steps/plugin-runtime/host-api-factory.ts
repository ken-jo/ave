import { requireDesktopHost, type BootHost } from "../../host-runtime.js";
/** Resolve runtime bindings lazily; effect-wrapper order and the single HTTP-verb read are security invariants. */
import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { normalizeAllowedHosts, urlHostMatchesAllowList } from "../../../main/host-allow-list.js";
import type { AuthRedirectCatchers } from "../../../main/auth-redirect-catcher.js";
import { resolveMappedDriveRoot } from "../../../main/host-api/mapped-drive-root.js";
import { AudioCaptureService } from "../../../main/audio-capture.js";
import type {
  AlertInput,
  AlertResult,
  AttachFloatingPanelRequest,
  AudioCaptureRequest,
} from "../../../plugins/public-contract.js";
import { FloatingDock } from "../../../main/floating-dock.js";
import { onLocaleChange } from "../../../i18n/index.js";
import { CREDENTIAL_HEADERS, evaluateHostFetch, runHostFetchHops, type HostFetchTransport } from "../../../main/host-fetch-guard.js";
import {
  partitionCookieHeaderForUrl,
  partitionCookiesForUrl,
} from "../../../main/auth-partition-cookie-jar.js";
import type { AuditLogger } from "../../../audit/audit-logger.js";
import type { PluginRuntime } from "../../../plugins/runtime.js";
import { instrumentEffectsByPath } from "../../../permissions/hostapi-effect-recorder.js";
import { enforceMutatingEffects, gateMutatingEffect, snapshotEffectArguments, assertSnapshotableRequestBody } from "../../../permissions/effect-enforcement.js";
import { recordEffect } from "../../../permissions/effect-ledger.js";
import { methodEffect } from "../../../permissions/effect-kind.js";
import type { PluginAccessSpec, PluginRegistryTrust } from "../../../plugins/types.js";
import type { PluginHostApiIncarnation } from "../../../plugins/runtime/index.js";
import {
  createPluginStorage,
  createPluginStorageAuditSink,
  type PluginStorageAuditLog,
} from "../../../plugins/storage.js";
import { resolvePluginHostStorageDir } from "../../../plugins/plugin-storage-layout.js";
import {
  isPluginInstallLockHeld,
  withPluginInstallLock,
} from "../../../plugins/install-lifecycle.js";
import { probePrivateHost } from "../../../plugins/private-host-probe.js";
import { shouldBlockPluginSecretRead } from "../../../plugins/secret-shape.js";
import {
  canEmitEvent,
  CAPABILITY_EXTERNAL_AUTH_CONSUMER,
  CAPABILITY_RAW_API_KEY,
} from "../../../plugins/capabilities.js";
import { appVersionSatisfiesMin } from "../../../shared/semver-compare.js";
import { auditPluginEmitDenial } from "../../../plugins/emit-denial-audit.js";
import { getDeclaredEmittedEvents, manifestDocumentSha256 } from "../../../plugins/runtime/manifest-validation.js";
import { canonicalJSON } from "../../../plugins/secret-access/canonical-json.js";
import { effectivePluginConfig } from "../../../plugins/effective-config.js";
import { shouldRestartAfterPluginConfigWrite } from "../../../plugins/config-restart-policy.js";
import { OVERLAY_V1, WORK_BOARD } from "../../../shared/ipc-channels.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
} from "../../../plugins/config-change-bus.js";
import type {
  ApprovalChoice,
  AuthPartitionCookie,
  AuthWindowCookie,
  ConversationTriggerSpec,
  OpenAuthWindowBaseOptions,
  OpenAuthWindowFinalUrlResult,
  PluginHostApi,
  PluginManifest,
} from "../../../plugins/types.js";
import type { SettingsService } from "../../../data/settings-store.js";
import type { RoutinesStore } from "../../../main/routines-store.js";
import type { WorkBoardStore } from "../../../main/work-board-store.js";
import { emitEvent, onEvent } from "../../types.js";
import { t } from "../../../i18n/index.js";
import { createLogger } from "../../../lib/logger.js";
import { logPluginLifecycle, PluginPhase } from "../../../plugins/lifecycle-log.js";
import { incrementHostSecretCounter, sanitizeKeyPrefix } from "../../../telemetry/host-secret-counters.js";
import type { HostSecretGrantEvidence } from "../../../plugins/secret-access/grants.js";
import { runSecretGate } from "../../../plugins/secret-access/secret-gate.js";
import { CredentialLeaseRegistry, CredentialLeaseError, type CredentialScheme } from "../../../plugins/secret-access/credential-lease-registry.js";
import { LeaseDenialAudit } from "../../../plugins/secret-access/lease-denial-audit.js";
import { HostApiBoundaryError, validateWireAuth } from "../../../plugins/isolation/host-api-wire.js";
import type { GrantEvidenceReader } from "./grant-evidence.js";
import {
  resolveApiKey as resolveApiKeyImpl,
  apiKeyIdentities,
  normalizeVendor,
  type CredentialIssuanceStage,
  type ResolveApiKeyPurpose,
  type ResolveApiKeyVendor,
} from "../../../main/host-api/resolve-api-key.js";
import {
  verifyApprovalRequestScope,
  verifyApprovalResponder,
} from "../../../permissions/agent-action-requester.js";
import { spawnWorker } from "../../../permissions/worker-spawn.js";
import { declaredHostDirectoryFloorPierces } from "../../../plugins/sandbox-authority.js";
import { approvalIssuerRegistry, auditApprovalViolation } from "./approval-gating.js";
import { routeExternalUrl } from "./external-url.js";
import {
  deriveOverlaySummaryForDisplay,
  evaluateTriggerSpec,
  formatPluginPendingPrompt,
  triggerConversationDedupe,
  triggerConversationRateLimiter,
  triggerDenyAuditThrottle,
  TriggerConversationRateLimiter,
} from "./trigger-gate.js";
import {
  getDeclaredSuggestionSources,
  getDeclaredWorkProposalKinds,
} from "../../../plugins/runtime/manifest-validation.js";
import { suggestionLedger } from "../../../alerts/suggestion-ledger.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import type { AlertsService } from "../../../alerts/service.js";
import { alertEventReaches, isAlertEvent } from "../../../alerts/events.js";
import type {
  WorkProposalChangedEventPayload,
  WorkProposalInput,
  WorkProposalResult,
} from "../../../shared/work-board-types.js";
import type { LateBindingRefs } from "../plugin-runtime.js";
import { proposalId } from "../../../work-board/board-file.js";
import { errorMessage } from "../../../shared/error-message.js";
import { resolvePluginDisplayName } from "../../../shared/plugin-provenance.js";

const log = createLogger("ave");

/** Proposal churn has its own rate bucket so upserts cannot consume overlay-trigger capacity. */
const workProposalRateLimiter = new TriggerConversationRateLimiter();

function assertActiveHostApi(
  pluginId: string,
  incarnation: PluginHostApiIncarnation,
  memberPath: string,
): void {
  if (incarnation.isActive()) return;
  throw new Error(
    `[plugin:${pluginId}] ${memberPath}: plugin instance is no longer active`,
  );
}

/** Revoke every callable surface of an obsolete HostApi incarnation. */
function enforceActiveHostApi(
  pluginId: string,
  incarnation: PluginHostApiIncarnation,
  hostApi: PluginHostApi,
): PluginHostApi {
  const proxies = new WeakMap<object, object>();
  const wrap = (target: object, path: string): object => {
    const existing = proxies.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(currentTarget, property, receiver) {
        const value = Reflect.get(currentTarget, property, receiver) as unknown;
        const memberPath = `${path}.${String(property)}`;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            assertActiveHostApi(pluginId, incarnation, memberPath);
            const result = Reflect.apply(value, currentTarget, args) as unknown;
            if (
              memberPath !== "hostApi.config.set"
              && result !== null
              && typeof result === "object"
              && typeof (result as PromiseLike<unknown>).then === "function"
            ) {
              return incarnation.trackOperation(Promise.resolve(result));
            }
            return result;
          };
        }
        if (value !== null && typeof value === "object") {
          return wrap(value, memberPath);
        }
        return value;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return wrap(hostApi, "hostApi") as PluginHostApi;
}

/** Create one capture service lazily; unused installations must not install display-media handlers. */
let sharedAudioCaptureService: AudioCaptureService | null = null;
function audioCaptureService(host: BootHost): AudioCaptureService {
  sharedAudioCaptureService ??= new AudioCaptureService(requireDesktopHost(host).createAudioCaptureSurface());
  return sharedAudioCaptureService;
}

/** Create one dock lazily and resolve its surface through the runtime getter after binding. */
let sharedFloatingDock: FloatingDock | null = null;
function floatingDock(host: BootHost, getPluginRuntime: () => PluginRuntime): FloatingDock {
  if (!sharedFloatingDock) {
    const dock = new FloatingDock(
      requireDesktopHost(host).createFloatingDockSurface(),
      (pluginId, extensionId) => getPluginRuntime().resolveFloatingSurface(pluginId, extensionId),
    );
    // Locale changes rerun full surface lookup, including entry containment checks and refusal audits.
    onLocaleChange(() => dock.refreshTitles());
    sharedFloatingDock = dock;
  }
  return sharedFloatingDock;
}

/** The dock, if one was ever built. Shutdown and the dock's IPC use it. */
export function peekFloatingDock(): FloatingDock | null {
  return sharedFloatingDock;
}

export interface CreateHostApiFactoryDeps {
  host: BootHost;
  /** Getter for the mutable `pluginRuntime` binding (assigned after this factory is built). */
  getPluginRuntime: () => PluginRuntime;
  lateBinding: LateBindingRefs;
  getRegistryEntry: (
    pluginId: string,
  ) => PluginRegistryTrust | undefined;
  /** Re-read the registry into `getRegistryEntry` when the file changed since the last read. */
  refreshRegistryEntryCacheIfChanged: () => Promise<void>;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  readAppPreference: (pluginId: string, key: string) => unknown;
  settingsService: SettingsService;
  bootAuditLogger: AuditLogger;
  leaseDenialAudit?: LeaseDenialAudit;
  _onCredentialIssuanceStageForTest?: (stage: CredentialIssuanceStage) => Promise<void> | void;
  /** Reuse runtime audit transport so host and webview storage refusals share one record shape. */
  pluginRuntimeAuditLog: PluginStorageAuditLog;
  networkFetch: HostFetchTransport;
  /** Boot-captured fallback only; use getMainWindow for live targeting after windows reopen. */
  mainWindow: BrowserWindow | null;
  /** Optional in minimal hosts; production resolves the live main window. */
  getMainWindow?: () => BrowserWindow | null;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean },
  ) => Promise<AuthWindowCookie[] | OpenAuthWindowFinalUrlResult>;
  openLinkWindowService: (
    parent: BrowserWindow,
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  openAuthPartitionViewerService: (
    parent: BrowserWindow,
    opts: import("../../../main/auth-partition-viewer-service.js").OpenAuthPartitionViewerOptions,
  ) => Promise<void>;
  clearAuthPartitionService: (partition: string) => Promise<void>;
  /** Share redirect catchers across plugins within one runtime; isolate registries between hosts. */
  authRedirectCatchers: AuthRedirectCatchers;
  shellOpenExternal: (url: string) => Promise<void>;
  approvalGate: import("../../../permissions/approval-gate.js").ApprovalGate;
  permissionManager?: import("../../../permissions/permission-manager.js").PermissionManager;
  routinesStore: RoutinesStore;
  /** Resolve Work Board storage late; absence at plugin start is a boot-order error. */
  getWorkBoardStore: () => WorkBoardStore | undefined;
  /** Minimal hosts may omit alerts; raiseAlert then fails loudly. */
  getAlertsService: () => AlertsService | undefined;
  /** Create and promote the Suggestions conversation before staging its card. */
  stageInSuggestionsSession: () => void;
  /** Host-secret evidence contract: marketplace design, host-secret grant conditions. */
  grantEvidence: GrantEvidenceReader;
}

/** Invoked once per plugin during startAll. */
export function createHostApiFactory(
  deps: CreateHostApiFactoryDeps,
): (
  pluginId: string,
  manifest: PluginManifest,
  pluginDataDir: string,
  incarnation: PluginHostApiIncarnation,
  installPluginId: string | null,
  candidateRegistryEntry?: Readonly<
    PluginRegistryTrust
  >,
  candidateApprovedPluginAccess?: PluginAccessSpec | null,
) => PluginHostApi {
  const {
    getPluginRuntime,
    lateBinding,
    getRegistryEntry,
    refreshRegistryEntryCacheIfChanged,
    pluginShutdownHandlers,
    readAppPreference,
    settingsService,
    bootAuditLogger,
    pluginRuntimeAuditLog,
    networkFetch,
    mainWindow,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    authRedirectCatchers,
    shellOpenExternal,
    approvalGate,
    permissionManager,
    routinesStore,
    getWorkBoardStore,
    getAlertsService,
    stageInSuggestionsSession,
    grantEvidence,
  } = deps;
  const credentialRegistry = new CredentialLeaseRegistry(
    settingsService,
    (pluginId) => permissionManager?.getPluginRevokeEpoch(pluginId) ?? 0,
  );
  const leaseDenialAudit = deps.leaseDenialAudit ?? new LeaseDenialAudit(bootAuditLogger);

  /** Resolve the current window on every send; null means no desktop surface. */
  const liveMainWindow = (): BrowserWindow | null => getMainWindow ? getMainWindow() : mainWindow;
  const requireMainWindow = (): BrowserWindow => {
    const win = liveMainWindow();
    if (!win || win.isDestroyed()) throw new Error("Host UI requires an active main window");
    return win;
  };

  return (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
    installPluginId: string | null,
    candidateRegistryEntry?: Readonly<
      PluginRegistryTrust
    >,
    candidateApprovedPluginAccess?: PluginAccessSpec | null,
  ): PluginHostApi => {
    // Resolve the runtime once per plugin incarnation, after assignment.
    const pluginRuntime = getPluginRuntime();
    const getApprovedPluginAccess = (): PluginAccessSpec | undefined =>
      candidateApprovedPluginAccess === undefined
        ? pluginRuntime.getApprovedPluginAccess(pluginId)
        : candidateApprovedPluginAccess ?? undefined;
    if (installPluginId === undefined) {
      throw new Error(`HostApi install provenance missing: ${pluginId}`);
    }
    // Refresh registry evidence; candidates may use only the same install’s origin, never another source’s.
    const readRegistryEntry = async (): Promise<PluginRegistryTrust | undefined> => {
      if (installPluginId === null) return candidateRegistryEntry;
      await refreshRegistryEntryCacheIfChanged();
      const committed = getRegistryEntry(installPluginId);
      if (!candidateRegistryEntry) return committed;
      return committed && recordsCandidate(committed, candidateRegistryEntry) ? committed : candidateRegistryEntry;
    };
    // Verify legacy receipts once per incarnation; updates create a new incarnation.
    let legacyReceiptSha256: string | null | undefined;
    const hostSecretGrantEvidence: HostSecretGrantEvidence = {
      officialPins: (plugin, version) => grantEvidence.officialPins(plugin, version),
      receiptArtifactSha256: async () => {
        if (installPluginId === null) return null;
        if (legacyReceiptSha256 === undefined) legacyReceiptSha256 = await grantEvidence.receiptArtifactSha256(installPluginId);
        return legacyReceiptSha256;
      },
    };
    const hostIncarnation = incarnation;
    // Admit host notifications only while this incarnation is live and runtime shutdown has not begun.
    const acceptsHostNotification = (): boolean =>
      hostIncarnation.isActive() && !pluginRuntime.isShuttingDown();
    hostIncarnation.registerDisposer(() => credentialRegistry.endIncarnation(hostIncarnation));
    const hostEffects = hostIncarnation.generationScope;
    const registerOwnedDisposer = (dispose: () => void): (() => void) => {
      let disposed = false;
      const disposeOnce = () => {
        if (disposed) return;
        disposed = true;
        dispose();
      };
      hostIncarnation.registerDisposer(disposeOnce);
      hostEffects?.registerDisposer(disposeOnce);
      return disposeOnce;
    };
    // Candidate grants activate with their generation; failed candidates cannot mutate incumbent alerts or settings.
    const alertRegistration = getAlertsService()?.prepareRegistration(pluginId, manifest, () => hostIncarnation.isActive());
    if (alertRegistration) {
      const publish = () => {
        void alertRegistration.publish().catch((err: unknown) => {
          log.warn(`[plugin:${pluginId}] alert kind registration failed: ${errorMessage(err)}`);
        });
      };
      registerOwnedDisposer(alertRegistration.unpublish);
      if (hostEffects) {
        hostEffects.stagePublish(publish);
        hostEffects.onSupersede(alertRegistration.unpublish);
      } else if (hostIncarnation.isActive()) {
        publish();
      }
    }
    const requireAlertsService = (member: string): AlertsService => {
      const service = getAlertsService();
      if (!service) throw new Error(`[plugin:${pluginId}] hostApi.${member}: alerts service is not constructed`);
      return service;
    };
    /** Missing Work Board storage is a boot-order error, never a silent proposal drop. */
    const requireWorkBoardStore = (): WorkBoardStore => {
      const store = getWorkBoardStore();
      if (!store) {
        throw new Error(
          `[plugin:${pluginId}] hostApi.proposeWork: work board store is not constructed`,
        );
      }
      return store;
    };
    const notifyProposalChanged = (
      id: string,
      change: WorkProposalChangedEventPayload["change"],
    ): void => {
      const target = liveMainWindow();
      if (!target || target.isDestroyed()) return;
      target.webContents.send(WORK_BOARD.proposalChanged, {
        proposalId: id,
        change,
        changedAt: new Date().toISOString(),
      } satisfies WorkProposalChangedEventPayload);
    };
    const assertIssuedCapabilityActive = (memberPath: string): void => {
      if (!hostIncarnation.isActive()) {
        throw new Error(
          `[plugin:${pluginId}] ${memberPath}: plugin instance is no longer active`,
        );
      }
    };
    const bindApiKeyResult = (
      result: Awaited<ReturnType<NonNullable<PluginHostApi["resolveApiKey"]>>>,
    ): Awaited<ReturnType<NonNullable<PluginHostApi["resolveApiKey"]>>> => {
      if (!result.ok) return result;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await result.release();
      };
      hostIncarnation.registerDisposer(() => { void release(); });
      const bound = {
        ...result,
        release,
      };
      if (result.exposure === "raw") {
        const metadata = result as typeof result & {
          handleId: string;
          onClosed: (listener: (reason: "revoked" | "peer-gone") => void) => () => void;
        };
        Object.defineProperties(bound, {
          handleId: { value: metadata.handleId },
          onClosed: { value: metadata.onClosed },
        });
      }
      return bound;
    };
    const bindWorkerHandle = (
      worker: Awaited<ReturnType<NonNullable<PluginHostApi["spawnWorker"]>>>,
    ): Awaited<ReturnType<NonNullable<PluginHostApi["spawnWorker"]>>> => {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        worker.stop();
      };
      hostIncarnation.registerDisposer(stop);
      return {
        socketPath: worker.socketPath,
        pid: worker.pid,
        stop,
        onStdout: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onStdout");
          worker.onStdout((chunk) => {
            if (hostIncarnation.isActive()) listener(chunk);
          });
        },
        onStderr: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onStderr");
          worker.onStderr((chunk) => {
            if (hostIncarnation.isActive()) listener(chunk);
          });
        },
        onExit: (listener) => {
          assertIssuedCapabilityActive("hostApi.spawnWorker().onExit");
          worker.onExit((info) => {
            if (hostIncarnation.isActive()) listener(info);
          });
        },
      };
    };
      const pluginStorage = createPluginStorage(
        pluginId,
        resolvePluginHostStorageDir(pluginDataDir),
        deps.host.encryption,
        createPluginStorageAuditSink(pluginId, pluginRuntimeAuditLog),
      );
      // Compare the parsed manifest document digest to the install pin; projections and unparsed manifests cannot match.
      const manifestSha256 = manifestDocumentSha256(manifest);
      // Record every HostApi effect from the shared path classification; storage instrumentation is idempotent.
      // Enforce outside the recorder so denied mutations are not recorded as observed; hostFetch gates its own verb.
      return enforceActiveHostApi(pluginId, hostIncarnation, enforceMutatingEffects<PluginHostApi>(
        instrumentEffectsByPath<PluginHostApi>({
      storage: pluginStorage,
      // Read merged config live so changes from other surfaces are immediately visible.
      // Secret-format keys must use encrypted secret storage, never cleartext pluginConfigs.
      // Config listeners are scoped to the bound plugin id; cross-plugin observation is rejected.
      config: {
        get: <T = unknown>(key: string): T | undefined => {
          // Config precedence is schema defaults, manifest defaults, wildcard metadata, then saved plugin overrides.
          const merged = effectivePluginConfig(manifest,
            pluginRuntime.getWildcardConfigOverride?.() ?? {},
            settingsService.getPluginConfig(pluginId) ?? {},
          );
          return merged[key] as T | undefined;
        },
        set: <T = unknown>(key: string, value: T): Promise<void> => {
          const schemaProp = manifest.configSchema?.properties?.[key];
          if (schemaProp?.type === "string" && schemaProp.format === "secret") {
            return Promise.reject(new Error(
              `[plugin:${pluginId}] config.set('${key}'): secret fields must be saved via hostApi.setSecret(), not config.set().`,
            ));
          }
          const nestedLifecycleMutation =
            isPluginInstallLockHeld(pluginId) || hostIncarnation.isLifecycleHookActive();
          const persistence = withPluginInstallLock(pluginId, async () => {
            // Queued writes from retired incarnations must not recreate removed or reinstalled plugin config.
            if (!hostIncarnation.isActive()) {
              throw new Error(
                `[plugin:${pluginId}] config.set('${key}'): plugin instance is no longer active`,
              );
            }
            const current = settingsService.getPluginConfig(pluginId) ?? {};
            // Clone persisted records so plugins cannot mutate host-owned references.
            const nextRecord = structuredClone({
              ...current,
              [key]: value as unknown,
            });
            await settingsService.setPluginConfig(pluginId, nextRecord);
            // Refresh runtime overrides before publishing changes so reload and existing listeners see the same value.
            pluginRuntime.setConfigOverride(pluginId, nextRecord);
            emitPluginConfigChange(pluginId, key, value);
          });
          // Return the tracked chain directly; async wrapping can detach rejection and end the owning mutation early.
          const operation = persistence.then(async () => {
            // Lifecycle writes persist without recursively restarting the instance whose mutation is being awaited.
            // Restart policy must avoid reentering lifecycle hooks or an already-running restart.
            if (
              !shouldRestartAfterPluginConfigWrite({
                mutatedCleartextConfig: true,
                restartUnsafe:
                  nestedLifecycleMutation
                  || pluginRuntime.isPluginRestartPending?.(pluginId) === true,
              })
            ) {
              return;
            }
            try {
              const restartResult = await pluginRuntime.restartPlugin(
                pluginId,
                { skipPreparation: true },
              );
              if (restartResult !== "started") {
                throw new Error(
                  `runtime reload returned ${restartResult ?? "not-loaded"}`,
                );
              }
            } catch (err) {
              throw new Error(
                `[plugin:${pluginId}] config.set('${key}'): runtime reload failed: ${(err as Error).message}`,
              );
            }
          });
          return hostIncarnation.trackOperation(operation);
        },
        onChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
        ): (() => void) => {
          const invoke = (nextValue: T | undefined) => {
            if (!acceptsHostNotification()) return;
            callback(nextValue);
          };
          // Use wrapListener to contain async callback failures; discarded rejections can terminate the main process.
          const notify = hostEffects ? hostEffects.wrapListener(invoke) : invoke;
          const unsubscribe = subscribePluginConfigChange(
            pluginId,
            key,
            (_changedKey, value) => {
              notify(value as T | undefined);
            },
          );
          // Remove config listeners when the plugin is disabled.
          return registerOwnedDisposer(unsubscribe);
        },
      },
      emitEvent: (type, data) => {
        logPluginLifecycle("debug", { pluginId, phase: PluginPhase.CAPABILITY_CHECK, eventType: type }, "checking emit capability");
        const declaredEmittedEvents = getDeclaredEmittedEvents(manifest);
        if (!canEmitEvent(type, declaredEmittedEvents)) {
          auditPluginEmitDenial({
            auditLogger: bootAuditLogger,
            lane: "plugin",
            pluginId,
            eventType: type,
            declaredEmittedEvents,
          });
          throw new Error(`Plugin '${pluginId}' is not allowed to emit undeclared event '${type}'`);
        }
        pluginRuntime.assertPluginEventEmitAccess(pluginId, type);
        logPluginLifecycle("debug", { pluginId, phase: PluginPhase.EVENT_EMIT, eventType: type }, "event emitted");
        emitEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId });
      },
      onEvent: (type, handler) => {
        pluginRuntime.assertPluginEventAccess(
          pluginId,
          type,
          candidateApprovedPluginAccess,
        );
        // Host alert events are visible only to the owner or explicitly granted named-plugin subscribers.
        const alertEvent = isAlertEvent(type);
        const dispatch = (data: unknown) => {
          if (!acceptsHostNotification()) return;
          if (alertEvent && !alertEventReaches(pluginId, type, data, getApprovedPluginAccess())) return;
          handler(data);
        };
        // Contain asynchronous event-listener failures just as the bus contains synchronous throws.
        const guardedHandler = hostEffects ? hostEffects.wrapListener(dispatch) : dispatch;
        const unsubscribe = onEvent(type, (data) => { guardedHandler(data); });
        logPluginLifecycle("debug", { pluginId, phase: PluginPhase.EVENT_LISTEN, eventType: type }, "event listener registered");
        return registerOwnedDisposer(unsubscribe);
      },
      getInstalledPluginIds: () => {
        return pluginRuntime.listPluginIds().filter((id) => id !== pluginId);
      },
      onPluginsChanged: (handler) => {
        const dispatchInstalled = (data: unknown) => {
          if (!acceptsHostNotification()) return;
          const payload = data as { pluginId?: string; source?: "marketplace" | "local-dev" } | null | undefined;
          const subjectId = payload?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          const source = payload?.source === "local-dev" ? "local-dev" : "marketplace";
          handler({ type: "installed", pluginId: subjectId, source });
        };
        const dispatchUninstalled = (data: unknown) => {
          if (!acceptsHostNotification()) return;
          const subjectId = (data as { pluginId?: string } | null | undefined)?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          handler({ type: "uninstalled", pluginId: subjectId });
        };
        const guardedInstalled = hostEffects ? hostEffects.wrapListener(dispatchInstalled) : dispatchInstalled;
        const guardedUninstalled = hostEffects ? hostEffects.wrapListener(dispatchUninstalled) : dispatchUninstalled;
        const unsubInstalled = onEvent("plugin.installed", (data) => { guardedInstalled(data); });
        const unsubUninstalled = onEvent("plugin.uninstalled", (data) => { guardedUninstalled(data); });
        const unsubscribe = () => { unsubInstalled(); unsubUninstalled(); };
        return registerOwnedDisposer(unsubscribe);
      },
      // Return opaque host leases unless raw exposure was explicitly reviewed.
      resolveApiKey: async (opts) => {
        const request = {
          purpose: opts.purpose,
          vendor: opts.vendor,
          exposure: opts.exposure ?? "lease",
          signal: opts.signal,
        };
        if (request.exposure !== "lease" && request.exposure !== "raw") {
          throw new HostApiBoundaryError("argument-marshalling-rejected", "Unknown credential exposure.");
        }
        const activeVendor = settingsService.get("llm").provider;
        const normalizedSource = normalizeVendor(request.vendor ?? activeVendor);
        if (normalizedSource === "gemini" || normalizedSource === "vertex-ai") {
          return { ok: false, reason: "vendor-unsupported" };
        }
        const permissionSignal = permissionManager?.getPluginRevokeSignal(pluginId) ?? new AbortController().signal;
        const identities = apiKeyIdentities(request, pluginId, settingsService);
        const reservation = credentialRegistry.reserve(
          pluginId, hostIncarnation, identities, permissionSignal, request.exposure,
        );
        if (!reservation) return { ok: false, reason: "lease-limit" };
        try {
        if (request.exposure === "raw") {
          const reviewedVersion = installPluginId === null ? null
            : await grantEvidence.receiptReviewedAppVersion?.(installPluginId) ?? null;
          if (!manifest.capabilities?.includes(CAPABILITY_RAW_API_KEY)
            || !reviewedVersion || !appVersionSatisfiesMin(reviewedVersion, "0.12.0")) {
            reservation.finish();
            return { ok: false, reason: "raw-exposure-denied" };
          }
        }
        const result = await resolveApiKeyImpl(
          {
            purpose: request.purpose as ResolveApiKeyPurpose,
            vendor: request.vendor as ResolveApiKeyVendor | undefined,
            exposure: request.exposure,
            signal: request.signal,
          },
          {
            pluginId,
            manifest,
            manifestSha256,
            settingsService,
            auditLogger: bootAuditLogger,
            readRegistryEntry,
            grantEvidence: hostSecretGrantEvidence,
            ...(deps._onCredentialIssuanceStageForTest
              ? { _onCredentialIssuanceStageForTest: deps._onCredentialIssuanceStageForTest }
              : {}),
            // Bind the permission revoke signal for the issuing request.
            ...(permissionManager
              ? {
                  getPluginRevokeSignal: (id: string) =>
                    permissionManager.getPluginRevokeSignal(id),
                }
              : {}),
          },
        );
        if (!result.ok) {
          reservation.finish();
          return result;
        }
        let secret: string;
        try { secret = result.bearer(); } catch {
          reservation.finish(); result.release();
          return { ok: false, reason: request.signal?.aborted ? "aborted" : "stale-authorization" };
        }
        const llm = settingsService.get("llm");
        const configuredBaseUrl = (llm.vendors as Record<string, { baseUrl?: string } | undefined> | undefined)?.[result.vendor]?.baseUrl;
        const defaultBaseUrl = result.vendor === "openai" ? "https://api.openai.com"
          : result.vendor === "claude" ? "https://api.anthropic.com" : undefined;
        const baseUrl = configuredBaseUrl || result.baseUrl || defaultBaseUrl;
        const scheme: CredentialScheme | undefined = result.vendor === "openai" ? "bearer"
          : result.vendor === "azure-foundry" ? "api-key"
            : result.vendor === "claude" ? "x-api-key" : undefined;
        if (!scheme) { reservation.finish(); result.release(); return { ok: false, reason: "vendor-unsupported" }; }
        if (result.source === "host-secret" && !baseUrl) {
          reservation.finish(); result.release(); return { ok: false, reason: "endpoint-unavailable" };
        }
        const allowedDomains = manifest.networkAccess?.allowedDomains ?? [];
        if (request.exposure === "lease" && result.source === "plugin-own" && allowedDomains.length === 0) {
          reservation.finish(); result.release(); return { ok: false, reason: "audience-not-allowlisted" };
        }
        let origin: string | undefined;
        try {
          if (baseUrl) {
            const endpoint = new URL(baseUrl);
            if (endpoint.protocol === "https:") origin = endpoint.origin;
          }
        } catch { /* invalid host endpoint is unavailable */ }
        if (result.source === "host-secret" && !origin) {
          reservation.finish(); result.release(); return { ok: false, reason: "endpoint-unavailable" };
        }
        if (result.source === "host-secret" && !urlHostMatchesAllowList(new URL(origin!).hostname, allowedDomains)) {
          reservation.finish(); result.release(); return { ok: false, reason: "audience-not-allowlisted" };
        }
        if (!hostIncarnation.isActive()) {
          reservation.finish(); result.release(); return { ok: false, reason: "stale-authorization" };
        }
        if (deps._onCredentialIssuanceStageForTest) await deps._onCredentialIssuanceStageForTest("before-reply");
        const registered = credentialRegistry.register(reservation, {
          key: result.keyName,
          vendor: result.vendor,
          ...(baseUrl ? { baseUrl } : {}),
          secret,
          scheme,
          permissionSignal,
          audience: result.source === "host-secret"
            ? (url) => url.origin === origin
            : (url) => urlHostMatchesAllowList(url.hostname, allowedDomains),
        });
        result.release();
        return registered ? bindApiKeyResult(registered)
          : { ok: false, reason: request.signal?.aborted ? "aborted" : "stale-authorization" };
        } catch (error) {
          reservation.finish();
          throw error;
        }
      },
      getSecret: async (key) => {
        // Both secret APIs use runSecretGate; this closure owns only its result shape and audit accounting.
        // Fold unknown key prefixes into other to bound attacker-controlled counter cardinality.
        // Cap audit keys at 64 characters to prevent oversized denial records.
        const auditKey = key.slice(0, 64);
        const keyPrefix = sanitizeKeyPrefix(key);
        const audit = (type: "info" | "warn", line: string): void => {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type,
              input: `[plugin:${pluginId}] ${line}`,
            });
          } catch { /* audit must not break host */ }
        };
        // Trust the host registry entry, never writable plugin.json claims.
        const outcome = await runSecretGate({
          pluginId,
          operation: "export",
          key,
          allowlist: manifest.hostSecrets?.read ?? [],
          manifestSha256,
          readRegistryEntry,
          grantEvidence: hostSecretGrantEvidence,
          readSettings: () => {
            const llm = settingsService.get("llm");
            return {
              llmProvider: llm.provider as string,
              marketplaceProviderPresetId: llm.marketplaceProviderPresetId,
              readInstalledProviderPresetIds: () =>
                (settingsService.get("marketplace").installedProviderPresets ?? []).map(
                  (preset) => preset.providerId,
                ),
            };
          },
        });
        if (outcome.kind === "deny") {
          audit("warn", `hostSecret_denied reason=${outcome.reason} key=${auditKey}`);
          incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
          return null;
        }
        const value = settingsService.getSecret(key);
        // Block endpoint URLs in API-key-shaped plugin secrets; otherwise own-namespace reads can exfiltrate data.
        if (shouldBlockPluginSecretRead({ pluginId, storageKey: key, value })) {
          audit(
            "warn",
            `pluginSecret_denied reason=endpoint-url-in-api-key-like-secret key=${auditKey}`,
          );
          incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
          return null;
        }
        if (outcome.via === "own-namespace") {
          // Count own-namespace reads consistently across both secret APIs.
          audit("info", `pluginSecret_read key=${auditKey}`);
          incrementHostSecretCounter("hostSecret_read", pluginId, keyPrefix);
          return value;
        }
        audit("info", `hostSecret_read key=${auditKey}`);
        incrementHostSecretCounter("hostSecret_read", pluginId, keyPrefix);
        return value;
      },
      callLlm: async (prompt, opts) => {
        if (lateBinding.pluginCallLlmRef.fn) {
          return lateBinding.pluginCallLlmRef.fn(pluginId, prompt, opts);
        }
        if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
        return lateBinding.llmCallerRef.fn(prompt, opts);
      },
      hostFetch: async (input, init) => {
        try {
        // Use the host’s OS proxy and trust-store transport for declared network access.
        // The shared evaluator owns scheme, HTTPS, allow-list, and DNS-aware SSRF checks; audit stays here.
        // Sanitize denial buckets before telemetry so untrusted reasons cannot grow the counter map.
        const auditEgressDeny = (reasonBucket: string, detail: string) => {
          incrementHostSecretCounter("hostFetch_denied", pluginId, sanitizeKeyPrefix(reasonBucket));
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] host_fetch_denied ${detail}`,
            });
          } catch { /* audit must not break host */ }
        };
        // Read the plugin-controlled method getter once; effect classification, audit, and wire verb share that snapshot.
        const { method: rawVerb, ...restInit } = init ?? {};
        const hasAuth = Object.hasOwn(restInit, "auth");
        const auth = hasAuth ? validateWireAuth(restInit.auth) : undefined;
        const { auth: _auth, ...liveInit } = restInit;
        const callerHeaders = new Headers(liveInit.headers ?? {});
        assertSnapshotableRequestBody(liveInit.body);
        const transportInit = snapshotEffectArguments([{ ...liveInit, headers: callerHeaders }]).args[0] as RequestInit;
        if (auth) {
          for (const header of CREDENTIAL_HEADERS) {
            if (callerHeaders.has(header)) throw new CredentialLeaseError("credential-conflict", { header });
          }
        }
        const methodSnapshot =
          typeof rawVerb === "string" && rawVerb.length > 0 ? rawVerb.toUpperCase() : "GET";
        // Self-record hostFetch once before denial gates; audit attempted effects using origin only.
        let effectTarget: string | undefined;
        if (typeof input === "string") {
          try {
            effectTarget = new URL(input).origin;
          } catch {
            /* best-effort forensic origin — never blocks the record */
          }
        }
        recordEffect({
          kind: "hostFetch",
          effect: methodEffect(methodSnapshot),
          ...(effectTarget !== undefined ? { target: effectTarget } : {}),
        });
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          auditEgressDeny("capability", "capability external-auth-consumer not declared");
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer (hostFetch)`,
          );
        }
        const raw = input instanceof URL ? input.toString() : input;
        // Private and reserved DNS results require an explicit private-network grant even for allow-listed hosts.
        const decision = await evaluateHostFetch({
          pluginId,
          rawUrl: raw,
          method: methodSnapshot,
          allowedDomains: manifest.networkAccess?.allowedDomains ?? [],
          allowPrivateNetworks: manifest.networkAccess?.allowPrivateNetworks === true,
        });
        if (!decision.ok) {
          auditEgressDeny(decision.reason, decision.detail);
          throw new Error(decision.message);
        }
        const url = decision.url;
        // Each exact hop authorizes immediately before transport; manifest and destination checks remain independent.
        assertActiveHostApi(pluginId, hostIncarnation, "hostApi.hostFetch");
        const credentialUse = auth ? credentialRegistry.beginUse(auth.lease, pluginId, hostIncarnation) : undefined;
        credentialUse?.assertLive("after-await");
        incrementHostSecretCounter("hostFetch_egress", pluginId, "egress");
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input: `[plugin:${pluginId}] host_fetch ${url.origin} method=${decision.method} effect=${decision.effect}`,
          });
        } catch { /* audit must not break host */ }
        // Each redirect reruns the gate before sending; default rejects, manual returns, and follow is bounded.
        // Attach vaulted cookies per hop without exposing values; declaring plugins must not supply a competing Cookie header.
        const authCookieSub = manifest.networkAccess?.authCookiePartition;
        let injectSessionCookie: ((target: URL) => Promise<string>) | undefined;
        if (typeof authCookieSub === "string" && authCookieSub.length > 0) {
          const pluginSentCookie = new Headers(
            (transportInit.headers as HeadersInit | undefined) ?? {},
          ).has("cookie");
          if (pluginSentCookie) {
            auditEgressDeny(
              "cookie-vault",
              "plugin sent its own Cookie header while authCookiePartition is declared",
            );
            throw new Error(
              `[plugin:${pluginId}] hostFetch: a plugin declaring networkAccess.authCookiePartition `
                + `must not send its own Cookie header — the host injects session cookies from `
                + `persist:plugin-auth:${pluginId}:${authCookieSub}`,
            );
          }
          const partition = `persist:plugin-auth:${encodeURIComponent(pluginId)}:${authCookieSub}`;
          const partitionSession = requireDesktopHost(deps.host).getAuthPartition(partition);
          injectSessionCookie = (target: URL) =>
            partitionCookieHeaderForUrl(partitionSession, target);
        }
        return await runHostFetchHops({
          pluginId,
          first: decision,
          authorizeHop: async (hop) => {
            const reviewHeaders = new Headers(hop.headers);
            let capabilityBound = Boolean(auth || injectSessionCookie);
            for (const name of CREDENTIAL_HEADERS) {
              if (reviewHeaders.has(name)) capabilityBound = true;
              reviewHeaders.delete(name);
            }
            await gateMutatingEffect({
              pluginId, methodPath: "hostFetch", effect: methodEffect(hop.method), target: hop.url.origin,
              input: [hop.url.toString(), { method: hop.method, body: hop.body, headers: Array.from(reviewHeaders.entries()), credentialAttached: capabilityBound }],
              capabilityBound, approvalGate, permissionManager,
            });
            assertActiveHostApi(pluginId, hostIncarnation, "hostApi.hostFetch");
          },

          init: transportInit,
          transport: networkFetch,
          ...(credentialUse ? { credentialUse } : {}),
          allowedDomains: manifest.networkAccess?.allowedDomains ?? [],
          allowPrivateNetworks: manifest.networkAccess?.allowPrivateNetworks === true,
          ...(injectSessionCookie ? { injectSessionCookie } : {}),
          auditHop: (line) => {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "tool_call",
                input: `[plugin:${pluginId}] ${line}`,
              });
            } catch { /* audit must not break host */ }
          },
          auditDeny: auditEgressDeny,
          onResponseBodyError: (error) => {
            if (error instanceof CredentialLeaseError) leaseDenialAudit.record(pluginId, "hostFetch", error);
          },
        });
        } catch (error) {
          if (error instanceof CredentialLeaseError) leaseDenialAudit.record(pluginId, "hostFetch", error);
          else if (error instanceof HostApiBoundaryError && error.code === "credential-conflict") {
            leaseDenialAudit.record(pluginId, "hostFetch", { code: "credential-conflict" });
          }
          throw error;
        }
      },
      logEvent: (level, message, data) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          log.warn(`logEvent failed: %s`, (err as Error).message);
        }
      },
      onShutdown: (handler) => {
        const invoke = async () => {
          if (!hostIncarnation.isActive()) return;
          await handler();
        };
        const entry = {
          pluginId,
          handler: hostEffects ? hostEffects.wrapCallback(invoke) : invoke,
        };
        pluginShutdownHandlers.push(entry);
        const unsubscribe = () => {
          const index = pluginShutdownHandlers.indexOf(entry);
          if (index >= 0) pluginShutdownHandlers.splice(index, 1);
        };
        registerOwnedDisposer(unsubscribe);
      },
      // Bind worker identity host-side; a self-claimed worker id cannot authorize host-routed tools.
      spawnWorker: async (workerSpec) => {
        const worker = await spawnWorker({
          ...workerSpec,
          pluginId,
          // Only reviewed host declarations may allow worker reads inside the protected floor.
          floorPierces: declaredHostDirectoryFloorPierces(manifest.sandbox),
        });
        if (!hostIncarnation.isActive()) {
          worker.stop();
          throw new Error(
            `[plugin:${pluginId}] hostApi.spawnWorker: plugin instance is no longer active`,
          );
        }
        return bindWorkerHandle(worker);
      },
      // Read external-link routing live; public preference reads use only the explicit allow-list.
      // Denied preference keys return undefined and warn once per key and plugin.
      openExternalUrl: async (url: string): Promise<void> => {
        await routeExternalUrl({
          url,
          pluginId,
          settingsService,
          bootAuditLogger,
          openLinkWindowService: (opts) => openLinkWindowService(requireMainWindow(), opts),
          shellOpenExternal,
        });
      },
      getAppPreference: <T = unknown>(key: string): T | undefined => {
        return readAppPreference(pluginId, key) as T | undefined;
      },
      // Host DNS probing is a bounded UX hint, not a trust boundary.
      // Audit probe host and outcome here because read effects bypass executor audit; cap names to 64 characters.
      probePrivateHost: async (host: string, opts?: { timeoutMs?: number }): Promise<boolean> => {
        const auditHost = (typeof host === "string" ? host : String(host)).slice(0, 64);
        try {
          const resolved = await probePrivateHost(host, opts);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "tool_call",
              input: `[plugin:${pluginId}] probe_private_host host=${auditHost} resolved=${resolved}`,
            });
          } catch { /* audit must not break host */ }
          return resolved;
        } catch (err) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "warn",
              input: `[plugin:${pluginId}] probe_private_host_rejected host=${auditHost} reason=${(err as Error).message.slice(0, 120)}`,
            });
          } catch { /* audit must not break host */ }
          throw err;
        }
      },
      // Auth-cookie surfaces require declared capability; audit allows and denials without sensitive query values.
      /** Bind redirect-catcher ownership to this HostApi’s plugin id; callers cannot name another owner. */
      authRedirect: {
        open: async () => await authRedirectCatchers.open(pluginId),
        wait: async (opts: { handle: string; timeoutMs?: number }) =>
          await authRedirectCatchers.wait(pluginId, opts.handle, opts.timeoutMs),
        close: async (opts: { handle: string }) => {
          authRedirectCatchers.close(pluginId, opts.handle);
        },
      },
      /** Bind chooser identity host-side; prefer the focused window and allow an unparented chooser when none exists. */
      pickFolders: async () => {
        const result = await requireDesktopHost(deps.host).pickFolders(pluginId,
          () => requireDesktopHost(deps.host).getFocusedWindow() ?? getMainWindow?.() ?? null,
        );
        // Return a copied list so plugin mutations cannot change the host’s answer.
        return { canceled: result.canceled, folders: [...result.folders] };
      },
      /** Validate the drive letter in the resolver that constructs the host-owned command. */
      resolveMappedDriveRoot: async (drive: string) => resolveMappedDriveRoot(drive),
      /** One host capture service owns the physical devices; plugins supply only bounded capture settings. */
      listAudioInputDevices: async () => audioCaptureService(deps.host).listInputDevices(),
      startAudioCapture: async (request: AudioCaptureRequest) =>
        audioCaptureService(deps.host).start(request),
      /** The host owns dock placement and flags; plugins may attach only their own declared surface at a clamped height. */
      attachFloatingPanel: async (request: AttachFloatingPanelRequest) =>
        floatingDock(deps.host, deps.getPluginRuntime).attach(pluginId, request),
      resizeFloatingPanel: async (panelId: string, height: number) =>
        floatingDock(deps.host, deps.getPluginRuntime).resizeByPanelId(pluginId, panelId, height),
      openAuthWindow: (async (opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        const cookieHostCount = Array.isArray(opts.cookieHosts) ? opts.cookieHosts.length : 0;

        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_window_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }

        log.info(
          `plugin:${pluginId} openAuthWindow url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
        );
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] openAuthWindow ` +
              `url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
          });
        } catch { /* audit must not break host */ }

        // Default auth partitions are per-plugin and non-persistent so sessions neither leak across plugins nor survive on disk.
        // Persistent auth partitions must remain within the bound plugin’s namespace.
        const encodedId = encodeURIComponent(pluginId);
        const defaultPartition = `plugin-auth:${encodedId}`;
        const allowedPersistBase = `persist:${defaultPartition}`;
        const requested = opts.persistPartition;
        if (
          requested !== undefined &&
          requested !== allowedPersistBase &&
          !requested.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] open_auth_window_invalid_partition ` +
                `persistPartition=${requested} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthWindow: persistPartition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        const effectiveOpts = requested
          ? opts
          : { ...opts, persistPartition: defaultPartition };
        return openAuthWindowService(requireDesktopHost(deps.host).getFocusedWindow() ?? requireMainWindow(), effectiveOpts);
      }) as PluginHostApi["openAuthWindow"],

      // Auth viewers use the caller’s partition and the same capability gate as auth capture.
      openAuthPartitionViewer: async (opts: { url: string; windowTitle?: string }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        const declared = manifest.auth?.partitionDomains ?? [];
        let allowedHosts: string[];
        try {
          allowedHosts = normalizeAllowedHosts(declared);
        } catch (err) {
          const reason = errorMessage(err);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_manifest_invalid reason=${reason}`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains invalid (${reason})`,
          );
        }
        if (allowedHosts.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains must be a non-empty list`,
          );
        }
        return openAuthPartitionViewerService(
          requireDesktopHost(deps.host).getFocusedWindow() ?? requireMainWindow(),
          {
            pluginId,
            url: opts.url,
            allowedHosts,
            windowTitle: opts.windowTitle,
            parent: requireDesktopHost(deps.host).getFocusedWindow() ?? requireMainWindow(),
            audit: (event) => {
              try {
                bootAuditLogger.log({
                  timestamp: event.timestamp,
                  sessionId: "plugin",
                  type: event.type === "open_auth_partition_viewer" ? "tool_call" : "error",
                  input:
                    `[plugin:${event.pluginId}] ${event.type} ` +
                    `url=${event.url}` +
                    (event.deniedHost ? ` deniedHost=${event.deniedHost}` : "") +
                    ` allowedHosts=${event.allowedHosts.join(",")}`,
                });
              } catch { /* audit must not break host */ }
            },
          },
        );
      },

      // Clear only the caller’s auth partitions after sign-out to prevent residual-cookie SSO.
      clearAuthPartition: async (partition: string): Promise<void> => {
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] clear_auth_partition_capability_denied missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        if (typeof partition !== "string" || partition.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be a non-empty string`,
          );
        }
        const encodedId = encodeURIComponent(pluginId);
        const allowedPersistBase = `persist:plugin-auth:${encodedId}`;
        if (
          partition !== allowedPersistBase &&
          !partition.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] clear_auth_partition_invalid_partition ` +
                `partition=${partition} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input: `[plugin:${pluginId}] clearAuthPartition partition=${partition}`,
          });
        } catch { /* audit must not break host */ }
        await clearAuthPartitionService(partition);
      },

      getAuthPartitionCookies: async (opts: {
        partitionSub: string;
        urls: string[];
      }): Promise<Array<{ url: string; cookies: AuthPartitionCookie[] }>> => {
        if (!manifest.capabilities?.includes(CAPABILITY_EXTERNAL_AUTH_CONSUMER)) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] get_auth_partition_cookies_capability_denied missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        const { partitionSub, urls } = opts ?? { partitionSub: "", urls: [] };
        if (typeof partitionSub !== "string" || partitionSub.length === 0 || partitionSub.includes(":")) {
          throw new Error(
            `[plugin:${pluginId}] getAuthPartitionCookies: partitionSub must be a non-empty string naming one sub-namespace (no ':')`,
          );
        }
        if (!Array.isArray(urls) || !urls.every((u): u is string => typeof u === "string")) {
          throw new Error(
            `[plugin:${pluginId}] getAuthPartitionCookies: urls must be an array of strings`,
          );
        }
        // Cookie reads use the caller’s network allow-list; invalid or disallowed entries return empty groups.
        const normalizedAllowed = normalizeAllowedHosts(
          manifest.networkAccess?.allowedDomains ?? [],
          { allowLoopback: true },
        );
        const partition = `persist:plugin-auth:${encodeURIComponent(pluginId)}:${partitionSub}`;
        const partitionSession = requireDesktopHost(deps.host).getAuthPartition(partition);
        const results: Array<{ url: string; cookies: AuthPartitionCookie[] }> = [];
        for (const rawUrl of urls) {
          let parsed: URL | null = null;
          try {
            parsed = new URL(rawUrl);
          } catch {
            parsed = null;
          }
          if (parsed === null || !urlHostMatchesAllowList(parsed.hostname, normalizedAllowed)) {
            results.push({ url: rawUrl, cookies: [] });
            continue;
          }
          const scoped = await partitionCookiesForUrl(partitionSession, parsed);
          results.push({ url: rawUrl, cookies: scoped });
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] getAuthPartitionCookies partitionSub=${partitionSub} ` +
              `urls=${urls.length} origins=${results.map((r) => { try { return new URL(r.url).origin; } catch { return "[invalid]"; } }).join(",")}`,
          });
        } catch { /* audit must not break host */ }
        return results;
      },

      // The approval gate is required at construction; absence is a boot-order error.
      // Requests bind approved scope and issuer; responses recheck both ownership and the current grant.
      agentApproval: {
        request: async (input: {
          toolName: string;
          args: unknown;
          reason: string;
          scope: string;
        }): Promise<ApprovalChoice> => {
          const approvedAccess = getApprovedPluginAccess();
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalRequestScope(pluginId, input.scope, allowedScopes);
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, `request:${input.scope}`);
          }
          const { requestAgentApproval } = await import(
            "../../../permissions/agent-action-requester.js"
          );
          return requestAgentApproval(
            approvalGate,
            {
              toolName: input.toolName,
              args: input.args,
              reason: input.reason,
              source: "plugin",
              sourcePluginId: pluginId,
              scope: input.scope,
            },
            approvalIssuerRegistry,
          );
        },

        respond: async (
          requestId: string,
          choice: ApprovalChoice,
          nonce?: string,
          hmac?: string,
        ): Promise<void> => {
          const approvedAccess = getApprovedPluginAccess();
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalResponder(
              approvalIssuerRegistry,
              requestId,
              pluginId,
              allowedScopes,
            );
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, requestId);
          }
          approvalGate.resolve(requestId, { requestId, choice, nonce, hmac });
        },
      },

      // Stage suggestions in their dedicated conversation; confirmation imports the prompt without starting a new loop.
      // Declared suggestion sources are accepted once per 30 days; stage before charging and persist before resolving.
      triggerConversation: async (spec: ConversationTriggerSpec) => {
        const declaredSuggestions = getDeclaredSuggestionSources(manifest, pluginId);
        if (declaredSuggestions !== null) await suggestionLedger.load();
        const eventId = randomUUID();
        const decision = evaluateTriggerSpec({
          stageDelivery: (source) => {
            const overlayTarget = requireMainWindow();

            const overlayId = `plugin:${pluginId}:${eventId}`;
            const derivedSummary = deriveOverlaySummaryForDisplay(spec);
            const overlayItem = {
              id: overlayId,
              source: { kind: "plugin" as const, pluginId, eventId },
              pluginDisplayName: resolvePluginDisplayName(pluginId, manifest.name),
              title: spec.title ?? spec.source.replace(/^overlay:/, ""),
              summary: derivedSummary,
              running: false,
              primaryActionLabel: spec.primaryActionLabel ?? t("be_pluginRuntime.overlayPrimaryActionLabel"),
              pendingPrompt: formatPluginPendingPrompt(spec.prompt, source),
              createdAt: new Date().toISOString(),
              originSessionId: SUGGESTIONS_SESSION_ID,
            };
            stageInSuggestionsSession();
            overlayTarget.webContents.send(OVERLAY_V1.show, overlayItem);
          },
          assertDeliveryAvailable: () => { requireMainWindow(); },
          spec,
          pluginId,
          capabilities: manifest.capabilities ?? [],
          dedupe: triggerConversationDedupe,
          rateLimiter: triggerConversationRateLimiter,
          denyAuditThrottle: triggerDenyAuditThrottle,
          auditLogger: bootAuditLogger,
          suggestions: declaredSuggestions === null
            ? undefined
            : { declared: declaredSuggestions, ledger: suggestionLedger },
        });

        if (decision.kind === "deny") {
          return decision.result;
        }
        if (declaredSuggestions !== null) await suggestionLedger.flush();

        return { accepted: true, source: decision.source, eventId };
      },

      // Routine probes enumerate only the caller’s suggestion prefix; out-of-prefix requests return false.
      hasRoutineBySource: async (source: string): Promise<boolean> => {
        if (typeof source !== "string" || source.length === 0) return false;
        const callerPrefix = `suggestion:${pluginId}:`;
        if (!source.startsWith(callerPrefix)) {
          return false;
        }
        return routinesStore.list().some((r) => r.source === source);
      },

      // Proposals carry text and a key; host-owned planning, approval, and execution retain executable authority.
      // Only installed manifest kinds authorize proposals; undeclared kinds are refused.
      proposeWork: async (input: WorkProposalInput): Promise<WorkProposalResult> => {
        if (!input || typeof input !== "object" || typeof input.kind !== "string") {
          return { status: "invalid", field: "kind" };
        }
        if (workProposalRateLimiter.isOverCap(pluginId)) {
          return { status: "rate_limited" };
        }
        const result = await requireWorkBoardStore().upsertProposal(
          {
            pluginId,
            // An omitted authored display name intentionally resolves to its id.
            pluginLabel: manifest.name ?? pluginId,
            grantedKinds: getDeclaredWorkProposalKinds(manifest, pluginId),
          },
          input,
        );
        workProposalRateLimiter.record(pluginId);
        if (result.status === "ok") notifyProposalChanged(result.proposal.id, "posted");
        return result;
      },

      withdrawWorkProposal: async (kind: string, key: string): Promise<boolean> => {
        if (typeof kind !== "string" || typeof key !== "string") return false;
        const withdrawn = await requireWorkBoardStore().withdrawProposal(pluginId, kind, key);
        // Proposal identity includes the bound plugin id, so another plugin’s key cannot address it.
        if (withdrawn) notifyProposalChanged(proposalId(pluginId, kind, key.trim()), "withdrawn");
        return withdrawn;
      },

      // Host-rendered alerts accept declared kind slots only; ownership uses the bound plugin id.
      raiseAlert: async (input: AlertInput): Promise<AlertResult> =>
        requireAlertsService("raiseAlert").raise(pluginId, input),

      withdrawAlert: async (kind: string, key: string): Promise<boolean> =>
        requireAlertsService("withdrawAlert").withdraw(pluginId, kind, key),
        }),
        {
          pluginId,
          approvalGate,
          permissionManager,
          resolveStoragePath: (relativePath) => pluginStorage.resolve(relativePath),
          assertActive: () =>
            assertActiveHostApi(pluginId, hostIncarnation, "hostApi.approvedEffect"),
        },
      ));
  };
}

function recordsCandidate(committed: Readonly<PluginRegistryTrust>, candidate: Readonly<PluginRegistryTrust>): boolean {
  if (committed.installSource !== candidate.installSource) return false;
  if (committed.manifestSha256 !== candidate.manifestSha256) return false;
  if (!candidate.origin) return true;
  return canonicalJSON(committed.origin ?? null) === canonicalJSON(candidate.origin);
}
