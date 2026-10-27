



import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import type { SandboxGateAction, SandboxGateReason } from "./sandbox-gate.js";
import {
  canRetryWindowsAsProxyOnly,
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
  windowsSubstrateFor,
  windowsSubstrateWithoutAsrt,
  type WindowsSandboxPlanInputs,
} from "./windows-sandbox-plan.js";
import type { SandboxStartFailureCause } from "../../shared/sandbox-capability-info.js";
import { classifySandboxDependencyErrors } from "../../permissions/sandbox-start-failure.js";
import { errorMessage } from "../../shared/error-message.js";
import { checkSandboxSweepRoot } from "../../shared/ave-home-test-guard.js";
import { removeOwnedPluginTree } from "../../plugins/installed-entry-fs.js";
import { getAveHomePrivacyFailure, setAveHomePrivacyRefusalReporter } from "../../shared/ave-home.js";

const log = createLogger("ave");

export async function initSandboxGate(ctx: BootContext): Promise<void> {
  const { settingsService, bootAuditLogger, buildWorkerEgressAllowlists } = ctx;
  setAveHomePrivacyRefusalReporter((message) => {
    log.warn(message);
    bootAuditLogger.log({ timestamp: new Date().toISOString(), sessionId: "extensions", type: "error",
      output: `[ave_home_privacy_refused] ${message}` });
  });

  // On macOS/Linux, failed explicit activation aborts; failed settings activation warns and continues without isolation.
  // Windows failures always warn and continue; its runtime provides filesystem and network confinement without process isolation.
  {
    const {
      initializeAsrtSandbox,
      subscribeAsrtViolations,
      appOwnedSandboxHomeRoot,
      ensureSandboxPrivateRoot,
      useAppOwnedSandboxTempRoot,
      checkAsrtDependencies,
      isAsrtLinuxRuntimeProbeError,
      isAsrtMacRuntimeProbeError,
      closeAllEgressConnections,
    } = await import("../../permissions/asrt-sandbox.js");
    const {
      setActiveSandboxCapability,
      setShellSandboxRequestedAtBoot,
      setPluginWorkerConfinementRequestedAtBoot,
      setSandboxBootOutcome,
      detectSandboxCapability,
      setWindowsSandboxSubstrate,
      getWindowsSandboxSubstrate,
    } = await import("../../permissions/sandbox-capability.js");
    const { sandboxConfinementForPlatform } = await import(
      "../../shared/sandbox-capability-info.js"
    );
    const { decideSandboxGate, shouldWarnHostClassifyInterlock } = await import(
      "./sandbox-gate.js"
    );

    // Shell and worker signals control independent scopes; either may initialize the shared runtime.
    // Explicit environment activation and settings activation use different failure policies.
    const features = settingsService.get("features");
    const shellExplicitEnv = process.env["AVE_SANDBOX_ENABLED"] === "1";
    const workerExplicitEnv = process.env["AVE_PLUGIN_WORKER_CONFINEMENT"] === "1";
    const shellRequested = (features?.osToolSandbox ?? false) || shellExplicitEnv;
    const workerRequested = (features?.pluginWorkerConfinement ?? false) || workerExplicitEnv;
    const explicitEnv = shellExplicitEnv || workerExplicitEnv;
    const settingOn = (features?.osToolSandbox ?? false) || (features?.pluginWorkerConfinement ?? false);
    const sandboxOptIn = shellRequested || workerRequested;
    // Freeze activation intent per scope at boot; mutable UI settings must not alter worker confinement or hide requested-but-degraded shell plans.
    setShellSandboxRequestedAtBoot(shellRequested);
    setPluginWorkerConfinementRequestedAtBoot(workerRequested);
    const explicitEnvNames = [
      ...(shellExplicitEnv ? ["AVE_SANDBOX_ENABLED"] : []),
      ...(workerExplicitEnv ? ["AVE_PLUGIN_WORKER_CONFINEMENT"] : []),
    ];
    const explicitEnvLabel = explicitEnvNames.map((name) => `${name}=1`).join(" and ");
    // The shell environment override no longer activates worker confinement; warn launchers that assume otherwise.
    if (shellExplicitEnv && !workerRequested) {
      log.warn(
        "boot: AVE_SANDBOX_ENABLED=1 now confines host shells only — plugin workers, plugin children, " +
          "plugin hooks and MCP stdio servers run WITHOUT OS confinement this session. " +
          "Set AVE_PLUGIN_WORKER_CONFINEMENT=1 (or turn on Settings → Permissions 'Extension confinement') " +
          "to confine them as before.",
      );
    }

    // Emit one terminal activation event; explicit environment signals take precedence over settings, then off.
    const sandboxGateOnSignal: "explicit-env" | "default-settings" | "off" =
      explicitEnv ? "explicit-env" : settingOn ? "default-settings" : "off";

    /** Publish one terminal outcome to audit and renderer together so diagnostics cannot contradict the user-visible state. */
    const recordGate = (
      outcome: SandboxGateAction,
      reason: SandboxGateReason,
      dependencyErrors: readonly string[] = [],
      causes: readonly SandboxStartFailureCause[] = [],
    ): void => {
      bootAuditLogger.logSandboxGate({
        platform: process.platform,
        onSignal: sandboxGateOnSignal,
        outcome,
        reason,
      });
      setSandboxBootOutcome({
        action: outcome,
        reason,
        onSignal: sandboxGateOnSignal,
        dependencyErrors,
        causes,
      });
    };

    // Interlock warnings use actual activation so requested-but-degraded confinement cannot suppress them.
    let sandboxActive = false;

    if (sandboxOptIn) {
      const deps = await checkAsrtDependencies();
      const dependencyCauses = deps.errors.length > 0
        ? classifySandboxDependencyErrors(process.platform, deps.errors, deps.dependencyFailure)
        : [];
      // Record every Windows substrate branch for Settings; available containers carry agent shells independently of the other runtime.
      const windowsInputs = process.platform === "win32"
        ? await detectWindowsBootInputs(shellRequested, workerRequested, deps.errors.length === 0)
        : undefined;
      const windowsPlan = windowsInputs === undefined ? undefined : planWindowsSandbox(windowsInputs);
      // Track proxy-only startup separately from the requested runtime plan.
      let windowsStart = windowsPlan?.start;
      /** Publish slow shell-probe results only if the startup record has not been replaced meanwhile. */
      const recordWindows = (started: "srt-win" | "proxy-only" | "none", failed: boolean): void => {
        if (windowsInputs === undefined) return;
        const at = (mxc: WindowsSandboxPlanInputs["mxc"]) => {
          const substrate = windowsSubstrateFor({ ...windowsInputs, mxc }, started);
          return failed ? windowsSubstrateWithoutAsrt(substrate) : substrate;
        };
        const first = at(windowsInputs.mxc);
        setWindowsSandboxSubstrate(first, first.shells === "mxc" ? mxcShellCapability() : undefined);
        if (started === "proxy-only" && !failed) {
          setActiveSandboxCapability(windowsProxyOnlyCapability(first));
        }
        if (windowsInputs.mxc.state !== "checking") return;
        const recorded = getWindowsSandboxSubstrate();
        void settleWindowsMxcStartProbe().then((mxc) => {
          if (getWindowsSandboxSubstrate() !== recorded) return;
          const settled = at(mxc);
          setWindowsSandboxSubstrate(settled, settled.shells === "mxc" ? mxcShellCapability() : undefined);
          if (started === "proxy-only" && !failed) {
            setActiveSandboxCapability(windowsProxyOnlyCapability(settled));
          }
          log.info(
            "boot: Windows sandbox settled — MXC %s, shells: %s, shell egress identity: %s",
            mxc.state === "unavailable" ? `unavailable (${mxc.reason})` : mxc.state,
            settled.shells,
            settled.shellEgressIdentity,
          );
        });
      };
      // Proxy-only startup can confine container shells while extensions remain unconfined.
      const decision: { action: SandboxGateAction; reason: SandboxGateReason } =
        windowsPlan?.start === "proxy-only"
          ? { action: "activate", reason: "activate-windows-mxc-proxy-only" }
          : decideSandboxGate({
              settingOn,
              explicitEnv,
              platform: process.platform,
              depsOk: deps.errors.length === 0,
            });

      const privacyFailure = getAveHomePrivacyFailure();
      if (privacyFailure !== undefined && windowsStart !== "proxy-only") {
        const path = privacyFailure.failedPath ?? privacyFailure.home;
        log.warn("boot: extension isolation is OFF; AVE_HOME privacy failed (%s, %s). Extensions require session approval in Settings > Permissions.", privacyFailure.category, path);
        recordWindows("none", true);
        recordGate("degrade", "degrade-ave-home-privacy-failed", [privacyFailure.reason], ["ave-home-privacy-failed"]);
      } else if (decision.action === "abort") {
        // Explicit environment activation on macOS/Linux must abort if confinement is unavailable; never silently spawn unsandboxed.
        // Settings activation degrades, and Windows never aborts for missing prerequisites.
        const message =
          `boot: OS tool sandbox is ON via ${explicitEnvLabel} but its dependencies are missing — refusing to start. ` +
          `Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) or unset ${explicitEnvNames.join(" and ")}. ` +
          `Missing: ${deps.errors.join("; ")}`;
        log.error(message);
        recordGate("abort", decision.reason, deps.errors, dependencyCauses);
        await bootAuditLogger.flush();
        throw new Error(message);
      } else if (decision.action === "degrade") {
        // Failed settings activation warns and leaves isolation inactive; never publish a capability that did not initialize.
        const detail = deps.errors.join("; ");
        if (process.platform === "win32") {
          log.warn(
            "boot: OS tool sandbox is ON but the Windows sandbox (srt-win) is NOT ready — " +
              "tools run with NO OS isolation until setup completes. " +
              (dependencyCauses.includes("windows-sandbox-missing") || dependencyCauses.includes("windows-sandbox-integrity-failed")
                ? "Repair or reinstall Ave, then restart the app. "
                : "Complete the one-time administrator install, then restart the app. ") +
              "Windows confines filesystem + network, but not process isolation. " +
              `Detail: ${detail}`,
          );
        } else {
          log.warn(
            "boot: OS tool sandbox is ON by default but its dependencies are missing — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) until the deps are installed. " +
              "Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) to activate it, or turn it off " +
      "in Settings → Permissions 'OS tool sandbox'. (Set AVE_SANDBOX_ENABLED=1 for shells or " +
      "AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes to make this fail-closed instead.) " +
              `Missing: ${detail}`,
          );
        }
        recordWindows("none", false);
        recordGate("degrade", decision.reason, deps.errors, dependencyCauses);
      } else {
        // Runtime initialization failures use the same explicit-versus-settings policy as missing prerequisites.
        try {
          if (deps.warnings.length > 0) {
            log.warn("boot: ASRT dependency warnings: %s", deps.warnings.join("; "));
          }
          // Keep the global domain allow-list empty; on macOS/Linux, per-wrap listeners bind identity and proxy usernames are not trusted.
          // Workers get only their own extension domains and model endpoints; shells require grants or approval, terminals ask in their own banner with a 120-second limit, and unattributed or unanswered requests are denied.
          const workerAllowlists = await buildWorkerEgressAllowlists();
          const { setWorkerEgressAllowlists, createEgressAskRuntimeCallback } = await import(
            "../../permissions/egress-runtime.js"
          );
          setWorkerEgressAllowlists(workerAllowlists);
          const egressAskCallback = createEgressAskRuntimeCallback({
            approvalGate: ctx.approvalGate,
            permissionManager: ctx.permissionManager,
            shellAskEnabled: () => settingsService.get("features")?.shellEgressAsk === true,
          });
          // Keep weakening flags unset; apply filesystem scope only at each wrap.
          // Set the temp-root policy before the first wrap and sweep stale private homes before confined processes start, retaining this process's directories.
          await sweepSandboxPrivateRoots();
          // Create both roots before any wrap; Linux may omit read denies for paths that do not yet exist.
          ensureSandboxPrivateRoot(appOwnedSandboxHomeRoot());
          const sandboxTempRoot = useAppOwnedSandboxTempRoot();
          // Subscribe before starting the proxy so no deny precedes monitoring.
          {
            const [{ startEgressDenyMonitor }, { emitSandboxAudit }] = await Promise.all([
              import("../../permissions/egress-deny-monitor.js"),
              import("../../audit/sandbox-audit-sink.js"),
            ]);
            await startEgressDenyMonitor({
              subscribe: subscribeAsrtViolations,
              emit: emitSandboxAudit,
              capability: detectSandboxCapability,
            });
          }
          // Resolve upstreamProxy per destination and clear its cache on writes; system mode follows app environment then OS proxy configuration.
          // Audit skipped unusable routes.
          const upstreamRouter = await (async () => {
            const [{ createUpstreamProxyRouter, upstreamProxyDeps }, { maskSensitiveData }, { emitSandboxAudit }] = await Promise.all([
              import("../../permissions/upstream-proxy.js"),
              import("../../audit/dlp-filter.js"),
              import("../../audit/sandbox-audit-sink.js"),
            ]);
            const mask = (text: string): string => maskSensitiveData(text).masked;
            const upstream = createUpstreamProxyRouter(upstreamProxyDeps(settingsService, ctx.host.resolveProxy, (event) => {
              emitSandboxAudit({
                timestamp: new Date().toISOString(),
                entryKind: "egress-route",
                destination: { host: mask(event.host), port: event.port },
                source: event.source,
                skipped: event.skipped.map(mask),
              }).catch((error: unknown) => log.warn(`[sandbox] upstream route audit write failed: ${errorMessage(error)}`));
            }));
            // Proxy-policy changes invalidate the generation and close connections; pending decisions recheck before dialing.
            settingsService.onChanged("upstreamProxy", () => {
              upstream.invalidate();
              const closed = closeAllEgressConnections();
              if (closed > 0) log.info(`[sandbox] upstream proxy setting changed; closed ${closed} open sandbox connection(s)`);
            });
            return upstream.router;
          })();
          const initializeAs = (start: typeof windowsStart) =>
            initializeAsrtSandbox({
              allowedDomains: [],
              strictAllowlist: false,
              upstreamRouter,
              // Derive deny paths from actual userData so custom directories remain protected.
              userDataDir: ctx.host.userDataPath,
              ...(start === "proxy-only" ? { windows: { externalConfinement: true } } : {}),
            }, egressAskCallback);
          try {
            await initializeAs(windowsStart);
          } catch (srtWinErr) {
            // A failed session setup clears runtime config, permitting clean proxy-only initialization for container shells.
            if (windowsInputs === undefined || windowsStart === undefined || !canRetryWindowsAsProxyOnly(windowsInputs, windowsStart)) {
              throw srtWinErr;
            }
            log.warn(
              "boot: the Windows sandbox (srt-win) failed to start — extensions run with NO OS isolation this session; " +
                "retrying ASRT as the proxy only so agent shells can run in Microsoft Execution Containers. " +
                `Cause: ${errorMessage(srtWinErr)}`,
            );
            windowsStart = "proxy-only";
            await initializeAs(windowsStart);
          }
          // Publish only initialized confinement: full on macOS/Linux, filesystem and network only on the Windows runtime.
          // Inactive or degraded activation must leave capability none; reviewers rely on these dimensions.
          const asrtBackend =
            process.platform === "darwin"
              ? "Seatbelt"
              : process.platform === "win32"
                ? windowsStart === "proxy-only" ? "proxy only, shells in MXC" : "srt-win"
                : "bwrap";
          const confinementKind = process.platform === "win32" ? "partial" : "full";
          const confines = sandboxConfinementForPlatform(
            process.platform,
            confinementKind,
          );
          const reason =
            process.platform === "win32"
              ? `ASRT (${asrtBackend}) active — filesystem + network contained, process isolation unavailable`
              : `ASRT (${asrtBackend}) active — fs+process+network contained`;
          if (windowsStart !== "proxy-only") {
            setActiveSandboxCapability({
              kind: "asrt",
              confidence: "verified",
              platform: process.platform,
              reason,
              // Report measured shell confinement dimensions, never a generic active flag.
              confines,
            });
          }
          if (windowsInputs !== undefined && windowsStart !== undefined) {
            recordWindows(windowsStart, false);
            const substrate = windowsSubstrateFor(windowsInputs, windowsStart);
            if (workerRequested && substrate.extensions === "none" && windowsPlan?.start !== "srt-win") {
              log.warn(
                "boot: extension confinement is ON but the Windows sandbox (srt-win) is NOT ready — " +
                  "plugin workers, plugin children, plugin hooks and MCP stdio servers run with NO OS isolation " +
                  "until the one-time administrator install completes; agent shells run in Microsoft Execution Containers " +
                "once the container start check passes.",
              );
            }
            log.info(
              "boot: Windows sandbox — MXC %s, shells: %s, extensions: %s, shell egress identity: %s",
              substrate.mxc.state,
              substrate.shells,
              substrate.extensions,
              substrate.shellEgressIdentity,
            );
          }
          log.info(
            "boot: ASRT OS tool sandbox initialized (%s, %s, egress decided per connection by the ask callback; %d model endpoints at init, extension allowlists refreshed after plugin load; confined temp root %s)",
            process.platform,
            asrtBackend,
            workerAllowlists.modelEndpointHosts.length,
            sandboxTempRoot,
          );
          sandboxActive = true;
          recordGate(
            "activate",
            windowsStart === "proxy-only" ? "activate-windows-mxc-proxy-only" : decision.reason,
            deps.errors,
            dependencyCauses,
          );
        } catch (initErr) {
          // Reapply the same boot decision on initialization failure; no active capability may publish until initialization succeeds.
          const failDecision = decideSandboxGate({
            settingOn,
            explicitEnv,
            platform: process.platform,
            depsOk: false,
          });
          const macRuntimeProbeFailed = process.platform === "darwin" && isAsrtMacRuntimeProbeError(initErr);
          const runtimeProbeFailed =
            process.platform === "linux" && isAsrtLinuxRuntimeProbeError(initErr);
          const failureReason: SandboxGateReason = macRuntimeProbeFailed
            ? failDecision.action === "abort" ? "abort-macos-runtime-probe-failed" : "degrade-macos-runtime-probe-failed"
            : runtimeProbeFailed
            ? failDecision.action === "abort"
              ? "abort-linux-runtime-probe-failed"
              : "degrade-linux-runtime-probe-failed"
            : process.platform === "win32"
              // Dependency checks passed, so report a start failure rather than missing installation.
              ? "degrade-windows-init-failed"
              : failDecision.reason;
          const cause = errorMessage(initErr);
          const failureCauses: SandboxStartFailureCause[] = [
            runtimeProbeFailed ? "linux-runtime-probe-failed" : "init-failed",
          ];
          if (failDecision.action === "abort") {
            // Explicit activation must fail closed on initialization errors.
            log.error(
              `boot: OS tool sandbox is ON via ${explicitEnvLabel} but ASRT initialization failed — refusing to start. ` +
                `Cause: ${cause}`,
            );
            recordGate("abort", failureReason, [cause], failureCauses);
            await bootAuditLogger.flush();
            throw initErr;
          }
          // Settings activation and Windows errors warn and continue without isolation.
          log.warn(
            "boot: OS tool sandbox is ON by default but ASRT initialization failed — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) this session. " +
              "(Set AVE_SANDBOX_ENABLED=1 for shells or AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes " +
                "to make this fail-closed instead.) " +
              `Cause: ${cause}`,
          );
          recordWindows(windowsStart ?? "none", true);
          recordGate("degrade", failureReason, [cause], failureCauses);
          // Probe failure must leave capability none for UI and reviewer.
        }
      }
    } else {
      if (process.platform === "darwin") {
        log.info(
    "boot: OS tool sandbox gated off (enable via Settings → Permissions, or AVE_SANDBOX_ENABLED=1 for shells / " +
      "AVE_PLUGIN_WORKER_CONFINEMENT=1 for extension processes)",
        );
      }
      recordGate("skip", "gate-off");
    }

    // Warn whenever host risk classification is enabled without active OS confinement, including degraded activation; settings remain independent.
    if (
      shouldWarnHostClassifyInterlock({
        hostClassifiesRisk: settingsService.get("features")?.hostClassifiesRisk ?? false,
        // Only worker confinement contains plugin code; shell-only runtime activation does not.
        sandboxActive: sandboxActive && workerRequested,
      })
    ) {
      log.warn(
        "boot: hostClassifiesRisk is ON but plugin-worker confinement (pluginWorkerConfinement / AVE_PLUGIN_WORKER_CONFINEMENT) is NOT active — " +
          "effect-boundary classification does NOT contain off-hostApi mutations (direct node:fs, bare fetch, " +
          "detached async frames) without the OS sandbox. For that residual, host-classify WITHOUT the sandbox is " +
          "weaker than the pre-exec ask it replaces. Install/enable the OS sandbox to contain it, or keep the " +
          "pre-exec ask (turn hostClassifiesRisk off) until the sandbox is active.",
      );
    }
  }
}

/** Sweep private roots while retaining this process's directories; report failures and retain the read-deny floor. */
export async function sweepSandboxPrivateRoots(): Promise<void> {
  const { appOwnedSandboxHomeRoot, appOwnedSandboxTempRoot, sandboxTempPrincipalDirsInUse } =
    await import("../../permissions/asrt-sandbox.js");
  const { sandboxProcessHomesInUse } = await import("../../permissions/sandbox-process-home.js");
  const { appOwnedSandboxActionRoot } = await import("../../shared/sandbox-private-paths.js");
  const { sandboxActionDirectoriesInUse } = await import("../../permissions/sandbox-action-directory.js");
  const roots = [
    [appOwnedSandboxTempRoot(), sandboxTempPrincipalDirsInUse()],
    [appOwnedSandboxHomeRoot(), sandboxProcessHomesInUse()],
    [appOwnedSandboxActionRoot(), sandboxActionDirectoriesInUse()],
  ] as const;
  // Reject real-home test targets before touching any root.
  for (const [root] of roots) checkSandboxSweepRoot(root);
  for (const [root, inUse] of roots) {
    await sweepSandboxPrivateRoot(root, inUse).catch((error: unknown) => {
      log.warn("boot: could not empty the sandbox root %s: %s", root, errorMessage(error));
    });
  }
}

/** Sweep unused private roots before confined processes start; preserve this process's directories.
 * Never follow links; remove owned trees while reclaiming restrictive modes and immutable flags. */
export async function sweepSandboxPrivateRoot(root: string, inUse: ReadonlySet<string>): Promise<void> {
  checkSandboxSweepRoot(root);
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!entry.isDirectory()) {
    await unlink(root);
    return;
  }
  const canonicalRoot = await realpath(root);
  // The root contains live processes' homes and temporary files; sweeping would delete them.
  checkSandboxSweepRoot(canonicalRoot);
  for (const name of await readdir(root)) {
    if (inUse.has(join(root, name)) || inUse.has(join(canonicalRoot, name))) continue;
    await removeOwnedPluginTree(join(root, name));
  }
}

/** Boot performs static container checks; the slow start probe runs afterward and reports its outcome to Settings. */
async function detectWindowsBootInputs(
  shellRequested: boolean,
  workerRequested: boolean,
  srtWinReady: boolean,
): Promise<WindowsSandboxPlanInputs> {
  const { detectHostMxcPrerequisites } = await import("../../permissions/mxc-windows.js");
  const mxc = await detectHostMxcPrerequisites();
  if (mxc.state === "unavailable") logMxcUnavailable(mxc.reason, mxc.windowsBuild, mxc.detail);
  return {
    shellRequested,
    workerRequested,
    mxc: mxc.state === "available" ? { state: "checking" } : { state: "unavailable", reason: mxc.reason },
    windowsBuild: mxc.windowsBuild,
    srtWinReady,
  };
}

/** Probe a real shell start after boot. */
async function settleWindowsMxcStartProbe(): Promise<WindowsSandboxPlanInputs["mxc"]> {
  const { probeHostMxcPowerShellStart } = await import("../../permissions/mxc-windows.js");
  const started = Date.now();
  try {
    const mxc = await probeHostMxcPowerShellStart();
    log.info("boot: MXC PowerShell start probe finished in %d ms (%s)", Date.now() - started, mxc.state);
    if (mxc.state === "available") return { state: "available" };
    logMxcUnavailable(mxc.reason, mxc.windowsBuild, mxc.detail);
    return { state: "unavailable", reason: mxc.reason };
  } catch (error) {
    logMxcUnavailable("powershell-start-failed", null, errorMessage(error));
    return { state: "unavailable", reason: "powershell-start-failed" };
  }
}

function logMxcUnavailable(reason: string, windowsBuild: string | null, detail: string): void {
  log.warn(
    "boot: Microsoft Execution Containers cannot confine agent shells on this host (%s, build %s): %s",
    reason,
    windowsBuild ?? "unknown",
    detail,
  );
}
