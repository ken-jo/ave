import { readPluginRegistry, vouchedInstalledPluginIds } from "./plugins/registry.js";
import { requireDesktopHost, type BootHost } from "./boot/host-runtime.js";
import { approvalSurfaceResolver } from "./boot/approval-surface.js";
import { configureHostResources } from "./main/host-resources.js";
/**
 * Boot Sequence — §4.2 (thin orchestrator).
 *
 * `bootstrap()` builds a {@link BootContext} accumulator and threads it through
 * the ordered boot steps under `src/boot/steps/*`, then hands the fully-
 * populated context to {@link assembleAppServices} to build the returned
 * {@link AppServices}. Each step reads prior services from the context and
 * writes its own outputs back onto it; the construction ORDER of the steps is
 * the contract (approvalGate / permissionManager / routinesStore / whitelist
 * before initPluginRuntime; plugin runtime before the ConversationLoop; loop
 * before the late-bound SubAgentRunner — locked by the C3 integration test).
 *
 * The remaining inline glue here is the earliest bring-up (core services,
 * approval gate, permission manager, routines store, plugin runtime) plus the
 * tail lifecycle hooks (watcher telemetry, shutdown-hook diff-cache cleanup,
 * starred/feedback stores, release prep). Everything with real weight lives in
 * a focused step module:
 *
 *   steps/network-fetch-setup     Electron fetch surface (net + private + plugin
 *                                 egress chooser + SSRF-guarded LLM fetch).
 *   steps/audit-notification      shared AuditLogger + NotificationService +
 *                                 plugin auth-partition tracker seeding.
 *   steps/plugin-runtime          PluginRuntime + per-plugin HostApi factory.
 *   steps/work-board-setup        Work Board persistence + due-soon scanner.
 *   steps/workflow-stores         workflow stores + builtin tool registration.
 *   steps/marketplace-setup       plugin store + live-refresh closures.
 *   steps/reviewer-permission-wiring  reviewer agent + PermissionManager
 *                                 broadcasts + manifest-integrity bridge.
 *   steps/plugin-tool-executor    plugin-surface ToolExecutor + invoke delegate.
 *   steps/conversation-wiring     routine engine + ConversationLoop + late
 *                                 bindings + SubAgentRunner + work-board engine.
 *   steps/remote-a2a-setup        remote A2A runtime + action controller;
 *                                 a start failure disables the feature only.
 *   steps/routines-wiring         RoutinesScheduler v2 branch wiring.
 *   steps/mcp-setup               MCP servers + signed-artifact stores.
 *   steps/sandbox-init            OS tool sandbox gate + ASRT init.
 *   steps/post-boot               release prep + plugin update-check timer.
 *
 * No plugin-specific code lives here — all plugins register themselves via the
 * HostApi manufactured in `steps/plugin-runtime.ts`.
 */
import type { BrowserWindow } from "electron";
import { CHANNELS } from "./contract/app-contract.js";
import { resolve } from "node:path";
import { sweepOrphanUninstallDirs } from "./plugins/orphan-uninstall-sweeper.js";
import { agentPluginDataRoot } from "./marketplace/content/agent-plugin-data.js";
import { migratePluginHostStorage, sweepPluginSocketDiscardDirs } from "./plugins/plugin-storage-layout.js";
import { preparePluginRegistryForBoot } from "./plugins/plugin-boot-recovery.js";
import { purgeStaleSessionDiffDirs, clearSessionDiffCache,
} from "./tools/write-diff-cache.js";
import { resolvePluginPaths } from "./plugins/plugin-paths.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { forgetTrackedPluginAuthPartitions, getTrackedPluginAuthPartitions } from "./main/plugin-auth-partition-tracker.js";
import { createPluginRetirementPort } from "./plugins/retired-config.js";
import { recoverPendingPluginUninstallCleanups } from "./plugins/uninstall-lifecycle.js";
import { drainPluginInstallLockOperations } from "./plugins/install-lifecycle.js";
import { registerBootMcpDisconnect, registerShutdownHook, configureAppShutdownHost } from "./main/app-shutdown.js";

import { type AppServices, emitEvent as emitHostEvent, onEvent } from "./boot/types.js";
import { startWatcherTelemetryCollector } from "./boot/steps/watcher-telemetry-collector.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { RoutinesStore } from "./main/routines-store.js";
import { RoutinesScheduler } from "./main/routines-scheduler.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createApprovalGate,
} from "./boot/conversation.js";
import { readPermissionSettings } from "./permissions/permission-settings-store.js";
import { summarizeParentContextTurns } from "./permissions/parent-context-evidence.js";
import type { ParentContextTurn } from "./permissions/parent-context-evidence.js";
import { McpAppModelContextStore } from "./mcp/mcp-app-model-context.js";
import { initPluginRuntime } from "./boot/steps/plugin-runtime.js";
import { feedRevocationsFromSnapshots } from "./boot/steps/revocation-bootstrap.js";
import { createServiceClient } from "./boot/steps/service-endpoint.js";
import { wireModelCatalogRefresh } from "./boot/steps/model-catalog-refresh.js";
import { wireAnnouncementCheck, wireReleasePrep,
} from "./boot/steps/post-boot.js";
import { migrateCanonicalization } from "./permissions/user-approval-store.js";
import { reconcileWorkspaceRoots } from "./permissions/workspace-root-reconciler.js";
import { createLogger } from "./lib/logger.js";
import { configureTracing, parseTelemetrySpec } from "./engine/telemetry/tracing.js";
import { getAveAppVersion } from "./shared/app-version.js";
import { ensureAveHomePrivate, aveHome, setAveHomePrivacyAtBoot, setAveHomeConfigurationRefusedAtBoot } from "./shared/ave-home.js";
import { migrateAveHomeConfiguration } from "./shared/ave-home-configuration.js";
import { isAveHomeConfigurationOwner } from "./shared/ave-home-configuration-access.js";
import { ensureAveScratchDir } from "./shared/ave-scratch.js";
import {
  listAveHomeDocUpgradeMarkers,
  seedAveHomeDocs,
  type AveHomeDocUpgradeMarker,
} from "./main/seed-ave-home-docs.js";

import { assertBootContextReady, createBootContext } from "./boot/context.js";
import { assembleAppServices } from "./boot/assemble-services.js";
import { setupNetworkFetch } from "./boot/steps/network-fetch-setup.js";
import { setupAuditAndNotification } from "./boot/steps/audit-notification.js";
import { notifyHomeBoundaryRepairs, notifyHomeConfigurationPreserved } from "./boot/steps/home-privacy-notice.js";
import { setupWorkBoard } from "./boot/steps/work-board-setup.js";
import { setupAlerts } from "./boot/steps/alerts-setup.js";
import { setupWorkflowStores } from "./boot/steps/workflow-stores.js";
import { setupMarketplace } from "./boot/steps/marketplace-setup.js";
import { wireReviewerAndPermissions } from "./boot/steps/reviewer-permission-wiring.js";
import { setupPluginToolExecutor } from "./boot/steps/plugin-tool-executor.js";
import { wireRationaleHost } from "./boot/steps/rationale-host-wiring.js";
import {
  createIsolatedConversationMemoryManagers,
  createSubscriptionChatLoopBindings,
  wireConversation,
} from "./boot/steps/conversation-wiring.js";
import { detachWorkspaceRootSessions } from "./memory/workspace-root-session-lifecycle.js";
import { wireRoutinesScheduler } from "./boot/steps/routines-wiring.js";
import { setupRemoteA2A } from "./boot/steps/remote-a2a-setup.js";
import { setupMcp } from "./boot/steps/mcp-setup.js";
import { initSandboxGate } from "./boot/steps/sandbox-init.js";
import { createA2ARemoteRuntime } from "./main/a2a-remote-runtime.js";
import { snapshotA2ARemoteGates } from "./main/a2a-remote-gates.js";
import { createRemoteA2AActionController } from "./main/remote-a2a-action-controller.js";
import { buildSingleFlightAgentActionApprover } from "./permissions/agent-action-approver.js";
import { PluginBundleLifecycle } from "./plugins/plugin-bundle-lifecycle.js";
import { configureChatGptPlanRuntime } from "./main/chatgpt-plan/runtime.js";
const log = createLogger("ave");

/**
 * How long one parent transcript read is reused for tier-2 evidence.
 *
 * `loadSession` reads and parses the whole session file synchronously on this
 * process's only thread. One adjudicated tool call is worth that; a burst of
 * them from one child run is not, and the approval path is the worst place to
 * spend it. A few seconds of staleness costs at most one very recent turn out
 * of the quoted block.
 */
const PARENT_CONTEXT_CACHE_MS = 5_000;

const parentContextCache = new Map<
  string,
  { readAt: number; turns: readonly ParentContextTurn[] }
>();

/**
 * Compose the parent-context block, reusing a recent read of the same session.
 *
 * Keyed by session AND turn count because the count bounds what the summariser
 * returns. The map is bounded by clearing it whenever it outgrows a handful of
 * sessions — this is a burst cache, not a store.
 */
function readParentContextTurns(
  memoryManager: { loadSession: (sessionId: string) => unknown[] | null },
  parentSessionId: string,
  maxTurns: number,
): readonly ParentContextTurn[] {
  const key = `${parentSessionId}\u0000${maxTurns}`;
  const now = Date.now();
  const cached = parentContextCache.get(key);
  if (cached && now - cached.readAt < PARENT_CONTEXT_CACHE_MS) return cached.turns;
  const turns = summarizeParentContextTurns(
    memoryManager.loadSession(parentSessionId) ?? [],
    maxTurns,
  );
  if (parentContextCache.size > 16) parentContextCache.clear();
  parentContextCache.set(key, { readAt: now, turns });
  return turns;
}

export type { AppServices } from "./boot/types.js";

/**
 * How this process was launched, and therefore whether anything is watching it.
 *
 * `"headless"` is the one-shot `--exec` / `--set-secret` run: it performs a
 * single request and quits. Such a run opens no DISCRETIONARY service
 * connection — no marketplace catalog sync, no release check, no polling, no
 * telemetry — because nothing in the process can act on
 * what any of them returns, and a run asked for one turn should not reach
 * anything the turn did not ask for.
 *
 * The plugin trust chain needs no connection: host-secret grants and
 * revocations are read from the marketplace snapshots already on disk
 * (design §10.3, §10.4), so a headless run keeps both without fetching
 * anything.
 *
 * An `"interactive"` launch keeps every one of them.
 */
export type BootLaunch = "interactive" | "headless";

/**
 * @param getMainWindow Live BrowserWindow getter — must read the current
 *   `main.ts` binding because Electron close+reopen replaces the window.
 *   Bootstrap-time consumers (e.g. plugin event bridge) take the resolved
 *   `mainWindow`; runtime consumers (e.g. routinesScheduler) take this getter.
 * @param launch Whether this is an interactive launch or a headless one-shot
 *   run — see {@link BootLaunch}. The single fact every service-connection
 *   decision below is derived from.
 */
export async function bootstrap(
  projectRoot: string,
  mainWindow: BrowserWindow | null,
  getMainWindow: () => BrowserWindow | null,
  launch: BootLaunch,
  host: BootHost,
): Promise<AppServices> {
  configureAppShutdownHost(host);
  configureHostResources(host);
  log.info("boot: starting...");
  const headless = launch === "headless";
  if (!headless && !mainWindow) throw new Error("Interactive boot requires a main window");
  if (headless) {
    log.info(
      "boot: headless launch — no catalog sync, model catalog refresh, release check, polling or telemetry",
    );
  }
  const ctx = createBootContext({ projectRoot, mainWindow, getMainWindow, host });

  // Before any provider exists, so the AI SDK integration is registered by the
  // time the first model is constructed. An unreadable spec leaves tracing off
  // and is reported: a malformed environment variable must not stop the app.
  const telemetrySpec = parseTelemetrySpec(process.env.AVE_TELEMETRY);
  if ("error" in telemetrySpec) log.error(`boot: ${telemetrySpec.error}`);
  ctx.tracing = await configureTracing(telemetrySpec, getAveAppVersion());

  await setupNetworkFetch(ctx);

  // Create protected storage boundaries before any feature writes.
  const homePrivacy = ensureAveHomePrivate();
  setAveHomePrivacyAtBoot(homePrivacy);
  if (homePrivacy.enforcement !== "posix-mode") {
    for (const diagnostic of homePrivacy.diagnostics ?? []) log.warn(`boot: ${diagnostic}`);
  }
  if (homePrivacy.enforcement === "none") {
    log.error(
      `boot: ${homePrivacy.failedPath ?? homePrivacy.home} could not be restricted to this account (${homePrivacy.category}: ${homePrivacy.reason}) — extension confinement is refused because private directory protection is unverified`,
    );
  }

  // An unverified root has no protected config boundary to migrate into; legacy root files stay in place.
  if (homePrivacy.enforcement === "none") log.warn("boot: legacy root configuration is not migrated while home protection is unverified");
  const configurationDiagnostics = isAveHomeConfigurationOwner()
    ? migrateAveHomeConfiguration(homePrivacy.home, homePrivacy) : [];
  if (homePrivacy.enforcement === "none") setAveHomeConfigurationRefusedAtBoot(homePrivacy.home);
  for (const diagnostic of configurationDiagnostics) log.warn(`boot: ${diagnostic}`);

  // The application-owned scratch directory the agent may stage work in
  // without an approval. It is offered to the model and to the Layer 1
  // defaults only while it verifies as a `0o700` directory this account owns;
  // a failure here means the agent simply has no default scratch space, which
  // is reported rather than replaced by the shared temp root.
  const scratch = ensureAveScratchDir();
  if (!scratch.ok) {
    log.error(`boot: scratch directory ${scratch.path} is not usable (${scratch.reason}) — no default scratch space will be offered`);
  }

  // Seed user-facing docs into `~/.ave/` before any other component reads
  // home state. AGENTS.md is the LLM-facing system reference; on first boot
  // it is copied from packaged resources, and on subsequent upgrades a
  // `.new` sibling is dropped next to the user's edited copy for diff/merge.
  // Non-fatal — failures log and continue.
  let aveHomeDocUpgradeMarkers: AveHomeDocUpgradeMarker[] = [];
  try {
    const seeded = seedAveHomeDocs();
    if (seeded.seeded.length > 0) {
      log.info(`boot: seeded ave-home docs: ${seeded.seeded.join(", ")}`);
    }
    if (seeded.upgraded.length > 0) {
      log.info(
        `boot: ave-home docs upgrade available: ${seeded.upgraded.join(", ")}`,
      );
    }
    aveHomeDocUpgradeMarkers = listAveHomeDocUpgradeMarkers();
    if (aveHomeDocUpgradeMarkers.length > 0) {
      log.info(
        `boot: pending ave-home docs upgrade markers: ${aveHomeDocUpgradeMarkers.map((m) => m.markerPath).join(", ")}`,
      );
    }
  } catch (err) {
    log.warn(`boot: seedAveHomeDocs failed (non-fatal): ${String(err)}`);
  }
  ctx.aveHomeDocUpgradeMarkers = aveHomeDocUpgradeMarkers;

  // §4.2 Step 0-1 + 4-5: Core services.
  const core = await bootstrapCoreServices(mainWindow, host);
  const {
    pythonPath,
    pythonRuntime,
    bashAstValidator,
    auditService,
    settingsService,
    memoryManager,
    memoryCaptureService,
    inputClassifier,
    toolRegistry,
    routeEngine,
  } = core;
  ctx.pythonPath = pythonPath;
  ctx.pythonRuntime = pythonRuntime;
  ctx.bashAstValidator = bashAstValidator;
  ctx.auditService = auditService;
  ctx.settingsService = settingsService;
  ctx.memoryManager = memoryManager;
  ctx.memoryCaptureService = memoryCaptureService;
  ctx.inputClassifier = inputClassifier;
  ctx.toolRegistry = toolRegistry;
  ctx.routeEngine = routeEngine;

  // One-shot idempotent migration: re-canonicalize user-approval keys for the
  // RFC 8785 JCS deep-recursion canonicalStringify. Runs after bootstrapCoreServices so any failure is
  // caught internally and logged without aborting boot. Noop if marker present.
  await migrateCanonicalization();

  // Shared AuditLogger + NotificationService + plugin auth-partition seeding.
  await setupAuditAndNotification(ctx);
  notifyHomeBoundaryRepairs(homePrivacy, ctx);
  notifyHomeConfigurationPreserved(configurationDiagnostics, ctx);

  // §F7: ApprovalGate with audit. Constructed BEFORE initPluginRuntime so
  // the per-plugin HostApi factory can wire `agentApproval` namespace to the
  // live gate — without this ordering, plugins receive a hostApi missing the
  // namespace and §8 main-process approval routing silently no-ops.
  const approvalGate = await createApprovalGate(
    // Resolve the current conversation owner on delivery, listing and response.
    mainWindow === null ? null : approvalSurfaceResolver(),
    ctx.bootAuditLogger,
    ctx.notificationService,
    // Tier 2 of the sub-agent approval chain, supplied as accessors rather
    // than values: the gate is built here, the reviewer that backs the
    // adjudicator is wired much later in this same boot, and both the
    // adjudicator and the policy are replaced whenever settings or login
    // re-fire that wiring. Reading them per ask is what keeps the gate on the
    // current one. In the window before the reviewer is wired the accessor has
    // nothing to return, which the gate treats as it treats every other
    // failure of this lane — the ask escalates to the user.
    {
      // Both adjudicators are replaced on every reviewer re-wire, so the
      // policy's model source is resolved per ask here rather than captured —
      // the reason this whole block is accessors.
      adjudicator: (source) =>
        source === "parent-session"
          ? ctx.parentSessionAdjudicator
          : ctx.parentAdjudicator,
      // The flag itself ships ON: `settings-defaults.ts` sets it, and the
      // settings service merges stored flags over those defaults, so both an
      // absent key and a non-boolean one resolve to the default rather than to
      // this `?? false`. What `?? false` covers is the narrower case of a
      // settings service with no feature block at all — an uninitialised read,
      // where the host cannot establish the flag's state and therefore does
      // not act on it.
      isEnabled: () =>
        settingsService.get("features")?.subAgentParentAdjudication ?? false,
      policy: () =>
        readPermissionSettings().permissions.reviewer.parentAdjudication,
      // The parent conversation's recent turns, when the operator opted in.
      // Read from the main session store the parent's own loop writes, and
      // composed by the summariser — which is where the exclusion of
      // child-authored entries, the bounds and the masking all live.
      //
      // Memoised for a few seconds because `loadSession` is a synchronous
      // whole-file read and parse on this process's only thread, and a busy
      // child can raise adjudications in a tight burst (up to `maxPerChildRun`
      // of them). Once per burst is the cost this feature is worth; once per
      // ask is a main-process stall on the approval path. Staleness is bounded
      // by the same few seconds and costs at most one missing recent turn.
      parentContext: (parentSessionId, maxTurns) =>
        readParentContextTurns(memoryManager, parentSessionId, maxTurns),
      // Whether a dock would be seen by anyone. Visible and not minimised, not
      // focused: a user reading the window beside another app is still there.
      //
      // A headless run answers no before asking the window. Window visibility
      // is the right signal for a launch that has an operator, but it is the
      // wrong one for `--exec`, where it reports whatever the boot window
      // happens to be doing: it read `true` while a bootstrap splash was up,
      // and the `second-instance` and `activate` handlers can still reveal
      // that window mid-run, flipping the answer under a run nobody joined.
      // The launch mode is the fact; the window is a proxy for it.
      isDeskAttended: () => {
        if (headless) return false;
        // Any open main window on screen counts: several may be open.
        const windows = host.desktop?.getAppWindows() ?? [getMainWindow()];
        return windows.some((win) => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
      },
      // The queue a tier-3 escalation lands in when nobody is watching the
      // run. Reached through the permission manager rather than captured: the
      // queue instance is replaced on every reviewer re-wire.
      deferredQueue: () => ctx.permissionManager?.getDeferredQueue() ?? null,
    },
  );
  ctx.approvalGate = approvalGate;
  const remoteA2AAgentActionApprover = buildSingleFlightAgentActionApprover(
    approvalGate,
    {
      onConcurrent: () =>
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "a2a-remote",
          type: "warn",
          input: "a2a-remote:approval-concurrent-denied",
        }),
      onError: () =>
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "a2a-remote",
          type: "warn",
          input: "a2a-remote:approval-error-denied",
        }),
    },
    { allowOnceOnly: true },
  );
  if (!remoteA2AAgentActionApprover)
    throw new Error("a2a-remote-approval-unavailable");
  const auditRemoteA2A = (code: string) =>
    ctx.bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "a2a-remote",
      type: "warn",
      input: `a2a-remote:${code}`,
    });
  // Read once, and handed to the runtime rather than re-read by it, so what
  // the status channel later compares against is exactly what this run used.
  const remoteA2ABootGates = snapshotA2ARemoteGates(settingsService);
  const remoteA2A = await setupRemoteA2A({
    createRuntime: () =>
      createA2ARemoteRuntime({
        gates: remoteA2ABootGates,
        encryption: host.encryption,
        settings: settingsService,
        agentActionApprover: remoteA2AAgentActionApprover,
        projectRoot,
        audit: auditRemoteA2A,
      }),
    createController: (runtime) =>
      createRemoteA2AActionController({
        runtime,
        config: settingsService.get("a2aRemote"),
        projectRoot,
      }),
    audit: auditRemoteA2A,
    logError: (err, message) => log.error({ err }, message),
  });
  ctx.a2aRemoteRuntime = remoteA2A.runtime;
  ctx.remoteA2AActionController = remoteA2A.controller;
  ctx.remoteA2AStartFailureReason = remoteA2A.startFailureReason;
  ctx.remoteA2ABootGates = remoteA2ABootGates;

  // §4.2 Step 3 + 5: PluginRuntime + per-plugin HostApi factory.
  // Sweep orphan uninstall tombstones from prior session FIRST (before
  // initPluginRuntime touches pluginsRoot for discovery). The Windows
  // uninstall path leaves tombstones under `<pluginsRoot>/+tombstones+/`
  // when SQLite WAL/SHM handles weren't released in time; this is the only
  // moment where the previous worker process is guaranteed gone.
  //
  // pluginsRoot resolution MUST go through `resolvePluginPaths()` (which
  // honors the `AVE_HOME` env override via `aveHome()`) — `homedir()`
  // alone would silently sweep `~/.ave/plugins` even in e2e fixtures
  // pointing at a per-test temp dir, masking real bugs.
  // Fire-and-forget — sweep failure must not block boot.
  const sweeperPluginPaths = resolvePluginPaths();
  // Recover crash-interrupted replacement rows before runtime discovery. A
  // pending row is visible to bundle planners but hidden from runtime loading;
  // recovery clears it only after exact prior bytes + receipt are proven or
  // restored from its durable backup metadata.
  await preparePluginRegistryForBoot(sweeperPluginPaths)
    .then(({ recovered, unresolved, removals, pendingRecoverySkipped }) => {
      if (
        removals.restored.length > 0 ||
        removals.cleaned.length > 0 ||
        removals.unresolved.length > 0
      ) {
        log.info(
          "boot: plugin-removal-recovery restored=%d cleaned=%d unresolved=%d",
          removals.restored.length,
          removals.cleaned.length,
          removals.unresolved.length,
        );
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: removals.unresolved.length > 0 ? "warn" : "info",
          input: "plugin-removal-recovery",
          output: JSON.stringify(removals),
        });
      }
      if (pendingRecoverySkipped) {
        log.warn(
          "boot: pending plugin recovery skipped because removal recovery is unresolved",
        );
      }
      if (recovered.length > 0 || unresolved.length > 0) {
        log.info(
          "boot: plugin-update-recovery recovered=%d unresolved=%d",
          recovered.length,
          unresolved.length,
        );
      }
      if (unresolved.length > 0) {
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "warn",
          input: "plugin-update-recovery-unresolved",
          output: JSON.stringify(unresolved),
        });
      }
    })
    .catch((err) => {
      log.warn(
        "boot: plugin migration/recovery failed (pending rows remain hidden): %s",
        (err as Error).message,
      );
      ctx.bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "warn",
        input: "plugin-migration-recovery-failed",
        output: (err as Error).message,
      });
    });
  // Agent plugins' data directories are tombstoned the same way at runtime.
  await sweepOrphanUninstallDirs(agentPluginDataRoot())
    .catch((err) => log.warn("boot: agent-plugin data tombstone sweep failed (non-fatal): %s", (err as Error).message));
  // Awaited, not fired and forgotten: tombstones are deleted only before any
  // confined process can run, and plugin start (below) begins that phase
  // (lib/confined-process-phase.ts).
  await sweepOrphanUninstallDirs(sweeperPluginPaths.pluginsRoot, {
    auditFailures: (failures) => {
      // Surface persistent rm failures (typically antivirus / corp endpoint
      // protection holding handles past process death) into the audit log
      // so operators see them beyond the info-level summary line.
      ctx.bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "warn",
        input: `plugin-tombstone-sweep-failed root=${sweeperPluginPaths.pluginsRoot}`,
        output: JSON.stringify(failures),
      });
    },
  })
    .then(({ swept, failed }) => {
      if (swept.length > 0 || failed.length > 0) {
        log.info(
          "boot: orphan-uninstall-sweeper swept=%d failed=%d",
          swept.length,
          failed.length,
        );
      }
    })
    .catch((err) => {
      log.warn(
        "boot: orphan-uninstall-sweeper crashed (non-fatal): %s",
        (err as Error).message,
      );
    });
  // Entries a runtime socket carry discarded wait in each live root's
  // host-only discard directory for this sweep, for the same reason.
  await sweepPluginSocketDiscardDirs(sweeperPluginPaths.pluginsRoot)
    .then((emptied) => {
      if (emptied.length > 0) log.info("boot: plugin socket discard sweep emptied=%d", emptied.length);
    })
    .catch((err) => {
      log.warn("boot: plugin socket discard sweep failed (non-fatal): %s", (err as Error).message);
    });
  // Plugins' HostApi storage moved out of `data/` into the host-only
  // `storage/` beside it. A root whose state predates that gets its storage
  // view copied over once, here, before any confined process can run.
  const PLUGIN_HOST_STORAGE_AUDIT_SKIPPED_MAX = 50;
  await migratePluginHostStorage(sweeperPluginPaths.pluginsRoot)
    .then(({ migrated, skipped, failed }) => {
      if (migrated.length > 0 || skipped.length > 0) {
        log.info("boot: plugin host storage migration migrated=%d skipped=%d", migrated.length, skipped.length);
      }
      if (failed.length > 0 || skipped.length > 0) {
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: failed.length > 0 ? "warn" : "info",
          input: "plugin-host-storage-migration",
          // Bounded: a data/ holding a node_modules or a venv skips thousands
          // of links, and one audit record should not carry them all.
          output: JSON.stringify({
            migrated,
            failed,
            skippedCount: skipped.length,
            skipped: skipped.slice(0, PLUGIN_HOST_STORAGE_AUDIT_SKIPPED_MAX),
          }),
        });
      }
    })
    .catch((err) => {
      log.warn("boot: plugin host storage migration failed (retried next boot): %s", (err as Error).message);
    });

  // Issue #749 — boot-time purge of stale write-file diff sidecar dirs.
  // Dirs older than 7 days are deleted fire-and-forget. Mirrors the
  // orphan-uninstall-sweeper pattern: failures surface to audit log only.
  const DIFF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  void purgeStaleSessionDiffDirs(DIFF_CACHE_MAX_AGE_MS)
    .then(({ swept, failed }) => {
      if (swept.length > 0 || failed.length > 0) {
        log.info(
          "boot: diff-cache-sweeper swept=%d failed=%d",
          swept.length,
          failed.length,
        );
      }
      if (failed.length > 0) {
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "warn",
          input: "diff-cache-sweep-failed",
          output: JSON.stringify(failed),
        });
      }
    })
    .catch((err) => {
      log.warn(
        "boot: diff-cache-sweeper crashed (non-fatal): %s",
        (err as Error).message,
      );
    });

  // Feed revocations from the marketplace snapshots on disk BEFORE
  // initPluginRuntime: the LOAD-boundary gate (`markRevoked`) runs inside
  // `pluginRuntime.startAll()`, and the installed-content reload the renderer
  // triggers after boot reads the same registry. Local files only; the
  // marketplace feeds it again after each sync.
  await feedRevocationsFromSnapshots({
    appVersion: getAveAppVersion(),
    home: aveHome(),
    pluginRegistryPath: resolvePluginPaths().registryPath,
    bootAuditLogger: ctx.bootAuditLogger,
  });

  // PermissionManager is built BEFORE initPluginRuntime
  // so its per-plugin revoke signal can be wired into the resolveApiKey host
  // factory at plugin construction time. The reviewer + broadcast hookups
  // below still happen after pluginRuntime exists (they depend on the
  // mainWindow getter and the registered plugins).
  const permissionManager = await createPermissionManager();
  ctx.permissionManager = permissionManager;
  // Routines SOT must exist before project reconciliation so durable routine
  // scope pruning can succeed before the permission registry is narrowed.
  const routinesStore = new RoutinesStore();
  await routinesStore.load().catch((err) => {
    log.warn(
      "boot: routines load failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  ctx.routinesStore = routinesStore;
  // Open every durable conversation namespace before reconciliation. The same
  // instances are wired into the live loops below, preserving root tombstones
  // against late writes in this process.
  const isolatedConversationMemoryManagers =
    createIsolatedConversationMemoryManagers();
  const workspaceSessionStores = [
    memoryManager,
    isolatedConversationMemoryManagers.sideChatMemoryManager,
    isolatedConversationMemoryManagers.subAgentMemoryManager,
  ];
  // Project roots are persisted permissions, so reconcile them before any
  // plugin receives a HostApi. Confirmed missing/non-directory roots are
  // removed and their path grants pruned; transient filesystem failures retain
  // the user's setting. Conversation JSONL is preserved while stale project
  // metadata is detached and reindexed before the interactive loop is created.
  const rootReconciliation = await reconcileWorkspaceRoots({
    source: "boot",
    auditLogger: ctx.bootAuditLogger,
    permissionManager,
    beforeRemove: async (runtimeRoot, context) => {
      const pruneOptions = { preserveRoots: context.preserveRoots };
      const errors: unknown[] = [];
      let prunedGrants = 0;
      try {
        await routinesStore.revokeWorkspaceRoot(runtimeRoot, pruneOptions);
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        const pruned = await permissionManager.prunePathGrantsUnderRoot(
          runtimeRoot,
          pruneOptions,
        );
        prunedGrants = pruned.length;
      } catch (error: unknown) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw Object.assign(
          new AggregateError(
            errors,
            "workspace-root-durable-scope-cleanup-failed",
          ),
          { code: "WORKSPACE_ROOT_DURABLE_SCOPE_CLEANUP_FAILED" },
        );
      }
      return prunedGrants;
    },
    beforeComplete: async (runtimeRoot) => {
      await detachWorkspaceRootSessions(runtimeRoot, workspaceSessionStores);
    },
  });

  const {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    runPluginShutdownHandlers,
    pluginPaths,
    loopbackManager,
    setBundleLifecycleHandler,
    startPlugins,
  } = await initPluginRuntime({
    host,
    projectRoot,
    settingsService,
    memoryManager,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger: ctx.bootAuditLogger,
    mainWindow,
    networkFetch: ctx.singleHopNetworkFetch,
    getMainWindow,
    openAuthWindowService: (parent, opts) => requireDesktopHost(host).openAuthWindowService(parent, opts),
    openLinkWindowService: (parent, opts) => requireDesktopHost(host).openLinkWindowService(parent, opts),
    openAuthPartitionViewerService: (parent, opts) => requireDesktopHost(host).openAuthPartitionViewerService(parent, opts),
    clearAuthPartitionService: (partition) => requireDesktopHost(host).clearAuthPartitionService(partition),
    shellOpenExternal: (url) => requireDesktopHost(host).shellOpenExternal(url),
    approvalGate,
    // Wire PermissionManager so the per-plugin
    // resolveApiKey host implementation can abort outstanding bearers when
    // permission rules change.
    permissionManager,
    // Idempotency SOT for `hostApi.hasRoutineBySource` (constructed above).
    routinesStore,
    // Recommended-work channel target for `hostApi.proposeWork`. Read lazily:
    // setupWorkBoard() runs below this call, and plugins only start after it.
    getWorkBoardStore: () => ctx.workBoardStore,
    // Alerts channel for `hostApi.raiseAlert`, read lazily for the same reason:
    // setupAlerts() runs below this call, before plugins start.
    getAlertsService: () => ctx.alertsService,
    onPluginUiRevisionChange: (pluginId) => {
      host.desktop?.revokePluginWebviews(pluginId, (appSessionId) =>
        ctx.revokePluginOperationSession?.(appSessionId),
      );
    },
    deferStart: true,
    // Lazily reads ctx: setupMarketplace() installs the closure AFTER this
    // call, but startPluginsOnce only fires at startPlugins() further below.
    refreshSandboxUnionDomains: () => ctx.refreshSandboxNetworkConfig(),
  });
  ctx.pluginRuntime = pluginRuntime;
  ctx.deploymentGuard = deploymentGuard;
  ctx.lateBinding = lateBinding;
  ctx.runPluginShutdownHandlers = runPluginShutdownHandlers;
  ctx.pluginPaths = pluginPaths;
  ctx.pluginLoopbackManager = loopbackManager;

  // Workflow system tools — services constructed up-front so the
  // tool registry can register them in one pass below. Late bindings
  // (subAgentRunner, askUserQuestionGate) hop through closures so the
  // ConversationLoop / BrowserWindow are available before the tool fires.
  // (routinesStore is constructed above — it must exist before initPluginRuntime.)
  const routinesScheduler = new RoutinesScheduler(routinesStore, async () => {
    const registry = await readPluginRegistry(pluginPaths.registryPath);
    return registry.plugins.map((entry) => pluginRuntime.resolvePluginId(entry.id));
  });
  ctx.routinesScheduler = routinesScheduler;

  await setupWorkBoard(ctx);
  await setupWorkflowStores(ctx, workspaceSessionStores);
  await setupMarketplace(ctx);
  // Before cleanup replay and plugin startup: uninstall events must reach the
  // alerts service, and declared kinds must register before their first raise.
  await setupAlerts(ctx);
  // ONE cleanup service set for every boot entry point into
  // plugins/uninstall-lifecycle. It used to be hand-spelled per call site, and
  // `emitHostEvent` — optional on the dep interface, so its absence type-checks
  // — was passed by only one of them. Without it a completed cleanup emits no
  // `plugin.uninstalled`, and that event is what drops the stale registry-entry
  // cache (boot/steps/plugin-runtime.ts, "so a re-install does not inherit the
  // previous Tier-3 bypass or manifest SHA decision"). The subscriber is
  // registered by initPluginRuntime above, so it is live for the use below.
  //
  // `refreshPluginEventBridge` is deliberately NOT in this set: it re-registers
  // the plugin event bridge against a renderer window, and the use below runs
  // before conversation wiring has one. The renderer-driven (IPC) and
  // deep-link wirings pass it because they run with a live window; boot does not.
  const pluginStateCleanupDeps = {
    pluginRuntime,
    settingsService,
    pluginPaths,
    clearAuthPartitionService: (partition: string) => requireDesktopHost(host).clearAuthPartitionService(partition),
    listPluginAuthPartitionsService: getTrackedPluginAuthPartitions,
    forgetPluginAuthPartitionsService: forgetTrackedPluginAuthPartitions,
    drainPluginInstallLockOperationsService: drainPluginInstallLockOperations,
    emitHostEvent,
    log,
  };
  const unresolvedUninstallCleanups =
    await recoverPendingPluginUninstallCleanups({
      pluginMarketplace: ctx.pluginMarketplace,
      ...pluginStateCleanupDeps,
      retirement: createPluginRetirementPort({
        settings: settingsService,
        marketplace: ctx.pluginMarketplace,
        wildcard: () => pluginRuntime.getWildcardConfigOverride(),
        appVersion: getAveAppVersion,
      }),
    });
  if (unresolvedUninstallCleanups.length > 0) {
    ctx.bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "boot",
      type: "warn",
      input: "plugin-uninstall-cleanup-unresolved",
      output: JSON.stringify(unresolvedUninstallCleanups),
    });
  }

  // §4.5.9: SystemPromptBuilder.
  // Skills use progressive disclosure: lightweight index every turn; a body
  // enters the context only as an explicit skill_load tool_result.
  // MCP-app `ui/update-model-context` slots. Constructed HERE because it has exactly two
  // consumers and they must share one instance: the builder below READS it at turn build,
  // and the gated `mcp.uiModelContext` IPC (via AppServices) WRITES it. There is no third
  // path — in particular none into the conversation loop, which is why an app's context
  // update can never start a turn.
  const mcpAppModelContext = new McpAppModelContextStore();
  ctx.mcpAppModelContext = mcpAppModelContext;

  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager,
    toolRegistry,
    pluginRuntime,
    getAvailableSkills: () => ctx.skillStore.listCatalogSync(),
    getAppModelContext: (sessionId) =>
      mcpAppModelContext.buildSection(sessionId),
    mcpServerGuidanceProvider: () =>
      ctx.mcpManager
        .listServers()
        .flatMap((server) =>
          server.status === "connected" &&
          typeof server.instructions === "string" &&
          server.instructions.trim().length > 0
            ? [{ serverId: server.id, instructions: server.instructions }]
            : [],
        ),
  });
  ctx.systemPromptBuilder = systemPromptBuilder;

  // Subscription-authenticated reviewers run before conversation wiring, so
  // construct the one main-owned provider factory here and share it with both
  // the reviewer and all conversation-loop variants below.
  // ChatGPT plan usage keeps its account record in the encrypted secret store and sends every request through the
  // host network stack behind its own egress allowlist. Configured before the subscription service is first created.
  configureChatGptPlanRuntime({
    secrets: settingsService,
    networkFetch: host.networkFetch,
    onEvent: (event) => {
      try {
        ctx.bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "subscription-runtime",
          type: event.failure ? "warn" : "info",
          // Codes only: the session event carries no token, URL or account detail.
          input: JSON.stringify({ provider: "chatgpt-plan", event: event.event, ...(event.failure ? { failure: event.failure } : {}) }),
        });
      } catch {
        // Auditing never changes a session outcome.
      }
    },
  });
  ctx.subscriptionProviderFactory = createSubscriptionChatLoopBindings({
    auditLogger: ctx.bootAuditLogger,
  }).subscriptionProviderFactory;

  // Permission policy P4 — reviewer agent + PermissionManager broadcast wiring.
  wireReviewerAndPermissions(ctx);

  // Permission policy P4 — Layer 6 plugin tool execution surface + delegate.
  await setupPluginToolExecutor(ctx);

  // #17 follow-up — recover durable rationale authority before loop publication.
  await wireRationaleHost(ctx);

  // §4.5 + §7: routine engine, ConversationLoop, late bindings, SubAgentRunner,
  // WorkBoardEngine/reporter, and manifest-driven plugin IPC bridges.
  await wireConversation(
    ctx,
    [
      ...new Set([
        ...rootReconciliation.removed.map((removed) => removed.runtimePath),
        ...(rootReconciliation.inactiveRoots ?? []),
      ]),
    ],
    isolatedConversationMemoryManagers,
    headless ? "unavailable" : "interactive",
  );

  // §7: RoutinesScheduler v2 execution-branch wiring.
  wireRoutinesScheduler(ctx);

  // §9.5: MCP servers + signed marketplace artifact stores.
  await setupMcp(ctx);
  // An interrupted bootstrap disconnects MCP before it stops the plugin
  // runtime, as the normal shutdown does (see runIncompleteBootShutdown).
  registerBootMcpDisconnect(() => ctx.mcpManager.disconnectAll());

  // Skills, Hook runtime, and external MCP manager now all exist. Bind the
  // lifecycle callback and replay boot-loaded plugins because initial startAll
  // intentionally does not emit onEnable.
  const pluginBundleLifecycle = new PluginBundleLifecycle({
    pluginRuntime,
    receiptCacheRoot: pluginPaths.cacheRoot,
    skillStore: ctx.skillStore,
    skillOverlay: ctx.skillOverlay,
    personaPromptStore: ctx.personaPromptStore,
    onContributionsUpdated: () => {
      for (const win of host.desktop?.getAppWindows() ?? [getMainWindow()]) {
        if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.prompts.updated);
      }
    },
    hookManager: ctx.scriptHookManager,
    mcpManager: ctx.mcpManager,
    loopbackManager: ctx.pluginLoopbackManager,
    revokeOperationGeneration: ctx.revokePluginOperationGeneration,
  });
  ctx.pluginBundleLifecycle = pluginBundleLifecycle;
  pluginRuntime.setGenerationAccess(pluginBundleLifecycle);
  ctx.mcpManager.setPluginGenerationAccess(pluginBundleLifecycle);
  // App-plugin OAuth servers authenticate and reconnect through their generation; the
  // registry names every installed plugin, enabled or not. A missing, unreadable or
  // mid-replacement registry cannot vouch for that, so no stored sign-in is pruned then.
  ctx.mcpManager.registerBundledCredentialSource("plugin", pluginBundleLifecycle.bundledMcpCredentialSource(
    () => vouchedInstalledPluginIds(pluginPaths.registryPath),
  ));
  ctx.scriptHookManager.setPluginGenerationAccess(pluginBundleLifecycle);
  setBundleLifecycleHandler?.(pluginBundleLifecycle);
  await pluginBundleLifecycle.recoverRetirements();

  // §691: OS-level tool sandbox — decided exactly once here at boot, and
  // BEFORE startPlugins(): an out-of-process plugin's factory spawns its
  // confined child inside startAll(), and wrapWorkerCommand refuses to build
  // a spawn plan while ASRT is not yet active. The network union computed at
  // init predates pluginRuntime.load(), so startPluginsOnce refreshes it
  // (same builder, safe global live-swap) after load() and before startAll().
  await initSandboxGate(ctx);

  await startPlugins();

  log.info(
    "boot: ready (%d tools, %d plugins, %d mcp)",
    toolRegistry.size,
    pluginRuntime.listPluginIds().length,
    ctx.mcpManager.listServers().filter((s) => s.status === "connected").length,
  );

  // Watcher telemetry consumer — plugin-emitted watcher poll events are
  // appended to ~/.ave/logs/watcher-poll.jsonl. This is the pre-metrics
  // pipeline raw source for cold-seed latency / payload distribution tuning.
  const watcherTelemetryLogPath = resolve(
    aveHome(),
    "logs",
    "watcher-poll.jsonl",
  );
  const watcherTelemetryCollector = startWatcherTelemetryCollector({
    filePath: watcherTelemetryLogPath,
    subscribe: (type, handler) => onEvent(type, handler),
    log: (msg, meta) => log.warn({ meta }, msg),
  });
  registerShutdownHook("watcher-telemetry", () => watcherTelemetryCollector.stop());

  // Issue #749 — clean up CURRENT session's diff-cache dir on quit.
  // NOTE: only clears the CURRENT session's diff-cache dir. Diff caches from
  // sessions touched earlier in this process lifetime persist on disk until
  // the 7-day boot-time purge. Acceptable trade-off because:
  //   (a) cache content is owner-only (0o600),
  //   (b) boot purge backstop exists,
  //   (c) tracking all touched-session-ids would add lifecycle complexity.
  // Fire-and-forget: quit must not block on I/O.
  registerShutdownHook("diff-cache", () => {
    const sid = ctx.conversationLoop.getSessionId();
    if (sid)
      void clearSessionDiffCache(sid).catch((err: unknown) => {
        log.warn(
          "before-quit: diff-cache clear failed: %s",
          (err as Error).message,
        );
      });
  });

  // Starred store + feedback store.
  const starredStore = new StarredStore();
  const feedbackStore = new FeedbackStore();
  ctx.starredStore = starredStore;
  ctx.feedbackStore = feedbackStore;

  // §4.2 Step 8: Post-boot — release prep (telemetry/crash/updater) + plugin update-check.
  const serviceClient = createServiceClient(ctx.singleHopNetworkFetch);
  const { telemetry, pluginTelemetry, autoUpdaterStop } = wireReleasePrep({
    mainWindow,
    settingsService,
    bootAuditLogger: ctx.bootAuditLogger,
    networkFetch: ctx.singleHopNetworkFetch,
    tracing: ctx.tracing,
    serviceClient,
    discretionaryEgress: !headless,
  }, host);
  // The announcement poller exists to push a banner at a renderer. A headless
  // run has neither the renderer nor the lifetime, so it does not schedule it.
  // The marketplace's sync and update notices start with the window (main.ts).
  if (!headless) {
    wireAnnouncementCheck({
      getMainWindow,
      settingsService,
      listAnnouncements: () => serviceClient.announcements(),
    });
    // Daily at most, on by default (design model-capability-catalog.md §7);
    // it writes the cache only, and the next launch reads it. A headless run
    // resolves against the cache or its AVE_MODEL_CATALOG pin and fetches nothing.
    void wireModelCatalogRefresh({ settingsService, fetchImpl: ctx.singleHopNetworkFetch });
  }
  ctx.telemetry = telemetry;
  ctx.pluginTelemetry = pluginTelemetry;
  ctx.autoUpdaterStop = autoUpdaterStop;

  assertBootContextReady(ctx);
  return assembleAppServices(ctx);
}
