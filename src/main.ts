



import { app, net, powerMonitor } from "electron";
import { desktopSecretEncryption } from "./main/desktop-secret-encryption.js";
import { writeSync } from "node:fs";
import { onLocaleChange, t } from "./i18n/index.js";
import { registerIpcHandlers, unregisterPluginWebview } from "./ipc-bridge.js";
import { installHtmlPreviewPartitionBlock } from "./main/html-preview-partition.js";
import { isAuthOwned } from "./main/auth-window-registry.js";
import { isLinkOwned } from "./main/link-window-registry.js";
import { shouldBlockGlobalWebviewNavigation } from "./main/webview-navigation-policy.js";
import { installSideBrowserPartitionPolicy } from "./main/side-browser-webview.js";
import { findAveProtocolUri } from "./main/ave-protocol.js";
import {
  decideAveProtocolClientRegistration,
  getPackagedWindowsProtocolMarkerState,
} from "./main/ave-protocol-registration.js";
import { setIsPackaged } from "./boot/dev-flags.js";
import { createLogger } from "./lib/logger.js";
import {
  isAppUpdateInstallPrepared,
  isAppUpdateInstallRequested,
  markAppUpdateInstallPrepared,
} from "./main/app-update-install-intent.js";
import { distRoot, projectRoot } from "./main/main-paths.js";
import { applyRuntimeAppIcon, runEarlyBootEnv } from "./main/early-boot-env.js";
import { defaultAveHome } from "./shared/ave-home.js";
import { ensureCorporateCaInjected } from "./main/corp-ca-runtime.js";
import { readPersistedCorpCaConfigSync } from "./main/persisted-corp-ca.js";
import { loadMainStartupDependencies } from "./main/startup-dependencies.js";
import { showConfigurationBootError } from "./main/configuration-boot-error.js";
import { updateSplashStatus, waitForMinimumBootstrapSplash } from "./main/bootstrap-splash.js";
import { registerShutdownHook, runAppShutdownCleanup, runShutdownHooks } from "./main/app-shutdown.js";
import {
  createWindow,
  getAppWindows,
  loadMainInterface,
  showMainWindow,
} from "./main/main-window.js";
import { refreshApplicationMenu } from "./main/app-menu.js";
import { ensureTray, openNewMainWindow, refreshTrayMenu, showOrCreateMainWindow, showOrCreatePrimaryMainWindow } from "./main/app-tray.js";
import { configureNativeWindowCoordinator } from "./main/native-window-coordinator.js";
import { readStartupLaunchState } from "./main/startup-launch.js";
import { reconcileOsIntegrationOnBoot } from "./main/reconcile-os-integration.js";
import { maybeStartLocalApiServer } from "./main/local-api-server.js";
import { createConversationSurfaceRuntime } from "./engine/conversation-surface-runtime.js";
import { createConversationCommandPort } from "./main/conversation-command-port.js";
import { createA2ALoopbackRuntime } from "./main/a2a-loopback-runtime.js";
import { maybeStartRemoteA2AReceiverServer } from "./main/a2a-remote-receiver-server.js";
import {
  maybeStartTailnetObserverServer,
  loadTailnetObserverConfig,
} from "./main/tailnet-surface-server.js";
import { createTailnetObserverConfigService } from "./main/tailnet-observer-config-service.js";
import { createTailnetPairedSharingRuntime } from "./main/tailnet-paired-sharing-runtime.js";
import { nudgeTelegramBridgeServer, stopTelegramBridgeServer } from "./main/telegram-bridge-server.js";
import { createTelegramConnectionStore } from "./main/telegram-connection-store.js";
import { createNetworkOnlineSource, createTelegramConnectionService } from "./main/telegram-connection-service.js";
import { createTelegramShareChangeWatcher } from "./main/telegram-share-identity.js";
import {
  reconcileTelegramActorKey,
  startTelegramConnectionActivation,
  telegramConversationDigest,
  telegramConversationDigestFor,
} from "./main/telegram-connection-activation.js";
import { createTailnetSharingOwnerService } from "./main/tailnet-sharing-owner-service.js";
import { getAveAppVersion } from "./shared/app-version.js";
import { installNativeEditContextMenu } from "./main/native-edit-context-menu.js";
import { handleAveUri, aveDevLog } from "./main/ave-deep-link.js";
import {
  EXEC_FAILURE_EXIT_CODE,
  GUI_BOOT_FAILURE_EXIT_CODE,
  EXEC_LOCKED_EXIT_CODE,
  EXEC_USAGE_EXIT_CODE,
  execModeRequested,
  parseExecFlags,
  readAllStdin,
  runExecTurn,
  waitForExecRelease,
} from "./main/exec-mode.js";
import { isAuthorizedWorkspaceProjectRoot } from "./main/project-root-authorization.js";
import {
  initializeWorkloadBroker,
  isActiveWorkloadBrokerCwd,
} from "./workload/runtime.js";
import {
  getMainWindow,
  getPendingAveUri,
  getServices,
  isAppShutdownCompleted,
  isAppShutdownStarted,
  isPendingRendererReload,
  setPendingAveUri,
  setRendererReloadReady,
  setServices,
} from "./main/app-state.js";

const log = createLogger("ave");

// Early boot environment — workspace cwd, plugin-asset protocol scheme, WSL/GPU
// switches, app name/AppUserModelId, and packaged-env scrub.
// MUST run before app.whenReady(); called here at module load.
// The directory the process was started from. `runEarlyBootEnv()` re-anchors
// the process to `~/.ave/workspace` a line later, and a headless `--exec`
// without `--exec-cwd` must work on the caller's directory, not the anchor.
// Read only for a headless launch: a desktop launch from an unlinked directory
// must not fail here, before the anchor gives the process a directory again.
const launchCwd = execModeRequested(process.argv) ? process.cwd() : null;
runEarlyBootEnv();

/**
 * `--plugin-smoke=<id1>,<id2>,...` CLI flag.
 *
 * Verifies that the named plugins mount + init correctly during boot, then
 * exits 0 (success) or 1 (any plugin missing / failed to initialize). Used
 * by per-plugin smoke tests in CI and by the boot verification gate.
 *
 * Returns null if the flag is not present.
 */
function parsePluginSmokeFlag(argv: readonly string[]): string[] | null {
  for (const arg of argv) {
    if (arg.startsWith("--plugin-smoke=")) {
      const raw = arg.slice("--plugin-smoke=".length);
      const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return ids;
    }
  }
  return null;
}

const pluginSmokeIds = parsePluginSmokeFlag(process.argv);

// `--exec` / `--set-secret`. Parsed at module load beside the smoke flag so a
// malformed command line is already known when the branch below is reached.
const execRequest = parseExecFlags(process.argv, launchCwd);
// The single fact that separates a run with a viewer from a one-shot run
// without one. `bootstrap()` names it `BootLaunch`; the window needs the same
// answer, so it is derived once here rather than re-tested at each site.
const bootLaunch = execRequest === null ? "interactive" : "headless";
let guiBootstrapFailed = false;

async function main() {
  // A malformed `--exec` / `--set-secret` command line is answered before a
  // window, a splash, or a service exists: there is nothing to boot for.
  if (execRequest !== null && "error" in execRequest) {
    process.stderr.write(`${execRequest.error}\n`);
    process.exitCode = EXEC_USAGE_EXIT_CODE;
    app.quit();
    return;
  }
  if (execRequest?.workloadBroker) {
    await initializeWorkloadBroker(execRequest.workloadBroker);
    if (!execRequest.turn || !isActiveWorkloadBrokerCwd(execRequest.turn.cwd)) {
      throw new Error("workload-broker:cwd-binding-mismatch");
    }
  }
  const startDesktop = async () => {
    configureNativeWindowCoordinator({
      showOrCreateMainWindow,
      openNewMainWindow,
      refreshNativeChrome: () => {
        refreshApplicationMenu();
        refreshTrayMenu();
      },
    });
    // Native menus are built once from `t()` and plugin labels resolved at that
    // moment; a language switch must rebuild them or they keep the old one.
    onLocaleChange(() => {
      refreshApplicationMenu();
      refreshTrayMenu();
    });
    createWindow({ headless: bootLaunch === "headless" });
    updateSplashStatus(t("be_main.splashCheckingCerts"));
    return loadMainStartupDependencies(
      () => import("./desktop-boot.js"),
      // The settings file is read synchronously here because injection has to
      // happen before the first outbound request, which is well before
      // `bootstrap()` constructs SettingsService.
      () => ensureCorporateCaInjected(readPersistedCorpCaConfigSync(app.getPath("userData"))),
      () => updateSplashStatus(t("be_main.splashLoadingSettings")),
    );
  };
  const operatorAttestationPath = execRequest?.operatorAttestationPath;
  const desktopBoot = operatorAttestationPath !== undefined
    ? await (await import("./main/operator-attestation-boot.js"))
      .startAfterOperatorAttestation(operatorAttestationPath, startDesktop)
    : await startDesktop();
  const { bootstrap } = desktopBoot;

  // Drive splash status from the real bootstrap pipeline so the text below
  // the wordmark matches what's actually happening rather than cycling
  // through a setInterval list. The fallback idle cycle inside the splash
  // still runs until the first explicit update lands.
  // `bootLaunch` is the single fact boot derives every service-connection
  // decision from: a headless one-shot run opens none of its own.
  const services = await bootstrap(projectRoot, getMainWindow(), () => getMainWindow(), bootLaunch);
  setServices(services);

  updateSplashStatus(t("be_main.splashOpeningWorkspace"));

  // `--plugin-smoke=<id,...>` exits early after verifying that the
  // named plugins mounted + initialized. Boot already awaited
  // pluginRuntime.startAll(); here we just confirm the named ids are loaded.
  if (pluginSmokeIds !== null) {
    const loadedIds = new Set(services.pluginRuntime.listPluginIds());
    const missing = pluginSmokeIds.filter((id) => !loadedIds.has(id));
    if (missing.length > 0) {
      log.error(
        "plugin-smoke: %d/%d plugins missing: %s",
        missing.length,
        pluginSmokeIds.length,
        missing.join(","),
      );
      app.exit(1);
      return;
    }
    log.info(`all ${pluginSmokeIds.length} plugins initialized`);
    app.exit(0);
    return;
  }

  // The headless request runs against the freshly booted service graph. An
  // explicitly retained session waits for release inside runExecTurn; every
  // completed request then takes the ordinary shutdown path below.
  //
  // `app.quit()` rather than `app.exit()` — unlike the smoke flag above, this
  // run has WRITTEN things. The `before-quit` handler's runAppShutdownCleanup
  // is what flushes the session transcript and the audit log, and a hard exit
  // would drop exactly the record a benchmark run came to produce.
  if (execRequest !== null) {
    process.exitCode = await runExecTurn(
      {
        conversationLoop: services.conversationLoop,
        permissionManager: services.conversationLoop.permissionManager,
        approvalGate: services.approvalGate,
        settingsService: services.settingsService,
        stdout: process.stdout,
        stderr: process.stderr,
        readStdin: readAllStdin,
        isAuthorizedProjectRoot: isAuthorizedWorkspaceProjectRoot,
        waitForRelease: waitForExecRelease,
        flushTelemetry: services.flushTracing,
      },
      execRequest,
    );
    app.quit();
    return;
  }

  // One host-owned source for every main-conversation surface. It outlives the
  // opt-in Local API transport so Electron remains the canonical producer.
  const conversationSurfaceRuntime = createConversationSurfaceRuntime();

  // Commands, like events, have one host-owned entrypoint. Surface adapters
  // receive this instance rather than recreating their own send path.
  const conversationCommandPort = createConversationCommandPort(
    {
      ...services,
      getMainWindow: () => getMainWindow(),
      getAppWindows,
      conversationSurfaceRuntime,
    },
    conversationSurfaceRuntime,
  );
  // Pairing/share state is created once at boot and injected into both local
  // owner controls and the Tailnet listener. A failed OS-encrypted setup never
  // falls back to a second runtime or a plaintext identity secret.
  const getCurrentConversationId = () => services.conversationLoop.getSessionId();
  let tailnetPairedSharingRuntime:
    | Awaited<ReturnType<typeof createTailnetPairedSharingRuntime>>
    | undefined;
  let tailnetPairedSharingBootstrapUnavailable = false;
  let tailnetSharingOwnerService:
    | ReturnType<typeof createTailnetSharingOwnerService>
    | undefined;
  try {
    const { config: tailnetConfig } = await loadTailnetObserverConfig();
    if (tailnetConfig?.pairedSharingEnabled) {
      tailnetPairedSharingRuntime = await createTailnetPairedSharingRuntime({
        encryption: desktopSecretEncryption,
        getCurrentConversationId,
      });
      tailnetSharingOwnerService = createTailnetSharingOwnerService({
        runtime: tailnetPairedSharingRuntime,
        getCurrentConversationId,
      });
    }
  } catch (err) {
    tailnetPairedSharingBootstrapUnavailable = true;
    log.error(
      { err },
      "tailnet paired sharing failed to initialize; owner controls and listener stay unavailable",
    );
  }



  let telegramConnectionService:
    | ReturnType<typeof createTelegramConnectionService>
    | undefined;
  try {
    const telegramStore = createTelegramConnectionStore({
      conversationDigestFor: telegramConversationDigest,
    });
    await telegramStore.open();
    telegramConnectionService = createTelegramConnectionService({
      store: telegramStore,
      settingsService: services.settingsService,
      // Chromium's stack, not Node's: it is the one that resolves the machine's
      // proxy configuration and reads its trust store, so the Bot API is
      // reached over the route the machine is configured for.
      networkFetch: services.singleHopNetworkFetch,
      bridgeControl: {
        start: (hooks) => startTelegramConnectionActivation({
          encryption: desktopSecretEncryption,
          store: telegramStore,
          settingsService: services.settingsService,
          conversationSurfaceRuntime,
          conversationCommandPort,
          getCurrentConversationId,
          networkFetch: services.singleHopNetworkFetch,
          // A fatal poll outcome tears the activation down through the same
          // owner-initiated path a manual disconnect uses.
          stopBridge: () => stopTelegramBridgeServer("user"),
          // Read at activation time, not boot order: the gate is created with
          // the main window, after this service but before any owner-driven
          // activation can run. Absent keeps approvals desk-only.
          ...(services.approvalGate ? { approvalGate: services.approvalGate } : {}),
          onPollHealth: hooks.onPollHealth,
          log: (message: string) => log.info(message),
        }),
        stop: (reason: "shutdown" | "user") => stopTelegramBridgeServer(reason),
        nudge: () => {
          nudgeTelegramBridgeServer();
        },
      },
      // Reconnect on wake and when the network returns, as the reference remote
      // surfaces do, instead of waiting out a backoff sized for an outage.
      onSystemResume: (listener) => {
        powerMonitor.on("resume", listener);
        return () => powerMonitor.removeListener("resume", listener);
      },
      onNetworkOnline: createNetworkOnlineSource(() => net.isOnline()),
      // Sequenced by the service ahead of its own credential read: one keychain
      // reset takes the bot token and the actor key together, and only the
      // service can put the reconcile before the read that would abandon it.
      reconcileActorKey: () => reconcileTelegramActorKey({ store: telegramStore, encryption: desktopSecretEncryption }),
      getCurrentConversationId,
      conversationDigestFor: (conversationId: string) => {
        const digest = telegramConversationDigestFor(telegramStore, conversationId);
        // The service treats a throw here as "no digest available", which is
        // the correct answer before a bot has been verified.
        if (digest === null) throw new Error("telegram-conversation-digest-unavailable");
        return digest;
      },
      // The same source the conversation list is built from, so the owner is
      // never told a share points at something they cannot see.
      conversationExists: (conversationId: string) =>
        services.memoryManager.hasSessionTranscript(conversationId),
    });
    const disposeTelegramConnection = telegramConnectionService.dispose;
    registerShutdownHook("telegram-connection-reconnect", () => disposeTelegramConnection());
    // Any change to the paired share retires an armed Away Authority grant.
    //
    // The grant is a desk gesture about the share that existed when it was
    // made. A revoke, re-share, pause, disconnect or re-pair replaces that
    // share with a different one, and the per-call authority re-check cannot
    // see the difference: a re-pair mints a fresh authority that is perfectly
    // current.
    //
    // The subscription is the store's single mutation chokepoint, but the raw
    // signal is far too broad to act on: the poll offset lives in the same
    // document and advances after every inbound message, so retiring on "the
    // document changed" would retire the grant on the exact traffic it exists
    // to answer. `createTelegramShareChangeWatcher` keeps the chokepoint and
    // compares the share's identity instead.
    telegramConnectionService.subscribe(
      createTelegramShareChangeWatcher({
        readOwnerSnapshot: () => telegramStore.ownerSnapshot(),
        onShareChanged: () => {
          services.approvalGate?.retireAwayAuthority("share-lifecycle");
        },
      }),
    );
  } catch (err) {
    log.error({ err }, "telegram connection service failed to initialize (continuing boot)");
  }

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  const ipcRegistration = registerIpcHandlers(
    services,
    () => getMainWindow(),
    getAppWindows,
    conversationSurfaceRuntime,
    conversationCommandPort,
    tailnetSharingOwnerService,
    telegramConnectionService,
    createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => tailnetPairedSharingBootstrapUnavailable,
    }),
  );

  // #1436: start the OPT-IN loopback local API server (OFF by default; enabled
  // via Settings → system.localApiServer OR env AVE_LOCAL_API=1). Wrapped in
  // try/catch so this aux transport can NEVER brick app boot — when the gate is
  // off maybeStartLocalApiServer returns null immediately (no code path throws).
  try {
    const localApi = await maybeStartLocalApiServer({
      services,
      getMainWindow: () => getMainWindow(),
      getAppWindows,
      conversationCommandPort,
      conversationSurfaceRuntime,
      createA2ARouter: ({ approveAgentAction }) => {
        const project = services.conversationLoop.getSessionProjectContext();
        return createA2ALoopbackRuntime({
          services,
          project: {
            root: project.projectRoot ?? services.conversationLoop.getSessionExecutionCwd(),
            ...(project.projectName ? { name: project.projectName } : {}),
          },
          appVersion: getAveAppVersion(),
          approveAgentAction,
        });
      },
      log: (m) => log.info(m),
    });
    if (localApi) log.info(`local API server listening on 127.0.0.1:${localApi.port}`);
  } catch (err) {
    log.error({ err }, "local API server failed to start (continuing boot)");
  }

  // Tailnet is a separate, default-OFF ingress. Its observer is always
  // read-only unless the boot environment explicitly enables the narrow
  // controller capability; it never exposes Local API/A2A or configures Serve.
  try {
    const observer = await maybeStartTailnetObserverServer({
      encryption: desktopSecretEncryption,
      conversationSurfaceRuntime,
      conversationCommandPort,
      getCurrentConversationId,
      tailnetPairedSharingRuntime: tailnetPairedSharingBootstrapUnavailable
        ? null : tailnetPairedSharingRuntime,
      isConversationBusy: () => conversationSurfaceRuntime.activity.isBusy(),
      // An own-device pairing the owner never clicked to approve is still a
      // grant, so it lands in the same audit log every other one does.
      auditLogger: services.auditLogger,
      log: (message) => log.info(message),
    });
    if (observer) {
      log.info("tailnet observer listening on 127.0.0.1:" + observer.port);
    }
  } catch (err) {
    log.error({ err }, "tailnet observer failed to start (continuing boot)");
  }

  // Telegram is a separately configured external-platform adapter. It remains
  // OFF until the owner connects a bot from the desktop; it never registers a
  // webhook and never shares Tailnet, Local API, or A2A authority.
  try {
    if (telegramConnectionService) {
      // Resume whatever the owner left connected. A paused or disconnected
      // store is a no-op, so nothing reaches Telegram until they ask for it.
      await telegramConnectionService.resumeStoredConnection();
    }
  } catch (err) {
    log.error({ err }, "telegram bridge failed to start (continuing boot)");
  }

  // The remote A2A receiver ingress has an independent immutable gate and
  // listener; it never widens or reuses the local API route family. The app
  // binds only loopback; a separately trusted HTTPS tunnel/terminator owns
  // public ingress.
  try {
    const receiver = await maybeStartRemoteA2AReceiverServer({
      services,
      log: (message) => log.info(message),
    });
    if (receiver) {
      log.info(`remote A2A receiver listening on 127.0.0.1:${receiver.port}`);
    }
  } catch (err) {
    log.error({ err }, "remote A2A receiver failed to start (continuing boot)");
  }

  // Start the routines scheduler AFTER IPC handlers are wired so a
  // routine past-due at boot fires into a renderer that already has a
  // `ave:routines:fired` listener attached. The scheduler is otherwise
  // safe to start at any time — `start()` is idempotent.
  services.startRoutinesScheduler?.();

  // Same deferral rationale as the routines scheduler: start the Work Board
  // due-soon scanner after IPC + plugin bus are wired so the first emit of
  // `work_board.work_item.due_soon` reaches any subscribed consumer.
  services.startWorkBoardDueSoon?.();
  // And the alerts expiry sweep, so a card whose lifetime ends is withdrawn
  // from a renderer that is listening.
  services.startAlerts?.();

  refreshApplicationMenu();
  ensureTray();
  setRendererReloadReady(true);

  // Reconcile OS-level global shortcuts + login item from persisted
  // settings once the tray + services exist. Registration failures are surfaced
  // via NotificationService (No-Fallback): a global-shortcut conflict inside
  // reconcileGlobalShortcuts, and a login-item apply failure via
  // notifyStartupLaunchFailureIfNeeded. Wiring extracted to
  // reconcileOsIntegrationOnBoot so the conflict-notification path is unit-
  // testable without a full main() startup.
  const initialSettings = services.settingsService.getAll();
  reconcileOsIntegrationOnBoot(initialSettings);
  // Detect a hidden (tray-only) auto-launch so the first window show is
  // suppressed. Login launches use the persisted minimized preference on
  // macOS; Windows uses the --hidden launch argument.
  const launchedHidden = readStartupLaunchState().wasOpenedAsHidden;

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  const mainWindow = getMainWindow();
  if (mainWindow) {
    if (!isPendingRendererReload()) await waitForMinimumBootstrapSplash();
    await loadMainInterface(mainWindow, isPendingRendererReload() ? "bootstrap-recovery" : "bootstrap-complete");
    // Hidden auto-launch: loadMainInterface shows the window; hide it back so
    // the app starts in the tray. A user-initiated launch (launchedHidden
    // false) is unaffected.
    if (launchedHidden && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }

  // Process any ave:// URI that arrived before services were ready.
  // Deferred until after loadFile so IPC handlers are registered and the
  // renderer's deep-link listener is active.
  const pendingAveUri = getPendingAveUri();
  if (pendingAveUri) {
    void handleAveUri(pendingAveUri);
    setPendingAveUri(null);
  }

  // The marketplace's boot sync and installs, then the periodic sync (design
  // §7.3, §10.2). After the load so the renderer hears what they publish.
  void ipcRegistration.gitMarketplace.startBackground();
}

// ave:// custom URI scheme.
// `app.setAsDefaultProtocolClient` rewrites a user-wide OS default (HKCU on
// Windows, the LaunchServices default on macOS, the xdg default on Linux), so
// only a packaged production app on its real profile claims it. Unpackaged,
// E2E, relocated-AVE_HOME and explicit --user-data-dir launches skip, so a dev,
// test or CDP run cannot take the installed app's deep links. The per-machine
// Windows installer owns the packaged association in HKLM; its adjacent marker
// keeps Electron's setter from shadowing it with HKCU. The decision is the pure
// `decideAveProtocolClientRegistration`; it must stay synchronous and before
// the single-instance lock.
setIsPackaged(app.isPackaged);
const aveProtocolClientRegistration = decideAveProtocolClientRegistration({
  isPackaged: app.isPackaged,
  platform: process.platform,
  env: process.env,
  defaultAveHome: defaultAveHome(),
  hasUserDataDirSwitch: app.commandLine.hasSwitch("user-data-dir"),
  probeWindowsMarker: () => getPackagedWindowsProtocolMarkerState(process.execPath),
});
if (aveProtocolClientRegistration.register) {
  if (!app.setAsDefaultProtocolClient("ave")) {
    log.warn(
      "setAsDefaultProtocolClient('ave') failed — deep links may not work in this environment",
    );
  }
} else if (aveProtocolClientRegistration.reason === "nsis-marker-unknown") {
  log.warn(
    "Unable to verify the packaged Windows protocol marker; skipped self-registration",
  );
} else {
  log.info(
    `Skipped ave:// protocol client self-registration (${aveProtocolClientRegistration.reason})`,
  );
}

// macOS: URI delivered via open-url event (register before whenReady to avoid missing cold-start)
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (bootLaunch === "headless") return;
  void handleAveUri(url);
});

// Windows/Linux: URI delivered as argv of second instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // A headless run must never look like an empty successful turn: say why
  // nothing happened and exit with a code a runner can retry on.
  if (execRequest !== null) {
    // Synchronous: `process.stderr` is asynchronous on a macOS pipe, and the
    // hard exit below would drop the line a runner needs to explain the code.
    writeSync(
      2,
      "exec: another Ave process holds the single-instance lock; quit it before running --exec\n",
    );
    // Before `whenReady` there is no `will-quit` to carry the code (see the
    // handler below), and nothing has been booted that a hard exit could lose.
    // The process ends here; the `app.quit()` below is the desktop
    // second-instance path.
    app.exit(EXEC_LOCKED_EXIT_CODE);
  }
  // We are NOT the primary instance — quit immediately and let the existing
  // primary handle the protocol URL via its `second-instance` listener.
  // Do NOT run bootstrap on this doomed process: pino-pretty's thread-stream
  // worker exits with the process, and the first `log.info(...)` afterwards
  // would throw "the worker has exited" — Electron surfaces that as an
  // uncaught-exception dialog the user sees during marketplace plugin
  // install. Quitting before `whenReady` keeps the second-instance exit
  // silent. Regression guard: `src/__tests__/main-single-instance-gate.test.ts`.
  app.quit();
} else {
  const coldStartUri = findAveProtocolUri(process.argv);
  if (coldStartUri) {
    setPendingAveUri(coldStartUri);
  }
  app.on("second-instance", (_event, argv) => {
    if (bootLaunch === "headless") return;
    // Redact `--user-data-dir=<absolute path>` before logging — the path
    // contains the OS username and on shared/VDI/corp boxes that's PII that
    // would otherwise land in screenshots, support bundles, and stdout
    // capture tools.
    const safeArgv = argv.map((a) =>
      a.startsWith("--user-data-dir=") ? "--user-data-dir=<redacted>" : a,
    );
    aveDevLog("[ave] second-instance event fired", { argv: safeArgv });
    const url = findAveProtocolUri(argv);
    aveDevLog("[ave] second-instance URL extracted", { url });
    if (url) {
      // A deep link is addressed to the running app: handle it and surface
      // the window in use, as before.
      void handleAveUri(url);
      const mainWindow = getMainWindow();
      if (mainWindow) {
        showMainWindow(mainWindow);
      }
      return;
    }
    // Launching the app again (dock/taskbar/launcher) brings the primary
    // window back; only an explicit "New Window" action opens another.
    showOrCreatePrimaryMainWindow("second-instance");
  });

  // whenReady is scoped to the primary-instance branch — second-instance
  // processes must NOT run main(). See the comment on `app.quit()` above.
  app.whenReady().then(() => {
    applyRuntimeAppIcon();
    installHtmlPreviewPartitionBlock();
    installSideBrowserPartitionPolicy();
    void main().catch(async (error) => {
      log.error({ err: error }, "bootstrap failed");
      if (bootLaunch !== "headless" && execRequest === null) {
        showConfigurationBootError(error);
        try {
          const { showProviderSettingsStartupError } = await import("./main/provider-settings-startup-error.js");
          await showProviderSettingsStartupError(error, app.getPath("userData"), app.getLocale());
        } catch (displayError) {
          log.error({ err: displayError }, "startup error display failed");
        }
      }
      // Preserve any code already chosen by the run. A failed interactive
      // launch also needs a code that survives app.quit().
      if (execRequest === null) guiBootstrapFailed = true;
      if (process.exitCode === undefined) {
        process.exitCode = execRequest === null
          ? GUI_BOOT_FAILURE_EXIT_CODE
          : EXEC_FAILURE_EXIT_CODE;
      }
      app.quit();
    });
  });
}

// render_html tool webview hardening — the <webview> element carries LLM
// authored HTML. It loads a data: URL and must never navigate anywhere else
// (a click on <a href="…"> would bypass the injected meta CSP by moving to a
// new document). Deny every non-data navigation and new-window attempt on
// any webview webContents as soon as it's created.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") {
    installNativeEditContextMenu(contents);
    return;
  }

  // There is deliberately NO attach-time `installPluginPartitionPolicy` call
  // here (#1953). One used to sit at this point, reading
  // `contents.session.partition` to recover the partition name — but Electron's
  // `Session` exposes no `partition` property (verified against the Electron 43
  // typings; only the *options* interfaces carry one), so the read was always
  // `undefined` and the branch never ran (#498). Keeping it implied a second
  // installer of the partition request filter and a fallback for partitions the
  // lifecycle missed; neither existed.
  //
  // `boot/steps/plugin-runtime.ts` is the single installer, covering every
  // partition a plugin-shell webview can be attached with: the post-`startAll`
  // loop, the `plugin.installed` event, and the `onEnable` lifecycle hook — all
  // keyed by the same `pluginPartitionName(pluginId)` the renderer uses for the
  // `<webview partition=…>` attribute. If a new producer ever attaches a
  // shell-URL webview with a partition that path does not cover, that partition
  // has no request filter and `shouldBlockGlobalWebviewNavigation` below becomes
  // its only gate.

  // Plugin webview lifecycle: clean up the (webContents.id → pluginId)
  // registry entry on destroy so a stale id can't be reused for an
  // unrelated future webContents. `render-process-gone` covers the case
  // where the underlying renderer process crashes (sandbox kill, OOM,
  // GPU lost) — Electron does not always emit `destroyed` synchronously
  // afterwards, so we clear the binding eagerly.
  const dropBinding = () => {
    const services = getServices();
    if (!services) return;
    unregisterPluginWebview(contents.id, services.revokePluginOperationSession);
  };
  contents.on("destroyed", dropBinding);
  contents.on("render-process-gone", dropBinding);

  contents.on("will-navigate", (navEvent) => {
    // Plugin webview policy: allow file:// navigations ONLY into the app's
    // dist/src directory (plugin-ui-shell.html + plugin entry modules
    // resolved by the shell). The previous substring match on ".js" or
    // "plugin-ui-shell" let any local .js file load — treat that as LFI
    // and reject. LLM-HTML webviews (different consumer) keep the
    // data:/about: only fallback below.
    //
    // URL must come from the canonical `navEvent.url` payload. Electron 41.x
    // empties the deprecated positional `url` arg, so reading it would crash
    // here and bypass the security check entirely.
    const url = navEvent.url;
    const currentUrl = contents.getURL();
    // Auth and external-link viewer webviews load remote http(s) pages under
    // scoped per-window policies. Keep the global guard deny-by-default for
    // every unregistered webview.
    if (shouldBlockGlobalWebviewNavigation({
      url,
      currentUrl,
      distRoot,
      authOwned: isAuthOwned(contents),
      linkOwned: isLinkOwned(contents),
    })) {
      navEvent.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("child-process-gone", (_event, details) => {
  const fields = {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? "",
    name: details.name ?? "",
  };
  // A child process going away during shutdown is the shutdown working, not a
  // fault. Logging it at error taught readers that errors here are routine,
  // which is how a real one gets skipped — every quit produced a handful, so
  // the level stopped carrying information.
  //
  // Outside shutdown the same event is a genuine crash and stays at error.
  if (isAppShutdownStarted() || isAppShutdownCompleted()) {
    log.info(fields, "child process gone during shutdown");
    return;
  }
  log.error(fields, "child process gone");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: re-create window on Dock icon click when all windows are closed.
// Re-register the plugin event bridge for the new window (Issue 5).
app.on("activate", () => {
  if (bootLaunch === "headless") return;
  showOrCreateMainWindow("activate");
});

// Electron's `quit()` ends the process with 0 whatever `process.exitCode`
// says (verified on the packaged Linux build and the macOS dev build), so a
// chosen failure code reaches its caller only through `app.exit()`. `will-quit`
// is the one event every `quit()` path crosses AFTER the `before-quit` cleanup
// has flushed the transcript, the audit log and the trace, which is why the
// exec branch keeps `app.quit()` and the code is applied here rather than there.
app.on("will-quit", (event) => {
  if (execRequest === null && !guiBootstrapFailed) return;
  if (typeof process.exitCode !== "number") return;
  event.preventDefault();
  app.exit(process.exitCode);
});

// The one `before-quit` listener the host installs. Every subsystem that only
// needs to stop a timer, a watcher or a batch exporter registers a shutdown
// hook instead of a listener of its own, so this count does not grow with the
// service graph and Electron's `App` never crosses Node's listener ceiling.
app.on("before-quit", (event) => {
  // Hooks run first and unconditionally. Eight of them were prepended
  // listeners, which fired ahead of this handler; all of them fired on quits
  // where the guards below return early.
  runShutdownHooks();
  const appUpdateInstallRequested = isAppUpdateInstallRequested();
  if (isAppUpdateInstallPrepared()) return;
  if (!getServices() || isAppShutdownCompleted()) return;
  if (isAppShutdownStarted()) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  void (async () => {
    const outcome = await runAppShutdownCleanup({
      reason: appUpdateInstallRequested ? "app-update-install" : "before-quit",
      exitOnTimeout: !appUpdateInstallRequested,
    });
    if (appUpdateInstallRequested) {
      markAppUpdateInstallPrepared();
      app.quit();
      return;
    }
    if (outcome === "timed-out") return;
    app.quit();
  })();
});
